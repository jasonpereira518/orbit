/**
 * Settings → AI "Relationship analysis" switch: getSettings reads it (default on), the save
 * action persists it, and turning it on outside a request does not throw.
 * Drives the server action as demo mode's `demo-user`.
 *
 * Run: npx tsx scripts/smoke-relationship-settings.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";
process.env.ORBIT_DEMO_DATA = "off"; // no demo workspace seeding
process.env.VERCEL = "1"; // env provider keys must not count as "usable"

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { getSettings, saveRelationshipEngineEnabled } from "../src/actions/settings";

const USER = "demo-user";
function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();
  await db.update(userSettings).set({ relationshipEngineEnabled: 1 }).where(eq(userSettings.userId, USER));
  check("default on", (await getSettings()).relationshipEngineEnabled === true);
  await saveRelationshipEngineEnabled(false);
  const off = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("saved off", off?.relationshipEngineEnabled === 0);
  check("read off", (await getSettings()).relationshipEngineEnabled === false);
  await saveRelationshipEngineEnabled(true);
  check("read on (and turning on does not throw outside a request)", (await getSettings()).relationshipEngineEnabled === true);
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
});
