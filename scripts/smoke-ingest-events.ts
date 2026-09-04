/**
 * The ingest spine's contract, which every connector inherits.
 *
 * The properties pinned here are the ones whose absence is invisible until production:
 * re-syncing must not duplicate (the whole point of the external-id key), two attendees of
 * one meeting resolving to the same contact must not abort the batch, the plan's contact cap
 * must hold on a streamed source as well as a staged one, and an interaction window must
 * widen without ever narrowing.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import {
  finalizeIngest,
  ingestEvents,
  openIngestContext,
  type NetworkEvent,
} from "../src/lib/ingest/events";
import { calendarExternalIdBase } from "../src/lib/ingest/external-id";

const USER = "ingest-smoke-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function reset() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM interactions WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM companies WHERE user_id = ${USER}`);
}

async function counts() {
  const db = await getDb();
  const row = rowsOf<{ contacts: number; interactions: number }>(
    await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM contacts WHERE user_id = ${USER}) AS contacts,
        (SELECT count(*)::int FROM interactions WHERE user_id = ${USER}) AS interactions
    `)
  )[0];
  return { contacts: Number(row.contacts), interactions: Number(row.interactions) };
}

function meeting(uid: string, at: Date, participants: NetworkEvent["participants"]): NetworkEvent {
  return {
    externalIdBase: calendarExternalIdBase(uid),
    type: "meeting",
    timestamp: at,
    participants,
    summary: `Meeting ${uid}`,
    notes: `Notes for ${uid}`,
  };
}

const CALENDAR_OPTS = {
  source: "google_calendar",
  createsContacts: true,
  matchConfidence: 0.6,
};

run(async () => {
  const db = await getDb();
  const day1 = new Date("2026-03-10T15:00:00Z");
  const day0 = new Date("2026-01-05T15:00:00Z");
  const day2 = new Date("2026-06-01T15:00:00Z");

  // --- Creating from an event, then re-ingesting it ---------------------------------------
  await reset();
  {
    const ctx = await openIngestContext(USER, CALENDAR_OPTS);
    const first = await ingestEvents(ctx, [
      meeting("evt-1", day1, [{ name: "Ada Lovelace", email: "ada@example.com" }]),
    ]);
    check("an unmatched participant becomes a contact", first.contactsCreated === 1);
    check("the event is logged as an interaction", first.interactionsLogged === 1);
    await finalizeIngest(ctx);
  }
  const afterFirst = await counts();

  {
    // A second sync of the same calendar — the single most important case.
    const ctx = await openIngestContext(USER, CALENDAR_OPTS);
    const again = await ingestEvents(ctx, [
      meeting("evt-1", day1, [{ name: "Ada Lovelace", email: "ada@example.com" }]),
    ]);
    check("re-ingesting matches instead of creating", again.contactsCreated === 0);
  }
  const afterSecond = await counts();
  check(
    "re-ingesting creates no second contact",
    afterSecond.contacts === afterFirst.contacts,
    `${afterFirst.contacts} -> ${afterSecond.contacts}`
  );
  check(
    "re-ingesting creates no second interaction",
    afterSecond.interactions === afterFirst.interactions,
    `${afterFirst.interactions} -> ${afterSecond.interactions}`
  );

  // --- Two attendees of one event that resolve to the SAME contact --------------------------
  // The case that raises "ON CONFLICT DO UPDATE command cannot affect row a second time" if
  // the intra-batch dedupe is missing. One entry is email-only and one name-only, so they
  // survive participantIdentityKey but both match Ada through the duplicate index.
  {
    const ctx = await openIngestContext(USER, CALENDAR_OPTS);
    let threw: string | null = null;
    try {
      await ingestEvents(ctx, [
        meeting("evt-collide", day1, [
          { email: "ada@example.com" },
          { name: "Ada Lovelace" },
        ]),
      ]);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    check("two attendees resolving to one contact does not abort the batch", threw === null, threw ?? "");
  }
  const afterCollide = await counts();
  check(
    "the colliding event logs exactly one interaction",
    afterCollide.interactions === afterFirst.interactions + 1,
    `${afterCollide.interactions}`
  );

  // --- Interaction windows widen, never narrow ----------------------------------------------
  {
    const ctx = await openIngestContext(USER, CALENDAR_OPTS);
    await ingestEvents(ctx, [
      meeting("evt-late", day2, [{ email: "ada@example.com" }]),
      meeting("evt-early", day0, [{ email: "ada@example.com" }]),
    ]);
  }
  const window = rowsOf<{ first_interaction_at: string | Date; last_interaction_at: string | Date }>(
    await db.execute(sql`
      SELECT first_interaction_at, last_interaction_at
      FROM contacts WHERE user_id = ${USER} AND email = 'ada@example.com'
    `)
  )[0];
  const firstAt = new Date(window.first_interaction_at as string).getTime();
  const lastAt = new Date(window.last_interaction_at as string).getTime();
  check(
    "an older event widens first_interaction_at backwards",
    firstAt <= day0.getTime(),
    new Date(firstAt).toISOString()
  );
  check(
    "a newer event widens last_interaction_at forwards",
    lastAt >= day2.getTime(),
    new Date(lastAt).toISOString()
  );

  // --- A newly created contact is dated by its events, not by "now" ---------------------------
  // `contacts.last_interaction_at` is read directly by the closeness cohort, so a person first
  // seen in an old meeting must not be scored as if they were met today.
  await reset();
  {
    const ctx = await openIngestContext(USER, CALENDAR_OPTS);
    await ingestEvents(ctx, [
      meeting("evt-old-a", day0, [{ name: "Ada Lovelace", email: "ada@example.com" }]),
      meeting("evt-old-b", day1, [{ name: "Ada Lovelace", email: "ada@example.com" }]),
    ]);
  }
  const dated = rowsOf<{ first_interaction_at: string | Date; last_interaction_at: string | Date }>(
    await db.execute(sql`
      SELECT first_interaction_at, last_interaction_at
      FROM contacts WHERE user_id = ${USER} AND email = 'ada@example.com'
    `)
  )[0];
  const createdFirst = new Date(dated.first_interaction_at as string).getTime();
  const createdLast = new Date(dated.last_interaction_at as string).getTime();
  check(
    "a created contact's last_interaction_at is the newest event, not now",
    createdLast === day1.getTime(),
    new Date(createdLast).toISOString()
  );
  check(
    "a created contact's first_interaction_at is the oldest event",
    createdFirst === day0.getTime(),
    new Date(createdFirst).toISOString()
  );
  check("one person across two events is created once", (await counts()).contacts === 1);
  check("each event still logs its own interaction", (await counts()).interactions === 2);

  // --- An annotate-only source never creates -------------------------------------------------
  await reset();
  {
    const ctx = await openIngestContext(USER, {
      source: "calendar_ics",
      createsContacts: false,
      matchConfidence: 0.6,
    });
    const stats = await ingestEvents(ctx, [
      meeting("evt-anno", day1, [{ name: "Grace Hopper", email: "grace@example.com" }]),
    ]);
    check("createsContacts:false creates nobody", stats.contactsCreated === 0);
    check("the unmatched participant is counted, not silently dropped", stats.unmatched === 1);
    check("no interaction is logged for an unresolved person", stats.interactionsLogged === 0);
  }
  check("an annotate-only source leaves the network empty", (await counts()).contacts === 0);

  // --- The plan's contact cap holds on a streamed source --------------------------------------
  await reset();
  {
    const ctx = await openIngestContext(USER, CALENDAR_OPTS);
    // Exhaust the allowance the way a nearly-full free account would be.
    ctx.headroom = 1;
    const stats = await ingestEvents(ctx, [
      meeting("evt-cap-a", day1, [{ name: "Alan Turing", email: "alan@example.com" }]),
      meeting("evt-cap-b", day1, [{ name: "Katherine Johnson", email: "kj@example.com" }]),
    ]);
    check("the cap stops creation at the headroom", stats.contactsCreated === 1, String(stats.contactsCreated));
    check("the blocked participant is reported", stats.blockedByPlan >= 1, String(stats.blockedByPlan));
  }
  check("only the allowed contact was written", (await counts()).contacts === 1);

  // --- A participant with no usable identity is skipped, not crashed on -------------------------
  await reset();
  {
    const ctx = await openIngestContext(USER, CALENDAR_OPTS);
    const stats = await ingestEvents(ctx, [meeting("evt-empty", day1, [{}, { name: "  " }])]);
    check("an identity-less participant is skipped", stats.contactsCreated === 0 && stats.interactionsLogged === 0);
  }

  await reset();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll ingest-spine checks passed.");
});
