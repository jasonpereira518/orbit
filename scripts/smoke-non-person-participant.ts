/**
 * Non-person participants (`src/lib/non-person-participant.ts`): the predicate's cases, that
 * its SQL twin agrees row for row, that ingest no longer creates them, that the People list
 * hides them, and that the cleanup script deletes only calendar-only matches.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, reminders } from "../src/db/schema";
import { listContactsPage } from "../src/lib/contacts-page-query";
import { calendarExternalIdBase } from "../src/lib/ingest/external-id";
import { ingestEvents, openIngestContext } from "../src/lib/ingest/events";
import { isNonPersonParticipant, nonPersonContactSql } from "../src/lib/non-person-participant";
import { deleteNonPersonContacts, findNonPersonContacts } from "./cleanup-non-person-contacts";
import { checker } from "./smoke/check";

const t = checker();

// [name, email, is a non-person]
const CASES: [string, string | null, boolean][] = [
  ["External Stripe Interview Calendar 2", "c_abc123@group.calendar.google.com", true],
  ["External Stripe Interview Calendar 2", null, true],
  ["Team Offsite Calendar", null, true],
  ["Board Room", "c_188xyz@resource.calendar.google.com", true],
  ["Conference Room 4B", "room4b@acme.com", true],
  ["Acme Meeting Room", null, true],
  ["Acme", "noreply@acme.com", true],
  ["Acme", "no-reply+abc@acme.com", true],
  ["Acme Notifications", "notifications@acme.com", true],
  ["Recruiting", "invites@lu.ma", true],
  ["Acme", "calendar@acme.com", true],
  ["Acme", "updates@acme.com", true],
  // Role-looking mailboxes on a person's own domain are often one person.
  ["Maya Chen", "hello@mayachen.com", false],
  ["Maya Chen", "hi@mayachen.com", false],
  ["Founders", "team@tinyco.io", false],
  ["Raj Patel", "sales@patelco.com", false],
  ["Raj Patel", "info@patelco.com", false],
  ["Calvin Dar", "calvin.dar@gmail.com", false],
  ["Ann Calendar", "ann@gmail.com", false],
  ["Calendula Smith", null, false],
  ["Priya Raman", "priya@acme.com", false],
  ["Jo Lee", "jo+calendar@gmail.com", false],
  ["Sam Ortiz", "sam@calendar-co.com", false],
];

run(async () => {
  for (const [name, email, want] of CASES) {
    t.check(`TS: "${name}" <${email ?? ""}> → ${want ? "not a person" : "person"}`, isNonPersonParticipant(name, email) === want);
  }

  const db = await getDb();
  const PROBE = `smoke-nonperson-probe-${randomUUID()}`;
  const ids = new Map<string, boolean>();
  for (const [name, email] of CASES) {
    const [row] = await db.insert(contacts).values({ userId: PROBE, fullName: name, email }).returning();
    ids.set(row!.id, isNonPersonParticipant(name, email));
  }
  const sqlHits = new Set(
    (await db.select({ id: contacts.id }).from(contacts).where(nonPersonContactSql())).map((r) => r.id)
  );
  const disagree = [...ids].filter(([id, ts]) => sqlHits.has(id) !== ts);
  t.check("SQL twin agrees with the TS predicate on every case", disagree.length === 0, `${disagree.length} disagree`);

  const page = await listContactsPage(PROBE, { limit: 200 });
  t.check(
    "the People list shows only the people",
    page.items.length === CASES.filter((c) => !c[2]).length && page.total === page.items.length,
    `${page.items.length} shown, total ${page.total}`
  );

  // Ingest: the group calendar is not created; the person on the same invite is.
  const INGEST = `smoke-nonperson-ingest-${randomUUID()}`;
  const ctx = await openIngestContext(INGEST, { source: "google_calendar", createsContacts: true });
  const stats = await ingestEvents(ctx, [
    {
      externalIdBase: calendarExternalIdBase("evt-np"),
      type: "meeting",
      timestamp: new Date("2026-03-10T15:00:00Z"),
      participants: [
        { name: "External Stripe Interview Calendar 2", email: "c_abc123@group.calendar.google.com" },
        { name: "Ada Lovelace", email: "ada@example.com" },
      ],
      summary: "Interview",
    },
  ]);
  const created = await db.select({ fullName: contacts.fullName }).from(contacts).where(eq(contacts.userId, INGEST));
  t.check("ingest creates the person and skips the calendar", created.length === 1 && created[0]!.fullName === "Ada Lovelace" && stats.unmatched === 1, JSON.stringify({ created, stats }));

  // Cleanup: only an untouched, calendar-made match goes; everything else is kept with a reason.
  const CLEAN = `smoke-nonperson-clean-${randomUUID()}`;
  const add = async (fullName: string, email: string | null, sources: string[], source = "google_calendar") => {
    const [c] = await db.insert(contacts).values({ userId: CLEAN, fullName, email, source }).returning();
    for (const s of sources) await db.insert(interactions).values({ userId: CLEAN, contactId: c!.id, interactionType: "meeting", source: s });
    return c!.id;
  };
  const calOnly = await add("Interview Calendar 2", "c_1@group.calendar.google.com", ["google_calendar", "google_calendar"]);
  const bare = await add("Board Room", "c_2@resource.calendar.google.com", []);
  const noted = await add("Acme Notifications", "notifications@acme.com", ["google_calendar", "capture"]);
  const reminded = await add("Team Offsite Calendar", "c_3@group.calendar.google.com", ["google_calendar"]);
  await db.insert(reminders).values({ userId: CLEAN, contactId: reminded, title: "Follow up", dueDate: new Date() });
  const handMade = await add("Conference Room 4B", "room4b@acme.com", [], "manual");
  const person = await add("Calvin Dar", "calvin.dar@gmail.com", ["google_calendar"]);
  const nameOnly = await add("Mary Ann Calendar", "mary@acme.com", ["google_calendar"]);

  const matches = (await findNonPersonContacts()).filter((m) => m.userId === CLEAN);
  const byId = new Map(matches.map((m) => [m.id, m]));
  t.check("cleanup finds the six matches, not the person", matches.length === 6 && !byId.has(person));
  t.check("interaction counts by source are reported", byId.get(calOnly)?.sources.google_calendar === 2 && byId.get(noted)?.sources.capture === 1);
  t.check("calendar-only and bare calendar matches are deletable", byId.get(calOnly)?.deletable === true && byId.get(bare)?.deletable === true);
  t.check("a match with a non-calendar interaction is kept", byId.get(noted)?.deletable === false && byId.get(noted)!.keepReasons.includes("non-calendar interactions"));
  t.check("a calendar-only match with a reminder is kept", byId.get(reminded)?.deletable === false && byId.get(reminded)!.keepReasons.includes("has reminders"), JSON.stringify(byId.get(reminded)?.keepReasons));
  t.check("a match not made by a calendar is kept", byId.get(handMade)?.deletable === false && byId.get(handMade)!.keepReasons.includes("source manual"));

  t.check(
    "a name-only match with an ordinary email is kept",
    byId.get(nameOnly)?.deletable === false && byId.get(nameOnly)!.keepReasons.join() === "name-only match",
    JSON.stringify(byId.get(nameOnly)?.keepReasons)
  );

  const deleted = await deleteNonPersonContacts(matches);
  const left = new Set((await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.userId, CLEAN))).map((r) => r.id));
  t.check(
    "--apply deletes the deletable ones and keeps the rest",
    deleted.length === 2 && left.size === 5 && [noted, reminded, handMade, person, nameOnly].every((id) => left.has(id)),
    `${deleted.length} deleted`
  );

  // Other smokes share this PGlite and look contacts up by email (ada@example.com), so leave
  // nothing behind.
  const users = [PROBE, INGEST, CLEAN];
  await db.delete(reminders).where(inArray(reminders.userId, users));
  await db.delete(interactions).where(inArray(interactions.userId, users));
  await db.delete(contacts).where(inArray(contacts.userId, users));

  t.done("non-person participant smoke");
});
