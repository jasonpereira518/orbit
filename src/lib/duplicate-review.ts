/**
 * The duplicates that already exist, gathered for review.
 *
 * Two sources, deliberately kept apart because they mean different things:
 *
 *  - **Identifier collisions** are certain. Two contacts carry the same email or LinkedIn
 *    profile, and only one of them holds the `contact_identities` row for it — the other
 *    lost the claim, which is exactly what "this is a pre-existing duplicate" looks like
 *    after the backfill. These are safe to merge in bulk.
 *  - **Name suggestions** are not certain. They are what the matcher noticed and declined
 *    to act on, recorded by the write paths. A human decides.
 *
 * Nothing here merges anything. It reads.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, duplicateSuggestions, interactions } from "@/db/schema";

export type DuplicateCandidate = {
  id: string;
  fullName: string;
  email: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  profileImageUrl: string | null;
  createdAt: Date | null;
  interactionCount: number;
};

export type DuplicatePair = {
  /** Present for name suggestions; absent for identifier collisions, which are computed. */
  suggestionId?: string;
  reason: string;
  confidence: number;
  /** Certain (an identifier both contacts carry) vs proposed (a name match). */
  certain: boolean;
  /** The contact that should survive by default: the older of the two. */
  keep: DuplicateCandidate;
  merge: DuplicateCandidate;
};

const CANDIDATE_COLUMNS = {
  id: contacts.id,
  fullName: contacts.fullName,
  email: contacts.email,
  company: contacts.company,
  title: contacts.title,
  linkedinUrl: contacts.linkedinUrl,
  profileImageUrl: contacts.profileImageUrl,
  createdAt: contacts.createdAt,
};

async function loadCandidates(
  userId: string,
  ids: string[]
): Promise<Map<string, DuplicateCandidate>> {
  if (!ids.length) return new Map();
  const db = await getDb();
  const rows = await db
    .select(CANDIDATE_COLUMNS)
    .from(contacts)
    .where(and(eq(contacts.userId, userId), inArray(contacts.id, ids)));

  // Counted with a separate GROUP BY rather than a correlated subquery in the projection
  // above. Drizzle renders an interpolated column inside a `sql` template in the SELECT list
  // UNQUALIFIED — `${contacts.id}` becomes bare `"id"` — so
  //   (SELECT count(*) FROM interactions i WHERE i.contact_id = ${contacts.id})
  // compiles to `i.contact_id = "id"`, which binds to `interactions.id` and is never true.
  // It returns 0 for every contact, with no error from Postgres, tsc or eslint. See
  // `smoke-duplicate-review`, which exists because this was silently wrong once.
  const counts = await db
    .select({
      contactId: interactions.contactId,
      n: sql<number>`count(*)::int`,
    })
    .from(interactions)
    .where(and(eq(interactions.userId, userId), inArray(interactions.contactId, ids)))
    .groupBy(interactions.contactId);
  const countById = new Map(counts.map((c) => [c.contactId, Number(c.n)]));

  return new Map(
    rows.map((r) => [r.id, { ...r, interactionCount: countById.get(r.id) ?? 0 }])
  );
}

/** Older contact first — the default survivor, matching the resolver's own merge direction. */
function order(a: DuplicateCandidate, b: DuplicateCandidate): [DuplicateCandidate, DuplicateCandidate] {
  const at = a.createdAt?.getTime() ?? 0;
  const bt = b.createdAt?.getTime() ?? 0;
  if (at !== bt) return at < bt ? [a, b] : [b, a];
  return a.id < b.id ? [a, b] : [b, a];
}

/**
 * Pairs of contacts that carry the same identifier.
 *
 * Found by joining contacts back onto `contact_identities` on the *value* they carry: the
 * contact that owns the row and the contact that merely carries the same value are, by the
 * unique index, necessarily different rows describing one person.
 */
export async function findIdentityCollisions(
  userId: string,
  limit = 100
): Promise<DuplicatePair[]> {
  const db = await getDb();
  const rows = await db.execute(sql`
    SELECT i.contact_id::text AS owner_id,
           c.id::text          AS other_id,
           i.kind              AS kind
      FROM contact_identities i
      JOIN contacts c
        ON c.user_id = i.user_id
       AND c.id <> i.contact_id
       AND (
             (i.kind = 'email'         AND lower(btrim(c.email))     = i.value)
          OR (i.kind = 'linkedin_slug' AND c.linkedin_slug           = i.value)
          OR (i.kind = 'x_handle'      AND lower(btrim(c.x_handle))  = i.value)
       )
     WHERE i.user_id = ${userId}
     LIMIT ${limit}
  `);
  const raw = (Array.isArray(rows) ? rows : rows.rows) as {
    owner_id: string;
    other_id: string;
    kind: string;
  }[];
  if (!raw.length) return [];

  const candidates = await loadCandidates(userId, [
    ...new Set(raw.flatMap((r) => [r.owner_id, r.other_id])),
  ]);

  const seen = new Set<string>();
  const pairs: DuplicatePair[] = [];
  for (const row of raw) {
    const a = candidates.get(row.owner_id);
    const b = candidates.get(row.other_id);
    if (!a || !b) continue;
    const [keep, merge] = order(a, b);
    const key = `${keep.id}:${merge.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({
      reason:
        row.kind === "email"
          ? "Same email"
          : row.kind === "linkedin_slug"
            ? "Same LinkedIn profile"
            : "Same X handle",
      confidence: 0.95,
      certain: true,
      keep,
      merge,
    });
  }
  return pairs;
}

/** Name-tier pairs the write paths declined to merge, still awaiting a decision. */
export async function findPendingSuggestions(
  userId: string,
  limit = 100
): Promise<DuplicatePair[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(duplicateSuggestions)
    .where(
      and(eq(duplicateSuggestions.userId, userId), eq(duplicateSuggestions.status, "pending"))
    )
    .orderBy(desc(duplicateSuggestions.confidence))
    .limit(limit);
  if (!rows.length) return [];

  const candidates = await loadCandidates(userId, [
    ...new Set(rows.flatMap((r) => [r.contactAId, r.contactBId])),
  ]);

  const pairs: DuplicatePair[] = [];
  for (const row of rows) {
    const a = candidates.get(row.contactAId);
    const b = candidates.get(row.contactBId);
    // A side may have been merged away or deleted since the suggestion was recorded.
    if (!a || !b) continue;
    const [keep, merge] = order(a, b);
    pairs.push({
      suggestionId: row.id,
      reason: row.reason,
      confidence: row.confidence,
      certain: false,
      keep,
      merge,
    });
  }
  return pairs;
}

/**
 * Contacts that share a name, found by scanning rather than by remembering.
 *
 * `findPendingSuggestions` only returns pairs a write path recorded as it went, which means
 * it can never see a duplicate that predates this feature — and those are exactly the ones a
 * cleanup surface exists for. Two contacts imported as "Grace Hopper" years ago share no
 * identifier, so `findIdentityCollisions` misses them too, and neither list would ever
 * mention them.
 *
 * Pairs the user has already judged are excluded: a dismissal has to outlive the scan, or
 * the page proposes the same rejected pair on every visit forever.
 */
export async function findNameCollisions(
  userId: string,
  limit = 100
): Promise<DuplicatePair[]> {
  const db = await getDb();
  const rows = await db.execute(sql`
    SELECT a.id::text AS a_id,
           b.id::text AS b_id,
           (lower(btrim(coalesce(a.company, ''))) = lower(btrim(coalesce(b.company, '')))
            AND coalesce(a.company, '') <> '') AS same_company
      FROM contacts a
      JOIN contacts b
        ON b.user_id = a.user_id
       AND lower(btrim(b.full_name)) = lower(btrim(a.full_name))
       -- Each unordered pair once, not twice.
       AND a.id < b.id
     WHERE a.user_id = ${userId}
       AND btrim(coalesce(a.full_name, '')) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM duplicate_suggestions s
          WHERE s.user_id = a.user_id
            AND s.status <> 'pending'
            AND s.contact_a_id = LEAST(a.id, b.id)
            AND s.contact_b_id = GREATEST(a.id, b.id))
     LIMIT ${limit}
  `);
  const raw = (Array.isArray(rows) ? rows : rows.rows) as {
    a_id: string;
    b_id: string;
    same_company: boolean;
  }[];
  if (!raw.length) return [];

  const candidates = await loadCandidates(userId, [
    ...new Set(raw.flatMap((r) => [r.a_id, r.b_id])),
  ]);

  const pairs: DuplicatePair[] = [];
  for (const row of raw) {
    const a = candidates.get(row.a_id);
    const b = candidates.get(row.b_id);
    if (!a || !b) continue;
    const [keep, merge] = order(a, b);
    pairs.push({
      reason: row.same_company ? "Same name + company" : "Same full name",
      confidence: row.same_company ? 0.9 : 0.6,
      certain: false,
      keep,
      merge,
    });
  }
  return pairs;
}

export type DuplicateReview = {
  certain: DuplicatePair[];
  proposed: DuplicatePair[];
};

/** Merge the two proposed sources, keeping the highest-confidence reading of each pair. */
function dedupePairs(certain: DuplicatePair[], proposed: DuplicatePair[]): DuplicatePair[] {
  // A pair that is already a certain identifier collision does not also need proposing.
  const seen = new Set(certain.map((p) => `${p.keep.id}:${p.merge.id}`));
  const out: DuplicatePair[] = [];
  for (const pair of proposed) {
    const key = `${pair.keep.id}:${pair.merge.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

export async function getDuplicateReview(userId: string): Promise<DuplicateReview> {
  const [certain, recorded, scanned] = await Promise.all([
    findIdentityCollisions(userId),
    findPendingSuggestions(userId),
    findNameCollisions(userId),
  ]);
  // Recorded suggestions first: they carry a `suggestionId`, which is what makes a pair
  // dismissible. A scanned pair for the same two contacts would otherwise shadow it and
  // leave the user no way to reject it.
  return { certain, proposed: dedupePairs(certain, [...recorded, ...scanned]) };
}

/**
 * How many pairs are waiting, for the entry point on the contacts page.
 *
 * Deliberately capped rather than an exact `count(*)`: this runs on every contacts page
 * render, the number is only used to decide whether to show a link and what badge to put on
 * it, and "99+" is as actionable as an exact figure.
 */
export async function countDuplicatesAwaitingReview(userId: string): Promise<number> {
  const [certain, recorded, scanned] = await Promise.all([
    findIdentityCollisions(userId, 99),
    findPendingSuggestions(userId, 99),
    findNameCollisions(userId, 99),
  ]);
  return certain.length + dedupePairs(certain, [...recorded, ...scanned]).length;
}
