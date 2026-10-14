/**
 * Upkeep of the shared LinkedIn photo pool (`linkedin_avatars`): promoting photos a contact
 * already holds (seed script), filling the most-shared slugs a little each hour, and
 * removing rows once no contact in any account carries the slug.
 */
import { and, isNull, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { linkedinAvatars } from "@/db/schema";
import { deleteSharedAvatarBlob } from "@/lib/avatar-blob";
import {
  AvatarSourceRateLimitError,
  downloadAndPersistSharedAvatar,
  hasBlobStorage,
} from "@/lib/contact-avatar";
import { LINKEDIN_HOST_RE } from "@/lib/contact-avatar-sql";
import {
  adoptSharedPhoto,
  getSharedAvatar,
  isLinkedInCdnPhoto,
  resolveLinkedInPhotoCached,
  type SharedAvatarSource,
} from "@/lib/shared-avatars";

/** Slugs resolved per hourly run. The shared Unavatar/Microlink allowance is the real cap. */
export const SHARED_AVATAR_FILL_PER_RUN = 20;
/** Rows removed per statement, and statements per run. */
export const SHARED_AVATAR_SWEEP_BATCH = 200;
const SWEEP_MAX_BATCHES = 10;

/**
 * Where a contact's stored photo URL provably came from the public web: a LinkedIn CDN photo
 * (what the extension scrapes) or Unavatar's LinkedIn endpoint. Blob, data:, Google, Outlook
 * and everything else is null: its origin is not provable, so it is never shared.
 */
export function provablePublicPhotoSource(url: string | null | undefined): SharedAvatarSource | null {
  if (!url) return null;
  if (isLinkedInCdnPhoto(url)) return "extension";
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "unavatar.io" && u.pathname.startsWith("/linkedin/")
      ? "unavatar"
      : null;
  } catch {
    return null;
  }
}

export type SeedOutcome = "promoted" | "not-provable" | "blocked" | "already" | "no-image";

/**
 * Cache `url` (a contact's remote photo) into the pool under `slug`. Always stored from the
 * slug, never re-derived from a URL; the pool holds our own copy, never a remote reference.
 * `dryRun` classifies without downloading or writing.
 */
export async function seedSharedAvatar(slug: string, url: string, dryRun = false): Promise<SeedOutcome> {
  const source = provablePublicPhotoSource(url);
  if (!source) return "not-provable";
  const row = await getSharedAvatar(slug);
  if (row?.blockedAt) return "blocked";
  if (row?.imageUrl) return "already";
  if (dryRun) return "promoted";
  // Unavatar serves an SVG placeholder for misses; the download refuses vectors.
  const stored = await downloadAndPersistSharedAvatar(slug, url);
  if (!stored) return "no-image";
  return (await adoptSharedPhoto(slug, row, stored, source)) ? "promoted" : "blocked";
}

/**
 * Resolve up to `limit` slugs that have no pool row, most-shared first (contacts across all
 * accounts). Stops at the first quota deferral. Each lookup is charged to its own system id:
 * the per-user daily slice protects users from each other, and this is not a user; the
 * app-wide allowance (what actually defers) still applies.
 */
export async function fillSharedAvatars(
  limit = SHARED_AVATAR_FILL_PER_RUN
): Promise<{ found: number; missed: number; deferred: boolean }> {
  const out = { found: 0, missed: 0, deferred: false };
  if (!hasBlobStorage()) return out;
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT c.linkedin_slug AS slug
      FROM contacts c
     WHERE c.linkedin_slug IS NOT NULL
       AND c.linkedin_url ~* ${LINKEDIN_HOST_RE}
       AND NOT EXISTS (SELECT 1 FROM linkedin_avatars la WHERE la.slug = c.linkedin_slug)
     GROUP BY c.linkedin_slug
     ORDER BY count(*) DESC, c.linkedin_slug
     LIMIT ${limit}
  `);
  for (const { slug } of rowsOf<{ slug: string }>(result)) {
    try {
      const got = await resolveLinkedInPhotoCached(
        `shared:${slug}`,
        `https://www.linkedin.com/in/${slug}`,
        `system:avatar-fill:${slug}`
      );
      if (got) out.found += 1;
      else out.missed += 1;
    } catch (err) {
      if (!(err instanceof AvatarSourceRateLimitError)) throw err;
      out.deferred = true;
      break;
    }
  }
  return out;
}

/**
 * Delete pool rows no contact in any account refers to any more (blocked rows stay: they
 * hold no image and keep the slug from being re-contributed). The row goes first, in one
 * statement that re-checks for a contact that just appeared; its object is deleted after,
 * best-effort. Returns rows removed.
 */
export async function sweepOrphanedSharedAvatars(): Promise<number> {
  const db = await getDb();
  const orphan = sql`blocked_at IS NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.linkedin_slug = linkedin_avatars.slug)`;
  let removed = 0;
  for (let i = 0; i < SWEEP_MAX_BATCHES; i++) {
    const gone = await db
      .delete(linkedinAvatars)
      .where(
        and(
          isNull(linkedinAvatars.blockedAt),
          sql`${orphan} AND linkedin_avatars.slug IN (SELECT slug FROM linkedin_avatars WHERE ${orphan} LIMIT ${SHARED_AVATAR_SWEEP_BATCH})`
        )
      )
      .returning();
    for (const g of gone) await deleteSharedAvatarBlob(g.imageUrl);
    removed += gone.length;
    if (gone.length < SHARED_AVATAR_SWEEP_BATCH) break;
  }
  return removed;
}
