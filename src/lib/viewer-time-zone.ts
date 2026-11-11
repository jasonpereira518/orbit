import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { TZ_COOKIE, isValidTimeZone, resolveTimeZone } from "@/lib/reminder-due-bucket";

/**
 * The zone of whoever is asking. Server only. The `orbit-tz` cookie (this browser, right now)
 * first, then the zone the app layout last saved for the account, then UTC. Outside a request
 * (MCP, cron, scripts) there is no cookie and the saved zone answers.
 *
 * Reads the column itself rather than `userTimeZone` (meeting-context.ts): that module's
 * imports would follow every caller of this one into the marketing bundle graph.
 */
export async function viewerTimeZone(userId?: string | null): Promise<string> {
  try {
    const { cookies } = await import("next/headers");
    const raw = (await cookies()).get(TZ_COOKIE)?.value;
    if (isValidTimeZone(raw)) return raw;
  } catch {
    // No request scope.
  }
  if (!userId) return "UTC";
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { radarDigestTz: true },
  });
  return resolveTimeZone(row?.radarDigestTz);
}
