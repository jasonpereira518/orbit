/**
 * What a person can do to a Radar card, as request-free functions that take `userId`, so
 * the server actions stay thin and the smoke can drive the same code.
 *
 * Every write is scoped to the owner's rows. Every action records feedback, because the
 * next run reads it: that is what makes a dismissal stick overnight.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { recommendationFeedback, recommendations } from "@/db/schema";
import { scheduleContactFollowUpForUser } from "@/lib/reminder-writes";
import { settleJobChangeCongratsForUser } from "@/lib/job-changes";
import { recordFeedback } from "@/lib/radar/store";
import { LIVE_RECOMMENDATION_STATUSES } from "@/lib/radar/types";

const DAY_MS = 86_400_000;

export const SNOOZE_DAYS = { "1w": 7, "1m": 30 } as const;
export type SnoozeLength = keyof typeof SNOOZE_DAYS;
export const SCHEDULE_DAYS = [3, 7, 14] as const;
export type ScheduleDays = (typeof SCHEDULE_DAYS)[number];

async function ownedPending(userId: string, id: string) {
  const db = await getDb();
  const [row] = await db
    .select({ id: recommendations.id, contactId: recommendations.contactId, kind: recommendations.kind, status: recommendations.status })
    .from(recommendations)
    .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** Put a follow-up on the calendar and retire the card. */
export async function scheduleRecommendationForUser(userId: string, id: string, days: ScheduleDays) {
  const rec = await ownedPending(userId, id);
  if (!rec || rec.status !== "pending") return { ok: false as const };
  const result = await scheduleContactFollowUpForUser(userId, rec.contactId, days);
  const db = await getDb();
  const now = new Date();
  await db
    .update(recommendations)
    .set({ status: "accepted", resolvedAt: now, actedAt: now, updatedAt: now })
    .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)));
  await recordFeedback(userId, { contactId: rec.contactId, recommendationId: id, kind: rec.kind, action: "accepted" });
  return { ok: true as const, contactId: rec.contactId, dueDate: result.dueDate };
}

export async function snoozeRecommendationForUser(userId: string, id: string, length: SnoozeLength) {
  const rec = await ownedPending(userId, id);
  if (!rec || rec.status !== "pending") return { ok: false as const };
  const db = await getDb();
  const now = new Date();
  await db
    .update(recommendations)
    .set({ status: "snoozed", snoozedUntil: new Date(now.getTime() + SNOOZE_DAYS[length] * DAY_MS), actedAt: now, updatedAt: now })
    .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)));
  await recordFeedback(userId, { contactId: rec.contactId, recommendationId: id, kind: rec.kind, action: "snoozed" });
  return { ok: true as const };
}

export async function dismissRecommendationForUser(userId: string, id: string) {
  const rec = await ownedPending(userId, id);
  if (!rec || rec.status !== "pending") return { ok: false as const };
  const db = await getDb();
  const now = new Date();
  await db
    .update(recommendations)
    .set({ status: "dismissed", resolvedAt: now, actedAt: now, updatedAt: now })
    .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)));
  await recordFeedback(userId, { contactId: rec.contactId, recommendationId: id, kind: rec.kind, action: "dismissed" });
  return { ok: true as const };
}

/** "Not for this person": no card about them, of any kind, ever. */
export async function neverForContactForUser(userId: string, id: string) {
  const rec = await ownedPending(userId, id);
  if (!rec) return { ok: false as const };
  const db = await getDb();
  const now = new Date();
  await db
    .update(recommendations)
    .set({ status: "dismissed", resolvedAt: now, actedAt: now, updatedAt: now })
    .where(
      and(
        eq(recommendations.userId, userId),
        eq(recommendations.contactId, rec.contactId),
        inArray(recommendations.status, [...LIVE_RECOMMENDATION_STATUSES])
      )
    );
  await recordFeedback(userId, { contactId: rec.contactId, recommendationId: id, kind: null, action: "never" });
  return { ok: true as const };
}

/**
 * Undo for dismiss, snooze and "not for this person": the card comes back as it was, and
 * the feedback that would have suppressed it is removed. `restored: false` when a newer card
 * about the same person and kind already took its place.
 */
export async function restoreRecommendationForUser(userId: string, id: string) {
  const db = await getDb();
  const [rec] = await db
    .select({ contactId: recommendations.contactId, status: recommendations.status })
    .from(recommendations)
    .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)))
    .limit(1);
  if (!rec || rec.status === "pending") return { restored: rec?.status === "pending" };
  try {
    await db
      .update(recommendations)
      .set({ status: "pending", snoozedUntil: null, resolvedAt: null, actedAt: null, updatedAt: new Date() })
      .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)));
  } catch {
    // The live unique index: a later run already raised this person again.
    return { restored: false };
  }
  await db
    .delete(recommendationFeedback)
    .where(
      and(
        eq(recommendationFeedback.userId, userId),
        eq(recommendationFeedback.recommendationId, id),
        inArray(recommendationFeedback.action, ["dismissed", "snoozed", "never"])
      )
    );
  return { restored: true };
}

/**
 * The person wrote to this contact (an email from a card's sheet, or any follow-up send):
 * every pending card about them is answered. `at` is the send time, so the send's own
 * interaction counts as the outcome (`detectRadarOutcomes` wants interaction_date >= acted_at).
 */
export async function markContactRecommendationsActedForUser(userId: string, contactId: string, at: Date) {
  const db = await getDb();
  const acted = await db
    .update(recommendations)
    .set({ status: "accepted", resolvedAt: at, actedAt: at, updatedAt: new Date() })
    .where(
      and(eq(recommendations.userId, userId), eq(recommendations.contactId, contactId), eq(recommendations.status, "pending"))
    )
    .returning();
  for (const rec of acted) {
    await recordFeedback(userId, { contactId, recommendationId: rec.id, kind: rec.kind, action: "accepted" });
  }
}

/**
 * The person reached out to this contact — an email sent from Orbit, or a message they
 * marked sent (LinkedIn has no send API). Their pending Radar cards are answered and any
 * congratulations nudge retires. Every "I wrote to them" path calls this one function.
 */
export async function markContactReachedOutForUser(userId: string, contactId: string, at: Date) {
  await markContactRecommendationsActedForUser(userId, contactId, at);
  await settleJobChangeCongratsForUser(userId, contactId);
}
