import { and, asc, eq, notInArray, or, sql } from "drizzle-orm";
import type { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { AvatarSourceRateLimitError, AvatarStorageError } from "@/lib/contact-avatar";
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
 * How long a failed lookup is remembered before the contact is tried again.
 *
 * The backfill is mounted on every authenticated page, so without this every visit
 * re-attempted every unresolvable contact against every free tier. Free in dollars,
 * but not in latency or in goodwill with the upstream services.
 */
export const AVATAR_RECHECK_DAYS = 30;

/** What the stored `profile_image_url` is, decided in SQL so the value never leaves Postgres. */
const storedKind = sql<"none" | "durable" | "unusable" | "remote">`CASE
  WHEN ${contacts.profileImageUrl} IS NULL OR btrim(${contacts.profileImageUrl}) = '' THEN 'none'
  WHEN ${contacts.profileImageUrl} LIKE 'data:image/%' THEN 'durable'
  WHEN ${contacts.profileImageUrl} LIKE '%.public.blob.vercel-storage.com%' THEN 'durable'
  WHEN ${contacts.profileImageUrl} LIKE '%unavatar.io%'
    OR ${contacts.profileImageUrl} LIKE '%static.licdn.com/aero%' THEN 'unusable'
  ELSE 'remote'
END`;

/** Mirrors the JS predicate the action used to apply after loading every row. */
function needsWorkPredicate(userId: string, skipIds: string[]) {
  const hasLinkedIn = sql`${contacts.linkedinUrl} IS NOT NULL AND btrim(${contacts.linkedinUrl}) <> ''`;
  const hasEmail = sql`${contacts.email} IS NOT NULL AND btrim(${contacts.email}) <> ''`;
  return and(
    eq(contacts.userId, userId),
    skipIds.length > 0 ? notInArray(contacts.id, skipIds) : undefined,
    or(
      // Something to look up — a LinkedIn profile or an email for Gravatar — and
      // nothing usable stored. Email alone qualifies, so the backlog counter is
      // larger than it was before Gravatar existed.
      //
      // A contact we already tried and failed is left alone until the cooldown
      // expires; otherwise the backlog never shrinks and every visit re-pays for it.
      sql`(${hasLinkedIn} OR ${hasEmail})
        AND ${storedKind} IN ('none', 'unusable')
        AND (${contacts.profileImageCheckedAt} IS NULL
             OR ${contacts.profileImageCheckedAt} < now() - ${sql.raw(`interval '${AVATAR_RECHECK_DAYS} days'`)})`,
      // A usable remote photo that is not yet in durable storage. Always worth a go:
      // it costs no third-party quota, just a fetch we already know the URL for.
      sql`${storedKind} = 'remote'`
    )
  );
}

export type AvatarCandidate = {
  id: string;
  linkedinUrl: string | null;
  email: string | null;
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
      email: contacts.email,
      remoteUrl: sql<string | null>`CASE WHEN ${storedKind} = 'remote' THEN ${contacts.profileImageUrl} ELSE NULL END`,
    })
    .from(contacts)
    .where(needsWorkPredicate(userId, options.skipIds))
    .orderBy(sql`CASE WHEN ${storedKind} = 'remote' THEN 0 ELSE 1 END`, asc(contacts.id))
    .limit(Math.max(1, options.limit));
  return rows.map((r) => ({
    id: r.id,
    linkedinUrl: r.linkedinUrl?.trim() || null,
    email: r.email?.trim() || null,
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
  /** Resolve a photo from Gravatar by email; null when the address has none. */
  resolveGravatar: (contactId: string, email: string) => Promise<string | null>;
  save: (contactId: string, photoUrl: string) => Promise<void>;
  /** Record that a contact was tried and yielded nothing, starting its cooldown. */
  markChecked: (contactId: string) => Promise<void>;
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
      // Set when a source refused us for quota rather than answering. Such a contact
      // stays retryable (kept out of failedIds, never cooldown-stamped) so it gets a
      // real look once the source's quota resets.
      let quotaDeferred = false;

      if (contact.remoteUrl) {
        photoUrl = await deps.persistRemote(contact.id, contact.remoteUrl);
      }

      if (!photoUrl && contact.linkedinUrl) {
        try {
          photoUrl = await deps.resolveLinkedIn(contact.id, contact.linkedinUrl);
        } catch (err) {
          if (err instanceof AvatarSourceRateLimitError) {
            rateLimitedUntil = err.resetAt;
            // A quota'd tier (Unavatar or Microlink) never got a real look. Gravatar is a
            // different service, so still try it — but keep the contact retryable.
            quotaDeferred = true;
          } else {
            throw err;
          }
        }
      }

      if (!photoUrl && contact.email) {
        photoUrl = await deps.resolveGravatar(contact.id, contact.email);
      }

      if (!photoUrl) {
        failed += 1;
        // A quota-deferred contact is not a real miss — do not start its cooldown, or
        // Unavatar's 25-a-day limit would write off everyone past the 25th for a month.
        if (!quotaDeferred) {
          failedIds.push(contact.id);
          await deps.markChecked(contact.id);
        }
        continue;
      }

      await deps.save(contact.id, photoUrl);
      saved += 1;
      savedIds.push(contact.id);
    } catch (err) {
      if (err instanceof AvatarSourceRateLimitError) {
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
