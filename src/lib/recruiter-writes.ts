/**
 * Logging a recruiter and editing the user's own link to one, user-scoped so chat's writes
 * (@/lib/tools/chat-writes-features) can call them. The server actions `logRecruiter` and
 * `updateMyLink` (src/actions/recruiters.ts) wrap these; revalidation stays with them.
 *
 * Two tables: `recruiters` is the crowdsourced canonical row, shared across accounts;
 * `user_recruiter_links` is this user's own status, rating and notes on one. Contact details
 * reach the shared row only from someone who shares (`isViewerSharing`); they always land on
 * the user's own link.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { recruiters, userRecruiterLinks, type RecruiterLinkSource, type RecruiterLinkStatus } from "@/db/schema";
import { requireEntitlement } from "@/lib/entitlements";
import { UserFacingError } from "@/lib/errors";
import {
  ensureUserLink,
  isViewerSharing,
  mergeRecruiterFields,
  pooledIdsForViewer,
  recomputeRecruiterRating,
  upsertCanonicalRecruiter,
} from "@/lib/recruiters";
import { requireVisibleSurface } from "@/lib/surface-visibility";

/** Recruiters is a paid, page-gated feature: the same check `requireRecruitersUser` makes. */
export async function assertRecruitersForUser(userId: string, route = "chat.recruiters") {
  await requireEntitlement(userId, "recruiters", { route });
  await requireVisibleSurface(userId, "page.recruiters");
}

export type LogRecruiterInput = {
  fullName: string;
  firm?: string;
  specialty?: string[];
  email?: string;
  linkedinUrl?: string;
  phone?: string;
  status?: RecruiterLinkStatus;
  notes?: string;
  personalRating?: number;
  source?: RecruiterLinkSource;
  /** When logging an existing directory entry */
  recruiterId?: string;
};

/** Log a recruiter: find or make the shared row, then the user's own link. Returns the recruiter's id. */
export async function logRecruiterForUser(userId: string, input: LogRecruiterInput): Promise<{ id: string; linkCreated: boolean }> {
  const sharing = await isViewerSharing(userId);
  const fullName = input.fullName?.trim();
  if (!fullName && !input.recruiterId) {
    throw new UserFacingError("Add the recruiter’s name first");
  }

  let recruiterId = input.recruiterId;

  if (recruiterId) {
    const db = await getDb();
    const existing = await db.query.recruiters.findFirst({
      where: eq(recruiters.id, recruiterId),
    });
    if (!existing) throw new Error("Recruiter not found");
    // Only a row this viewer could already see: one they created or link, or one in the
    // pool while they share. Any other id — someone's private recruiter — reads as missing.
    const visible =
      existing.createdByUserId === userId ||
      Boolean(
        await db.query.userRecruiterLinks.findFirst({
          where: and(eq(userRecruiterLinks.userId, userId), eq(userRecruiterLinks.recruiterId, existing.id)),
          columns: { id: true },
        })
      ) ||
      (await pooledIdsForViewer(userId, [existing.id])).has(existing.id);
    if (!visible) throw new Error("Recruiter not found");
    // Patch THIS row directly: going back through upsertCanonicalRecruiter would let an
    // email match — and then patch — a different recruiter than the one being logged.
    // Only a sharing user may fill gaps on the shared row at all: firm and specialty are
    // visible to everyone who can see it, so a private user's log stays on their own link.
    if (sharing) {
      const patch = mergeRecruiterFields(existing, {
        fullName: fullName || existing.fullName,
        firm: input.firm,
        specialty: input.specialty,
        email: input.email,
        linkedinUrl: input.linkedinUrl,
        phone: input.phone,
      });
      if (Object.keys(patch).length > 1) {
        await db.update(recruiters).set(patch).where(eq(recruiters.id, existing.id));
      }
    }
  } else {
    const created = await upsertCanonicalRecruiter(
      {
        fullName: fullName!,
        firm: input.firm,
        specialty: input.specialty,
        email: input.email,
        linkedinUrl: input.linkedinUrl,
        phone: input.phone,
      },
      { contributePii: sharing, createdByUserId: userId }
    );
    recruiterId = created.id;
  }

  const rating =
    typeof input.personalRating === "number" && input.personalRating >= 1 && input.personalRating <= 5
      ? input.personalRating
      : null;

  const { created } = await ensureUserLink({
    userId,
    recruiterId: recruiterId!,
    status: input.status || "planned",
    email: input.email,
    phone: input.phone,
    linkedinUrl: input.linkedinUrl,
    notes: input.notes || null,
    source: input.source || "manual",
    personalRating: rating,
  });

  if (rating !== null) {
    await recomputeRecruiterRating(recruiterId!);
  }
  return { id: recruiterId!, linkCreated: created };
}

export type RecruiterLinkPatch = {
  status?: RecruiterLinkStatus;
  notes?: string | null;
  personalRating?: number | null;
};

/** Edit the user's own link to a recruiter; returns the fields before, or null when they have not logged them. */
export async function updateMyLinkForUser(userId: string, recruiterId: string, patch: RecruiterLinkPatch) {
  const db = await getDb();
  const link = await db.query.userRecruiterLinks.findFirst({
    where: and(eq(userRecruiterLinks.userId, userId), eq(userRecruiterLinks.recruiterId, recruiterId)),
  });
  if (!link) return null;

  const rating =
    patch.personalRating === undefined
      ? undefined
      : patch.personalRating === null
        ? null
        : patch.personalRating >= 1 && patch.personalRating <= 5
          ? patch.personalRating
          : undefined;

  await db
    .update(userRecruiterLinks)
    .set({
      status: patch.status ?? link.status,
      notes: patch.notes !== undefined ? patch.notes : link.notes,
      personalRating: rating !== undefined ? rating : link.personalRating,
      updatedAt: new Date(),
    })
    .where(eq(userRecruiterLinks.id, link.id));

  if (rating !== undefined) {
    await recomputeRecruiterRating(recruiterId);
  }
  return { before: { status: link.status, notes: link.notes, personalRating: link.personalRating } };
}

/** Undo for a chat-logged recruiter: the user's own link goes; the shared directory row stays. */
export async function removeMyLinkForUser(userId: string, recruiterId: string): Promise<boolean> {
  const db = await getDb();
  const removed = await db
    .delete(userRecruiterLinks)
    .where(and(eq(userRecruiterLinks.userId, userId), eq(userRecruiterLinks.recruiterId, recruiterId)))
    .returning();
  if (removed.length) await recomputeRecruiterRating(recruiterId);
  return removed.length > 0;
}
