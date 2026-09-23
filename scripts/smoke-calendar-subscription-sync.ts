/**
 * `syncCalendarSubscription` end to end, with a stubbed ICS fetch.
 *
 * Nothing in the repo calls `syncCalendarSubscription` except production code
 * (`src/actions/calendar.ts`, `src/lib/sync-scheduler.ts`), so the RRULE-expansion wiring it
 * grew in `calendar-sync.ts` (Task 3 of the calendar-connections plan) was otherwise exercised
 * by nothing — `smoke-recurrence.ts`'s "through the ICS parser" case calls `expandEvent`
 * directly with the same arguments the sync path builds, which pins the expander and the
 * parser but never actually runs the wiring between them.
 *
 * This asserts on rows, the way a real re-sync would be judged: a recurring feed event must
 * turn into one interaction per occurrence, each with its own `external_id`; a non-recurring
 * feed event must turn into exactly one interaction whose `external_id` carries no occurrence
 * suffix — `cal:<uid>:<contactId>` is already written on every interaction Orbit has ever
 * ingested, so that shape is load-bearing; and re-syncing the same feed must not duplicate
 * either.
 *
 * pglite tier: runs the real ingest spine (contacts, interactions) against a throwaway PGlite
 * database. Stop any dev server on this worktree before running — PGlite is single-writer.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { calendarSubscriptions } from "../src/db/schema";
import { syncCalendarSubscription } from "../src/lib/calendar-sync";

const USER = "calendar-subscription-sync-smoke-user";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** `YYYYMMDDTHHMMSSZ`, the UTC form ICS actually writes. */
function icsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

async function reset() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM reminders WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contact_embeddings WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM interactions WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM companies WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM calendar_subscriptions WHERE user_id = ${USER}`);
}

async function externalIds(db: Awaited<ReturnType<typeof getDb>>) {
  const rows = rowsOf<{ external_id: string }>(
    await db.execute(sql`
      SELECT external_id FROM interactions WHERE user_id = ${USER} ORDER BY external_id
    `)
  );
  return rows.map((r) => r.external_id);
}

run(async () => {
  const db = await getDb();
  await reset();

  // Anchored to "now" rather than a fixed calendar date, so this stays well inside
  // `syncCalendarSubscription`'s own window (90 days back, 60 days forward) forever, and
  // avoids a fixed date ever drifting stale.
  const now = new Date();
  const weeklyStart = new Date(now.getTime() - 21 * 86400000);
  weeklyStart.setUTCHours(15, 0, 0, 0);
  const weeklyEnd = new Date(weeklyStart.getTime() + 30 * 60000);

  const singleStart = new Date(now.getTime() - 10 * 86400000);
  singleStart.setUTCHours(16, 0, 0, 0);
  const singleEnd = new Date(singleStart.getTime() + 30 * 60000);

  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:weekly-sub-uid",
    "SUMMARY:1:1 with Priya",
    `DTSTART:${icsUtc(weeklyStart)}`,
    `DTEND:${icsUtc(weeklyEnd)}`,
    "RRULE:FREQ=WEEKLY;COUNT=4",
    "ATTENDEE;CN=Priya:mailto:priya@example.com",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:single-sub-uid",
    "SUMMARY:1:1 with Sam",
    `DTSTART:${icsUtc(singleStart)}`,
    `DTEND:${icsUtc(singleEnd)}`,
    "ATTENDEE;CN=Sam:mailto:sam@example.com",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(ics, { status: 200, headers: { "Content-Type": "text/calendar" } })) as typeof fetch;

  try {
    const [sub] = await db
      .insert(calendarSubscriptions)
      .values({ userId: USER, icsUrl: "https://example.test/feed.ics", enabled: 1 })
      .returning();

    await syncCalendarSubscription(USER, sub!.id);

    const ids = await externalIds(db);
    const weeklyIds = ids.filter((id) => id.startsWith("cal:weekly-sub-uid"));
    const singleIds = ids.filter((id) => id.startsWith("cal:single-sub-uid"));

    check("a recurring feed event yields several interactions", weeklyIds.length === 4, `got ${weeklyIds.length}`);
    check("each occurrence's external_id is distinct", new Set(weeklyIds).size === 4, weeklyIds.join(", "));
    // MUST FIX 3 ruling: the occurrence matching the master's own DTSTART (`weeklyStart`, 21
    // days back, inside the sync window) keeps the bare `cal:<uid>` id — the same id it would
    // already have from before expansion existed; only the three LATER occurrences carry the
    // `_<instant>` suffix.
    const bareWeeklyIds = weeklyIds.filter((id) => /^cal:weekly-sub-uid:[0-9a-f-]{36}$/.test(id));
    const suffixedWeeklyIds = weeklyIds.filter((id) =>
      /^cal:weekly-sub-uid_\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:[0-9a-f-]{36}$/.test(id)
    );
    check(
      "the DTSTART occurrence keeps the bare external_id",
      bareWeeklyIds.length === 1,
      weeklyIds.join(", ")
    );
    check(
      "the three later occurrences carry the occurrence instant",
      suffixedWeeklyIds.length === 3,
      weeklyIds.join(", ")
    );
    check("a non-recurring feed event yields exactly one interaction", singleIds.length === 1, `got ${singleIds.length}`);
    check(
      "its external_id carries no occurrence suffix — cal:<uid>:<contactId>",
      /^cal:single-sub-uid:[0-9a-f-]{36}$/.test(singleIds[0] ?? ""),
      singleIds[0]
    );

    // --- re-sync: idempotent ---
    await syncCalendarSubscription(USER, sub!.id);
    const idsAfter = await externalIds(db);
    check(
      "re-syncing the same feed creates no duplicates",
      idsAfter.length === ids.length && new Set(idsAfter).size === idsAfter.length,
      `${ids.length} -> ${idsAfter.length}`
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  // --- a recurring series produces AT MOST ONE post-meeting follow-up, not one per occurrence
  //
  // `postMeetingReminder` fires for every occurrence in the last 21 days, and ingest dedupes
  // reminders on (contactId, description) where the description embeds the now-per-occurrence
  // uid — so before the fix, a daily standup expanded into several distinct reminder rows, one
  // per occurrence, all clamped to the same due date. A single counterpart with a run of daily
  // occurrences inside that window is exactly the failure case.
  {
    await db.execute(sql`DELETE FROM reminders WHERE user_id = ${USER}`);

    const dailyStart = new Date(now.getTime() - 10 * 86400000);
    dailyStart.setUTCHours(9, 0, 0, 0);
    const dailyEnd = new Date(dailyStart.getTime() + 30 * 60000);

    const dailyIcs = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:daily-followup-uid",
      "SUMMARY:1:1 with Ana",
      `DTSTART:${icsUtc(dailyStart)}`,
      `DTEND:${icsUtc(dailyEnd)}`,
      "RRULE:FREQ=DAILY;COUNT=10",
      "ATTENDEE;CN=Ana:mailto:ana@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    globalThis.fetch = (async () =>
      new Response(dailyIcs, { status: 200, headers: { "Content-Type": "text/calendar" } })) as typeof fetch;

    try {
      const [dailySub] = await db
        .insert(calendarSubscriptions)
        .values({ userId: USER, icsUrl: "https://example.test/daily-feed.ics", enabled: 1 })
        .returning();

      await syncCalendarSubscription(USER, dailySub!.id);

      const dailyIds = (await externalIds(db)).filter((id) => id.startsWith("cal:daily-followup-uid"));
      check(
        "the daily series produces several interactions",
        dailyIds.length >= 8,
        `got ${dailyIds.length}`
      );

      const reminderRows = rowsOf<{ description: string }>(
        await db.execute(sql`
          SELECT description FROM reminders
          WHERE user_id = ${USER} AND description LIKE '%daily-followup-uid%'
        `)
      );
      // Exactly one, not merely "at most one": `seriesFollowUpEligibility` picks the series'
      // single MOST RECENT PAST occurrence — here, the tenth and last (COUNT=10, so "yesterday"
      // relative to `now`) — and suppresses the other nine, the same way a non-recurring
      // event's single occurrence always has exactly one shot at a follow-up.
      check(
        "ten interactions from one daily series produce EXACTLY ONE follow-up reminder",
        reminderRows.length === 1,
        `got ${reminderRows.length}`
      );
      const mostRecentDailyOccurrence = new Date(dailyStart.getTime() + 9 * 86400000);
      check(
        "that one reminder's description carries the MOST RECENT occurrence's uid, not DTSTART's",
        reminderRows[0]?.description ===
          `You met with them. Event daily-followup-uid_${mostRecentDailyOccurrence.toISOString()}`,
        reminderRows[0]?.description
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // --- REGRESSION 1: a RECURRENCE-ID override replaces the occurrence it moved, not the
  //     whole series.
  //
  // A real feed for a recurring meeting with one moved instance carries two VEVENTs sharing a
  // UID: the master (RRULE) and an override (RECURRENCE-ID — the ORIGINAL slot it replaces —
  // no RRULE, its own moved time/summary). Before the fix, `parseIcsEvents` dropped
  // RECURRENCE-ID, so the override arrived as a second independent event with the SAME bare
  // uid as the master's own DTSTART occurrence; ingest's last-one-wins `onConflictDoUpdate`
  // then overwrote that row with the override's (wrong) data, and the occurrence the override
  // actually replaced was left untouched under its own suffixed id — one interaction row lost,
  // one row corrupted.
  {
    await reset();

    const overrideWeeklyStart = new Date(now.getTime() - 21 * 86400000);
    overrideWeeklyStart.setUTCHours(15, 0, 0, 0);
    const overrideWeeklyEnd = new Date(overrideWeeklyStart.getTime() + 30 * 60000);

    // The master's own second occurrence — the exact slot the override replaces.
    const secondOccurrence = new Date(overrideWeeklyStart.getTime() + 7 * 86400000);

    // Moved two days later, at a different hour, with a different summary.
    const movedStart = new Date(secondOccurrence.getTime() + 2 * 86400000);
    movedStart.setUTCHours(18, 0, 0, 0);
    const movedEnd = new Date(movedStart.getTime() + 30 * 60000);

    const overrideIcs = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:override-sub-uid",
      "SUMMARY:1:1 with Nia",
      `DTSTART:${icsUtc(overrideWeeklyStart)}`,
      `DTEND:${icsUtc(overrideWeeklyEnd)}`,
      "RRULE:FREQ=WEEKLY;COUNT=4",
      "ATTENDEE;CN=Nia:mailto:nia@example.com",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:override-sub-uid",
      `RECURRENCE-ID:${icsUtc(secondOccurrence)}`,
      "SUMMARY:1:1 with Nia (rescheduled)",
      `DTSTART:${icsUtc(movedStart)}`,
      `DTEND:${icsUtc(movedEnd)}`,
      "ATTENDEE;CN=Nia:mailto:nia@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    globalThis.fetch = (async () =>
      new Response(overrideIcs, { status: 200, headers: { "Content-Type": "text/calendar" } })) as typeof fetch;

    try {
      const [overrideSub] = await db
        .insert(calendarSubscriptions)
        .values({ userId: USER, icsUrl: "https://example.test/override-feed.ics", enabled: 1 })
        .returning();

      await syncCalendarSubscription(USER, overrideSub!.id);

      const rows = rowsOf<{ external_id: string; interaction_date: string; ai_summary: string | null }>(
        await db.execute(sql`
          SELECT external_id, interaction_date, ai_summary FROM interactions
          WHERE user_id = ${USER} AND external_id LIKE 'cal:override-sub-uid%'
          ORDER BY external_id
        `)
      );

      check(
        "a rescheduled instance produces exactly one row per occurrence, not a duplicate/overwritten bare id",
        rows.length === 4,
        rows.map((r) => r.external_id).join(", ")
      );

      const bareRow = rows.find((r) => /^cal:override-sub-uid:[0-9a-f-]{36}$/.test(r.external_id));
      check(
        "the original DTSTART occurrence survives, untouched by the override",
        bareRow?.ai_summary === "1:1 with Nia",
        bareRow?.ai_summary ?? "(missing)"
      );
      check(
        "...at its own original time, not the override's",
        !!bareRow && new Date(bareRow.interaction_date).getTime() === overrideWeeklyStart.getTime(),
        bareRow?.interaction_date
      );

      const secondSuffix = `cal:override-sub-uid_${secondOccurrence.toISOString()}`;
      const replacedRow = rows.find((r) => r.external_id.startsWith(secondSuffix));
      check(
        "the overridden slot keeps the id of the occurrence it replaces",
        !!replacedRow,
        rows.map((r) => r.external_id).join(", ")
      );
      check(
        "...but carries the override's own summary",
        replacedRow?.ai_summary === "1:1 with Nia (rescheduled)",
        replacedRow?.ai_summary ?? "(missing)"
      );
      check(
        "...and its own moved time, not the slot's original time",
        !!replacedRow && new Date(replacedRow.interaction_date).getTime() === movedStart.getTime(),
        replacedRow?.interaction_date
      );

      const untouchedSuffixes = rows.filter(
        (r) => r.external_id.includes("_") && !r.external_id.startsWith(secondSuffix)
      );
      check(
        "the two un-overridden later occurrences are untouched",
        untouchedSuffixes.length === 2 && untouchedSuffixes.every((r) => r.ai_summary === "1:1 with Nia"),
        untouchedSuffixes.map((r) => `${r.external_id}=${r.ai_summary}`).join(", ")
      );

      // --- re-sync: still idempotent with an override in play ---
      await syncCalendarSubscription(USER, overrideSub!.id);
      const rowsAfter = rowsOf<{ external_id: string }>(
        await db.execute(sql`
          SELECT external_id FROM interactions
          WHERE user_id = ${USER} AND external_id LIKE 'cal:override-sub-uid%'
        `)
      );
      check(
        "re-syncing a feed with an override creates no duplicates",
        rowsAfter.length === rows.length,
        `${rows.length} -> ${rowsAfter.length}`
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // --- REGRESSION 2, the case the smoke above can't see: an ESTABLISHED series (DTSTART well
  //     past the 90-day expansion window) still produces exactly one follow-up.
  //
  // `postMeetingReminder` used to suppress a follow-up for every OCCURRENCE uid
  // (`isOccurrenceUid`), keeping only the series' bare-uid DTSTART occurrence eligible. That
  // works only when DTSTART itself falls inside the sync window. A DTSTART 120+ days back never
  // gets expanded at all (the window is 90 days back), so every occurrence this series ever
  // emits carries a suffixed, occurrence-derived uid — and the old check suppressed ALL of them,
  // the dominant real case (an established weekly 1:1) producing zero follow-ups instead of one.
  {
    await db.execute(sql`DELETE FROM reminders WHERE user_id = ${USER}`);
    await db.execute(sql`DELETE FROM interactions WHERE user_id = ${USER} AND external_id LIKE 'cal:established-weekly-uid%'`);

    const establishedStart = new Date(now.getTime() - 130 * 86400000);
    establishedStart.setUTCHours(11, 0, 0, 0);
    const establishedEnd = new Date(establishedStart.getTime() + 30 * 60000);

    const establishedIcs = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:established-weekly-uid",
      "SUMMARY:1:1 with Priya",
      `DTSTART:${icsUtc(establishedStart)}`,
      `DTEND:${icsUtc(establishedEnd)}`,
      "RRULE:FREQ=WEEKLY",
      "ATTENDEE;CN=Priya:mailto:priya-established@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    globalThis.fetch = (async () =>
      new Response(establishedIcs, { status: 200, headers: { "Content-Type": "text/calendar" } })) as typeof fetch;

    try {
      const [establishedSub] = await db
        .insert(calendarSubscriptions)
        .values({ userId: USER, icsUrl: "https://example.test/established-feed.ics", enabled: 1 })
        .returning();

      await syncCalendarSubscription(USER, establishedSub!.id);

      const establishedIds = (await externalIds(db)).filter((id) => id.startsWith("cal:established-weekly-uid"));
      check(
        "an established series (DTSTART 130 days back) still produces interactions inside the sync window",
        establishedIds.length > 0,
        `got ${establishedIds.length}`
      );
      check(
        "none of them carry the bare, pre-window uid — DTSTART itself is outside the 90-day window",
        establishedIds.every((id) => id.includes("_")),
        establishedIds.join(", ")
      );

      const establishedReminders = rowsOf<{ description: string }>(
        await db.execute(sql`
          SELECT description FROM reminders
          WHERE user_id = ${USER} AND description LIKE '%established-weekly-uid%'
        `)
      );
      check(
        "an established weekly series produces EXACTLY ONE follow-up, not zero",
        establishedReminders.length === 1,
        `got ${establishedReminders.length}`
      );

      // --- and a series with several counterparts produces one follow-up PER counterpart, as
      //     a single (non-recurring) meeting already would.
      await db.execute(sql`DELETE FROM reminders WHERE user_id = ${USER}`);
      await db.execute(sql`DELETE FROM interactions WHERE user_id = ${USER} AND external_id LIKE 'cal:established-multi-uid%'`);

      const multiIcs = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:established-multi-uid",
        // "1:1 with ..." (not "Team sync") so `classifyCalendarEvent`'s NETWORKING_TITLE rule
        // keeps it despite two counterparts (its count<=3 allowance) — a title-less classifier
        // rejection would confound this check with the thing it's actually testing.
        "SUMMARY:1:1 with Priya and Sam",
        `DTSTART:${icsUtc(establishedStart)}`,
        `DTEND:${icsUtc(establishedEnd)}`,
        "RRULE:FREQ=WEEKLY",
        "ATTENDEE;CN=Priya:mailto:priya-multi@example.com",
        "ATTENDEE;CN=Sam:mailto:sam-multi@example.com",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      globalThis.fetch = (async () =>
        new Response(multiIcs, { status: 200, headers: { "Content-Type": "text/calendar" } })) as typeof fetch;

      const [multiSub] = await db
        .insert(calendarSubscriptions)
        .values({ userId: USER, icsUrl: "https://example.test/established-multi-feed.ics", enabled: 1 })
        .returning();

      await syncCalendarSubscription(USER, multiSub!.id);

      const multiReminders = rowsOf<{ description: string }>(
        await db.execute(sql`
          SELECT description FROM reminders
          WHERE user_id = ${USER} AND description LIKE '%established-multi-uid%'
        `)
      );
      check(
        "an established series with two counterparts produces one follow-up PER counterpart",
        multiReminders.length === 2,
        `got ${multiReminders.length}`
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  await reset();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll calendar subscription sync checks passed.");
});
