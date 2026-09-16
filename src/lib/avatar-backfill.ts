import { and, asc, eq, notInArray, or, sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { AvatarStorageError, MicrolinkRateLimitError } from "@/lib/contact-avatar";
import { NO_PHOTO_PREFIX, NO_PHOTO_TTL_MS } from "@/lib/contact-avatar-url";
import { deadlineReached } from "@/lib/time-budget";

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * Selecting which contacts still need a photo, and resolving a bounded batch of them.
 *
 * The backfill is mounted on every authenticated page and fires on mount, so it is the
 * one piece of work whose cost every visit pays. It used to load `profile_image_url` —
 * base64 up to 120 KB — for EVERY contact just to classify the stored value in JS, then
 * resolve up to five contacts one after another with 15–20 s network timeouts each. On a
 * large network that alone could outrun the function's 60 s ceiling, and it was the most
 * likely producer of the exactly-60-seconds kills on whatever page happened to be open.
 *
 * Two changes, both asserted by `scripts/smoke-page-budgets.ts`:
 *   - the classification happens in SQL (`storedKind` below), the query is LIMITed, and
 *     the stored value is returned only when it is a short remote URL we intend to fetch;
 *   - the batch stops at a wall-clock deadline, so the action returns in bounded time
 *     whatever the network does. Unattempted contacts are simply pending for next tick.
 */

/**
 * What the stored `profile_image_url` is, decided in SQL so the value never leaves Postgres.
 *
 * The `no_photo` branch mirrors `hasFreshNoPhotoMarker`, and its absence was a real leak:
 * the negative-cache marker is not a URL, so it fell through to `'remote'` and the backfill
 * queued it as "a usable remote photo not yet in durable storage" — which sorts AHEAD of
 * LinkedIn lookups, is attempted every run, and can never succeed. The rows Orbit had
 * already established have no photo were the ones it retried first, forever.
 *
 * A marker inside its TTL is its own kind, excluded from the work predicate entirely. Past
 * the TTL it reads as `'none'`, which is what makes the negative cache expire rather than
 * become permanent. Both the prefix and the TTL are interpolated from the constants the JS
 * predicate uses, so the two cannot drift again.
 *
 * The digits guard matches the JS, which treats an unparseable suffix as stale: without it a
 * malformed marker would fail the bigint cast and take the whole query with it.
 */
/**
 * The epoch-millisecond stamp inside a marker, or the rest of the string if it is malformed.
 *
 * `substr(x, n)`, not `substring(x FROM n)`: with a bound parameter Postgres reads the
 * `FROM` form as the SQL-standard REGEX overload rather than the positional one, so the
 * offset was matched as a pattern and every marker's stamp came back NULL — which read as
 * "malformed", which read as "stale", which quietly disabled the negative cache entirely.
 * The offset is inlined rather than bound for the same reason.
 */
const noPhotoStamp = sql`substr(btrim(${contacts.profileImageUrl}), ${sql.raw(String(NO_PHOTO_PREFIX.length + 1))})`;

export const avatarBacklogKindSql = sql<"none" | "durable" | "unusable" | "remote" | "no_photo">`CASE
  WHEN ${contacts.profileImageUrl} IS NULL OR btrim(${contacts.profileImageUrl}) = '' THEN 'none'
  WHEN ${contacts.profileImageUrl} LIKE ${NO_PHOTO_PREFIX + "%"} THEN
    CASE
      WHEN ${noPhotoStamp} ~ '^[0-9]+$'
       AND (${noPhotoStamp})::bigint
           > (extract(epoch from now()) * 1000)::bigint - ${NO_PHOTO_TTL_MS}
      THEN 'no_photo'
      ELSE 'none'
    END
  WHEN ${contacts.profileImageUrl} LIKE 'data:image/%' THEN 'durable'
  WHEN ${contacts.profileImageUrl} LIKE '%.public.blob.vercel-storage.com%' THEN 'durable'
  WHEN ${contacts.profileImageUrl} LIKE '%unavatar.io%'
    OR ${contacts.profileImageUrl} LIKE '%static.licdn.com/aero%' THEN 'unusable'
  ELSE 'remote'
END`;

/** Mirrors the JS predicate the action used to apply after loading every row. */
function needsWorkPredicate(userId: string, skipIds: string[]) {
  const hasLinkedIn = sql`${contacts.linkedinUrl} IS NOT NULL AND btrim(${contacts.linkedinUrl}) <> ''`;
  return and(
    eq(contacts.userId, userId),
    skipIds.length > 0 ? notInArray(contacts.id, skipIds) : undefined,
    or(
      // Needs LinkedIn resolution: a profile to look up, and nothing usable stored.
      sql`(${hasLinkedIn}) AND ${avatarBacklogKindSql} IN ('none', 'unusable')`,
      // A usable remote photo that is not yet in durable storage.
      sql`${avatarBacklogKindSql} = 'remote'`
    )
  );
}

export type AvatarCandidate = {
  id: string;
  linkedinUrl: string | null;
  /** The stored URL, only when it is a remote photo worth caching. Never a data: URL. */
  remoteUrl: string | null;
};

/**
 * Up to `limit` contacts that still need a photo, cheapest work first: remote→durable
 * caching costs no Microlink quota, so it sorts ahead of LinkedIn lookups.
 */
export async function findAvatarBackfillCandidates(
  db: Db,
  userId: string,
  options: { limit: number; skipIds: string[] }
): Promise<AvatarCandidate[]> {
  const rows = await db
    .select({
      id: contacts.id,
      linkedinUrl: contacts.linkedinUrl,
      remoteUrl: sql<string | null>`CASE WHEN ${avatarBacklogKindSql} = 'remote' THEN ${contacts.profileImageUrl} ELSE NULL END`,
    })
    .from(contacts)
    .where(needsWorkPredicate(userId, options.skipIds))
    .orderBy(sql`CASE WHEN ${avatarBacklogKindSql} = 'remote' THEN 0 ELSE 1 END`, asc(contacts.id))
    .limit(Math.max(1, options.limit));
  return rows.map((r) => ({
    id: r.id,
    linkedinUrl: r.linkedinUrl?.trim() || null,
    remoteUrl: r.remoteUrl?.trim() || null,
  }));
}

/** How many contacts still need a photo — the backlog the client shows progress against. */
export async function countAvatarBackfillCandidates(
  db: Db,
  userId: string,
  skipIds: string[]
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(needsWorkPredicate(userId, skipIds));
  return row?.n ?? 0;
}

export type AvatarBatchDeps = {
  /** Epoch ms. The loop attempts no new contact once this has passed. */
  deadline: number;
  now?: () => number;
  /** Cache a remote photo durably; null when it cannot be fetched or decoded. */
  persistRemote: (contactId: string, url: string) => Promise<string | null>;
  /** Resolve a LinkedIn profile photo; null when none is findable. */
  resolveLinkedIn: (contactId: string, linkedinUrl: string) => Promise<string | null>;
  save: (contactId: string, photoUrl: string) => Promise<void>;
};

export type AvatarBatchResult = {
  saved: number;
  savedIds: string[];
  /** Attempted and unresolvable — the client passes these back as `skipIds`. */
  failedIds: string[];
  failed: number;
  /** Candidates left for a later tick: unattempted, or rate-limited and worth retrying. */
  pending: number;
  rateLimitedUntil: number | null;
  /** Set when the photo store itself is broken — the whole run should stop. */
  storageError: string | null;
};

export async function runAvatarBackfillBatch(
  candidates: AvatarCandidate[],
  deps: AvatarBatchDeps
): Promise<AvatarBatchResult> {
  const now = deps.now ?? Date.now;
  let saved = 0;
  let failed = 0;
  const savedIds: string[] = [];
  const failedIds: string[] = [];
  let rateLimitedUntil: number | null = null;
  let storageError: string | null = null;

  for (const contact of candidates) {
    if (deadlineReached(deps.deadline, now)) break;
    try {
      let photoUrl: string | null = null;

      if (contact.remoteUrl) {
        photoUrl = await deps.persistRemote(contact.id, contact.remoteUrl);
      }

      if (!photoUrl && contact.linkedinUrl) {
        try {
          photoUrl = await deps.resolveLinkedIn(contact.id, contact.linkedinUrl);
        } catch (err) {
          if (err instanceof MicrolinkRateLimitError) {
            rateLimitedUntil = err.resetAt;
            // Unavatar was already tried inside the resolver; retry after the cooldown.
            failed += 1;
            continue;
          }
          throw err;
        }
      }

      if (!photoUrl) {
        failed += 1;
        failedIds.push(contact.id);
        continue;
      }

      await deps.save(contact.id, photoUrl);
      saved += 1;
      savedIds.push(contact.id);
    } catch (err) {
      if (err instanceof MicrolinkRateLimitError) {
        rateLimitedUntil = err.resetAt;
        break;
      }
      if (err instanceof AvatarStorageError) {
        // Every remaining contact would fail the same way — stop the run.
        storageError = err.message;
        break;
      }
      failed += 1;
      failedIds.push(contact.id);
    }
  }

  return {
    saved,
    savedIds,
    failedIds,
    failed,
    pending: Math.max(0, candidates.length - saved - failedIds.length),
    rateLimitedUntil,
    storageError,
  };
}
