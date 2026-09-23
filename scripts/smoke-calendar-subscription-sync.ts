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
      // Exactly one, not merely "at most one": MUST FIX 3's ruling keeps the DTSTART
      // occurrence's uid bare, so it alone is not occurrence-derived and still earns its one
      // follow-up, same as a non-recurring meeting always has; the nine later, occurrence-
      // derived instances are suppressed by `isOccurrenceUid`.
      check(
        "ten interactions from one daily series produce EXACTLY ONE follow-up reminder",
        reminderRows.length === 1,
        `got ${reminderRows.length}`
      );
      check(
        "that one reminder's description carries the DTSTART occurrence's bare uid, no suffix",
        reminderRows[0]?.description === "You met with them. Event daily-followup-uid",
        reminderRows[0]?.description
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
