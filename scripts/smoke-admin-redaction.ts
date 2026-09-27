/**
 * `NEVER_REVEALABLE` is the list of columns no operator-console query may select. The
 * privacy policy quotes it ("what the console never shows"), so it has to be complete:
 * every `*_encrypted` column in the schema, plus the private content with no support use.
 * A new encrypted column that nobody adds here would otherwise be one careless SELECT from
 * rendering a foreign user's credential.
 *
 * Pure: imports the Drizzle schema objects, touches no database.
 * Run: npx tsx scripts/smoke-admin-redaction.ts
 */
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema";
import {
  NEVER_REVEALABLE,
  RedactionViolationError,
  assertRevealable,
} from "../src/lib/admin-redaction";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const denied = new Set(NEVER_REVEALABLE);
const real = new Set<string>();
const encrypted: string[] = [];
for (const value of Object.values(schema)) {
  if (!is(value, PgTable)) continue;
  const table = getTableConfig(value);
  for (const column of table.columns) {
    const qualified = `${table.name}.${column.name}`;
    real.add(qualified);
    if (column.name.endsWith("_encrypted")) encrypted.push(qualified);
  }
}

console.log("Every encrypted column");
check("the schema has the encrypted columns this guard expects", encrypted.length >= 15, `${encrypted.length}`);
for (const qualified of encrypted) {
  check(`${qualified} is never revealable`, denied.has(qualified));
}

console.log("Private content with no support use");
for (const qualified of [
  "chat_messages.content",
  "chat_threads.context_note",
  "user_settings.writing_instructions",
  "note_batches.source_text",
  "meeting_transcript_segments.text",
  "capture_photos.inline_data",
  "capture_photos.blob_url",
  "user_settings.calendar_feed_token",
]) {
  check(`${qualified} is never revealable`, denied.has(qualified));
}

console.log("The list itself");
for (const qualified of NEVER_REVEALABLE) {
  check(`${qualified} names a real column`, real.has(qualified));
}

let threw = false;
try {
  assertRevealable(["contacts.notes", "note_batches.source_text"]);
} catch (err) {
  threw = err instanceof RedactionViolationError && /note_batches\.source_text/.test(err.message);
}
check("asking for a denied column throws and names it", threw);

let allowed = true;
try {
  assertRevealable(["contacts.notes", "interactions.raw_notes"]);
} catch {
  allowed = false;
}
check("ordinary contact and interaction columns are still allowed", allowed);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll redaction checks passed.");
process.exit(0);
