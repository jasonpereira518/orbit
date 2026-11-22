/**
 * The Radar page (Radar revision PR 9a): what it is given and what its actions do.
 *
 *   - Dismissing asks why. "Wrong reason" is a vote against the card's kind and reasons;
 *     "wrong person" quiets every card about that person and teaches the model nothing;
 *     "already handled" is no vote; "not now" is a week's snooze.
 *   - The Opportunities lane lists the web pass's open finds (never past, saved or dismissed),
 *     with the introducer's name joined in. Saving one makes an event, a contact or a reminder
 *     by its kind; dismissing keeps the reason on the row.
 *   - The page knows when the week was built, and in a thin week what Radar still needs.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-radar-page.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, events, radarOpportunities, radarRuns, recommendationFeedback, recommendations, reminders, userGoals } from "../src/db/schema";
import { dismissRecommendationForUser } from "../src/lib/radar/actions-core";
import { dismissOpportunityForUser, listOpenOpportunities, saveOpportunityForUser } from "../src/lib/radar/opportunity-actions";
import { loadRadarPage } from "../src/lib/radar/page-data";
import { parsePersonTitle, personTitle } from "../src/lib/radar/person-title";
import { loadModelTallies, loadSuppressions } from "../src/lib/radar/store";
import type { RecommendationKind } from "../src/lib/radar/types";
import { ensureUserSettings } from "../src/lib/user-settings";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, purgeUsers } from "./smoke/factories";

const t = checker();
const DAY = 86_400_000;
const NOW = new Date();
const at = (d: number) => new Date(NOW.getTime() + d * DAY);

run(async () => {
  const db = await getDb();
  const USER = fakeUserId("radar-page");
  const users = [USER];
  try {
    await ensureUserSettings(USER);
    await db.insert(radarRuns).values({ userId: USER, trigger: "schedule", status: "ok", startedAt: at(-2), stats: { mode: "weekly" } });

    const card = async (contactId: string, kind: RecommendationKind, code: string) => {
      const [row] = await db
        .insert(recommendations)
        .values({ userId: USER, contactId, kind, score: 40, bucket: "soon", expiresAt: at(7), inputsHash: `h-${contactId}-${kind}`, reasons: [{ code, label: code, points: 30 }] })
        .returning();
      return row!.id;
    };

    console.log("dismiss reasons");
    const ana = (await insertContact(db, USER, 1))!;
    const bo = (await insertContact(db, USER, 2))!;
    const cy = (await insertContact(db, USER, 3))!;
    const dee = (await insertContact(db, USER, 4))!;
    const wrongReason = await card(ana.id, "reconnect", "dormant");
    const wrongPerson = await card(bo.id, "reach_out", "goal_fit_x");
    const handled = await card(cy.id, "follow_up", "open_thread");
    const notNow = await card(dee.id, "reconnect", "dormant");
    await dismissRecommendationForUser(USER, wrongReason, "wrong_reason");
    await dismissRecommendationForUser(USER, wrongPerson, "wrong_person");
    await dismissRecommendationForUser(USER, handled, "already_handled");
    await dismissRecommendationForUser(USER, notNow, "not_now");

    const [snoozed] = await db.select().from(recommendations).where(eq(recommendations.id, notNow));
    t.check("\"not now\" is a week's snooze, not a dismissal", snoozed?.status === "snoozed" && (snoozed.snoozedUntil?.getTime() ?? 0) > at(6).getTime(), snoozed?.status);
    const fb = await db.select().from(recommendationFeedback).where(eq(recommendationFeedback.recommendationId, wrongPerson));
    t.check("the reason is kept with the feedback", fb.some((f) => f.action === "dismissed" && f.reason === "wrong_person"));

    const tallies = await loadModelTallies(USER, NOW);
    const kind = (k: string) => tallies.find((r) => r.scope === "kind" && r.key === k);
    t.check("\"wrong reason\" votes against the kind", Number(kind("reconnect")?.d ?? 0) >= 1, JSON.stringify(kind("reconnect")));
    t.check("\"wrong person\" teaches the model nothing about the kind", Number(kind("reach_out")?.d ?? 0) === 0, JSON.stringify(kind("reach_out")));
    t.check("\"already handled\" is no vote either", Number(kind("follow_up")?.d ?? 0) === 0, JSON.stringify(kind("follow_up")));

    const sup = await loadSuppressions(USER, [], NOW);
    const boSup = sup.get(bo.id);
    t.check("\"wrong person\" quiets every kind of card about them", Boolean(boSup?.dismissedAt.reconnect && boSup.dismissedAt.prep && boSup.dismissedAt.introduce));
    t.check("a plain reason quiets only its own kind", Boolean(sup.get(ana.id)?.dismissedAt.reconnect) && !sup.get(ana.id)?.dismissedAt.reach_out);

    console.log("\nthe Opportunities lane");
    const mei = (await insertContact(db, USER, 5, { fullName: "Mei Tan" }))!;
    const proof = (url: string, label: string) => [{ label, at: null, url, code: "x", proof: { type: "url" as const, url } }];
    const finds = await db
      .insert(radarOpportunities)
      .values([
        { userId: USER, kind: "event", title: "Climate Meetup", url: "https://www.meetup.com/climate/1", why: "Your climate goal", startsAt: at(8), expiresAt: at(8), evidence: proof("https://www.meetup.com/climate/1", "At Capital Factory"), dedupeKey: "event:a" },
        { userId: USER, kind: "event", title: "Sooner Night", url: "https://example.com/soon", startsAt: at(2), expiresAt: at(2), evidence: proof("https://example.com/soon", "Event page"), dedupeKey: "event:b" },
        { userId: USER, kind: "event", title: "Last week's mixer", url: "https://example.com/past", startsAt: at(-3), expiresAt: at(-3), dedupeKey: "event:c" },
        { userId: USER, kind: "event", title: "Already saved", url: "https://example.com/saved", startsAt: at(5), status: "saved", dedupeKey: "event:d" },
        {
          userId: USER,
          kind: "person",
          title: personTitle({ fullName: "Rosa Alvarez", title: "Partnerships lead", company: "Fluence" }),
          url: "https://fluence.example.com/rosa",
          why: "Runs partnerships",
          expiresAt: at(30),
          relatedContactIds: [mei.id],
          evidence: proof("https://fluence.example.com/rosa", "Their page"),
          dedupeKey: "person:a",
        },
        { userId: USER, kind: "program", title: "Climate Fellows", url: "https://example.org/fellows", why: "Fits your goal", expiresAt: at(20), evidence: proof("https://example.org/fellows", "Program page"), dedupeKey: "program:a" },
      ])
      .returning();
    const idOf = (key: string) => finds.find((f) => f.dedupeKey === key)!.id;

    const open = await listOpenOpportunities(USER, NOW);
    t.check("open finds only: nothing past or saved", open.length === 4 && !open.some((o) => o.title === "Last week's mixer" || o.title === "Already saved"), open.map((o) => o.title).join());
    t.check("soonest first", open[0]?.title === "Sooner Night", open[0]?.title);
    const rosa = open.find((o) => o.kind === "person");
    t.check("a person find names the introducer", rosa?.introducer?.contactId === mei.id && rosa.introducer.name === "Mei Tan", JSON.stringify(rosa?.introducer));
    t.check("a person's title reads back", JSON.stringify(parsePersonTitle(rosa!.title)) === JSON.stringify({ fullName: "Rosa Alvarez", title: "Partnerships lead", company: "Fluence" }));

    const page = await loadRadarPage(USER);
    t.check("the page carries the finds", page.opportunities.length === 4);
    t.check("the page knows when the week was built", page.weekBuiltAt !== null && Math.abs(page.weekBuiltAt.getTime() - at(-2).getTime()) < 1000);
    t.check("a full week shows no help panel", page.coldStart === null);

    const savedEvent = await saveOpportunityForUser(USER, idOf("event:a"), NOW);
    const [ev] = await db.select().from(events).where(and(eq(events.userId, USER), eq(events.url, "https://www.meetup.com/climate/1")));
    t.check("saving an event puts it on the Events page, venue and all", savedEvent.ok && ev?.venue === "Capital Factory", ev?.venue ?? "none");
    const savedPerson = await saveOpportunityForUser(USER, idOf("person:a"), NOW);
    const [person] = await db.select().from(contacts).where(and(eq(contacts.userId, USER), eq(contacts.fullName, "Rosa Alvarez")));
    t.check("saving a person makes them a contact", savedPerson.ok && person?.company === "Fluence" && person.title === "Partnerships lead", `${person?.company} ${person?.title}`);
    const savedProgram = await saveOpportunityForUser(USER, idOf("program:a"), NOW);
    const [rem] = await db.select().from(reminders).where(and(eq(reminders.userId, USER), eq(reminders.title, "Apply: Climate Fellows")));
    const due = rem?.dueDate?.getTime() ?? 0;
    t.check("saving a program sets a reminder a week before its deadline", savedProgram.ok && Math.abs(due - at(13).getTime()) < DAY, rem?.dueDate?.toISOString());
    const again = await saveOpportunityForUser(USER, idOf("event:a"), NOW);
    t.check("a saved find can't be saved twice", !again.ok);

    await dismissOpportunityForUser(USER, idOf("event:b"), "not_now");
    const [b] = await db.select().from(radarOpportunities).where(eq(radarOpportunities.id, idOf("event:b")));
    t.check("dismissing a find keeps the reason", b?.status === "dismissed" && b.dismissReason === "not_now");
    const other = fakeUserId("radar-page-other");
    users.push(other);
    t.check("another account can't touch the find", !(await saveOpportunityForUser(other, idOf("event:c"), NOW)).ok);

    console.log("\na thin week");
    await db.insert(userGoals).values({ userId: USER, text: "Meet climate founders" });
    const thin = await loadRadarPage(USER);
    t.check("with fewer than three cards and finds, the page says what Radar needs", thin.coldStart !== null && thin.coldStart.goals === 1 && !thin.coldStart.hasCity, JSON.stringify(thin.coldStart));
  } finally {
    await purgeUsers(db, users);
  }

  t.done("radar page");
});
