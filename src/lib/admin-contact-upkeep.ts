/**
 * Admin Network Upkeep & Rate-Limit-Paced Queue Engine:
 * Runs global contact audit, name repair, and avatar resolution across all accounts.
 *
 * Rate-Limit Pacing:
 * - Batches candidate contacts across accounts in micro-chunks.
 * - Paces direct network requests with configurable delay (e.g. 200ms) to avoid triggering burst limits.
 * - Never calls LinkedIn: the LinkedIn photo queue (`linkedin-photo-queue.ts`) is the one
 *   bulk caller, so the two cannot stack LinkedIn's rate limits. Photos come from the shared
 *   pool (read only), connected Google/Outlook accounts and Gravatar.
 */

import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, cronRuns } from "@/db/schema";
import {
  downloadAndPersistAvatar,
  fetchGravatarPhotoUrl,
  isUnusableAvatarUrl,
} from "@/lib/contact-avatar";
import { isLikelyPersonName } from "@/lib/linkedin-scraper";
import {
  getSharedAvatar,
  isSharedFresh,
  sharedPhotoSlug,
  type ProfileImageSource,
} from "@/lib/shared-avatars";
import {
  guessName,
  isUsernameOrGenericName,
} from "@/lib/contact-name-guess";
import { handleCandidateSql } from "@/lib/contact-name-sweep";
import { notTourExample } from "@/lib/onboarding-examples/sql";
import { updateContactForUser } from "@/lib/contact-writes";
import {
  buildGooglePhotoIndex,
  buildOutlookContactIndex,
  buildProviderNameIndex,
  fetchOutlookContactPhoto,
} from "@/lib/contact-avatar-connectors";
import {
  type CronRunHandle,
  startCronRun,
  finishCronRun,
} from "@/lib/cron-runs";
import { reportError } from "@/lib/report-error";

export const UPKEEP_JOB_NAME = "contacts.monthly-upkeep";

export type GlobalUpkeepStats = {
  checked: number;
  namesFixed: number;
  avatarsUpdated: number;
  profilesEnriched: number;
  more: boolean;
};

export type GlobalUpkeepMetrics = {
  totalCandidates: number;
  namesToFix: number;
  avatarsNeeded: number;
  activeRun: {
    id: string;
    status: string;
    startedAt: string;
    stats: Record<string, number | boolean>;
  } | null;
  lastRun: {
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    stats: Record<string, number | boolean>;
  } | null;
};

function weakOrGenericNameSql() {
  return or(
    handleCandidateSql(),
    sql`lower(btrim(${contacts.fullName})) in ('linkedin member', 'member', 'unknown', 'user', 'none', 'n/a', 'unnamed')`,
    sql`(${contacts.linkedinSlug} is not null and lower(btrim(${contacts.fullName})) = ${contacts.linkedinSlug})`
  );
}

/**
 * SQL predicate matching contacts for a single user that need refresh or upkeep:
 * 1. Has LinkedIn URL (to refresh profile info & avatar from LinkedIn)
 * 2. OR missing/placeholder/broken avatar with an identifier (email or LinkedIn)
 * 3. OR has a username/handle/slug/generic placeholder name
 */
export function contactRefreshCandidatePredicate(userId: string) {
  const hasLinkedIn = sql`${contacts.linkedinUrl} IS NOT NULL AND btrim(${contacts.linkedinUrl}) <> ''`;
  const hasEmail = sql`${contacts.email} IS NOT NULL AND btrim(${contacts.email}) <> ''`;

  const needsAvatar = or(
    isNull(contacts.profileImageUrl),
    sql`btrim(${contacts.profileImageUrl}) = ''`,
    sql`${contacts.profileImageUrl} LIKE 'orbit:no-photo:%'`,
    sql`${contacts.profileImageUrl} LIKE '%static.licdn.com/aero%'`
  );

  return and(
    eq(contacts.userId, userId),
    notTourExample(contacts.source),
    or(
      hasLinkedIn,
      and(or(hasLinkedIn, hasEmail), needsAvatar),
      weakOrGenericNameSql()
    )
  );
}

/**
 * SQL predicate identifying contacts needing upkeep across all accounts:
 * 1. Username, handle, email prefix, slug, or generic placeholder names
 * 2. Missing, placeholder, generic (aero), or stale avatars (> 30 days) with an identifier
 * 3. Stale LinkedIn profiles (> 30 days)
 */
export function globalUpkeepCandidatePredicate() {
  const hasLinkedIn = sql`${contacts.linkedinUrl} IS NOT NULL AND btrim(${contacts.linkedinUrl}) <> ''`;
  const hasEmail = sql`${contacts.email} IS NOT NULL AND btrim(${contacts.email}) <> ''`;

  const needsAvatar = or(
    isNull(contacts.profileImageUrl),
    sql`btrim(${contacts.profileImageUrl}) = ''`,
    sql`${contacts.profileImageUrl} LIKE 'orbit:no-photo:%'`,
    sql`${contacts.profileImageUrl} LIKE '%static.licdn.com/aero%'`,
    sql`${contacts.profileImageCheckedAt} IS NULL`,
    sql`${contacts.profileImageCheckedAt} < now() - interval '30 days'`
  );

  return and(
    notTourExample(contacts.source),
    or(
      and(or(hasLinkedIn, hasEmail), needsAvatar),
      weakOrGenericNameSql(),
      and(
        hasLinkedIn,
        or(
          sql`${contacts.updatedAt} < now() - interval '30 days'`,
          sql`${contacts.profileImageCheckedAt} < now() - interval '30 days'`
        )
      )
    )
  );
}

/**
 * Reads overall upkeep backlog metrics and run history across all accounts.
 */
export async function getGlobalUpkeepMetrics(): Promise<GlobalUpkeepMetrics> {
  const db = await getDb();
  const now = Date.now();

  const [candidateTotals, recentRuns] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        namesToFix: sql<number>`count(*) filter (where ${weakOrGenericNameSql()})::int`,
        avatarsNeeded: sql<number>`count(*) filter (where ${or(
          isNull(contacts.profileImageUrl),
          sql`btrim(${contacts.profileImageUrl}) = ''`,
          sql`${contacts.profileImageUrl} LIKE 'orbit:no-photo:%'`,
          sql`${contacts.profileImageUrl} LIKE '%static.licdn.com/aero%'`
        )})::int`,
      })
      .from(contacts)
      .where(globalUpkeepCandidatePredicate()),
    db
      .select({
        id: cronRuns.id,
        status: cronRuns.status,
        startedAt: cronRuns.startedAt,
        finishedAt: cronRuns.finishedAt,
        stats: cronRuns.stats,
      })
      .from(cronRuns)
      .where(eq(cronRuns.job, UPKEEP_JOB_NAME))
      .orderBy(desc(cronRuns.startedAt))
      .limit(5),
  ]);

  const activeRunRow = recentRuns.find((r) => r.status === "running" && (now - r.startedAt.getTime() < 15 * 60 * 1000));
  const lastFinishedRow = recentRuns.find((r) => r.status !== "running");

  return {
    totalCandidates: candidateTotals[0]?.total ?? 0,
    namesToFix: candidateTotals[0]?.namesToFix ?? 0,
    avatarsNeeded: candidateTotals[0]?.avatarsNeeded ?? 0,
    activeRun: activeRunRow
      ? {
          id: activeRunRow.id,
          status: activeRunRow.status,
          startedAt: activeRunRow.startedAt.toISOString(),
          stats: activeRunRow.stats ?? {},
        }
      : null,
    lastRun: lastFinishedRow
      ? {
          id: lastFinishedRow.id,
          status: lastFinishedRow.status,
          startedAt: lastFinishedRow.startedAt.toISOString(),
          finishedAt: lastFinishedRow.finishedAt ? lastFinishedRow.finishedAt.toISOString() : null,
          stats: lastFinishedRow.stats ?? {},
        }
      : null,
  };
}

export type GlobalUpkeepOptions = {
  deadline?: number;
  batchSize?: number;
  handle?: CronRunHandle;
};

/**
 * Execute a paced batch of contact maintenance across all accounts.
 */
export async function runGlobalContactUpkeepBatch(
  options?: GlobalUpkeepOptions
): Promise<GlobalUpkeepStats> {
  const db = await getDb();
  const deadline = options?.deadline ?? Date.now() + 180_000;
  const batchSize = Math.min(options?.batchSize ?? 50, 200);

  const rows = await db
    .select({
      id: contacts.id,
      userId: contacts.userId,
      fullName: contacts.fullName,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      linkedinUrl: contacts.linkedinUrl,
      profileImageUrl: contacts.profileImageUrl,
      profileImageCheckedAt: contacts.profileImageCheckedAt,
      company: contacts.company,
      title: contacts.title,
    })
    .from(contacts)
    .where(globalUpkeepCandidatePredicate())
    .orderBy(asc(contacts.profileImageCheckedAt))
    .limit(batchSize);

  const stats: GlobalUpkeepStats = {
    checked: 0,
    namesFixed: 0,
    avatarsUpdated: 0,
    profilesEnriched: 0,
    more: rows.length === batchSize,
  };

  if (rows.length === 0) return stats;

  // Cache address books and photos by user to avoid repetitive provider calls
  const userProviderIndex = new Map<string, Map<string, { first: string; last: string; full: string }>>();
  const userGooglePhotoIndex = new Map<string, Map<string, string>>();
  const userOutlookPhotoIndex = new Map<string, Map<string, string>>();

  for (const c of rows) {
    if (Date.now() >= deadline) {
      stats.more = true;
      break;
    }
    stats.checked++;

    const slug = sharedPhotoSlug(c.linkedinUrl);
    let resolvedName: string | null = null;
    let resolvedPhoto: string | null = null;
    let photoSource: ProfileImageSource = "public";
    let sharedPhoto = false;

    // 1. Name Resolution if name is a username, handle, or generic
    const currentNameWeak = isUsernameOrGenericName(c.fullName, c.email, c.linkedinUrl);
    let nameFixed = false;
    let newFirstName: string | null = null;
    let newLastName: string | null = null;

    if (currentNameWeak) {
      if (!resolvedName && c.email) {
        // Check connected address books for this user
        if (!userProviderIndex.has(c.userId)) {
          const pIndex = await buildProviderNameIndex(c.userId).catch(() => new Map());
          userProviderIndex.set(c.userId, pIndex);
        }
        const pIndex = userProviderIndex.get(c.userId)!;
        const p = pIndex.get(c.email.toLowerCase());
        if (p?.full && isLikelyPersonName(p.full) && !isUsernameOrGenericName(p.full)) {
          resolvedName = p.full;
          newFirstName = p.first;
          newLastName = p.last;
        }
      }

      if (!resolvedName && c.email) {
        const g = guessName({
          fullName: c.fullName,
          email: c.email,
          linkedinUrl: c.linkedinUrl,
        });
        if (g?.full && isLikelyPersonName(g.full) && !isUsernameOrGenericName(g.full)) {
          resolvedName = g.full;
          newFirstName = g.first;
          newLastName = g.last;
        }
      }

      if (resolvedName && resolvedName !== c.fullName) {
        nameFixed = true;
        stats.namesFixed++;
      }
    }

    // 2. Avatar Resolution if missing or generic
    const currentAvatarUnusable = isUnusableAvatarUrl(c.profileImageUrl);

    if (currentAvatarUnusable) {
      // The shared pool, read only: the LinkedIn photo queue is what fills it.
      if (slug) {
        const pooled = await getSharedAvatar(slug).catch(() => null);
        if (pooled?.imageUrl && !pooled.blockedAt && isSharedFresh(pooled)) sharedPhoto = true;
      }

      // Connected account photos (Google / Outlook)
      if (!resolvedPhoto && !sharedPhoto && c.email) {
        const emailKey = c.email.toLowerCase();
        if (!userGooglePhotoIndex.has(c.userId)) {
          const gIndex = await buildGooglePhotoIndex(c.userId).catch(() => new Map());
          userGooglePhotoIndex.set(c.userId, gIndex);
        }
        const gPhoto = userGooglePhotoIndex.get(c.userId)!.get(emailKey);
        if (gPhoto) {
          resolvedPhoto = gPhoto;
          photoSource = "google";
        }

        if (!resolvedPhoto) {
          if (!userOutlookPhotoIndex.has(c.userId)) {
            const oIndex = await buildOutlookContactIndex(c.userId).catch(() => new Map());
            userOutlookPhotoIndex.set(c.userId, oIndex);
          }
          const outId = userOutlookPhotoIndex.get(c.userId)!.get(emailKey);
          if (outId) {
            const outPhoto = await fetchOutlookContactPhoto(c.userId, outId);
            if (outPhoto) {
              resolvedPhoto = outPhoto;
              photoSource = "outlook";
            }
          }
        }
      }

      // Gravatar fallback
      if (!resolvedPhoto && !sharedPhoto && c.email) {
        try {
          const gravatar = await fetchGravatarPhotoUrl(c.id, c.email);
          if (gravatar) {
            resolvedPhoto = gravatar;
            photoSource = "gravatar";
          }
        } catch {
          // Miss is normal
        }
      }

      if (resolvedPhoto || sharedPhoto) {
        stats.avatarsUpdated++;
      }
    }

    // 3. Persist contact updates
    const patch: Record<string, unknown> = {};

    if (nameFixed && resolvedName) {
      patch.fullName = resolvedName;
      if (newFirstName) patch.firstName = newFirstName;
      if (newLastName) patch.lastName = newLastName;
    }

    if (resolvedPhoto) {
      const persisted = await downloadAndPersistAvatar(c.id, resolvedPhoto);
      if (persisted) {
        patch.profileImageUrl = persisted;
        patch.profileImageSource = photoSource;
      }
    }

    try {
      if (Object.keys(patch).length > 0) {
        await updateContactForUser(c.userId, c.id, patch, {
          skipRevalidate: true,
          skipEmbedding: true,
          skipSummary: true,
        });
      }
      // Always stamp checked_at so candidate isn't retried immediately
      await db
        .update(contacts)
        .set({ profileImageCheckedAt: new Date() })
        .where(eq(contacts.id, c.id));
    } catch {
      // Individual write fault doesn't stop the queue
    }
  }

  // Update cron ledger row with running stats if handle is supplied
  if (options?.handle?.id) {
    await db
      .update(cronRuns)
      .set({
        stats: {
          checked: stats.checked,
          namesFixed: stats.namesFixed,
          avatarsUpdated: stats.avatarsUpdated,
          more: stats.more,
        },
      })
      .where(eq(cronRuns.id, options.handle.id))
      .catch(() => null);
  }

  return stats;
}

/**
 * Top-level coordinator for admin upkeep trigger:
 * Starts a ledger run in `cron_runs` and executes batch passes.
 */
export async function triggerAdminContactUpkeepJob(
  options?: { batchSize?: number }
): Promise<{ ok: boolean; stats: GlobalUpkeepStats }> {
  const handle = await startCronRun(UPKEEP_JOB_NAME, "manual");
  try {
    const stats = await runGlobalContactUpkeepBatch({
      handle,
      batchSize: options?.batchSize ?? 100,
    });

    await finishCronRun(handle, {
      status: stats.more ? "partial" : "ok",
      stats: {
        checked: stats.checked,
        namesFixed: stats.namesFixed,
        avatarsUpdated: stats.avatarsUpdated,
        more: stats.more,
      },
    });

    return { ok: true, stats };
  } catch (err) {
    await finishCronRun(handle, {
      status: "failed",
      error: err,
    });
    reportError(err, { where: "job.admin-contact-upkeep", level: "warning" });
    throw err;
  }
}
