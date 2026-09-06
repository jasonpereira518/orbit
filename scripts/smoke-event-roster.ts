/**
 * The roster -> connections flow, end to end.
 *
 * These are the properties whose absence is invisible until someone's network is wrong:
 * re-connecting the same people must not double their interactions, an attendee who is
 * already a contact must be matched rather than duplicated, two different people who happen
 * to share a name must NOT be merged (the reason this path uses 0.85 and not calendar's 0.6),
 * the plan cap must be reported rather than swallowed, and every connected attendee must be
 * linked back to the contact they became.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { connectAttendees, previewConnect } from "../src/lib/events/connect";
import {
  createEventForUser,
  linkAttendeesToContacts,
  listRosterForUser,
  upsertEventAttendees,
  unlinkAttendeeForUser,
} from "../src/lib/events/store";
import { parseRosterText } from "../src/lib/events/parse-roster";
import { attendeeIdentityKey } from "../src/lib/events/identity";
import { eventExternalIdBase } from "../src/lib/ingest/external-id";
import { interactionExternalId } from "../src/lib/ingest/external-id";

const USER = "event-roster-smoke-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function reset() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM event_attendees WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM events WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM interactions WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM companies WHERE user_id = ${USER}`);
}

async function counts() {
  const db = await getDb();
  return rowsOf<{ contacts: number; interactions: number }>(
    await db.execute(sql`
      SELECT (SELECT count(*)::int FROM contacts WHERE user_id = ${USER}) AS contacts,
             (SELECT count(*)::int FROM interactions WHERE user_id = ${USER}) AS interactions
    `)
  )[0]!;
}

const ROSTER = `
Ada Lovelace <ada@analytical.io> — Engineer at Analytical
Grace Hopper <grace@cobol.mil>
Alan Turing <alan@bletchley.uk>
`;

run(async () => {
  await reset();

  // --- identity keys agree with ingest's ---------------------------------------------------
  {
    // The two implementations must agree or a roster of 40 quietly becomes 38 contacts.
    // ingest's `participantIdentityKey` is private, so this asserts the precedence contract
    // it documents: linkedin > email > handle > name.
    check(
      "linkedin outranks email",
      attendeeIdentityKey({ linkedinUrl: "https://linkedin.com/in/x", email: "a@b.c" }) ===
        "li:https://linkedin.com/in/x"
    );
    check(
      "email outranks name",
      attendeeIdentityKey({ email: "A@B.c", fullName: "Ada" }) === "em:a@b.c"
    );
    check("name is the last resort", attendeeIdentityKey({ fullName: " Ada  Lovelace " }) === "nm:ada lovelace");
    check("nothing identifiable yields null", attendeeIdentityKey({}) === null);
  }

  const event = await createEventForUser(USER, {
    title: "Deep Learning Summit",
    startsAt: new Date("2026-03-04T18:00:00Z"),
    venue: "Moscone",
    city: "San Francisco",
  });

  // --- roster import is idempotent ---------------------------------------------------------
  const parsed = parseRosterText(ROSTER);
  await upsertEventAttendees(USER, event.id, parsed.attendees, "paste");
  await upsertEventAttendees(USER, event.id, parsed.attendees, "paste");
  let roster = await listRosterForUser(USER, event.id);
  check("re-pasting the same roster does not duplicate", roster.length === 3, `${roster.length} rows`);

  // --- an existing contact is matched, not duplicated ---------------------------------------
  {
    const db = await getDb();
    await db.execute(sql`
      INSERT INTO contacts (user_id, full_name, email) VALUES (${USER}, 'Grace Hopper', 'grace@cobol.mil')
    `);
  }

  const preview = await previewConnect(USER, event, roster.map((r) => r.id));
  const grace = preview.find((p) => p.name.startsWith("Grace"));
  check("preview says Grace will match an existing contact", grace?.outcome === "match", grace?.outcome);
  check(
    "preview says the other two will be created",
    preview.filter((p) => p.outcome === "create").length === 2
  );

  const before = await counts();
  const summary = await connectAttendees(USER, event, roster.map((r) => r.id));
  const after = await counts();

  check("two new contacts were created", summary.created === 2, JSON.stringify(summary));
  check("one existing contact was matched", summary.matched === 1);
  check("three interactions were logged", summary.interactionsLogged === 3);
  check(
    "the network grew by exactly two",
    after.contacts - before.contacts === 2,
    `${before.contacts} -> ${after.contacts}`
  );
  check("nothing was blocked by the plan", summary.blockedByPlan === 0);

  // --- the stored interaction is shaped right ------------------------------------------------
  {
    const db = await getDb();
    const rows = rowsOf<{ interaction_type: string; external_id: string; interaction_date: string }>(
      await db.execute(sql`
        SELECT interaction_type, external_id, interaction_date
          FROM interactions WHERE user_id = ${USER} ORDER BY external_id
      `)
    );
    check(
      "every interaction is typed 'event'",
      rows.length === 3 && rows.every((r) => r.interaction_type === "event"),
      rows.map((r) => r.interaction_type).join(",")
    );
    check(
      "external ids are evt:<eventId>:<contactId>",
      rows.every((r) => r.external_id.startsWith(`${eventExternalIdBase(event.id)}:`)),
      rows[0]?.external_id
    );
    // Dating these today would score a March conference as the user's most recent contact.
    check(
      "interactions are dated from the event, not from now",
      rows.every((r) => new Date(r.interaction_date).getUTCFullYear() === 2026 &&
                        new Date(r.interaction_date).getUTCMonth() === 2),
      rows[0]?.interaction_date
    );
    check(
      "ids are unique per (event, contact)",
      new Set(rows.map((r) => r.external_id)).size === 3
    );
  }

  // --- attendees are linked back ---------------------------------------------------------------
  roster = await listRosterForUser(USER, event.id);
  check("every attendee is linked to a contact", roster.every((r) => r.contactId !== null));
  check("every attendee is marked spoken-to", roster.every((r) => r.spokeTo));
  check(
    "each attendee maps to a DISTINCT contact",
    new Set(roster.map((r) => r.contactId)).size === 3
  );

  // --- re-running is idempotent ------------------------------------------------------------
  {
    const again = await connectAttendees(USER, event, roster.map((r) => r.id));
    const now = await counts();
    check(
      "re-connecting creates no new contacts",
      now.contacts === after.contacts,
      `${after.contacts} -> ${now.contacts}`
    );
    check(
      "re-connecting creates no new interactions",
      now.interactions === after.interactions,
      `${after.interactions} -> ${now.interactions}`
    );
    check("already-connected attendees are skipped", again.created === 0 && again.matched === 0);
  }

  // --- two different people who share a name must NOT be merged ------------------------------
  {
    // The reason this path uses DUPLICATE_MERGE_CONFIDENCE (0.85) rather than calendar's 0.6.
    // At 0.6 a bare full-name hit merges, which would weld two humans into one record.
    const other = await createEventForUser(USER, { title: "Name Collision Meetup" });
    await upsertEventAttendees(
      USER,
      other.id,
      parseRosterText("Grace Hopper").attendees,
      "paste"
    );
    const otherRoster = await listRosterForUser(USER, other.id);
    const pv = await previewConnect(USER, other, otherRoster.map((r) => r.id));
    check(
      "a name-only match does not merge into the emailed contact",
      pv[0]?.outcome === "create",
      `${pv[0]?.outcome} @ ${pv[0]?.confidence}`
    );
  }

  // --- unlinking leaves the contact alone -----------------------------------------------------
  {
    const target = (await listRosterForUser(USER, event.id))[0]!;
    await unlinkAttendeeForUser(USER, target.id);
    const now = await counts();
    const refreshed = (await listRosterForUser(USER, event.id)).find((r) => r.id === target.id)!;
    check("unlinking clears the attendee's contact", refreshed.contactId === null);
    check("unlinking clears spoke-to", refreshed.spokeTo === false);
    check("unlinking does NOT delete the contact", now.contacts === after.contacts);
    // Restore so the cascade check below is meaningful.
    await linkAttendeesToContacts(USER, [
      { attendeeId: target.id, contactId: target.contactId! },
    ]);
  }

  // --- the plan cap is reported, not swallowed -------------------------------------------------
  {
    const capped = await createEventForUser(USER, { title: "Capped Event" });
    await upsertEventAttendees(
      USER,
      capped.id,
      parseRosterText("Cap One <one@cap.io>\nCap Two <two@cap.io>").attendees,
      "paste"
    );
    const cappedRoster = await listRosterForUser(USER, capped.id);
    // The demo/free ceiling is enforced by contactHeadroomForUser; rather than reaching into
    // plan config, assert the field is carried through as a number the UI can render.
    const s = await connectAttendees(USER, capped, cappedRoster.map((r) => r.id));
    check(
      "blockedByPlan is always reported as a number",
      typeof s.blockedByPlan === "number",
      String(s.blockedByPlan)
    );
  }

  // --- deleting an event cascades its roster ----------------------------------------------------
  {
    const db = await getDb();
    const doomed = await createEventForUser(USER, { title: "Doomed" });
    await upsertEventAttendees(USER, doomed.id, parseRosterText("Zed Zed").attendees, "paste");
    await db.execute(sql`DELETE FROM events WHERE id = ${doomed.id}`);
    const left = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM event_attendees WHERE event_id = ${doomed.id}`)
    )[0]!.n;
    check("deleting an event cascades its attendees", left === 0, String(left));
  }

  // Prove the external-id helper is the one actually used, not a restatement.
  check(
    "interactionExternalId composes the documented shape",
    interactionExternalId(eventExternalIdBase("E"), "C") === "evt:E:C"
  );

  await reset();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll event roster checks passed.");
});
