/**
 * The roster, and marking people as met on it.
 *
 * These are the properties whose absence is invisible until someone's network is wrong:
 * re-importing must not duplicate rows, a contact logged as met must land on the roster row
 * that is already them rather than a second line, logging twice must change nothing, and
 * every person met must be linked back to their contact.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { previewConnect, restampEventInteractions } from "../src/lib/events/connect";
import {
  createEventForUser,
  recordMetAtEvent,
  linkAttendeesToContacts,
  listRosterForUser,
  upsertEventAttendees,
  unlinkAttendeeForUser,
  updateAttendeeForUser,
  deleteAttendeeForUser,
} from "../src/lib/events/store";
import {
  parseRosterCsv,
  parseRosterText,
  speakersNotOnRoster,
  speakersToAttendees,
} from "../src/lib/events/parse-roster";
import {
  upsertProviderAttendees,
  upsertProviderEvent,
} from "../src/lib/events/provider-writes";
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

async function addContact(fullName: string, email: string | null, linkedinUrl: string | null = null): Promise<string> {
  const db = await getDb();
  return rowsOf<{ id: string }>(
    await db.execute(sql`
      INSERT INTO contacts (user_id, full_name, email, linkedin_url)
      VALUES (${USER}, ${fullName}, ${email}, ${linkedinUrl}) RETURNING id
    `)
  )[0]!.id;
}

async function graceId(): Promise<string> {
  const db = await getDb();
  return rowsOf<{ id: string }>(
    await db.execute(sql`SELECT id FROM contacts WHERE user_id = ${USER} AND email = 'grace@cobol.mil'`)
  )[0]!.id;
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

  // --- logging people as met ("Log who you met" saves through capture, then this) -----------
  {
    // Matched to their rows by email, by exact name, and one person who was never on the list.
    const grace = await graceId();
    const alanId = await addContact("Alan Turing", null);
    const adaId = await addContact("Ada Lovelace", "ada@analytical.io");
    const newId = await addContact("Katherine Johnson", "kj@nasa.gov");
    const linked = await recordMetAtEvent(USER, event.id, [grace, alanId, adaId, newId]);
    check("every person met is linked", linked === 4, String(linked));

    roster = await listRosterForUser(USER, event.id);
    check("a guest already on the list is not added twice", roster.length === 4, `${roster.length} rows`);
    check(
      "the person who was not on the list is added",
      roster.some((r) => r.fullName === "Katherine Johnson" && r.source === "capture")
    );
    check("every row is linked to a contact", roster.every((r) => r.contactId !== null));
    check("every row is marked met", roster.every((r) => r.spokeTo));
    check("each row maps to a DISTINCT contact", new Set(roster.map((r) => r.contactId)).size === 4);
    check("the name-only match landed on Alan", roster.find((r) => r.email === "alan@bletchley.uk")?.contactId === alanId);

    const before = await counts();
    await recordMetAtEvent(USER, event.id, [grace, alanId, adaId, newId]);
    check("logging again adds no rows", (await listRosterForUser(USER, event.id)).length === 4);
    check("and creates no contacts", (await counts()).contacts === before.contacts);

    const stranger = await createEventForUser("someone-else", { title: "Not yours" });
    let refused = false;
    try {
      await recordMetAtEvent(USER, stranger.id, [grace]);
    } catch {
      refused = true;
    }
    check("another user's event is refused", refused);
  }

  // --- editing and deleting a single row --------------------------------------------------------
  {
    const fix = await createEventForUser(USER, { title: "Bad Parse Meetup" });
    await upsertEventAttendees(
      USER,
      fix.id,
      parseRosterText("Ada Lovelace Engineer\nGrace Hopper <grace@cobol.mil>").attendees,
      "paste"
    );
    let rows = await listRosterForUser(USER, fix.id);
    const bad = rows.find((r) => r.fullName?.startsWith("Ada"))!;

    // The correction: a title swallowed into the name. Before this there was no write path
    // that could overwrite a non-null field at all — the COALESCE upsert only fills blanks.
    const fixed = await updateAttendeeForUser(USER, bad.id, {
      fullName: "Ada Lovelace",
      email: "ada@analytical.io",
      company: "Analytical",
      title: "Engineer",
      linkedinUrl: null,
      xHandle: null,
      attendeeRole: null,
    });
    check("a bad row can be corrected", fixed.ok === true, JSON.stringify(fixed));
    rows = await listRosterForUser(USER, fix.id);
    const now = rows.find((r) => r.id === bad.id)!;
    check("the name is actually overwritten", now.fullName === "Ada Lovelace", String(now.fullName));
    check("and the title is split out", now.title === "Engineer", String(now.title));

    // The point of recomputing identity_key: the row keyed `nm:ada lovelace engineer` before
    // the edit. If the key had been left stale, this import would miss the conflict target
    // and insert a SECOND Ada.
    await upsertEventAttendees(
      USER,
      fix.id,
      parseRosterText("Ada Lovelace <ada@analytical.io>").attendees,
      "paste"
    );
    rows = await listRosterForUser(USER, fix.id);
    check(
      "a later import dedupes onto the corrected row",
      rows.filter((r) => r.fullName === "Ada Lovelace").length === 1,
      `${rows.length} rows total`
    );

    // Refusals. Merging is deliberately out of scope, so a collision is reported with the
    // other row named — deleting one is the resolution.
    const collide = await updateAttendeeForUser(USER, bad.id, {
      fullName: "Ada Lovelace",
      email: "grace@cobol.mil",
      company: null,
      title: null,
      linkedinUrl: null,
      xHandle: null,
      attendeeRole: null,
    });
    check("an edit that collides is refused", collide.ok === false && collide.reason === "collision", JSON.stringify(collide));
    check(
      "and names the row it collided with",
      collide.ok === false && collide.reason === "collision" && collide.otherName === "Grace Hopper",
      JSON.stringify(collide)
    );

    const emptied = await updateAttendeeForUser(USER, bad.id, {
      fullName: "   ",
      email: null,
      company: "Analytical",
      title: null,
      linkedinUrl: null,
      xHandle: null,
      attendeeRole: null,
    });
    check("an edit leaving nothing identifying is refused", emptied.ok === false && emptied.reason === "empty", JSON.stringify(emptied));
    rows = await listRosterForUser(USER, fix.id);
    check(
      "and a refused edit changes nothing",
      rows.find((r) => r.id === bad.id)?.fullName === "Ada Lovelace"
    );

    // Deleting a CONNECTED row must not take the contact or the interaction with it.
    await recordMetAtEvent(USER, fix.id, [await graceId()]);
    const before = await counts();
    const connected = (await listRosterForUser(USER, fix.id)).find((r) => r.contactId)!;
    await deleteAttendeeForUser(USER, connected.id);
    const after = await counts();
    const left = await listRosterForUser(USER, fix.id);
    check("the row is gone", !left.some((r) => r.id === connected.id), `${left.length} rows`);
    check("but the contact stays", after.contacts === before.contacts, `${before.contacts} -> ${after.contacts}`);
    check("and so does the interaction", after.interactions === before.interactions, `${before.interactions} -> ${after.interactions}`);
  }

  // --- a resync must not disturb the roster -----------------------------------------------------
  {
    // Refreshing an event re-reads the page and re-seeds its speaker line-up. That runs
    // through the same idempotent upsert as any other source, which is the whole reason a
    // refresh is safe to press twice — but "safe" here has to mean specifically: no second
    // row for the same person, and no unpicking of a connection the user already made.
    const ev = await createEventForUser(USER, { title: "Refresh Me Summit" });
    const lineUp = speakersToAttendees([
      { name: "Ada Lovelace", url: "https://www.linkedin.com/in/ada-refresh" },
      { name: "Grace Hopper", url: null },
    ]);
    await upsertEventAttendees(USER, ev.id, lineUp, "page");

    await recordMetAtEvent(USER, ev.id, [await addContact("Ada Lovelace", null, "https://www.linkedin.com/in/ada-refresh")]);
    const linkedBefore = (await listRosterForUser(USER, ev.id)).find((r) => r.fullName === "Ada Lovelace")!;
    const before = await counts();

    // The refresh: the same page, read again.
    await upsertEventAttendees(USER, ev.id, lineUp, "page");

    const after = await listRosterForUser(USER, ev.id);
    const linkedAfter = after.find((r) => r.fullName === "Ada Lovelace")!;
    check("a refresh adds no duplicate rows", after.length === 2, String(after.length));
    check("the connected person keeps their contact", linkedAfter.contactId === linkedBefore.contactId);
    check("and stays marked spoken-to", linkedAfter.spokeTo === true);
    const now = await counts();
    check("no contact is created by refreshing", now.contacts === before.contacts, `${before.contacts} -> ${now.contacts}`);
    check("and no interaction either", now.interactions === before.interactions, `${before.interactions} -> ${now.interactions}`);

    // THE regression. Correcting a speaker's row moves its identity key off `nm:` — which is
    // correct and necessary — and the page's name-only key then stops matching it. Before the
    // name filter, refreshing manufactured a second Grace on every single press.
    const grace = (await listRosterForUser(USER, ev.id)).find((r) => r.fullName === "Grace Hopper")!;
    await updateAttendeeForUser(USER, grace.id, {
      fullName: "Grace Hopper",
      email: "grace@navy.mil",
      company: null,
      title: null,
      linkedinUrl: null,
      xHandle: null,
      attendeeRole: "speaker",
    });
    const enriched = speakersNotOnRoster(
      lineUp,
      (await listRosterForUser(USER, ev.id)).map((r) => r.fullName)
    );
    check("an edited speaker is not re-seeded by a refresh", enriched.length === 0, `${enriched.length} would be inserted`);
    await upsertEventAttendees(USER, ev.id, enriched, "page");
    check(
      "so the roster does not grow",
      (await listRosterForUser(USER, ev.id)).length === 2,
      String((await listRosterForUser(USER, ev.id)).length)
    );
    check(
      "and the correction survives",
      (await listRosterForUser(USER, ev.id)).find((r) => r.fullName === "Grace Hopper")?.email === "grace@navy.mil"
    );

    // A newly announced speaker IS added — the line-up is additive, never a replacement.
    const announced = speakersNotOnRoster(
      speakersToAttendees([{ name: "Katherine Johnson", url: null }]),
      (await listRosterForUser(USER, ev.id)).map((r) => r.fullName)
    );
    await upsertEventAttendees(USER, ev.id, announced, "page");
    check("a newly announced speaker is still added", (await listRosterForUser(USER, ev.id)).length === 3);
  }

  // --- event edits flow through to interactions already written ---------------------------------
  {
    const ev = await createEventForUser(USER, {
      title: "Restamp Summit",
      startsAt: new Date("2026-05-01T18:00:00.000Z"),
      venue: "Old Hall",
      city: "Boston",
    });
    await upsertEventAttendees(
      USER,
      ev.id,
      parseRosterText("Katherine Johnson <kj@nasa.gov>\nMargaret Hamilton <mh@mit.edu>").attendees,
      "paste"
    );
    // The interactions the retired roster Connect wrote (`evt:` ids, a derived note). Nothing
    // writes these any more, but existing ones are still kept in step when the event changes.
    const db = await getDb();
    for (const [name, email] of [
      ["Katherine Johnson", "kj@nasa.gov"],
      ["Margaret Hamilton", "mh@mit.edu"],
    ] as const) {
      const contactId = await addContact(name, email);
      await db.execute(sql`
        INSERT INTO interactions (user_id, contact_id, interaction_type, interaction_date, raw_notes, ai_summary, external_id)
        VALUES (${USER}, ${contactId}, 'event', ${ev.startsAt}, 'Met at Restamp Summit (Old Hall, Boston).',
                'Restamp Summit', ${`${eventExternalIdBase(ev.id)}:${contactId}`})
      `);
    }
    const noteOf = async (email: string) =>
      rowsOf<{ raw_notes: string | null; ai_summary: string | null; interaction_date: Date }>(
        await db.execute(sql`
          SELECT i.raw_notes, i.ai_summary, i.interaction_date
          FROM interactions i JOIN contacts c ON c.id = i.contact_id
          WHERE i.user_id = ${USER} AND c.email = ${email}
        `)
      )[0]!;

    check("the note is derived from the event", (await noteOf("kj@nasa.gov")).raw_notes === "Met at Restamp Summit (Old Hall, Boston).", String((await noteOf("kj@nasa.gov")).raw_notes));

    // One person's note is edited by hand, the way it would be from a contact's timeline.
    await db.execute(sql`
      UPDATE interactions SET raw_notes = 'We talked about Apollo guidance software.'
      WHERE user_id = ${USER}
        AND contact_id = (SELECT id FROM contacts WHERE user_id = ${USER} AND email = 'mh@mit.edu')
    `);

    const moved = { ...ev, venue: "New Hall", startsAt: new Date("2026-05-02T18:00:00.000Z") };
    const touched = await restampEventInteractions(USER, ev, moved);
    check("the restamp reports what it changed", touched === 2, String(touched));

    const kj = await noteOf("kj@nasa.gov");
    check("an untouched note is refreshed", kj.raw_notes === "Met at Restamp Summit (New Hall, Boston).", String(kj.raw_notes));
    check(
      "and its date follows the event",
      new Date(kj.interaction_date).toISOString() === "2026-05-02T18:00:00.000Z",
      String(kj.interaction_date)
    );

    const mh = await noteOf("mh@mit.edu");
    // The load-bearing one: staleness is a smaller harm than destroying what someone wrote.
    check(
      "a hand-edited note is left alone",
      mh.raw_notes === "We talked about Apollo guidance software.",
      String(mh.raw_notes)
    );
    check(
      "while its untouched date is still refreshed",
      new Date(mh.interaction_date).toISOString() === "2026-05-02T18:00:00.000Z",
      String(mh.interaction_date)
    );

    check("an unchanged event restamps nothing", (await restampEventInteractions(USER, moved, moved)) === 0);
  }

  // --- attendee_role survives the write path ---------------------------------------------------
  {
    // This column existed from day one, was computed by both connectors, and was dropped on
    // the way to the database by `upsertEventAttendees` and again by `upsertProviderAttendees`
    // — so it was NULL on every row ever written. The check is that it now round-trips.
    const talk = await createEventForUser(USER, { title: "Speakers Night" });
    const speakers = speakersToAttendees([
      { name: "Ada Lovelace", url: "https://www.linkedin.com/in/ada-speaker" },
      { name: "Grace Hopper", url: null },
    ]);
    await upsertEventAttendees(USER, talk.id, speakers, "page");
    const seeded = await listRosterForUser(USER, talk.id);
    check("speakers land on the roster", seeded.length === 2, String(seeded.length));
    check("with their role stored", seeded.every((r) => r.attendeeRole === "speaker"));
    check("and are attributed to the page", seeded.every((r) => r.source === "page"));
    // The rule #140 set and this change did NOT relax: reading a page creates no contacts.
    check("and nobody was connected by reading a page", seeded.every((r) => r.contactId === null));
    check("nor marked as spoken to", seeded.every((r) => r.spokeTo === false));

    // What happens when the user later pastes the real list, and why.
    //
    // A speaker known only by name keys on `nm:grace hopper`; the same human pasted WITH an
    // email keys on `em:grace@navy.mil`. Different keys, so two rows — and that is correct,
    // not a gap. Collapsing them would mean merging on a bare full name, which is precisely
    // what the next block refuses and what `DUPLICATE_MERGE_CONFIDENCE` exists to prevent:
    // two different Grace Hoppers would be welded into one person.
    //
    // The cost is a visible duplicate the user can delete. The alternative cost is a silent,
    // unrecoverable merge of two humans. This asserts we keep paying the cheaper one.
    await upsertEventAttendees(
      USER,
      talk.id,
      parseRosterText("Grace Hopper <grace@navy.mil> — Rear Admiral at USN").attendees,
      "paste"
    );
    const merged = await listRosterForUser(USER, talk.id);
    check("a name-only speaker and an emailed paste stay separate rows", merged.length === 3, String(merged.length));
    const byName = merged.filter((r) => r.fullName === "Grace Hopper");
    check("both Grace rows are present", byName.length === 2, String(byName.length));
    check("the speaker row keeps its role", byName.some((r) => r.attendeeRole === "speaker"));
    check("and the pasted row carries the email", byName.some((r) => r.email === "grace@navy.mil"));

    // The identity tiers DO collapse when the signal is strong enough: same LinkedIn URL,
    // one row, whichever source arrived first.
    await upsertEventAttendees(
      USER,
      talk.id,
      parseRosterText("Ada Lovelace https://www.linkedin.com/in/ada-speaker").attendees,
      "paste"
    );
    const afterAda = await listRosterForUser(USER, talk.id);
    check("a matching LinkedIn URL collapses onto the speaker row", afterAda.length === 3, String(afterAda.length));
    check(
      "and that row is still marked a speaker",
      afterAda.find((r) => r.fullName === "Ada Lovelace")?.attendeeRole === "speaker"
    );
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
    // Snapshotted immediately before the unlink rather than reusing an earlier count: the
    // property is "unlinking changes nothing", and a distant baseline makes this assertion
    // fail for any unrelated block added in between rather than for the thing it tests.
    const beforeUnlink = await counts();
    await unlinkAttendeeForUser(USER, target.id);
    const now = await counts();
    const refreshed = (await listRosterForUser(USER, event.id)).find((r) => r.id === target.id)!;
    check("unlinking clears the attendee's contact", refreshed.contactId === null);
    check("unlinking clears spoke-to", refreshed.spokeTo === false);
    check("unlinking does NOT delete the contact", now.contacts === beforeUnlink.contacts, `${beforeUnlink.contacts} -> ${now.contacts}`);
    // Restore so the cascade check below is meaningful.
    await linkAttendeesToContacts(USER, [
      { attendeeId: target.id, contactId: target.contactId! },
    ]);
  }

  // --- what a provider sync writes that nothing used to store -----------------------------------
  {
    const db = await getDb();
    // A provider event that reached the table some other way first — which is what discovery
    // will do routinely: the user's calendar shows the event long before the host API is
    // connected. The row therefore starts as `attended`.
    const seeded = await createEventForUser(USER, {
      title: "Provider Promotion Summit",
      role: "attended",
      provider: "luma",
      providerEventId: "evt-promote",
      source: "manual",
    });
    const promotedId = await upsertProviderEvent(USER, "luma", {
      providerEventId: "evt-promote",
      title: "Provider Promotion Summit",
      startsAt: new Date("2026-06-01T17:00:00.000Z"),
      endsAt: null,
      timezone: "America/Los_Angeles",
      venue: null,
      city: null,
      url: "https://lu.ma/promote",
      description: null,
      coverImageUrl: null,
      attendeeCount: 3,
    });
    check("the provider event upserts onto the existing row", promotedId === seeded.id);
    const role = rowsOf<{ role: string }>(
      await db.execute(sql`SELECT role FROM events WHERE id = ${promotedId}`)
    )[0]?.role;
    // Only a host-scoped credential can list an event at all, so the API listing it IS the
    // evidence the user hosts it. Without the promotion the UI goes on asking for a pasted
    // guest list for an event it is already syncing.
    check("and is promoted to hosted", role === "hosted", String(role));

    await upsertProviderAttendees(
      USER,
      promotedId,
      [
        {
          externalRef: "guest-1",
          fullName: "Ada Lovelace",
          email: "ada@analytical.io",
          company: null,
          title: null,
          linkedinUrl: null,
          xHandle: null,
          phone: "+15550101",
          attendeeRole: "attendee",
        },
      ],
      "luma"
    );
    const stored = rowsOf<{ external_ref: string | null; phone: string | null }>(
      await db.execute(sql`
        SELECT external_ref, phone FROM event_attendees WHERE event_id = ${promotedId}
      `)
    )[0]!;
    // Both columns existed from day one and nothing ever wrote them: the connectors computed
    // an external ref and it was dropped between the mapper and the insert.
    check("the provider's guest id is stored", stored.external_ref === "guest-1", String(stored.external_ref));

    // The next sync reads Ada's registration answers and now knows her LinkedIn. Her row was
    // keyed on her email; it must be filled in, not joined by a second Ada.
    await upsertProviderAttendees(
      USER,
      promotedId,
      [
        {
          externalRef: "guest-1",
          fullName: "Ada Lovelace",
          email: "ada@analytical.io",
          company: "Analytical Engines",
          title: null,
          linkedinUrl: "https://www.linkedin.com/in/ada",
          xHandle: null,
          phone: "+15550101",
          attendeeRole: "attendee",
        },
      ],
      "luma"
    );
    const adas = rowsOf<{ linkedin_url: string | null; company: string | null }>(
      await db.execute(sql`
        SELECT linkedin_url, company FROM event_attendees
         WHERE event_id = ${promotedId} AND full_name = 'Ada Lovelace'
      `)
    );
    check(
      "a Luma guest who gains a LinkedIn answer stays one row, filled in",
      adas.length === 1 && adas[0]?.linkedin_url === "https://www.linkedin.com/in/ada" && adas[0]?.company === "Analytical Engines",
      JSON.stringify(adas)
    );
    check("and so is the phone number", stored.phone === "+15550101", String(stored.phone));

    // Fill-blanks, like every other column: a later paste cannot erase the provider's id.
    await upsertEventAttendees(
      USER,
      promotedId,
      parseRosterText("Ada Lovelace <ada@analytical.io>").attendees,
      "paste"
    );
    const after = rowsOf<{ external_ref: string | null }>(
      await db.execute(sql`
        SELECT external_ref FROM event_attendees WHERE event_id = ${promotedId}
      `)
    )[0]!;
    check("and a later paste does not blank it", after.external_ref === "guest-1", String(after.external_ref));
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
  console.log("\nCSV headers as exports write them");
  {
    // Luma's guest export uses snake_case; Excel leaves a byte-order mark on the first header.
    const luma = parseRosterCsv(
      "\uFEFFfirst_name,last_name,email,phone_number,approval_status\nAna,Founder,ana@acme.io,+15550001,approved\n"
    );
    const ana = luma.attendees[0];
    check(
      "snake_case and a BOM still match (Luma export)",
      ana?.fullName === "Ana Founder" && ana.email === "ana@acme.io" && ana.phone === "+15550001",
      JSON.stringify(ana)
    );
    const eb = parseRosterCsv("First Name,Last Name,Email,Company,Job Title\nKim,Lee,kim@x.io,Acme,CTO\n");
    const kim = eb.attendees[0];
    check(
      "Title Case headers still match (Eventbrite export)",
      kim?.fullName === "Kim Lee" && kim.company === "Acme" && kim.title === "CTO",
      JSON.stringify(kim)
    );
    const spaced = parseRosterCsv("  Full   Name ,E-mail\nRo Sun,ro@x.io\n");
    check("doubled spaces and padding still match", spaced.attendees[0]?.fullName === "Ro Sun" && spaced.attendees[0]?.email === "ro@x.io");
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll event roster checks passed.");
});
