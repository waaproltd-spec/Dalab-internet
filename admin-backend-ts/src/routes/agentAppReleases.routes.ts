import { Router } from "express";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";

/**
 * Agent App Release APK (Admin Dashboard): the newest Agent App APK that
 * is actually safe to install, read live from this project's own GitHub
 * Releases -- never a hand-typed link or version.
 *
 * A release is offered only when ALL of these hold:
 *  - it was published by the "Build Agent App APK" workflow
 *    (tag agent-app-run-<run number>), which publishes only after the unit
 *    tests and both builds pass;
 *  - that workflow run's conclusion is "success" (GitHub Actions API);
 *  - its app-release.apk asset is fully uploaded;
 *  - it carries agent-app-release.json, written by the workflow's
 *    "Verify release APK" step after apksigner verified the signature and
 *    aapt2 read the package/version from the APK itself -- and that file's
 *    run number and APK size match the release.
 * "Check for New Release" additionally fetches the download link and
 * confirms it serves the APK at the recorded size. Releases from before the
 * verification step existed are listed as history but never offered as the
 * latest.
 */
export const agentAppReleasesRouter = Router();

const REPO = () => process.env.AGENT_APP_RELEASES_REPO || "waaproltd-spec/Dalab-internet";
const WORKFLOW = "agent-app-build-apk.yml";
const TAG_RE = /^agent-app-run-(\d+)$/;
const CACHE_MS = 5 * 60 * 1000;

type Fetch = typeof fetch;

export type AgentAppRelease = {
  tag: string;
  runNumber: number;
  title: string;
  publishedAt: string | null;
  sizeBytes: number;
  downloadUrl: string;
  releaseUrl: string;
  versionName: string | null;
  versionCode: number | null;
  commit: string | null;
  apkSha256: string | null;
  verified: boolean;
  notVerifiedReason: string | null;
};

export type ReleaseOverview = {
  latest: (AgentAppRelease & { downloadVerified: boolean | null; downloadCheckedAt: string | null; downloadError: string | null }) | null;
  releases: AgentAppRelease[];
  message: string | null;
  checkedAt: string;
};

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "dalab-admin-backend" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function getJson(fetchImpl: Fetch, url: string): Promise<any> {
  const res = await fetchImpl(url, { headers: githubHeaders(), redirect: "follow" });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url}`);
  return res.json();
}

/** Lists Agent App releases (newest first) and works out which are safe to offer. */
export async function loadAgentAppReleases(fetchImpl: Fetch = fetch): Promise<{ releases: AgentAppRelease[]; message: string | null }> {
  const repo = REPO();
  const raw = (await getJson(fetchImpl, `https://api.github.com/repos/${repo}/releases?per_page=50`)) as any[];
  let successfulRuns: Set<number> | null = null;
  let runsError: string | null = null;
  try {
    const runs = await getJson(fetchImpl, `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs?status=success&per_page=100`);
    successfulRuns = new Set((runs.workflow_runs ?? []).map((r: any) => Number(r.run_number)));
  } catch (e) {
    runsError = (e as Error).message;
  }

  const candidates = raw
    .map((r) => ({ r, m: TAG_RE.exec(String(r.tag_name ?? "")) }))
    .filter(({ r, m }) => m && !r.draft && !r.prerelease)
    .map(({ r, m }) => ({ r, runNumber: Number(m![1]) }))
    .sort((a, b) => b.runNumber - a.runNumber)
    .slice(0, 10);

  const releases: AgentAppRelease[] = [];
  for (const { r, runNumber } of candidates) {
    const assets: any[] = r.assets ?? [];
    const apk = assets.find((a) => a.name === "app-release.apk");
    const metaAsset = assets.find((a) => a.name === "agent-app-release.json");
    let reason: string | null = null;
    let meta: any = null;
    if (!apk || apk.state !== "uploaded" || !(Number(apk.size) > 0)) reason = "The release APK isn't fully uploaded.";
    else if (!successfulRuns) reason = `Couldn't confirm the build succeeded (${runsError}).`;
    else if (!successfulRuns.has(runNumber)) reason = "Its CI build didn't finish successfully.";
    else if (!metaAsset) reason = "Built before APK verification was added — no verified version or signature on record.";
    if (!reason) {
      try {
        meta = await getJson(fetchImpl, metaAsset.browser_download_url);
        if (meta?.signatureVerified !== true) reason = "Its APK signature wasn't verified.";
        else if (Number(meta.runNumber) !== runNumber) reason = "Its verification record belongs to a different build.";
        else if (Number(meta.apkSizeBytes) !== Number(apk.size)) reason = "The uploaded APK doesn't match the verified one.";
        else if (!meta.versionName || !Number.isFinite(Number(meta.versionCode))) reason = "Its version couldn't be read from the APK.";
      } catch (e) {
        reason = `Couldn't read its verification record (${(e as Error).message}).`;
      }
    }
    releases.push({
      tag: r.tag_name,
      runNumber,
      title: r.name ?? r.tag_name,
      publishedAt: r.published_at ?? null,
      sizeBytes: Number(apk?.size ?? 0),
      downloadUrl: apk?.browser_download_url ?? "",
      releaseUrl: r.html_url ?? "",
      versionName: reason ? null : String(meta.versionName),
      versionCode: reason ? null : Number(meta.versionCode),
      commit: reason ? null : (meta.commit ?? null),
      apkSha256: reason ? null : (meta.apkSha256 ?? null),
      verified: !reason,
      notVerifiedReason: reason,
    });
  }
  const message = releases.some((r) => r.verified)
    ? null
    : "No verified Agent App release is available yet. The next successful \"Build Agent App APK\" run publishes one.";
  return { releases, message };
}

/** Confirms the download link serves the APK at its recorded size. */
export async function verifyDownload(release: AgentAppRelease, fetchImpl: Fetch = fetch): Promise<{ ok: boolean; error: string | null }> {
  try {
    const res = await fetchImpl(release.downloadUrl, { method: "HEAD", redirect: "follow", headers: { "User-Agent": "dalab-admin-backend" } });
    if (!res.ok) return { ok: false, error: `The download link answered ${res.status}.` };
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > 0 && length !== release.sizeBytes) {
      return { ok: false, error: `The download is ${length} bytes, expected ${release.sizeBytes}.` };
    }
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: `The download link couldn't be reached (${(e as Error).message}).` };
  }
}

let cache: { at: number; overview: ReleaseOverview } | null = null;

export async function releaseOverview(opts: { force?: boolean; fetchImpl?: Fetch } = {}): Promise<ReleaseOverview> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) return cache.overview;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { releases, message } = await loadAgentAppReleases(fetchImpl);
  const newest = releases.find((r) => r.verified) ?? null;
  let latest: ReleaseOverview["latest"] = null;
  if (newest) {
    // Re-check the link on a forced check, or when the newest release changed.
    const previous = cache?.overview.latest;
    if (!opts.force && previous && previous.tag === newest.tag && previous.downloadVerified !== null) {
      latest = { ...newest, downloadVerified: previous.downloadVerified, downloadCheckedAt: previous.downloadCheckedAt, downloadError: previous.downloadError };
    } else {
      const check = await verifyDownload(newest, fetchImpl);
      latest = { ...newest, downloadVerified: check.ok, downloadCheckedAt: new Date().toISOString(), downloadError: check.error };
    }
  }
  const overview: ReleaseOverview = { latest, releases, message, checkedAt: new Date().toISOString() };
  cache = { at: Date.now(), overview };
  return overview;
}

export function clearAgentAppReleaseCache() {
  cache = null;
}

agentAppReleasesRouter.get("/admin/agent-app/releases", requirePermission("devices.manage"), async (_req, res) => {
  try {
    sendJson(res, 200, await releaseOverview());
  } catch (e) {
    sendJson(res, 502, { error: `Couldn't reach GitHub Releases: ${(e as Error).message}` });
  }
});

// "Check for New Release": bypasses the cache and re-verifies the download.
agentAppReleasesRouter.post("/admin/agent-app/releases/check", requirePermission("devices.manage"), async (_req, res) => {
  try {
    sendJson(res, 200, await releaseOverview({ force: true }));
  } catch (e) {
    sendJson(res, 502, { error: `Couldn't reach GitHub Releases: ${(e as Error).message}` });
  }
});
