/**
 * What discovery actually writes: create, attach, suppress, and the contact cap.
 *
 * `pglite` tier, because every property here is about rows and indexes rather than parsing.
 *
 * The load-bearing assertions, in order of how bad their absence would be:
 *
 *   1. **No contacts.** A discovery pass reads a user's calendar. If it created contacts, one
 *      term of lecture invites would consume a free user's entire allowance overnight, filled
 *      with people they have never met. Asserted after every single write below.
 *   2. **Dismissal sticks.** "Not mine" is the bargain that makes auto-adding acceptable at
 *      all, and a sync that re-adds a dismissed event every fifteen minutes is worse than no
 *      discovery at all.
 *   3. **One event, not four.** The same party arrives as a calendar invite, a feed entry and
 *      an email, each knowing a different key for it.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { recordDiscoveryCandidates } from "../src/lib/events/discovery/record";
import {
  dismissEventForUser,
  listTombstones,
  restoreEventForUser,
  tombstoneAliasesForEvent,
} from "../src/lib/events/discovery/aliases";
import {
  createEventForUser,
  listEventsForUser,
  listRosterForUser,
  updateAttendeeForUser,
  upsertEventAttendees,
} from "../src/lib/events/store";
import { parseRosterText } from "../src/lib/events/parse-roster";
import {
  backfillPersonKeys,
  eventsTogetherForRoster,
  listRepeatCoAttendees,
} from "../src/lib/events/people-store";
import {
  claimDueEnrichments,
  markEnrichResult,
  requeueUnreadEvents,
} from "../src/lib/events/enrich-queue";
import { IcsFeedGoneError, syncIcsFeed } from "../src/lib/events/discovery/from-ics-feed";
import { scanGmailForEvents } from "../src/lib/events/discovery/from-gmail";
import type { DiscoveryCandidate } from "../src/lib/events/discovery/types";

const USER = "event-discovery-smoke-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function candidate(over: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return {
    source: "gcal",
    sourceRef: "gcal:uid-1",
    url: "https://lu.ma/ai-tinkerers",
    platform: "luma",
    providerEventId: null,
    title: "AI Tinkerers SF",
    startsAt: new Date("2026-06-01T18:00:00.000Z"),
    endsAt: null,
    timezone: null,
    location: "Shack15",
    roleHint: null,
    rsvpHint: null,
    attendees: [],
    evidence: { calendarSummary: "AI Tinkerers SF" },
    ...over,
  };
}

async function reset() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM event_aliases WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM event_attendees WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM events WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
}

async function contactCount() {
  const db = await getDb();
  return rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM contacts WHERE user_id = ${USER}`)
  )[0]!.n;
}

async function eventCount() {
  const db = await getDb();
  return rowsOf<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM events WHERE user_id = ${USER}`)
  )[0]!.n;
}

run(async () => {
  await reset();

  console.log("\nthe first report creates the event");
  {
    const stats = await recordDiscoveryCandidates(USER, [candidate()]);
    check("one event created", stats.created === 1, JSON.stringify(stats));
    check("and queued for a page read", stats.enrichQueued === 1);
    const [event] = await listEventsForUser(USER);
    check("the badge says where it came from", event?.discoveredVia === "gcal", String(event?.discoveredVia));
    check("the title is carried", event?.title === "AI Tinkerers SF");
    // A calendar invite cannot tell us who is running the event.
    check("the role is attended, and marked as a guess", event?.role === "attended");
    const roleSource = rowsOf<{ role_source: string | null }>(
      await db().execute(sql`SELECT role_source FROM events WHERE id = ${event!.id}`)
    )[0]?.role_source;
    check("...explicitly", roleSource === "inferred", String(roleSource));
    check("and nobody became a contact", (await contactCount()) === 0);
  }

  console.log("\nthe same event from three sources is still one event");
  {
    // Each source knows a different key: the calendar its UID, the feed the provider id, the
    // email its own message id. Only the URL is shared, and not even in the same spelling.
    const stats = await recordDiscoveryCandidates(USER, [
      candidate({ source: "luma_ics", sourceRef: "ics:evt-6mLuOvNx", url: "https://luma.com/ai-tinkerers", providerEventId: "evt-6mLuOvNx" }),
      candidate({ source: "gmail", sourceRef: "gmail:msg-1", url: "https://lu.ma/ai-tinkerers?tk=TOKEN" }),
    ]);
    check("both attach to the existing row", stats.attached === 1 && stats.created === 0, JSON.stringify(stats));
    check("there is still exactly one event", (await eventCount()) === 1, String(await eventCount()));
    const aliases = rowsOf<{ n: number }>(
      await db().execute(sql`SELECT count(*)::int AS n FROM event_aliases WHERE user_id = ${USER}`)
    )[0]!.n;
    // url + provider + three source refs.
    check("every source's key is recorded", aliases >= 5, String(aliases));
    check("still no contacts", (await contactCount()) === 0);
  }

  console.log("\nattach fills blanks without overwriting");
  {
    const [before] = await listEventsForUser(USER);
    await recordDiscoveryCandidates(USER, [
      candidate({ sourceRef: "gcal:uid-1", title: "A Worse Title", location: "Elsewhere", timezone: "America/Los_Angeles" }),
    ]);
    const [after] = await listEventsForUser(USER);
    check("the title is not overwritten", after?.title === before?.title, String(after?.title));
    check("the venue is not overwritten", after?.venue === "Shack15", String(after?.venue));
    const tz = rowsOf<{ timezone: string | null }>(
      await db().execute(sql`SELECT timezone FROM events WHERE id = ${after!.id}`)
    )[0]?.timezone;
    check("but a blank IS filled", tz === "America/Los_Angeles", String(tz));
  }

  console.log("\nan RSVP change is the one thing that DOES overwrite");
  {
    const [event] = await listEventsForUser(USER);
    await recordDiscoveryCandidates(USER, [candidate({ sourceRef: "gcal:uid-1", rsvpHint: "waitlist" })]);
    await recordDiscoveryCandidates(USER, [candidate({ sourceRef: "gcal:uid-1", rsvpHint: "going" })]);
    const rsvp = (await listEventsForUser(USER)).find((e) => e.id === event!.id)?.rsvpStatus;
    check("the newest answer wins", rsvp === "going", String(rsvp));
  }

  console.log("\ncalendar guests land on the roster, and stop there");
  {
    const [event] = await listEventsForUser(USER);
    await recordDiscoveryCandidates(USER, [
      candidate({
        sourceRef: "gcal:uid-1",
        attendees: [
          {
            externalRef: null,
            fullName: "Ada Lovelace",
            email: "ada@analytical.io",
            company: null,
            title: null,
            linkedinUrl: null,
            xHandle: null,
            phone: null,
            attendeeRole: "attendee",
          },
        ],
      }),
    ]);
    const roster = await listRosterForUser(USER, event!.id);
    check("the guest is on the roster", roster.length === 1, String(roster.length));
    check("badged as a calendar invite, not a published guest list", roster[0]?.source === "calendar");
    check("not connected to anyone", roster[0]?.contactId === null);
    check("not marked spoken-to", roster[0]?.spokeTo === false);
    // The rule that keeps the plan cap honest.
    check("STILL no contacts exist", (await contactCount()) === 0, String(await contactCount()));
  }

  console.log("\n“not mine” sticks");
  {
    const [event] = await listEventsForUser(USER);
    await dismissEventForUser(USER, event!.id);
    check("it leaves the list", (await listEventsForUser(USER)).length === 0);
    check("but is still findable in the hidden list", (await listEventsForUser(USER, 100, { hidden: true })).length === 1);

    // The whole point: the same feed reports it again fifteen minutes later.
    const stats = await recordDiscoveryCandidates(USER, [candidate()]);
    check("the re-report is refused", stats.suppressed === 1 && stats.created === 0, JSON.stringify(stats));
    check("and no second row appeared", (await eventCount()) === 1, String(await eventCount()));

    // A source that changes its own ref must not escape the dismissal by looking new.
    const renamed = await recordDiscoveryCandidates(USER, [candidate({ sourceRef: "gcal:uid-RENAMED" })]);
    check("a new source ref does not escape it", renamed.suppressed === 1, JSON.stringify(renamed));

    await restoreEventForUser(USER, event!.id);
    check("restoring brings it back", (await listEventsForUser(USER)).length === 1);
  }

  console.log("\na deleted event stays deleted");
  {
    const [event] = await listEventsForUser(USER);
    await tombstoneAliasesForEvent(USER, event!.id);
    await db().execute(sql`DELETE FROM events WHERE id = ${event!.id}`);
    check("the keys survive the row", (await listTombstones(USER)).length > 0);

    const stats = await recordDiscoveryCandidates(USER, [candidate()]);
    check("the next sync does not resurrect it", stats.suppressed === 1 && stats.created === 0, JSON.stringify(stats));
    check("no events exist", (await eventCount()) === 0);
  }

  console.log("\nbut pasting the link by hand overrides a tombstone");
  {
    // An explicit request outranks a dismissal: that was an answer about a suggestion.
    const event = await createEventForUser(USER, {
      title: "AI Tinkerers SF",
      url: "https://lu.ma/ai-tinkerers",
    });
    const { claimEventAliases, keysForEvent } = await import("../src/lib/events/discovery/record");
    await claimEventAliases(USER, event.id, keysForEvent({ url: "https://lu.ma/ai-tinkerers" }), "manual");

    const stats = await recordDiscoveryCandidates(USER, [candidate()]);
    check("discovery now attaches to the user's own row", stats.attached === 1, JSON.stringify(stats));
    check("rather than making a second one", (await eventCount()) === 1, String(await eventCount()));
  }

  console.log("\nthe enrichment queue");
  {
    // A fresh discovery, so there is something genuinely owed a page read: everything above
    // has either been read, deleted, or was created by hand with its details already filled.
    const queued = await recordDiscoveryCandidates(USER, [
      candidate({ sourceRef: "gcal:uid-enrich", url: "https://lu.ma/needs-a-read", title: null }),
    ]);
    check("a new discovery is queued for a read", queued.enrichQueued === 1, JSON.stringify(queued));

    const claimed = await claimDueEnrichments(5);
    check("a discovered event is due a page read", claimed.length >= 1, String(claimed.length));
    const leased = await claimDueEnrichments(5);
    // The lease is what stops two overlapping passes fetching the same page twice.
    check("a claimed event is not claimed twice", leased.length === 0, String(leased.length));

    const target = claimed[0]!;
    await markEnrichResult(target.id, { ok: false, attempts: 0 });
    const attempts = rowsOf<{ enrich_attempts: number; enrich_due_at: Date | null }>(
      await db().execute(sql`SELECT enrich_attempts, enrich_due_at FROM events WHERE id = ${target.id}`)
    )[0]!;
    check("a failure counts and backs off", attempts.enrich_attempts === 1 && attempts.enrich_due_at !== null);

    await markEnrichResult(target.id, { ok: false, attempts: 2 });
    const done = rowsOf<{ enrich_due_at: Date | null }>(
      await db().execute(sql`SELECT enrich_due_at FROM events WHERE id = ${target.id}`)
    )[0]!;
    // A page that will not load is usually a page that never will.
    check("the third failure stops asking", done.enrich_due_at === null);

    await markEnrichResult(target.id, { ok: true, attempts: 0 });
    const cleared = rowsOf<{ enrich_attempts: number; enrich_due_at: Date | null }>(
      await db().execute(sql`SELECT enrich_attempts, enrich_due_at FROM events WHERE id = ${target.id}`)
    )[0]!;
    check("success clears the queue", cleared.enrich_due_at === null && cleared.enrich_attempts === 0);
  }

  console.log("\na dismissed event is never fetched");
  {
    const [event] = await listEventsForUser(USER);
    await db().execute(sql`UPDATE events SET enrich_due_at = now() WHERE id = ${event!.id}`);
    await dismissEventForUser(USER, event!.id);
    const claimed = await claimDueEnrichments(5);
    check("it is not in the queue", claimed.every((c) => c.id !== event!.id));
  }

  console.log("\na personal calendar feed");
  {
    // The most valuable connection in the feature: no API, no paid plan, no scraping — just
    // the "subscribe to my calendar" link every one of these platforms already hands out.
    // Luma's personal feed holds every registration in ANY state — approved, waitlisted,
    // pending approval — plus what the user hosts. Only the ones they are going to may land.
    const feed = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:evt-feed1@lu.ma
SUMMARY:Founders Brunch
DTSTART:20260801T170000Z
URL:https://lu.ma/e/evt-feedOne
DESCRIPTION:Get up-to-date information at: https://lu.ma/e/evt-feedOne\\n\\nA morning for founders.\\n\\nWe have a big waitlist\\, so please cancel if you can't come!
END:VEVENT
BEGIN:VEVENT
UID:evt-feed2@lu.ma
SUMMARY:Design Systems Night
DTSTART:20260815T010000Z
URL:https://lu.ma/e/evt-feedTwo
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:evt-feed3@lu.ma
SUMMARY:Candlelit Salon
DTSTART:20260816T010000Z
URL:https://lu.ma/e/evt-feedThree
DESCRIPTION:You're on the waitlist for this event.\\nGet up-to-date information at: https://lu.ma/e/evt-feedThree
END:VEVENT
BEGIN:VEVENT
UID:evt-feed4@lu.ma
SUMMARY:Invite-Only Dinner
DTSTART:20260817T010000Z
URL:https://lu.ma/e/evt-feedFour
DESCRIPTION:Your registration is pending approval.
END:VEVENT
BEGIN:VEVENT
UID:evt-feed5@lu.ma
SUMMARY:Unanswered Invite
DTSTART:20260818T010000Z
URL:https://lu.ma/e/evt-feedFive
ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Me:mailto:me@example.com
END:VEVENT
END:VCALENDAR`;
    const served = (body: string, status = 200) =>
      ({
        fetch: (async () =>
          new Response(status === 200 ? body : null, {
            status,
            headers: status === 200 ? { "content-type": "text/calendar" } : {},
          })) as unknown as typeof fetch,
      });

    const before = await eventCount();
    const stats = await syncIcsFeed(USER, "https://api.lu.ma/ics/get?u=secret", "luma_ics", served(feed));
    check("only the event the user is going to is created", stats.created === 1, JSON.stringify(stats));
    check("the other four are counted, not written", stats.notAttending === 4, JSON.stringify(stats));
    check("and exist", (await eventCount()) === before + 1);

    const rows = await listEventsForUser(USER);
    const brunch = rows.find((e) => e.title === "Founders Brunch");
    check("badged as coming from the Luma feed", brunch?.discoveredVia === "luma_ics", String(brunch?.discoveredVia));
    // "Waitlist" deep in the host's own blurb says nothing about the user's registration.
    check("a host's blurb mentioning a waitlist does not hide it", Boolean(brunch) && brunch?.rsvpStatus !== "waitlist", String(brunch?.rsvpStatus));
    for (const title of ["Design Systems Night", "Candlelit Salon", "Invite-Only Dinner", "Unanswered Invite"]) {
      check(`"${title}" is not on the page`, !rows.some((e) => e.title === title));
    }

    // The feed is polled every half hour, forever. Re-reading it must be a no-op.
    const again = await syncIcsFeed(USER, "https://api.lu.ma/ics/get?u=secret", "luma_ics", served(feed));
    check("re-reading the feed creates nothing", again.created === 0, JSON.stringify(again));
    check("and the count holds", (await eventCount()) === before + 1);

    // Off the waitlist: the same entry now reads as confirmed, and the event arrives.
    const approved = feed.replace(
      "You're on the waitlist for this event.\\n",
      ""
    );
    const promoted = await syncIcsFeed(USER, "https://api.lu.ma/ics/get?u=secret", "luma_ics", served(approved));
    check("coming off the waitlist creates it", promoted.created === 1, JSON.stringify(promoted));
    check(
      "and it shows",
      (await listEventsForUser(USER)).some((e) => e.title === "Candlelit Salon")
    );

    // Regenerating the link is how these platforms revoke one.
    let gone: unknown = null;
    try {
      await syncIcsFeed(USER, "https://api.lu.ma/ics/get?u=stale", "luma_ics", served("", 404));
    } catch (error) {
      gone = error;
    }
    check("a revoked feed URL is not a transient failure", gone instanceof IcsFeedGoneError, String(gone));

    check("and the feed created no contacts either", (await contactCount()) === 0);
  }

  console.log("\na confirmation email, end to end");
  {
    const before = await eventCount();
    const scan = await scanGmailForEvents(USER, "token", null, {
      now: new Date("2026-06-02T00:00:00Z"),
      deps: {
        listPage: async () => ({ messages: [{ id: "msg-9", threadId: "t9" }], nextPageToken: null }),
        headers: async () => [
          {
            id: "msg-9",
            threadId: "t9",
            from: "Partiful <hello@partiful.com>",
            subject: "You're going to Rooftop Dinner",
            snippet: "",
            internalDate: Date.parse("2026-05-20T00:00:00Z"),
          },
        ],
        links: async () => [
          {
            id: "msg-9",
            threadId: "t9",
            from: "Partiful <hello@partiful.com>",
            subject: "You're going to Rooftop Dinner",
            snippet: "",
            internalDate: Date.parse("2026-05-20T00:00:00Z"),
            authenticationResults: "dkim=pass header.d=partiful.com",
            links: [
              "https://partiful.com/e/kX9fT2vQ?t=PERSONALTOKEN",
              "https://partiful.com/unsubscribe",
            ],
          },
        ],
      },
    });

    check("the email produced an event", scan.stats.created === 1, JSON.stringify(scan.stats));
    check("and it exists", (await eventCount()) === before + 1);

    const created = (await listEventsForUser(USER)).find((e) => e.discoveredVia === "gmail");
    check("badged as coming from email", created !== undefined);
    check("the RSVP was read from the subject", created?.rsvpStatus === "going", String(created?.rsvpStatus));
    // The `?t=` on a Partiful link is the RECIPIENT's token. It must never be stored, let
    // alone rendered back as a clickable link on the event page.
    check("the personal token is stripped", created?.url?.includes("PERSONALTOKEN") === false, String(created?.url));

    const evidence = rowsOf<{ evidence: Record<string, unknown> }>(
      await db().execute(sql`
        SELECT evidence FROM event_aliases
         WHERE user_id = ${USER} AND value = 'gmail:msg-9'
      `)
    )[0]?.evidence;
    // Enough to answer "why is this here?", and nothing more: no body, no snippet, no
    // addresses. This table must never become a copy of the user's mail.
    check("the subject is kept as evidence", evidence?.subject === "You're going to Rooftop Dinner", JSON.stringify(evidence));
    check("with the sender's domain", evidence?.fromDomain === "partiful.com");
    check("and nothing else", Object.keys(evidence ?? {}).sort().join(",") === "fromDomain,receivedAt,subject", Object.keys(evidence ?? {}).join(","));

    // Re-scanning the same mailbox is a no-op: the message id is the key.
    const again = await scanGmailForEvents(USER, "token", null, {
      now: new Date("2026-06-02T00:00:00Z"),
      deps: {
        listPage: async () => ({ messages: [{ id: "msg-9", threadId: "t9" }], nextPageToken: null }),
        headers: async () => [
          {
            id: "msg-9",
            threadId: "t9",
            from: "Partiful <hello@partiful.com>",
            subject: "You're going to Rooftop Dinner",
            snippet: "",
            internalDate: null,
          },
        ],
        links: async () => [
          {
            id: "msg-9",
            threadId: "t9",
            from: "Partiful <hello@partiful.com>",
            subject: "You're going to Rooftop Dinner",
            snippet: "",
            internalDate: null,
            authenticationResults: "dkim=pass header.d=partiful.com",
            links: ["https://partiful.com/e/kX9fT2vQ"],
          },
        ],
      },
    });
    check("re-scanning creates nothing", again.stats.created === 0, JSON.stringify(again.stats));
    check("and the mailbox scan created no contacts", (await contactCount()) === 0);
  }

  console.log("\npeople you keep seeing");
  {
    await reset();
    const db = await getDb();

    // Three events. Ada is at all three, spelled differently every time — which is the
    // entire problem: `identity_key` would call those three different people.
    const one = await createEventForUser(USER, { title: "Meetup One", startsAt: new Date("2026-01-10T18:00:00Z") });
    const two = await createEventForUser(USER, { title: "Meetup Two", startsAt: new Date("2026-02-10T18:00:00Z") });
    const three = await createEventForUser(USER, { title: "Meetup Three", startsAt: new Date("2026-03-10T18:00:00Z") });

    await upsertEventAttendees(USER, one.id, parseRosterText("Ada Lovelace https://linkedin.com/in/ada").attendees, "paste");
    await upsertEventAttendees(USER, two.id, parseRosterText("Ada Lovelace https://www.linkedin.com/in/ada/").attendees, "paste");
    await upsertEventAttendees(USER, three.id, parseRosterText("Ada Lovelace <ada@analytical.io>").attendees, "paste");
    // Grace is at one event only: not a pattern.
    await upsertEventAttendees(USER, one.id, parseRosterText("Grace Hopper <grace@navy.mil>").attendees, "paste");
    // Two different people who happen to share a name, at two events. The whole reason the
    // name tier is hidden by default — calling these "someone you keep seeing" is a lie.
    await upsertEventAttendees(USER, one.id, parseRosterText("David Kim").attendees, "paste");
    await upsertEventAttendees(USER, two.id, parseRosterText("David Kim").attendees, "paste");

    const strong = await listRepeatCoAttendees(USER, { minEvents: 2 });
    check("the repeat is found", strong.length === 1, JSON.stringify(strong.map((p) => p.name)));
    check("across two spellings of one profile", strong[0]?.eventsTogether === 2, String(strong[0]?.eventsTogether));
    check("and it is Ada", strong[0]?.name === "Ada Lovelace", String(strong[0]?.name));
    check("a one-off is not a pattern", !strong.some((p) => p.name === "Grace Hopper"));
    // The email row is a THIRD key for the same human, and nothing links it to the LinkedIn
    // rows until she becomes a contact. Stated here rather than pretended away.
    check("an unlinked third identity stays separate", strong[0]?.eventsTogether !== 3);
    check("name-only clusters are excluded by default", !strong.some((p) => p.name === "David Kim"));

    const withWeak = await listRepeatCoAttendees(USER, { minEvents: 2, includeWeak: true });
    const david = withWeak.find((p) => p.name === "David Kim");
    check("but can be asked for", david !== undefined);
    check("and are flagged as weak", david?.weak === true);

    // The user is on every one of their own rosters; without this they are the top result.
    await upsertEventAttendees(USER, one.id, parseRosterText("Me Myself <me@example.com>").attendees, "paste");
    await upsertEventAttendees(USER, two.id, parseRosterText("Me Myself <me@example.com>").attendees, "paste");
    const excludingSelf = await listRepeatCoAttendees(USER, {
      minEvents: 2,
      selfKeys: ["email:me@example.com"],
    });
    check("the user is not someone they keep seeing", !excludingSelf.some((p) => p.name === "Me Myself"));

    // Hiding an event removes it from the pattern too: "not mine" has to mean it everywhere.
    await dismissEventForUser(USER, two.id);
    const afterHide = await listRepeatCoAttendees(USER, { minEvents: 2 });
    check("a hidden event stops counting", afterHide.length === 0, JSON.stringify(afterHide.map((p) => p.name)));
    await restoreEventForUser(USER, two.id);

    // The roster badge: how many events each row's person shares with the user.
    const history = await eventsTogetherForRoster(USER, two.id);
    const adaRow = (await listRosterForUser(USER, two.id)).find((r) => r.fullName === "Ada Lovelace");
    check("the badge sees the second event", history.get(adaRow!.id)?.count === 2, String(history.get(adaRow!.id)?.count));

    // Correcting a row must move its cross-event identity with it, or the corrected person
    // stays filed under the old key forever.
    const graceRow = (await listRosterForUser(USER, one.id)).find((r) => r.fullName === "Grace Hopper")!;
    await updateAttendeeForUser(USER, graceRow.id, {
      fullName: "Grace Hopper",
      email: "grace@cobol.mil",
      company: null,
      title: null,
      linkedinUrl: null,
      xHandle: null,
      attendeeRole: null,
    });
    const movedKey = rowsOf<{ person_key_value: string | null }>(
      await db.execute(sql`SELECT person_key_value FROM event_attendees WHERE id = ${graceRow.id}`)
    )[0]?.person_key_value;
    check("an edit recomputes the person key", movedKey === "grace@cobol.mil", String(movedKey));

    // The backfill, for rows written before the column existed.
    await db.execute(sql`UPDATE event_attendees SET person_key_kind = NULL, person_key_value = NULL WHERE user_id = ${USER}`);
    const filled = await backfillPersonKeys(500);
    check("the backfill fills them", filled > 0, String(filled));
    const rebuilt = await listRepeatCoAttendees(USER, { minEvents: 2 });
    check("and the pattern comes back", rebuilt.some((p) => p.name === "Ada Lovelace"));
    check("running it again finds nothing left", (await backfillPersonKeys(500)) === 0);
  }

  console.log("\nonly events the user is going to are on the page");
  {
    await reset();
    // Rows as discovery wrote them BEFORE it stopped creating the rest: still in the table,
    // and every one of them has to stay off the page without being deleted.
    const insert = async (title: string, cols: { rsvp: string | null; via: string | null; roleSource: string | null; role?: string }) => {
      const rows = rowsOf<{ id: string }>(
        await db().execute(sql`
          INSERT INTO events (user_id, title, starts_at, role, role_source, source, discovered_via, rsvp_status, url)
          VALUES (${USER}, ${title}, ${new Date("2026-05-01T18:00:00Z")}, ${cols.role ?? "attended"},
                  ${cols.roleSource}, 'manual', ${cols.via}, ${cols.rsvp}, ${`https://lu.ma/${title.replace(/\W+/g, "-").toLowerCase()}`})
          RETURNING id
        `)
      );
      return rows[0]!.id;
    };
    await insert("Feed going", { rsvp: "going", via: "luma_ics", roleSource: "inferred" });
    await insert("Feed unknown", { rsvp: null, via: "luma_ics", roleSource: "inferred" });
    await insert("Feed waitlisted", { rsvp: "waitlist", via: "luma_ics", roleSource: "inferred" });
    await insert("Feed maybe", { rsvp: "maybe", via: "partiful_ics", roleSource: "inferred" });
    await insert("Mail newsletter", { rsvp: null, via: "gmail", roleSource: "inferred" });
    await insert("Hosted but pending", { rsvp: "waitlist", via: "luma_ics", roleSource: "inferred", role: "hosted" });
    await insert("Typed in by hand", { rsvp: "waitlist", via: "luma_ics", roleSource: null });

    const titles = (await listEventsForUser(USER)).map((e) => e.title).sort();
    check(
      "confirmed, unknown-from-a-feed, hosted and hand-added events show; the rest do not",
      JSON.stringify(titles) ===
        JSON.stringify(["Feed going", "Feed unknown", "Hosted but pending", "Typed in by hand"]),
      JSON.stringify(titles)
    );
    check("nothing was deleted to get there", (await eventCount()) === 7);
    const due = await requeueUnreadEvents();
    check("only visible events are queued for a page read", due === 4, String(due));
  }

  console.log("\nupcoming and past");
  {
    await reset();
    const now = new Date("2026-09-12T12:00:00Z");
    const make = (title: string, startsAt: Date | null, endsAt: Date | null = null) =>
      createEventForUser(USER, { title, startsAt, endsAt });
    await make("Last week", new Date("2026-09-05T18:00:00Z"));
    await make("Last month", new Date("2026-08-10T18:00:00Z"));
    await make("Day two of a conference", new Date("2026-09-11T09:00:00Z"), new Date("2026-09-13T18:00:00Z"));
    await make("Tomorrow", new Date("2026-09-13T18:00:00Z"));
    await make("Next month", new Date("2026-10-10T18:00:00Z"));
    await make("No date", null);

    const upcoming = (await listEventsForUser(USER, 100, { when: "upcoming", now })).map((e) => e.title);
    const past = (await listEventsForUser(USER, 100, { when: "past", now })).map((e) => e.title);
    check(
      "upcoming is soonest-first, and includes an event that has started but not ended",
      JSON.stringify(upcoming) === JSON.stringify(["Day two of a conference", "Tomorrow", "Next month"]),
      JSON.stringify(upcoming)
    );
    check(
      "past is newest-first, with the undated at the bottom",
      JSON.stringify(past) === JSON.stringify(["Last week", "Last month", "No date"]),
      JSON.stringify(past)
    );
  }

  console.log("\ncovers for events that never had a page read");
  {
    await reset();
    // An import larger than the per-pass cap: the overflow used to get no read, and no cover.
    const many = await recordDiscoveryCandidates(
      USER,
      [1, 2, 3].map((n) =>
        candidate({ sourceRef: `gcal:bulk-${n}`, url: `https://lu.ma/bulk-${n}`, title: `Bulk ${n}` })
      ),
      { maxEnrichQueued: 1 }
    );
    check("all three are created", many.created === 3, JSON.stringify(many));
    const waves = rowsOf<{ due: Date | string | null }>(
      await db().execute(sql`SELECT enrich_due_at AS due FROM events WHERE user_id = ${USER} ORDER BY enrich_due_at`)
    ).map((r) => (r.due ? new Date(r.due).getTime() : null));
    check("every one of them is queued", waves.every((t) => t !== null), JSON.stringify(waves));
    check("the overflow waits its turn", waves[2]! - waves[0]! >= 59 * 60 * 1000, JSON.stringify(waves));

    // Rows from before: never queued, and a Luma share card worn as a cover.
    await reset();
    const neverRead = await createEventForUser(USER, { title: "Never read", url: "https://lu.ma/never-read" });
    const shareCard = await createEventForUser(USER, { title: "Share card", url: "https://lu.ma/share-card" });
    const freshCard = await createEventForUser(USER, { title: "Read since", url: "https://lu.ma/read-since" });
    await db().execute(sql`
      UPDATE events SET cover_image_url = 'https://blob/x.png',
             cover_source_url = 'https://images.lumacdn.com/cdn-cgi/image/w=800/event-social/41/x.png',
             enriched_at = ${new Date("2026-09-01T00:00:00Z")}
       WHERE id = ${shareCard.id}`);
    await db().execute(sql`
      UPDATE events SET cover_image_url = 'https://blob/y.png',
             cover_source_url = 'https://images.lumacdn.com/cdn-cgi/image/w=800/event-social/41/y.png',
             enriched_at = ${new Date("2026-09-20T00:00:00Z")}
       WHERE id = ${freshCard.id}`);
    await requeueUnreadEvents();
    const queuedIds = rowsOf<{ id: string }>(
      await db().execute(sql`SELECT id FROM events WHERE user_id = ${USER} AND enrich_due_at IS NOT NULL`)
    ).map((r) => r.id);
    check("a never-read event is queued", queuedIds.includes(neverRead.id));
    check("a Luma share card from before the fix is re-read", queuedIds.includes(shareCard.id));
    check("but not one already re-read since", !queuedIds.includes(freshCard.id));
  }

  console.log("\nand after all of that");
  check("no contact was ever created", (await contactCount()) === 0, String(await contactCount()));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll event discovery store checks passed.");
});

/** `getDb` returns a promise; this keeps the assertions above readable. */
function db() {
  return {
    execute: async (statement: Parameters<Awaited<ReturnType<typeof getDb>>["execute"]>[0]) =>
      (await getDb()).execute(statement),
  };
}
