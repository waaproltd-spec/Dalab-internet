import { randomUUID } from "node:crypto";
import { Request, Response, NextFunction, Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { rateLimit } from "../auth/rateLimit.js";
import { sendJson } from "../utils/camelCase.js";
import { broadcast } from "../realtime/orderEvents.js";
import { parseDataUri } from "../utils/dataUri.js";

export const supportRouter = Router();

const OPEN_STATUSES = ["queued", "pending", "assigned"];
const SUPPORT_TOPICS = ["dalab_internet", "payment_services", "agent_support"];

// ---------------- Shared helpers ----------------

type SupportActorRole = "admin" | "agent";
interface SupportActor {
  id: string;
  role: SupportActorRole;
}

/** A JWT's `role` claim collapses to exactly two support-handling actor kinds. */
function actorFromAuth(auth: { sub: string; role: string }): SupportActor {
  return { id: auth.sub, role: auth.role === "agent" ? "agent" : "admin" };
}

/**
 * Gate for every conversation-handling route: Admin Dashboard staff need the
 * 'support.manage' permission (unchanged from before -- super_admin always
 * passes, a regular admin needs it granted, checked live against the DB),
 * OR a native Agent App field agent (the `agents` table, device-based
 * login) -- any online agent may handle support, the same way any staff
 * member with the permission could; agents have no individual per-feature
 * permission toggle the way admin_users.permissions does.
 */
async function adminHasSupportManage(adminId: string): Promise<boolean> {
  const admin = await queryOne<{ permissions: string[] }>(`SELECT permissions FROM admin_users WHERE id=$1`, [adminId]);
  return admin?.permissions?.includes("support.manage") === true;
}

function requireSupportActor() {
  const auth = requireAuth("super_admin", "admin", "agent");
  return (req: Request, res: Response, next: NextFunction): void => {
    auth(req, res, async () => {
      if (req.auth!.role === "agent" || req.auth!.role === "super_admin") return next();
      if (await adminHasSupportManage(req.auth!.sub)) return next();
      res.status(403).json({ error: "Missing the 'support.manage' permission — ask a Super Admin to grant it." });
    });
  };
}

/**
 * Registers the exact same handler at both an /admin/support/... path
 * (Admin Dashboard) and the equivalent /agent/support/... path (Agent App)
 * -- not a second implementation, literally the same function reference
 * twice. Express's own path-array overload works fine at runtime, but this
 * project's installed @types/express doesn't accept it, so two calls it is.
 */
function dual(
  method: "get" | "post" | "put",
  adminPath: string,
  agentPath: string,
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  handler: (req: Request, res: Response) => void | Promise<void>
): void {
  supportRouter[method](adminPath, middleware, handler);
  supportRouter[method](agentPath, middleware, handler);
}

/** Position (1-based) among every currently 'queued' conversation, oldest first. Null once no longer queued. */
async function queuePositionFor(conversationId: string): Promise<number | null> {
  const row = await queryOne<{ position: string }>(
    `SELECT position FROM (
       SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS position
       FROM support_conversations WHERE status = 'queued'
     ) ranked WHERE ranked.id = $1`,
    [conversationId]
  );
  return row ? Number(row.position) : null;
}

async function serializeConversation(row: any, opts: { includeMessages?: boolean } = {}) {
  const out: Record<string, unknown> = { ...row };
  if (row.status === "queued") {
    const position = await queuePositionFor(row.id);
    out.queuePosition = position;
    out.customersAhead = position !== null ? position - 1 : null;
  } else {
    out.queuePosition = null;
    out.customersAhead = null;
  }
  if (row.agent_id) {
    if (row.agent_role === "agent") {
      const agent = await queryOne<{ name: string }>(`SELECT name FROM agents WHERE id=$1`, [row.agent_id]);
      out.agentName = agent?.name ?? null;
    } else {
      const admin = await queryOne<{ email: string }>(`SELECT email FROM admin_users WHERE id=$1`, [row.agent_id]);
      out.agentName = admin?.email ?? null;
    }
  } else {
    out.agentName = null;
  }
  if (opts.includeMessages) {
    // media_data (BYTEA) is deliberately never selected here — same pattern
    // promo_images uses — it's only ever read by GET /support/messages/:id/media,
    // served raw rather than through sendJson. media_url is what a client
    // actually fetches for an image/voice message; null for plain text.
    const rows = await query<{
      id: string;
      sender_type: string;
      message_type: string;
      body: string | null;
      media_mime_type: string | null;
      created_at: string;
    }>(
      `SELECT id, sender_type, message_type, body, media_mime_type, created_at
       FROM support_messages WHERE conversation_id=$1 ORDER BY created_at ASC`,
      [row.id]
    );
    out.messages = rows.map((m) => ({
      ...m,
      media_url: m.message_type === "text" ? null : `/support/messages/${m.id}/media`,
    }));
  }
  return out;
}

type SupportMessageType = "text" | "image" | "voice";
const SUPPORT_MESSAGE_TYPES: SupportMessageType[] = ["text", "image", "voice"];

/**
 * Validates and normalizes a message-send request body into what
 * INSERT INTO support_messages actually needs, shared by both the
 * customer-facing and agent-facing message endpoints so the text/image/voice
 * validation lives in exactly one place. `messageType` defaults to "text"
 * (every pre-existing caller/client only ever sent a plain body, so this
 * keeps them working unchanged); "image"/"voice" require `mediaBase64` as a
 * data:<mime>;base64,<data> string instead of a body.
 */
function composeMessage(
  body: unknown,
  messageType: unknown,
  mediaBase64: unknown
): { messageType: SupportMessageType; body: string | null; mediaData: Buffer | null; mediaMimeType: string | null } | { error: string } {
  const type: SupportMessageType =
    typeof messageType === "string" && SUPPORT_MESSAGE_TYPES.includes(messageType as SupportMessageType)
      ? (messageType as SupportMessageType)
      : "text";

  if (type === "text") {
    const text = String(body ?? "").trim();
    if (!text) return { error: "Message cannot be empty" };
    return { messageType: "text", body: text, mediaData: null, mediaMimeType: null };
  }

  const parsed = parseDataUri(mediaBase64);
  if (!parsed) return { error: "mediaBase64 must be a data:<mime>;base64,<data> string" };
  if (type === "image" && !parsed.mimeType.startsWith("image/")) {
    return { error: "An image message's media must be an image/* mime type" };
  }
  if (type === "voice" && !parsed.mimeType.startsWith("audio/")) {
    return { error: "A voice message's media must be an audio/* mime type" };
  }
  return { messageType: type, body: null, mediaData: parsed.data, mediaMimeType: parsed.mimeType };
}

/**
 * The single "who can take a new conversation right now" lookup, shared by
 * every place that needs to auto-assign one: starting a new conversation,
 * checking availability before starting one, and re-homing a conversation
 * the instant its agent goes offline. An "idle" actor is online with
 * nothing currently assigned to them.
 */
async function findIdleOnlineActor(): Promise<{ actor_id: string; actor_role: SupportActorRole } | null> {
  return queryOne<{ actor_id: string; actor_role: SupportActorRole }>(
    `SELECT s.admin_id AS actor_id, s.actor_role FROM support_agent_status s
     WHERE s.online = true
       AND NOT EXISTS (
         SELECT 1 FROM support_conversations c
         WHERE c.agent_id = s.admin_id AND c.agent_role = s.actor_role AND c.status = 'assigned'
       )
     ORDER BY s.updated_at ASC
     LIMIT 1`
  );
}

async function isAnyAgentOnline(): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM support_agent_status WHERE online = true) AS exists`
  );
  return row?.exists === true;
}

// ---------------- Customer-facing ----------------

// Idempotent by design: a customer can only ever have one open (queued /
// pending / assigned) conversation at a time -- enforced twice, once here
// (a plain read, the common case) and again by the DB's own partial unique
// index as the race-proof backstop (see migration 061), so a retried
// request from a flaky connection can never create a duplicate.
supportRouter.post(
  "/support/conversations",
  requireAuth("customer"),
  rateLimit("support-conversation-create", 10, 15 * 60 * 1000),
  async (req, res) => {
    const topic = String(req.body.topic ?? "agent_support");
    if (!SUPPORT_TOPICS.includes(topic)) {
      return sendJson(res, 400, { error: `topic must be one of: ${SUPPORT_TOPICS.join(", ")}` });
    }
    const message = String(req.body.message ?? "").trim();
    if (!message) return sendJson(res, 400, { error: "A message is required to start a support request" });

    const existing = await queryOne(
      `SELECT * FROM support_conversations WHERE customer_id=$1 AND status = ANY($2)`,
      [req.auth!.sub, OPEN_STATUSES]
    );
    if (existing) {
      return sendJson(res, 200, await serializeConversation(existing, { includeMessages: true }));
    }

    // Look for an online actor (staff or field agent) with nothing
    // currently assigned to them -- if found, the customer skips the queue
    // entirely and connects immediately. Otherwise: queued (someone is
    // online, just busy) or pending (nobody is online at all -- the "leave
    // a message" case).
    const idleActor = await findIdleOnlineActor();
    const agentOnline = await isAnyAgentOnline();

    const status = idleActor ? "assigned" : agentOnline ? "queued" : "pending";
    const id = randomUUID();

    let conversation;
    try {
      const inserted = await query(
        `INSERT INTO support_conversations (id, customer_id, topic, status, agent_id, agent_role, agent_offline_at_start, assigned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          id,
          req.auth!.sub,
          topic,
          status,
          idleActor?.actor_id ?? null,
          idleActor?.actor_role ?? null,
          !agentOnline,
          status === "assigned" ? new Date() : null,
        ]
      );
      conversation = inserted[0];
    } catch (err) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23505" && pgErr.constraint === "idx_support_conversations_one_open_per_customer") {
        const raced = await queryOne(`SELECT * FROM support_conversations WHERE customer_id=$1 AND status = ANY($2)`, [
          req.auth!.sub,
          OPEN_STATUSES,
        ]);
        return sendJson(res, 200, await serializeConversation(raced, { includeMessages: true }));
      }
      throw err;
    }

    await query(`INSERT INTO support_messages (id, conversation_id, sender_type, body) VALUES ($1,$2,'customer',$3)`, [
      randomUUID(),
      id,
      message,
    ]);

    broadcast({ type: "support_conversation.updated", conversationId: id });
    sendJson(res, 201, await serializeConversation(conversation, { includeMessages: true }));
  }
);

// The customer app polls this to drive the waiting screen / chat screen --
// null when there's nothing open, so the app knows to show the 3 support
// cards again. Survives the app being closed and reopened: this is a pure
// read of server state, there is no client-side-only queue position.
supportRouter.get("/support/conversations/mine", requireAuth("customer"), async (req, res) => {
  const conversation = await queryOne(
    `SELECT * FROM support_conversations WHERE customer_id=$1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 1`,
    [req.auth!.sub, OPEN_STATUSES]
  );
  if (!conversation) return sendJson(res, 200, null);
  sendJson(res, 200, await serializeConversation(conversation, { includeMessages: true }));
});

supportRouter.post(
  "/support/conversations/:id/messages",
  requireAuth("customer"),
  rateLimit("support-message-send", 30, 5 * 60 * 1000),
  async (req, res) => {
    const composed = composeMessage(req.body.message, req.body.messageType, req.body.mediaBase64);
    if ("error" in composed) return sendJson(res, 400, { error: composed.error });

    const conversation = await queryOne(`SELECT * FROM support_conversations WHERE id=$1 AND customer_id=$2`, [
      req.params.id,
      req.auth!.sub,
    ]);
    if (!conversation) return sendJson(res, 404, { error: "Conversation not found" });
    if (!OPEN_STATUSES.includes(conversation.status)) {
      return sendJson(res, 409, { error: "This conversation is closed" });
    }

    await query(
      `INSERT INTO support_messages (id, conversation_id, sender_type, message_type, body, media_data, media_mime_type)
       VALUES ($1,$2,'customer',$3,$4,$5,$6)`,
      [randomUUID(), req.params.id, composed.messageType, composed.body, composed.mediaData, composed.mediaMimeType]
    );
    await query(`UPDATE support_conversations SET updated_at=now() WHERE id=$1`, [req.params.id]);

    broadcast({ type: "support_conversation.updated", conversationId: req.params.id });
    sendJson(res, 201, await serializeConversation(conversation, { includeMessages: true }));
  }
);

// Only while queued/pending -- once an agent has actually picked it up the
// natural end is the agent resolving/closing it, matching where the "Cancel"
// button is specced to appear (the pre-assignment waiting screen only).
supportRouter.post("/support/conversations/:id/cancel", requireAuth("customer"), async (req, res) => {
  const rows = await query(
    `UPDATE support_conversations SET status='closed', closed_at=now(), updated_at=now()
     WHERE id=$1 AND customer_id=$2 AND status IN ('queued','pending') RETURNING id`,
    [req.params.id, req.auth!.sub]
  );
  if (rows.length === 0) {
    return sendJson(res, 409, { error: "Conversation not found, not yours, or already being handled" });
  }
  // Ephemeral by design -- see endConversationAndAutoClaim's comment below
  // for why the same delete happens on every path that ends a conversation.
  await query(`DELETE FROM support_messages WHERE conversation_id=$1`, [req.params.id]);
  broadcast({ type: "support_conversation.updated", conversationId: req.params.id });
  sendJson(res, 200, { id: req.params.id, status: "closed" });
});

// A small, deliberately static FAQ -- never a generative call, and never
// anything that could look like it knows this customer's own balance,
// orders, or account status (per the product requirement: AI must not
// invent that kind of information). Anything not confidently matched here
// is the app's cue to hand off to the real queue via POST /support/conversations.
//
// Agent Assist (the customer-facing chat this backs) speaks Somali only, per
// spec, regardless of the app's own EN/SO language toggle -- answers here
// are Somali; keywords include both English and Somali spellings since a
// customer typing a question may use either.
const SUPPORT_FAQ: { keywords: string[]; answer: string }[] = [
  // Payments / EVC Plus / deposits
  { keywords: ["evc", "evc plus"], answer: "EVC Plus waa boorsada lacagta ee mobilka ee Hormuud. Xulo EVC Plus habka aad ku bixinayso, kadibna raac talaabooyinka USSD si aad u dhammaystirto lacag-bixinta." },
  { keywords: ["deposit", "top up", "add money", "add funds", "dhig lacag", "ku dar lacag", "kudar"], answer: "Si aad lacag ugu dhigto, fur Boorsada (Wallet) ee menu-ga app-ka, dooro Deposit, xulo habka lacag-bixinta, kadibna raac talaabada USSD. Balance-kaaga waa la cusboonaysiiyaa si toos ah marka lacag-bixinta la xaqiijiyo." },
  { keywords: ["payment failed", "payment not going through", "payment declined", "lacag bixin way fashilantay", "lama guulaysan"], answer: "Lacag-bixin fashilan waxaa badanaa sababa in codsiga USSD la joojiyay ama uu waqtigu dhammaaday, ama balance-ka mobilkaaga uusan ku filneyn. Isku day mar kale, oo hubi inaad si degdeg ah u ansixiso codsiga USSD." },
  { keywords: ["payment method", "how to pay", "how do i pay", "sida loo bixiyo"], answer: "Waxaad ku bixin kartaa EVC Plus, eDahab, Sahal, ama boorso kale oo la taageero — xulo bixiyahaaga marka aad wax iibsanayso oo raac talaabada USSD." },
  // Withdrawals
  { keywords: ["withdraw", "withdrawal", "cash out", "ka bixi lacag"], answer: "Ka bixinta lacagta (Withdraw) waxay u furan tahay xisaabaha Reseller-ka oo kaliya, waxaana laga helaa qaybta Reseller. Dooro Withdraw, geli lacagta, oo xaqiiji — si toos ah ayaa loogu diri doonaa lambarkaaga lacag-bixinta ee diiwaan gashan." },
  // Orders / order status
  { keywords: ["order status", "track order", "where is my order", "my order", "xaalada dalabka", "halka dalabkeyga"], answer: "Waxaad ka hubin kartaa xaalada dalab kasta bogga Orders ee menu-ga app-ka — wuxuu tusayaa pending, in progress, completed, ama failed waqti dhab ah." },
  { keywords: ["create order", "how to order", "buy package", "new order", "sida loo dalabsado"], answer: "Si aad dalab u samayso, dooro shirkad iyo baakidh bogga Home, dooro lambarka telefoonka helaya, kadibna bixi — baakidhka si toos ah ayaa loo geeyaa marka lacag-bixinta la xaqiijiyo." },
  { keywords: ["cancel order", "jooji dalabka"], answer: "Dalab waxaa la joojin karaa kaliya ka hor inta aan lacag-bixintu dhammaan. Marka lacag-bixintu xaqiijsanto, wakiil ayaa kaa caawin kara isbeddel kasta — riix \"La xiriir Agent\" hoose." },
  { keywords: ["how long", "how much time", "delivery time", "waqti intee"], answer: "Inta badan dalabyada internetka/data-da waxaa la geeyaa dhawr daqiiqo gudahood marka lacag-bixinta la xaqiijiyo. Haddii ay ka badan tahay, wakiil ayaa kuu hubin kara dalabkaaga gaarka ah." },
  // Internet packages
  { keywords: ["package", "data plan", "internet plan", "bundle", "baakidh"], answer: "Baakidhyada internetka/data-da oo dhan iyo qiimahooda waxaad ka arki kartaa bogga Home — dooro shirkad si aad u aragto baakidhyadeeda." },
  // eBadal
  { keywords: ["ebadal"], answer: "eBadal wuxuu kuu ogolaanayaa inaad lacag ka beddesho bixiyeyaasha la taageero. Fur eBadal ee menu-ga app-ka, dooro shirkadaha iyo lacagta, kadibna xaqiiji." },
  // Reseller
  { keywords: ["reseller"], answer: "Xisaabaha Reseller-ka waxay iibsan karaan baakidhyo tiro badan, u iibiyaan macaamiishooda, oo ka maamuli karaan deposits/withdrawals qaybta Reseller ee app-ka." },
  // Account / login / settings
  { keywords: ["change password", "reset password", "forgot password", "furaha sirta"], answer: "Waxaad ka beddeli kartaa password-kaaga bogga login-ka adigoo isticmaalaya \"Forgot password\" — waxaad u baahan doontaa lambarka telefoonka ee diiwaan gashan." },
  { keywords: ["login", "sign in", "cannot log in", "gal account", "gali account"], answer: "Haddii aadan geli karin, hubi lambarka telefoonkaaga iyo password-ka. Haddii aad illowday password-ka, isticmaal \"Forgot password\" bogga login-ka." },
  { keywords: ["update profile", "change name", "change phone number", "settings", "account settings"], answer: "Waxaad ka cusboonaysiin kartaa macluumaadka profile-kaaga iyo settings-ka bogga Settings ee menu-ga app-ka." },
  { keywords: ["delete account", "close account", "tirtir account"], answer: "Si aad account-kaaga u tirtirto, la xiriir taageerada adigoo bixinaya lambarka telefoonka ee diiwaan gashan — waa la xaqiijin doonaa oo la tirtiri doonaa." },
  { keywords: ["macaash", "points", "loyalty"], answer: "Dhibcaha Macaash waa dhibcaha daacadnimo ee DALAB, kuwaas oo lagu helo iibsiga u qalma oo loo isticmaali karo qiimo-dhimis dalab mustaqbal ah." },
  // App usage / notifications / errors / general
  { keywords: ["notification", "not receiving notifications", "ogeysiisyo"], answer: "Hubi in ogeysiisyada (notifications) loo furay app-ka settings-ka taleefankaaga, iyo inaad soo gashay account-kaaga — ogeysiisyadu waxay ku xidhan yihiin account-kaaga." },
  { keywords: ["update app", "new version", "cusboonaysii app"], answer: "Cusboonaysiinta waxaa lagu daabacaa Play Store — fur Play Store, raadi DALAB, kadibna riix Update haddii ay jirto mid diyaar ah." },
  { keywords: ["what is dalab", "what does dalab", "about dalab", "dalab waa maxay"], answer: "DALAB Internet waxay kuu ogolaanaysaa inaad iibsato baakidhyada internetka/data-da, lacag ka beddesho, iyo inaad maamusho boorsadaada — dhammaan hal app dhexdiisa." },
  { keywords: ["error", "crash", "not working", "bug", "khalad", "ma shaqeynayo"], answer: "Waan ka xumahay dhibaatadaas. Marka hore isku day inaad app-ka dib u furto ama cusboonaysiiso. Haddii dhibaatadu sii socoto, wakiil dhab ah ayaa kaa caawin kara — riix \"La xiriir Agent\" hoose." },
  { keywords: ["how to use", "how does this app work", "sida loo isticmaalo", "sida app-ka"], answer: "DALAB wuxuu kuu ogolaanayaa inaad iibsato baakidhyo internet ah, aad bixiso lacag, ooad maamusho boorsadaada. Bogga Home ka dooro shirkad iyo baakidh, kadibna bixi — i weydii qayb gaar ah haddii aad su'aal dheeraad ah qabto." },
];

supportRouter.post("/support/ai-assist", requireAuth("customer"), async (req, res) => {
  const question = String(req.body.question ?? "").trim().toLowerCase();
  const match = question ? SUPPORT_FAQ.find((f) => f.keywords.some((k) => question.includes(k))) : undefined;
  sendJson(res, 200, { answered: !!match, answer: match?.answer ?? null });
});

// ---------------- Shared: message media (customer AND Admin Dashboard/Agent App) ----------------
// The one route both sides need: an image/voice message's `mediaUrl` in
// serializeConversation's output points here. Deliberately its own combined
// auth (not requireAuth("customer") or requireSupportActor() alone) since
// both a customer and an authorized staff member/agent need to reach the
// exact same bytes for the exact same message -- "only the customer and the
// assigned/authorized agent should be able to access ... media files" is
// enforced below, per-request, rather than by two separate routes.
supportRouter.get(
  "/support/messages/:id/media",
  requireAuth("customer", "super_admin", "admin", "agent"),
  async (req, res) => {
    const message = await queryOne<{
      conversation_id: string;
      message_type: string;
      media_data: Buffer | null;
      media_mime_type: string | null;
    }>(
      `SELECT conversation_id, message_type, media_data, media_mime_type FROM support_messages WHERE id=$1`,
      [req.params.id]
    );
    if (!message || message.message_type === "text" || !message.media_data) {
      return sendJson(res, 404, { error: "Media not found" });
    }

    const conversation = await queryOne<{ customer_id: string }>(
      `SELECT customer_id FROM support_conversations WHERE id=$1`,
      [message.conversation_id]
    );
    if (!conversation) return sendJson(res, 404, { error: "Media not found" });

    if (req.auth!.role === "customer") {
      if (conversation.customer_id !== req.auth!.sub) {
        return sendJson(res, 403, { error: "Not your conversation" });
      }
    } else if (req.auth!.role === "admin") {
      if (!(await adminHasSupportManage(req.auth!.sub))) {
        return sendJson(res, 403, { error: "Missing the 'support.manage' permission — ask a Super Admin to grant it." });
      }
    }
    // super_admin and agent: always allowed, same as requireSupportActor().

    res.setHeader("Content-Type", message.media_mime_type ?? "application/octet-stream");
    // private, not public -- this is a customer's own conversation media,
    // never suitable for a shared/CDN cache the way promo_images' is.
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(message.media_data);
  }
);

// ---------------- Agent-facing (Admin Dashboard AND Agent App) ----------------
// Every route below is reachable at both an /admin/support/... path (Admin
// Dashboard, kept for backward compatibility with the existing web UI) and
// the equivalent /agent/support/... path (native Agent App), registered as
// one array of paths pointing at the exact same handler -- not a second
// implementation, the same code, same queue, same data. requireSupportActor()
// is what actually decides who's allowed through either path.

dual("get", "/admin/support/status", "/agent/support/status", requireSupportActor(), async (req, res) => {
  const actor = actorFromAuth(req.auth!);
  const status = await queryOne<{ online: boolean }>(
    `SELECT online FROM support_agent_status WHERE admin_id=$1 AND actor_role=$2`,
    [actor.id, actor.role]
  );
  const active = await queryOne(
    `SELECT id FROM support_conversations WHERE agent_id=$1 AND agent_role=$2 AND status='assigned'`,
    [actor.id, actor.role]
  );
  sendJson(res, 200, { online: status?.online ?? false, activeConversationId: active?.id ?? null });
});

dual("put", "/admin/support/status", "/agent/support/status", requireSupportActor(), async (req, res) => {
  const actor = actorFromAuth(req.auth!);
  const online = Boolean(req.body.online);
  await query(
    `INSERT INTO support_agent_status (admin_id, actor_role, online, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (admin_id) DO UPDATE SET online=$3, actor_role=$2, updated_at=now()`,
    [actor.id, actor.role, online]
  );

  if (!online) {
    // Never drop the conversation -- free it back into the assignable pool
    // (queued/pending, whichever the next claim-next call would prefer is
    // irrelevant: both are eligible) so the next available agent picks it
    // up, all messages intact. Same behavior regardless of whether it was a
    // staff member or a field agent who went offline.
    const reassigned = await query<{ id: string }>(
      `UPDATE support_conversations SET status='pending', agent_id=NULL, agent_role=NULL, updated_at=now()
       WHERE agent_id=$1 AND agent_role=$2 AND status='assigned' RETURNING id`,
      [actor.id, actor.role]
    );
    for (const row of reassigned) {
      await query(`INSERT INTO support_messages (id, conversation_id, sender_type, body) VALUES ($1,$2,'system',$3)`, [
        randomUUID(),
        row.id,
        "The agent went offline. You'll be connected to the next available agent.",
      ]);
      broadcast({ type: "support_conversation.updated", conversationId: row.id });
    }

    // Don't just leave the freed conversations sitting in the pool for
    // whenever someone next hits claim-next -- if another agent is already
    // online and idle right now, hand them over immediately (oldest-first,
    // same claimNextForAgent FIFO claim every other auto-assign path uses).
    // One attempt per conversation just freed; stops as soon as nobody's
    // idle anymore.
    for (let i = 0; i < reassigned.length; i++) {
      const idleActor = await findIdleOnlineActor();
      if (!idleActor) break;
      const claimed = await claimNextForAgent({ id: idleActor.actor_id, role: idleActor.actor_role });
      if (!claimed) break;
      broadcast({ type: "support_conversation.updated", conversationId: claimed.id });
    }
  } else {
    // Coming online: this actor is immediately idle (they can't have
    // anything assigned yet -- claim endpoints refuse a second one), so
    // hand them the oldest waiting customer right now instead of leaving
    // them to sit in the pool until someone taps claim-next. This is what
    // lets a customer already waiting get connected automatically the
    // moment any agent becomes available, not just when their own agent
    // frees up.
    const claimed = await claimNextForAgent(actor);
    if (claimed) broadcast({ type: "support_conversation.updated", conversationId: claimed.id });
  }

  sendJson(res, 200, { online });
});

dual("get", "/admin/support/queue", "/agent/support/queue", requireSupportActor(), async (req, res) => {
  const rows = await query(
    `SELECT c.*, cu.name AS customer_name, cu.phone AS customer_phone,
            (SELECT body FROM support_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at ASC LIMIT 1) AS first_message
     FROM support_conversations c
     JOIN customers cu ON cu.id = c.customer_id
     WHERE c.status IN ('queued','pending')
     ORDER BY c.created_at ASC`
  );
  sendJson(res, 200, rows);
});

dual("get", "/admin/support/conversations/:id", "/agent/support/conversations/:id", requireSupportActor(), async (req, res) => {
  const conversation = await queryOne(
    `SELECT c.*, cu.name AS customer_name, cu.phone AS customer_phone
     FROM support_conversations c JOIN customers cu ON cu.id = c.customer_id
     WHERE c.id=$1`,
    [req.params.id]
  );
  if (!conversation) return sendJson(res, 404, { error: "Conversation not found" });
  sendJson(res, 200, await serializeConversation(conversation, { includeMessages: true }));
});

// The single atomic "give me the oldest waiting customer" claim -- same
// FOR UPDATE SKIP LOCKED-on-the-candidate-row idiom used for every other
// work queue in this codebase (see smsLogs/resellerSmsMatching/orders
// matching), so two actors (staff or field agents, any mix) hitting this at
// the same instant can never both walk away with the same customer.
async function claimNextForAgent(actor: SupportActor) {
  return queryOne(
    `UPDATE support_conversations SET status='assigned', agent_id=$1, agent_role=$2, assigned_at=now(), updated_at=now()
     WHERE id = (
       SELECT id FROM support_conversations
       WHERE status IN ('queued','pending')
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [actor.id, actor.role]
  );
}

dual("post", "/admin/support/claim-next", "/agent/support/claim-next", requireSupportActor(), async (req, res) => {
  const actor = actorFromAuth(req.auth!);
  const status = await queryOne<{ online: boolean }>(
    `SELECT online FROM support_agent_status WHERE admin_id=$1 AND actor_role=$2`,
    [actor.id, actor.role]
  );
  if (!status?.online) return sendJson(res, 409, { error: "Go online before claiming a conversation" });

  const alreadyActive = await queryOne(
    `SELECT id FROM support_conversations WHERE agent_id=$1 AND agent_role=$2 AND status='assigned'`,
    [actor.id, actor.role]
  );
  if (alreadyActive) return sendJson(res, 409, { error: "Finish your current conversation first" });

  const claimed = await claimNextForAgent(actor);
  if (!claimed) return sendJson(res, 200, { claimed: null });

  broadcast({ type: "support_conversation.updated", conversationId: claimed.id });
  sendJson(res, 200, { claimed: await serializeConversation(claimed, { includeMessages: true }) });
});

// Claim one specific waiting conversation (lets an agent pick a particular
// customer out of the list, not just always take the oldest).
dual(
  "post",
  "/admin/support/conversations/:id/claim",
  "/agent/support/conversations/:id/claim",
  requireSupportActor(),
  async (req, res) => {
    const actor = actorFromAuth(req.auth!);
    const status = await queryOne<{ online: boolean }>(
      `SELECT online FROM support_agent_status WHERE admin_id=$1 AND actor_role=$2`,
      [actor.id, actor.role]
    );
    if (!status?.online) return sendJson(res, 409, { error: "Go online before claiming a conversation" });

    const alreadyActive = await queryOne(
      `SELECT id FROM support_conversations WHERE agent_id=$1 AND agent_role=$2 AND status='assigned'`,
      [actor.id, actor.role]
    );
    if (alreadyActive) return sendJson(res, 409, { error: "Finish your current conversation first" });

    const claimed = await queryOne(
      `UPDATE support_conversations SET status='assigned', agent_id=$1, agent_role=$2, assigned_at=now(), updated_at=now()
       WHERE id=$3 AND status IN ('queued','pending') RETURNING *`,
      [actor.id, actor.role, req.params.id]
    );
    if (!claimed) return sendJson(res, 409, { error: "This conversation was already claimed or is no longer waiting" });

    broadcast({ type: "support_conversation.updated", conversationId: claimed.id });
    sendJson(res, 200, await serializeConversation(claimed, { includeMessages: true }));
  }
);

dual(
  "post",
  "/admin/support/conversations/:id/messages",
  "/agent/support/conversations/:id/messages",
  requireSupportActor(),
  async (req, res) => {
    const actor = actorFromAuth(req.auth!);
    const composed = composeMessage(req.body.message, req.body.messageType, req.body.mediaBase64);
    if ("error" in composed) return sendJson(res, 400, { error: composed.error });

    const conversation = await queryOne(`SELECT * FROM support_conversations WHERE id=$1`, [req.params.id]);
    if (!conversation) return sendJson(res, 404, { error: "Conversation not found" });
    if (conversation.agent_id !== actor.id || conversation.agent_role !== actor.role) {
      return sendJson(res, 403, { error: "This conversation is assigned to a different agent" });
    }
    if (conversation.status !== "assigned") {
      return sendJson(res, 409, { error: "This conversation is not active" });
    }

    await query(
      `INSERT INTO support_messages (id, conversation_id, sender_type, sender_admin_id, sender_role, message_type, body, media_data, media_mime_type)
       VALUES ($1,$2,'agent',$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), req.params.id, actor.id, actor.role, composed.messageType, composed.body, composed.mediaData, composed.mediaMimeType]
    );
    await query(`UPDATE support_conversations SET updated_at=now() WHERE id=$1`, [req.params.id]);

    broadcast({ type: "support_conversation.updated", conversationId: req.params.id });
    sendJson(res, 201, await serializeConversation(conversation, { includeMessages: true }));
  }
);

/**
 * Shared by /resolve and /close: ends the actor's current conversation, then
 * immediately tries to hand them the next oldest waiting one — "when the
 * agent finishes, the next waiting customer should automatically become
 * available" (spec), done server-side rather than requiring a separate
 * manual claim.
 */
async function endConversationAndAutoClaim(
  id: string,
  actor: SupportActor,
  finalStatus: "resolved" | "closed"
): Promise<{ ok: true; next: any } | { ok: false }> {
  const timestampColumn = finalStatus === "resolved" ? "resolved_at" : "closed_at";
  const ended = await queryOne(
    `UPDATE support_conversations SET status=$1, ${timestampColumn}=now(), updated_at=now()
     WHERE id=$2 AND agent_id=$3 AND agent_role=$4 AND status='assigned' RETURNING id`,
    [finalStatus, id, actor.id, actor.role]
  );
  if (!ended) return { ok: false };
  // Agent Support conversation content (text, images, voice) is ephemeral --
  // it exists only for the session it belongs to. Deleting the message rows
  // deletes their media_data BYTEA in the same statement, since media lives
  // on the message row itself (migration 063) -- no separate blob cleanup to
  // keep in sync. The conversation row itself (status, timestamps, who
  // handled it) is kept for queue history/oversight; only the message
  // content is ephemeral. Same delete on the customer-facing /cancel path
  // above, the only other route that ends a conversation.
  await query(`DELETE FROM support_messages WHERE conversation_id=$1`, [id]);
  broadcast({ type: "support_conversation.updated", conversationId: id });

  const next = await claimNextForAgent(actor);
  if (next) broadcast({ type: "support_conversation.updated", conversationId: next.id });
  return { ok: true, next };
}

dual(
  "post",
  "/admin/support/conversations/:id/resolve",
  "/agent/support/conversations/:id/resolve",
  requireSupportActor(),
  async (req, res) => {
    const result = await endConversationAndAutoClaim(req.params.id, actorFromAuth(req.auth!), "resolved");
    if (!result.ok) return sendJson(res, 409, { error: "Conversation not found, not yours, or not active" });
    sendJson(res, 200, {
      ended: true,
      next: result.next ? await serializeConversation(result.next, { includeMessages: true }) : null,
    });
  }
);

dual(
  "post",
  "/admin/support/conversations/:id/close",
  "/agent/support/conversations/:id/close",
  requireSupportActor(),
  async (req, res) => {
    const result = await endConversationAndAutoClaim(req.params.id, actorFromAuth(req.auth!), "closed");
    if (!result.ok) return sendJson(res, 409, { error: "Conversation not found, not yours, or not active" });
    sendJson(res, 200, {
      ended: true,
      next: result.next ? await serializeConversation(result.next, { includeMessages: true }) : null,
    });
  }
);

// ---------------- 1-hour waiting-queue timeout sweep ----------------
// A 'queued' conversation (live position shown to the customer) that ages
// past an hour with no agent free is demoted to 'pending' -- never
// deleted, message history untouched -- so the customer app switches from
// a live position to "an agent will respond when available". Runs on a
// timer at module load, mirroring orderEvents.ts's own self-starting
// heartbeat interval; safe to import this module more than once since ES
// modules are cached, so the interval only actually starts once.
const SUPPORT_QUEUE_TIMEOUT_SWEEP_MS = 60_000;
setInterval(async () => {
  try {
    const expired = await query<{ id: string }>(
      `UPDATE support_conversations SET status='pending', updated_at=now()
       WHERE status='queued' AND created_at < now() - interval '1 hour'
       RETURNING id`
    );
    for (const row of expired) {
      await query(`INSERT INTO support_messages (id, conversation_id, sender_type, body) VALUES ($1,$2,'system',$3)`, [
        randomUUID(),
        row.id,
        "No agent became available within an hour. An agent will respond to you as soon as one is available.",
      ]);
      broadcast({ type: "support_conversation.updated", conversationId: row.id });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Support queue timeout sweep failed:", (err as Error).message);
  }
}, SUPPORT_QUEUE_TIMEOUT_SWEEP_MS);
