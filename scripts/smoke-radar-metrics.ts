/**
 * Radar's measurement: impressions, action stamps, outcomes, and the admin aggregates.
 *
 * On a throwaway PGlite. Seeds one account's cards in every state the metrics distinguish,
 * then checks each definition in `src/lib/radar/metrics.ts` against rows it wrote itself:
 * an impression counts once per six hours, an action stamps `acted_at` and Undo clears it,
 * only a real conversation within 14 days of an accept is an outcome, and the report's
 * rates, rerank groups, draft split, median and run figures add up.
 *
 * The clock is fixed years ahead so rows other scripts leave in the shared database fall
 * outside every window here. Leaves nothing behind.
 *
 * Run: npx tsx scripts/smoke-radar-metrics.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, radarRuns, recommendations, userSettings } from "../src/db/schema";
import {
  dismissRecommendationForUser,
  restoreRecommendationForUser,
  scheduleRecommendationForUser,
} from "../src/lib/radar/actions-core";
import { loadRadarMetrics, summarizeRadarMetrics } from "../src/lib/radar/metrics";
import { detectRadarOutcomes, markRecommendationsSeen, RADAR_SEEN_DEBOUNCE_MS } from "../src/lib/radar/store";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-radar-metrics-user";
const NOW = new Date("2031-03-01T12:00:00Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function reset() {
  const db = await getDb();
  await db.delete(radarRuns).where(eq(radarRuns.userId, USER));
  // Contacts cascade to interactions and recommendations.
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function person(name: string) {
  const db = await getDb();
  const [row] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: name, firstInteractionAt: ago(300), lastInteractionAt: ago(60) })
    .returning();
  return row!.id;
}

type CardSeed = Partial<typeof recommendations.$inferInsert> & { contactId: string };
async function card(seed: CardSeed) {
  const db = await getDb();
  const [row] = await db
    .insert(recommendations)
    .values({
      userId: USER,
      kind: "reconnect",
      score: 40,
      bucket: "soon",
      expiresAt: new Date(NOW.getTime() + 7 * DAY),
      inputsHash: "h",
      ...seed,
    })
    .returning();
  return row!;
}

async function main() {
  await reset();
  const db = await getDb();
  await ensureUserSettings(USER);

  console.log("impressions");
  {
    const c = await person("Seen Sol");
    const rec = await card({ contactId: c });
    await markRecommendationsSeen(USER, [rec.id], NOW);
    await markRecommendationsSeen(USER, [rec.id], new Date(NOW.getTime() + HOUR));
    let [row] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id));
    check("a reload within six hours is not a second look", row?.seenCount === 1, `seen ${row?.seenCount}`);
    check("the first look is stamped", row?.firstSeenAt?.getTime() === NOW.getTime());
    const later = new Date(NOW.getTime() + RADAR_SEEN_DEBOUNCE_MS + HOUR);
    await markRecommendationsSeen(USER, [rec.id], later);
    [row] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id));
    check("a look after the debounce counts", row?.seenCount === 2, `seen ${row?.seenCount}`);
    check("and keeps the first look", row?.firstSeenAt?.getTime() === NOW.getTime());
    check("while moving the last one", row?.lastSeenAt?.getTime() === later.getTime());
    await markRecommendationsSeen("someone-else", [rec.id], new Date(later.getTime() + 2 * RADAR_SEEN_DEBOUNCE_MS));
    [row] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id));
    check("another account cannot stamp this card", row?.seenCount === 2);
    await db.delete(contacts).where(eq(contacts.id, c));
  }

  console.log("\naction stamps");
  {
    const a = await person("Accept Ada");
    const d = await person("Dismiss Dev");
    const accepted = await card({ contactId: a });
    const dismissed = await card({ contactId: d });
    await scheduleRecommendationForUser(USER, accepted.id, 7);
    await dismissRecommendationForUser(USER, dismissed.id);
    const [acc] = await db.select().from(recommendations).where(eq(recommendations.id, accepted.id));
    const [dis] = await db.select().from(recommendations).where(eq(recommendations.id, dismissed.id));
    check("scheduling stamps acted_at", acc?.actedAt instanceof Date);
    check("dismissing stamps acted_at", dis?.actedAt instanceof Date);
    await restoreRecommendationForUser(USER, dismissed.id);
    const [back] = await db.select().from(recommendations).where(eq(recommendations.id, dismissed.id));
    check("Undo clears it, since the action no longer happened", back?.status === "pending" && back?.actedAt === null);
    await db.delete(contacts).where(eq(contacts.id, a));
    await db.delete(contacts).where(eq(contacts.id, d));
  }

  console.log("\noutcomes");
  {
    const talk = await person("Talked Tara");
    const late = await person("Late Lou");
    const derived = await person("Derived Dom");
    const dismissedContact = await person("Dismissed Dee");
    const talked = await card({ contactId: talk, status: "accepted", actedAt: ago(10) });
    const tooLate = await card({ contactId: late, status: "accepted", actedAt: ago(25) });
    const onlyDerived = await card({ contactId: derived, status: "accepted", actedAt: ago(10) });
    const notAccepted = await card({ contactId: dismissedContact, status: "dismissed", actedAt: ago(10) });
    await db.insert(interactions).values([
      { userId: USER, contactId: talk, interactionType: "meeting", interactionDate: ago(6) },
      { userId: USER, contactId: talk, interactionType: "note", interactionDate: ago(4) },
      { userId: USER, contactId: late, interactionType: "meeting", interactionDate: ago(2) },
      { userId: USER, contactId: derived, interactionType: "meeting", interactionDate: ago(6), source: "ai_derived" },
      { userId: USER, contactId: dismissedContact, interactionType: "meeting", interactionDate: ago(6) },
    ]);
    const converted = await detectRadarOutcomes(USER, NOW);
    const read = async (id: string) => (await db.select().from(recommendations).where(eq(recommendations.id, id)))[0];
    check("one card converted", converted === 1, `got ${converted}`);
    check("a conversation within 14 days of the accept is an outcome, dated to the first one",
      (await read(talked.id))?.outcomeAt?.getTime() === ago(6).getTime());
    check("one after the window is not", (await read(tooLate.id))?.outcomeAt === null);
    check("an AI-derived row is not a conversation", (await read(onlyDerived.id))?.outcomeAt === null);
    check("a dismissed card has no outcome", (await read(notAccepted.id))?.outcomeAt === null);
    check("a second pass converts nothing new", (await detectRadarOutcomes(USER, NOW)) === 0);
    for (const id of [talk, late, derived, dismissedContact]) await db.delete(contacts).where(eq(contacts.id, id));
  }

  console.log("\nthe report");
  {
    const seen = (days: number) => ({ firstSeenAt: ago(days), lastSeenAt: ago(days), seenCount: 1 });
    const cs = await Promise.all(["A", "B", "C", "D", "E", "F", "G"].map((n) => person(`Report ${n}`)));
    // 7 cards shown in the last week; one older card outside the 7-day window.
    await card({ contactId: cs[0]!, kind: "reach_out", ...seen(2), status: "accepted", actedAt: new Date(ago(2).getTime() + 2 * HOUR), outcomeAt: ago(1), aiDelta: 10, draft: { body: "Hi", channel: "email", inputsHash: "h", generatedAt: ago(2).toISOString() } });
    await card({ contactId: cs[1]!, kind: "reach_out", ...seen(3), status: "accepted", actedAt: new Date(ago(3).getTime() + 4 * HOUR), aiDelta: 5 });
    await card({ contactId: cs[2]!, kind: "reach_out", ...seen(3), status: "dismissed", actedAt: new Date(ago(3).getTime() + 6 * HOUR), aiDelta: -8 });
    await card({ contactId: cs[3]!, kind: "reconnect", ...seen(4), status: "expired", seenCount: 3 });
    await card({ contactId: cs[4]!, kind: "reconnect", ...seen(4), status: "expired", seenCount: 1 });
    await card({ contactId: cs[5]!, kind: "prep", ...seen(1), status: "snoozed", actedAt: ago(1) });
    await card({ contactId: cs[6]!, kind: "prep", ...seen(20), status: "accepted", actedAt: ago(19) });
    await db.insert(radarRuns).values([
      { userId: USER, trigger: "schedule", status: "ok", startedAt: ago(1), durationMs: 1000, stats: { aiNotes: 2 } },
      { userId: USER, trigger: "schedule", status: "failed", startedAt: ago(2), durationMs: 3000, stats: { aiNotes: 0 } },
    ]);

    const week = await loadRadarMetrics(7, NOW);
    check("shown counts cards first seen in the window", week.totals.shown === 6, `got ${week.totals.shown}`);
    check("accepted and its rate", week.totals.accepted === 2 && Math.abs((week.totals.acceptRate ?? 0) - 2 / 6) < 1e-9);
    check("converted is a share of accepted", week.totals.converted === 1 && week.totals.convertRate === 0.5);
    check("ignored needs three looks and no action", week.totals.ignored === 1, `got ${week.totals.ignored}`);
    const reach = week.kinds.find((k) => k.kind === "reach_out");
    check("per kind", reach?.shown === 3 && reach.accepted === 2 && reach.dismissed === 1);
    check("the rerank splits promoted, demoted and untouched",
      week.rerank.promoted.shown === 2 && week.rerank.promoted.accepted === 2 &&
      week.rerank.demoted.shown === 1 && week.rerank.demoted.accepted === 0 &&
      week.rerank.untouched.shown === 3);
    check("drafts split", week.drafts.withDraft.shown === 1 && week.drafts.without.shown === 5);
    // Acted on after 2 h, 4 h and 6 h (reach_out), and 0 h (the snooze, the moment it was
    // seen): the median of 0, 2, 4, 6 is 3.
    check("median time to act is over the cards acted on",
      week.medianHoursToAction !== null && Math.abs(week.medianHoursToAction - 3) < 1e-6, `got ${week.medianHoursToAction}`);
    check("accounts shown", week.accountsShown === 1);
    check("runs: total, failed, p95, AI lines",
      week.runs.total === 2 && week.runs.failed === 1 && week.runs.p95Ms !== null && week.runs.p95Ms > 2000 &&
      week.runs.avgAiNotes === 1, JSON.stringify(week.runs));
    const month = await loadRadarMetrics(28, NOW);
    check("the 28-day window includes the older card", month.totals.shown === 7 && month.totals.accepted === 3);

    const empty = summarizeRadarMetrics([], {
      windowDays: 7,
      medianHoursToAction: null,
      accountsShown: 0,
      runs: { total: 0, failed: 0, p95Ms: null, avgAiNotes: null, accounts: 0 },
    });
    check("an empty window has no rates, not zero rates",
      empty.totals.acceptRate === null && empty.totals.convertRate === null && empty.totals.ignoreRate === null);
    check("and lists every kind", empty.kinds.length === 6);
  }

  console.log("\nthe admin page");
  {
    const { default: AdminRadarPage } = await import("../src/app/(clerk)/(admin)/admin/analytics/radar/page");
    const page = await AdminRadarPage({ searchParams: Promise.resolve({ window: "7" }) });
    check("renders without throwing", page != null);
    const bogus = await AdminRadarPage({ searchParams: Promise.resolve({ window: "9999" }) });
    check("and falls back to the default window on a bad parameter", bogus != null);
  }

  await reset();
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll radar metrics checks passed.");
}

run(async () => {
  try {
    await main();
  } finally {
    await reset().catch(() => {});
  }
});
