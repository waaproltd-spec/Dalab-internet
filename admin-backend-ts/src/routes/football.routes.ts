import { Router, type Request, type Response, type NextFunction } from "express";
import type { PoolClient } from "pg";
import { promises as fs } from "node:fs";
import path from "node:path";
import { query, queryOne, withTransaction } from "../db/pool.js";
import { requireAuth } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { rateLimit } from "../auth/rateLimit.js";
import { sendJson } from "../utils/camelCase.js";
import { sendPushToCustomer } from "../services/push.js";
import { randomUUID } from "node:crypto";
import { MediaError, deleteImageFile, imageInUse, mediaDir, readImage, saveImage } from "../utils/mediaStorage.js";

/**
 * Ciyaaraha -- football exact-score prediction contests.
 *
 * Fairness rules enforced here (never by the apps):
 *  - one prediction per customer per contest, accepted only while the
 *    contest is open AND the server clock is before predictions_close_at;
 *  - the time that counts is the database clock at insert
 *    (football_predictions.created_at, ties by seq) -- the client sends no
 *    time at all, and predictions cannot be changed (DB trigger);
 *  - the candidate winner is computed by the server: the earliest prediction
 *    whose score equals the official score. An agent can only confirm that
 *    exact candidate, never pick someone else; no exact match = no winner;
 *  - the customer is told they won only after an agent confirms;
 *  - a reward can be recorded as paid only once per contest (unique index).
 *
 * Agents need agents.ciyaaraha_enabled (switched on by an Admin). Every
 * result entry/correction, confirmation, reward, dispute and automatic
 * status change is written to football_contest_events.
 */
export const footballRouter = Router();

const STATUSES_WITH_RESULT = new Set(["verification", "no_winner", "completed"]);

// ---------- helpers ----------

export function maskPhone(phone: string | null | undefined): string {
  const d = String(phone ?? "").replace(/\D/g, "").slice(-9);
  if (d.length < 6) return d ? "*".repeat(d.length) : "";
  return `${d.slice(0, 2)}****${d.slice(-3)}`;
}

/** "Ahmed Ali Yusuf" -> "Ahmed A." -- for public winner display. */
export function publicName(name: string | null | undefined): string {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "DALAB";
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[1][0].toUpperCase()}.`;
}

function imageUrl(id: string | null | undefined): string | null {
  return id ? `/football/images/${id}` : null;
}

function parseGoals(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 30 ? n : null;
}

function parseTime(v: unknown): Date | null {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function logEvent(
  db: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  contestId: string,
  actorType: "agent" | "admin" | "system",
  actorId: string | null,
  action: string,
  oldValue: unknown,
  newValue: unknown
) {
  await db.query(
    `INSERT INTO football_contest_events (contest_id, actor_type, actor_id, action, old_value, new_value) VALUES ($1,$2,$3,$4,$5,$6)`,
    [contestId, actorType, actorId, action, oldValue == null ? null : JSON.stringify(oldValue), newValue == null ? null : JSON.stringify(newValue)]
  );
}

/** The earliest prediction with exactly this score (server time, then insert order). */
export async function earliestExactPrediction(
  db: PoolClient | null,
  contestId: string,
  home: number,
  away: number
): Promise<{ id: string; customer_id: string; created_at: string } | null> {
  const sql = `SELECT id, customer_id, created_at FROM football_predictions
                WHERE contest_id=$1 AND home_goals=$2 AND away_goals=$3
                ORDER BY created_at ASC, seq ASC LIMIT 1`;
  if (db) return (await db.query(sql, [contestId, home, away])).rows[0] ?? null;
  return queryOne(sql, [contestId, home, away]);
}

/** What the apps show, from the stored status and the clock. */
export function displayStatus(c: { status: string; kickoff_at: string | Date; predictions_close_at: string | Date }, now = new Date()): string {
  const kickoff = new Date(c.kickoff_at).getTime();
  const t = now.getTime();
  switch (c.status) {
    case "open":
      return t < new Date(c.predictions_close_at).getTime() ? "predictions_open" : "predictions_closed";
    case "closed":
      return t < kickoff ? "predictions_closed" : "match_in_progress";
    case "awaiting_result":
      return "awaiting_result";
    case "verification":
      return "winner_verification";
    case "completed":
    case "no_winner":
      return "completed";
    default:
      return c.status; // draft, cancelled, disputed
  }
}

const CONTEST_SELECT = `
  SELECT fc.*, ht.name AS home_team_name, ht.logo_image_id AS home_logo_id,
         at.name AS away_team_name, at.logo_image_id AS away_logo_id,
         co.name AS reward_company_name,
         (SELECT COUNT(*)::int FROM football_predictions p WHERE p.contest_id=fc.id) AS participants
    FROM football_contests fc
    JOIN football_teams ht ON ht.id = fc.home_team_id
    JOIN football_teams at ON at.id = fc.away_team_id
    JOIN companies co ON co.id = fc.reward_company_id
     -- Deleted contests (migration 122) are hidden from every list and lookup.
     AND fc.deleted_at IS NULL`;

function contestView(c: any, now = new Date()) {
  const showResult = STATUSES_WITH_RESULT.has(c.status);
  return {
    id: c.id,
    homeTeam: { id: c.home_team_id, name: c.home_team_name, logoUrl: imageUrl(c.home_logo_id) },
    awayTeam: { id: c.away_team_id, name: c.away_team_name, logoUrl: imageUrl(c.away_logo_id) },
    league: c.league,
    kickoffAt: c.kickoff_at,
    predictionsCloseAt: c.predictions_close_at,
    rewardLabel: c.reward_label,
    rewardCompany: { id: c.reward_company_id, name: c.reward_company_name },
    imageUrl: imageUrl(c.image_id),
    participants: Number(c.participants ?? 0),
    status: c.status,
    displayStatus: displayStatus(c, now),
    officialScore: showResult && c.official_home_goals != null ? { home: c.official_home_goals, away: c.official_away_goals } : null,
    serverTime: now.toISOString(),
  };
}

// ---------- images (public read) ----------

footballRouter.get("/football/images/:id", async (req, res) => {
  const img = await readImage(req.params.id);
  if (!img) return sendJson(res, 404, { error: "Image not found" });
  res.setHeader("Content-Type", img.mimeType);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(img.data);
});

// ---------- customer ----------

footballRouter.get("/football/contests", requireAuth("customer"), async (req, res) => {
  const scope = req.query.scope === "completed" ? "completed" : "active";
  const page = Math.max(0, Number(req.query.page) || 0);
  const where =
    scope === "completed"
      ? `fc.status IN ('completed','no_winner','cancelled')`
      : `fc.status IN ('open','closed','awaiting_result','verification','disputed')`;
  const order = scope === "completed" ? "fc.kickoff_at DESC" : "fc.kickoff_at ASC";
  const rows = await query<any>(
    `${CONTEST_SELECT}
      WHERE ${where}
      ORDER BY ${order} LIMIT 30 OFFSET $1`,
    [page * 30]
  );
  const mine = rows.length
    ? await query<any>(
        `SELECT contest_id, id, home_goals, away_goals, created_at FROM football_predictions WHERE customer_id=$1 AND contest_id = ANY($2::uuid[])`,
        [req.auth!.sub, rows.map((r) => r.id)]
      )
    : [];
  const winners = rows.length
    ? await query<any>(
        `SELECT w.contest_id, w.prediction_id, cu.name FROM football_winners w JOIN customers cu ON cu.id=w.customer_id
          WHERE w.contest_id = ANY($1::uuid[]) AND w.status <> 'revoked' AND w.status <> 'disputed'`,
        [rows.map((r) => r.id)]
      )
    : [];
  const now = new Date();
  sendJson(
    res,
    200,
    rows.map((c) => {
      const p = mine.find((m) => m.contest_id === c.id);
      const w = winners.find((x) => x.contest_id === c.id);
      return {
        ...contestView(c, now),
        myPrediction: p ? { id: p.id, home: p.home_goals, away: p.away_goals, submittedAt: p.created_at } : null,
        myResult: !p ? null : w ? (w.prediction_id === p.id ? "won" : "lost") : c.status === "no_winner" ? "lost" : "pending",
        winner: w ? { name: publicName(w.name) } : null,
      };
    })
  );
});

footballRouter.get("/football/contests/:id", requireAuth("customer"), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Contest not found" });
  const c = await queryOne<any>(`${CONTEST_SELECT} WHERE fc.id=$1 AND fc.status <> 'draft'`, [req.params.id]);
  if (!c) return sendJson(res, 404, { error: "Contest not found" });
  const p = await queryOne<any>(`SELECT id, home_goals, away_goals, created_at FROM football_predictions WHERE contest_id=$1 AND customer_id=$2`, [c.id, req.auth!.sub]);
  const w = await queryOne<any>(
    `SELECT w.prediction_id, w.status, cu.name FROM football_winners w JOIN customers cu ON cu.id=w.customer_id
      WHERE w.contest_id=$1 AND w.status NOT IN ('revoked','disputed')`,
    [c.id]
  );
  sendJson(res, 200, {
    ...contestView(c),
    myPrediction: p ? { id: p.id, home: p.home_goals, away: p.away_goals, submittedAt: p.created_at } : null,
    myResult: !p ? null : w ? (w.prediction_id === p.id ? "won" : "lost") : c.status === "no_winner" ? "lost" : "pending",
    myRewardStatus: p && w && w.prediction_id === p.id ? w.status : null,
    winner: w ? { name: publicName(w.name) } : null,
  });
});

footballRouter.post(
  "/football/contests/:id/predictions",
  requireAuth("customer"),
  rateLimit("football-predict", 30, 15 * 60 * 1000),
  async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Contest not found" });
    const home = parseGoals(req.body?.homeGoals);
    const away = parseGoals(req.body?.awayGoals);
    if (home == null || away == null) return sendJson(res, 400, { error: "homeGoals and awayGoals must be whole numbers from 0 to 30" });
    const customerId = req.auth!.sub;
    const outcome = await withTransaction(async (client) => {
      // FOR SHARE: a concurrent close/cancel waits for this insert (and vice
      // versa), so nothing is accepted after the contest stops taking them.
      const c = (
        await client.query(
          `SELECT id, status, predictions_close_at, clock_timestamp() < predictions_close_at AS still_open
             FROM football_contests WHERE id=$1 FOR SHARE`,
          [req.params.id]
        )
      ).rows[0];
      if (!c || c.status === "draft") return { status: 404, body: { error: "Contest not found" } };
      if (c.status !== "open" || !c.still_open) return { status: 409, body: { code: "PREDICTIONS_CLOSED", error: "Predictions for this match are closed." } };
      const inserted = (
        await client.query(
          `INSERT INTO football_predictions (contest_id, customer_id, home_goals, away_goals) VALUES ($1,$2,$3,$4)
           ON CONFLICT (contest_id, customer_id) DO NOTHING RETURNING id, home_goals, away_goals, created_at`,
          [c.id, customerId, home, away]
        )
      ).rows[0];
      if (!inserted) return { status: 409, body: { code: "ALREADY_PREDICTED", error: "You have already submitted your prediction for this match." } };
      return { status: 201, body: { id: inserted.id, home: inserted.home_goals, away: inserted.away_goals, submittedAt: inserted.created_at } };
    });
    sendJson(res, outcome.status, outcome.body);
  }
);

footballRouter.get("/football/my-predictions", requireAuth("customer"), async (req, res) => {
  const rows = await query<any>(
    `SELECT p.id, p.home_goals, p.away_goals, p.created_at, p.contest_id
       FROM football_predictions p WHERE p.customer_id=$1 ORDER BY p.created_at DESC LIMIT 100`,
    [req.auth!.sub]
  );
  sendJson(res, 200, rows.map((p) => ({ id: p.id, contestId: p.contest_id, home: p.home_goals, away: p.away_goals, submittedAt: p.created_at })));
});

// ---------- agent ----------

async function requireFootballAgent(req: Request, res: Response, next: NextFunction) {
  const a = await queryOne<{ status: string; ciyaaraha_enabled: boolean }>(`SELECT status, ciyaaraha_enabled FROM agents WHERE id=$1`, [req.auth!.sub]);
  if (!a || a.status !== "active" || !a.ciyaaraha_enabled) {
    return sendJson(res, 403, { code: "FOOTBALL_NOT_ENABLED", error: "Ciyaaraha isn't enabled for this agent account. Ask an Admin to turn it on." });
  }
  next();
}
const agentGate = [requireAuth("agent"), requireFootballAgent];

async function upsertTeam(client: PoolClient, team: any): Promise<string> {
  const name = String(team?.name ?? "").trim();
  if (name.length < 2 || name.length > 60) throw new MediaError("Team names must be 2-60 characters");
  const logo = team?.logoImageId && UUID_RE.test(team.logoImageId) ? team.logoImageId : null;
  if (logo) {
    const ok = (await client.query(`SELECT 1 FROM media_images WHERE id=$1 AND status='active'`, [logo])).rows.length;
    if (!ok) throw new MediaError("Team logo image not found");
  }
  const r = (
    await client.query(
      `INSERT INTO football_teams (name, logo_image_id) VALUES ($1,$2)
       ON CONFLICT (lower(name)) DO UPDATE SET logo_image_id = COALESCE(EXCLUDED.logo_image_id, football_teams.logo_image_id), updated_at=now()
       RETURNING id`,
      [name, logo]
    )
  ).rows[0];
  return r.id;
}

footballRouter.get("/agent/football/me", requireAuth("agent"), async (req, res) => {
  const a = await queryOne<{ ciyaaraha_enabled: boolean }>(`SELECT ciyaaraha_enabled FROM agents WHERE id=$1`, [req.auth!.sub]);
  sendJson(res, 200, { enabled: Boolean(a?.ciyaaraha_enabled) });
});

footballRouter.get("/agent/football/teams", ...agentGate, async (_req, res) => {
  const rows = await query<any>(`SELECT id, name, logo_image_id FROM football_teams ORDER BY name LIMIT 500`);
  sendJson(res, 200, rows.map((t) => ({ id: t.id, name: t.name, logoUrl: imageUrl(t.logo_image_id), logoImageId: t.logo_image_id })));
});

footballRouter.post("/agent/football/images", ...agentGate, rateLimit("football-image-upload", 60, 15 * 60 * 1000), async (req, res) => {
  const purpose = req.body?.purpose === "team_logo" ? "team_logo" : "contest_image";
  try {
    const img = await saveImage(req.body?.imageBase64, purpose, { agentId: req.auth!.sub });
    sendJson(res, 201, { id: img.id, url: imageUrl(img.id), mimeType: img.mimeType, sizeBytes: img.sizeBytes });
  } catch (e) {
    if (e instanceof MediaError) return sendJson(res, e.status, { error: e.message });
    throw e;
  }
});

// Deleting an image only marks it; the cleanup job removes the file once
// nothing refers to it. An image a contest or team still uses is refused.
footballRouter.delete("/agent/football/images/:id", ...agentGate, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Image not found" });
  if (await imageInUse(req.params.id)) return sendJson(res, 409, { error: "This image is still used by a contest or team." });
  const r = await query(
    `UPDATE media_images SET status='pending_deletion', delete_requested_at=now() WHERE id=$1 AND status='active' RETURNING id`,
    [req.params.id]
  );
  if (r.length === 0) return sendJson(res, 404, { error: "Image not found" });
  sendJson(res, 200, { id: req.params.id, status: "pending_deletion" });
});

footballRouter.get("/agent/football/contests", ...agentGate, async (req, res) => {
  const page = Math.max(0, Number(req.query.page) || 0);
  const scope = String(req.query.scope ?? "all");
  const where =
    scope === "active" ? `WHERE fc.status IN ('draft','open','closed','awaiting_result','verification','disputed')`
    : scope === "history" ? `WHERE fc.status IN ('completed','no_winner','cancelled')`
    : "";
  const rows = await query<any>(`${CONTEST_SELECT} ${where} ORDER BY fc.kickoff_at DESC LIMIT 30 OFFSET $1`, [page * 30]);
  const now = new Date();
  sendJson(res, 200, rows.map((c) => contestView(c, now)));
});

footballRouter.post("/agent/football/contests", ...agentGate, async (req, res) => {
  const b = req.body ?? {};
  const kickoff = parseTime(b.kickoffAt);
  const close = b.predictionsCloseAt ? parseTime(b.predictionsCloseAt) : kickoff;
  const league = String(b.league ?? "").trim();
  const rewardLabel = String(b.rewardLabel ?? "").trim();
  const companyId = String(b.rewardCompanyId ?? "").trim();
  if (!kickoff || !close) return sendJson(res, 400, { error: "kickoffAt (and predictionsCloseAt, if given) must be valid dates" });
  if (kickoff.getTime() <= Date.now()) return sendJson(res, 400, { error: "Kickoff must be in the future" });
  if (close.getTime() > kickoff.getTime()) return sendJson(res, 400, { error: "Predictions must close at or before kickoff" });
  if (close.getTime() <= Date.now()) return sendJson(res, 400, { error: "The prediction deadline must be in the future" });
  if (!league || league.length > 80) return sendJson(res, 400, { error: "League is required (max 80 characters)" });
  if (!rewardLabel || rewardLabel.length > 80) return sendJson(res, 400, { error: "Reward is required, e.g. \"1 GB Internet\"" });
  const company = await queryOne(`SELECT id FROM companies WHERE id=$1 AND deleted_at IS NULL`, [companyId]);
  if (!company) return sendJson(res, 400, { error: "Choose a valid reward provider (Hormuud, Somnet, Somtel or Amtel)" });
  const imageId = b.imageId && UUID_RE.test(b.imageId) ? b.imageId : null;
  try {
    const created = await withTransaction(async (client) => {
      const homeId = await upsertTeam(client, b.homeTeam);
      const awayId = await upsertTeam(client, b.awayTeam);
      if (homeId === awayId) throw new MediaError("Home and away teams must be different");
      if (imageId && !(await client.query(`SELECT 1 FROM media_images WHERE id=$1 AND status='active'`, [imageId])).rows.length) {
        throw new MediaError("Match image not found");
      }
      const publish = b.publish === true;
      const row = (
        await client.query(
          `INSERT INTO football_contests (home_team_id, away_team_id, league, kickoff_at, predictions_close_at, reward_label, reward_company_id, image_id,
                                          status, published_at, created_by_agent_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, status`,
          [homeId, awayId, league, kickoff, close, rewardLabel, companyId, imageId, publish ? "open" : "draft", publish ? new Date() : null, req.auth!.sub]
        )
      ).rows[0];
      await logEvent(client, row.id, "agent", req.auth!.sub, "contest_created", null, { status: row.status, kickoffAt: kickoff, predictionsCloseAt: close, rewardLabel, companyId });
      return row;
    });
    const c = await queryOne<any>(`${CONTEST_SELECT} WHERE fc.id=$1`, [created.id]);
    sendJson(res, 201, contestView(c));
  } catch (e) {
    if (e instanceof MediaError) return sendJson(res, e.status, { error: e.message });
    throw e;
  }
});

/**
 * Fixes a contest's details (team names, league, reward, provider, image)
 * until its result is entered. Kickoff changes go through /postpone. A
 * renamed team points the contest at that team's row (teams are shared,
 * so the old row is left alone). Every change is logged with old and new.
 */
footballRouter.put("/agent/football/contests/:id", ...agentGate, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Contest not found" });
  const b = req.body ?? {};
  try {
    const out = await withTransaction(async (client) => {
      const c = (await client.query(`SELECT * FROM football_contests WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [req.params.id])).rows[0];
      if (!c) return { status: 404, body: { error: "Contest not found" } };
      if (!["draft", "open", "closed", "awaiting_result"].includes(c.status) || c.official_home_goals != null) {
        return { status: 409, body: { error: "A contest can only be edited before its result is entered." } };
      }
      const next: Record<string, unknown> = {};
      if (b.homeTeam !== undefined) next.home_team_id = await upsertTeam(client, b.homeTeam);
      if (b.awayTeam !== undefined) next.away_team_id = await upsertTeam(client, b.awayTeam);
      const home = (next.home_team_id ?? c.home_team_id) as string;
      const away = (next.away_team_id ?? c.away_team_id) as string;
      if (home === away) throw new MediaError("Home and away teams must be different");
      if (b.league !== undefined) {
        const league = String(b.league ?? "").trim();
        if (!league || league.length > 80) throw new MediaError("League is required (max 80 characters)");
        next.league = league;
      }
      if (b.rewardLabel !== undefined) {
        const label = String(b.rewardLabel ?? "").trim();
        if (!label || label.length > 80) throw new MediaError('Reward is required, e.g. "1 GB Internet"');
        next.reward_label = label;
      }
      if (b.rewardCompanyId !== undefined) {
        const ok = (await client.query(`SELECT 1 FROM companies WHERE id=$1 AND deleted_at IS NULL`, [String(b.rewardCompanyId)])).rows.length;
        if (!ok) throw new MediaError("Choose a valid reward provider (Hormuud, Somnet, Somtel or Amtel)");
        next.reward_company_id = String(b.rewardCompanyId);
      }
      if (b.removeImage === true) next.image_id = null;
      else if (b.imageId) {
        if (!UUID_RE.test(b.imageId) || !(await client.query(`SELECT 1 FROM media_images WHERE id=$1 AND status='active'`, [b.imageId])).rows.length) {
          throw new MediaError("Match image not found");
        }
        next.image_id = b.imageId;
      }
      const changed = Object.keys(next).filter((k) => String(next[k] ?? "") !== String(c[k] ?? ""));
      if (changed.length === 0) return { status: 200, body: { id: c.id, changed: [] } };
      const sets = changed.map((k, i) => `${k}=$${i + 2}`).join(", ");
      await client.query(`UPDATE football_contests SET ${sets}, updated_at=now() WHERE id=$1`, [c.id, ...changed.map((k) => next[k])]);
      await logEvent(
        client, c.id, "agent", req.auth!.sub, "edited",
        Object.fromEntries(changed.map((k) => [k, c[k]])),
        Object.fromEntries(changed.map((k) => [k, next[k]]))
      );
      return { status: 200, body: { id: c.id, changed } };
    });
    if (out.status !== 200) return sendJson(res, out.status, out.body);
    sendJson(res, 200, contestView(await queryOne<any>(`${CONTEST_SELECT} WHERE fc.id=$1`, [req.params.id])));
  } catch (e) {
    if (e instanceof MediaError) return sendJson(res, e.status, { error: e.message });
    throw e;
  }
});

/**
 * Deletes a contest nobody has predicted yet. It is kept as cancelled with
 * deleted_at set (hidden everywhere), so the audit trail survives. Once a
 * customer has predicted, the agent must cancel it instead, so customers
 * still see what happened to their prediction.
 */
footballRouter.delete("/agent/football/contests/:id", ...agentGate, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Contest not found" });
  const out = await withTransaction(async (client) => {
    const c = (await client.query(`SELECT * FROM football_contests WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [req.params.id])).rows[0];
    if (!c) return { status: 404, body: { error: "Contest not found" } };
    const n = Number((await client.query(`SELECT COUNT(*) AS n FROM football_predictions WHERE contest_id=$1`, [c.id])).rows[0].n);
    if (n > 0) {
      return { status: 409, body: { code: "HAS_PREDICTIONS", error: `${n} customer(s) already predicted this match, so it can't be deleted. Cancel it instead.` } };
    }
    await client.query(
      `UPDATE football_contests SET status='cancelled', status_reason='Deleted', deleted_at=now(), deleted_by_agent_id=$2, updated_at=now() WHERE id=$1`,
      [c.id, req.auth!.sub]
    );
    await logEvent(client, c.id, "agent", req.auth!.sub, "deleted", { status: c.status }, { status: "cancelled", deleted: true });
    return { status: 200, body: { id: c.id, deleted: true } };
  });
  sendJson(res, out.status, out.body);
});

footballRouter.post("/agent/football/contests/:id/publish", ...agentGate, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Contest not found" });
  const r = await query<any>(
    `UPDATE football_contests SET status='open', published_at=now(), updated_at=now()
      WHERE id=$1 AND status='draft' AND predictions_close_at > now() RETURNING id`,
    [req.params.id]
  );
  if (r.length === 0) return sendJson(res, 409, { error: "Only a draft whose prediction deadline is still ahead can be published." });
  await logEvent({ query }, req.params.id, "agent", req.auth!.sub, "published", { status: "draft" }, { status: "open" });
  sendJson(res, 200, contestView(await queryOne<any>(`${CONTEST_SELECT} WHERE fc.id=$1`, [req.params.id])));
});

// Postponed match: new kickoff/deadline; predictions already made are kept.
footballRouter.post("/agent/football/contests/:id/postpone", ...agentGate, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Contest not found" });
  const kickoff = parseTime(req.body?.kickoffAt);
  const close = req.body?.predictionsCloseAt ? parseTime(req.body.predictionsCloseAt) : kickoff;
  if (!kickoff || !close || close > kickoff || kickoff.getTime() <= Date.now()) {
    return sendJson(res, 400, { error: "A new future kickoffAt (and a deadline at or before it) is required" });
  }
  const out = await withTransaction(async (client) => {
    const c = (await client.query(`SELECT * FROM football_contests WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!c) return { status: 404, body: { error: "Contest not found" } };
    if (!["draft", "open", "closed", "awaiting_result"].includes(c.status) || c.official_home_goals != null) {
      return { status: 409, body: { error: "Only a contest without a result can be postponed." } };
    }
    const next = c.status === "draft" ? "draft" : close.getTime() > Date.now() ? "open" : "closed";
    await client.query(
      `UPDATE football_contests SET kickoff_at=$2, predictions_close_at=$3, status=$4, status_reason=$5, updated_at=now() WHERE id=$1`,
      [c.id, kickoff, close, next, String(req.body?.reason ?? "Postponed").slice(0, 200)]
    );
    await logEvent(client, c.id, "agent", req.auth!.sub, "postponed", { kickoffAt: c.kickoff_at, status: c.status }, { kickoffAt: kickoff, predictionsCloseAt: close, status: next });
    return { status: 200, body: { id: c.id, status: next } };
  });
  sendJson(res, out.status, out.body);
});

footballRouter.post("/agent/football/contests/:id/cancel", ...agentGate, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Contest not found" });
  const reason = String(req.body?.reason ?? "").trim();
  if (!reason) return sendJson(res, 400, { error: "A reason is required (e.g. match cancelled or abandoned)" });
  const out = await withTransaction(async (client) => {
    const c = (await client.query(`SELECT * FROM football_contests WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!c) return { status: 404, body: { error: "Contest not found" } };
    const hasWinner = (await client.query(`SELECT 1 FROM football_winners WHERE contest_id=$1 AND status <> 'revoked'`, [c.id])).rows.length;
    if (hasWinner || ["completed", "cancelled"].includes(c.status)) {
      return { status: 409, body: { error: "A contest with a confirmed winner, or already cancelled, can't be cancelled." } };
    }
    await client.query(`UPDATE football_contests SET status='cancelled', status_reason=$2, updated_at=now() WHERE id=$1`, [c.id, reason.slice(0, 200)]);
    await logEvent(client, c.id, "agent", req.auth!.sub, "cancelled", { status: c.status }, { status: "cancelled", reason });
    return { status: 200, body: { id: c.id, status: "cancelled" } };
  });
  sendJson(res, out.status, out.body);
});

/**
 * Enters (or, before a winner is confirmed, corrects) the official final
 * score and recomputes the candidate: the earliest exact-score prediction.
 * No exact match -> 'no_winner' (nobody with a wrong score is rewarded).
 */
footballRouter.post("/agent/football/contests/:id/result", ...agentGate, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Contest not found" });
  const home = parseGoals(req.body?.homeGoals);
  const away = parseGoals(req.body?.awayGoals);
  if (home == null || away == null) return sendJson(res, 400, { error: "homeGoals and awayGoals must be whole numbers from 0 to 30" });
  const out = await withTransaction(async (client) => {
    const c = (await client.query(`SELECT *, clock_timestamp() >= kickoff_at AS started FROM football_contests WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!c) return { status: 404, body: { error: "Contest not found" } };
    // 'open' too: after kickoff the deadline has passed even if the 30-second
    // lifecycle job hasn't closed it yet (predictions are refused by the
    // clock check regardless).
    if (!["open", "closed", "awaiting_result", "verification", "no_winner"].includes(c.status) || !c.started) {
      const why = c.status === "disputed" ? "This contest is disputed; an Admin must resolve it." : "The result can be entered only after kickoff, before a winner is confirmed.";
      return { status: 409, body: { error: why } };
    }
    const candidate = await earliestExactPrediction(client, c.id, home, away);
    const next = candidate ? "verification" : "no_winner";
    await client.query(
      `UPDATE football_contests SET official_home_goals=$2, official_away_goals=$3, result_entered_at=now(), result_entered_by=$4,
              candidate_prediction_id=$5, status=$6, completed_at=CASE WHEN $6='no_winner' THEN now() ELSE NULL END, updated_at=now()
        WHERE id=$1`,
      [c.id, home, away, req.auth!.sub, candidate?.id ?? null, next]
    );
    const corrected = c.official_home_goals != null;
    await logEvent(
      client, c.id, "agent", req.auth!.sub, corrected ? "result_corrected" : "result_entered",
      corrected ? { home: c.official_home_goals, away: c.official_away_goals, candidate: c.candidate_prediction_id } : null,
      { home, away, candidate: candidate?.id ?? null, status: next }
    );
    return { status: 200, body: { id: c.id, status: next, officialScore: { home, away }, candidatePredictionId: candidate?.id ?? null } };
  });
  sendJson(res, out.status, out.body);
});

/**
 * Exact-score search, done in the database (indexed), ordered by server
 * submission time. Without a score it lists every prediction in order.
 */
footballRouter.get("/agent/football/contests/:id/predictions", ...agentGate, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Contest not found" });
  const c = await queryOne<any>(
    `SELECT fc.id, fc.status, fc.official_home_goals, fc.official_away_goals, fc.candidate_prediction_id, fc.reward_label, co.name AS reward_company_name
       FROM football_contests fc JOIN companies co ON co.id = fc.reward_company_id WHERE fc.id=$1 AND fc.deleted_at IS NULL`,
    [req.params.id]
  );
  if (!c) return sendJson(res, 404, { error: "Contest not found" });
  const home = req.query.home !== undefined ? parseGoals(req.query.home) : null;
  const away = req.query.away !== undefined ? parseGoals(req.query.away) : null;
  if ((req.query.home !== undefined || req.query.away !== undefined) && (home == null || away == null)) {
    return sendJson(res, 400, { error: "Search a full score, e.g. home=2&away=3" });
  }
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));
  const page = Math.max(0, Number(req.query.page) || 0);
  const args: unknown[] = [c.id];
  let filter = "";
  if (home != null && away != null) { args.push(home, away); filter = "AND p.home_goals=$2 AND p.away_goals=$3"; }
  const total = Number((await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM football_predictions p WHERE p.contest_id=$1 ${filter}`, args))?.n ?? 0);
  const rows = await query<any>(
    `SELECT p.id, p.customer_id, p.home_goals, p.away_goals, p.created_at, cu.name, cu.phone
       FROM football_predictions p JOIN customers cu ON cu.id=p.customer_id
      WHERE p.contest_id=$1 ${filter}
      ORDER BY p.created_at ASC, p.seq ASC
      LIMIT ${pageSize} OFFSET ${page * pageSize}`,
    args
  );
  const winner = await queryOne<any>(`SELECT prediction_id, status FROM football_winners WHERE contest_id=$1 AND status <> 'revoked'`, [c.id]);
  const hasResult = c.official_home_goals != null;
  // The Winning Customer card: the confirmed winner, or else the server's
  // candidate (the earliest exact prediction, chosen when the result was
  // entered). The app only shows it; it never picks one itself.
  const winningId = winner?.prediction_id ?? (hasResult ? c.candidate_prediction_id : null);
  const wp = winningId
    ? await queryOne<any>(
        `SELECT p.id, p.home_goals, p.away_goals, p.created_at, cu.name, cu.phone FROM football_predictions p JOIN customers cu ON cu.id=p.customer_id WHERE p.id=$1`,
        [winningId]
      )
    : null;
  const winningCustomer = wp
    ? {
        predictionId: wp.id,
        customerName: wp.name ?? "",
        phoneMasked: maskPhone(wp.phone),
        home: wp.home_goals,
        away: wp.away_goals,
        submittedAt: wp.created_at,
        rewardLabel: c.reward_label,
        provider: c.reward_company_name,
        confirmed: Boolean(winner),
        winnerStatus: winner?.status ?? null,
        canConfirm: !winner && c.status === "verification" && wp.id === c.candidate_prediction_id,
      }
    : null;
  sendJson(res, 200, {
    total,
    page,
    pageSize,
    officialScore: hasResult ? { home: c.official_home_goals, away: c.official_away_goals } : null,
    candidatePredictionId: c.candidate_prediction_id,
    winner: winner ? { predictionId: winner.prediction_id, status: winner.status } : null,
    hasResult,
    contestStatus: c.status,
    winningCustomer,
    items: rows.map((r, i) => ({
      predictionId: r.id,
      position: page * pageSize + i + 1,
      customerId: r.customer_id,
      customerName: r.name ?? "",
      phoneMasked: maskPhone(r.phone),
      home: r.home_goals,
      away: r.away_goals,
      submittedAt: r.created_at,
      matchesOfficial: hasResult ? r.home_goals === c.official_home_goals && r.away_goals === c.official_away_goals : null,
      isCandidate: r.id === c.candidate_prediction_id,
      isWinner: winner?.prediction_id === r.id,
    })),
  });
});

footballRouter.get("/agent/football/contests/:id", ...agentGate, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Contest not found" });
  const c = await queryOne<any>(`${CONTEST_SELECT} WHERE fc.id=$1`, [req.params.id]);
  if (!c) return sendJson(res, 404, { error: "Contest not found" });
  sendJson(res, 200, await agentContestDetail(c));
});

async function agentContestDetail(c: any) {
  const candidate = c.candidate_prediction_id
    ? await queryOne<any>(
        `SELECT p.id, p.home_goals, p.away_goals, p.created_at, cu.id AS customer_id, cu.name, cu.phone
           FROM football_predictions p JOIN customers cu ON cu.id=p.customer_id WHERE p.id=$1`,
        [c.candidate_prediction_id]
      )
    : null;
  const winner = await queryOne<any>(
    `SELECT w.*, cu.name, cu.phone, p.home_goals, p.away_goals, p.created_at AS predicted_at
       FROM football_winners w JOIN customers cu ON cu.id=w.customer_id JOIN football_predictions p ON p.id=w.prediction_id
      WHERE w.contest_id=$1 AND w.status <> 'revoked'`,
    [c.id]
  );
  const rewards = winner
    ? await query<any>(`SELECT id, attempt_no, status, transaction_ref, note, reward_label, company_id, recipient_phone, created_at FROM football_reward_transactions WHERE winner_id=$1 ORDER BY attempt_no`, [winner.id])
    : [];
  const exactCount = c.official_home_goals != null
    ? Number((await queryOne<any>(`SELECT COUNT(*) AS n FROM football_predictions WHERE contest_id=$1 AND home_goals=$2 AND away_goals=$3`, [c.id, c.official_home_goals, c.official_away_goals]))?.n ?? 0)
    : null;
  const events = await query<any>(`SELECT action, actor_type, actor_id, old_value, new_value, created_at FROM football_contest_events WHERE contest_id=$1 ORDER BY created_at DESC LIMIT 50`, [c.id]);
  return {
    ...contestView(c),
    officialScore: c.official_home_goals != null ? { home: c.official_home_goals, away: c.official_away_goals } : null,
    statusReason: c.status_reason,
    exactScoreCount: exactCount,
    candidate: candidate
      ? { predictionId: candidate.id, customerId: candidate.customer_id, customerName: candidate.name ?? "", phoneMasked: maskPhone(candidate.phone), home: candidate.home_goals, away: candidate.away_goals, submittedAt: candidate.created_at }
      : null,
    // The confirmed winner's full number: the agent needs it to deliver the reward.
    winner: winner
      ? { id: winner.id, predictionId: winner.prediction_id, customerId: winner.customer_id, customerName: winner.name ?? "", phone: winner.phone, status: winner.status, confirmedAt: winner.confirmed_at, notifiedAt: winner.notified_at, home: winner.home_goals, away: winner.away_goals, predictedAt: winner.predicted_at }
      : null,
    rewards: rewards.map((r) => ({ id: r.id, attemptNo: r.attempt_no, status: r.status, transactionRef: r.transaction_ref, note: r.note, rewardLabel: r.reward_label, companyId: r.company_id, recipientPhone: r.recipient_phone, createdAt: r.created_at })),
    events,
  };
}

// ---------- result notifications ----------
//
// After the agent confirms the winner, every participant is told the
// result once: the winner gets "Hambalyo! Waad guuleysatay!", everyone else
// "Natiijadii Tartanka Waa La Xaqiijiyey!" -- in the language they chose in
// the Customer App (customers.app_language; Somali when unknown). Rows are
// queued in football_notifications inside the confirmation transaction, so
// nothing goes out before the official confirmation and each person is
// told once per confirmed winner. The in-app notification is written once;
// only the phone push is retried. The winner is named the public way
// ("Ahmed A.") -- never a phone number.

const MAX_NOTIFY_ATTEMPTS = 5;

export interface ResultMessageValues {
  homeTeam: string;
  awayTeam: string;
  officialHome: number;
  officialAway: number;
  winningHome: number;
  winningAway: number;
  reward: string;
  winnerName: string;
}

/** The customer-facing text for a result notification. */
export function resultMessage(kind: "winner" | "participant", language: string | null | undefined, v: ResultMessageValues) {
  const en = language === "en";
  const official = `${v.officialHome}–${v.officialAway}`;
  const winning = `${v.winningHome}–${v.winningAway}`;
  if (kind === "winner") {
    return en
      ? {
          title: "🏆 Congratulations! You won!",
          body:
            `You won the score prediction contest for ${v.homeTeam} vs ${v.awayTeam}.\n\n` +
            `⚽ Official result: ${official}\n\n🎯 Your correct prediction: ${winning}\n\n🎁 Your reward: ${v.reward}\n\n` +
            `Open DALAB APP to see the details of your win and your reward.`,
        }
      : {
          title: "🏆 Hambalyo! Waad guuleysatay!",
          body:
            `Waxaad ku guuleysatay tartanka saadaasha ciyaarta ${v.homeTeam} vs ${v.awayTeam}.\n\n` +
            `⚽ Natiijada rasmiga ah: ${official}\n\n🎯 Saadaashaadii saxda ahayd: ${winning}\n\n🎁 Abaalmarintaada: ${v.reward}\n\n` +
            `Fur DALAB APP si aad u aragto faahfaahinta guushaada iyo abaalmarintaada.`,
        };
  }
  return en
    ? {
        title: "🔔 The Contest Result Is Confirmed!",
        body:
          `The score prediction contest for ${v.homeTeam} vs ${v.awayTeam} has been completed.\n\n` +
          `🏆 Winner: ${v.winnerName}\n\n⚽ Winning prediction: ${winning}\n\n` +
          `Thank you for taking part. Good luck in the next contests!`,
      }
    : {
        title: "🔔 Natiijadii Tartanka Waa La Xaqiijiyey!",
        body:
          `Tartanka saadaasha ciyaarta ${v.homeTeam} vs ${v.awayTeam} waa la dhammeystiray.\n\n` +
          `🏆 Guuleystaha: ${v.winnerName}\n\n⚽ Saadaashii guuleysatay: ${winning}\n\n` +
          `Waad ku mahadsan tahay ka qaybgalka tartanka. Nasiib wacan tartamada soo socda!`,
      };
}

/** Queues one result notification per participant; call inside the confirmation transaction. */
async function queueResultNotifications(client: PoolClient, contestId: string, winnerId: string, winnerCustomerId: string) {
  await client.query(
    `INSERT INTO football_notifications (contest_id, winner_id, customer_id, kind)
     SELECT $1, $2, p.customer_id, CASE WHEN p.customer_id = $3 THEN 'winner' ELSE 'participant' END
       FROM football_predictions p WHERE p.contest_id = $1
     ON CONFLICT (winner_id, customer_id) DO NOTHING`,
    [contestId, winnerId, winnerCustomerId]
  );
}

let delivering = false;

/**
 * Sends due result notifications (claimed with SKIP LOCKED, so two runs
 * never send the same one). Rows of a winner later disputed or revoked
 * are held back. A failed push is retried with growing gaps, up to
 * MAX_NOTIFY_ATTEMPTS; a customer with no registered phone only gets the
 * in-app notification ("no_device").
 */
export async function deliverFootballNotifications(limit = 200): Promise<{ processed: number }> {
  if (delivering) return { processed: 0 };
  delivering = true;
  try {
    const rows = await query<any>(
      `UPDATE football_notifications n
          SET attempts = n.attempts + 1, next_attempt_at = now() + (LEAST(n.attempts + 1, 6) * interval '2 minutes')
        WHERE n.id IN (
          SELECT fn.id FROM football_notifications fn JOIN football_winners w ON w.id = fn.winner_id
           WHERE w.status NOT IN ('revoked','disputed')
             AND (fn.notification_id IS NULL OR fn.push_status IN ('pending','failed'))
             AND fn.attempts < $2 AND fn.next_attempt_at <= now()
           ORDER BY fn.created_at LIMIT $1
           FOR UPDATE OF fn SKIP LOCKED)
        RETURNING n.*`,
      [limit, MAX_NOTIFY_ATTEMPTS]
    );
    const winners = new Map<string, any>();
    for (const n of rows) {
      try {
        let w = winners.get(n.winner_id);
        if (!w) {
          w = await queryOne<any>(
            `SELECT w.id, w.customer_id, cu.name, p.home_goals, p.away_goals FROM football_winners w
               JOIN customers cu ON cu.id = w.customer_id JOIN football_predictions p ON p.id = w.prediction_id WHERE w.id = $1`,
            [n.winner_id]
          );
          w.contest = await queryOne<any>(`SELECT fc.*, ht.name AS home_team_name, at.name AS away_team_name, co.name AS reward_company_name
              FROM football_contests fc JOIN football_teams ht ON ht.id = fc.home_team_id JOIN football_teams at ON at.id = fc.away_team_id
              JOIN companies co ON co.id = fc.reward_company_id WHERE fc.id = $1`, [n.contest_id]);
          winners.set(n.winner_id, w);
        }
        const c = w.contest;
        const dataKind = n.kind === "winner" ? "football_winner" : "football_result";
        let notificationId: string = n.notification_id;
        let title: string;
        let body: string;
        let sentAt: string;
        if (!notificationId) {
          const lang = (await queryOne<any>(`SELECT app_language FROM customers WHERE id = $1`, [n.customer_id]))?.app_language ?? "so";
          ({ title, body } = resultMessage(n.kind, lang, {
            homeTeam: c.home_team_name, awayTeam: c.away_team_name,
            officialHome: c.official_home_goals, officialAway: c.official_away_goals,
            winningHome: w.home_goals, winningAway: w.away_goals,
            reward: `${c.reward_label} (${c.reward_company_name})`,
            winnerName: publicName(w.name),
          }));
          notificationId = randomUUID();
          sentAt = new Date().toISOString();
          // The in-app row and the queue row change together, so a retry
          // never writes the in-app notification twice.
          await withTransaction(async (client) => {
            await client.query(
              `INSERT INTO notifications (id, type, title, body, customer_id, sent_at, data) VALUES ($1,'football_contest',$2,$3,$4,$5,$6)`,
              [notificationId, title, body, n.customer_id, sentAt, JSON.stringify({ kind: dataKind, contestId: n.contest_id })]
            );
            await client.query(`UPDATE football_notifications SET notification_id=$2, language=$3, sent_at=$4 WHERE id=$1`, [n.id, notificationId, lang, sentAt]);
            if (n.kind === "winner") {
              const first = (await client.query(`UPDATE football_winners SET notified_at=now() WHERE id=$1 AND notified_at IS NULL RETURNING id`, [n.winner_id])).rows.length;
              if (first) await logEvent(client, n.contest_id, "system", null, "winner_notified", null, { customerId: n.customer_id });
            }
          });
        } else {
          const prev = await queryOne<any>(`SELECT title, body, sent_at FROM notifications WHERE id = $1`, [notificationId]);
          title = prev?.title ?? "";
          body = prev?.body ?? "";
          sentAt = prev?.sent_at ? new Date(prev.sent_at).toISOString() : new Date().toISOString();
        }
        const push = await sendPushToCustomer(n.customer_id, {
          title,
          body,
          data: { kind: dataKind, contestId: n.contest_id, notificationId, notificationType: "football_contest", sentAt },
        });
        const status = !push.attempted ? "no_device" : push.delivered ? "sent" : "failed";
        await query(`UPDATE football_notifications SET push_status=$2, last_error=$3 WHERE id=$1`, [n.id, status, status === "failed" ? "push not delivered" : null]);
      } catch (e) {
        await query(`UPDATE football_notifications SET last_error=$2 WHERE id=$1`, [n.id, String((e as Error).message).slice(0, 300)]).catch(() => {});
      }
    }
    return { processed: rows.length };
  } finally {
    delivering = false;
  }
}

/**
 * The agent confirms the server's candidate -- the request must name it,
 * so a stale screen can't confirm someone else after a correction.
 */
footballRouter.post("/agent/football/contests/:id/confirm-winner", ...agentGate, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Contest not found" });
  const predictionId = String(req.body?.predictionId ?? "");
  const out = await withTransaction(async (client) => {
    const c = (await client.query(`SELECT * FROM football_contests WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!c) return { status: 404, body: { error: "Contest not found" } };
    const existing = (await client.query(`SELECT prediction_id FROM football_winners WHERE contest_id=$1 AND status <> 'revoked'`, [c.id])).rows[0];
    if (existing) {
      return existing.prediction_id === predictionId
        ? { status: 200, body: { id: c.id, status: c.status, alreadyConfirmed: true } }
        : { status: 409, body: { error: "A different winner is already confirmed for this contest." } };
    }
    if (c.status !== "verification" || c.official_home_goals == null) {
      return { status: 409, body: { error: "Enter the official result first; there must be a correct prediction to confirm." } };
    }
    const candidate = await earliestExactPrediction(client, c.id, c.official_home_goals, c.official_away_goals);
    if (!candidate || candidate.id !== predictionId || candidate.id !== c.candidate_prediction_id) {
      return { status: 409, body: { code: "NOT_THE_CANDIDATE", error: "Only the earliest correct prediction can be confirmed. Refresh and check again." } };
    }
    const winner = (
      await client.query(
        `INSERT INTO football_winners (contest_id, prediction_id, customer_id, confirmed_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [c.id, candidate.id, candidate.customer_id, req.auth!.sub]
      )
    ).rows[0];
    await queueResultNotifications(client, c.id, winner.id, candidate.customer_id);
    await client.query(`UPDATE football_contests SET status='completed', completed_at=now(), updated_at=now() WHERE id=$1`, [c.id]);
    await logEvent(client, c.id, "agent", req.auth!.sub, "winner_confirmed", null, { predictionId: candidate.id, customerId: candidate.customer_id, score: { home: c.official_home_goals, away: c.official_away_goals } });
    return { status: 200, body: { id: c.id, status: "completed" } };
  });
  if (out.status === 200) await deliverFootballNotifications().catch(() => ({ processed: 0 }));
  sendJson(res, out.status, out.body);
});

/**
 * Records the manually delivered reward: 'pending' (agent is sending it),
 * 'paid' (with the carrier's transaction reference) or 'failed' (retry
 * later). A second 'paid' is rejected by the unique index.
 */
footballRouter.post("/agent/football/contests/:id/reward", ...agentGate, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Contest not found" });
  const status = String(req.body?.status ?? "");
  const ref = String(req.body?.transactionRef ?? "").trim().slice(0, 120);
  const note = String(req.body?.note ?? "").trim().slice(0, 300) || null;
  if (!["pending", "paid", "failed"].includes(status)) return sendJson(res, 400, { error: "status must be pending, paid or failed" });
  if (status === "paid" && !ref) return sendJson(res, 400, { error: "Enter the transaction reference from the carrier's SMS" });
  try {
    const out = await withTransaction(async (client) => {
      const c = (await client.query(`SELECT fc.*, co.name AS company_name FROM football_contests fc JOIN companies co ON co.id=fc.reward_company_id WHERE fc.id=$1 FOR UPDATE OF fc`, [req.params.id])).rows[0];
      if (!c) return { status: 404, body: { error: "Contest not found" } };
      const w = (await client.query(
        `SELECT w.*, cu.phone FROM football_winners w JOIN customers cu ON cu.id=w.customer_id WHERE w.contest_id=$1 AND w.status <> 'revoked' FOR UPDATE OF w`,
        [c.id]
      )).rows[0];
      if (!w) return { status: 409, body: { error: "No confirmed winner yet." } };
      if (w.status === "disputed") return { status: 409, body: { error: "This contest is disputed; an Admin must resolve it first." } };
      if (w.status === "reward_paid") return { status: 409, body: { code: "ALREADY_PAID", error: "The reward is already recorded as paid." } };
      if (status === "pending") {
        await client.query(`UPDATE football_winners SET status='reward_pending', updated_at=now() WHERE id=$1`, [w.id]);
        await logEvent(client, c.id, "agent", req.auth!.sub, "reward_pending", { status: w.status }, { status: "reward_pending" });
        return { status: 200, body: { winnerStatus: "reward_pending" } };
      }
      const attempt = Number((await client.query(`SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM football_reward_transactions WHERE winner_id=$1`, [w.id])).rows[0].n);
      const tx = (await client.query(
        `INSERT INTO football_reward_transactions (contest_id, winner_id, attempt_no, reward_label, company_id, recipient_phone, status, transaction_ref, note, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
        [c.id, w.id, attempt, c.reward_label, c.reward_company_id, w.phone, status, ref || null, note, req.auth!.sub]
      )).rows[0];
      const next = status === "paid" ? "reward_paid" : "reward_failed";
      await client.query(`UPDATE football_winners SET status=$2, updated_at=now() WHERE id=$1`, [w.id, next]);
      await logEvent(client, c.id, "agent", req.auth!.sub, status === "paid" ? "reward_paid" : "reward_failed", { status: w.status }, { status: next, attemptNo: attempt, transactionRef: ref || null, note });
      return { status: 201, body: { winnerStatus: next, transactionId: tx.id, attemptNo: attempt } };
    });
    sendJson(res, out.status, out.body);
  } catch (e: any) {
    if (e?.code === "23505") return sendJson(res, 409, { code: "ALREADY_PAID", error: "The reward is already recorded as paid." });
    throw e;
  }
});

// Any enabled agent can flag a dispute (pauses everything); only an Admin resolves.
footballRouter.post("/agent/football/contests/:id/dispute", ...agentGate, async (req, res) => {
  const out = await openDispute(req.params.id, "agent", req.auth!.sub, String(req.body?.reason ?? ""));
  sendJson(res, out.status, out.body);
});

async function openDispute(contestId: string, actorType: "agent" | "admin", actorId: string, reasonRaw: string) {
  if (!UUID_RE.test(contestId)) return { status: 404, body: { error: "Contest not found" } };
  const reason = reasonRaw.trim().slice(0, 300);
  if (!reason) return { status: 400, body: { error: "A reason is required" } };
  return withTransaction(async (client) => {
    const c = (await client.query(`SELECT * FROM football_contests WHERE id=$1 FOR UPDATE`, [contestId])).rows[0];
    if (!c) return { status: 404, body: { error: "Contest not found" } };
    if (["draft", "cancelled", "disputed"].includes(c.status)) return { status: 409, body: { error: `A ${c.status} contest can't be disputed.` } };
    await client.query(`UPDATE football_contests SET status='disputed', status_reason=$2, updated_at=now() WHERE id=$1`, [c.id, reason]);
    const w = (await client.query(`UPDATE football_winners SET status='disputed', updated_at=now() WHERE contest_id=$1 AND status <> 'revoked' RETURNING id, status`, [c.id])).rows[0];
    await logEvent(client, c.id, actorType, actorId, "dispute_opened", { status: c.status }, { reason, winnerDisputed: Boolean(w) });
    return { status: 200, body: { id: c.id, status: "disputed" } };
  });
}

/** Raadi Macmiil: one customer by phone, customer ID, order ID or prediction ID. */
footballRouter.get("/agent/football/customers/search", ...agentGate, rateLimit("football-customer-search", 120, 15 * 60 * 1000), async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 4) return sendJson(res, 400, { error: "Enter a phone number, customer ID, order ID or prediction ID" });
  let customer: any = null;
  if (UUID_RE.test(q)) {
    customer = await queryOne<any>(`SELECT id, name, phone, created_at FROM customers WHERE id=$1`, [q]);
    if (!customer) customer = await queryOne<any>(`SELECT cu.id, cu.name, cu.phone, cu.created_at FROM football_predictions p JOIN customers cu ON cu.id=p.customer_id WHERE p.id=$1`, [q]);
  } else if (/^DLB\d+$/i.test(q)) {
    customer = await queryOne<any>(`SELECT cu.id, cu.name, cu.phone, cu.created_at FROM orders o JOIN customers cu ON cu.id=o.customer_id WHERE o.id=$1`, [q.toUpperCase()]);
  } else {
    const digits = q.replace(/\D/g, "").slice(-9);
    if (digits.length === 9) {
      customer = await queryOne<any>(`SELECT id, name, phone, created_at FROM customers WHERE right(regexp_replace(phone, '\\D', '', 'g'), 9)=$1 LIMIT 1`, [digits]);
    }
  }
  if (!customer) return sendJson(res, 404, { error: "No customer found" });
  const predictions = await query<any>(
    `SELECT p.id, p.home_goals, p.away_goals, p.created_at, fc.id AS contest_id, fc.status, fc.kickoff_at, fc.league,
            fc.official_home_goals, fc.official_away_goals, ht.name AS home_team_name, at.name AS away_team_name,
            w.status AS winner_status, (w.prediction_id = p.id) AS is_winner
       FROM football_predictions p
       JOIN football_contests fc ON fc.id=p.contest_id
       JOIN football_teams ht ON ht.id=fc.home_team_id JOIN football_teams at ON at.id=fc.away_team_id
       LEFT JOIN football_winners w ON w.contest_id=fc.id AND w.status <> 'revoked'
      WHERE p.customer_id=$1 ORDER BY p.created_at DESC LIMIT 50`,
    [customer.id]
  );
  const rewards = await query<any>(
    `SELECT t.contest_id, t.status, t.transaction_ref, t.reward_label, t.company_id, t.created_at
       FROM football_reward_transactions t JOIN football_winners w ON w.id=t.winner_id WHERE w.customer_id=$1 ORDER BY t.created_at DESC LIMIT 50`,
    [customer.id]
  );
  sendJson(res, 200, {
    customer: { id: customer.id, name: customer.name ?? "", phoneMasked: maskPhone(customer.phone), memberSince: customer.created_at },
    predictions: predictions.map((p) => {
      const hasResult = STATUSES_WITH_RESULT.has(p.status) && p.official_home_goals != null;
      return {
        predictionId: p.id, contestId: p.contest_id, match: `${p.home_team_name} vs ${p.away_team_name}`, league: p.league, kickoffAt: p.kickoff_at,
        home: p.home_goals, away: p.away_goals, submittedAt: p.created_at, contestStatus: p.status,
        officialScore: hasResult ? { home: p.official_home_goals, away: p.official_away_goals } : null,
        outcome: p.is_winner ? "won" : hasResult || p.status === "completed" ? (hasResult && p.home_goals === p.official_home_goals && p.away_goals === p.official_away_goals ? "correct_not_first" : "lost") : p.status === "cancelled" ? "cancelled" : "pending",
        rewardStatus: p.is_winner ? p.winner_status : null,
      };
    }),
    rewards: rewards.map((r) => ({ contestId: r.contest_id, status: r.status, transactionRef: r.transaction_ref, rewardLabel: r.reward_label, companyId: r.company_id, createdAt: r.created_at })),
  });
});

// ---------- admin ----------

footballRouter.get("/admin/football/contests", requirePermission("football.manage"), async (req, res) => {
  const status = typeof req.query.status === "string" && req.query.status ? req.query.status : null;
  const rows = await query<any>(
    `${CONTEST_SELECT} ${status ? "WHERE fc.status=$1" : ""} ORDER BY fc.kickoff_at DESC LIMIT 200`,
    status ? [status] : []
  );
  const winners = rows.length
    ? await query<any>(`SELECT w.contest_id, w.status, cu.name, cu.phone FROM football_winners w JOIN customers cu ON cu.id=w.customer_id WHERE w.contest_id = ANY($1::uuid[]) AND w.status <> 'revoked'`, [rows.map((r) => r.id)])
    : [];
  const now = new Date();
  sendJson(res, 200, rows.map((c) => {
    const w = winners.find((x) => x.contest_id === c.id);
    return {
      ...contestView(c, now),
      officialScore: c.official_home_goals != null ? { home: c.official_home_goals, away: c.official_away_goals } : null,
      statusReason: c.status_reason,
      hasCandidate: Boolean(c.candidate_prediction_id),
      winner: w ? { name: w.name ?? "", phoneMasked: maskPhone(w.phone), status: w.status } : null,
    };
  }));
});

footballRouter.get("/admin/football/contests/:id", requirePermission("football.manage"), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Contest not found" });
  const c = await queryOne<any>(`${CONTEST_SELECT} WHERE fc.id=$1`, [req.params.id]);
  if (!c) return sendJson(res, 404, { error: "Contest not found" });
  sendJson(res, 200, await agentContestDetail(c));
});

footballRouter.post("/admin/football/contests/:id/dispute", requirePermission("football.manage"), async (req, res) => {
  const out = await openDispute(req.params.id, "admin", req.auth!.sub, String(req.body?.reason ?? ""));
  sendJson(res, out.status, out.body);
});

/**
 * Resolves a dispute:
 *  - "uphold": everything stays as it was (winner/result kept);
 *  - "correct_result": the official score was wrong. Allowed only while no
 *    reward is recorded as paid; any current winner is kept as 'revoked'
 *    and the candidate is recomputed for an agent to confirm again.
 */
footballRouter.post("/admin/football/contests/:id/resolve", requirePermission("football.manage"), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Contest not found" });
  const action = String(req.body?.action ?? "");
  const note = String(req.body?.note ?? "").trim().slice(0, 300);
  if (!["uphold", "correct_result"].includes(action)) return sendJson(res, 400, { error: "action must be uphold or correct_result" });
  const out = await withTransaction(async (client) => {
    const c = (await client.query(`SELECT * FROM football_contests WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!c) return { status: 404, body: { error: "Contest not found" } };
    if (c.status !== "disputed") return { status: 409, body: { error: "This contest isn't disputed." } };
    const opened = (await client.query(`SELECT old_value FROM football_contest_events WHERE contest_id=$1 AND action='dispute_opened' ORDER BY created_at DESC LIMIT 1`, [c.id])).rows[0];
    const before = opened?.old_value?.status ?? "closed";
    const w = (await client.query(`SELECT * FROM football_winners WHERE contest_id=$1 AND status <> 'revoked' FOR UPDATE`, [c.id])).rows[0];
    const paid = w ? (await client.query(`SELECT 1 FROM football_reward_transactions WHERE winner_id=$1 AND status='paid'`, [w.id])).rows.length : 0;
    if (action === "uphold") {
      if (w) {
        const last = (await client.query(`SELECT status FROM football_reward_transactions WHERE winner_id=$1 ORDER BY attempt_no DESC LIMIT 1`, [w.id])).rows[0];
        const ws = paid ? "reward_paid" : last?.status === "failed" ? "reward_failed" : "winner_confirmed";
        await client.query(`UPDATE football_winners SET status=$2, updated_at=now() WHERE id=$1`, [w.id, ws]);
      }
      await client.query(`UPDATE football_contests SET status=$2, status_reason=NULL, updated_at=now() WHERE id=$1`, [c.id, before]);
      await logEvent(client, c.id, "admin", req.auth!.sub, "dispute_upheld", { status: "disputed" }, { status: before, note });
      return { status: 200, body: { id: c.id, status: before } };
    }
    const home = parseGoals(req.body?.homeGoals);
    const away = parseGoals(req.body?.awayGoals);
    if (home == null || away == null) return { status: 400, body: { error: "homeGoals and awayGoals are required" } };
    if (paid) return { status: 409, body: { error: "A reward is already recorded as paid; the result can't be changed here. Handle the refund/claim outside the app and uphold." } };
    if (w) await client.query(`UPDATE football_winners SET status='revoked', updated_at=now() WHERE id=$1`, [w.id]);
    const candidate = await earliestExactPrediction(client, c.id, home, away);
    const next = candidate ? "verification" : "no_winner";
    await client.query(
      `UPDATE football_contests SET official_home_goals=$2, official_away_goals=$3, candidate_prediction_id=$4, status=$5, status_reason=NULL,
              completed_at=CASE WHEN $5='no_winner' THEN now() ELSE NULL END, updated_at=now() WHERE id=$1`,
      [c.id, home, away, candidate?.id ?? null, next]
    );
    await logEvent(client, c.id, "admin", req.auth!.sub, "result_corrected_by_admin",
      { home: c.official_home_goals, away: c.official_away_goals, revokedWinner: w?.id ?? null },
      { home, away, candidate: candidate?.id ?? null, status: next, note });
    return { status: 200, body: { id: c.id, status: next, candidatePredictionId: candidate?.id ?? null } };
  });
  sendJson(res, out.status, out.body);
});

footballRouter.get("/admin/football/agents", requirePermission("football.manage"), async (_req, res) => {
  const rows = await query<any>(`SELECT id, name, phone, status, ciyaaraha_enabled FROM agents ORDER BY name`);
  sendJson(res, 200, rows.map((a) => ({ id: a.id, name: a.name, phone: a.phone, status: a.status, ciyaarahaEnabled: a.ciyaaraha_enabled })));
});

footballRouter.put("/admin/football/agents/:id", requirePermission("football.manage"), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return sendJson(res, 404, { error: "Agent not found" });
  const enabled = req.body?.enabled === true;
  const r = await query(`UPDATE agents SET ciyaaraha_enabled=$2 WHERE id=$1 RETURNING id`, [req.params.id, enabled]);
  if (r.length === 0) return sendJson(res, 404, { error: "Agent not found" });
  await query(
    `INSERT INTO admin_activity_log (id, admin_id, action, entity_type, entity_id, old_value, new_value) VALUES (gen_random_uuid(), $1, 'football_agent_access', 'agent', $2, NULL, $3)`,
    [req.auth!.sub, req.params.id, JSON.stringify({ enabled })]
  );
  sendJson(res, 200, { id: req.params.id, ciyaarahaEnabled: enabled });
});

footballRouter.get("/admin/football/rewards", requirePermission("football.manage"), async (_req, res) => {
  const rows = await query<any>(
    `SELECT t.*, ht.name AS home_team_name, at.name AS away_team_name, ag.name AS agent_name
       FROM football_reward_transactions t JOIN football_contests fc ON fc.id=t.contest_id
       JOIN football_teams ht ON ht.id=fc.home_team_id JOIN football_teams at ON at.id=fc.away_team_id
       LEFT JOIN agents ag ON ag.id=t.recorded_by ORDER BY t.created_at DESC LIMIT 200`
  );
  sendJson(res, 200, rows.map((t) => ({ id: t.id, contestId: t.contest_id, match: `${t.home_team_name} vs ${t.away_team_name}`, attemptNo: t.attempt_no, status: t.status, transactionRef: t.transaction_ref, rewardLabel: t.reward_label, companyId: t.company_id, recipientPhoneMasked: maskPhone(t.recipient_phone), agentName: t.agent_name, note: t.note, createdAt: t.created_at })));
});

footballRouter.get("/admin/football/cleanup-runs", requirePermission("football.manage"), async (_req, res) => {
  sendJson(res, 200, await query(`SELECT * FROM cleanup_runs ORDER BY started_at DESC LIMIT 50`));
});

// ---------- automatic jobs ----------

/**
 * Lifecycle: closes predictions at the deadline and marks matches that
 * should be over as awaiting the official result. Each change is a guarded
 * UPDATE ... WHERE status=..., so running it twice changes nothing.
 */
export async function runFootballLifecycle(): Promise<{ closed: number; awaiting: number }> {
  const closed = await query<{ id: string }>(
    `UPDATE football_contests SET status='closed', updated_at=now() WHERE status='open' AND predictions_close_at <= now() RETURNING id`
  );
  for (const r of closed) await logEvent({ query }, r.id, "system", null, "predictions_closed", { status: "open" }, { status: "closed" });
  const minutes = Number(process.env.FOOTBALL_MATCH_LENGTH_MINUTES) || 110;
  const awaiting = await query<{ id: string }>(
    `UPDATE football_contests SET status='awaiting_result', updated_at=now()
      WHERE status='closed' AND kickoff_at <= now() - ($1 || ' minutes')::interval RETURNING id`,
    [String(minutes)]
  );
  for (const r of awaiting) await logEvent({ query }, r.id, "system", null, "awaiting_result", { status: "closed" }, { status: "awaiting_result" });
  // Result notifications not sent yet (or a push to retry).
  await deliverFootballNotifications();
  return { closed: closed.length, awaiting: awaiting.length };
}

/**
 * Storage cleanup, in small batches, never touching anything still in use:
 *  1. images marked for deletion and not referenced -> file removed;
 *  2. images uploaded but never attached to anything (24h) -> marked;
 *  3. match images of contests finished more than FOOTBALL_IMAGE_RETENTION_DAYS
 *     (default 30) ago -> detached and marked (team logos are kept);
 *  4. files on disk with no database row (24h old) -> removed.
 * Predictions, winners, rewards and audit events are never deleted.
 */
export async function runMediaCleanup(batch = 100): Promise<{ processed: number; deleted: number; errors: number }> {
  const run = await queryOne<{ id: string }>(`INSERT INTO cleanup_runs (job) VALUES ('media_cleanup') RETURNING id`);
  let processed = 0, deleted = 0, errors = 0;
  const detail: Record<string, unknown> = {};
  try {
    const retention = Number(process.env.FOOTBALL_IMAGE_RETENTION_DAYS) || 30;
    const expired = await query<{ id: string }>(
      `UPDATE football_contests SET image_id=NULL, updated_at=now()
        WHERE id IN (SELECT id FROM football_contests WHERE image_id IS NOT NULL AND status IN ('completed','no_winner','cancelled')
                       AND COALESCE(completed_at, updated_at) < now() - ($1 || ' days')::interval LIMIT $2)
        RETURNING id`,
      [String(retention), batch]
    );
    detail.detachedAfterRetention = expired.length;
    const unattached = await query<{ id: string }>(
      `UPDATE media_images m SET status='pending_deletion', delete_requested_at=now()
        WHERE m.id IN (SELECT mi.id FROM media_images mi
                        WHERE mi.status='active' AND mi.created_at < now() - interval '24 hours'
                          AND NOT EXISTS (SELECT 1 FROM football_contests fc WHERE fc.image_id=mi.id)
                          AND NOT EXISTS (SELECT 1 FROM football_teams ft WHERE ft.logo_image_id=mi.id)
                        LIMIT $1)
        RETURNING m.id`,
      [batch]
    );
    detail.markedUnused = unattached.length;
    const pending = await query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM media_images WHERE status='pending_deletion' ORDER BY delete_requested_at NULLS FIRST LIMIT $1`,
      [batch]
    );
    for (const m of pending) {
      processed++;
      try {
        if (await imageInUse(m.id)) {
          await query(`UPDATE media_images SET status='active', delete_requested_at=NULL WHERE id=$1`, [m.id]);
          continue;
        }
        await deleteImageFile(m.id, m.storage_key);
        deleted++;
      } catch (e) {
        errors++;
        await query(`UPDATE media_images SET delete_error=$2 WHERE id=$1`, [m.id, String((e as Error).message).slice(0, 300)]);
      }
    }
    // Orphan files: on disk but unknown to the database.
    let orphans = 0;
    const root = mediaDir();
    const months = await fs.readdir(root).catch(() => [] as string[]);
    outer: for (const month of months) {
      const files = await fs.readdir(path.join(root, month)).catch(() => [] as string[]);
      for (const f of files) {
        if (orphans >= batch) break outer;
        const key = `${month}/${f}`;
        const known = await queryOne(`SELECT 1 FROM media_images WHERE storage_key=$1`, [key]);
        if (known) continue;
        const st = await fs.stat(path.join(root, key)).catch(() => null);
        if (!st || Date.now() - st.mtimeMs < 24 * 3600 * 1000) continue;
        try {
          await fs.rm(path.join(root, key), { force: true });
          orphans++;
          deleted++;
        } catch {
          errors++;
        }
      }
    }
    detail.orphanFilesRemoved = orphans;
  } catch (e) {
    errors++;
    detail.error = String((e as Error).message).slice(0, 300);
  } finally {
    await query(`UPDATE cleanup_runs SET finished_at=now(), processed=$2, deleted=$3, errors=$4, detail=$5 WHERE id=$1`, [run!.id, processed, deleted, errors, JSON.stringify(detail)]);
  }
  return { processed, deleted, errors };
}

// Background schedule (one process). In-flight flags stop a slow run from
// overlapping the next tick; FOOTBALL_JOBS=off disables both (tests).
if (process.env.FOOTBALL_JOBS !== "off") {
  let lifecycleBusy = false;
  let cleanupBusy = false;
  setInterval(() => {
    if (lifecycleBusy) return;
    lifecycleBusy = true;
    runFootballLifecycle().catch((e) => console.error("football lifecycle failed:", e)).finally(() => { lifecycleBusy = false; });
  }, 30_000) as unknown as { unref?: () => void };
  setInterval(() => {
    if (cleanupBusy) return;
    cleanupBusy = true;
    runMediaCleanup().catch((e) => console.error("media cleanup failed:", e)).finally(() => { cleanupBusy = false; });
  }, 60 * 60 * 1000) as unknown as { unref?: () => void };
}
