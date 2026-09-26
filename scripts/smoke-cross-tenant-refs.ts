/**
 * Cross-tenant references: an id that arrives from a client must be the caller's before
 * anything is written against it, and a row that already holds a foreign id must not leak
 * the other account's data when it is read back.
 *
 * `pglite` tier. These pin the lib write paths rather than the actions, because every
 * caller funnels through them — the four event actions, the MCP tools, the capture save.
 *
 * What each guard stops:
 *   - attendees/companies on someone else's event: `ON CONFLICT (event_id, …) DO UPDATE`
 *     filled blanks on the victim's own attendee rows;
 *   - enrichment of someone else's event: overwrote the public Blob cover at
 *     `event-covers/<eventId>`;
 *   - `updateEventForUser` with a `userId` key: moved the row into another account;
 *   - opportunities/reminders on a foreign contact: the job matcher and the ICS feed then
 *     printed that contact's name and employer into the attacker's account.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contacts, events, reminders } from "../src/db/schema";
import {
  assertEventOwnedBy,
  createEventForUser,
  EventNotFoundError,
  updateEventForUser,
  upsertEventAttendees,
} from "../src/lib/events/store";
import { upsertEventCompanies } from "../src/lib/events/companies";
import { enrichEvent } from "../src/lib/events/enrich";
import { insertOpportunities } from "../src/lib/contact-opportunities";
import { assertReminderContactOwned } from "../src/lib/reminder-writes";
import { buildRemindersFeed } from "../src/lib/calendar-feed";

const OWNER = "xtenant-owner";
const ATTACKER = "xtenant-attacker";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function rejects(label: string, fn: () => Promise<unknown>, expect?: (e: unknown) => boolean) {
  try {
    await fn();
    check(label, false, "did not throw");
  } catch (error) {
    check(label, expect ? expect(error) : true, String(error));
  }
}

run(async () => {
  const db = await getDb();
  for (const table of [
    "event_companies",
    "event_attendees",
    "events",
    "contact_opportunities",
    "reminders",
    "contacts",
  ]) {
    await db.execute(sql.raw(`DELETE FROM ${table} WHERE user_id IN ('${OWNER}', '${ATTACKER}')`));
  }

  const event = await createEventForUser(OWNER, { title: "Owner's dinner" });
  const [contact] = await db
    .insert(contacts)
    .values({ userId: OWNER, fullName: "Secret Person", company: "Hidden Co" })
    .returning();

  console.log("\nevents: a foreign event id is refused before any write");
  await rejects(
    "attendees cannot be written onto another account's event",
    () =>
      upsertEventAttendees(
        ATTACKER,
        event.id,
        [{ fullName: "Planted", email: null, company: null, title: null, linkedinUrl: null, xHandle: null, identityKey: "name:planted" }],
        "paste"
      ),
    (e) => e instanceof EventNotFoundError
  );
  await rejects(
    "companies cannot be written onto another account's event",
    () => upsertEventCompanies(ATTACKER, event.id, [{ name: "Planted Inc", role: "employer", source: "paste" }]),
    (e) => e instanceof EventNotFoundError
  );
  await rejects(
    "enrichment of another account's event stops before any fetch or cover write",
    () =>
      enrichEvent(ATTACKER, event.id, "https://example.com/e", {
        deps: {
          fetch: (async () => {
            throw new Error("fetched a foreign event's page");
          }) as unknown as typeof fetch,
        },
      }),
    (e) => e instanceof EventNotFoundError
  );
  await rejects("a malformed event id is refused without a query", () =>
    assertEventOwnedBy(OWNER, "not-a-uuid")
  );
  await assertEventOwnedBy(OWNER, event.id);
  check("the owner's own event passes", true);

  const [attendeeCount] = rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM event_attendees WHERE event_id = ${event.id}`)
  );
  check("nothing was written against the owner's event", attendeeCount?.n === 0, JSON.stringify(attendeeCount));

  console.log("\nevents: an edit can never re-home a row");
  await updateEventForUser(OWNER, event.id, {
    title: "Renamed",
    ...({ userId: ATTACKER, id: "00000000-0000-0000-0000-000000000000" } as object),
  });
  const after = await db.query.events.findFirst({ where: eq(events.id, event.id) });
  check("the event keeps its owner", after?.userId === OWNER, after?.userId);
  check("the allowed field still changed", after?.title === "Renamed", after?.title);

  console.log("\nopportunities and reminders: a foreign contact id is refused");
  await rejects("an opportunity cannot point at another account's contact", () =>
    insertOpportunities(ATTACKER, [{ contactId: contact!.id, kind: "referral", label: "probe" }])
  );
  await rejects("a reminder cannot point at another account's contact", () =>
    assertReminderContactOwned(ATTACKER, contact!.id)
  );
  await assertReminderContactOwned(OWNER, contact!.id);
  check("the owner's own contact passes", true);

  console.log("\ncalendar feed: a row that already holds a foreign contact id leaks nothing");
  await db.insert(reminders).values({
    userId: ATTACKER,
    title: "Probe",
    contactId: contact!.id,
    dueDate: new Date(Date.now() + 86_400_000),
  });
  const feed = await buildRemindersFeed(ATTACKER);
  check("the feed carries the reminder", feed.includes("Probe"));
  check("but not the other account's contact name", !feed.includes("Secret Person"));

  if (failures) {
    console.error(`\n${failures} cross-tenant check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll cross-tenant reference checks passed.");
});
