/**
 * Core of `scripts/migrate-avatars-to-blob.ts`, separated so the smoke test can drive it
 * in-process against PGlite (a second process would contend for the single-writer file).
 */
import { put } from "@vercel/blob";
import { and, eq, like, sql } from "drizzle-orm";
import { getDb } from "../../src/db";
import { contacts } from "../../src/db/schema";
import { parseImageDataUrl } from "../../src/lib/contact-avatar";

const PAGE = 50;

export type AvatarMigrationResult = { total: number; moved: number; skipped: number };

type Uploader = (path: string, body: Buffer, contentType: string) => Promise<string>;

const blobUploader: Uploader = async (path, body, contentType) => {
  const blob = await put(path, body, { access: "public", contentType, addRandomSuffix: false });
  return blob.url;
};

/**
 * Upload every inline (`data:image/...`) avatar to Blob and replace the stored value with
 * the Blob URL. Idempotent and resumable: only rows still holding a data: URL are selected,
 * in pages, so a re-run after an interruption continues where it stopped.
 */
export async function migrateInlineAvatars(options: {
  dryRun: boolean;
  limit?: number;
  upload?: Uploader;
  log?: (line: string) => void;
}): Promise<AvatarMigrationResult> {
  const log = options.log ?? (() => {});
  const upload = options.upload ?? blobUploader;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const db = await getDb();
  const where = like(contacts.profileImageUrl, "data:image/%");

  const [{ n: total }] = await db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(where);

  let moved = 0;
  let skipped = 0;
  const seen = new Set<string>();
  while (moved + skipped < Math.min(total, limit)) {
    // Rows still holding a data: URL, minus any this run already touched or gave up on.
    // In a dry run nothing changes, so `seen` is the only thing that makes progress.
    const page = await db
      .select({ id: contacts.id, userId: contacts.userId, stored: contacts.profileImageUrl })
      .from(contacts)
      .where(where)
      .orderBy(contacts.id)
      .limit(PAGE + seen.size);
    const fresh = page.filter((r) => !seen.has(r.id)).slice(0, PAGE);
    if (fresh.length === 0) break;

    for (const row of fresh) {
      if (moved + skipped >= limit) break;
      seen.add(row.id);
      const parsed = parseImageDataUrl(row.stored ?? "");
      if (!parsed) {
        skipped += 1;
        log(`  skip ${row.id}: unparseable data URL`);
        continue;
      }
      if (options.dryRun) {
        moved += 1;
        continue;
      }
      const url = await upload(`avatars/${row.id}.jpg`, parsed.buf, parsed.contentType);
      await db
        .update(contacts)
        .set({ profileImageUrl: url })
        .where(and(eq(contacts.id, row.id), eq(contacts.userId, row.userId)));
      moved += 1;
      if (moved % 25 === 0) log(`  ${moved}/${total} moved`);
    }
  }

  return { total, moved, skipped };
}
