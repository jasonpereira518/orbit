/**
 * The relationship engine's tables and columns exist on a freshly bootstrapped database —
 * checked against information_schema, not against schema.ts, because the DDL template is
 * split on semicolons and `db:check` only reads source text (see the memory_chunks trap).
 *
 * Run: npx tsx scripts/smoke-relationship-schema.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-rel-schema";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-rel-schema";

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function columns(table: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = rowsOf<{ column_name: string }>(
    await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = ${table}`)
  );
  return new Set(rows.map((r) => r.column_name));
}

async function main() {
  const digests = await columns("relationship_digests");
  for (const c of [
    "contact_id", "user_id", "what_they_do", "working_on", "summary", "topics", "open_threads",
    "message_count", "sources", "watermark_at", "watermark_interaction_id",
    "history_truncated_before", "attempts", "last_error", "batch_job_id", "batch_pending_until",
    "run_id", "updated_at",
  ]) {
    check(`relationship_digests.${c}`, digests.has(c));
  }
  const runs = await columns("relationship_runs");
  for (const c of [
    "id", "user_id", "import_id", "status", "claim_token", "lease_until", "inline_used",
    "processed", "skipped", "failed", "reminders_created", "facts_added", "open_threads_added",
    "flags", "note_batch_id", "last_error", "created_at", "finished_at",
  ]) {
    check(`relationship_runs.${c}`, runs.has(c));
  }
  check("action_items.owed_by", (await columns("action_items")).has("owed_by"));
  check(
    "user_settings.relationship_engine_enabled",
    (await columns("user_settings")).has("relationship_engine_enabled")
  );
  check("user_settings.chat_self_names", (await columns("user_settings")).has("chat_self_names"));
  console.log("\nsmoke-relationship-schema: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
