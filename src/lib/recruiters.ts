import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  recruiters,
  userRecruiterLinks,
  type Recruiter,
  type RecruiterLinkSource,
  type RecruiterLinkStatus,
  type UserRecruiterLink,
} from "@/db/schema";

export type PublicRecruiter = {
  id: string;
  fullName: string;
  firm: string | null;
  specialty: string[];
  avgRating: number;
  ratingCount: number;
  logCount: number;
  /** Present only when the viewer has a personal link. */
  email: string | null;
  linkedinUrl: string | null;
  phone: string | null;
  piiUnlocked: boolean;
  myLink: UserRecruiterLink | null;
};

export function normalizePersonName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const t = email?.trim().toLowerCase();
  return t || null;
}

export function normalizeFirm(firm: string | null | undefined): string | null {
  const t = firm?.trim().toLowerCase().replace(/\s+/g, " ");
  return t || null;
}

/** True when a chat question is asking about recruiters / talent acquisition. */
export function isRecruiterIntent(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\brecruit(er|ers|ing)?\b/.test(q) ||
    /\btalent acquisition\b/.test(q) ||
    /\bsourcer(s)?\b/.test(q) ||
    /\bstaffing\b/.test(q) ||
    /\bheadhunter(s)?\b/.test(q)
  );
}

export function normalizeLinkedinUrl(
  url: string | null | undefined
): string | null {
  const t = url?.trim();
  if (!t) return null;
  try {
    const u = new URL(t.startsWith("http") ? t : `https://${t}`);
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return `https://www.linkedin.com${path}`;
  } catch {
    return t.toLowerCase();
  }
}

export function toPublicRecruiter(
  row: Recruiter,
  link: UserRecruiterLink | null
): PublicRecruiter {
  const unlocked = Boolean(link);
  return {
    id: row.id,
    fullName: row.fullName,
    firm: row.firm,
    specialty: row.specialty || [],
    avgRating: row.avgRating,
    ratingCount: row.ratingCount,
    logCount: row.logCount,
    email: unlocked ? row.email : null,
    linkedinUrl: unlocked ? row.linkedinUrl : null,
    phone: unlocked ? row.phone : null,
    piiUnlocked: unlocked,
    myLink: link,
  };
}

/** Fill empty fields only — never overwrite existing non-empty values. */
export function mergeRecruiterFields(
  existing: Recruiter,
  incoming: {
    fullName?: string;
    firm?: string | null;
    specialty?: string[];
    email?: string | null;
    linkedinUrl?: string | null;
    phone?: string | null;
  }
): Partial<typeof recruiters.$inferInsert> {
  const patch: Partial<typeof recruiters.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (!existing.firm && incoming.firm?.trim()) {
    patch.firm = incoming.firm.trim();
    patch.firmNormalized = normalizeFirm(incoming.firm);
  }
  if (!existing.email && incoming.email?.trim()) {
    patch.email = incoming.email.trim();
    patch.emailNormalized = normalizeEmail(incoming.email);
  }
  if (!existing.linkedinUrl && incoming.linkedinUrl?.trim()) {
    patch.linkedinUrl = normalizeLinkedinUrl(incoming.linkedinUrl);
  }
  if (!existing.phone && incoming.phone?.trim()) {
    patch.phone = incoming.phone.trim();
  }
  if (incoming.specialty?.length) {
    const current = new Set(existing.specialty || []);
    for (const s of incoming.specialty) {
      const t = s.trim();
      if (t) current.add(t);
    }
    patch.specialty = Array.from(current);
  }
  if (
    incoming.fullName?.trim() &&
    normalizePersonName(incoming.fullName) === existing.nameNormalized
  ) {
    // Keep existing display name; no-op
  }

  return patch;
}

export async function findMatchingRecruiter(input: {
  email?: string | null;
  linkedinUrl?: string | null;
  fullName: string;
  firm?: string | null;
}): Promise<Recruiter | null> {
  const db = await getDb();
  const emailNorm = normalizeEmail(input.email);
  const linkedin = normalizeLinkedinUrl(input.linkedinUrl);
  const nameNorm = normalizePersonName(input.fullName);
  const firmNorm = normalizeFirm(input.firm);

  if (emailNorm) {
    const byEmail = await db.query.recruiters.findFirst({
      where: eq(recruiters.emailNormalized, emailNorm),
    });
    if (byEmail) return byEmail;
  }

  if (linkedin) {
    const byLinkedin = await db.query.recruiters.findFirst({
      where: eq(recruiters.linkedinUrl, linkedin),
    });
    if (byLinkedin) return byLinkedin;
  }

  if (firmNorm) {
    const byNameFirm = await db.query.recruiters.findFirst({
      where: and(
        eq(recruiters.nameNormalized, nameNorm),
        eq(recruiters.firmNormalized, firmNorm)
      ),
    });
    if (byNameFirm) return byNameFirm;
  }

  return null;
}

export async function upsertCanonicalRecruiter(input: {
  fullName: string;
  firm?: string | null;
  specialty?: string[];
  email?: string | null;
  linkedinUrl?: string | null;
  phone?: string | null;
}): Promise<Recruiter> {
  const db = await getDb();
  const fullName = input.fullName.trim();
  if (!fullName) throw new Error("Recruiter name is required");

  const existing = await findMatchingRecruiter({
    email: input.email,
    linkedinUrl: input.linkedinUrl,
    fullName,
    firm: input.firm,
  });

  if (existing) {
    const patch = mergeRecruiterFields(existing, input);
    if (Object.keys(patch).length > 1) {
      const [updated] = await db
        .update(recruiters)
        .set(patch)
        .where(eq(recruiters.id, existing.id))
        .returning();
      return updated;
    }
    return existing;
  }

  const [created] = await db
    .insert(recruiters)
    .values({
      fullName,
      nameNormalized: normalizePersonName(fullName),
      firm: input.firm?.trim() || null,
      firmNormalized: normalizeFirm(input.firm),
      specialty: input.specialty || [],
      email: input.email?.trim() || null,
      emailNormalized: normalizeEmail(input.email),
      linkedinUrl: normalizeLinkedinUrl(input.linkedinUrl),
      phone: input.phone?.trim() || null,
      logCount: 0,
      avgRating: 0,
      ratingCount: 0,
    })
    .returning();

  return created;
}

export async function recomputeRecruiterRating(recruiterId: string) {
  const db = await getDb();
  const links = await db.query.userRecruiterLinks.findMany({
    where: eq(userRecruiterLinks.recruiterId, recruiterId),
    columns: { personalRating: true },
  });

  const ratings = links
    .map((l) => l.personalRating)
    .filter((r): r is number => typeof r === "number" && r >= 1 && r <= 5);

  const ratingCount = ratings.length;
  const avgRating =
    ratingCount === 0
      ? 0
      : Math.round(
          (ratings.reduce((a, b) => a + b, 0) / ratingCount) * 10
        );

  const logCount = links.length;

  await db
    .update(recruiters)
    .set({
      avgRating,
      ratingCount,
      logCount,
      updatedAt: new Date(),
    })
    .where(eq(recruiters.id, recruiterId));
}

export async function ensureUserLink(input: {
  userId: string;
  recruiterId: string;
  status?: RecruiterLinkStatus;
  notes?: string | null;
  source?: RecruiterLinkSource;
  personalRating?: number | null;
  contactId?: string | null;
}): Promise<{ link: UserRecruiterLink; created: boolean }> {
  const db = await getDb();
  const existing = await db.query.userRecruiterLinks.findFirst({
    where: and(
      eq(userRecruiterLinks.userId, input.userId),
      eq(userRecruiterLinks.recruiterId, input.recruiterId)
    ),
  });

  if (existing) {
    const [updated] = await db
      .update(userRecruiterLinks)
      .set({
        status: input.status ?? existing.status,
        notes:
          input.notes !== undefined ? input.notes : existing.notes,
        personalRating:
          input.personalRating !== undefined
            ? input.personalRating
            : existing.personalRating,
        contactId:
          input.contactId !== undefined
            ? input.contactId
            : existing.contactId,
        updatedAt: new Date(),
      })
      .where(eq(userRecruiterLinks.id, existing.id))
      .returning();
    return { link: updated, created: false };
  }

  const [created] = await db
    .insert(userRecruiterLinks)
    .values({
      userId: input.userId,
      recruiterId: input.recruiterId,
      status: input.status || "planned",
      notes: input.notes || null,
      source: input.source || "manual",
      personalRating: input.personalRating ?? null,
      contactId: input.contactId ?? null,
    })
    .returning();

  await recomputeRecruiterRating(input.recruiterId);
  return { link: created, created: true };
}

export async function searchCanonicalRecruiters(opts: {
  q?: string;
  limit?: number;
}) {
  const db = await getDb();
  const limit = opts.limit ?? 40;
  const q = opts.q?.trim();

  if (!q) {
    return db.query.recruiters.findMany({
      orderBy: [desc(recruiters.avgRating), desc(recruiters.logCount)],
      limit,
    });
  }

  const pattern = `%${q}%`;
  return db.query.recruiters.findMany({
    where: or(
      ilike(recruiters.fullName, pattern),
      ilike(recruiters.firm, pattern),
      sql`exists (
        select 1 from jsonb_array_elements_text(coalesce(${recruiters.specialty}, '[]'::jsonb)) s
        where s ilike ${pattern}
      )`
    ),
    orderBy: [desc(recruiters.avgRating), desc(recruiters.logCount)],
    limit,
  });
}

/** Community score used for chat ranking: avgRating (x10 stored) * logCount. */
export function communityScore(r: {
  avgRating: number;
  logCount: number;
}): number {
  return (r.avgRating / 10) * Math.max(1, r.logCount);
}
