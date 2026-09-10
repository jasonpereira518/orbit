/**
 * Query-shape budgets for the authenticated hot paths: dashboard, constellation graph,
 * and the notifications panel.
 *
 * Every one of these was timing out at the 60-second function ceiling for heavy accounts,
 * and none of them was slow because of statement COUNT — each is one lateral-joined scan.
 * They were slow because of ROW WIDTH: the scans pulled `notes` (multi-KB) and
 * `profile_image_url` (base64 up to 120 KB) for every contact, over a driver that streams
 * each statement as an HTTPS response, only to strip both server-side before rendering.
 * That property is invisible in behavior — the page renders identically either way — so
 * it is asserted here on the SQL the functions actually issue, against a 3,000-contact
 * network with a realistic share of inline avatars.
 *
 * Also covers the avatar backfill, which is mounted on every page and used to load the
 * base64 for every contact just to decide which ones still needed a photo, then resolved
 * them sequentially with 15–20s network timeouts — the most likely producer of the
 * exactly-60s kills.
 *
 * Runs against the local PGlite database. Run: npx tsx scripts/smoke-page-budgets.ts
 */
import "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { getDashboardData } from "../src/lib/reminders";
import { loadGraphData } from "../src/lib/graph-data";
import { loadNotificationPanel } from "../src/lib/notification-panel";
import {
  findAvatarBackfillCandidates,
  runAvatarBackfillBatch,
} from "../src/lib/avatar-backfill";
import { traced } from "../src/lib/perf-trace";
import { capturedQueries, startQueryCount, stopQueryCount } from "../src/lib/query-counter";
import { scaleContactRows } from "./lib/scale-fixture";

const USER = "smoke-page-budgets-user";
const N = 3000;
/** Row index whose follow-up is due — deliberately past any "first 300 rows" cut. */
const DUE_ROW = 2900;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** The contacts scan(s) among the captured statements. */
function contactScans(statements: string[]) {
  return statements.filter((s) => /from\s+"contacts"/i.test(s) && /^\s*select/i.test(s));
}

/** True when the column is selected as a bare value (not merely referenced inside an expression). */
function selectsBare(statement: string, column: string) {
  return new RegExp(`"${column}"\\s*(,|\\bfrom\\b)`, "i").test(statement);
}

async function reset() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
}

async function seed() {
  const db = await getDb();
  const rows = scaleContactRows(USER, N, {
    inlineAvatarShare: 0.3,
    longNotesShare: 0.5,
    dueFollowUpRows: [DUE_ROW],
  });
  for (let start = 0; start < rows.length; start += 250) {
    await db.insert(contacts).values(rows.slice(start, start + 250));
  }
  // A handful of hand-shaped avatar states for the backfill candidate query.
  const special = [
    { key: "remote", profileImageUrl: "https://media.licdn.com/dms/image/abc/photo.jpg", linkedinUrl: null },
    { key: "blob", profileImageUrl: "https://xyz.public.blob.vercel-storage.com/avatars/a.jpg", linkedinUrl: "https://www.linkedin.com/in/blob-person/" },
    { key: "inline", profileImageUrl: `data:image/jpeg;base64,${"A".repeat(400)}`, linkedinUrl: "https://www.linkedin.com/in/inline-person/" },
    { key: "unavatar", profileImageUrl: "https://unavatar.io/linkedin/someone", linkedinUrl: "https://www.linkedin.com/in/unavatar-person/" },
    { key: "nothing", profileImageUrl: null, linkedinUrl: null },
  ];
  const ids: Record<string, string> = {};
  for (const s of special) {
    // Plain `.returning()`: getDb() is a union of the neon and pglite drivers, and the
    // partial-shape overload does not resolve across both.
    const [row] = await db
      .insert(contacts)
      .values({ userId: USER, fullName: `Special ${s.key}`, profileImageUrl: s.profileImageUrl, linkedinUrl: s.linkedinUrl })
      .returning();
    ids[s.key] = row.id;
  }
  await db.execute(sql`ANALYZE contacts`);
  return ids;
}

async function main() {
  await reset();
  console.log(`Seeding ${N} contacts for ${USER}…`);
  const specialIds = await seed();
  const db = await getDb();
  const dueId = (
    await db.query.contacts.findFirst({
      where: eq(contacts.fullName, scaleContactRows(USER, DUE_ROW + 1)[DUE_ROW].fullName),
      columns: { id: true },
    })
  )?.id;
  check("fixture: the due-row contact exists", Boolean(dueId));

  // ---- Dashboard ---------------------------------------------------------------------
  console.log("\nDashboard (getDashboardData)…");
  // The first visit after a bulk insert materializes the closeness cohort (a handful of
  // batched UPDATEs plus a snapshot insert). That is a one-off; the budget is the steady
  // state every later visit pays.
  await getDashboardData(USER);
  startQueryCount();
  const dashboard = await getDashboardData(USER);
  const dashboardCount = stopQueryCount();
  const dashboardScans = contactScans(capturedQueries());
  console.log(`  statements: ${dashboardCount}`);
  if (process.env.DEBUG_QUERIES) for (const q of capturedQueries()) console.log("    ·", q.replace(/\s+/g, " ").slice(0, 110));
  // 13 for the same one reason as the graph's 9 — see the note there.
  check("dashboard issues ≤ 13 statements", dashboardCount <= 13, `got ${dashboardCount}`);
  check("dashboard scans contacts at least once", dashboardScans.length >= 1);
  check(
    "dashboard contacts scan does not pull notes",
    dashboardScans.every((s) => !selectsBare(s, "notes")),
    dashboardScans.find((s) => selectsBare(s, "notes"))?.slice(0, 200)
  );
  check(
    "dashboard contacts scan does not pull profile_image_url as a bare column",
    dashboardScans.every((s) => !selectsBare(s, "profile_image_url")),
    dashboardScans.find((s) => selectsBare(s, "profile_image_url"))?.slice(0, 200)
  );
  const dashboardJson = JSON.stringify(dashboard);
  check("dashboard payload carries no inline base64", !dashboardJson.includes("data:image/"));
  check(
    "dashboard payload under 1.5 MB",
    dashboardJson.length < 1_500_000,
    `${(dashboardJson.length / 1024).toFixed(0)} KB`
  );
  check(
    "dashboard still resolves an inline avatar to the avatar route",
    dashboardJson.includes("/api/avatars/")
  );
  check(
    "dashboard still lists the due follow-up at row 2900",
    Boolean(dueId) && dashboard.dueFollowUps.some((c) => c.id === dueId)
  );

  // ---- Graph -------------------------------------------------------------------------
  console.log("\nConstellation (loadGraphData)…");
  startQueryCount();
  const graph = await loadGraphData(USER, { profile: Promise.resolve(null) });
  const graphCount = stopQueryCount();
  const graphScans = contactScans(capturedQueries());
  console.log(`  statements: ${graphCount}`);
  // 9, not 8: the constellation filter reads its singleton `constellation_settings` row.
  // That is the ONLY statement the feature adds — its per-contact eligibility tallies ride
  // on the `group by contact_id` the closeness cohort already issues, so they cost nothing.
  // If this number moves again, something started scanning `interactions` a second time.
  check("graph issues ≤ 9 statements", graphCount <= 9, `got ${graphCount}`);
  check("graph contacts scan does not pull notes", graphScans.every((s) => !selectsBare(s, "notes")));
  check(
    "graph contacts scan does not pull profile_image_url as a bare column",
    graphScans.every((s) => !selectsBare(s, "profile_image_url")),
    graphScans.find((s) => selectsBare(s, "profile_image_url"))?.slice(0, 200)
  );
  const graphJson = JSON.stringify(graph);
  check("graph payload carries no inline base64", !graphJson.includes("data:image/"));
  // The constellation ships every contact to the client by design (~700 bytes each once
  // notes and avatars are out), so this is a base64-regression tripwire, not a target.
  check("graph payload under 3 MB", graphJson.length < 3_000_000, `${(graphJson.length / 1024).toFixed(0)} KB`);
  // Unfiltered on purpose, and now load-bearing: the constellation filter hides stars but
  // must never change what Orbit says the network *is*. This is the guard on that.
  check("graph reports every contact", graph.summary.total === N + 5, `got ${graph.summary.total}`);
  // The whole point of filtering server-side: the default view must not carry the people it
  // is not drawing. At ~741 bytes a contact, shipping them anyway is megabytes per visit.
  check(
    "graph ships only the contacts it draws",
    graph.contacts.length === graph.summary.constellationFilter.shown &&
      graph.contacts.length < graph.summary.total,
    `${graph.contacts.length} shipped of ${graph.summary.total}`
  );
  check(
    "and reports the full network as available behind the 'show all' control",
    graph.summary.constellationFilter.available === graph.summary.total
  );

  console.log("\nConstellation, show-all scope (loadGraphData scope:all)…");
  startQueryCount();
  const graphAll = await loadGraphData(USER, {
    profile: Promise.resolve(null),
    scope: "all",
  });
  const graphAllCount = stopQueryCount();
  console.log(`  statements: ${graphAllCount}`);
  check("show-all issues ≤ 9 statements", graphAllCount <= 9, `got ${graphAllCount}`);
  check(
    "show-all carries the whole network",
    graphAll.contacts.length === N + 5,
    `${graphAll.contacts.length}`
  );
  const engagedBytes = JSON.stringify(graph.contacts).length;
  const allBytes = JSON.stringify(graphAll.contacts).length;
  check(
    "and the default view is materially lighter than it",
    engagedBytes < allBytes,
    `engaged ${(engagedBytes / 1024).toFixed(0)} KB vs all ${(allBytes / 1024).toFixed(0)} KB`
  );
  console.log(
    `  engaged ${(engagedBytes / 1024).toFixed(0)} KB · all ${(allBytes / 1024).toFixed(0)} KB` +
      ` (${((1 - engagedBytes / allBytes) * 100).toFixed(0)}% smaller)`
  );
  check("graph still resolves an inline avatar to the avatar route", graphJson.includes("/api/avatars/"));

  // ---- Notifications panel -----------------------------------------------------------
  console.log("\nNotifications panel (loadNotificationPanel)…");
  startQueryCount();
  // withAlerts: false — this budget targets the bounded-query design this phase adds.
  // Account alerts are a separate feature with their own statement budget, covered by
  // smoke-account-alerts.ts.
  const panel = await loadNotificationPanel(USER, new Date(), { withAlerts: false });
  const panelCount = stopQueryCount();
  const panelScans = contactScans(capturedQueries());
  console.log(`  statements: ${panelCount}`);
  check("panel issues ≤ 8 statements", panelCount <= 8, `got ${panelCount}`);
  check(
    "panel contacts scan filters on next_follow_up_at",
    panelScans.some((s) => /where[\s\S]*"next_follow_up_at"/i.test(s)),
    panelScans[0]?.slice(0, 300)
  );
  check(
    "panel contacts scan orders by next_follow_up_at",
    panelScans.some((s) => /order by[\s\S]*"next_follow_up_at"/i.test(s))
  );
  check(
    "panel surfaces the due follow-up at row 2900",
    Boolean(dueId) && panel.items.some((i) => i.kind === "follow_up" && i.contactId === dueId)
  );

  // ---- Avatar backfill candidates ----------------------------------------------------
  console.log("\nAvatar backfill (findAvatarBackfillCandidates)…");
  startQueryCount();
  const candidates = await findAvatarBackfillCandidates(db, USER, { limit: 25, skipIds: [] });
  const candidateCount = stopQueryCount();
  check("candidate lookup is one statement", candidateCount === 1, `got ${candidateCount}`);
  const candidateScans = contactScans(capturedQueries());
  check(
    "candidate lookup does not pull profile_image_url as a bare column",
    candidateScans.every((s) => !selectsBare(s, "profile_image_url")),
    candidateScans[0]?.slice(0, 200)
  );
  check(
    "candidate lookup is bounded in SQL, not in JS",
    candidateScans.some((s) => /\blimit\b/i.test(s)),
    candidateScans[0]?.slice(0, 200)
  );
  check("candidate lookup is bounded by limit", candidates.length <= 25, `got ${candidates.length}`);
  check(
    "no candidate carries inline base64",
    candidates.every((c) => !(c.remoteUrl ?? "").startsWith("data:")),
  );
  check(
    "the remote (non-durable) photo is a candidate, and comes first",
    candidates[0]?.id === specialIds.remote,
    candidates[0]?.id
  );
  const ids = new Set(candidates.map((c) => c.id));
  check("a Blob-hosted photo is not a candidate", !ids.has(specialIds.blob));
  check("an inline photo is not a candidate", !ids.has(specialIds.inline));
  check("a contact with no photo and no LinkedIn is not a candidate", !ids.has(specialIds.nothing));
  const skipped = await findAvatarBackfillCandidates(db, USER, { limit: 25, skipIds: [specialIds.remote] });
  check("skipIds removes a candidate", !skipped.some((c) => c.id === specialIds.remote));

  // ---- Avatar backfill wall-clock budget ---------------------------------------------
  console.log("\nAvatar backfill (runAvatarBackfillBatch budget)…");
  let resolved = 0;
  const slow = async () => {
    await new Promise((r) => setTimeout(r, 30));
    resolved += 1;
    return null;
  };
  const fake = Array.from({ length: 10 }, (_, i) => ({
    id: `fake-${i}`,
    linkedinUrl: `https://www.linkedin.com/in/fake-${i}/`,
    remoteUrl: null,
  }));
  const result = await runAvatarBackfillBatch(fake, {
    deadline: Date.now() + 50,
    resolveLinkedIn: slow,
    persistRemote: slow,
    save: async () => {},
  });
  check("batch stops at the deadline", resolved < 10, `resolved ${resolved}`);
  check(
    "unprocessed candidates are reported as pending",
    result.pending === 10 - resolved,
    `pending ${result.pending}, resolved ${resolved}`
  );

  // ---- perf trace ------------------------------------------------------------------
  console.log("\nperf trace (traced)…");
  const recorded: { kind: string; ms: number }[] = [];
  let t = 0;
  const clock = () => t;
  const value = await traced(
    "slow.thing",
    async () => {
      t += 12_000;
      return 42;
    },
    { thresholdMs: 10_000, now: clock, record: async (e) => void recorded.push(e) }
  );
  check("traced returns the wrapped value", value === 42);
  check("a call over the threshold is recorded once", recorded.length === 1 && recorded[0].kind === "slow.thing");
  await traced("fast.thing", async () => 1, { thresholdMs: 10_000, now: clock, record: async (e) => void recorded.push(e) });
  check("a call under the threshold is not recorded", recorded.length === 1);

  await reset();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll page-budget checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
