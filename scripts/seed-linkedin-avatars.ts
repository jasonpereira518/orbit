/**
 * One-off: seed the shared LinkedIn photo pool from slugs whose contact already shows an
 * Unavatar LinkedIn photo (source unknown or "public"). Each slug gets a fresh public lookup:
 * Unavatar by the slug, never the stored URL, stored under avatars-shared/. Stored
 * media.licdn.com photos are never promoted (they may be extension captures, which stay with
 * their account), nor Blob, data:, Google, Outlook, Gravatar, Apollo or uploaded photos.
 * Blocked and already-positive slugs are skipped.
 *
 * Dry run by default (nothing is downloaded or written). Needs BLOB_READ_WRITE_TOKEN to apply.
 * Run: npx tsx scripts/seed-linkedin-avatars.ts [--apply]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { AvatarSourceRateLimitError, hasBlobStorage } from "../src/lib/contact-avatar";
import { provablePublicPhotoSource, seedSharedAvatar } from "../src/lib/shared-avatar-upkeep";
import { sharedPhotoSlug } from "../src/lib/shared-avatars";

const apply = process.argv.includes("--apply");

async function main() {
  if (apply && !hasBlobStorage()) throw new Error("--apply needs BLOB_READ_WRITE_TOKEN.");
  const db = await getDb();
  const rows = await db
    .select({ url: contacts.linkedinUrl, photo: contacts.profileImageUrl })
    .from(contacts)
    .where(
      and(
        isNotNull(contacts.linkedinSlug),
        isNotNull(contacts.profileImageUrl),
        or(isNull(contacts.profileImageSource), eq(contacts.profileImageSource, "public")),
        sql`${contacts.profileImageUrl} LIKE 'https://unavatar.io/linkedin/%'`
      )
    );
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  for (const { url, photo } of rows) {
    const slug = sharedPhotoSlug(url);
    if (!slug || !photo || !provablePublicPhotoSource(photo) || seen.has(slug)) continue;
    seen.add(slug);
    try {
      const outcome = await seedSharedAvatar(slug, photo, !apply);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    } catch (err) {
      if (!(err instanceof AvatarSourceRateLimitError)) throw err;
      console.log(`${err.source} rate limit hit; stopping. Re-run later: promoted slugs are skipped.`);
      break;
    }
  }
  console.log(`${apply ? "Applied" : "Dry run"}: ${seen.size} candidate slug(s).`, counts);
  if (!apply) console.log('"promoted" = would be promoted. Re-run with --apply to write.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
