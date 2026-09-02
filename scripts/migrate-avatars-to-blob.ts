/**
 * Move inline (base64) contact avatars into Vercel Blob storage.
 *
 * Before Blob storage was provisioned, every resolved LinkedIn photo was stored as a
 * `data:image/...` URL on the contact row — up to 120 KB each, TOASTed in Postgres, and
 * read back on every list scan that touched `profile_image_url`. The hot paths no longer
 * select that column, but the bytes still bloat the table and every remaining reader
 * (`/api/avatars/[contactId]`, the contact page, the extension). This uploads each one to
 * Blob at the same stable path the backfill uses (`avatars/{id}.jpg`) and replaces the
 * stored value with the Blob URL, which the app already treats as durable.
 *
 * Idempotent and resumable. Needs BLOB_READ_WRITE_TOKEN; without it, or with --dry-run,
 * it only reports what it would do. Afterwards, reclaim the space in Neon's SQL editor:
 * `VACUUM (FULL) contacts;`
 *
 * Run: npx tsx scripts/migrate-avatars-to-blob.ts [--dry-run] [--limit N]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { hasBlobStorage } from "../src/lib/contact-avatar";
import { migrateInlineAvatars } from "./lib/avatar-migration";

const dryRun = process.argv.includes("--dry-run") || !hasBlobStorage();
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : undefined;

async function main() {
  if (!hasBlobStorage()) console.log("BLOB_READ_WRITE_TOKEN is not set; running as a dry run.");
  const result = await migrateInlineAvatars({ dryRun, limit, log: console.log });
  console.log(
    `${result.total} contact(s) held an inline avatar. ${dryRun ? "Would move" : "Moved"} ${result.moved}; skipped ${result.skipped}.`
  );
  if (!dryRun && result.moved > 0) {
    console.log("Next: VACUUM (FULL) contacts; in the Neon SQL editor to reclaim the space.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
