/**
 * The waitlist page's product demo, and the admin console's switch for it.
 *
 * ON UNLESS AN ADMIN TURNS IT OFF. The column is null until someone flips it, and null reads
 * as on. A failed read also reads as on: this sits on the waitlist page's request path, and
 * a database hiccup must not quietly take the page's centrepiece down.
 *
 * CLERK-FREE ON PURPOSE. The waitlist lives in the `(site)` group, which has no
 * `ClerkProvider`, so this module may import the database and the audit log but never
 * `@/lib/site-access` (which pulls in Clerk). It shares `site_settings` with the stealth
 * switch and writes only its own column, so neither switch disturbs the other.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { siteSettings } from "@/db/schema";
import { recordAdminAction } from "@/lib/admin-audit";

/** Long enough to keep the read off the hot path, short enough that a toggle lands quickly. */
const TTL_MS = 10_000;

const globalForDemo = globalThis as unknown as {
  orbitWaitlistDemo?: { value: boolean; at: number };
};

async function readFresh(): Promise<boolean> {
  const db = await getDb();
  const row = await db.query.siteSettings.findFirst({ where: eq(siteSettings.id, 1) });
  return row?.waitlistDemoEnabled ?? true;
}

/**
 * Whether the waitlist page should show its demo. Cached per instance; `{ fresh: true }`
 * skips the cache (the admin console, which must show what is actually stored).
 */
export async function getWaitlistDemoEnabled(options: { fresh?: boolean } = {}): Promise<boolean> {
  const cached = globalForDemo.orbitWaitlistDemo;
  if (!options.fresh && cached && Date.now() - cached.at < TTL_MS) return cached.value;
  try {
    const value = await readFresh();
    globalForDemo.orbitWaitlistDemo = { value, at: Date.now() };
    return value;
  } catch (err) {
    if (options.fresh) throw err;
    console.error("[waitlist-demo] site_settings read failed", err);
    return cached?.value ?? true;
  }
}

/**
 * Turn the demo on or off for everyone. No auth of its own — the server action is the gate,
 * which is what lets a smoke script call this with no request context.
 *
 * Only `waitlist_demo_enabled` is written: `updated_at` / `updated_by` belong to the stealth
 * switch's audit trail, and the admin audit log records who flipped this one.
 */
export async function setWaitlistDemoEnabled(adminUserId: string, enabled: boolean): Promise<boolean> {
  const before = await getWaitlistDemoEnabled({ fresh: true });
  const db = await getDb();
  await db
    .insert(siteSettings)
    .values({ id: 1, waitlistDemoEnabled: enabled })
    .onConflictDoUpdate({
      target: siteSettings.id,
      set: { waitlistDemoEnabled: sql`excluded.waitlist_demo_enabled` },
    });

  await recordAdminAction({
    adminUserId,
    action: enabled ? "site.waitlist_demo.on" : "site.waitlist_demo.off",
    resourceType: "site_settings",
    resourceId: "1",
    detail: { from: before, to: enabled },
  });

  globalForDemo.orbitWaitlistDemo = undefined;
  return getWaitlistDemoEnabled({ fresh: true });
}
