/**
 * Move capture photos and feedback screenshots stored before the switch to PRIVATE Blob
 * objects (src/lib/stored-blob.ts), then delete the public copies.
 *
 *   npx tsx scripts/migrate-private-blobs.ts            # dry run: counts only
 *   npx tsx scripts/migrate-private-blobs.ts --apply    # copy, repoint the row, delete public
 *
 * Runs against whatever DATABASE_URL and BLOB_READ_WRITE_TOKEN resolve to. Idempotent and
 * resumable: a row is repointed only after its private copy exists, and the public object is
 * deleted only after the row points away from it. Try it on a preview environment first, and
 * open one migrated photo through /api/capture/photos/<id> before running it in production.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { del, put } from "../src/lib/blob-lazy";
import { PRIVATE_BLOB_ACCESS } from "../src/lib/stored-blob";

const TABLES = ["capture_photos", "feedback_screenshots"] as const;
const BATCH = 200;

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply && !process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("BLOB_READ_WRITE_TOKEN is not set — nothing can be copied.");
    process.exit(1);
  }
  const db = await getDb();
  for (const table of TABLES) {
    const pending = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE blob_url LIKE '%.public.blob.vercel-storage.com/%'`)
    )[0]?.n ?? 0;
    console.log(`${table}: ${pending} public object(s)`);
    if (!apply || pending === 0) continue;

    let moved = 0;
    let failed = 0;
    for (;;) {
      const rows = rowsOf<{ id: string; blob_url: string; content_type: string }>(
        await db.execute(sql`
          SELECT id, blob_url, content_type FROM ${sql.identifier(table)}
           WHERE blob_url LIKE '%.public.blob.vercel-storage.com/%' ORDER BY id LIMIT ${BATCH}`)
      );
      if (rows.length === 0) break;
      let progressed = false;
      for (const row of rows) {
        try {
          const res = await fetch(row.blob_url, { cache: "no-store" });
          if (!res.ok) throw new Error(`fetch ${res.status}`);
          const bytes = Buffer.from(await res.arrayBuffer());
          // Same path, so an operator can still match an object to its row.
          const pathname = new URL(row.blob_url).pathname.replace(/^\//, "").replace(/-[A-Za-z0-9]{20,}(\.[a-z0-9]+)$/, "$1");
          const copy = await put(pathname, bytes, { access: PRIVATE_BLOB_ACCESS, contentType: row.content_type, addRandomSuffix: true });
          await db.execute(sql`UPDATE ${sql.identifier(table)} SET blob_url = ${copy.url} WHERE id = ${row.id}::uuid AND blob_url = ${row.blob_url}`);
          await del(row.blob_url).catch(() => {});
          moved++;
          progressed = true;
        } catch (err) {
          failed++;
          console.error(`  ${table} ${row.id}: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (!progressed) break;
    }
    console.log(`  moved ${moved}, failed ${failed}`);
  }
  if (!apply) console.log("Dry run. Re-run with --apply.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
