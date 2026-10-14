/**
 * Upkeep of the shared LinkedIn photo pool (`linkedin_avatars`): seeding slugs whose contact
 * already shows an Unavatar photo (seed script, by a fresh public lookup), filling the most-shared slugs a little each hour, and
 * removing rows once no contact in any account carries the slug.
 */
import { createHash } from "node:crypto";
import { and, isNull, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { linkedinAvatars, rateLimitBuckets } from "@/db/schema";
import { deleteSharedAvatarBlob } from "@/lib/avatar-blob";
import {
  AvatarSourceRateLimitError,
  downloadAndPersistSharedAvatar,
  hasBlobStorage,
} from "@/lib/contact-avatar";
import { LINKEDIN_HOST_RE } from "@/lib/contact-avatar-sql";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import {
  adoptSharedPhoto,
  getSharedAvatar,
  resolveLinkedInPhotoCached,
} from "@/lib/shared-avatars";

/** Slugs resolved per hourly run. The shared Unavatar/Microlink allowance is the real cap. */
export const SHARED_AVATAR_FILL_PER_RUN = 20;
/** Rows removed per statement, and statements per run. */
export const SHARED_AVATAR_SWEEP_BATCH = 200;
const SWEEP_MAX_BATCHES = 10;
/** The fill stops while the app-wide allowance of either source has fewer than this left. */
export const SHARED_FILL_RESERVE = 10;
/** Wall-clock ceiling on one fill run. */
export const SHARED_FILL_BUDGET_MS = 20_000;

/**
 * Whether a contact's stored photo URL provably came from a public lookup: Unavatar's LinkedIn
 * endpoint. A media.licdn.com URL is NOT: it may be an extension capture from before photo
 * provenance existed, and captures stay with their account. Blob, data:, Google, Outlook and
 * everything else is null too.
 */
export function provablePublicPhotoSource(url: string | null | undefined): "unavatar" | null {
  if (!url) return null;
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
 * Pool `slug` when a contact's photo `url` shows Unavatar had one: a fresh Unavatar lookup by
 * the slug (never the stored URL) is stored as our own copy. `dryRun` classifies without
 * downloading or writing.
 */
export async function seedSharedAvatar(slug: string, url: string, dryRun = false): Promise<SeedOutcome> {
  if (!provablePublicPhotoSource(url)) return "not-provable";
  const row = await getSharedAvatar(slug);
  if (row?.blockedAt) return "blocked";
  if (row?.imageUrl) return "already";
  if (dryRun) return "promoted";
  // Unavatar serves an SVG placeholder for misses; the download refuses vectors.
  const from = `https://unavatar.io/linkedin/${encodeURIComponent(slug)}?fallback=false`;
  const stored = await downloadAndPersistSharedAvatar(slug, from);
  if (!stored) return "no-image";
  return (await adoptSharedPhoto(slug, row, stored, "unavatar")) ? "promoted" : "blocked";
}

/** Lookups left today in an app-wide source allowance (`consumeBucket`'s window rule). */
async function sharedAllowanceLeft(source: "unavatar" | "microlink"): Promise<number> {
  const db = await getDb();
  const policy = RATE_LIMITS.avatarSourceShared;
  const [b] = await db
    .select()
    .from(rateLimitBuckets)
    .where(sql`${rateLimitBuckets.bucket} = ${"avatarSource.shared:" + source}`);
  if (!b || Date.now() - b.windowStartedAt.getTime() > policy.windowSec * 1000) return policy.limit;
  return policy.limit - b.count;
}

/**
 * Resolve up to `limit` slugs that have no pool row, most-shared first (contacts across all
 * accounts). Never takes an app-wide source allowance below {@link SHARED_FILL_RESERVE}, which
 * is left for interactive lookups, has its own daily cap and a time budget, and stops at the first
 * deferral of any kind. Each lookup is charged to its own system id: the per-user daily slice
 * protects users from each other and this is not a user.
 * ponytail: the candidate query is linear in contacts that carry a slug, once an hour; if
 * that table gets large, keep a per-slug count (or a worklist table) updated on write.
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
  const deadline = Date.now() + SHARED_FILL_BUDGET_MS;
  for (const { slug } of rowsOf<{ slug: string }>(result)) {
    if (Date.now() > deadline) break;
    try {
      const left = await Promise.all([sharedAllowanceLeft("unavatar"), sharedAllowanceLeft("microlink")]);
      // This lookup spends one (two on a Unavatar miss), so stop at the reserve, not below it.
      if (Math.min(...left) <= SHARED_FILL_RESERVE) {
        out.deferred = true;
        break;
      }
      await consumeBucket("avatarFill", "daily", RATE_LIMITS.avatarFill);
      const got = await resolveLinkedInPhotoCached(
        `shared:${slug}`,
        `https://www.linkedin.com/in/${slug}`,
        // Hashed: the id becomes part of a bucket key, and a slug is user-controlled text.
        `system:avatar-fill:${createHash("sha256").update(slug).digest("hex").slice(0, 16)}`
      );
      if (got) out.found += 1;
      else out.missed += 1;
    } catch (err) {
      if (!(err instanceof AvatarSourceRateLimitError || isRateLimitedError(err))) throw err;
      out.deferred = true;
      break;
    }
  }
  return out;
}

/**
 * Delete pool rows no contact in any account refers to any more (blocked rows stay: they
 * hold no image and keep the slug from being fetched again). The row goes first, in one
 * statement that re-checks for contacts as of its own snapshot (a contact inserted by a
 * concurrent transaction can still lose its photo until the next lookup re-fills it); the
 * object is deleted after, best-effort. Returns rows removed.
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
