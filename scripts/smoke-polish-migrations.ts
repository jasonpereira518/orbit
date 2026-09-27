/**
 * The Phase 4 data migrations, on a database one version behind: plaintext calendar feed
 * tokens become their SHA-256 (and still resolve), li-event interactions become ai_derived,
 * nothing else changes, and a second pass changes nothing.
 * Run: npx tsx scripts/smoke-polish-migrations.ts
 */
import "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { SCHEMA_VERSION, getDb, reconcileSchema } from "../src/db";
import { contacts, interactions, userSettings } from "../src/db/schema";
import { findUserByFeedToken, hashCalendarFeedToken } from "../src/lib/calendar-feed";
import { AI_DERIVED_SOURCE } from "../src/lib/interaction-provenance";
import { ensureUserSettings } from "../src/lib/user-settings";
import { run } from "./smoke/_env";

const USER = "smoke-polish-migrations-user";
const LEGACY_TOKEN = "legacyPlaintextFeedToken_0123456789abcdefXYZ"; // 43 chars, base64url-shaped

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function behindAndReconcile() {
  const db = await getDb();
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1} WHERE id = 1`);
  const result = await reconcileSchema();
  check("the sweep ran with no failed statement", result.applied === true && result.failed.length === 0, JSON.stringify(result.failed));
}

run(async () => {
  const db = await getDb();
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
  await db.update(userSettings).set({ calendarFeedToken: LEGACY_TOKEN }).where(eq(userSettings.userId, USER));
  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Priya Raman" }).returning();
  await db.insert(interactions).values([
    { userId: USER, contactId: c.id, interactionType: "meeting", source: "linkedin_messages", externalId: `li-event:${c.id}:meeting:x` },
    { userId: USER, contactId: c.id, interactionType: "linkedin_message", source: "linkedin_messages", direction: "in", externalId: "li-msg:smoke-1" },
  ]);

  console.log("First pass…");
  await behindAndReconcile();
  const settings = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("the stored token is now its hash", settings?.calendarFeedToken === hashCalendarFeedToken(LEGACY_TOKEN), String(settings?.calendarFeedToken));
  check("the old feed URL still resolves", (await findUserByFeedToken(LEGACY_TOKEN))?.userId === USER);
  const rows = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });
  const bySource = Object.fromEntries(rows.map((r) => [r.externalId, r.source]));
  check("the li-event row is ai_derived", bySource[`li-event:${c.id}:meeting:x`] === AI_DERIVED_SOURCE, JSON.stringify(bySource));
  check("a real message is untouched", bySource["li-msg:smoke-1"] === "linkedin_messages");

  console.log("\nSecond pass…");
  await behindAndReconcile();
  const again = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("a hash is never hashed twice", again?.calendarFeedToken === hashCalendarFeedToken(LEGACY_TOKEN));
  check("the feed still resolves", (await findUserByFeedToken(LEGACY_TOKEN))?.userId === USER);

  // The smoke runner shares one PGlite across scripts.
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
});
