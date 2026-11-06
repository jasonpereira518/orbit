/**
 * Reminders that come from the calendar, run on every `calendar_events` refresh.
 *
 *   - **Prep**, the day before a meeting worth preparing for: a first meeting with someone,
 *     a gap of more than 90 days, or something still open with them.
 *   - **Post-meeting follow-up**, two days after a one-off meeting with someone you know —
 *     unless it was recorded, because the recording's own summary already made its reminders.
 *     The ICS subscription path has had this since the start; Google now gets the same, with
 *     the same title and description so the two never double up on one calendar.
 *   - **Cleanup**: a prep reminder follows its meeting when it moves and is dismissed when it
 *     is cancelled. Dismissed, never deleted — the same rule as note-batch undo.
 *
 * Only real meetings: timed, not declined, at most `MAX_GUESTS` other people, with at least one
 * of them already a contact. A webinar or an all-hands is not a relationship touch.
 *
 * Each reminder carries `calendar_event_key` (the provider's per-instance id), which is both
 * the dedupe key and what cleanup follows.
 */
import { and, eq, inArray, isNotNull, isNull, lt, max, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { actionItems, interactions, meetingSessions, reminders, type CalendarEventAttendee } from "@/db/schema";

const DAY = 86_400_000;
const MAX_GUESTS = 8;
/** How far ahead a prep reminder is made. Further out, whether it is worth it can still change. */
const PREP_HORIZON_MS = 3 * DAY;
const GAP_MS = 90 * DAY;

export type ReminderEvent = {
  providerEventId: string;
  icalUid: string | null;
  seriesId: string | null;
  title: string;
  startAt: Date;
  endAt: Date | null;
  allDay: boolean;
  attendees: CalendarEventAttendee[];
  attendeeCount: number;
  selfResponse: string | null;
};

function isRealMeeting(e: ReminderEvent): boolean {
  return (
    !e.allDay &&
    e.selfResponse !== "declined" &&
    e.attendeeCount > 0 &&
    e.attendeeCount <= MAX_GUESTS &&
    e.attendees.some((a) => a.contactId)
  );
}

/** A prep reminder is due the day before, or now when the meeting is less than a day away. */
export function prepDue(startAt: Date, now: Date): Date {
  return new Date(Math.max(now.getTime(), startAt.getTime() - DAY));
}

/** The ICS path's description, byte for byte — its dedupe compares descriptions. */
function postMeetingDescription(e: ReminderEvent): string {
  return `You met with them. Event ${e.icalUid ?? e.providerEventId}`;
}

function quoted(title: string): string {
  return title.trim() ? `“${title.trim().slice(0, 120)}”` : "your meeting";
}

/**
 * Why a meeting is worth preparing for, per contact on it: the first reason that applies, or
 * nothing. Exported for the smoke, which drives it with fixed facts.
 */
export function prepReasons(
  people: Array<{ contactId: string; name: string }>,
  facts: { lastTouch: Map<string, Date>; open: Map<string, number>; dueBefore?: Map<string, string> },
  now: Date
): Array<{ contactId: string; reason: string }> {
  const out: Array<{ contactId: string; reason: string }> = [];
  for (const p of people) {
    const last = facts.lastTouch.get(p.contactId);
    const open = facts.open.get(p.contactId) ?? 0;
    if (!last) out.push({ contactId: p.contactId, reason: `First meeting with ${p.name}` });
    else if (now.getTime() - last.getTime() > GAP_MS) {
      const months = Math.round((now.getTime() - last.getTime()) / (30 * DAY));
      out.push({ contactId: p.contactId, reason: `Last spoke with ${p.name} ${months} months ago` });
    } else if (facts.dueBefore?.get(p.contactId)) {
      out.push({ contactId: p.contactId, reason: `Due before the meeting: ${facts.dueBefore.get(p.contactId)}` });
    } else if (open > 0) {
      out.push({ contactId: p.contactId, reason: `${open} open ${open === 1 ? "to-do" : "to-dos"} with ${p.name}` });
    }
  }
  return out;
}

export async function syncCalendarReminders(
  userId: string,
  events: ReminderEvent[],
  complete: boolean,
  now: Date
): Promise<void> {
  const db = await getDb();
  const nowMs = now.getTime();
  const meetings = events.filter(isRealMeeting);

  // One-off meetings only: a weekly 1:1 does not need a nudge after every occurrence.
  const past = meetings.filter((e) => (e.endAt ?? e.startAt).getTime() < nowMs && !e.seriesId);
  const upcoming = meetings.filter((e) => e.startAt.getTime() > nowMs && e.startAt.getTime() - nowMs <= PREP_HORIZON_MS);

  const keys = [...past, ...upcoming].map((e) => e.providerEventId);
  if (keys.length) {
    const [existing, recorded] = await Promise.all([
      db
        .select({ key: reminders.calendarEventKey, type: reminders.reminderType, description: reminders.description })
        .from(reminders)
        .where(
          and(
            eq(reminders.userId, userId),
            or(
              inArray(reminders.calendarEventKey, keys),
              past.length ? inArray(reminders.description, past.map(postMeetingDescription)) : undefined
            )
          )
        ),
      past.length
        ? db
            .select({ key: meetingSessions.calendarEventKey })
            .from(meetingSessions)
            .where(
              and(
                eq(meetingSessions.userId, userId),
                inArray(meetingSessions.calendarEventKey, past.map((e) => e.providerEventId))
              )
            )
        : Promise.resolve([]),
    ]);
    const has = new Set(existing.map((r) => `${r.type}:${r.key}`));
    const descriptions = new Set(existing.map((r) => r.description));
    const wasRecorded = new Set(recorded.map((r) => r.key));

    const rows: (typeof reminders.$inferInsert)[] = [];

    for (const e of past) {
      if (has.has(`post_meeting:${e.providerEventId}`) || wasRecorded.has(e.providerEventId)) continue;
      if (descriptions.has(postMeetingDescription(e))) continue;
      const end = (e.endAt ?? e.startAt).getTime();
      rows.push({
        userId,
        contactId: e.attendees.find((a) => a.contactId)!.contactId,
        title: `Follow up after ${e.title.trim() || "meeting"}`,
        description: postMeetingDescription(e),
        dueDate: new Date(Math.max(end + 2 * DAY, nowMs + DAY)),
        status: "pending",
        reminderType: "post_meeting",
        actionKind: "follow_up",
        createdBy: "calendar_sync",
        calendarEventKey: e.providerEventId,
      });
    }

    const toPrep = upcoming.filter((e) => !has.has(`pre_meeting:${e.providerEventId}`));
    const contactIds = [
      ...new Set(toPrep.flatMap((e) => e.attendees.map((a) => a.contactId).filter((c): c is string => !!c))),
    ];
    if (contactIds.length) {
      const [touches, openReminders, openItems] = await Promise.all([
        db
          .select({ contactId: interactions.contactId, last: max(interactions.interactionDate) })
          .from(interactions)
          .where(
            and(
              eq(interactions.userId, userId),
              inArray(interactions.contactId, contactIds),
              // Calendar sync logs upcoming meetings as interactions too; only the past counts.
              lt(interactions.interactionDate, now)
            )
          )
          .groupBy(interactions.contactId),
        db
          .select({ contactId: reminders.contactId, title: reminders.title, dueDate: reminders.dueDate })
          .from(reminders)
          .where(
            and(
              eq(reminders.userId, userId),
              inArray(reminders.contactId, contactIds),
              eq(reminders.status, "pending"),
              isNull(reminders.calendarEventKey)
            )
          )
          .orderBy(reminders.dueDate),
        db
          .select({ contactId: actionItems.contactId, n: sql<number>`count(*)::int` })
          .from(actionItems)
          .where(
            and(eq(actionItems.userId, userId), inArray(actionItems.contactId, contactIds), eq(actionItems.status, "open"))
          )
          .groupBy(actionItems.contactId),
      ]);
      const lastTouch = new Map<string, Date>();
      for (const t of touches) if (t.contactId && t.last) lastTouch.set(t.contactId, new Date(t.last));
      const open = new Map<string, number>();
      for (const r of openReminders) if (r.contactId) open.set(r.contactId, (open.get(r.contactId) ?? 0) + 1);
      for (const r of openItems) if (r.contactId) open.set(r.contactId, (open.get(r.contactId) ?? 0) + Number(r.n));

      for (const e of toPrep) {
        const people = e.attendees
          .filter((a): a is CalendarEventAttendee & { contactId: string } => !!a.contactId)
          .map((a) => ({ contactId: a.contactId, name: a.name || a.email }));
        // The earliest to-do with each person that falls due before this meeting starts.
        const dueBefore = new Map<string, string>();
        for (const r of openReminders) {
          if (r.contactId && r.dueDate && r.dueDate.getTime() <= e.startAt.getTime() && !dueBefore.has(r.contactId)) {
            dueBefore.set(r.contactId, r.title);
          }
        }
        const reasons = prepReasons(people, { lastTouch, open, dueBefore }, now);
        if (!reasons.length) continue;
        rows.push({
          userId,
          contactId: reasons[0].contactId,
          title: `Prep for ${quoted(e.title)}`,
          description: reasons.map((r) => r.reason).join(" · "),
          dueDate: prepDue(e.startAt, now),
          status: "pending",
          reminderType: "pre_meeting",
          actionKind: "meet",
          createdBy: "calendar_sync",
          calendarEventKey: e.providerEventId,
        });
      }
    }

    if (rows.length) await db.insert(reminders).values(rows);
  }

  if (!complete) return;

  // Cleanup: pending prep reminders follow their meeting, or go when it does.
  const pending = await db
    .select({ id: reminders.id, key: reminders.calendarEventKey, dueDate: reminders.dueDate })
    .from(reminders)
    .where(
      and(
        eq(reminders.userId, userId),
        eq(reminders.status, "pending"),
        eq(reminders.reminderType, "pre_meeting"),
        eq(reminders.createdBy, "calendar_sync"),
        isNotNull(reminders.calendarEventKey)
      )
    );
  if (!pending.length) return;
  const byKey = new Map(events.map((e) => [e.providerEventId, e]));
  const gone: string[] = [];
  for (const r of pending) {
    const e = byKey.get(r.key!);
    if (!e || e.selfResponse === "declined" || e.startAt.getTime() < nowMs) {
      gone.push(r.id);
      continue;
    }
    // Moved: a day before the new start. Inside that last day, only a meeting moved EARLIER
    // than its reminder moves it (to now) — otherwise it would creep forward every pass.
    const target = e.startAt.getTime() - DAY;
    const cur = r.dueDate?.getTime() ?? null;
    let next: number | null = null;
    if (target > nowMs) {
      if (cur === null || Math.abs(cur - target) > 60_000) next = target;
    } else if (cur === null || cur > e.startAt.getTime()) {
      next = nowMs;
    }
    if (next !== null) await db.update(reminders).set({ dueDate: new Date(next) }).where(eq(reminders.id, r.id));
  }
  if (gone.length) {
    await db
      .update(reminders)
      .set({ status: "dismissed" })
      .where(and(eq(reminders.userId, userId), inArray(reminders.id, gone)));
  }
}
