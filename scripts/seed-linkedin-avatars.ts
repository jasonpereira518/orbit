/**
 * One-off: promote photos contacts already hold into the shared LinkedIn photo pool.
 *
 * Only a contact's REMOTE public photo is eligible (https media.licdn.com, or Unavatar's
 * LinkedIn endpoint, and not from a mailbox/enrichment/upload source): those are the only
 * photos whose public origin is provable. Each is downloaded and stored under
 * avatars-shared/. Blob, data:, Google and Outlook photos are never promoted. Blocked and
 * already-positive slugs are skipped.
 *
 * Dry run by default (nothing is downloaded or written). Needs BLOB_READ_WRITE_TOKEN to apply.
 * Run: npx tsx scripts/seed-linkedin-avatars.ts [--apply]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { and, isNotNull, isNull, or, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { hasBlobStorage } from "../src/lib/contact-avatar";
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
        or(isNull(contacts.profileImageSource), inArray(contacts.profileImageSource, ["extension", "public"])),
        sql`(${contacts.profileImageUrl} LIKE 'https://media.licdn.com/%' OR ${contacts.profileImageUrl} LIKE 'https://unavatar.io/linkedin/%')`
      )
    );
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  for (const { url, photo } of rows) {
    const slug = sharedPhotoSlug(url);
    if (!slug || !photo || !provablePublicPhotoSource(photo) || seen.has(slug)) continue;
    seen.add(slug);
    const outcome = await seedSharedAvatar(slug, photo, !apply);
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  console.log(`${apply ? "Applied" : "Dry run"}: ${seen.size} candidate slug(s).`, counts);
  if (!apply) console.log('"promoted" = would be promoted. Re-run with --apply to write.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
