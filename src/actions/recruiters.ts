"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import {
  recruiters,
  userRecruiterLinks,
  type RecruiterLinkSource,
  type RecruiterLinkStatus,
} from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  communityScore,
  ensureUserLink,
  recomputeRecruiterRating,
  searchCanonicalRecruiters,
  toPublicRecruiter,
  upsertCanonicalRecruiter,
  type PublicRecruiter,
} from "@/lib/recruiters";

function revalidateRecruiterPaths(id?: string) {
  revalidatePath("/recruiters");
  revalidatePath("/chat");
  if (id) revalidatePath(`/recruiters/${id}`);
}

export async function searchRecruiters(q?: string): Promise<PublicRecruiter[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const rows = await searchCanonicalRecruiters({ q, limit: 50 });
  const links = await db.query.userRecruiterLinks.findMany({
    where: eq(userRecruiterLinks.userId, userId),
  });
  const byRecruiter = new Map(links.map((l) => [l.recruiterId, l]));
  return rows.map((r) => toPublicRecruiter(r, byRecruiter.get(r.id) || null));
}

export async function listMyRecruiters(): Promise<PublicRecruiter[]> {
  const userId = await requireUserId();
  const db = await getDb();
  const links = await db.query.userRecruiterLinks.findMany({
    where: eq(userRecruiterLinks.userId, userId),
    with: { recruiter: true },
    orderBy: [desc(userRecruiterLinks.updatedAt)],
  });
  return links.map((l) => toPublicRecruiter(l.recruiter, l));
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
  return toPublicRecruiter(row, link || null);
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

export async function logRecruiter(input: LogRecruiterInput) {
  const userId = await requireUserId();
  const fullName = input.fullName?.trim();
  if (!fullName && !input.recruiterId) {
    throw new Error("Recruiter name is required");
  }

  let recruiterId = input.recruiterId;

  if (recruiterId) {
    const db = await getDb();
    const existing = await db.query.recruiters.findFirst({
      where: eq(recruiters.id, recruiterId),
    });
    if (!existing) throw new Error("Recruiter not found");
    if (fullName || input.email || input.firm || input.linkedinUrl) {
      await upsertCanonicalRecruiter({
        fullName: fullName || existing.fullName,
        firm: input.firm ?? existing.firm,
        specialty: input.specialty,
        email: input.email ?? existing.email,
        linkedinUrl: input.linkedinUrl ?? existing.linkedinUrl,
        phone: input.phone ?? existing.phone,
      });
    }
  } else {
    const created = await upsertCanonicalRecruiter({
      fullName: fullName!,
      firm: input.firm,
      specialty: input.specialty,
      email: input.email,
      linkedinUrl: input.linkedinUrl,
      phone: input.phone,
    });
    recruiterId = created.id;
  }

  const rating =
    typeof input.personalRating === "number" &&
    input.personalRating >= 1 &&
    input.personalRating <= 5
      ? input.personalRating
      : null;

  await ensureUserLink({
    userId,
    recruiterId: recruiterId!,
    status: input.status || "planned",
    notes: input.notes || null,
    source: input.source || "manual",
    personalRating: rating,
  });

  if (rating !== null) {
    await recomputeRecruiterRating(recruiterId!);
  }

  revalidateRecruiterPaths(recruiterId);
  return { id: recruiterId! };
}

export async function updateMyLink(
  recruiterId: string,
  patch: {
    status?: RecruiterLinkStatus;
    notes?: string | null;
    personalRating?: number | null;
  }
) {
  const userId = await requireUserId();
  const db = await getDb();
  const link = await db.query.userRecruiterLinks.findFirst({
    where: and(
      eq(userRecruiterLinks.userId, userId),
      eq(userRecruiterLinks.recruiterId, recruiterId)
    ),
  });
  if (!link) throw new Error("You have not logged this recruiter yet");

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
      personalRating:
        rating !== undefined ? rating : link.personalRating,
      updatedAt: new Date(),
    })
    .where(eq(userRecruiterLinks.id, link.id));

  if (rating !== undefined) {
    await recomputeRecruiterRating(recruiterId);
  }

  revalidateRecruiterPaths(recruiterId);
}

export async function rateRecruiter(recruiterId: string, rating: number) {
  if (rating < 1 || rating > 5) throw new Error("Rating must be 1–5");
  await updateMyLink(recruiterId, { personalRating: rating });
}

/** For chat: personal links first, then top community matches. */
export async function loadRecruitersForChat(
  userId: string,
  question: string,
  limit = 8
) {
  const db = await getDb();
  const personal = await db.query.userRecruiterLinks.findMany({
    where: eq(userRecruiterLinks.userId, userId),
    with: { recruiter: true },
    orderBy: [desc(userRecruiterLinks.updatedAt)],
    limit: 20,
  });

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
        email: r.email,
        linkedinUrl: r.linkedinUrl,
        score: 100 + personalBoost + tokenHits * 10 + communityScore(r),
      };
    })
    .sort((a, b) => b.score - a.score);

  const community = await searchCanonicalRecruiters({
    q: tokens.slice(0, 3).join(" ") || undefined,
    limit: 20,
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
