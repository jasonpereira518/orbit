import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  recruiters,
  userRecruiterLinks,
  userSettings,
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
  /** Present only when unlockedRecruiterIds unlocked this row for the viewer. */
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

/**
 * Shape a canonical row for a specific viewer.
 *
 * `piiUnlocked` must come from `unlockedRecruiterIds` — never from "the viewer has a link".
 * A link used to unlock the row's email, phone and LinkedIn for anyone who logged it, which
 * handed one user's private contact details to any other user who typed the same name and
 * firm (audit A8).
 *
 * Note what is absent: `notes` and `aiSummary` reach the caller only inside `myLink`,
 * which is null for anyone but the owner. They are never derived from `row`.
 */
export function toPublicRecruiter(
  row: Recruiter,
  link: UserRecruiterLink | null,
  piiUnlocked = false
): PublicRecruiter {
  return {
    id: row.id,
    fullName: row.fullName,
    firm: row.firm,
    specialty: row.specialty || [],
    avgRating: row.avgRating,
    ratingCount: row.ratingCount,
    logCount: row.logCount,
    email: piiUnlocked ? row.email : null,
    linkedinUrl: piiUnlocked ? row.linkedinUrl : null,
    phone: piiUnlocked ? row.phone : null,
    piiUnlocked,
    myLink: link,
  };
}

/**
 * Fill empty fields only — never overwrite existing non-empty values.
 *
 * `includePii: false` (a caller who is not sharing) merges firm and specialty but never
 * email, phone or LinkedIn: the row is shared, and a private caller's contact details
 * would otherwise become visible to whoever the row is unlocked for.
 */
export function mergeRecruiterFields(
  existing: Recruiter,
  incoming: {
    fullName?: string;
    firm?: string | null;
    specialty?: string[];
    email?: string | null;
    linkedinUrl?: string | null;
    phone?: string | null;
  },
  opts: { includePii: boolean }
): Partial<typeof recruiters.$inferInsert> {
  const patch: Partial<typeof recruiters.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (!existing.firm && incoming.firm?.trim()) {
    patch.firm = incoming.firm.trim();
    patch.firmNormalized = normalizeFirm(incoming.firm);
  }
  if (opts.includePii) {
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
  }
  if (incoming.specialty?.length) {
    const current = new Set(existing.specialty || []);
    for (const s of incoming.specialty) {
      const t = s.trim();
      if (t) current.add(t);
    }
    patch.specialty = Array.from(current);
  }

  return patch;
}

/**
 * A recruiter is in the shared pool when at least one owner who has opted in still has
 * this particular link opted in.
 *
 * Deliberately a live EXISTS rather than a denormalized counter on `recruiters`: flipping
 * the toggle off has to withdraw a user's contributions *immediately*, and a cached count
 * would leave them exposed until something recomputed it.
 */
function pooledPredicate() {
  return sql`exists (
    select 1 from user_recruiter_links url
    join user_settings us on us.user_id = url.user_id
    where url.recruiter_id = ${recruiters.id}
      and url.shared_to_pool = 1
      and us.recruiter_sharing = 1
  )`;
}

function linkedByViewerPredicate(viewerUserId: string) {
  return sql`exists (
    select 1 from user_recruiter_links url
    where url.recruiter_id = ${recruiters.id}
      and url.user_id = ${viewerUserId}
  )`;
}

/** Whether this user has opted into the shared pool. */
export async function isViewerSharing(userId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { recruiterSharing: true },
  });
  return (row?.recruiterSharing ?? 0) === 1;
}

/**
 * Which of these recruiter ids are in the pool, in one query.
 *
 * Batched on purpose — the per-row alternative is a query per result, and every list
 * surface needs this for a whole page at once.
 */
export async function pooledRecruiterIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const db = await getDb();
  const rows = await db
    .selectDistinct({ recruiterId: userRecruiterLinks.recruiterId })
    .from(userRecruiterLinks)
    .innerJoin(userSettings, eq(userSettings.userId, userRecruiterLinks.userId))
    .where(
      and(
        inArray(userRecruiterLinks.recruiterId, ids),
        eq(userRecruiterLinks.sharedToPool, 1),
        eq(userSettings.recruiterSharing, 1)
      )
    );
  return new Set(rows.map((r) => r.recruiterId));
}

/**
 * How long after a row's creation its creator's link can be made. `logRecruiter` and the
 * Gmail scan both create the row and then the link back to back, so a link inside this
 * window is the creator's — the person who supplied the row's contact details.
 */
export const CREATOR_LINK_WINDOW_SECONDS = 120;

export function isCreatorLink(
  row: Pick<Recruiter, "createdAt">,
  link: Pick<UserRecruiterLink, "createdAt"> | null
): boolean {
  if (!link) return false;
  const gapMs = link.createdAt.getTime() - row.createdAt.getTime();
  return gapMs >= 0 && gapMs <= CREATOR_LINK_WINDOW_SECONDS * 1000;
}

/**
 * Rows whose contact details their CREATOR has put in the pool: the creator is sharing and
 * their link is not excluded. Pooling a row by linking it yourself does not count — the
 * details were not yours to share.
 */
export async function piiPooledRecruiterIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const db = await getDb();
  const rows = await db
    .selectDistinct({ recruiterId: userRecruiterLinks.recruiterId })
    .from(userRecruiterLinks)
    .innerJoin(recruiters, eq(recruiters.id, userRecruiterLinks.recruiterId))
    .innerJoin(userSettings, eq(userSettings.userId, userRecruiterLinks.userId))
    .where(
      and(
        inArray(userRecruiterLinks.recruiterId, ids),
        eq(userRecruiterLinks.sharedToPool, 1),
        eq(userSettings.recruiterSharing, 1),
        gte(userRecruiterLinks.createdAt, recruiters.createdAt),
        lte(
          userRecruiterLinks.createdAt,
          sql`${recruiters.createdAt} + make_interval(secs => ${CREATOR_LINK_WINDOW_SECONDS})`
        )
      )
    );
  return new Set(rows.map((r) => r.recruiterId));
}

/**
 * Which of these rows' contact details this viewer may read: the ones they created, plus —
 * when they are sharing — the ones whose creator shares. The one function every read
 * surface asks; nothing else may decide it.
 */
export async function unlockedRecruiterIds(
  viewerUserId: string,
  rows: Array<Pick<Recruiter, "id" | "createdAt">>
): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const db = await getDb();
  const ids = rows.map((r) => r.id);
  const links = await db
    .select({ recruiterId: userRecruiterLinks.recruiterId, createdAt: userRecruiterLinks.createdAt })
    .from(userRecruiterLinks)
    .where(
      and(eq(userRecruiterLinks.userId, viewerUserId), inArray(userRecruiterLinks.recruiterId, ids))
    );
  const linkByRecruiter = new Map(links.map((l) => [l.recruiterId, l]));

  const unlocked = new Set<string>();
  for (const row of rows) {
    if (isCreatorLink(row, linkByRecruiter.get(row.id) ?? null)) unlocked.add(row.id);
  }
  const rest = ids.filter((id) => !unlocked.has(id));
  if (rest.length > 0 && (await isViewerSharing(viewerUserId))) {
    for (const id of await piiPooledRecruiterIds(rest)) unlocked.add(id);
  }
  return unlocked;
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

export async function upsertCanonicalRecruiter(
  input: {
    fullName: string;
    firm?: string | null;
    specialty?: string[];
    email?: string | null;
    linkedinUrl?: string | null;
    phone?: string | null;
  },
  /** Required: a private caller never writes contact details onto an existing row. */
  opts: { callerIsSharing: boolean }
): Promise<Recruiter> {
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
    const patch = mergeRecruiterFields(existing, input, { includePii: opts.callerIsSharing });
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

/**
 * Recompute the public aggregates from *pool-visible links only*.
 *
 * Private users contribute nothing, ratings included — otherwise a rating from someone
 * who opted out still moves a public average they cannot see, and `log_count` would leak
 * how many hidden users have logged a recruiter.
 *
 * Consequence: a recruiter only you have logged shows `ratingCount === 0`. That is
 * correct — it means "no community ratings" — so UI must render that state rather than
 * an empty zero-star row. Your own score lives on `myLink.personalRating`.
 */
export async function recomputeRecruiterRating(recruiterId: string) {
  const db = await getDb();
  const links = await db
    .select({ personalRating: userRecruiterLinks.personalRating })
    .from(userRecruiterLinks)
    .innerJoin(userSettings, eq(userSettings.userId, userRecruiterLinks.userId))
    .where(
      and(
        eq(userRecruiterLinks.recruiterId, recruiterId),
        eq(userRecruiterLinks.sharedToPool, 1),
        eq(userSettings.recruiterSharing, 1)
      )
    );

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

function matchesQuery(q: string) {
  const pattern = `%${q}%`;
  return or(
    ilike(recruiters.fullName, pattern),
    ilike(recruiters.firm, pattern),
    sql`exists (
      select 1 from jsonb_array_elements_text(coalesce(${recruiters.specialty}, '[]'::jsonb)) s
      where s ilike ${pattern}
    )`
  );
}

/**
 * Search recruiters *visible to this viewer*.
 *
 * `viewerUserId` is required rather than optional on purpose: this function is the read
 * boundary for a globally-keyed table, and an optional viewer is one forgotten argument
 * away from returning the entire directory to someone who opted out.
 *
 * Sharing viewer  -> pool + anything they linked themselves.
 * Private viewer  -> only what they linked themselves.
 */
export async function searchCanonicalRecruiters(opts: {
  q?: string;
  limit?: number;
  viewerUserId: string;
  viewerIsSharing: boolean;
}) {
  const db = await getDb();
  const limit = opts.limit ?? 40;
  const q = opts.q?.trim();

  const mine = linkedByViewerPredicate(opts.viewerUserId);
  // Own links stay visible even when excluded from the pool — `shared_to_pool = 0` hides
  // a recruiter from everyone else, never from the person who logged them.
  const visibility = opts.viewerIsSharing ? or(pooledPredicate(), mine) : mine;

  return db.query.recruiters.findMany({
    where: q ? and(visibility, matchesQuery(q)) : visibility,
    orderBy: [desc(recruiters.avgRating), desc(recruiters.logCount)],
    limit,
  });
}

/**
 * Pool recruiters the viewer has no link to — the "Discover" surface.
 * Returns nothing for a private viewer, which is the whole point of the exchange.
 */
export async function listPoolDiscoveries(opts: {
  viewerUserId: string;
  viewerIsSharing: boolean;
  q?: string;
  limit?: number;
}) {
  if (!opts.viewerIsSharing) return [];
  const db = await getDb();
  const q = opts.q?.trim();
  const notMine = sql`not exists (
    select 1 from user_recruiter_links url
    where url.recruiter_id = ${recruiters.id}
      and url.user_id = ${opts.viewerUserId}
  )`;

  return db.query.recruiters.findMany({
    where: q
      ? and(pooledPredicate(), notMine, matchesQuery(q))
      : and(pooledPredicate(), notMine),
    orderBy: [desc(recruiters.avgRating), desc(recruiters.logCount)],
    limit: opts.limit ?? 40,
  });
}

/**
 * Recompute every recruiter this user links to. Run after a sharing toggle, since one
 * flip adds or removes this user's rating from every recruiter they have logged.
 * Callers should defer it with `after()` — a heavy linker means one recompute per link.
 */
export async function resweepUserRatings(userId: string) {
  const db = await getDb();
  const links = await db.query.userRecruiterLinks.findMany({
    where: eq(userRecruiterLinks.userId, userId),
    columns: { recruiterId: true },
  });
  for (const link of links) {
    await recomputeRecruiterRating(link.recruiterId);
  }
}

/** Community score used for chat ranking: avgRating (x10 stored) * logCount. */
export function communityScore(r: {
  avgRating: number;
  logCount: number;
}): number {
  return (r.avgRating / 10) * Math.max(1, r.logCount);
}
