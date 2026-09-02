import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { closenessCohorts, contacts, interactions, userGoals } from "@/db/schema";
import type {
  ClosenessCohortSnapshot,
  StoredClosenessBreakdown,
} from "@/db/schema";
import {
  applyClosenessCohort,
  computeRawCloseness,
  CADENCE_WINDOW_DAYS,
  type ClosenessBreakdown,
  type ClosenessCohort,
} from "@/lib/closeness";

/**
 * Persisting closeness, and reading it back.
 *
 * Closeness is cohort-relative: a contact's score and ring are its position in the
 * distribution formed by the user's whole network. Computed on read, that meant every
 * surface had to load every contact in order to render any of them — which is what made
 * `/contacts` cost O(network size) and blocked SQL pagination outright.
 *
 * This module moves that work off the read path. Recalibration computes the cohort once and
 * writes both halves: the applied per-contact scores onto `contacts`, and the distribution
 * itself onto `closeness_cohorts`. Afterwards a page of 50 can be scored by selecting 50
 * rows, and a single contact can be rescored against the stored distribution without
 * reading its 4,999 neighbours.
 *
 * The tradeoff this buys is staleness, and it is deliberate: a write updates its own
 * contact immediately and flags the distribution dirty, but the distribution itself is
 * redrawn in the background. So a score is always current for the contact you just edited,
 * and at most one debounce window behind for everyone else's relative position.
 */

/**
 * Compile-time proof that the JSONB shape declared in `schema.ts` still matches the real
 * breakdown. `schema.ts` cannot import from the lib layer — drizzle-kit loads it directly
 * and cannot resolve the `@/` alias — so the type is declared twice, and this is what stops
 * the copies drifting.
 */
const _breakdownShapeCheck: StoredClosenessBreakdown = null as unknown as ClosenessBreakdown;
void _breakdownShapeCheck;

/**
 * Resolution of the stored distribution sketch.
 *
 * Below this many evidenced contacts the exact sorted scores are stored, so small networks
 * lose nothing. Above it the scores are sampled down to this many ascending breakpoints,
 * which keeps the cohort row a fixed size whether the user has 500 contacts or 50,000.
 * `cohortPercentile` does a midrank lookup over whatever array it is given, so a
 * representative sample yields the same percentile — to within one part in this number.
 */
const SKETCH_POINTS = 401;

/**
 * How long a dirty distribution is allowed to stand before a recalibration is worth doing.
 *
 * Set above zero on purpose. A bulk import marks the cohort dirty on every chunk; without a
 * debounce each chunk would trigger its own full recalibration and the import would spend
 * most of its time rescoring people it is about to rescore again.
 */
const RECALIBRATE_DEBOUNCE_MS = 60_000;

/** Rows written per statement. `neon-http` sends one HTTPS request per statement. */
const WRITE_CHUNK = 500;

function sampleAscending(sorted: number[], points: number): number[] {
  if (sorted.length <= points) return sorted.slice();
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    out.push(sorted[Math.round((i * (sorted.length - 1)) / (points - 1))]);
  }
  return out;
}

export function buildSnapshot(
  cohort: ClosenessCohort,
  averageRaw: number,
  inputs: {
    maxCompany: number;
    maxSchool: number;
    userDomain: string | null;
    mailConnected: boolean;
  }
): ClosenessCohortSnapshot {
  return {
    n: cohort.n,
    evidencedN: cohort.evidencedN,
    coverage: cohort.coverage,
    relativeWeight: cohort.relativeWeight,
    quantiles: sampleAscending(cohort.sortedRaw, SKETCH_POINTS),
    averageRaw,
    ...inputs,
  };
}

/**
 * Rebuild a usable cohort from a stored snapshot.
 *
 * `sortedRaw` is handed the sketch directly: every consumer of it goes through
 * `cohortPercentile`, which only ever asks "where does this score fall among these", and a
 * representative ascending sample answers that identically.
 */
export function cohortFromSnapshot(
  snapshot: ClosenessCohortSnapshot
): ClosenessCohort {
  return {
    n: snapshot.n ?? 0,
    evidencedN: snapshot.evidencedN ?? 0,
    coverage: snapshot.coverage ?? 0,
    relativeWeight: snapshot.relativeWeight ?? 0,
    sortedRaw: snapshot.quantiles ?? [],
  };
}

const EMPTY_SNAPSHOT: ClosenessCohortSnapshot = {
  n: 0,
  evidencedN: 0,
  coverage: 0,
  relativeWeight: 0,
  quantiles: [],
  averageRaw: 0,
  maxCompany: 1,
  maxSchool: 1,
  userDomain: null,
  mailConnected: false,
};

export function isUsableSnapshot(
  snapshot: ClosenessCohortSnapshot | null | undefined
): snapshot is ClosenessCohortSnapshot {
  return (
    !!snapshot &&
    typeof snapshot.n === "number" &&
    snapshot.n > 0 &&
    Array.isArray(snapshot.quantiles)
  );
}

/**
 * Write already-computed scores onto their contacts.
 *
 * One `UPDATE ... FROM (VALUES ...)` per chunk rather than one per contact. That distinction
 * is the whole point: on `neon-http` there are no connections and no transactions, just one
 * HTTPS request per statement, so a per-row loop over a 5,000-contact network would be 5,000
 * sequential round trips.
 */
export async function persistClosenessScores(
  userId: string,
  scores: Array<{ id: string; breakdown: ClosenessBreakdown }>
) {
  if (scores.length === 0) return;
  const db = await getDb();
  const computedAt = new Date();

  for (let i = 0; i < scores.length; i += WRITE_CHUNK) {
    const chunk = scores.slice(i, i + WRITE_CHUNK);
    const tuples = chunk.map(
      ({ id, breakdown: b }) =>
        sql`(${id}::uuid, ${b.raw}::real, ${Math.round(b.closeness * 100)}::integer, ${b.tier}::text, ${b.orbitScore}::integer, ${b.evidence}::real, ${b.prior}::real, ${JSON.stringify(b)}::jsonb)`
    );

    await db.execute(sql`
      UPDATE contacts AS c
      SET closeness_raw = v.raw,
          closeness = v.closeness,
          closeness_tier = v.tier,
          orbit_score = v.orbit_score,
          closeness_evidence = v.evidence,
          closeness_prior = v.prior,
          closeness_breakdown = v.breakdown,
          closeness_computed_at = ${computedAt}
      FROM (VALUES ${sql.join(tuples, sql`, `)})
        AS v(id, raw, closeness, tier, orbit_score, evidence, prior, breakdown)
      WHERE c.id = v.id AND c.user_id = ${userId}
    `);
  }
}

export async function saveCohortSnapshot(
  userId: string,
  snapshot: ClosenessCohortSnapshot
) {
  const db = await getDb();
  await db
    .insert(closenessCohorts)
    .values({
      userId,
      snapshot,
      contactCount: snapshot.n,
      computedAt: new Date(),
      dirtyAt: null,
    })
    .onConflictDoUpdate({
      target: closenessCohorts.userId,
      set: {
        snapshot,
        contactCount: snapshot.n,
        computedAt: new Date(),
        dirtyAt: null,
      },
    });
}

export async function readCohortRow(userId: string) {
  const db = await getDb();
  return db.query.closenessCohorts.findFirst({
    where: eq(closenessCohorts.userId, userId),
  });
}

/**
 * Flag the distribution as out of date.
 *
 * Only sets `dirty_at` when it is not already set, so the timestamp records when drift
 * *started* rather than when the most recent write happened. A bulk import that keeps
 * touching a cohort must not be able to hold off recalibration indefinitely by continually
 * refreshing the clock.
 */
export async function markCohortDirty(userId: string) {
  const db = await getDb();
  await db
    .insert(closenessCohorts)
    .values({
      userId,
      // Placeholder only — this row exists to carry `dirtyAt`. `isUsableSnapshot` rejects
      // it, so a reader finding this recomputes rather than trusting empty numbers.
      snapshot: EMPTY_SNAPSHOT,
      contactCount: 0,
      dirtyAt: new Date(),
    })
    .onConflictDoUpdate({
      target: closenessCohorts.userId,
      set: { dirtyAt: sql`coalesce(${closenessCohorts.dirtyAt}, now())` },
    });
}

/** Users whose distribution has been dirty for longer than the debounce window. */
export async function findStaleCohorts(limit = 25): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ userId: closenessCohorts.userId })
    .from(closenessCohorts)
    .where(
      and(
        sql`${closenessCohorts.dirtyAt} is not null`,
        lt(closenessCohorts.dirtyAt, new Date(Date.now() - RECALIBRATE_DEBOUNCE_MS))
      )
    )
    .limit(limit);
  return rows.map((r) => r.userId);
}

/** Contacts that have never been scored — a fresh import, or a network predating this. */
export async function countUnscoredContacts(userId: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), isNull(contacts.closenessComputedAt)));
  return Number(rows[0]?.n ?? 0);
}

/**
 * Whether reading stored scores would be misleading right now.
 *
 * Dirtiness alone does not qualify: a stale *ranking* is the tradeoff this design accepts.
 * What does qualify is having no distribution at all, or contacts that have never been
 * scored — those would render as a closeness of zero, which is wrong rather than stale.
 */
export async function needsRecalibration(userId: string): Promise<boolean> {
  const row = await readCohortRow(userId);
  if (!row || !isUsableSnapshot(row.snapshot)) return true;
  return (await countUnscoredContacts(userId)) > 0;
}

/**
 * Score one contact against the stored distribution and write just that row.
 *
 * This is what keeps ordinary writes off the expensive path. Without it a newly created
 * contact would have no `closeness_computed_at`, `resolveCohortResult` would treat the
 * network as unscored, and the very next page view would recalibrate everything — turning
 * every single create during an import into a full-network rescore.
 *
 * The contact's own inputs are measured now; the distribution it is placed within is the
 * stored one. So the number is right about the person and possibly a beat behind about
 * where they sit relative to everyone else, which recalibration settles.
 *
 * Returns false when there is no usable distribution yet — the caller should leave the
 * contact unscored so it gets picked up by a real recalibration.
 */
export async function rescoreContact(
  userId: string,
  contactId: string
): Promise<boolean> {
  const cohortRow = await readCohortRow(userId);
  if (!cohortRow || !isUsableSnapshot(cohortRow.snapshot)) return false;

  const snapshot = cohortRow.snapshot;
  const db = await getDb();
  const since = new Date(
    Date.now() - CADENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: {
      id: true,
      relationshipScore: true,
      statedCloseness: true,
      lastInteractionAt: true,
      firstInteractionAt: true,
      dateMet: true,
      createdAt: true,
      email: true,
      company: true,
      school: true,
      title: true,
      industry: true,
      howMet: true,
      aiSummary: true,
      keyFacts: true,
      sharedInterests: true,
    },
    with: { contactTags: { with: { tag: true } } },
  });
  if (!contact) return false;

  const [goalRows, touchRows, companyRows, schoolRows] = await Promise.all([
    db.query.userGoals.findMany({
      where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
      columns: { text: true },
    }),
    db
      .select({
        recent: sql<number>`count(*) filter (where ${interactions.interactionDate} >= ${since})::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(interactions)
      .where(
        and(
          eq(interactions.userId, userId),
          eq(interactions.contactId, contactId)
        )
      ),
    // Concentration for this contact's employer only — not a scan of the network to
    // rebuild every bucket. Served by `contacts_user_company_norm_idx`, which is an
    // expression index on `lower(trim(company))`: it has to match this predicate exactly,
    // because a plain b-tree on `company` cannot answer a normalized comparison.
    contact.company
      ? db
          .select({ n: sql<number>`count(*)::int` })
          .from(contacts)
          .where(
            and(
              eq(contacts.userId, userId),
              sql`lower(trim(${contacts.company})) = ${contact.company.trim().toLowerCase()}`
            )
          )
      : Promise.resolve([{ n: 0 }]),
    contact.school
      ? db
          .select({ n: sql<number>`count(*)::int` })
          .from(contacts)
          .where(
            and(
              eq(contacts.userId, userId),
              sql`lower(trim(${contacts.school})) = ${contact.school.trim().toLowerCase()}`
            )
          )
      : Promise.resolve([{ n: 0 }]),
  ]);

  const recent = Number(touchRows[0]?.recent ?? 0);
  const total = Number(touchRows[0]?.total ?? 0);
  const contactDomain = contact.email?.trim().toLowerCase().split("@")[1] ?? null;

  const raw = computeRawCloseness(
    {
      ...contact,
      notes: null,
      tags: contact.contactTags.map((ct) => ct.tag.name),
      hasLoggedInteraction: total > 0,
      emailDomainMatchesUser:
        !!snapshot.userDomain &&
        !!contactDomain &&
        contactDomain === snapshot.userDomain,
      companyConcentration: contact.company
        ? Number(companyRows[0]?.n ?? 0) / Math.max(1, snapshot.maxCompany)
        : 0,
      schoolConcentration: contact.school
        ? Number(schoolRows[0]?.n ?? 0) / Math.max(1, snapshot.maxSchool)
        : 0,
      coveredByConnectedSource: snapshot.mailConnected && !!contact.email,
    },
    goalRows.map((g) => g.text),
    recent
  );

  const breakdown = applyClosenessCohort(raw, cohortFromSnapshot(snapshot));
  await persistClosenessScores(userId, [{ id: contact.id, breakdown }]);
  return true;
}

export { RECALIBRATE_DEBOUNCE_MS, SKETCH_POINTS };
