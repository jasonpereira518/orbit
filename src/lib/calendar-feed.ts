import { randomBytes } from "node:crypto";
import { and, asc, eq, gte, isNotNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, reminders, userSettings } from "@/db/schema";
import { getAppBaseUrl } from "@/lib/app-url";
import { buildIcsFeed, type IcsFeedEvent } from "@/lib/ics";

/** Bounded so a long-lived account can't produce a multi-megabyte feed. */
const PAST_WINDOW_DAYS = 90;
const FUTURE_WINDOW_DAYS = 365;
const MAX_EVENTS = 500;

/**
 * Alarm offset for all-day events. An all-day event starts at midnight *local* in the
 * client, so +9h lands a 9am local reminder — local-time alerting derived purely from a
 * floating date, with no timezone stored anywhere.
 */
const ALL_DAY_ALARM = "PT9H";
const TIMED_ALARM = "-PT15M";

/**
 * Whether a due date carries no meaningful time of day, and so should be emitted as a
 * floating all-day event.
 *
 * Two storage conventions both mean "date only" in this codebase, and each must be
 * recognized or the event degrades into a spurious half-hour meeting:
 *   - UTC midnight — `new Date("YYYY-MM-DD")`, e.g. `createReminder`.
 *   - Local noon — `atLocalNoon()`, used by extracted dates and
 *     `scheduleContactFollowUpAt`. Noon is deliberate: it keeps the calendar day stable
 *     in the UI across timezone offsets, but it is emphatically not a real appointment
 *     time, and treating it as one also risks rendering on the wrong day for viewers
 *     far from the server's timezone.
 */
export function isDateOnly(due: Date) {
  const utcMidnight =
    due.getUTCHours() === 0 &&
    due.getUTCMinutes() === 0 &&
    due.getUTCSeconds() === 0;
  const localNoon =
    due.getHours() === 12 && due.getMinutes() === 0 && due.getSeconds() === 0;
  return utcMidnight || localNoon;
}

export function generateCalendarFeedToken() {
  return randomBytes(32).toString("base64url");
}

export function buildCalendarFeedUrl(token: string) {
  return `${getAppBaseUrl()}/api/calendar/${token}.ics`;
}

export function buildCalendarFeedWebcalUrl(token: string) {
  return buildCalendarFeedUrl(token).replace(/^https?:\/\//, "webcal://");
}

/**
 * Resolves a feed token to its owner. Returns null rather than throwing so the route can
 * answer 404 without revealing whether the token merely expired.
 */
export async function findUserByFeedToken(rawToken: string) {
  const token = rawToken.replace(/\.ics$/i, "").trim();
  // Cheap floor against enumeration; real tokens are 43 chars.
  if (token.length < 24) return null;

  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.calendarFeedToken, token),
    columns: { userId: true, calendarFeedLastFetchedAt: true },
  });
  return row ?? null;
}

/** Throttled so a polling calendar client doesn't cause a write per request. */
export async function touchFeedFetchedAt(
  userId: string,
  lastFetchedAt: Date | null
) {
  const FIFTEEN_MIN = 15 * 60_000;
  if (lastFetchedAt && Date.now() - lastFetchedAt.getTime() < FIFTEEN_MIN) {
    return;
  }
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ calendarFeedLastFetchedAt: new Date() })
    .where(eq(userSettings.userId, userId));
}

export async function buildRemindersFeed(userId: string) {
  const db = await getDb();
  const now = new Date();
  const from = new Date(now.getTime() - PAST_WINDOW_DAYS * 86_400_000);
  const to = new Date(now.getTime() + FUTURE_WINDOW_DAYS * 86_400_000);

  const rows = await db
    .select({
      id: reminders.id,
      title: reminders.title,
      description: reminders.description,
      dueDate: reminders.dueDate,
      actionKind: reminders.actionKind,
      createdAt: reminders.createdAt,
      contactId: reminders.contactId,
      contactFullName: contacts.fullName,
      contactPreferredName: contacts.preferredName,
    })
    .from(reminders)
    .leftJoin(contacts, eq(reminders.contactId, contacts.id))
    .where(
      and(
        eq(reminders.userId, userId),
        eq(reminders.status, "pending"),
        // Undated reminders have no place in a calendar; inventing a date would
        // produce events that drift and alarm at the wrong time.
        isNotNull(reminders.dueDate),
        gte(reminders.dueDate, from),
        lte(reminders.dueDate, to)
      )
    )
    .orderBy(asc(reminders.dueDate))
    .limit(MAX_EVENTS);

  const baseUrl = getAppBaseUrl();

  const events: IcsFeedEvent[] = rows.map((r) => {
    const due = new Date(r.dueDate!);
    const allDay = isDateOnly(due);

    const contactName = r.contactPreferredName || r.contactFullName;
    const descriptionParts = [r.description?.trim()].filter(Boolean) as string[];
    if (contactName) descriptionParts.push(`Contact: ${contactName}`);
    descriptionParts.push(
      r.contactId ? `${baseUrl}/contacts/${r.contactId}` : `${baseUrl}/reminders`
    );

    return {
      // Stable and derived only from the immutable row id — never from the due date,
      // which snoozing mutates in place and would otherwise spawn ghost events.
      uid: `orbit-reminder-${r.id}@orbit.app`,
      summary: r.title,
      description: descriptionParts.join("\n"),
      url: r.contactId
        ? `${baseUrl}/contacts/${r.contactId}`
        : `${baseUrl}/reminders`,
      categories: r.actionKind,
      allDay,
      start: due,
      stamp: new Date(r.createdAt),
      alarmTrigger: allDay ? ALL_DAY_ALARM : TIMED_ALARM,
    };
  });

  return buildIcsFeed(events, {
    calendarName: "Orbit Reminders",
    description: "Pending reminders from Orbit",
  });
}
