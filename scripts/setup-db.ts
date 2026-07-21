/**
 * Bootstrap / verify the Orbit database.
 * Uses DATABASE_URL (Neon) when set, otherwise local PGlite.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb, schema } from "../src/db";
import { sql } from "drizzle-orm";

  const EXPECTED_TABLES = [
  "user_settings",
  "companies",
  "contacts",
  "user_goals",
  "tags",
  "contact_tags",
  "interactions",
  "reminders",
  "imports",
  "ai_suggestions",
  "contact_embeddings",
  "calendar_subscriptions",
  "outreach_campaigns",
  "outreach_prospects",
  "outreach_messages",
  "chat_threads",
  "chat_messages",
] as const;

async function main() {
  const mode = process.env.DATABASE_URL?.trim() ? "neon" : "pglite";
  console.log(`Bootstrapping Orbit DB (${mode})…`);

  const db = await getDb();

  const rows = await db.execute<{ table_name: string }>(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);

  // drizzle-orm execute return shape differs by driver — normalize
  const tables = (
    Array.isArray(rows)
      ? rows
      : ((rows as { rows?: { table_name: string }[] }).rows ?? [])
  ).map((r) => (typeof r === "string" ? r : r.table_name));

  console.log("tables:", tables.join(", ") || "(none)");

  const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
  if (missing.length) {
    console.error("Missing tables:", missing.join(", "));
    process.exit(1);
  }

  // Smoke write/read against user_settings
  const userId = `setup-check-${Date.now()}`;
  await db.insert(schema.userSettings).values({ userId });
  const found = await db.query.userSettings.findFirst({
    where: (t, { eq }) => eq(t.userId, userId),
  });
  if (!found) {
    console.error("Failed to read back smoke-test user_settings row");
    process.exit(1);
  }
  await db.delete(schema.userSettings).where(sql`user_id = ${userId}`);

  console.log("✓ Schema ready and read/write OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
