/**
 * The operator's switch for the constellation filter, and the thresholds behind it.
 *
 * Global rather than per-user, in the same spirit as `app_surface_flags`: this is a decision
 * about what the star chart *means*, not a personal preference. The row is a singleton, so
 * reading it is a one-row select and writing it is an upsert on a fixed id.
 */
import { cache } from "react";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { constellationSettings } from "@/db/schema";
import { recordAdminAction } from "@/lib/admin-operations";
import {
  clampThresholds,
  DEFAULT_CONSTELLATION_THRESHOLDS,
  type ConstellationThresholds,
} from "@/lib/constellation-eligibility";

export type ConstellationConfig = {
  enabled: boolean;
  thresholds: ConstellationThresholds;
};

/** What a database with no row yet means: the feature is on, at its designed thresholds. */
export const DEFAULT_CONSTELLATION_CONFIG: ConstellationConfig = {
  enabled: true,
  thresholds: DEFAULT_CONSTELLATION_THRESHOLDS,
};

/** What a database we could not reach means: show everything. See the note below. */
const FAILSAFE_CONSTELLATION_CONFIG: ConstellationConfig = {
  enabled: false,
  thresholds: DEFAULT_CONSTELLATION_THRESHOLDS,
};

/**
 * Across requests, per server instance — the same arrangement as `hiddenKeysMemo` in
 * `surface-visibility.ts`, for the same reason. The dashboard, the graph and every profile
 * render read this singleton, and it changes only when an operator flips the switch, so each
 * instance re-reads it at most every `CONSTELLATION_CONFIG_TTL_MS`. `setConstellationConfig`
 * clears it at once on the instance that made the change; other instances catch up within
 * the TTL. What the chart draws is presentation, not authorization, so a few seconds of the
 * previous setting on another instance is acceptable.
 *
 * `generation` guards the one race the TTL alone would not: a read that started before a
 * write and finished after it must not put the pre-write value back for a whole TTL.
 */
const CONSTELLATION_CONFIG_TTL_MS = 15_000;
let configMemo: { config: ConstellationConfig; at: number } | null = null;
let configGeneration = 0;

/** Forget the cross-request copy. For writers of `constellation_settings`, including tests. */
export function invalidateConstellationConfig(): void {
  configMemo = null;
  configGeneration += 1;
}

/**
 * The current config, memoised per request and, for `CONSTELLATION_CONFIG_TTL_MS`, per
 * instance (see `configMemo` above).
 *
 * `cache()` as well, matching `getHiddenSurfaceKeys`: the graph payload and the admin page
 * may both ask on one request and should cost at most one query between them.
 *
 * The two failure modes resolve differently on purpose, and the asymmetry is the point:
 *
 * - **No row** means nobody has touched the setting, so the shipped default applies and the
 *   filter is on. That is a real answer, and memoised like one.
 * - **A thrown read** means we do not know what the setting is — and guessing "on" would hide
 *   most of somebody's network on the strength of a database hiccup, which is indistinguishable
 *   from data loss to the person looking at it. Showing too much for a moment is the cheaper
 *   mistake, exactly as "visible is the safe failure" is for surface flags. Never memoised,
 *   so the failure lasts one request rather than the whole TTL.
 */
export const getConstellationConfig = cache(
  async (): Promise<ConstellationConfig> => {
    const now = Date.now();
    if (configMemo && now - configMemo.at < CONSTELLATION_CONFIG_TTL_MS) {
      return configMemo.config;
    }
    const generation = configGeneration;
    try {
      const config = await readConstellationConfigFresh();
      if (generation === configGeneration) configMemo = { config, at: now };
      return config;
    } catch {
      return FAILSAFE_CONSTELLATION_CONFIG;
    }
  }
);

/**
 * Change the filter for everyone.
 *
 * Takes the admin id explicitly and does no auth of its own, matching every other operator
 * write in this codebase — the gate lives in the server action, and keeping the work in a
 * plain function is what lets a smoke script exercise it with no request context. For the
 * same reason there is no `revalidatePath` here; the action calls it.
 *
 * No reason string is required, unlike suspension or deletion: this writes one row, changes
 * no user data, and is undone by the same click that caused it. It is still audited.
 */
export async function setConstellationConfig(
  adminUserId: string,
  patch: { enabled?: boolean; minInbound?: number; minOutbound?: number }
): Promise<ConstellationConfig> {
  const current = await readConstellationConfigFresh();
  const next: ConstellationConfig = {
    enabled: patch.enabled ?? current.enabled,
    thresholds: clampThresholds({
      minInbound: patch.minInbound ?? current.thresholds.minInbound,
      minOutbound: patch.minOutbound ?? current.thresholds.minOutbound,
    }),
  };

  const db = await getDb();
  await db
    .insert(constellationSettings)
    .values({
      id: 1,
      filterEnabled: next.enabled,
      minInboundMessages: next.thresholds.minInbound,
      minOutboundMessages: next.thresholds.minOutbound,
      updatedBy: adminUserId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: constellationSettings.id,
      set: {
        filterEnabled: sql`excluded.filter_enabled`,
        minInboundMessages: sql`excluded.min_inbound_messages`,
        minOutboundMessages: sql`excluded.min_outbound_messages`,
        updatedBy: sql`excluded.updated_by`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  invalidateConstellationConfig();

  await recordAdminAction({
    adminUserId,
    action: "product.constellation.update",
    resourceType: "constellation_settings",
    resourceId: "1",
    detail: { from: current, to: next },
  });

  return next;
}

/**
 * The config straight from the database, bypassing the per-request `cache()` and the
 * per-instance memo — never cache this one.
 *
 * Needed by the writer (which must read-modify-write within one request, after its own
 * earlier write may have landed) and by tests, where a memoised getter would keep handing
 * back the value from before the write under test.
 */
export async function readConstellationConfigFresh(): Promise<ConstellationConfig> {
  const db = await getDb();
  const row = await db.query.constellationSettings.findFirst({
    where: eq(constellationSettings.id, 1),
  });
  if (!row) return DEFAULT_CONSTELLATION_CONFIG;
  return {
    enabled: row.filterEnabled,
    thresholds: clampThresholds({
      minInbound: row.minInboundMessages,
      minOutbound: row.minOutboundMessages,
    }),
  };
}
