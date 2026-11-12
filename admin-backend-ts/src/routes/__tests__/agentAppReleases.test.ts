// Pure tests (no database): npx tsx --test src/routes/__tests__/agentAppReleases.test.ts
//
// Agent App Release APK: only a release from a successful CI run, with its
// APK uploaded and signature/version verified by the workflow, is offered as
// the latest; the download link is checked; with none valid, a clear message
// instead of a link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAgentAppReleases, releaseOverview, clearAgentAppReleaseCache, verifyDownload } from "../agentAppReleases.routes.js";

const REPO = "waaproltd-spec/Dalab-internet";
const META = (run: number, size: number, extra: Record<string, unknown> = {}) => ({
  packageName: "com.dalab.agent", versionName: "1.2.0", versionCode: 3, apkSha256: "ab".repeat(32),
  apkSizeBytes: size, signatureVerified: true, runNumber: run, commit: "fa510f8", ...extra,
});

function release(run: number, opts: { meta?: boolean; apkState?: string; size?: number; draft?: boolean } = {}) {
  const size = opts.size ?? 3_250_000;
  const assets: any[] = [
    { name: "app-debug.apk", state: "uploaded", size: 19_000_000, browser_download_url: `https://dl/${run}/app-debug.apk` },
    { name: "app-release.apk", state: opts.apkState ?? "uploaded", size, browser_download_url: `https://dl/${run}/app-release.apk` },
  ];
  if (opts.meta !== false) assets.push({ name: "agent-app-release.json", state: "uploaded", size: 300, browser_download_url: `https://dl/${run}/agent-app-release.json` });
  return { tag_name: `agent-app-run-${run}`, name: `Agent App build #${run}`, draft: Boolean(opts.draft), prerelease: false, published_at: "2026-10-15T00:00:00Z", html_url: `https://gh/${run}`, assets };
}

function fakeGitHub(opts: { releases: any[]; successRuns: number[]; metas?: Record<number, any>; head?: (url: string) => Response }) {
  const calls: string[] = [];
  const f = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `https://api.github.com/repos/${REPO}/releases?per_page=50`) return Response.json(opts.releases);
    if (url.startsWith(`https://api.github.com/repos/${REPO}/actions/workflows/agent-app-build-apk.yml/runs`)) {
      return Response.json({ workflow_runs: opts.successRuns.map((n) => ({ run_number: n, conclusion: "success" })) });
    }
    const metaMatch = /^https:\/\/dl\/(\d+)\/agent-app-release\.json$/.exec(url);
    if (metaMatch) {
      const run = Number(metaMatch[1]);
      const meta = opts.metas?.[run] ?? META(run, 3_250_000);
      return Response.json(meta);
    }
    if (init?.method === "HEAD") return opts.head ? opts.head(url) : new Response(null, { status: 200, headers: { "content-length": "3250000" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

test("the latest is the newest release from a successful, verified build", async () => {
  const gh = fakeGitHub({ releases: [release(281, { meta: false }), release(285), release(284)], successRuns: [281, 284, 285] });
  const { releases, message } = await loadAgentAppReleases(gh.f);
  assert.equal(message, null);
  assert.deepEqual(releases.map((r) => r.runNumber), [285, 284, 281]);
  assert.equal(releases[0].verified, true);
  assert.equal(releases[0].versionName, "1.2.0");
  assert.equal(releases[0].versionCode, 3);
  assert.equal(releases[0].downloadUrl, "https://dl/285/app-release.apk");
  // A release from before verification existed is history only.
  assert.equal(releases[2].verified, false);
  assert.match(releases[2].notVerifiedReason!, /before APK verification/);
});

test("a build that failed, a draft, or a release whose APK isn't uploaded is never offered", async () => {
  const gh = fakeGitHub({
    releases: [release(290), release(289, { apkState: "starter" }), release(288, { draft: true }), release(287)],
    successRuns: [287, 289],
  });
  const { releases } = await loadAgentAppReleases(gh.f);
  const byRun = Object.fromEntries(releases.map((r) => [r.runNumber, r]));
  assert.equal(byRun[290].verified, false);
  assert.match(byRun[290].notVerifiedReason!, /didn't finish successfully/);
  assert.equal(byRun[289].verified, false);
  assert.match(byRun[289].notVerifiedReason!, /isn't fully uploaded/);
  assert.equal(byRun[288], undefined, "drafts are not listed");
  assert.equal(byRun[287].verified, true);
});

test("a verification record that doesn't match the uploaded APK is rejected", async () => {
  const gh = fakeGitHub({
    releases: [release(300), release(299), release(298)],
    successRuns: [298, 299, 300],
    metas: { 300: META(300, 1234), 299: META(297, 3_250_000), 298: META(298, 3_250_000, { signatureVerified: false }) },
  });
  const { releases, message } = await loadAgentAppReleases(gh.f);
  assert.equal(releases.every((r) => !r.verified), true);
  assert.match(releases[0].notVerifiedReason!, /doesn't match/);
  assert.match(releases[1].notVerifiedReason!, /different build/);
  assert.match(releases[2].notVerifiedReason!, /signature/);
  assert.match(message!, /No verified Agent App release/);
});

test("no valid release: a clear message and no download link", async () => {
  clearAgentAppReleaseCache();
  const gh = fakeGitHub({ releases: [release(281, { meta: false })], successRuns: [281] });
  const overview = await releaseOverview({ force: true, fetchImpl: gh.f });
  assert.equal(overview.latest, null);
  assert.match(overview.message!, /No verified Agent App release/);
});

test("the download link is checked: served at the verified size, or flagged", async () => {
  clearAgentAppReleaseCache();
  const good = fakeGitHub({ releases: [release(285)], successRuns: [285] });
  const ok = await releaseOverview({ force: true, fetchImpl: good.f });
  assert.equal(ok.latest?.downloadVerified, true);
  assert.ok(good.calls.includes("HEAD https://dl/285/app-release.apk"));

  const broken = fakeGitHub({ releases: [release(285)], successRuns: [285], head: () => new Response(null, { status: 404 }) });
  const bad = await releaseOverview({ force: true, fetchImpl: broken.f });
  assert.equal(bad.latest?.downloadVerified, false);
  assert.match(bad.latest!.downloadError!, /404/);

  const wrongSize = await verifyDownload(ok.latest!, (async () => new Response(null, { status: 200, headers: { "content-length": "999" } })) as typeof fetch);
  assert.equal(wrongSize.ok, false);
});

test("Check for New Release bypasses the cache and finds a newer build", async () => {
  clearAgentAppReleaseCache();
  const first = fakeGitHub({ releases: [release(285)], successRuns: [285] });
  assert.equal((await releaseOverview({ fetchImpl: first.f })).latest?.runNumber, 285);
  const newer = fakeGitHub({ releases: [release(286), release(285)], successRuns: [285, 286] });
  // Cached view is unchanged until a check...
  assert.equal((await releaseOverview({ fetchImpl: newer.f })).latest?.runNumber, 285);
  // ...which sees the new build.
  assert.equal((await releaseOverview({ force: true, fetchImpl: newer.f })).latest?.runNumber, 286);
});
