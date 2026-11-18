/**
 * The LinkedIn deep read is released, so it is on for every user. Smokes that pin what Orbit
 * does WITHOUT it (the old timeline reader, closeness with no depth term, chat with no
 * relationship block) run inside this: it hides the surface, the operator's kill switch, and
 * always unhides it. Smokes run one at a time, so the hide never reaches another script.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db";
import { appSurfaceFlags } from "../../src/db/schema";
import { invalidateHiddenSurfaceKeys } from "../../src/lib/surface-visibility";
import { LINKEDIN_DEEP_READ_SURFACE_KEY } from "../../src/lib/surfaces";

export async function withDeepReadOff<T>(fn: () => Promise<T>): Promise<T> {
  const db = await getDb();
  await db.insert(appSurfaceFlags).values({ surfaceKey: LINKEDIN_DEEP_READ_SURFACE_KEY, hiddenBy: "smoke" }).onConflictDoNothing();
  invalidateHiddenSurfaceKeys();
  try {
    return await fn();
  } finally {
    await db.delete(appSurfaceFlags).where(eq(appSurfaceFlags.surfaceKey, LINKEDIN_DEEP_READ_SURFACE_KEY));
    invalidateHiddenSurfaceKeys();
  }
}
