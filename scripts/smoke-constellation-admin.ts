/**
 * The operator's constellation switch: defaults, clamping, the single-row guarantee, and the
 * audit trail.
 *
 * `constellation_settings` is GLOBAL state — one row for the whole installation — so this
 * snapshots it up front and restores it in a `finally`, the same discipline
 * `smoke-surface-visibility.ts` uses for `app_surface_flags`. A smoke test that left the
 * filter disabled would be indistinguishable from a broken feature.
 *
 * Every read here goes through `readConstellationConfigFresh`, never `getConstellationConfig`:
 * the latter is `cache()`d per request, and a script is one long request, so it would keep
 * handing back the value from before the write under test.
 *
 * Run: npx tsx scripts/smoke-constellation-admin.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-constellation-admin";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-constellation-admin";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { adminAuditLog, constellationSettings } from "../src/db/schema";
import {
  DEFAULT_CONSTELLATION_CONFIG,
  readConstellationConfigFresh,
  setConstellationConfig,
} from "../src/lib/constellation-config";
import {
  MAX_MESSAGE_THRESHOLD,
  MIN_MESSAGE_THRESHOLD,
} from "../src/lib/constellation-eligibility";
import { run } from "./smoke/_env";

const ADMIN = "smoke-constellation-admin";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();

  // Snapshot the global row before touching anything.
  const before = await db.query.constellationSettings.findFirst({
    where: eq(constellationSettings.id, 1),
  });

  try {
    console.log("With no row at all…");
    await db.delete(constellationSettings).where(eq(constellationSettings.id, 1));
    const fresh = await readConstellationConfigFresh();
    check(
      "the shipped default applies and the filter is on",
      fresh.enabled === DEFAULT_CONSTELLATION_CONFIG.enabled && fresh.enabled
    );
    check(
      "at the designed thresholds",
      fresh.thresholds.minInbound === DEFAULT_CONSTELLATION_CONFIG.thresholds.minInbound
    );

    console.log("\nWriting…");
    await setConstellationConfig(ADMIN, { enabled: false, minInbound: 4, minOutbound: 6 });
    let stored = await readConstellationConfigFresh();
    check("the switch persists", stored.enabled === false);
    check(
      "and both thresholds do",
      stored.thresholds.minInbound === 4 && stored.thresholds.minOutbound === 6
    );

    console.log("\nA partial change leaves the rest alone…");
    await setConstellationConfig(ADMIN, { enabled: true });
    stored = await readConstellationConfigFresh();
    check("the switch moved", stored.enabled === true);
    check(
      "the thresholds did not",
      stored.thresholds.minInbound === 4 && stored.thresholds.minOutbound === 6
    );

    console.log("\nClamping…");
    await setConstellationConfig(ADMIN, { minInbound: 0, minOutbound: 0 });
    stored = await readConstellationConfigFresh();
    check(
      "zero clamps up — it would otherwise qualify every contact with no messages at all",
      stored.thresholds.minInbound === MIN_MESSAGE_THRESHOLD
    );
    await setConstellationConfig(ADMIN, { minInbound: 9999, minOutbound: 9999 });
    stored = await readConstellationConfigFresh();
    check(
      "an absurd number clamps down rather than emptying every sky",
      stored.thresholds.minInbound === MAX_MESSAGE_THRESHOLD
    );

    console.log("\nThe single-row guarantee…");
    let secondRowRejected = false;
    try {
      await db.insert(constellationSettings).values({ id: 2, filterEnabled: false });
    } catch {
      secondRowRejected = true;
    }
    check("a second settings row is refused by the CHECK", secondRowRejected);
    const rows = await db.select().from(constellationSettings);
    check("so exactly one row exists", rows.length === 1, `found ${rows.length}`);

    console.log("\nThe audit trail…");
    const audits = await db
      .select()
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.adminUserId, ADMIN),
          eq(adminAuditLog.action, "product.constellation.update")
        )
      );
    // Four writes above: the full set, the switch alone, the zero clamp, the ceiling clamp.
    check("every write was audited", audits.length === 4, `got ${audits.length}`);
    const detail = audits[0]?.detail as { from?: unknown; to?: unknown } | null;
    check(
      "and records what changed, not just that something did",
      Boolean(detail?.from && detail?.to)
    );
  } finally {
    await db.delete(constellationSettings).where(eq(constellationSettings.id, 1));
    if (before) {
      await db.insert(constellationSettings).values({
        id: 1,
        filterEnabled: before.filterEnabled,
        minInboundMessages: before.minInboundMessages,
        minOutboundMessages: before.minOutboundMessages,
        updatedAt: before.updatedAt,
        updatedBy: before.updatedBy,
      });
    }
    await db.delete(adminAuditLog).where(eq(adminAuditLog.adminUserId, ADMIN));

    const restored = await db.query.constellationSettings.findFirst({
      where: eq(constellationSettings.id, 1),
    });
    const same =
      (!before && !restored) ||
      (!!before &&
        !!restored &&
        before.filterEnabled === restored.filterEnabled &&
        before.minInboundMessages === restored.minInboundMessages &&
        before.minOutboundMessages === restored.minOutboundMessages);
    if (!same) {
      throw new Error(
        "constellation_settings was not restored — this test leaves global state behind"
      );
    }
  }

  console.log("\nAll constellation admin checks passed.");
});
