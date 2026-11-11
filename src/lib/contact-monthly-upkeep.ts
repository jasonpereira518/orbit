/**
 * Monthly maintenance sweep for contacts across all accounts:
 * 1. Avatars: Re-checks contacts with missing, placeholder (orbit:no-photo:*), generic (aero),
 *    or stale avatars (> 30 days old) and updates them with authentic LinkedIn profile photos.
 * 2. Names: Resolves real names for contacts currently saved as handles, email prefixes, or
 *    usernames using direct LinkedIn profile metadata (og:title / <title>), connected address books,
 *    and AI name guessing.
 */

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import {
  fetchGravatarPhotoUrl,
  isLinkedInProfilePhoto,
  isUnusableAvatarUrl,
} from "@/lib/contact-avatar";
import {
  fetchLinkedInMetadataDirect,
  isLinkedInDirectRateLimited,
} from "@/lib/linkedin-scraper";
import {
  adoptPhotoIntoSharedPool,
  getSharedAvatar,
  isSharedFresh,
  resolveLinkedInPhotoCached,
  sharedPhotoSlug,
} from "@/lib/shared-avatars";
import {
  guessName,
  isHandle,
  type NameGuess,
  type ProviderNameIndex,
} from "@/lib/contact-name-guess";
import { handleCandidateSql } from "@/lib/contact-name-sweep";
import { updateContactForUser } from "@/lib/contact-writes";
import { internalFetch } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";
import { notTourExample } from "@/lib/onboarding-examples/sql";
import { splitName } from "@/lib/names/parse";

export const MONTHLY_UPKEEP_BATCH = 100;
const UPKEEP_BUDGET_MS = 60_000;

export type MonthlyUpkeepStats = {
  checked: number;
  avatarsUpdated: number;
  namesFixed: number;
  more: boolean;
};

export type MonthlyUpkeepDeps = {
  providerIndex: (userId: string) => Promise<ProviderNameIndex>;
  askAi: (userId: string, c: { fullName: string; email: string | null; company: string | null; title: string | null; linkedinUrl: string | null }) => Promise<{ first: string; last: string; full: string } | null>;
};

const DEFAULT_DEPS: MonthlyUpkeepDeps = {
  providerIndex: async (userId) =>
    (await import("@/lib/contact-avatar-connectors")).buildProviderNameIndex(userId),
  askAi: async () => null,
};

/**
 * SQL predicate matching contacts that need monthly audit/repair:
 * - Stale, missing, or generic/placeholder avatar with an identifier to check
 * - OR a handle-like name that can be resolved
 */
export function monthlyUpkeepCandidatePredicate(userId: string) {
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

  const needsName = handleCandidateSql();

  return and(
    eq(contacts.userId, userId),
    notTourExample(contacts.source),
    or(
      and(or(hasLinkedIn, hasEmail), needsAvatar),
      needsName
    )
  );
}


/**
 * Run monthly upkeep pass for a user's contacts.
 */
export async function runMonthlyContactUpkeep(
  userId: string,
  options?: { deadline?: number; deps?: Partial<MonthlyUpkeepDeps> }
): Promise<MonthlyUpkeepStats> {
  const deadline = options?.deadline ?? Date.now() + UPKEEP_BUDGET_MS;
  const deps = { ...DEFAULT_DEPS, ...options?.deps };
  const db = await getDb();

  const rows = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      linkedinUrl: contacts.linkedinUrl,
      company: contacts.company,
      title: contacts.title,
      profileImageUrl: contacts.profileImageUrl,
      profileImageCheckedAt: contacts.profileImageCheckedAt,
      nameGuess: contacts.nameGuess,
    })
    .from(contacts)
    .where(monthlyUpkeepCandidatePredicate(userId))
    .limit(MONTHLY_UPKEEP_BATCH);

  const stats: MonthlyUpkeepStats = {
    checked: 0,
    avatarsUpdated: 0,
    namesFixed: 0,
    more: rows.length === MONTHLY_UPKEEP_BATCH,
  };

  if (rows.length === 0) return stats;

  const addressBookIndex = rows.some((r) => r.email && isHandle(r.fullName, r.email))
    ? await deps.providerIndex(userId).catch(() => new Map())
    : new Map();

  for (const c of rows) {
    if (Date.now() >= deadline) {
      stats.more = true;
      break;
    }
    stats.checked++;

    const slug = sharedPhotoSlug(c.linkedinUrl);
    let resolvedLinkedInName: string | null = null;
    let resolvedLinkedInPhoto: string | null = null;

    // 1. Direct LinkedIn metadata fetch (returns BOTH profile picture and verified real name)
    if (slug && !isLinkedInDirectRateLimited()) {
      try {
        const meta = await fetchLinkedInMetadataDirect(slug);
        if (meta?.fullName) {
          resolvedLinkedInName = meta.fullName;
        }
        if (meta?.imageUrl && isLinkedInProfilePhoto(meta.imageUrl)) {
          resolvedLinkedInPhoto = meta.imageUrl;
          // Adopt into shared database immediately so everyone benefits
          await adoptPhotoIntoSharedPool(slug, meta.imageUrl, "linkedin_direct").catch(() => null);
        }
      } catch {
        // Direct scrape challenged: fall through to shared cache & ladder
      }
    }

    // 2. Avatar upkeep: check if avatar is missing, generic, or broken
    const currentAvatarUnusable = isUnusableAvatarUrl(c.profileImageUrl);
    const avatarStale =
      !c.profileImageCheckedAt ||
      Date.now() - c.profileImageCheckedAt.getTime() > 30 * 86_400_000;

    if (currentAvatarUnusable || avatarStale) {
      let newPhotoUrl: string | null = resolvedLinkedInPhoto;

      // Check shared database cache first
      if (!newPhotoUrl && slug) {
        const sharedRow = await getSharedAvatar(slug);
        if (sharedRow?.imageUrl && isSharedFresh(sharedRow)) {
          newPhotoUrl = sharedRow.imageUrl;
        }
      }

      // If still missing, try cache-first resolution ladder
      if (!newPhotoUrl && c.linkedinUrl) {
        try {
          const res = await resolveLinkedInPhotoCached(c.id, c.linkedinUrl, userId);
          if (typeof res === "string") newPhotoUrl = res;
          else if (res?.sharedUrl) newPhotoUrl = res.sharedUrl;
        } catch {
          // Rate limit or miss: continue
        }
      }

      // Gravatar fallback for contacts with email
      if (!newPhotoUrl && c.email) {
        newPhotoUrl = await fetchGravatarPhotoUrl(c.id, c.email).catch(() => null);
      }

      if (newPhotoUrl && newPhotoUrl !== c.profileImageUrl) {
        await db
          .update(contacts)
          .set({
            profileImageUrl: newPhotoUrl,
            profileImageCheckedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(contacts.id, c.id), eq(contacts.userId, userId)));
        stats.avatarsUpdated++;
      } else {
        // Stamp checked at so we don't hammer upstream until next monthly cycle
        await db
          .update(contacts)
          .set({ profileImageCheckedAt: new Date() })
          .where(and(eq(contacts.id, c.id), eq(contacts.userId, userId)));
      }
    }

    // 3. Name upkeep: check if name is a handle, username, or email prefix
    if (isHandle(c.fullName, c.email)) {
      let bestName = resolvedLinkedInName;
      let guessSource: NameGuess["source"] = "linkedin";
      let isWeak = false;

      // Address book index fallback
      if (!bestName && c.email) {
        const fromBook = addressBookIndex.get(c.email.trim().toLowerCase());
        if (fromBook?.full) {
          bestName = fromBook.full;
          guessSource = "address_book";
        }
      }

      // Heuristic guess fallback
      if (!bestName) {
        const heuristic = guessName(c, addressBookIndex);
        if (heuristic?.full) {
          bestName = heuristic.full;
          guessSource = heuristic.source;
          isWeak = heuristic.weak;
        }
      }

      if (bestName && bestName !== c.fullName) {
        const parts = splitName(bestName);
        const first = parts.firstName ?? "";
        const last = parts.lastName ?? "";
        const nameGuess: NameGuess = {
          from: c.fullName,
          source: guessSource,
          weak: isWeak,
          at: new Date().toISOString(),
        };

        await updateContactForUser(
          userId,
          c.id,
          {
            fullName: bestName,
            firstName: first,
            lastName: last,
            nameGuess,
          },
          { skipRevalidate: true, skipSummary: true, skipCloseness: true }
        );
        stats.namesFixed++;
      }
    }
  }

  return stats;
}

/**
 * Find users who have contacts requiring monthly maintenance.
 */
export async function usersWithMonthlyUpkeepCandidates(limit: number): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .selectDistinct({ userId: contacts.userId })
    .from(contacts)
    .where(
      and(
        notTourExample(contacts.source),
        or(
          and(
            or(
              sql`${contacts.linkedinUrl} IS NOT NULL AND btrim(${contacts.linkedinUrl}) <> ''`,
              sql`${contacts.email} IS NOT NULL AND btrim(${contacts.email}) <> ''`
            ),
            or(
              isNull(contacts.profileImageUrl),
              sql`btrim(${contacts.profileImageUrl}) = ''`,
              sql`${contacts.profileImageUrl} LIKE 'orbit:no-photo:%'`,
              sql`${contacts.profileImageUrl} LIKE '%static.licdn.com/aero%'`,
              sql`${contacts.profileImageCheckedAt} IS NULL`,
              sql`${contacts.profileImageCheckedAt} < now() - interval '30 days'`
            )
          ),
          handleCandidateSql()
        )
      )
    )
    .limit(limit);

  return rows.map((r) => r.userId);
}

/**
 * Trigger monthly upkeep pass for a user or the entire system.
 */
export async function kickMonthlyUpkeep(userId?: string) {
  try {
    await internalFetch("/api/contacts/monthly-upkeep", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(userId ? { userId } : {}),
    });
  } catch (err) {
    reportError(err, { where: "job.monthly-upkeep.kick", userId, level: "warning" });
  }
}
