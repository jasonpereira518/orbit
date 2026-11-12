/**
 * Radar's rhythm (Radar revision PR 4): a weekly plan that stays put, plus a Today strip.
 *
 *   - The first run of a local week builds the plan (mode "weekly"); every later run that week
 *     is a light daily pass. Monday at 5am local is when the scheduled one lands.
 *   - A daily pass never reshuffles the plan: the same rows, same ids. It adds only moments
 *     (things that expire: a meeting tomorrow, a reply owed) to the Today strip, capped per
 *     plan, and it retires a card whose person has no reason left (you already wrote to them).
 *   - A card retired early that way is not "ignored" by the learned model.
 *   - With the daily pass switched off, the account still gets its weekly plan.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-radar-lifecycle.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactCareerMoves, contacts, interactions, radarRuns, recommendations, userSettings } from "../src/db/schema";
import { claimRadarLease, claimRadarUsers, runRadarForUser } from "../src/lib/radar/run";
import { whatChanged } from "../src/lib/radar/briefing";
import { loadModelTallies } from "../src/lib/radar/store";
import { isMoment, nextRadarRunAt, radarRunMode } from "../src/lib/radar/week";
import { localClock } from "../src/lib/radar/digest";
import type { RadarPick } from "../src/lib/radar/score";
import { ensureUserSettings } from "../src/lib/user-settings";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, purgeUsers } from "./smoke/factories";

const t = checker();
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** The Monday 06:00 UTC of the week three weeks back: a whole week to walk through, in the past. */
function mondayMorning(): Date {
  const d = new Date(Date.now() - 21 * DAY);
  const dow = d.getUTCDay();
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((dow + 6) % 7), 6));
  return monday;
}

function rules() {
  console.log("\nthe rules");
  const mon = mondayMorning();
  t.check("no weekly run on record: this run builds the plan", radarRunMode(null, mon, "UTC") === "weekly");
  t.check("a weekly run earlier this week: daily", radarRunMode(new Date(mon.getTime() - HOUR), new Date(mon.getTime() + 2 * DAY), "UTC") === "daily");
  t.check("last week's weekly run: a new plan", radarRunMode(new Date(mon.getTime() - 2 * DAY), mon, "UTC") === "weekly");
  t.check("the week turns over at local Monday, not UTC Monday",
    radarRunMode(new Date(mon.getTime() - 3 * DAY), new Date(mon.getTime() - 4 * HOUR), "Pacific/Auckland") === "weekly");

  const wed = new Date(mon.getTime() + 2 * DAY + 3 * HOUR);
  const daily = nextRadarRunAt(wed, "America/New_York", true);
  const weeklyOnly = nextRadarRunAt(wed, "America/New_York", false);
  t.check("with the daily pass on, next is tomorrow at 5am local", localClock(daily, "America/New_York").hour === 5 && daily.getTime() - wed.getTime() < 2 * DAY);
  t.check("with it off, next is Monday at 5am local",
    localClock(weeklyOnly, "America/New_York").weekday === 1 && localClock(weeklyOnly, "America/New_York").hour === 5 && weeklyOnly > wed);

  const pick = (code: string, at: Date | null, expiresAt: Date): RadarPick => ({
    contactId: "c1",
    kind: "reach_out",
    score: 40,
    baseScore: 40,
    bucket: "soon",
    reasons: [{ code, label: code, points: 30 }],
    evidence: [{ code, label: code, at: at ? at.toISOString() : null }],
    expiresAt,
  });
  const week = new Date(mon.getTime() + 7 * DAY);
  t.check("a meeting tomorrow is a moment", isMoment(pick("upcoming_meeting", new Date(mon.getTime() + DAY), new Date(mon.getTime() + 2 * DAY)), mon));
  t.check("a meeting in five days is not yet", !isMoment(pick("upcoming_meeting", new Date(mon.getTime() + 5 * DAY), new Date(mon.getTime() + 6 * DAY)), mon));
  t.check("a reply owed is a moment", isMoment(pick("inbound_unanswered", new Date(mon.getTime() - 8 * DAY), week), mon));
  t.check("a job move spotted yesterday is", isMoment(pick("job_change", new Date(mon.getTime() - DAY), week), mon));
  t.check("one spotted last week is not", !isMoment(pick("job_change", new Date(mon.getTime() - 6 * DAY), week), mon));
  t.check("going quiet never is", !isMoment(pick("dormant", new Date(mon.getTime() - 60 * DAY), week), mon));
}

run(async () => {
  rules();

  console.log("\na week, end to end");
  const db = await getDb();
  const USER = fakeUserId("radar-lifecycle");
  const OTHER = fakeUserId("radar-lifecycle-weekly-only");
  await purgeUsers(db, [USER, OTHER]);
  const MON = mondayMorning();
  const at = (days: number, hours = 0) => new Date(MON.getTime() + days * DAY + hours * HOUR);

  try {
    await ensureUserSettings(USER);
    // Pro: a plan of 7, a Today strip of 3.
    await db.update(userSettings).set({ compedPlan: "orbit", radarEnabledAt: at(-30), radarDigestTz: "UTC" }).where(eq(userSettings.userId, USER));

    // Three inner-circle people gone quiet: the week's plan (a plan holds at most half its size,
    // 3 of 7, of any one kind). Each met long ago (met gate).
    const quiet = [];
    for (let i = 0; i < 3; i++) {
      const c = await insertContact(db, USER, 10 + i, { closenessTier: "inner", closenessEvidence: 0.8, closeness: 90 - i, lastInteractionAt: at(-60 - i) });
      await db.insert(interactions).values({ userId: USER, contactId: c.id, interactionType: "meeting", interactionDate: at(-100) });
      quiet.push(c);
    }

    const runAt = async (when: Date) => {
      await claimRadarLease(USER, when);
      const stats = await runRadarForUser(USER, { trigger: "schedule", now: when, ai: false });
      t.check(`the run on ${when.toISOString().slice(0, 10)} succeeds`, stats.ok, JSON.stringify(stats));
      return stats;
    };
    const live = () =>
      db
        .select({ id: recommendations.id, contactId: recommendations.contactId, kind: recommendations.kind, bucket: recommendations.bucket, status: recommendations.status })
        .from(recommendations)
        .where(and(eq(recommendations.userId, USER), inArray(recommendations.status, ["pending", "snoozed", "auto_applied"])));

    const monday = await runAt(at(0));
    t.check("Monday's run is the weekly build", monday.mode === "weekly", String(monday.mode));
    const plan = await live();
    t.check("the plan holds the three quiet people", plan.length === 3 && quiet.every((c) => plan.some((r) => r.contactId === c.id)), JSON.stringify(plan));
    t.check("none of them is a moment", plan.every((r) => r.bucket === "soon"));
    const planIds = new Set(plan.map((r) => r.id));

    // Tuesday: a meeting tomorrow with a new person (a moment), and a fifth quiet person (not).
    const meetingPerson = await insertContact(db, USER, 20, { lastInteractionAt: at(-40) });
    await db.insert(interactions).values([
      { userId: USER, contactId: meetingPerson.id, interactionType: "meeting", interactionDate: at(-100) },
      { userId: USER, contactId: meetingPerson.id, interactionType: "meeting", interactionDate: at(2, 9), aiSummary: "Coffee" },
    ]);
    const fifth = await insertContact(db, USER, 21, { closenessTier: "inner", closenessEvidence: 0.8, closeness: 70, lastInteractionAt: at(-70) });
    await db.insert(interactions).values({ userId: USER, contactId: fifth.id, interactionType: "meeting", interactionDate: at(-100) });

    const tuesday = await runAt(at(1));
    t.check("Tuesday's run is a daily pass", tuesday.mode === "daily", String(tuesday.mode));
    const afterTue = await live();
    t.check("the plan is untouched: same rows, same ids", [...planIds].every((id) => afterTue.some((r) => r.id === id)));
    const meetingCard = afterTue.find((r) => r.contactId === meetingPerson.id);
    t.check("tomorrow's meeting joins the Today strip", meetingCard?.kind === "prep" && meetingCard.bucket === "today", JSON.stringify(meetingCard));
    t.check("a new quiet person waits for next week's plan", !afterTue.some((r) => r.contactId === fifth.id));

    // Wednesday: the person writes to one of the quiet three. Their reason is gone.
    const handled = quiet[0]!;
    await db.update(recommendations).set({ seenCount: 3 }).where(and(eq(recommendations.userId, USER), eq(recommendations.contactId, handled.id)));
    await db.insert(interactions).values({ userId: USER, contactId: handled.id, interactionType: "note", interactionDate: at(2, -1) });
    await db.update(contacts).set({ lastInteractionAt: at(2, -1) }).where(eq(contacts.id, handled.id));
    await runAt(at(2));
    const afterWed = await live();
    t.check("a card whose reason is gone is retired", !afterWed.some((r) => r.contactId === handled.id));
    t.check("the rest of the plan stays", quiet.slice(1).every((c) => afterWed.some((r) => r.contactId === c.id && planIds.has(r.id))));
    const tallies = await loadModelTallies(USER, at(2));
    const dormantVotes = tallies.find((r) => r.scope === "reason" && r.key === "dormant");
    t.check("retired early, it is not counted as ignored", (dormantVotes?.d ?? 0) === 0, JSON.stringify(dormantVotes));

    // Thursday to Sunday: nothing new. The plan does not move; Tuesday's meeting card leaves
    // the Today strip once the meeting is over.
    const planRows = async () => JSON.stringify((await live()).filter((r) => r.bucket === "soon").map((r) => r.id).sort());
    const before = await planRows();
    for (let d = 3; d <= 6; d++) await runAt(at(d));
    t.check("four quiet days later, the plan is the same rows", (await planRows()) === before);
    t.check("and the meeting card left Today once the meeting was over", !(await live()).some((r) => r.contactId === meetingPerson.id));

    // Saturday: news for someone already on the plan. It reaches the dashboard that day, not
    // next Monday, and nobody else's card moves.
    console.log("\nnews for someone already on the plan");
    const newsPerson = quiet[1]!;
    const cardsFor = async (id: string) => (await db.select().from(recommendations).where(and(eq(recommendations.userId, USER), eq(recommendations.contactId, id), inArray(recommendations.status, ["pending", "snoozed", "auto_applied"]))));
    const planBefore = (await live()).filter((r) => r.contactId !== newsPerson.id).map((r) => r.id).sort();
    await db.update(recommendations).set({ seenCount: 2, firstSeenAt: at(1) }).where(and(eq(recommendations.userId, USER), eq(recommendations.contactId, newsPerson.id)));
    await db.insert(contactCareerMoves).values({ userId: USER, contactId: newsPerson.id, kind: "joined", toOrg: "Ramp", toTitle: "Staff PM", source: "web", dedupeKey: "joined-ramp", detectedAt: at(6, 6) });
    await runAt(at(6, 8));
    const [news] = await cardsFor(newsPerson.id);
    t.check("they still have exactly one card", (await cardsFor(newsPerson.id)).length === 1);
    t.check("it now leads with the job move, on Today", news?.reasons[0]?.code === "job_change" && news.bucket === "today", JSON.stringify(news?.reasons[0]));
    t.check("and counts as new again: unseen, made today", news?.firstSeenAt === null && news.createdAt.getTime() === at(6, 8).getTime());
    t.check("the rest of the plan is the same rows", JSON.stringify((await live()).filter((r) => r.contactId !== newsPerson.id).map((r) => r.id).sort()) === JSON.stringify(planBefore));
    const changes = whatChanged([{ ...news!, contactName: "News" }], at(6, 9));
    t.check("the dashboard's What changed shows it", changes.length === 1 && changes[0]!.label === "Joined Ramp as Staff PM", JSON.stringify(changes));
    await runAt(at(6, 10));
    const [again] = await cardsFor(newsPerson.id);
    t.check("an unchanged day later does nothing more", again?.id === news?.id && again.updatedAt.getTime() === news?.updatedAt.getTime());
    await db.update(recommendations).set({ firstSeenAt: at(6, 11) }).where(eq(recommendations.id, news!.id));
    // The card's facts change (the profile refresh gave them a new title): same card, new again.
    await db.update(contacts).set({ title: "Director of Product" }).where(eq(contacts.id, newsPerson.id));
    await runAt(at(6, 14));
    const [updated] = await cardsFor(newsPerson.id);
    t.check("a change to the card's facts updates the same card in place", updated?.id === news?.id && updated.firstSeenAt === null, JSON.stringify({ same: updated?.id === news?.id, seen: updated?.firstSeenAt }));

    // Next Monday: a fresh plan, and the fifth person is in it.
    const nextMonday = await runAt(at(7));
    t.check("next Monday is weekly again", nextMonday.mode === "weekly", String(nextMonday.mode));
    t.check("and the new plan includes the person who went quiet mid-week", (await live()).some((r) => r.contactId === fifth.id));

    const modes = await db.select({ stats: radarRuns.stats }).from(radarRuns).where(eq(radarRuns.userId, USER));
    t.check("every run records its mode", modes.every((r) => (r.stats as { mode?: string } | null)?.mode === "weekly" || (r.stats as { mode?: string } | null)?.mode === "daily"));

    console.log("\nthe daily pass switched off");
    await ensureUserSettings(OTHER);
    await db
      .update(userSettings)
      .set({ radarEnabledAt: at(-30), radarDailyEnabled: 0, radarNextAt: at(7, -1), lastActiveAt: at(7) })
      .where(eq(userSettings.userId, OTHER));
    const claimed = await claimRadarUsers(500, at(7), { includeUnopened: true });
    await db.update(userSettings).set({ radarLeaseUntil: null }).where(inArray(userSettings.userId, claimed));
    t.check("an account with the daily pass off is still claimed for its weekly plan", claimed.includes(OTHER));
    await claimRadarLease(OTHER, at(7));
    await runRadarForUser(OTHER, { trigger: "schedule", now: at(7), ai: false });
    const [row] = await db.select({ next: userSettings.radarNextAt }).from(userSettings).where(eq(userSettings.userId, OTHER));
    t.check("and its next run is the Monday after", row?.next !== null && localClock(row!.next!, "UTC").weekday === 1 && row!.next! > at(7), String(row?.next?.toISOString()));
  } finally {
    await purgeUsers(db, [USER, OTHER]);
  }

  t.done("radar lifecycle");
});
