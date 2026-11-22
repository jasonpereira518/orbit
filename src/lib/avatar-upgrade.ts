import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { contacts, rateLimitBuckets } from "@/db/schema";
import {
  AvatarSourceRateLimitError,
  AvatarStorageError,
  fetchLinkedInPhoto,
  hasBlobStorage,
  isTruncatedJpeg,
  parseImageDataUrl,
} from "@/lib/contact-avatar";
import { sharedAvatarUrlSql } from "@/lib/contact-avatar-sql";
import { jpegDimensions } from "@/lib/jpeg-dimensions";
import { notTourExample } from "@/lib/onboarding-examples/sql";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { SHARED_FILL_RESERVE } from "@/lib/shared-avatar-upkeep";
import { deadlineReached } from "@/lib/time-budget";

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * Upgrading small stored contact photos in place.
 *
 * Photos stored before `AVATAR_PX` went from 256 to 384 (and photos whose source was small to
 * begin with, which `withoutEnlargement` keeps small) look soft on a retina profile header.
 * This pass re-fetches a bigger copy of a contact's LinkedIn photo and swaps it in ONLY when
 * the new one is strictly larger and decodes cleanly. It never creates a photo, never
 * replaces one with nothing, and is the lowest priority user of the third-party quota: the
 * primary backfill (first-time photos) always goes first.
 *
 * Limits, all deliberate:
 *   - Inline `data:image/jpeg` photos only. A Blob URL would have to be downloaded to be
 *     measured, and the pass cannot tell what an upload to Blob would cost; a PNG/WebP has no
 *     JPEG header to read. Both are skipped, not guessed at. The pass also stands down while
 *     a Blob store is configured, because the lookup would then `put` a new object before we
 *     could measure it.
 *   - Dimensions come from the JPEG's SOF marker (`jpegDimensions`), read from a PREFIX of the
 *     stored value so Postgres never ships a whole photo for a photo that turns out fine.
 */

/** A photo whose shorter edge is under this many pixels is "soft". */
export const SOFT_AVATAR_PX = 200;
/**
 * After a look at a photo (re-fetched without a bigger result, or found fine) it is left alone
 * this long. Stored in `profile_image_checked_at`, the existing per-contact photo clock: no
 * schema change. The primary backfill reads the same column with a 30 day cooldown, but only
 * for contacts with NO usable photo, which these are not.
 */
export const AVATAR_UPGRADE_COOLDOWN_DAYS = 90;
/** Lookups attempted per tick. Each can cost up to two quota units (Unavatar miss, then Microlink). */
export const AVATAR_UPGRADE_BATCH_SIZE = 3;
/** Stored photos whose header is read per tick. */
export const AVATAR_UPGRADE_SCAN_SIZE = 40;
/** Wall-clock budget for the whole pass, checked before each lookup. */
export const AVATAR_UPGRADE_BUDGET_MS = 10_000;
/**
 * Units of each per-user daily allowance (5 a day) the pass leaves for the primary backfill:
 * it may spend only the remainder. The shared (app-wide) allowance keeps `SHARED_FILL_RESERVE`.
 */
export const AVATAR_UPGRADE_USER_RESERVE = 3;

/** Characters of the stored value read per photo: ~6 KB of JPEG, far past any encoder's SOF. */
const HEAD_CHARS = 8192;
/**
 * A photo bigger than this (characters of base64, ~30 KB of JPEG) is not read. A picture under
 * 200px does not weigh that much, so this is a cheap size filter, not a size rule: a freak
 * soft photo above it is simply never upgraded.
 */
const MAX_SCANNED_CHARS = 40_000;
const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

/**
 * Sources the pass may replace: a photo that came from a public LinkedIn lookup or a
 * LinkedIn capture, or one from before provenance existed (null). Everything else is never
 * overwritten: `upload` is the person's own choice, and Google/Outlook/Gravatar/Apollo are
 * different people-sources whose photos a LinkedIn lookup has no business replacing.
 */
const REPLACEABLE_SOURCES = ["public", "extension"] as const;

/** The shorter edge, the single measure used for "soft" and for "bigger". */
export function minEdge(dim: { width: number; height: number }): number {
  return Math.min(dim.width, dim.height);
}

export function isSoftEdge(edge: number): boolean {
  return edge < SOFT_AVATAR_PX;
}

/** Dimensions of an inline JPEG from (a prefix of) its data URL, or null if it cannot be read. */
export function measureInlineJpeg(dataUrlHead: string): { width: number; height: number } | null {
  if (!dataUrlHead.startsWith(JPEG_DATA_URL_PREFIX)) return null;
  const b64 = dataUrlHead.slice(JPEG_DATA_URL_PREFIX.length);
  if (!b64) return null;
  return jpegDimensions(Buffer.from(b64, "base64"));
}

export type UpgradeVerdict = "better" | "not_bigger" | "unreadable";

/**
 * Whether `candidate` (the stored value a lookup produced) may replace a photo whose shorter
 * edge is `currentEdge`. All three must hold: it is a complete JPEG (not cut off), its size
 * can be read, and it is STRICTLY larger. Equal is not better: the swap would only churn.
 */
export function judgeUpgrade(currentEdge: number, candidate: string | null): UpgradeVerdict {
  if (!candidate) return "unreadable";
  const parsed = parseImageDataUrl(candidate);
  if (!parsed || parsed.contentType !== "image/jpeg") return "unreadable";
  if (isTruncatedJpeg(parsed.buf)) return "unreadable";
  const dim = jpegDimensions(parsed.buf);
  if (!dim) return "unreadable";
  return minEdge(dim) > currentEdge ? "better" : "not_bigger";
}

/** Skips the cooldown test, for reporting how many photos are being held back by it. */
export type UpgradeWhereOptions = { userId?: string; cooldown?: boolean };

/**
 * Contacts whose stored photo this pass may look at: an inline JPEG of a size worth reading, a
 * replaceable source, a LinkedIn profile to re-resolve from, not a tour example, not covered by
 * the shared pool (which displays ahead of the contact's own photo, so upgrading the own copy
 * would change nothing on screen), and outside the cooldown.
 *
 * `octet_length` and the 23-character `substr` are what keep this cheap: neither detoasts the
 * whole photo.
 */
export function upgradeCandidateWhere({ userId, cooldown = true }: UpgradeWhereOptions) {
  return and(
    userId ? eq(contacts.userId, userId) : undefined,
    sql`substr(${contacts.profileImageUrl}, 1, ${JPEG_DATA_URL_PREFIX.length}) = ${JPEG_DATA_URL_PREFIX}`,
    sql`octet_length(${contacts.profileImageUrl}) <= ${MAX_SCANNED_CHARS}`,
    or(isNull(contacts.profileImageSource), inArray(contacts.profileImageSource, [...REPLACEABLE_SOURCES])),
    sql`${contacts.linkedinUrl} IS NOT NULL AND btrim(${contacts.linkedinUrl}) <> ''`,
    notTourExample(contacts.source),
    cooldown
      ? sql`(${contacts.profileImageCheckedAt} IS NULL
             OR ${contacts.profileImageCheckedAt} < now() - ${sql.raw(`interval '${AVATAR_UPGRADE_COOLDOWN_DAYS} days'`)})`
      : undefined,
    sql`${sharedAvatarUrlSql} IS NULL`
  );
}

export type UpgradeScanRow = {
  id: string;
  userId: string;
  linkedinUrl: string;
  source: string | null;
  /** `octet_length` of the stored value: the race guard when the swap is written. */
  size: number;
  /** The data URL's first characters only. */
  head: string;
};

/** The next `limit` candidates after `afterId` (keyset by id), headers only. */
export async function findUpgradeScan(
  db: Db,
  options: UpgradeWhereOptions & { limit: number; afterId?: string }
): Promise<UpgradeScanRow[]> {
  const rows = await db
    .select({
      id: contacts.id,
      userId: contacts.userId,
      linkedinUrl: contacts.linkedinUrl,
      source: contacts.profileImageSource,
      size: sql<number>`octet_length(${contacts.profileImageUrl})::int`,
      head: sql<string>`substr(${contacts.profileImageUrl}, 1, ${HEAD_CHARS})`,
    })
    .from(contacts)
    .where(and(options.afterId ? gt(contacts.id, options.afterId) : undefined, upgradeCandidateWhere(options)))
    .orderBy(asc(contacts.id))
    .limit(options.limit);
  return rows.flatMap((r) => (r.linkedinUrl ? [{ ...r, linkedinUrl: r.linkedinUrl.trim() }] : []));
}

/** Lookups left today in a rate-limit bucket (`consumeBucket`'s window rule), without spending one. */
async function allowanceLeft(db: Db, bucket: string, policy: { limit: number; windowSec: number }) {
  const [b] = await db.select().from(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, bucket));
  if (!b || Date.now() - b.windowStartedAt.getTime() > policy.windowSec * 1000) return policy.limit;
  return policy.limit - b.count;
}

/**
 * Whether the quota'd sources have room to spare. Read, never spent: the lookup itself claims
 * through `claimAvatarSourceLookup`, which stays the single place a unit is taken. The pass
 * needs headroom in BOTH the user's daily slice and the app-wide allowance, for both sources
 * (a Unavatar miss falls through to Microlink), so it can never spend the units the primary
 * backfill's first-time photos are waiting on.
 */
export async function hasQuotaHeadroom(db: Db, userId: string): Promise<boolean> {
  const checks: Array<Promise<boolean>> = [];
  for (const source of ["unavatar", "microlink"] as const) {
    checks.push(
      allowanceLeft(db, `avatarSource.user:${source}:${userId}`, RATE_LIMITS.avatarSourceUser).then(
        (left) => left > AVATAR_UPGRADE_USER_RESERVE
      )
    );
    // A Microlink API key lifts the app-wide cap, exactly as `claimAvatarSourceLookup` has it.
    if (!(source === "microlink" && process.env.MICROLINK_API_KEY?.trim())) {
      checks.push(
        allowanceLeft(db, `avatarSource.shared:${source}`, RATE_LIMITS.avatarSourceShared).then(
          (left) => left > SHARED_FILL_RESERVE
        )
      );
    }
  }
  return (await Promise.all(checks)).every(Boolean);
}

export type AvatarUpgradeDeps = {
  /** Resolve a bigger copy: the inline data URL it produced, or null. May throw a quota deferral. */
  fetchPhoto?: (contact: { id: string; linkedinUrl: string }, userId: string) => Promise<string | null>;
  /** Defaults to {@link hasQuotaHeadroom}. */
  hasHeadroom?: (userId: string) => Promise<boolean>;
  deadline?: number;
  now?: () => number;
  /** Lookups attempted / photos read; default to the exported constants. */
  batchSize?: number;
  scanSize?: number;
};

export type AvatarUpgradeStop = "rate_limit" | "quota" | "storage" | "budget" | "blob" | null;

export type AvatarUpgradeResult = {
  /** Photos whose header was read. */
  examined: number;
  /** Of those, soft ones. */
  soft: number;
  /** Lookups started. */
  attempted: number;
  upgraded: number;
  upgradedIds: string[];
  /** Why the pass ended early, if it did. A stopped contact is never stamped. */
  stopped: AvatarUpgradeStop;
  rateLimitedUntil: number | null;
};

const EMPTY: AvatarUpgradeResult = {
  examined: 0,
  soft: 0,
  attempted: 0,
  upgraded: 0,
  upgradedIds: [],
  stopped: null,
  rateLimitedUntil: null,
};

async function defaultFetchPhoto(contact: { id: string; linkedinUrl: string }, userId: string) {
  return (await fetchLinkedInPhoto(contact.linkedinUrl, userId, { contactId: contact.id }))?.url ?? null;
}

/** Start the cooldown for these contacts without touching anything else (not `updated_at`). */
async function stampChecked(db: Db, userId: string, ids: string[]) {
  if (ids.length === 0) return;
  await db
    .update(contacts)
    .set({ profileImageCheckedAt: new Date() })
    .where(and(eq(contacts.userId, userId), inArray(contacts.id, ids)));
}

/**
 * One bounded tick: read a handful of stored photo headers, then try to upgrade up to
 * `batchSize` of the soft ones. Run it only when the primary backfill found nothing to do.
 *
 * Cooldown rules (`profile_image_checked_at`, {@link AVATAR_UPGRADE_COOLDOWN_DAYS}):
 *   - photo read and fine (or unreadable): stamped, so it is not read again for 90 days;
 *   - soft, looked up, no strictly better result (nothing found, a placeholder, a cut-off
 *     or equal-size image, a non-quota failure): stamped, no retry storm;
 *   - upgraded: stamped with the swap;
 *   - quota refusal, no headroom, deadline, storage fault: NOT stamped, so a spent afternoon
 *     does not mute the contact for a quarter.
 * The pass stops at the first quota refusal or fault instead of trying the next contact.
 */
export async function runAvatarUpgradePass(
  db: Db,
  userId: string,
  deps: AvatarUpgradeDeps = {}
): Promise<AvatarUpgradeResult> {
  if (hasBlobStorage()) return { ...EMPTY, upgradedIds: [], stopped: "blob" };

  const now = deps.now ?? Date.now;
  const deadline = deps.deadline ?? now() + AVATAR_UPGRADE_BUDGET_MS;
  const fetchPhoto = deps.fetchPhoto ?? defaultFetchPhoto;
  const hasHeadroom = deps.hasHeadroom ?? ((id: string) => hasQuotaHeadroom(db, id));
  const batchSize = deps.batchSize ?? AVATAR_UPGRADE_BATCH_SIZE;

  const scan = await findUpgradeScan(db, { userId, limit: deps.scanSize ?? AVATAR_UPGRADE_SCAN_SIZE });
  const out: AvatarUpgradeResult = { ...EMPTY, upgradedIds: [], examined: scan.length };
  if (scan.length === 0) return out;

  const softRows: Array<UpgradeScanRow & { edge: number }> = [];
  const settled: string[] = [];
  for (const row of scan) {
    const dim = measureInlineJpeg(row.head);
    if (dim && isSoftEdge(minEdge(dim))) softRows.push({ ...row, edge: minEdge(dim) });
    else settled.push(row.id); // fine, or not something we can measure: look again in 90 days
  }
  out.soft = softRows.length;
  // Before any network: whatever happens to the lookups below, these were read.
  await stampChecked(db, userId, settled);

  for (const row of softRows) {
    if (out.attempted >= batchSize) break;
    if (deadlineReached(deadline, now)) {
      out.stopped = "budget";
      break;
    }
    if (!(await hasHeadroom(userId))) {
      out.stopped = "quota";
      break;
    }

    out.attempted += 1;
    let candidate: string | null = null;
    try {
      candidate = await fetchPhoto({ id: row.id, linkedinUrl: row.linkedinUrl }, userId);
    } catch (err) {
      if (err instanceof AvatarSourceRateLimitError) {
        out.stopped = "rate_limit";
        out.rateLimitedUntil = err.resetAt;
        break;
      }
      if (err instanceof AvatarStorageError) {
        out.stopped = "storage";
        break;
      }
      // Anything else is a failed lookup for this contact, like "found nothing": stamped below.
    }

    if (candidate && judgeUpgrade(row.edge, candidate) === "better") {
      // The swap only lands if the stored photo is still the one we measured: a photo the
      // person uploaded, or one another tab saved, since the scan must not be overwritten.
      const written = await db
        .update(contacts)
        .set({
          profileImageUrl: candidate,
          profileImageSource: "public",
          profileImageCheckedAt: new Date(),
          // `updated_at` stays: a background photo swap is not an edit (see the backfill's save).
        })
        .where(
          and(
            eq(contacts.id, row.id),
            eq(contacts.userId, userId),
            sql`${contacts.profileImageSource} IS NOT DISTINCT FROM ${row.source}`,
            sql`octet_length(${contacts.profileImageUrl}) = ${row.size}`
          )
        )
        .returning();
      if (written.length > 0) {
        out.upgraded += 1;
        out.upgradedIds.push(row.id);
      }
    } else {
      await stampChecked(db, userId, [row.id]);
    }
  }
  return out;
}
