/**
 * Autopilot: for the kinds a person opted into, Radar schedules the follow-up itself.
 *
 * What it does, and all it does: for up to `RADAR_AUTOPILOT_PER_RUN` of the nightly run's
 * Today cards of an opted-in kind, it puts a follow-up on the calendar (the same
 * `scheduleContactFollowUpForUser` the card's Schedule button uses) and marks the card
 * `auto_applied`, remembering exactly which reminder it set. It never sends anything, never
 * touches a contact that already has a follow-up, and every action has an Undo that removes
 * the reminder only while it is still the one autopilot set.
 *
 * An autopilot action is not the person's vote: the learned model ignores `auto_applied`
 * cards unless a conversation followed (`loadModelTallies`).
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, recommendationFeedback, recommendations, reminders, userSettings } from "@/db/schema";
import { scheduleContactFollowUpForUser } from "@/lib/reminder-writes";
import { reportUnlessQuiet } from "@/lib/report-error";
import { recordFeedback } from "@/lib/radar/store";
import {
  RECOMMENDATION_KINDS,
  type RadarAutopilot,
  type RadarAutopilotAction,
  type RadarEvidence,
  type RecommendationKind,
} from "@/lib/radar/types";

export const RADAR_AUTOPILOT_PER_RUN = 5;
/** How far out autopilot schedules a follow-up. Prep cards aim at the day before instead. */
export const RADAR_AUTOPILOT_DAYS = 3;
const DAY_MS = 86_400_000;

export function enabledAutopilotKinds(settings: RadarAutopilot | null | undefined): RecommendationKind[] {
  if (!settings) return [];
  return RECOMMENDATION_KINDS.filter((k) => settings[k] === true);
}

export async function loadRadarAutopilot(userId: string): Promise<RadarAutopilot> {
  const db = await getDb();
  const [row] = await db
    .select({ autopilot: userSettings.radarAutopilot })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  return row?.autopilot ?? {};
}

/**
 * Days until the follow-up for one card. For prep, the day before the meeting; null when
 * the meeting is too close for that to help.
 */
export function autopilotDays(kind: RecommendationKind, evidence: readonly RadarEvidence[], now: Date): number | null {
  if (kind !== "prep") return RADAR_AUTOPILOT_DAYS;
  const at = evidence.map((e) => (e.at ? new Date(e.at).getTime() : NaN)).find((t) => Number.isFinite(t) && t > now.getTime());
  if (at === undefined) return null;
  const days = Math.floor((at - now.getTime()) / DAY_MS) - 1;
  return days >= 1 ? days : null;
}

/** Act on this run's Today cards of the opted-in kinds. Returns how many. Never throws. */
export async function applyAutopilot(userId: string, settings: RadarAutopilot, now: Date): Promise<number> {
  const kinds = enabledAutopilotKinds(settings);
  if (kinds.length === 0) return 0;
  const db = await getDb();
  const targets = rowsOf<{ id: string; contact_id: string; kind: RecommendationKind; evidence: RadarEvidence[] }>(
    await db.execute(sql`
      SELECT r.id, r.contact_id, r.kind, r.evidence
        FROM recommendations r
        JOIN contacts c ON c.id = r.contact_id AND c.user_id = r.user_id
       WHERE r.user_id = ${userId}
         AND r.status = 'pending'
         AND r.bucket = 'today'
         AND r.kind IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})
         AND c.next_follow_up_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM reminders m
            WHERE m.user_id = r.user_id AND m.contact_id = r.contact_id AND m.status = 'pending'
         )
       ORDER BY r.score DESC, r.id
       LIMIT ${RADAR_AUTOPILOT_PER_RUN}
    `)
  );
  let applied = 0;
  for (const t of targets) {
    const days = autopilotDays(t.kind, t.evidence ?? [], now);
    if (days === null) continue;
    try {
      const result = await scheduleContactFollowUpForUser(userId, t.contact_id, days);
      const action: RadarAutopilotAction = {
        reminderId: result.reminder!.id,
        dueDate: result.dueDate,
        at: now.toISOString(),
      };
      await db
        .update(recommendations)
        .set({ status: "auto_applied", actedAt: now, autopilot: action, updatedAt: now })
        .where(and(eq(recommendations.id, t.id), eq(recommendations.userId, userId), eq(recommendations.status, "pending")));
      await recordFeedback(userId, { contactId: t.contact_id, recommendationId: t.id, kind: t.kind, action: "accepted", reason: "autopilot" });
      applied++;
    } catch (err) {
      reportUnlessQuiet(err, { where: "job.radar.autopilot", userId, level: "warning" });
    }
  }
  return applied;
}

/**
 * Undo one autopilot action: remove the reminder it set (only while it is still pending and
 * still due when autopilot set it), clear the contact's follow-up date if it is still that
 * one, and retire the card without counting it against its kind.
 */
export async function undoAutopilotForUser(userId: string, id: string): Promise<{ ok: boolean; cleared: boolean }> {
  const db = await getDb();
  const [rec] = await db
    .select({ id: recommendations.id, contactId: recommendations.contactId, status: recommendations.status, autopilot: recommendations.autopilot })
    .from(recommendations)
    .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)))
    .limit(1);
  if (!rec || rec.status !== "auto_applied") return { ok: false, cleared: false };
  const now = new Date();
  let cleared = false;
  if (rec.autopilot) {
    const due = new Date(rec.autopilot.dueDate);
    const removed = await db
      .delete(reminders)
      .where(
        and(
          eq(reminders.id, rec.autopilot.reminderId),
          eq(reminders.userId, userId),
          eq(reminders.status, "pending"),
          eq(reminders.dueDate, due)
        )
      )
      .returning();
    if (removed.length > 0) {
      cleared = true;
      await db
        .update(contacts)
        .set({ nextFollowUpAt: null, followUpStatus: "none", updatedAt: now })
        .where(and(eq(contacts.id, rec.contactId), eq(contacts.userId, userId), eq(contacts.nextFollowUpAt, due)));
    }
  }
  // `expired`, not `dismissed`: undoing autopilot is not a vote against the kind.
  await db
    .update(recommendations)
    .set({ status: "expired", resolvedAt: now, updatedAt: now })
    .where(and(eq(recommendations.id, id), eq(recommendations.userId, userId)));
  await db
    .delete(recommendationFeedback)
    .where(and(eq(recommendationFeedback.userId, userId), eq(recommendationFeedback.recommendationId, id)));
  return { ok: true, cleared };
}
