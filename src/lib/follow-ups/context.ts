import { and, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactDates,
  contactExperiences,
  contacts,
  eventAttendees,
  events,
  followUpSuggestions,
  followUpSuppressions,
  followUpWeights,
  interactions,
  reminders,
  userSettings,
} from "@/db/schema";
import type { Suppression, WeightRow } from "./score";
import { isoDay, startOfDay } from "./time";
import type {
  ContactDateSnapshot,
  ContactSnapshot,
  EventAttendanceSnapshot,
  ExperienceSnapshot,
  InteractionSnapshot,
  SignalContext,
} from "./types";

/**
 * How far back interactions are read.
 *
 * `thread_quiet` caps at 90 days and `open_loop` at 120, so 400 covers every source
 * with room for the anniversary sources' anchors. Unbounded would mean loading a
 * decade of history to answer a question about the last four months.
 */
const INTERACTION_WINDOW_DAYS = 400;
const INTERACTION_ROW_CAP = 5000;

/**
 * Everything every signal source needs, in a fixed number of statements.
 *
 * This is the whole reason sources are pure functions over a context rather than
 * things that query: thirteen sources each asking about each contact is the query
 * storm `smoke-page-budgets.ts` exists to prevent.
 */
export async function loadSignalContext(
  userId: string,
  now: Date
): Promise<SignalContext> {
  const db = await getDb();
  const windowStart = new Date(now.getTime() - INTERACTION_WINDOW_DAYS * 86_400_000);

  const [
    contactRows,
    interactionRows,
    experienceRows,
    dateRows,
    attendanceRows,
    pendingReminderRows,
  ] = await Promise.all([
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      // Projected to exactly what the snapshot carries. Unprojected, this loads inline
      // avatar data URLs and every note for the whole network.
      columns: {
        id: true,
        fullName: true,
        preferredName: true,
        title: true,
        company: true,
        closenessTier: true,
        priorityLevel: true,
        relationshipScore: true,
        constellationPin: true,
        dateMet: true,
        firstInteractionAt: true,
        lastInteractionAt: true,
        nextFollowUpAt: true,
      },
    }),
    db.query.interactions.findMany({
      where: and(
        eq(interactions.userId, userId),
        gte(interactions.interactionDate, windowStart)
      ),
      columns: {
        contactId: true,
        interactionType: true,
        interactionDate: true,
        direction: true,
        rawNotes: true,
        aiSummary: true,
        actionItems: true,
      },
      orderBy: [desc(interactions.interactionDate)],
      limit: INTERACTION_ROW_CAP,
    }),
    db.query.contactExperiences.findMany({
      where: and(
        eq(contactExperiences.userId, userId),
        eq(contactExperiences.isCurrent, true)
      ),
      columns: {
        contactId: true,
        organization: true,
        isCurrent: true,
        startYear: true,
        startMonth: true,
      },
    }),
    db.query.contactDates.findMany({
      where: eq(contactDates.userId, userId),
      columns: { contactId: true, kind: true, label: true, month: true, day: true, year: true },
    }),
    db
      .select({
        contactId: eventAttendees.contactId,
        eventId: events.id,
        title: events.title,
        startsAt: events.startsAt,
      })
      .from(eventAttendees)
      .innerJoin(events, eq(eventAttendees.eventId, events.id))
      .where(
        and(
          eq(eventAttendees.userId, userId),
          isNotNull(eventAttendees.contactId),
          isNotNull(events.startsAt),
          gte(events.startsAt, windowStart)
        )
      ),
    db.query.reminders.findMany({
      where: and(
        eq(reminders.userId, userId),
        eq(reminders.status, "pending"),
        isNotNull(reminders.contactId)
      ),
      columns: { contactId: true, title: true, dueDate: true },
    }),
  ]);

  const interactionsByContact = new Map<string, InteractionSnapshot[]>();
  for (const row of interactionRows) {
    const list = interactionsByContact.get(row.contactId) ?? [];
    list.push({
      contactId: row.contactId,
      interactionType: row.interactionType,
      interactionDate: row.interactionDate ?? now,
      direction: row.direction,
      text: (row.rawNotes || row.aiSummary || "").trim(),
      actionItems: row.actionItems ?? [],
    });
    interactionsByContact.set(row.contactId, list);
  }
  // The query ordered globally by date, which is per-contact ordering too — but only
  // because every contact's rows keep their relative order inside a stable sort. Sources
  // rely on [0] being the newest, so assert it rather than assume it.
  for (const list of interactionsByContact.values()) {
    list.sort((a, b) => b.interactionDate.getTime() - a.interactionDate.getTime());
  }

  const experiencesByContact = new Map<string, ExperienceSnapshot[]>();
  for (const row of experienceRows) {
    const list = experiencesByContact.get(row.contactId) ?? [];
    list.push(row as ExperienceSnapshot);
    experiencesByContact.set(row.contactId, list);
  }

  const datesByContact = new Map<string, ContactDateSnapshot[]>();
  for (const row of dateRows) {
    const list = datesByContact.get(row.contactId) ?? [];
    list.push(row);
    datesByContact.set(row.contactId, list);
  }

  const eventsByContact = new Map<string, EventAttendanceSnapshot[]>();
  for (const row of attendanceRows) {
    if (!row.contactId || !row.startsAt) continue;
    const list = eventsByContact.get(row.contactId) ?? [];
    list.push({
      contactId: row.contactId,
      eventId: row.eventId,
      title: row.title,
      startsAt: row.startsAt,
    });
    eventsByContact.set(row.contactId, list);
  }

  const contactsWithPendingReminder = new Set<string>();
  const dueCommitments: SignalContext["dueCommitments"] = [];
  for (const row of pendingReminderRows) {
    if (!row.contactId) continue;
    contactsWithPendingReminder.add(row.contactId);
    if (row.dueDate && row.dueDate <= now) {
      dueCommitments.push({ contactId: row.contactId, title: row.title, dueDate: row.dueDate });
    }
  }

  return {
    userId,
    now,
    contacts: contactRows as ContactSnapshot[],
    interactionsByContact,
    experiencesByContact,
    datesByContact,
    eventsByContact,
    contactsWithPendingReminder,
    dueCommitments,
  };
}

/**
 * The scoring-side inputs: suppressions, learned weights, the user's cap, and how much
 * of today's cap is already spent.
 */
export async function loadScoringInputs(userId: string, now: Date) {
  const db = await getDb();
  // Same day basis every `dueOn` is written in — see `isoDay`'s doc comment. Must stay
  // in lockstep with `pass.ts`'s `isoDay(candidate.dueOn)`, or the count below silently
  // stops matching the rows it is meant to count.
  const today = isoDay(startOfDay(now));

  const [suppressionRows, weightRows, pendingSuggestionRows, settings, todayRows] =
    await Promise.all([
      db.query.followUpSuppressions.findMany({
        where: and(
          eq(followUpSuppressions.userId, userId),
          or(
            sql`${followUpSuppressions.until} IS NULL`,
            gte(followUpSuppressions.until, now)
          )
        ),
        columns: { contactId: true, kind: true, until: true },
      }),
      db.query.followUpWeights.findMany({
        where: eq(followUpWeights.userId, userId),
      }),
      db.query.followUpSuggestions.findMany({
        where: and(
          eq(followUpSuggestions.userId, userId),
          inArray(followUpSuggestions.status, ["pending", "snoozed"])
        ),
        columns: { contactId: true },
      }),
      db.query.userSettings.findFirst({
        where: eq(userSettings.userId, userId),
        columns: { followUpDailyCap: true },
      }),
      // Status-agnostic on purpose: a suggestion the user dismissed minutes after an
      // earlier run today still spent that day's budget, and re-surfacing a
      // replacement for the slot it vacated is exactly the over-surfacing the daily
      // cap (as opposed to a per-invocation one) exists to prevent.
      db.query.followUpSuggestions.findMany({
        where: and(
          eq(followUpSuggestions.userId, userId),
          eq(followUpSuggestions.dueOn, today)
        ),
        columns: { id: true },
      }),
    ]);

  return {
    suppressions: suppressionRows as Suppression[],
    weightsByKind: new Map(weightRows.map((r) => [r.kind, r as WeightRow])),
    contactsWithPendingSuggestion: new Set(pendingSuggestionRows.map((r) => r.contactId)),
    dailyCap: settings?.followUpDailyCap ?? 3,
    suggestionsWrittenToday: todayRows.length,
  };
}
