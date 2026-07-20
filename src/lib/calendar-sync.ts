import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  calendarSubscriptions,
  contacts,
  interactions,
  reminders,
  type Contact,
} from "@/db/schema";
import { parseIcsEvents, type ParsedCalendarEvent } from "@/lib/calendar-import";
import {
  classifyCalendarEvent,
  counterpartsOf,
  nameFromNetworkingTitle,
} from "@/lib/calendar-classify";
import { findDuplicateCandidates, daysAgo } from "@/lib/duplicates";
import { upsertContactEmbedding } from "@/lib/search";
import { refreshOutreachSuggestions } from "@/lib/reminders";

const SYNC_WINDOW_PAST_MS = 90 * 86400000;
const SYNC_WINDOW_FUTURE_MS = 60 * 86400000;
export const CALENDAR_SYNC_STALE_MS = 30 * 60 * 1000;

export type CalendarSyncStats = {
  scanned: number;
  matched: number;
  created: number;
  updated: number;
  contactsCreated: number;
  skipped: number;
};

function meetingNote(event: ParsedCalendarEvent) {
  return [
    event.summary ? `Meeting: ${event.summary}` : "Calendar meeting",
    event.location ? `Location: ${event.location}` : "",
    event.description ? event.description.slice(0, 500) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function externalIdFor(eventUid: string, contactId: string) {
  return `cal:${eventUid}:${contactId}`;
}

async function fetchIcs(url: string) {
  const res = await fetch(url, {
    headers: {
      Accept: "text/calendar, text/plain, */*",
      "User-Agent": "OrbitNetworkingTracker/1.0",
    },
    // Avoid Next fetch caching of private calendar feeds
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Calendar feed returned ${res.status}`);
  }
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text) && !/BEGIN:VEVENT/i.test(text)) {
    throw new Error("URL did not return a valid ICS calendar feed");
  }
  return text;
}

async function resolveOrCreateContact(
  userId: string,
  existing: Contact[],
  person: { name: string; email: string },
  titleHint: string | null
): Promise<{ contact: Contact; created: boolean; list: Contact[] }> {
  const db = await getDb();
  const fullName = person.name || titleHint || person.email.split("@")[0] || "Calendar contact";

  const dups = findDuplicateCandidates(existing, {
    fullName: person.name || titleHint || undefined,
    email: person.email || undefined,
  });

  if (dups[0] && dups[0].confidence >= 0.6) {
    const contact = dups[0].contact;
    if (person.email && !contact.email) {
      const [updated] = await db
        .update(contacts)
        .set({ email: person.email, updatedAt: new Date() })
        .where(and(eq(contacts.id, contact.id), eq(contacts.userId, userId)))
        .returning();
      const list = existing.map((c) => (c.id === contact.id ? updated : c));
      return { contact: updated, created: false, list };
    }
    return { contact, created: false, list: existing };
  }

  const parts = fullName.trim().split(/\s+/);
  const [created] = await db
    .insert(contacts)
    .values({
      userId,
      fullName,
      firstName: parts[0],
      lastName: parts.length > 1 ? parts.slice(1).join(" ") : undefined,
      email: person.email || undefined,
      source: "calendar_sync",
      relationshipScore: 2,
      metContext: "event",
      howMet: "Calendar meeting",
      firstInteractionAt: new Date(),
      lastInteractionAt: new Date(),
    })
    .returning();

  return { contact: created, created: true, list: [...existing, created] };
}

export async function applyNetworkingEvents(
  userId: string,
  events: ParsedCalendarEvent[],
  options?: {
    selfEmails?: string[];
    createFollowUps?: boolean;
    source?: string;
  }
): Promise<CalendarSyncStats> {
  const db = await getDb();
  const selfEmails = options?.selfEmails || [];
  const createFollowUps = options?.createFollowUps !== false;
  const source = options?.source || "calendar_sync";

  const now = Date.now();
  const windowed = events.filter((e) => {
    if (!e.start) return false;
    const t = e.start.getTime();
    return t >= now - SYNC_WINDOW_PAST_MS && t <= now + SYNC_WINDOW_FUTURE_MS;
  });

  let existing = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });

  const stats: CalendarSyncStats = {
    scanned: windowed.length,
    matched: 0,
    created: 0,
    updated: 0,
    contactsCreated: 0,
    skipped: 0,
  };

  for (const event of windowed) {
    const classification = classifyCalendarEvent(event, selfEmails);
    if (!classification.keep) {
      stats.skipped++;
      continue;
    }

    stats.matched++;
    let counterparts = counterpartsOf(event, selfEmails);

    if (counterparts.length === 0) {
      const inferred = nameFromNetworkingTitle(event.summary || "");
      if (inferred) {
        counterparts = [{ name: inferred, email: "" }];
      } else {
        stats.skipped++;
        continue;
      }
    }

    // Cap at 3 people for networking events
    counterparts = counterparts.slice(0, 3);

    const eventDate = event.start || new Date();
    const isPast = eventDate.getTime() <= now;
    const note = meetingNote(event);
    const titleHint = nameFromNetworkingTitle(event.summary || "");

    for (const person of counterparts) {
      const resolved = await resolveOrCreateContact(
        userId,
        existing,
        person,
        titleHint
      );
      existing = resolved.list;
      if (resolved.created) stats.contactsCreated++;

      const contact = resolved.contact;
      const externalId = externalIdFor(event.uid, contact.id);

      const prior = await db.query.interactions.findFirst({
        where: and(
          eq(interactions.userId, userId),
          eq(interactions.externalId, externalId)
        ),
      });

      if (prior) {
        await db
          .update(interactions)
          .set({
            interactionDate: eventDate,
            rawNotes: note,
            aiSummary: event.summary || "Calendar meeting",
            topics: event.summary ? [event.summary] : [],
            source,
          })
          .where(eq(interactions.id, prior.id));
        stats.updated++;
      } else {
        await db.insert(interactions).values({
          userId,
          contactId: contact.id,
          interactionType: "meeting",
          interactionDate: eventDate,
          source,
          externalId,
          rawNotes: note,
          aiSummary: event.summary || "Calendar meeting",
          topics: event.summary ? [event.summary] : [],
        });
        stats.created++;
      }

      await db
        .update(contacts)
        .set({
          lastInteractionAt:
            !contact.lastInteractionAt || eventDate > contact.lastInteractionAt
              ? eventDate
              : contact.lastInteractionAt,
          firstInteractionAt:
            !contact.firstInteractionAt ||
            eventDate < contact.firstInteractionAt
              ? eventDate
              : contact.firstInteractionAt,
          nextFollowUpAt:
            !isPast && !contact.nextFollowUpAt
              ? eventDate
              : contact.nextFollowUpAt,
          email: contact.email || person.email || undefined,
          updatedAt: new Date(),
        })
        .where(and(eq(contacts.id, contact.id), eq(contacts.userId, userId)));

      await upsertContactEmbedding(
        userId,
        contact.id,
        "meeting",
        `${contact.fullName}\n${note}`,
        externalId
      );

      if (createFollowUps && isPast && daysAgo(eventDate) <= 21) {
        const existingReminder = await db.query.reminders.findFirst({
          where: and(
            eq(reminders.userId, userId),
            eq(reminders.contactId, contact.id),
            eq(reminders.reminderType, "post_meeting")
          ),
        });
        const alreadyForEvent =
          existingReminder &&
          (existingReminder.description || "").includes(event.uid);

        if (!alreadyForEvent) {
          const due = new Date(eventDate);
          due.setDate(due.getDate() + 2);
          if (due.getTime() < now) due.setTime(now + 2 * 86400000);
          await db.insert(reminders).values({
            userId,
            contactId: contact.id,
            title: `Follow up after ${event.summary || "meeting"}`,
            description: `You met with ${contact.fullName}. Event ${event.uid}`,
            dueDate: due,
            status: "pending",
            reminderType: "post_meeting",
            createdBy: "calendar_sync",
          });
        }
      }
    }
  }

  try {
    await refreshOutreachSuggestions(userId);
  } catch {
    // non-fatal
  }

  return stats;
}

export async function syncCalendarSubscription(
  userId: string,
  subscriptionId: string
): Promise<CalendarSyncStats> {
  const db = await getDb();
  const sub = await db.query.calendarSubscriptions.findFirst({
    where: and(
      eq(calendarSubscriptions.id, subscriptionId),
      eq(calendarSubscriptions.userId, userId)
    ),
  });
  if (!sub) throw new Error("Calendar subscription not found");
  if (!sub.enabled) throw new Error("Calendar subscription is disabled");

  try {
    const ics = await fetchIcs(sub.icsUrl);
    const events = parseIcsEvents(ics);
    const stats = await applyNetworkingEvents(userId, events, {
      selfEmails: sub.selfEmail ? [sub.selfEmail] : [],
      createFollowUps: true,
      source: "calendar_sync",
    });

    await db
      .update(calendarSubscriptions)
      .set({
        lastSyncedAt: new Date(),
        lastSyncStatus: "ok",
        lastSyncError: null,
        lastSyncStats: stats,
        updatedAt: new Date(),
      })
      .where(eq(calendarSubscriptions.id, sub.id));

    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    await db
      .update(calendarSubscriptions)
      .set({
        lastSyncedAt: new Date(),
        lastSyncStatus: "error",
        lastSyncError: message,
        updatedAt: new Date(),
      })
      .where(eq(calendarSubscriptions.id, sub.id));
    throw err;
  }
}

export async function syncDueCalendarSubscriptions(userId: string) {
  const db = await getDb();
  const subs = await db.query.calendarSubscriptions.findMany({
    where: and(
      eq(calendarSubscriptions.userId, userId),
      eq(calendarSubscriptions.enabled, 1)
    ),
  });

  const due = subs.filter((s) => {
    if (!s.lastSyncedAt) return true;
    return Date.now() - s.lastSyncedAt.getTime() >= CALENDAR_SYNC_STALE_MS;
  });

  const results: Array<{ id: string; stats?: CalendarSyncStats; error?: string }> =
    [];

  for (const sub of due) {
    try {
      const stats = await syncCalendarSubscription(userId, sub.id);
      results.push({ id: sub.id, stats });
    } catch (err) {
      results.push({
        id: sub.id,
        error: err instanceof Error ? err.message : "Sync failed",
      });
    }
  }

  return results;
}
