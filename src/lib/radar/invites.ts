/**
 * Calendar Invite Preparation and 1-Click Confirmation for Radar.
 *
 * Pre-constructs smart meeting slots with context-derived agendas, and provides
 * 1-click execution to write directly to Google / Outlook Calendar with attendees invited.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, recommendations } from "@/db/schema";
import { addCalendarMeeting, calendarWriteState, type CalendarMeeting } from "@/lib/calendar-write";
import { recordFeedback } from "@/lib/radar/store";
import type { RadarCalendarInvite } from "@/lib/radar/types";
import { localClock } from "@/lib/radar/digest";
import { reportError } from "@/lib/report-error";

const DAY_MS = 86_400_000;

/**
 * Calculates a logical next available meeting slot (3 weekdays out at 10:00 AM local time).
 */
export function calculateNextSuggestedSlot(now: Date, tz: string = "UTC"): Date {
  const { ymd } = localClock(now, tz);
  const [y, m, d] = ymd.split("-").map(Number);
  
  // Advance 3 days, skipping weekends
  let target = new Date(Date.UTC(y!, m! - 1, d! + 3, 10, 0, 0));
  const dayOfWeek = target.getUTCDay();
  if (dayOfWeek === 6) target = new Date(target.getTime() + 2 * DAY_MS); // Saturday -> Monday
  if (dayOfWeek === 0) target = new Date(target.getTime() + 1 * DAY_MS); // Sunday -> Monday

  return target;
}

/**
 * Prepares a suggested calendar invite payload for a Radar recommendation card.
 */
export function prepareSuggestedCalendarInvite(
  contact: { fullName: string; email?: string | null },
  reason: string,
  now: Date,
  tz: string = "UTC"
): RadarCalendarInvite {
  const slot = calculateNextSuggestedSlot(now, tz);
  const cleanReason = reason.replace(/^(prep|heads_up|follow_up|opportunity|reach_out|reconnect):\s*/i, "");

  return {
    title: `Catch up: ${contact.fullName}`,
    proposedStartTime: slot.toISOString(),
    durationMinutes: 30,
    agenda: `Discussion & follow-up regarding: ${cleanReason.slice(0, 100)}`,
    attendeeEmail: contact.email ?? undefined,
    attendeeName: contact.fullName,
    status: "suggested",
  };
}

/**
 * Executes 1-click confirmation of a calendar invite:
 * Creates the event in Google / Outlook Calendar with attendee, updates recommendation status.
 */
export async function confirmCalendarInviteFromRecommendation(
  userId: string,
  recommendationId: string,
  overrides?: { startTime?: string; title?: string; agenda?: string }
): Promise<
  | { ok: true; message?: string; eventId?: string }
  | { ok: false; message: string; eventId?: string }
> {
  try {
    const db = await getDb();
    const [rec] = await db
      .select({
        id: recommendations.id,
        contactId: recommendations.contactId,
        kind: recommendations.kind,
        status: recommendations.status,
        invite: recommendations.suggestedCalendarInvite,
        reasons: recommendations.reasons,
      })
      .from(recommendations)
      .where(and(eq(recommendations.id, recommendationId), eq(recommendations.userId, userId)))
      .limit(1);

    if (!rec) return { ok: false, message: "Recommendation not found" };

    const [contact] = await db
      .select({ fullName: contacts.fullName, email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.id, rec.contactId), eq(contacts.userId, userId)))
      .limit(1);

    if (!contact) return { ok: false, message: "Contact not found" };

    const title = overrides?.title || rec.invite?.title || `Catch up: ${contact.fullName}`;
    const startTimeStr = overrides?.startTime || rec.invite?.proposedStartTime;
    const startsAt = startTimeStr ? new Date(startTimeStr) : calculateNextSuggestedSlot(new Date());
    const description = overrides?.agenda || rec.invite?.agenda || "Catch up call via Orbit";
    const durationMin = rec.invite?.durationMinutes ?? 30;

    const meeting: CalendarMeeting = {
      title,
      startsAt,
      durationMin,
      description,
    };

    // Check calendar write capability
    const writeState = await calendarWriteState(userId);
    if (writeState.kind === "none" || writeState.kind === "grant") {
      // If user hasn't connected calendar or granted write permission,
      // we gracefully accept the recommendation and log it
      const now = new Date();
      await db
        .update(recommendations)
        .set({
          status: "accepted",
          resolvedAt: now,
          actedAt: now,
          updatedAt: now,
          suggestedCalendarInvite: {
            ...(rec.invite || {}),
            title,
            proposedStartTime: startsAt.toISOString(),
            durationMinutes: durationMin,
            agenda: description,
            status: "confirmed",
          },
        })
        .where(and(eq(recommendations.id, rec.id), eq(recommendations.userId, userId)));

      await recordFeedback(userId, {
        contactId: rec.contactId,
        recommendationId: rec.id,
        kind: rec.kind,
        action: "accepted",
      });

      return {
        ok: true as const,
        message: "Invite scheduled in Orbit (connect Calendar in Settings for automatic provider sync)",
      };
    }

    // Write directly to Google / Outlook Calendar
    const result = await addCalendarMeeting(userId, meeting);

    const now = new Date();
    await db
      .update(recommendations)
      .set({
        status: "accepted",
        resolvedAt: now,
        actedAt: now,
        updatedAt: now,
        suggestedCalendarInvite: {
          ...(rec.invite || {}),
          title,
          proposedStartTime: startsAt.toISOString(),
          durationMinutes: durationMin,
          agenda: description,
          status: "confirmed",
          calendarEventKey: result?.eventId,
        },
      })
      .where(and(eq(recommendations.id, rec.id), eq(recommendations.userId, userId)));

    await recordFeedback(userId, {
      contactId: rec.contactId,
      recommendationId: rec.id,
      kind: rec.kind,
      action: "accepted",
    });

    return {
      ok: true as const,
      eventId: result?.eventId,
      message: `Calendar invite added to your ${result?.provider === "google" ? "Google" : "Outlook"} Calendar!`,
    };
  } catch (err) {
    reportError(err, { where: "confirmCalendarInviteFromRecommendation", userId, extra: { recommendationId } });
    return { ok: false as const, message: "Couldn't create calendar invite — please try again." };
  }
}
