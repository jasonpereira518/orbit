/**
 * One-off: find stored contact photos that were saved cut off, and clear them so the normal
 * avatar backfill fetches a fresh copy.
 *
 * Before `encodeAvatar` learned to refuse truncated JPEGs, a photo that stopped arriving
 * partway was stored as-is. Browsers draw those as a sharp top, a blocky band, and soft
 * below, permanently, because a stored photo is never looked at again. Only inline `data:`
 * JPEGs are checked (a JPEG's last bytes are FFD9; one without it was cut). Blob photos are
 * not downloaded here.
 *
 * Also counts photos stored under 200px. Those are NOT cleared: they are real pictures, just
 * small, and clearing one risks leaving the contact with no photo when no bigger source exists.
 *
 * Dry run by default. --apply clears profile_image_url / _source / _checked_at on the broken
 * ones, which puts them back in the backfill queue. --user <id> limits it to one account.
 * Run: npx tsx scripts/clear-broken-avatars.ts [--apply] [--user <userId>]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { and, asc, eq, gt, like } from "drizzle-orm";
import sharp from "sharp";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { isTruncatedJpeg, parseImageDataUrl } from "../src/lib/contact-avatar";

const apply = process.argv.includes("--apply");
const userArg = process.argv.indexOf("--user");
const userId = userArg >= 0 ? process.argv[userArg + 1] : undefined;
const BATCH = 100;
const SMALL_PX = 200;

async function main() {
  const db = await getDb();
  let after = "00000000-0000-0000-0000-000000000000";
  let scanned = 0;
  const broken: string[] = [];
  let small = 0;

  // Keyset by id, a batch at a time: each value can be 120 KB of base64.
  for (;;) {
    const rows = await db
      .select({ id: contacts.id, photo: contacts.profileImageUrl })
      .from(contacts)
      .where(
        and(
          gt(contacts.id, after),
          like(contacts.profileImageUrl, "data:image/jpeg%"),
          userId ? eq(contacts.userId, userId) : undefined
        )
      )
      .orderBy(asc(contacts.id))
      .limit(BATCH);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    for (const { id, photo } of rows) {
      scanned++;
      const parsed = photo ? parseImageDataUrl(photo) : null;
      if (!parsed) continue;
      if (isTruncatedJpeg(parsed.buf)) {
        broken.push(id);
        continue;
      }
      const meta = await sharp(parsed.buf).metadata().catch(() => null);
      if (meta?.width && meta.width < SMALL_PX) small++;
    }
  }

  console.log(`${apply ? "Applying" : "Dry run"}: scanned ${scanned} inline JPEG photo(s).`);
  console.log(`  cut off (cleared with --apply): ${broken.length}`);
  console.log(`  under ${SMALL_PX}px (left alone): ${small}`);

  if (apply) {
    for (const id of broken) {
      await db
        .update(contacts)
        .set({
          profileImageUrl: null,
          profileImageSource: null,
          profileImageCheckedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, id));
    }
    console.log(`Cleared ${broken.length}. The backfill will re-fetch them on the next page load.`);
  } else if (broken.length > 0) {
    console.log("Re-run with --apply to clear them.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
