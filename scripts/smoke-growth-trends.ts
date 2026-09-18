/**
 * Guards the queries behind `/admin/growth`: user totals, signed-in viewers, rolling
 * active accounts, retention curves and per-feature depth.
 *
 * Every failure these catch is silent in the rendered page — a chart with a wrong number
 * still draws a perfectly plausible line. So the assertions are about invariants a reader
 * cannot check by eye:
 *
 *   - empty buckets come back as zero, not missing (a gap that closes up is a chart that lies)
 *   - the running total is the pre-window count plus the sum of new signups
 *   - DAU ≤ WAU ≤ MAU at every point
 *   - retention week 0 counts a member whose first write races their settings row, and a
 *     cohort shows no week its members have not all lived through
 *   - bot and anonymous page views are not counted as accounts opening Orbit
 *   - depth counts each deliberate action once: no capture-batch notes, no synced
 *     interactions, no assistant chat replies, no unsaved captures
 *
 * The smoke PGlite can be shared with other scripts in a run, so assertions compare
 * against a baseline taken before seeding rather than against absolute counts.
 *
 * Run: npx tsx scripts/smoke-growth-trends.ts
 */
import "./smoke/_env";

import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  aiOperationCosts,
  aiWeeklyUsage,
  consistentUsersTrend,
  depthTrend,
  growthSnapshot,
  retentionCurves,
  rollingActiveTrend,
  userTotalsTrend,
  viewersTrend,
  workflowStagesTrend,
} from "../src/lib/admin-trends";
import { MIN_RATE_DENOMINATOR, formatRate } from "../src/lib/format-rate";
import { grainAllowed, growthHref, resolveGrowthWindow } from "../src/lib/growth-range";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BUCKETS = 8; // weeks — wide enough to hold every seeded write but g_old

async function main() {
  // --- 1. Pure: the window and the rate rule ------------------------------------------
  console.log("\nWindow parsing");
  const now = new Date();
  const def = resolveGrowthWindow({}, null, now);
  check("default is 90 days, weekly", def.range === "90d" && def.grain === "week");
  check("garbage params fall back to the default", resolveGrowthWindow({ range: "'; drop", grain: "hour" }, null, now).range === "90d");
  check("daily over 12 months is refused", resolveGrowthWindow({ range: "12m", grain: "day" }, null, now).grain !== "day");
  check("daily over 30 days is allowed", resolveGrowthWindow({ range: "30d", grain: "day" }, null, now).grain === "day");
  check("monthly over 30 days is refused", !grainAllowed("month", 30));
  const allTime = resolveGrowthWindow({ range: "all", grain: "month" }, new Date(now.getTime() - 400 * DAY), now);
  check("all-time spans back to the first signup", allTime.spanDays >= 400 && allTime.buckets >= 13, JSON.stringify(allTime));
  check("default window has a bare href", growthHref("90d", "week") === "/admin/growth");
  check("non-default window keeps its params", growthHref("12m", "week") === "/admin/growth?range=12m&grain=week");

  console.log("\nRate rule");
  check(`below ${MIN_RATE_DENOMINATOR} the percentage is withheld`, formatRate(9, MIN_RATE_DENOMINATOR - 1) === `9 of ${MIN_RATE_DENOMINATOR - 1}`);
  check(`at ${MIN_RATE_DENOMINATOR} the percentage appears`, formatRate(9, MIN_RATE_DENOMINATOR) === `9 of ${MIN_RATE_DENOMINATOR} (30%)`);

  // --- 2. Baseline --------------------------------------------------------------------
  const db = await getDb();
  const before = {
    totals: await userTotalsTrend("week", BUCKETS),
    viewers: await viewersTrend("week", BUCKETS),
    rolling: await rollingActiveTrend("week", BUCKETS),
    depth: await depthTrend("week", BUCKETS),
    snapshot: await growthSnapshot(56),
    retention: await retentionCurves(6, 12),
    stages: await workflowStagesTrend("week", BUCKETS),
  };

  // --- 3. Seed ------------------------------------------------------------------------
  const tag = `gt_${Date.now().toString(36)}`;
  const id = (name: string) => `${tag}_${name}`;
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  const user = (name: string, createdAt: string) =>
    db.execute(sql`INSERT INTO user_settings (user_id, created_at) VALUES (${id(name)}, ${createdAt})`);
  const contact = async (name: string, at: string) => {
    const r = await db.execute(sql`
      INSERT INTO contacts (user_id, full_name, created_at) VALUES (${id(name)}, 'Smoke Contact', ${at})
      RETURNING id`);
    return (r as unknown as { rows: Array<{ id: string }> }).rows?.[0]?.id ??
      (r as unknown as Array<{ id: string }>)[0]?.id;
  };

  await user("old", ago(200 * DAY)); // before the window: seeds the running total only
  await user("a", ago(20 * DAY));
  await user("b", ago(20 * DAY));
  await user("c", ago(3 * DAY));

  // a: active in the last hour — a contact, one saved capture, one queued (not counted),
  // one hand-logged note (counted), one capture-batch note and one synced note (neither).
  const aContact = await contact("a", ago(1 * HOUR));
  await db.execute(sql`INSERT INTO capture_jobs (user_id, source_kind, status, created_at) VALUES
    (${id("a")}, 'text', 'saved', ${ago(1 * HOUR)}),
    (${id("a")}, 'text', 'queued', ${ago(1 * HOUR)})`);
  await db.execute(sql`INSERT INTO interactions (user_id, contact_id, created_at) VALUES (${id("a")}, ${aContact}, ${ago(1 * HOUR)})`);
  await db.execute(sql`INSERT INTO interactions (user_id, contact_id, note_batch_id, created_at) VALUES (${id("a")}, ${aContact}, gen_random_uuid(), ${ago(1 * HOUR)})`);
  await db.execute(sql`INSERT INTO interactions (user_id, contact_id, external_id, created_at) VALUES (${id("a")}, ${aContact}, 'cal-evt-1', ${ago(1 * HOUR)})`);

  // b: active five days ago only — inside WAU, outside DAU.
  await contact("b", ago(5 * DAY));

  // c: one chat exchange two hours ago — the user's message counts, the reply does not.
  const thread = await db.execute(sql`INSERT INTO chat_threads (user_id) VALUES (${id("c")}) RETURNING id`);
  const threadId =
    (thread as unknown as { rows: Array<{ id: string }> }).rows?.[0]?.id ??
    (thread as unknown as Array<{ id: string }>)[0]?.id;
  await db.execute(sql`INSERT INTO chat_messages (thread_id, user_id, role, content, created_at) VALUES
    (${threadId}, ${id("c")}, 'user', 'hi', ${ago(2 * HOUR)}),
    (${threadId}, ${id("c")}, 'assistant', 'hello', ${ago(2 * HOUR)})`);

  // Page views: three signed-in for a, one bot view for b, one anonymous.
  const pv = (userId: string | null, isBot: boolean) => sql`
    INSERT INTO page_views (id, visitor_hash, session_id, user_id, route, device, is_bot, created_at)
    VALUES (gen_random_uuid(), 'h', 's', ${userId}, '/dashboard', 'desktop', ${isBot}, ${ago(1 * HOUR)})`;
  for (let i = 0; i < 3; i++) await db.execute(pv(id("a"), false));
  await db.execute(pv(id("b"), true));
  await db.execute(pv(null, false));

  // Retention cohort four months back: r1 active weeks 0 and 1, r2 wrote 30 minutes BEFORE
  // their settings row existed (the sign-up race), r3 never wrote.
  const cohortStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 4, 1));
  const signed = new Date(cohortStart.getTime() + 1 * DAY);
  const at = (offsetMs: number) => new Date(signed.getTime() + offsetMs).toISOString();
  await user("r1", signed.toISOString());
  await user("r2", signed.toISOString());
  await user("r3", signed.toISOString());
  await contact("r1", at(1 * HOUR));
  await contact("r1", at(8 * DAY));
  await contact("r2", at(-30 * 60_000));

  // --- 4. After -----------------------------------------------------------------------
  const after = {
    totals: await userTotalsTrend("week", BUCKETS),
    viewers: await viewersTrend("week", BUCKETS),
    rolling: await rollingActiveTrend("week", BUCKETS),
    depth: await depthTrend("week", BUCKETS),
    snapshot: await growthSnapshot(56),
    retention: await retentionCurves(6, 12),
    stages: await workflowStagesTrend("week", BUCKETS),
  };

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const last = <T,>(xs: T[]) => xs[xs.length - 1]!;

  console.log("\nSpine");
  for (const [name, rows] of Object.entries({
    totals: after.totals,
    viewers: after.viewers,
    rolling: after.rolling,
    depth: after.depth,
  })) {
    check(`${name}: one row per bucket, empty ones included`, rows.length === BUCKETS, `got ${rows.length}`);
  }
  const bucketIndex = (iso: string) => {
    const t = new Date(iso).getTime();
    let idx = -1;
    after.totals.forEach((p, i) => { if (p.bucketStart.getTime() <= t) idx = i; });
    return idx;
  };
  const quiet = after.totals.findIndex((_, i) =>
    ![ago(20 * DAY), ago(3 * DAY)].some((d) => bucketIndex(d) === i)
  );
  check(
    "a bucket nobody signed up in is zero, not missing",
    quiet >= 0 && after.totals[quiet]!.added === before.totals[quiet]!.added
  );

  console.log("\nUser totals");
  const addedDelta = sum(after.totals.map((p) => p.added)) - sum(before.totals.map((p) => p.added));
  check("three in-window signups counted", addedDelta === 3, `delta ${addedDelta}`);
  check(
    "latest total includes the pre-window accounts (old + three retention members)",
    last(after.totals).total - last(before.totals).total === 7,
    `delta ${last(after.totals).total - last(before.totals).total}`
  );
  const runningOk = after.totals.every((p, i) =>
    i === 0 ? true : p.total === after.totals[i - 1]!.total + p.added
  );
  check("running total = previous + new, every bucket", runningOk);
  const preWindow = await db.execute(sql`
    SELECT count(*)::int AS n FROM user_settings WHERE created_at < ${after.totals[0]!.bucketStart.toISOString()}`);
  const preN = Number(
    ((preWindow as unknown as { rows?: Array<{ n: number }> }).rows ??
      (preWindow as unknown as Array<{ n: number }>))[0]?.n
  );
  check(
    "first total = pre-window count + first bucket's signups",
    after.totals[0]!.total === preN + after.totals[0]!.added,
    `${after.totals[0]!.total} vs ${preN} + ${after.totals[0]!.added}`
  );

  console.log("\nViewers");
  const vNow = last(after.viewers!);
  const vBefore = last(before.viewers!);
  check("one account opened Orbit (bots and anonymous excluded)", vNow.viewers - vBefore.viewers === 1, `delta ${vNow.viewers - vBefore.viewers}`);
  check("its three signed-in views counted", vNow.views - vBefore.views === 3, `delta ${vNow.views - vBefore.views}`);

  console.log("\nRolling active");
  check(
    "DAU ≤ WAU ≤ MAU at every point",
    after.rolling.every((p) => p.dau <= p.wau && p.wau <= p.mau),
    JSON.stringify(after.rolling.map((p) => [p.dau, p.wau, p.mau]))
  );
  const rNow = last(after.rolling);
  const rBefore = last(before.rolling);
  check("DAU +2 (a and c)", rNow.dau - rBefore.dau === 2, `delta ${rNow.dau - rBefore.dau}`);
  check("WAU +3 (b five days ago)", rNow.wau - rBefore.wau === 3, `delta ${rNow.wau - rBefore.wau}`);
  check("MAU +3", rNow.mau - rBefore.mau === 3, `delta ${rNow.mau - rBefore.mau}`);
  check("snapshot agrees with the last point", after.snapshot.dau - before.snapshot.dau === 2 && after.snapshot.wau - before.snapshot.wau === 3);
  check("snapshot total +7", after.snapshot.total - before.snapshot.total === 7);

  console.log("\nDepth");
  const d = (k: "captures" | "notes" | "chats" | "imports") =>
    sum(after.depth.map((p) => p[k])) - sum(before.depth.map((p) => p[k]));
  check("one saved capture (queued one ignored)", d("captures") === 1, `delta ${d("captures")}`);
  check("one hand-logged note (batch + synced ignored)", d("notes") === 1, `delta ${d("notes")}`);
  check("one chat message (assistant reply ignored)", d("chats") === 1, `delta ${d("chats")}`);
  check("no imports", d("imports") === 0);

  console.log("\nRetention");
  // Matched by calendar month, not timestamp: `date_trunc` answers in the session time
  // zone, which is UTC on Neon but local on a developer's PGlite.
  const sameMonth = (a: Date, b: Date) =>
    a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
  const curve = after.retention.find((c) => sameMonth(c.cohortStart, cohortStart));
  const prior = before.retention.find((c) => sameMonth(c.cohortStart, cohortStart));
  if (!curve) {
    check("seeded cohort present", false, `no cohort for ${cohortStart.toISOString()}`);
  } else {
    const wk = (c: typeof curve | undefined, w: number) =>
      c?.weeks.find((x) => x.week === w)?.active ?? 0;
    check("cohort size +3", curve.size - (prior?.size ?? 0) === 3);
    check("every week is drawn for a cohort four months old", curve.weeks.length === 13, `weeks ${curve.weeks.length}`);
    check("week 0 counts r1 and the pre-signup write of r2", wk(curve, 0) - wk(prior, 0) === 2, `delta ${wk(curve, 0) - wk(prior, 0)}`);
    check("week 1 counts r1 only", wk(curve, 1) - wk(prior, 1) === 1);
    check("week 2 counts nobody new", wk(curve, 2) - wk(prior, 2) === 0);
  }
  // c signed up three days ago, so their cohort cannot have finished week 0 yet.
  const cMonth = new Date(ago(3 * DAY));
  const young = after.retention.find((c) => sameMonth(c.cohortStart, cMonth));
  check(
    "a cohort with a three-day-old member draws no week 0",
    Boolean(young) && !young!.weeks.some((w) => w.week === 0)
  );

  console.log("\nWorkflow stages");
  const stageDelta = (k: "signedUp" | "onboarded" | "hasContacts" | "loggedActivity" | "cameBack") =>
    sum(after.stages.map((p) => p[k])) - sum(before.stages.map((p) => p[k]));
  // a and b wrote 7+ days after joining; c (three days old) chatted but cannot have come back.
  check("two accounts came back", stageDelta("cameBack") === 2, `delta ${stageDelta("cameBack")}`);
  check("c stops at logged activity", stageDelta("loggedActivity") === 1, `delta ${stageDelta("loggedActivity")}`);
  check(
    "stages partition each week's signups",
    after.stages.every((p, i) => {
      const t = after.totals[i]!;
      return p.signedUp + p.onboarded + p.hasContacts + p.loggedActivity + p.cameBack === t.added;
    })
  );

  // --- 5. Consistency and AI cost: their own seed, their own baseline ----------------
  console.log("\nConsistent use");
  const cBefore = await consistentUsersTrend(BUCKETS);
  const aiBefore = await aiWeeklyUsage(BUCKETS);
  const opsBefore = await aiOperationCosts(30);

  // k writes once a week, four weeks running: consistent by both definitions.
  await user("k", ago(40 * DAY));
  for (const d of [0, 7, 14, 21]) await contact("k", ago(d * DAY + 1 * HOUR));
  // AI: two managed-key calls, one BYOK call, one failed unpriced call.
  const ev = (owner: string, micros: number | null, success: number) => sql`
    INSERT INTO usage_events (user_id, operation, provider, model, kind, key_owner, estimated_cost_micros, success, created_at)
    VALUES (${id("k")}, 'smoke.growth_op', 'test', 'test-model', 'text', ${owner}, ${micros}, ${success}, ${ago(1 * HOUR)})`;
  await db.execute(ev("orbit", 1500, 1));
  await db.execute(ev("orbit", 2500, 1));
  await db.execute(ev("user", 700, 1));
  await db.execute(ev("user", null, 0));

  const cAfter = await consistentUsersTrend(BUCKETS);
  check(
    "all-four ≤ three-of-four at every week",
    cAfter.every((p) => p.allFour <= p.threeOfFour)
  );
  check("k counts as active in all four weeks", last(cAfter).allFour - last(cBefore).allFour === 1, `delta ${last(cAfter).allFour - last(cBefore).allFour}`);
  check("and in three-of-four", last(cAfter).threeOfFour - last(cBefore).threeOfFour === 1);

  console.log("\nAI usage and cost");
  const aiAfter = await aiWeeklyUsage(BUCKETS);
  const aNow = last(aiAfter);
  const aPrev = last(aiBefore);
  check("four calls this week", aNow.calls - aPrev.calls === 4, `delta ${aNow.calls - aPrev.calls}`);
  check("one failure", aNow.failures - aPrev.failures === 1);
  check("managed-key cost is Orbit's", aNow.orbitMicros - aPrev.orbitMicros === 4000, `delta ${aNow.orbitMicros - aPrev.orbitMicros}`);
  check("BYOK cost kept separate", aNow.userMicros - aPrev.userMicros === 700);
  check("unpriced call counted, not treated as free", aNow.unpriced - aPrev.unpriced === 1);
  const op = (await aiOperationCosts(30)).find((r) => r.operation === "smoke.growth_op");
  const opPrev = opsBefore.find((r) => r.operation === "smoke.growth_op");
  check(
    "operation row carries calls, cost and Orbit's share",
    Boolean(op) &&
      op!.calls - (opPrev?.calls ?? 0) === 4 &&
      op!.micros - (opPrev?.micros ?? 0) === 4700 &&
      op!.orbitMicros - (opPrev?.orbitMicros ?? 0) === 4000 &&
      op!.failures - (opPrev?.failures ?? 0) === 1,
    JSON.stringify(op)
  );

  console.log(failures === 0 ? "\nAll growth-trend checks passed." : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
