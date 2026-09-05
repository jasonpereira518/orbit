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
 * The current config, memoised per request.
 *
 * `cache()` rather than `unstable_cache`, matching `getHiddenSurfaceKeys`: the graph payload
 * and the admin page may both ask on one request and should cost one query between them.
 *
 * The two failure modes resolve differently on purpose, and the asymmetry is the point:
 *
 * - **No row** means nobody has touched the setting, so the shipped default applies and the
 *   filter is on.
 * - **A thrown read** means we do not know what the setting is — and guessing "on" would hide
 *   most of somebody's network on the strength of a database hiccup, which is indistinguishable
 *   from data loss to the person looking at it. Showing too much for a moment is the cheaper
 *   mistake, exactly as "visible is the safe failure" is for surface flags.
 */
export const getConstellationConfig = cache(
  async (): Promise<ConstellationConfig> => {
    try {
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
 * The config straight from the database, bypassing the per-request `cache()`.
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
