"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getDb } from "@/db";
import {
  recruiters,
  recruiterContactUnlocks,
  userRecruiterLinks,
  userSettings,
  type RecruiterLinkStatus,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { requireRecruitersUser } from "@/lib/plan-guards";
import { getEntitlements } from "@/lib/entitlements";
import { getCreditBalance, settleCredits } from "@/lib/credits/ledger";
import { creditsToMicros } from "@/lib/credits/grants";
import {
  MIN_RECRUITERS_FOR_SHARING,
  communityScore,
  getUserRecruiterCount,
  isViewerSharing,
  listPoolDiscoveries,
  pooledRecruiterIds,
  recomputeRecruiterRating,
  resweepUserRatings,
  searchCanonicalRecruiters,
  pooledIdsForViewer,
  rederiveSharedRecruiterPii,
  resolveRecruiterPii,
  toPublicRecruiter,
  unlockedRecruiterIdsForViewer,
  type PublicRecruiter,
} from "@/lib/recruiters";
import { ActionResult, asActionResult, UserFacingError } from "@/lib/errors";
import { logRecruiterForUser, updateMyLinkForUser, type LogRecruiterInput } from "@/lib/recruiter-writes";
import { reportError } from "@/lib/report-error";

function revalidateRecruiterPaths(id?: string) {
  revalidatePath("/recruiters");
  revalidatePath("/chat");
  if (id) revalidatePath(`/recruiters/${id}`);
}

/** Pool recruiters the user has not logged. Empty unless they are sharing. */
export async function listDiscoverRecruiters(
  q?: string
): Promise<PublicRecruiter[]> {
  const userId = await requireRecruitersUser();
  const sharing = await isViewerSharing(userId);
  if (!sharing) return [];
  const rows = await listPoolDiscoveries({
    viewerUserId: userId,
    viewerIsSharing: true,
    q,
    limit: 40,
  });
  const unlocked = await unlockedRecruiterIdsForViewer(
    userId,
    rows.map((r) => r.id)
  );
  return rows.map((r) => toPublicRecruiter(r, null, true, unlocked.has(r.id)));
}

export async function listMyRecruiters(): Promise<PublicRecruiter[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const links = await db.query.userRecruiterLinks.findMany({
    where: eq(userRecruiterLinks.userId, userId),
    with: { recruiter: true },
    orderBy: [desc(userRecruiterLinks.updatedAt)],
  });
  const pooled = await pooledIdsForViewer(userId, links.map((l) => l.recruiterId));
  return links.map((l) => toPublicRecruiter(l.recruiter, l, pooled.has(l.recruiterId), true));
}

export async function getRecruiter(id: string): Promise<PublicRecruiter | null> {
  const userId = await requireUserId();
  const db = await getDb();
  const row = await db.query.recruiters.findFirst({
    where: eq(recruiters.id, id),
  });
  if (!row) return null;
  const link = await db.query.userRecruiterLinks.findFirst({
    where: and(
      eq(userRecruiterLinks.userId, userId),
      eq(userRecruiterLinks.recruiterId, id)
    ),
  });

  // Detail is reachable by guessing a uuid, so it needs the same gate as the list.
  // Without a link, the row must be in the pool *and* the viewer must be sharing.
  if (!link) {
    const sharing = await isViewerSharing(userId);
    if (!sharing) return null;
    const pooled = await pooledRecruiterIds([id]);
    if (!pooled.has(id)) return null;
  }

  const isPooled = (await pooledIdsForViewer(userId, [id])).has(id);
  const isUnlocked = link ? true : (await unlockedRecruiterIdsForViewer(userId, [id])).has(id);

  return toPublicRecruiter(row, link ?? null, isPooled, isUnlocked);
}

/** Current sharing state and recruiter count for the toggle card. */
export async function getRecruiterSharing(): Promise<{
  enabled: boolean;
  recruiterCount: number;
  minRequired: number;
}> {
  const userId = await requireUserId();
  const [enabled, recruiterCount] = await Promise.all([
    isViewerSharing(userId),
    getUserRecruiterCount(userId),
  ]);
  return { enabled, recruiterCount, minRequired: MIN_RECRUITERS_FOR_SHARING };
}

/**
 * Flip the global opt-in. Requires at least 5 recruiters logged to enable sharing.
 */
export async function setRecruiterSharing(enabled: boolean) {
  const userId = await requireRecruitersUser();
  if (enabled) {
    const count = await getUserRecruiterCount(userId);
    if (count < MIN_RECRUITERS_FOR_SHARING) {
      throw new UserFacingError(
        `You need at least ${MIN_RECRUITERS_FOR_SHARING} recruiters in your list to join the shared pool (you currently have ${count}/${MIN_RECRUITERS_FOR_SHARING})`
      );
    }
  }

  const db = await getDb();
  await db
    .update(userSettings)
    .set({ recruiterSharing: enabled ? 1 : 0, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));

  after(async () => {
    try {
      await resweepUserRatings(userId);
      revalidatePath("/recruiters");
    } catch (err) {
      reportError(err, { where: "action.recruiters.rating-resweep", userId, level: "warning" });
    }
  });

  revalidateRecruiterPaths();
  return { enabled };
}

/**
 * Unlock a shared community recruiter's contact information (email, LinkedIn) using 1 credit.
 * Once unlocked, it stays permanently accessible for this user.
 */
export async function unlockRecruiterContact(recruiterId: string): Promise<
  ActionResult<{ email: string | null; linkedinUrl: string | null; phone: string | null }>
> {
  return asActionResult(async () => {
    const userId = await requireRecruitersUser();
    const sharing = await isViewerSharing(userId);
    if (!sharing) {
      throw new UserFacingError(
        "You must share at least 5 recruiters with the pool to unlock recruiter contact details"
      );
    }

    const db = await getDb();
    const recruiter = await db.query.recruiters.findFirst({
      where: eq(recruiters.id, recruiterId),
    });
    if (!recruiter) {
      throw new UserFacingError("Recruiter not found");
    }

    // 1. Check if already unlocked or user's own recruiter
    const ownLink = await db.query.userRecruiterLinks.findFirst({
      where: and(
        eq(userRecruiterLinks.userId, userId),
        eq(userRecruiterLinks.recruiterId, recruiterId)
      ),
    });
    if (ownLink) {
      return {
        email: ownLink.email || recruiter.email,
        linkedinUrl: ownLink.linkedinUrl || recruiter.linkedinUrl,
        phone: ownLink.phone || recruiter.phone,
      };
    }

    const existingUnlock = await db.query.recruiterContactUnlocks.findFirst({
      where: and(
        eq(recruiterContactUnlocks.userId, userId),
        eq(recruiterContactUnlocks.recruiterId, recruiterId)
      ),
    });
    if (existingUnlock) {
      return {
        email: recruiter.email,
        linkedinUrl: recruiter.linkedinUrl,
        phone: recruiter.phone,
      };
    }

    // 2. Check user's spendable credits
    const { plan } = await getEntitlements(userId);
    const settings = await db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
    });
    const balance = await getCreditBalance(userId, plan, settings);
    if (balance.spendable < creditsToMicros(1)) {
      throw new UserFacingError(
        "You need at least 1 credit to unlock this recruiter’s contact details"
      );
    }

    // 3. Settle 1 credit in the ledger
    const ledgerOp = "recruiter.unlock";
    await settleCredits({
      userId,
      operation: ledgerOp,
      micros: creditsToMicros(1),
    });

    // 4. Record the permanent unlock
    await db.insert(recruiterContactUnlocks).values({
      userId,
      recruiterId,
      costCredits: 1,
    });

    revalidateRecruiterPaths(recruiterId);
    return {
      email: recruiter.email,
      linkedinUrl: recruiter.linkedinUrl,
      phone: recruiter.phone,
    };
  });
}

/** Per-recruiter exception to the global opt-in. */
export async function setLinkShared(recruiterId: string, shared: boolean) {
  const userId = await requireRecruitersUser();
  const db = await getDb();
  const link = await db.query.userRecruiterLinks.findFirst({
    where: and(
      eq(userRecruiterLinks.userId, userId),
      eq(userRecruiterLinks.recruiterId, recruiterId)
    ),
  });
  if (!link) throw new Error("You have not logged this recruiter yet");

  await db
    .update(userRecruiterLinks)
    .set({ sharedToPool: shared ? 1 : 0, updatedAt: new Date() })
    .where(eq(userRecruiterLinks.id, link.id));

  await recomputeRecruiterRating(recruiterId);
  // This link just joined or left the pool: the shared row re-derives what is still vouched for.
  await rederiveSharedRecruiterPii(recruiterId, { withdrawn: link });
  revalidateRecruiterPaths(recruiterId);
  return { shared };
}

export type { LogRecruiterInput } from "@/lib/recruiter-writes";

export async function logRecruiter(input: LogRecruiterInput) {
  return asActionResult(async () => {
    const userId = await requireRecruitersUser();
    // The writes — shared row, the user's own link, the rating — are in `logRecruiterForUser`,
    // shared with chat.
    const { id } = await logRecruiterForUser(userId, input);
    revalidateRecruiterPaths(id);
    return { id };
  });
}

export async function updateMyLink(
  recruiterId: string,
  patch: {
    status?: RecruiterLinkStatus;
    notes?: string | null;
    personalRating?: number | null;
  }
) {
  const userId = await requireRecruitersUser();
  const changed = await updateMyLinkForUser(userId, recruiterId, patch);
  if (!changed) throw new Error("You have not logged this recruiter yet");
  revalidateRecruiterPaths(recruiterId);
}

/** For chat: personal links first, then top community matches. */
export async function loadRecruitersForChat(
  question: string,
  limit = 8
) {
  const userId = await requireUserId();
  const db = await getDb();
  const personal = await db.query.userRecruiterLinks.findMany({
    where: eq(userRecruiterLinks.userId, userId),
    with: { recruiter: true },
    orderBy: [desc(userRecruiterLinks.updatedAt)],
    limit: 20,
  });
  // Chat recites what it is given, so it gets only the details this viewer may read.
  const pooledPersonal = await pooledIdsForViewer(userId, personal.map((l) => l.recruiterId));

  const q = question.toLowerCase();
  const tokens = q
    .split(/[^a-z0-9+]+/)
    .filter((t) => t.length > 2 && !["the", "and", "for", "who", "best", "are", "my"].includes(t));

  const scoredPersonal = personal
    .map((l) => {
      const r = l.recruiter;
      const hay = `${r.fullName} ${r.firm || ""} ${(r.specialty || []).join(" ")}`.toLowerCase();
      const tokenHits = tokens.filter((t) => hay.includes(t)).length;
      const personalBoost = (l.personalRating || 0) * 2;
      return {
        id: r.id,
        fullName: r.fullName,
        firm: r.firm,
        specialty: r.specialty || [],
        avgRating: r.avgRating,
        logCount: r.logCount,
        personalRating: l.personalRating,
        status: l.status,
        notes: l.notes,
        contactId: l.contactId,
        piiUnlocked: true,
        ...(({ email, linkedinUrl }) => ({ email, linkedinUrl }))(
          resolveRecruiterPii(r, l, pooledPersonal.has(r.id))
        ),
        score: 100 + personalBoost + tokenHits * 10 + communityScore(r),
      };
    })
    .sort((a, b) => b.score - a.score);

  // Chat is a read surface like any other: a private user gets no community tier at all,
  // otherwise the assistant would happily recite the directory they opted out of.
  const community = await searchCanonicalRecruiters({
    q: tokens.slice(0, 3).join(" ") || undefined,
    limit: 20,
    viewerUserId: userId,
    viewerIsSharing: await isViewerSharing(userId),
  });
  const personalIds = new Set(scoredPersonal.map((p) => p.id));
  const communityRows = community
    .filter((r) => !personalIds.has(r.id))
    .map((r) => {
      const hay = `${r.fullName} ${r.firm || ""} ${(r.specialty || []).join(" ")}`.toLowerCase();
      const tokenHits = tokens.filter((t) => hay.includes(t)).length;
      return {
        id: r.id,
        fullName: r.fullName,
        firm: r.firm,
        specialty: r.specialty || [],
        avgRating: r.avgRating,
        logCount: r.logCount,
        personalRating: null as number | null,
        status: null as string | null,
        notes: null as string | null,
        contactId: null as string | null,
        piiUnlocked: false,
        email: null as string | null,
        linkedinUrl: null as string | null,
        score: communityScore(r) + tokenHits * 10,
      };
    })
    .sort((a, b) => b.score - a.score);

  return [...scoredPersonal, ...communityRows].slice(0, limit);
}
