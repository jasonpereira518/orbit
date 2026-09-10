/**
 * The duplicates that already exist, gathered for review.
 *
 * Only the ones the app could NOT decide for itself.
 *
 * Anything at or above `DUPLICATE_MERGE_CONFIDENCE` — a shared email, LinkedIn profile or X
 * handle, a shared name plus employer or role — is merged automatically by
 * `mergeConfidentDuplicates` and never reaches this list. Showing someone a pair while
 * telling them "these are the same person" and asking them to confirm it is just work the
 * app should have done.
 *
 * What is left is the genuinely ambiguous case: two contacts sharing a full name and nothing
 * else. Two different people can be called the same thing, so that one is a question.
 *
 * Nothing here merges anything. It reads.
 */

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, duplicateSuggestions, interactions } from "@/db/schema";
import { DUPLICATE_MERGE_CONFIDENCE } from "@/lib/duplicates";

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
 * Pairs a write path recorded and could not settle, still awaiting a decision.
 *
 * Filtered to BELOW the confidence line, not just to `status = 'pending'`. A stored row at or
 * above it is the sweep's business, not a question — it can exist because it was recorded
 * before the sweep last ran, or by an older build — and surfacing it would put a pair in
 * front of someone that the app is perfectly capable of deciding itself.
 */
export async function findPendingSuggestions(
  userId: string,
  limit = 100
): Promise<DuplicatePair[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(duplicateSuggestions)
    .where(
      and(
        eq(duplicateSuggestions.userId, userId),
        eq(duplicateSuggestions.status, "pending"),
        lt(duplicateSuggestions.confidence, DUPLICATE_MERGE_CONFIDENCE)
      )
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
           false AS same_company
      FROM contacts a
      JOIN contacts b
        ON b.user_id = a.user_id
       AND lower(btrim(b.full_name)) = lower(btrim(a.full_name))
       -- Each unordered pair once, not twice.
       AND a.id < b.id
     WHERE a.user_id = ${userId}
       AND btrim(coalesce(a.full_name, '')) <> ''
       -- A shared name AND a shared employer or role clears the confidence line, so the
       -- sweep in duplicate-sweep.ts has already merged it. Only the bare-name case is a
       -- question; proposing anything else would be asking about a settled matter.
       -- (No backticks in this prose: it lives inside a template literal.)
       AND NOT (btrim(coalesce(a.company, '')) <> ''
                AND lower(btrim(a.company)) = lower(btrim(b.company)))
       AND NOT (btrim(coalesce(a.title, '')) <> ''
                AND lower(btrim(a.title)) = lower(btrim(b.title)))
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
      reason: "Same full name",
      confidence: 0.6,
      certain: false,
      keep,
      merge,
    });
  }
  return pairs;
}

export type DuplicateReview = {
  /** Pairs awaiting a human. There is no "certain" list — those are merged, not shown. */
  proposed: DuplicatePair[];
};

/** Merge the two proposed sources, keeping the highest-confidence reading of each pair. */
function dedupePairs(proposed: DuplicatePair[]): DuplicatePair[] {
  const seen = new Set<string>();
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
  const [recorded, scanned] = await Promise.all([
    findPendingSuggestions(userId),
    findNameCollisions(userId),
  ]);
  // Recorded suggestions first: they carry a `suggestionId`. Ordering only matters for that
  // — either way the pair is dismissible, because dismissal is keyed on the two contact ids.
  return { proposed: dedupePairs([...recorded, ...scanned]) };
}

/**
 * How many pairs are waiting on a human, for the entry point on the contacts page.
 *
 * Deliberately capped rather than an exact `count(*)`: this runs on every contacts page
 * render, the number is only used to decide whether to show a link and what badge to put on
 * it, and "99+" is as actionable as an exact figure.
 */
export async function countDuplicatesAwaitingReview(userId: string): Promise<number> {
  const [recorded, scanned] = await Promise.all([
    findPendingSuggestions(userId, 99),
    findNameCollisions(userId, 99),
  ]);
  return dedupePairs([...recorded, ...scanned]).length;
}
