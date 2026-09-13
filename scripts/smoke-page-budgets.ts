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
 * What none of that measured is ROW COUNT, and that turned out to be the omission that
 * mattered. `getDashboardData` runs `findMany({ where: userId })` with no limit and then
 * filters, sorts and aggregates the result in JavaScript; `loadGraphData` does the same.
 * Statement count is bounded, row count is not — so the budget built to catch dashboard
 * regressions was structurally blind to the one actually happening, and the `maxDuration`
 * on `(app)/(main)/layout.tsx` was raised to 300 s to convert the resulting timeouts into
 * slow successes. The "Payload scaling" section at the end of this file measures the same
 * loaders at two account sizes so that growth is a number rather than an assumption.
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
import { loadSuggestionSignals } from "../src/lib/chat-suggestions-data";
import {
  AVATAR_RECHECK_DAYS,
  findAvatarBackfillCandidates,
  runAvatarBackfillBatch,
} from "../src/lib/avatar-backfill";
import { contactsListSelection } from "../src/lib/contact-avatar-sql";
import { traced } from "../src/lib/perf-trace";
import { capturedQueries, startQueryCount, stopQueryCount } from "../src/lib/query-counter";
import { scaleContactRows } from "./lib/scale-fixture";

const USER = "smoke-page-budgets-user";
const N = 3000;
/** The comparison account for the scaling section: a quarter of the size, same shape. */
const SCALE_USER = "smoke-page-budgets-scale-user";
const SCALE_N = 750;
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

type SpecialRow = {
  key: string;
  profileImageUrl: string | null;
  linkedinUrl: string | null;
  email: string | null;
  profileImageCheckedAt?: Date | null;
};

/** Hand-shaped avatar fixtures seeded on top of the N scaled rows. Keep in step with `special`. */
const SPECIAL_ROWS = 8;
const DAY_MS = 86_400_000;

async function reset() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
}

/** A second, smaller account. Its only job is to give the scaling section a comparison. */
async function seedScaleUser() {
  const db = await getDb();
  await resetScaleUser();
  const rows = scaleContactRows(SCALE_USER, SCALE_N, {
    inlineAvatarShare: 0.3,
    longNotesShare: 0.5,
    dueFollowUpRows: [Math.floor(SCALE_N * 0.9)],
  });
  for (let start = 0; start < rows.length; start += 250) {
    await db.insert(contacts).values(rows.slice(start, start + 250));
  }
  // The same number of hand-shaped rows the main fixture adds, so the two accounts differ
  // only in size. Keyed off SPECIAL_ROWS rather than a literal: this drifted once already
  // when the main fixture grew from five to eight.
  for (let i = 0; i < SPECIAL_ROWS; i++) {
    await db.insert(contacts).values({ userId: SCALE_USER, fullName: `Special ${i}` });
  }
  await db.execute(sql`ANALYZE contacts`);
}

async function resetScaleUser() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, SCALE_USER));
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
  const special: SpecialRow[] = [
    { key: "remote", profileImageUrl: "https://media.licdn.com/dms/image/abc/photo.jpg", linkedinUrl: null, email: null },
    { key: "blob", profileImageUrl: "https://xyz.public.blob.vercel-storage.com/avatars/a.jpg", linkedinUrl: "https://www.linkedin.com/in/blob-person/", email: null },
    { key: "inline", profileImageUrl: `data:image/jpeg;base64,${"A".repeat(400)}`, linkedinUrl: "https://www.linkedin.com/in/inline-person/", email: null },
    { key: "unavatar", profileImageUrl: "https://unavatar.io/linkedin/someone", linkedinUrl: "https://www.linkedin.com/in/unavatar-person/", email: null },
    // No LinkedIn, but an email — Gravatar can still resolve this one.
    { key: "emailOnly", profileImageUrl: null, linkedinUrl: null, email: "gravatar-person@example.com" },
    { key: "nothing", profileImageUrl: null, linkedinUrl: null, email: null },
    // Tried recently and found nothing: inside the cooldown, so not worth re-asking.
    {
      key: "checkedRecently",
      profileImageUrl: null,
      linkedinUrl: "https://www.linkedin.com/in/checked-person/",
      email: null,
      profileImageCheckedAt: new Date(Date.now() - 2 * DAY_MS),
    },
    // Tried long ago: the cooldown has expired, so it is due another look.
    {
      key: "checkedLongAgo",
      profileImageUrl: null,
      linkedinUrl: "https://www.linkedin.com/in/stale-person/",
      email: null,
      profileImageCheckedAt: new Date(Date.now() - (AVATAR_RECHECK_DAYS + 5) * DAY_MS),
    },
  ];
  const ids: Record<string, string> = {};
  for (const s of special) {
    // Plain `.returning()`: getDb() is a union of the neon and pglite drivers, and the
    // partial-shape overload does not resolve across both.
    const [row] = await db
      .insert(contacts)
      .values({ userId: USER, fullName: `Special ${s.key}`, profileImageUrl: s.profileImageUrl, linkedinUrl: s.linkedinUrl, email: s.email, profileImageCheckedAt: s.profileImageCheckedAt ?? null })
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
  // 16, up from 13, and deliberately: the extra statements are what make the ROW count
  // bounded. Four aggregates and a by-id hydration replaced "read the whole account and work
  // it out in JavaScript". On neon-http a statement is an HTTPS round trip, so this trades a
  // handful of FIXED round trips for a payload that no longer grows with the account —
  // 3,005 rows down to 766 at 3,000 contacts, and 983 bytes a contact down to 141.
  //
  // Statement count is a cost to watch, not a number to minimise. If it creeps past this,
  // the question to ask is whether something started scanning again, not whether two
  // aggregates can be folded together.
  check("dashboard issues ≤ 16 statements", dashboardCount <= 16, `got ${dashboardCount}`);
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
  check("graph reports every contact", graph.summary.total === N + SPECIAL_ROWS, `got ${graph.summary.total}`);
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
    graphAll.contacts.length === N + SPECIAL_ROWS,
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

  // ---- Contacts list projection ------------------------------------------------------
  // The hottest contacts scan in the app, and the one that was NOT guarded here — it
  // selected profile_image_url whole (up to 120 KB of base64 per row) and then threw the
  // bytes away in JS. `listContactsPage` calls requireUserId(), so run its exported
  // projection directly.
  console.log("\nContacts list (contactsListSelection)…");
  startQueryCount();
  const listRows = await db
    .select(contactsListSelection)
    .from(contacts)
    .where(eq(contacts.userId, USER))
    .limit(50);
  stopQueryCount();
  const listScans = contactScans(capturedQueries());
  check("contacts list scans contacts", listScans.length >= 1);
  check(
    "contacts list does not pull profile_image_url as a bare column",
    listScans.every((s) => !selectsBare(s, "profile_image_url")),
    listScans.find((s) => selectsBare(s, "profile_image_url"))?.slice(0, 200)
  );
  check(
    "contacts list does not pull notes",
    listScans.every((s) => !selectsBare(s, "notes"))
  );
  const listJson = JSON.stringify(listRows);
  check("contacts list payload carries no inline base64", !listJson.includes("data:image/"));
  check(
    "contacts list still resolves an inline avatar to the avatar route",
    listJson.includes("/api/avatars/")
  );

  // ---- Composer suggestion signals ---------------------------------------------------
  // The row renders on every visit to an empty /chat and on every open of the floating ask
  // bar, so its cost is paid far more often than a page load. Nine in the steady state, up
  // from six when the taxonomy added commitments, notes mentions, goals and the cold-start
  // company aggregate. Every one is a bounded index read over the user's own slice, and the
  // row is fetched at most once per page load — but this is the largest cost in the feature
  // and the number is meant to be argued rather than absorbed. If it has to come down, the
  // company aggregate is the one to drop, at the cost of the best cold-start question.
  console.log("\nComposer suggestions (loadSuggestionSignals)…");
  startQueryCount();
  await loadSuggestionSignals(USER);
  const suggestionCount = stopQueryCount();
  const suggestionScans = contactScans(capturedQueries());
  console.log(`  statements: ${suggestionCount}`);
  check("suggestions issue ≤ 12 statements", suggestionCount <= 12, `got ${suggestionCount}`);
  check(
    "suggestions do not pull notes as a bare column — the emptiness test belongs in the predicate",
    suggestionScans.every((s) => !selectsBare(s, "notes")),
    suggestionScans.find((s) => selectsBare(s, "notes"))?.slice(0, 300)
  );
  check(
    "suggestions do not pull profile_image_url",
    suggestionScans.every((s) => !selectsBare(s, "profile_image_url")),
    suggestionScans.find((s) => selectsBare(s, "profile_image_url"))?.slice(0, 200)
  );
  check(
    "every suggestion scan is bounded in SQL",
    suggestionScans.every((s) => /\blimit\b/i.test(s)),
    suggestionScans.find((s) => !/\blimit\b/i.test(s))?.slice(0, 300)
  );
  // The point of the budget: cost must not track network SIZE. That is not the same as
  // "identical regardless of data" — several lookups are conditional on there being
  // something to look up (mentions only when the user uses `@`, contact briefs only when
  // somebody is actually overdue), and skipping those on an empty account is correct.
  // What must never happen is the count going UP with the size of the network, which is
  // what a scan creeping in — the closeness cohort back inside `getAttentionBrief`, say —
  // would look like. The bounded-in-SQL assertion above is the other half of that guard.
  startQueryCount();
  await loadSuggestionSignals(`${USER}-empty`);
  const emptyCount = stopQueryCount();
  check(
    "3,000 contacts cost no more statements than an empty account plus its conditional lookups",
    suggestionCount <= emptyCount + 2,
    `empty ${emptyCount} vs populated ${suggestionCount}`
  );
  check(
    "and an empty account is never the more expensive one",
    emptyCount <= suggestionCount,
    `empty ${emptyCount} vs populated ${suggestionCount}`
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
  check(
    "a contact with no photo, no LinkedIn and no email is not a candidate",
    !ids.has(specialIds.nothing)
  );
  // Gravatar tier: an email alone is enough to be worth a (free) lookup. Checked over the
  // whole backlog rather than the first 25 — the scaled fixtures have emails too, so this
  // contact sorts well past any small limit.
  const allCandidates = await findAvatarBackfillCandidates(db, USER, {
    limit: N + SPECIAL_ROWS,
    skipIds: [],
  });
  const allIds = new Set(allCandidates.map((c) => c.id));
  check(
    "a contact with only an email is a candidate (Gravatar tier)",
    allIds.has(specialIds.emailOnly)
  );
  check(
    "a contact with no photo, no LinkedIn and no email is still not a candidate",
    !allIds.has(specialIds.nothing)
  );
  // The cooldown is what stops every page load re-paying for the permanent misses.
  check(
    "a contact checked inside the cooldown is NOT a candidate",
    !allIds.has(specialIds.checkedRecently)
  );
  check(
    "a contact checked before the cooldown expired IS a candidate again",
    allIds.has(specialIds.checkedLongAgo)
  );
  check(
    "candidates carry the email needed for the Gravatar lookup",
    allCandidates.find((c) => c.id === specialIds.emailOnly)?.email ===
      "gravatar-person@example.com"
  );
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
    email: null,
    remoteUrl: null,
  }));
  const result = await runAvatarBackfillBatch(fake, {
    deadline: Date.now() + 50,
    resolveLinkedIn: slow,
    resolveGravatar: slow,
    persistRemote: slow,
    save: async () => {},
    markChecked: async () => {},
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

  // ---- Payload scaling ---------------------------------------------------------------
  //
  // Everything above runs at ONE account size, so it can prove a payload is narrow but not
  // that it is BOUNDED. This runs the same loaders at a quarter of the size and compares.
  // A bounded surface returns at most its SQL limit either way; an unbounded one returns
  // the account.
  console.log("\nPayload scaling (the same loaders at two account sizes)…");
  await seedScaleUser();

  const smallDashboard = await getDashboardData(SCALE_USER);
  const smallGraph = await loadGraphData(SCALE_USER, { profile: Promise.resolve(null), scope: "all" });
  const smallPanel = await loadNotificationPanel(SCALE_USER, new Date(), { withAlerts: false });

  type Surface = {
    name: string;
    small: number;
    large: number;
    /**
     * The most rows this surface may ever return, or null when it has no bound at all.
     * A number here must be traceable to a LIMIT in SQL — not to what today's fixture
     * happens to produce.
     */
    bound: number | null;
    /**
     * Whether the bound is low enough that a 4× account is expected to return roughly the
     * same number of rows. True for the dashboard, whose ceiling sits below the fixture's
     * smaller size. The panel is bounded at 235 and simply has not saturated at 750
     * contacts yet — 34 → 100 is correct behaviour for it, not drift.
     */
    flat?: boolean;
  };

  const surfaces: Surface[] = [
    // Bounded by what the page can render plus the link analysis's own cap:
    // METRICS_MAX_CONTACTS (750) + the preview (150) + the two card lists + the contacts the
    // reminder and suggestion rows name. Overlapping sets, so the real figure sits just above
    // 750 rather than at the sum.
    { name: "dashboard", small: smallDashboard.contactById.size, large: dashboard.contactById.size, bound: 1000, flat: true },
    // Unbounded BY DESIGN — "show all" means all. The default (engaged-only) view above is
    // the bounded one users actually get, and the assertions there cover it.
    { name: "graph (show all)", small: smallGraph.contacts.length, large: graphAll.contacts.length, bound: null },
    // Bounded in SQL: four limited queries (80 + 100 + 30 + 25) feed `items`. This is the
    // shape the other two should end up in.
    { name: "notifications panel", small: smallPanel.items.length, large: panel.items.length, bound: 235 },
  ];
  const sizeRatio = (N + SPECIAL_ROWS) / (SCALE_N + SPECIAL_ROWS);

  for (const s of surfaces) {
    const growth = s.small === 0 ? 0 : s.large / s.small;
    console.log(
      `  ${s.name.padEnd(20)} ${String(s.small).padStart(5)} rows at ${SCALE_N}` +
        ` → ${String(s.large).padStart(5)} rows at ${N}` +
        `  (${growth.toFixed(1)}× for a ${sizeRatio.toFixed(1)}× account)`
    );
  }

  for (const s of surfaces) {
    if (s.bound !== null) {
      check(
        `${s.name} stays within its SQL bound of ${s.bound} rows`,
        s.large <= s.bound,
        `${s.large} rows`
      );
      check(
        `${s.name} does not return the whole account`,
        s.large < N,
        `${s.large} rows for a ${N + SPECIAL_ROWS}-contact account`
      );
      // The point of the whole exercise, for the surface it was the point for.
      if (s.flat) {
        check(
          `${s.name} barely moves for a 4× account`,
          s.small === 0 || s.large / s.small < 1.5,
          `${s.small} → ${s.large}`
        );
      }
    } else {
      // Characterisation, not approval. These two return the entire network on every visit;
      // pinning it means the number is in CI output rather than in someone's memory, and a
      // FOURTH surface joining them has to change this file to do it.
      //
      // Phase B of docs/superpowers/plans/2026-09-10-production-readiness.md is what fixes
      // the dashboard: aggregates into SQL, lists bounded with ORDER BY … LIMIT, and the
      // whole-graph pieces materialised. When it lands this entry gets a real `bound` and
      // `maxDuration` in (app)/(main)/layout.tsx goes back to 60.
      // "Show all" is the one surface that means all, and is the reason the scope toggle
      // exists. The default (engaged-only) view above is the bounded one users get.
      check(
        `${s.name} still returns the whole account (by design)`,
        s.large === N + SPECIAL_ROWS,
        `${s.large} rows for a ${N + SPECIAL_ROWS}-contact account`
      );
    }
  }

  // Row count is one half of "unbounded"; the SQL is the other, and it is the half that
  // cannot be faked. `contactById.size` measures what the loader RETAINS — so trimming the
  // Map while the scan still reads the whole table would make the numbers above improve
  // with nothing fixed. This asserts the scan itself.
  //
  // Phase B flips both together: the contacts scan gets an ORDER BY … LIMIT, this check
  // inverts, and the surfaces above get real bounds.
  // The network scan still reads one row per contact — clustering and constellation
  // eligibility are whole-network questions that a sample cannot answer — but it is now
  // NARROW, and that is the property worth pinning. A display column reappearing here would
  // be selected for the entire account in order to render a few hundred rows, which is the
  // mistake this whole section exists to catch.
  //
  // Identified by `constellation_pin`: the hydration queries below also select from
  // `contacts`, so the scan has to be named by something only it asks for.
  const networkScan = dashboardScans.find((q) => selectsBare(q, "constellation_pin"));
  check("the dashboard's network scan is identifiable", Boolean(networkScan));
  for (const column of [
    "full_name", "ai_summary", "email", "title", "last_interaction_at", "created_at",
  ]) {
    check(
      `the network scan does not select ${column}`,
      Boolean(networkScan) && !selectsBare(networkScan!, column),
      networkScan?.slice(0, 220)
    );
  }

  // The dashboard's real size.
  //
  // The "dashboard payload under 1.5 MB" check above cannot see this: `contactById` is a
  // Map, and `JSON.stringify` renders a Map as `{}`. So the byte budget has been measuring
  // the bounded card lists while the largest object on the page — one row per contact —
  // passed through it unweighed. Measured properly here, from the Map's values.
  const rowBytes = (d: { contactById: Map<string, unknown> }) =>
    JSON.stringify([...d.contactById.values()]).length;
  const smallBytes = rowBytes(smallDashboard);
  const largeBytes = rowBytes(dashboard);
  console.log(
    `  dashboard contact rows  ${(smallBytes / 1024).toFixed(0)} KB at ${SCALE_N}` +
      ` → ${(largeBytes / 1024).toFixed(0)} KB at ${N}` +
      `  (${(largeBytes / smallBytes).toFixed(1)}×, ` +
      `${(largeBytes / (dashboard.contactById.size || 1)).toFixed(0)} bytes a contact)`
  );
  // A ceiling on the rows the dashboard moves per contact. Row COUNT is Phase B's problem;
  // row WIDTH is this file's original one, and this is the guard that keeps a re-added
  // `notes` or base64 avatar from hiding inside an already-large payload.
  //
  // Currently ~983 bytes, so the headroom is deliberately thin: one more column on the
  // dashboard scan trips it. That is the intent. If a new field genuinely belongs there,
  // raise this WITH the measurement in the commit message — the thing that must not happen
  // silently is the per-contact cost drifting, because it multiplies by the account size
  // this section just showed is unbounded (2.9 MB at 3,000 contacts, ~9.6 MB at 10,000).
  check(
    "dashboard moves under 250 bytes per contact",
    largeBytes / (dashboard.contactById.size || 1) < 250,
    `${(largeBytes / (dashboard.contactById.size || 1)).toFixed(0)} bytes a contact`
  );

  await resetScaleUser();

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
