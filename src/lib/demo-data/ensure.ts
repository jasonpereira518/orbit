import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { isLocalhost } from "@/lib/demo-account";

/** Seeds in progress, so concurrent first requests for one account seed it once. */
const inFlight = new Map<string, Promise<void>>();

/**
 * On localhost, an account with no contacts is filled with the demo workspace, so every
 * local server — whatever its port, database or sign-in — opens onto a product that can
 * be demoed rather than an empty one.
 *
 * Runs from `bootstrapAuthenticatedUser`, ahead of the onboarding gate, so a fresh local
 * account lands on a populated dashboard. Accounts that already have contacts are never
 * touched. Because the check is "no contacts", clearing an account's data on localhost
 * (Settings → delete data) re-seeds it on the next request — a free "reset demo".
 *
 * `ORBIT_DEMO_DATA=off` disables it, for working on onboarding or empty states locally.
 * Never runs off localhost: `isLocalhost()` is `next dev`, which no deployment runs.
 */
export async function ensureLocalDemoData(userId: string): Promise<void> {
  if (!isLocalhost() || process.env.ORBIT_DEMO_DATA === "off") return;

  const pending = inFlight.get(userId);
  if (pending) return pending;

  const run = (async () => {
    const db = await getDb();
    const existing = await db.query.contacts.findFirst({
      where: eq(contacts.userId, userId),
      columns: { id: true },
    });
    if (existing) return;

    // Loaded on demand: the seeder and its data never enter the module graph of a
    // request that does not need them.
    const { seedDemoWorkspace } = await import("@/lib/demo-data/seed");
    const summary = await seedDemoWorkspace(userId);
    console.info(`[demo-data] seeded a demo workspace for ${userId}`, summary);
  })()
    .catch((err) => {
      // A failed seed must never take the page down with it; the account just stays empty.
      console.error(`[demo-data] could not seed ${userId}`, err);
    })
    .finally(() => inFlight.delete(userId));

  inFlight.set(userId, run);
  return run;
}
