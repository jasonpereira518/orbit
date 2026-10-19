import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { siteSettings } from "@/db/schema";
import { recordAdminAction } from "@/lib/admin-audit";
import type { AiProvider } from "@/lib/ai-providers";
import {
  forgetManagedAiPause,
  managedAiPausedDefault,
  managedAiSwitchedOff,
  managedKeysConfigured,
  managedPoolsSpent,
} from "@/lib/ai-access";

/**
 * The admin console's switch for included AI on every plan (`site_settings.managed_ai_paused`).
 *
 * Four things decide whether included AI runs, and the console shows all four because only
 * one of them is this switch:
 *  - `ORBIT_MANAGED_AI=off` in the environment always wins (a deploy-level kill switch);
 *  - Orbit must hold a key for at least one provider;
 *  - at least one provider pool (`MANAGED_AI_POOLS`) must have budget left;
 *  - this switch. Never set reads as running; pausing it here stops included AI for everyone
 *    within the 30-second cache.
 */
export type ManagedAiSwitchState = {
  paused: boolean;
  /** False when nobody has ever flipped the switch and `paused` is the environment default. */
  explicit: boolean;
  envOff: boolean;
  keysConfigured: boolean;
  /** Orbit-paid spend per pooled provider in its current window, in micros. */
  poolSpentMicros: Partial<Record<AiProvider, number>>;
};

export async function getManagedAiSwitchState(): Promise<ManagedAiSwitchState> {
  const db = await getDb();
  const [row] = await db
    .select({ paused: siteSettings.managedAiPaused })
    .from(siteSettings)
    .where(eq(siteSettings.id, 1))
    .limit(1);
  const explicit = row?.paused != null;
  return {
    paused: row?.paused ?? managedAiPausedDefault(),
    explicit,
    envOff: managedAiSwitchedOff(),
    keysConfigured: Object.values(managedKeysConfigured()).some(Boolean),
    poolSpentMicros: await managedPoolsSpent(),
  };
}

export async function setManagedAiPaused(
  adminUserId: string,
  paused: boolean,
  reason = ""
): Promise<ManagedAiSwitchState> {
  const before = await getManagedAiSwitchState();
  const db = await getDb();
  await db
    .insert(siteSettings)
    .values({ id: 1, managedAiPaused: paused })
    .onConflictDoUpdate({
      target: siteSettings.id,
      set: { managedAiPaused: sql`excluded.managed_ai_paused` },
    });

  await recordAdminAction({
    adminUserId,
    action: paused ? "site.managed_ai.pause" : "site.managed_ai.resume",
    resourceType: "site_settings",
    resourceId: "1",
    reason: reason.trim() || null,
    detail: { from: before.paused, to: paused, wasDefault: !before.explicit },
  });

  // Other instances pick it up within the gate's 30-second cache.
  forgetManagedAiPause();
  return getManagedAiSwitchState();
}
