import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { siteSettings } from "@/db/schema";
import { recordAdminAction } from "@/lib/admin-audit";
import {
  forgetManagedAiPause,
  managedAiPausedDefault,
  managedAiSwitchedOff,
  managedKeysConfigured,
} from "@/lib/ai-access";

/**
 * The admin console's switch for included AI on Pro and Max (`site_settings.managed_ai_paused`).
 *
 * Three things decide whether included AI runs, and the console shows all three because only
 * one of them is this switch:
 *  - `ORBIT_MANAGED_AI=off` in the environment always wins (a deploy-level kill switch);
 *  - Orbit must hold a key for at least one provider;
 *  - this switch. Never set reads as PAUSED on production, so included AI cannot start before
 *    someone turns it on here, deliberately.
 * Free and Lifetime never use Orbit's keys, whatever the switch says.
 */
export type ManagedAiSwitchState = {
  paused: boolean;
  /** False when nobody has ever flipped the switch and `paused` is the environment default. */
  explicit: boolean;
  envOff: boolean;
  keysConfigured: boolean;
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
