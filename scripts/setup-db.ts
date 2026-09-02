/**
 * Bootstrap / verify the Orbit database.
 * Uses DATABASE_URL (Neon) when set, otherwise local PGlite.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb, rowsOf, schema } from "../src/db";
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
  "suggested_reminders",
  "imports",
  "ai_suggestions",
  "contact_embeddings",
  "calendar_subscriptions",
  "outreach_campaigns",
  "outreach_prospects",
  "outreach_messages",
  "chat_threads",
  "chat_messages",
  "reminder_lists",
  "import_job_rows",
  "recruiters",
  "user_recruiter_links",
  "recruiter_messages",
  "gmail_connections",
  "outlook_connections",
  "usage_events",
  "admin_audit_log",
  "cron_runs",
  "ops_alert_state",
  "rate_limit_buckets",
  "webhook_deliveries",
  "error_events",
  "app_surface_flags",
  "interest_list_signups",
  "broadcasts",
  "broadcast_recipients",
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

  const tables = rowsOf<{ table_name: string }>(rows).map((r) =>
    typeof r === "string" ? r : r.table_name
  );

  console.log("tables:", tables.join(", ") || "(none)");

  const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
  if (missing.length) {
    console.error("Missing tables:", missing.join(", "));
    process.exit(1);
  }

  // contacts.stated_closeness distinguishes an unrated contact from one
  // deliberately scored 2 — every closeness-scoring task depends on it
  // existing, so a fresh environment must fail loudly if it's missing.
  const contactColumns = await db.execute<{ column_name: string }>(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts'
  `);
  const columnNames = (
    Array.isArray(contactColumns)
      ? contactColumns
      : ((contactColumns as { rows?: { column_name: string }[] }).rows ?? [])
  ).map((r) => (typeof r === "string" ? r : r.column_name));
  if (!columnNames.includes("stated_closeness")) {
    console.error(
      "Missing column: contacts.stated_closeness (run scripts/migrate-stated-closeness.ts)"
    );
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
