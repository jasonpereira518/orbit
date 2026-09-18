"use server";

import { eq } from "drizzle-orm";
import { after } from "next/server";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { FAST_MODELS, getAiCapability } from "@/lib/ai";
import {
  kickLinkedInTimelineBackfill,
  pendingTimelineAiContactCount,
} from "@/lib/linkedin-timeline-backfill";
import {
  TIMELINE_DAILY_CONTACT_CAP,
  timelineEstimateLabel,
  type TimelineBackfillStatus,
} from "@/lib/timeline-cost";

/** What the LinkedIn import card needs to offer the timeline backfill honestly. */
export async function getTimelineBackfillStatus(): Promise<TimelineBackfillStatus> {
  const userId = await requireUserId();
  const db = await getDb();
  const [settings, pending, capability] = await Promise.all([
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { timelineBackfillEnabled: true },
    }),
    pendingTimelineAiContactCount(userId),
    getAiCapability(userId),
  ]);
  const model = FAST_MODELS[capability.provider];
  return {
    enabled: (settings?.timelineBackfillEnabled ?? 0) === 1,
    pendingConversations: pending,
    hasKey: capability.hasKey,
    model,
    label: timelineEstimateLabel(pending, model),
    dailyCap: TIMELINE_DAILY_CONTACT_CAP,
  };
}

/** Turning it on starts the work now rather than at the next hourly sweep. */
export async function setTimelineBackfillEnabled(
  enabled: boolean
): Promise<TimelineBackfillStatus> {
  const userId = await requireUserId();
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ timelineBackfillEnabled: enabled ? 1 : 0, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));
  if (enabled) after(() => kickLinkedInTimelineBackfill(userId));
  return getTimelineBackfillStatus();
}
