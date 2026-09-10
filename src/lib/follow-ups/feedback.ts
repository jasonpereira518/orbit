import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contacts,
  followUpSuggestions,
  followUpSuppressions,
  followUpWeights,
  interactions,
  reminders,
} from "@/db/schema";
import { SIGNAL_TRIGGER } from "./registry";
import { WEIGHT_MAX, WEIGHT_MIN, WEIGHT_MIN_SHOWN } from "./score";

/** Acting on a suggestion means this person was just contacted. */
export const ACCEPT_SUPPRESSION_DAYS = 30;
/** Long enough that a rejected reason does not come back next week. */
export const DISMISS_SUPPRESSION_DAYS = 60;

/**
 * The kinds that treat absence-of-contact as their evidence — the same set
 * `refutedByRecentContact` in `score.ts` reads off `SIGNAL_TRIGGER`. Derived rather
 * than hardcoded so a kind added to the registry is classified once and both
 * mechanisms follow automatically.
 */
const STALENESS_KINDS = Object.entries(SIGNAL_TRIGGER)
  .filter(([, trigger]) => trigger === "staleness")
  .map(([kind]) => kind);

function daysFromNow(days: number, now: Date) {
  return new Date(now.getTime() + days * 86_400_000);
}

async function loadOwned(userId: string, suggestionId: string) {
  const db = await getDb();
  const row = await db.query.followUpSuggestions.findFirst({
    where: and(
      eq(followUpSuggestions.id, suggestionId),
      eq(followUpSuggestions.userId, userId)
    ),
  });
  if (!row) throw new Error("Suggestion not found");
  return row;
}

/**
 * Accept: this is the ONLY path that turns a suggestion into a `reminders` row.
 *
 * Until this runs, the suggestion is invisible to `listDueNotificationItems` and the
 * ICS feed. That boundary is the whole reason `follow_up_suggestions` is a separate
 * table, and it must not be crossed anywhere else.
 */
export async function acceptSuggestion(
  userId: string,
  suggestionId: string,
  options: { now?: Date } = {}
) {
  const now = options.now ?? new Date();
  const db = await getDb();
  const suggestion = await loadOwned(userId, suggestionId);

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, suggestion.contactId), eq(contacts.userId, userId)),
    columns: { id: true, fullName: true, preferredName: true },
  });
  if (!contact) throw new Error("Contact not found");

  const name = contact.preferredName?.trim() || contact.fullName;
  const [reminder] = await db
    .insert(reminders)
    .values({
      userId,
      contactId: suggestion.contactId,
      title: `Follow up with ${name}`,
      description: suggestion.reason,
      dueDate: now,
      status: "pending",
      reminderType: "generated",
      actionKind: "follow_up",
      createdBy: "system",
    })
    .returning();

  await db
    .update(followUpSuggestions)
    .set({ status: "accepted", reminderId: reminder.id, resolvedAt: now })
    .where(eq(followUpSuggestions.id, suggestionId));

  // Only now does the engine touch `next_follow_up_at`, and only because the user
  // asked. The old `generateDueFollowUps` wrote it speculatively, which made a system
  // guess indistinguishable from a date the user chose.
  await db
    .update(contacts)
    .set({ nextFollowUpAt: now, followUpStatus: "pending", updatedAt: now })
    .where(and(eq(contacts.id, suggestion.contactId), eq(contacts.userId, userId)));

  await bumpWeight(userId, suggestion.primaryKind, { accepted: 1 });

  // Acceptance means "you just contacted this person, so stop telling me they have
  // gone quiet" — it silences only the staleness-triggered kinds, one suppression row
  // per kind. It deliberately does NOT touch date-triggered kinds: talking to someone
  // yesterday does not make it any less their birthday, matching the split
  // `refutedByRecentContact` already draws. (A contact-wide `kind: null` suppression
  // would have silenced those too, which is the bug this loop fixes.)
  //
  // Note: a contact with an open accepted follow-up is already excluded by filter 4
  // (`contactsWithPendingReminder`) for as long as that reminder is pending, so this
  // suppression's real job only starts once the reminder is completed and the contact
  // becomes eligible for staleness signals again.
  for (const kind of STALENESS_KINDS) {
    await suppress(userId, {
      contactId: suggestion.contactId,
      kind,
      until: daysFromNow(ACCEPT_SUPPRESSION_DAYS, now),
      reason: "acted",
    });
  }

  return { reminderId: reminder.id, contactId: suggestion.contactId };
}

export async function snoozeSuggestion(
  userId: string,
  suggestionId: string,
  days: number,
  options: { now?: Date } = {}
) {
  const now = options.now ?? new Date();
  const db = await getDb();
  const suggestion = await loadOwned(userId, suggestionId);
  // Same 1..90 clamp as `snoozeReminder` in `src/lib/reminders.ts`. Two paths that
  // both defer a follow-up must not disagree about what a day count means.
  const clamped = Math.max(1, Math.min(90, days));
  await db
    .update(followUpSuggestions)
    .set({ status: "snoozed", snoozedUntil: daysFromNow(clamped, now) })
    .where(eq(followUpSuggestions.id, suggestionId));
  return { contactId: suggestion.contactId };
}

export async function dismissSuggestion(
  userId: string,
  suggestionId: string,
  reason: "not_now" | "wrong_reason" | "stop_this_kind",
  options: { now?: Date } = {}
) {
  const now = options.now ?? new Date();
  const db = await getDb();
  const suggestion = await loadOwned(userId, suggestionId);

  await db
    .update(followUpSuggestions)
    .set({ status: "dismissed", dismissedReason: reason, resolvedAt: now })
    .where(eq(followUpSuggestions.id, suggestionId));

  await bumpWeight(userId, suggestion.primaryKind, { dismissed: 1 });

  if (reason === "stop_this_kind") {
    // An explicit "never again" is a permanent kind-wide mute, not a timed suppression.
    await muteKind(userId, suggestion.primaryKind);
    return { contactId: suggestion.contactId };
  }

  await suppress(userId, {
    contactId: suggestion.contactId,
    // "not_now" is about timing, so it silences this person entirely for a while.
    // "wrong_reason" is about the reason, so it silences only this kind for them.
    kind: reason === "wrong_reason" ? suggestion.primaryKind : null,
    until: daysFromNow(DISMISS_SUPPRESSION_DAYS, now),
    reason: "dismissed",
  });

  return { contactId: suggestion.contactId };
}

/** Permanent, contact-wide. `until = null` is what makes it a mute rather than a snooze. */
export async function muteContact(userId: string, contactId: string) {
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { id: true },
  });
  if (!contact) throw new Error("Contact not found");
  await suppress(userId, { contactId, kind: null, until: null, reason: "muted_contact" });
}

/** Permanent, kind-wide across every contact. */
export async function muteKind(userId: string, kind: string) {
  await suppress(userId, { contactId: null, kind, until: null, reason: "muted_kind" });
}

/**
 * "I already messaged them, outside Orbit."
 *
 * Logs the interaction rather than only closing the card. Without the interaction the
 * engine still believes nothing happened and re-fires next week — the failure that
 * teaches users to stop trusting it. Logging it also feeds the 7-day hard filter, so
 * the noise filter and the feedback loop end up being the same mechanism.
 */
export async function markSuggestionSent(
  userId: string,
  suggestionId: string,
  options: { now?: Date } = {}
) {
  const now = options.now ?? new Date();
  const db = await getDb();
  const suggestion = await loadOwned(userId, suggestionId);

  await db.insert(interactions).values({
    userId,
    contactId: suggestion.contactId,
    interactionType: "reach_out",
    interactionDate: now,
    direction: "out",
    rawNotes: "Marked as sent from a follow-up suggestion",
  });

  await db
    .update(contacts)
    .set({ lastInteractionAt: now, updatedAt: now })
    .where(and(eq(contacts.id, suggestion.contactId), eq(contacts.userId, userId)));

  await db
    .update(followUpSuggestions)
    .set({ status: "accepted", resolvedAt: now })
    .where(eq(followUpSuggestions.id, suggestionId));

  await bumpWeight(userId, suggestion.primaryKind, { accepted: 1 });

  return { contactId: suggestion.contactId };
}

async function suppress(
  userId: string,
  row: { contactId: string | null; kind: string | null; until: Date | null; reason: string }
) {
  const db = await getDb();
  await db.insert(followUpSuppressions).values({ userId, ...row });
}

async function bumpWeight(
  userId: string,
  kind: string,
  delta: { accepted?: number; dismissed?: number }
) {
  const db = await getDb();
  const accepted = delta.accepted ?? 0;
  const dismissed = delta.dismissed ?? 0;
  await db
    .insert(followUpWeights)
    .values({ userId, kind, accepted, dismissed })
    .onConflictDoUpdate({
      target: [followUpWeights.userId, followUpWeights.kind],
      set: {
        accepted: sql`${followUpWeights.accepted} + ${accepted}`,
        dismissed: sql`${followUpWeights.dismissed} + ${dismissed}`,
        updatedAt: new Date(),
      },
    });
  await recomputeWeight(userId, kind);
}

/**
 * Recompute one kind's stored multiplier.
 *
 * Mirrors `userWeight` in `score.ts` exactly, including the `WEIGHT_MIN_SHOWN` pin.
 * The stored value is what the admin surface and any future explanation read; scoring
 * itself recomputes from the counters, so the two can never silently drift into
 * disagreement about what the number means.
 */
export async function recomputeWeight(userId: string, kind: string) {
  const db = await getDb();
  const rows = await db.query.followUpWeights.findMany({
    where: eq(followUpWeights.userId, userId),
  });
  const row = rows.find((r) => r.kind === kind);
  if (!row) return;

  if (row.shown < WEIGHT_MIN_SHOWN) {
    await db
      .update(followUpWeights)
      .set({ weight: 1 })
      .where(and(eq(followUpWeights.userId, userId), eq(followUpWeights.kind, kind)));
    return;
  }

  const eligible = rows.filter((r) => r.shown >= WEIGHT_MIN_SHOWN);
  const mean =
    eligible.reduce((acc, r) => acc + (r.accepted + 1) / (r.shown + 2), 0) /
    Math.max(1, eligible.length);
  const rate = (row.accepted + 1) / (row.shown + 2);
  const weight = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, rate / Math.max(0.01, mean)));

  await db
    .update(followUpWeights)
    .set({ weight })
    .where(and(eq(followUpWeights.userId, userId), eq(followUpWeights.kind, kind)));
}
