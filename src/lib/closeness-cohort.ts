import { cache } from "react";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, gmailConnections, interactions, outlookConnections, userGoals, userSettings } from "@/db/schema";
import {
  applyClosenessCohort,
  buildClosenessCohort,
  computeRawCloseness,
  CADENCE_WINDOW_DAYS,
  type ClosenessBreakdown,
  type ClosenessCohort,
} from "@/lib/closeness";
import { publicEmailDomain } from "@/lib/closeness-evidence";
import type { ContactSignalCounts } from "@/lib/constellation-eligibility";
import {
  buildSnapshot,
  cohortFromSnapshot,
  countUnscoredContacts,
  isUsableSnapshot,
  persistClosenessScores,
  readCohortRow,
  saveCohortSnapshot,
} from "@/lib/closeness-materialize";

/**
 * The columns the raw formula reads. A caller that has already loaded its
 * contacts can donate them (see `getClosenessCohort`) instead of paying for a
 * second scan; typing the donation this way means dropping one of these
 * columns from the caller's query is a compile error, not a silent scoring
 * difference between pages.
 */
export type ClosenessCohortRow = {
  id: string;
  relationshipScore: number | null;
  statedCloseness: number | null;
  lastInteractionAt: Date | string | null;
  firstInteractionAt: Date | string | null;
  dateMet: Date | string | null;
  createdAt: Date | string;
  email: string | null;
  company: string | null;
  school: string | null;
  title: string | null;
  industry: string | null;
  howMet: string | null;
  aiSummary: string | null;
  keyFacts: string[] | null;
  sharedInterests: string[] | null;
  contactTags: Array<{ tag: { name: string } }>;
};

/**
 * Network-wide inputs the raw formula reads. Derived from the whole orbit, so they are
 * snapshotted rather than recomputed whenever a single contact needs scoring.
 */
export type ClosenessCohortInputs = {
  maxCompany: number;
  maxSchool: number;
  userDomain: string | null;
  mailConnected: boolean;
};

/**
 * Constellation-eligibility tallies, as extra aggregates on the per-contact interaction
 * `GROUP BY` this module already issues.
 *
 * They ride along rather than running as their own query on purpose. Both the graph and the
 * dashboard already await this cohort and already donate their contact scan to it, and
 * `scripts/smoke-page-budgets.ts` caps the graph at 8 statements — which it already uses. A
 * separate aggregate would be a ninth statement AND a second full scan of `interactions`, to
 * learn something Postgres can count in the pass it is already making.
 *
 * Defined once and spread into both cohort paths (stored-snapshot and freshly-built) so the
 * two cannot drift into disagreeing about who is substantive.
 *
 * The notes clause matches on `interaction_type` alone, never on `raw_notes` being present:
 * the LinkedIn adapter writes each message body into `raw_notes`, so a presence test would
 * count every imported message as a note and qualify every messaged contact.
 */
const constellationSignalAggregates = {
  noteInteractions: sql<number>`count(*) filter (
    where ${interactions.interactionType} in ('note', 'meeting_note')
  )::int`,
  meetingInteractions: sql<number>`count(*) filter (
    where ${interactions.interactionType} in ('meeting', 'in_person')
  )::int`,
  linkedInInbound: sql<number>`count(*) filter (
    where ${interactions.interactionType} = 'linkedin_message'
      and ${interactions.direction} = 'in'
  )::int`,
  linkedInOutbound: sql<number>`count(*) filter (
    where ${interactions.interactionType} = 'linkedin_message'
      and ${interactions.direction} = 'out'
  )::int`,
  linkedInUndirected: sql<number>`count(*) filter (
    where ${interactions.interactionType} = 'linkedin_message'
      and ${interactions.direction} is null
  )::int`,
} satisfies Record<keyof ContactSignalCounts, SQL<number>>;

/** One tally row as the aggregates above return it. */
type SignalRow = { contactId: string } & Record<keyof ContactSignalCounts, number>;

function signalsFromRows(rows: SignalRow[]): Map<string, ContactSignalCounts> {
  return new Map(
    rows.map((r) => [
      r.contactId,
      {
        noteInteractions: Number(r.noteInteractions) || 0,
        meetingInteractions: Number(r.meetingInteractions) || 0,
        linkedInInbound: Number(r.linkedInInbound) || 0,
        linkedInOutbound: Number(r.linkedInOutbound) || 0,
        linkedInUndirected: Number(r.linkedInUndirected) || 0,
      },
    ])
  );
}

export type ClosenessCohortResult = {
  cohort: ClosenessCohort;
  byId: Map<string, ClosenessBreakdown>;
  /** Mean of the absolute scores. Unlike the blended mean it still moves with network health. */
  averageRaw: number;
  goals: string[];
  touchCounts: Map<string, number>;
  /**
   * Contacts with at least one `interactions` row, ever. Already computed here to feed
   * the score; exported so surfaces can tell "we spoke N days ago" apart from "you
   * imported them N days ago" without a second query — `contacts.lastInteractionAt`
   * is stamped on every create and cannot answer that.
   */
  interactedIds: Set<string>;
  /**
   * Per-contact tallies for the constellation filter, from the same grouped scan as
   * `touchCounts` — see `constellationSignalAggregates`. A contact with no interactions has
   * no entry; readers treat that as all-zero rather than as missing data.
   */
  constellationSignals: Map<string, ContactSignalCounts>;
  inputs: ClosenessCohortInputs;
};

/**
 * Per-request store, so whichever surface asks first decides how the cohort is
 * built and everyone else reuses that one result. Keyed by user and rebuilt
 * every request — `cache()` gives us a fresh Map per request, so nothing leaks
 * between users or survives a mutation.
 */
const cohortStore = cache(() => new Map<string, Promise<ClosenessCohortResult>>());

/**
 * Score every one of a user's contacts against the distribution they form.
 *
 * Shared per request so the five surfaces that display closeness (list, detail,
 * graph, network metrics, dashboard stats) all read one identical ranking —
 * previously each recomputed its own, and the graph fed in different fields,
 * so the same person could sit in a different ring on /graph than /contacts.
 *
 * `preloadedRows` lets a caller that is already scanning contacts hand over
 * that work — pass the *promise*, not the awaited rows, so its query still runs
 * in parallel with the goal and interaction queries here.
 */
export function getClosenessCohort(
  userId: string,
  preloadedRows?: ClosenessCohortRow[] | Promise<ClosenessCohortRow[]>
): Promise<ClosenessCohortResult> {
  const store = cohortStore();
  const existing = store.get(userId);
  if (existing) return existing;

  const pending = resolveCohortResult(userId, preloadedRows);
  store.set(userId, pending);
  return pending;
}

/**
 * Read the scores this user already has, or compute them if there are none worth reading.
 *
 * Staleness is not a reason to recompute here — a ranking that is one debounce window
 * behind is exactly the tradeoff materialization buys, and recalibrating on read would hand
 * the full scan straight back. What does force a recompute is an absent distribution or a
 * contact that has never been scored, because those render as a closeness of zero, which is
 * wrong rather than merely out of date.
 */
async function resolveCohortResult(
  userId: string,
  preloadedRows?: ClosenessCohortRow[] | Promise<ClosenessCohortRow[]>
): Promise<ClosenessCohortResult> {
  const cohortRow = await readCohortRow(userId);

  if (cohortRow && isUsableSnapshot(cohortRow.snapshot)) {
    const unscored = await countUnscoredContacts(userId);
    if (unscored === 0) {
      return readStoredCohortResult(userId, cohortRow.snapshot);
    }
  }

  const result = await buildCohortResult(userId, preloadedRows);
  await persistCohortResult(userId, result);
  return result;
}

/** Assemble the same result shape from stored columns, doing no scoring at all. */
async function readStoredCohortResult(
  userId: string,
  snapshot: NonNullable<Awaited<ReturnType<typeof readCohortRow>>>["snapshot"]
): Promise<ClosenessCohortResult> {
  const db = await getDb();
  const since = new Date(
    Date.now() - CADENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );

  // Goals and touch counts are not derived from the cohort — the contact-detail page reads
  // them to explain a single score — so they are still fetched live. Both are cheap: one
  // tiny table, and one grouped count that `interactions_user_date_idx` now covers.
  const [scored, goalRows, touchRows] = await Promise.all([
    // Raw SQL because `closeness_breakdown` is deliberately absent from the Drizzle schema
    // (see the note on the `contacts` table) — this is the one place that wants it.
    db.execute(sql`
      select id, closeness_breakdown as breakdown
      from contacts
      where user_id = ${userId} and closeness_breakdown is not null
    `),
    db.query.userGoals.findMany({
      where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
      columns: { text: true },
    }),
    db
      .select({
        contactId: interactions.contactId,
        recent: sql<number>`count(*) filter (where ${interactions.interactionDate} >= ${since})::int`,
        // Same group-by, one more aggregate: "has this ever been touched at all",
        // which the recent-window count cannot answer. See `interactedIds`.
        total: sql<number>`count(*)::int`,
        ...constellationSignalAggregates,
      })
      .from(interactions)
      .where(eq(interactions.userId, userId))
      .groupBy(interactions.contactId),
  ]);

  const byId = new Map<string, ClosenessBreakdown>();
  for (const row of rowsOf<{ id: string; breakdown: ClosenessBreakdown | null }>(scored)) {
    if (row.breakdown) byId.set(row.id, row.breakdown);
  }

  return {
    cohort: cohortFromSnapshot(snapshot),
    byId,
    averageRaw: snapshot.averageRaw ?? 0,
    goals: goalRows.map((g) => g.text),
    touchCounts: new Map(
      touchRows.map((r) => [r.contactId, Number(r.recent) || 0])
    ),
    interactedIds: new Set(
      touchRows.filter((r) => Number(r.total) > 0).map((r) => r.contactId)
    ),
    constellationSignals: signalsFromRows(touchRows),
    inputs: {
      maxCompany: snapshot.maxCompany ?? 1,
      maxSchool: snapshot.maxSchool ?? 1,
      userDomain: snapshot.userDomain ?? null,
      mailConnected: snapshot.mailConnected ?? false,
    },
  };
}

async function persistCohortResult(
  userId: string,
  result: ClosenessCohortResult
) {
  await persistClosenessScores(
    userId,
    [...result.byId.entries()].map(([id, breakdown]) => ({ id, breakdown }))
  );
  await saveCohortSnapshot(
    userId,
    buildSnapshot(result.cohort, result.averageRaw, result.inputs)
  );
}

/**
 * Recompute a user's whole distribution and write it down.
 *
 * The expensive path, and the only one that should ever run outside a request: after a bulk
 * import, or from the cron that drains cohorts left dirty by ordinary edits.
 */
export async function recalibrateCloseness(
  userId: string
): Promise<ClosenessCohortResult> {
  const result = await buildCohortResult(userId);
  await persistCohortResult(userId, result);
  return result;
}

async function buildCohortResult(
  userId: string,
  preloadedRows?: ClosenessCohortRow[] | Promise<ClosenessCohortRow[]>
): Promise<ClosenessCohortResult> {
  const db = await getDb();
  const since = new Date(
    Date.now() - CADENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );

  const [rows, goalRows, touchRows, settings, gmailConnection, outlookConnection] = await Promise.all([
    preloadedRows ??
      db.query.contacts.findMany({
        where: eq(contacts.userId, userId),
        // Only what the formula reads. `notes` is deliberately excluded — see
        // the goal-haystack note below.
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
      }),
    db.query.userGoals.findMany({
      where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
      columns: { text: true },
    }),
    // Two numbers from one scan. `recent` is cadence — touches inside the
    // trailing window. `total` answers a different question: has this contact
    // *ever* been interacted with? That is what the evidence layer needs, and
    // the cadence window is far too narrow to stand in for it — a friend you
    // last saw two years ago is someone we know about, not someone we have no
    // data on. It cannot come from `contacts.last_interaction_at` either: that
    // column is stamped `metAt ?? now` on every create, so it is non-null for
    // every imported contact. Hence no date predicate in the WHERE, and the
    // window applied as a FILTER instead.
    db
      .select({
        contactId: interactions.contactId,
        recent: sql<number>`count(*) filter (where ${interactions.interactionDate} >= ${since})::int`,
        total: sql<number>`count(*)::int`,
        ...constellationSignalAggregates,
      })
      .from(interactions)
      .where(eq(interactions.userId, userId))
      .groupBy(interactions.contactId),
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { email: true },
    }),
    // Whether a mail source is genuinely connected. NOT `userSettings.email`,
    // which is set for every account and would mark the entire orbit as
    // covered — inflating evidence for people we have never actually observed.
    // Gmail and Outlook are both equally wired integrations, so either one
    // connected counts.
    db.query.gmailConnections.findFirst({
      where: eq(gmailConnections.userId, userId),
      columns: { id: true },
    }),
    db.query.outlookConnections.findFirst({
      where: eq(outlookConnections.userId, userId),
      columns: { id: true },
    }),
  ]);

  const goals = goalRows.map((g) => g.text);
  const touchCounts = new Map<string, number>(
    touchRows.map((r) => [r.contactId, Number(r.recent) || 0])
  );
  const everInteracted = new Set<string>(
    touchRows.filter((r) => Number(r.total) > 0).map((r) => r.contactId)
  );

  // Orbit-relative affinity. Orbit stores no company or school for the user
  // themselves, so "where has this person overlapped with me" is inferred from
  // the shape of the orbit: an employer holding a large share of your contacts
  // is somewhere you have been. Computed from the rows already in hand — no
  // extra query.
  const companyCounts = new Map<string, number>();
  const schoolCounts = new Map<string, number>();
  for (const c of rows) {
    const co = c.company?.trim().toLowerCase();
    if (co) companyCounts.set(co, (companyCounts.get(co) ?? 0) + 1);
    const sc = c.school?.trim().toLowerCase();
    if (sc) schoolCounts.set(sc, (schoolCounts.get(sc) ?? 0) + 1);
  }
  const maxCompany = Math.max(1, ...companyCounts.values());
  const maxSchool = Math.max(1, ...schoolCounts.values());

  const userDomain = (() => {
    const email = settings?.email?.trim().toLowerCase();
    const domain = email?.split("@")[1];
    if (!domain || publicEmailDomain(domain)) return null;
    return domain;
  })();

  const mailConnected = !!gmailConnection || !!outlookConnection;

  // The goal haystack intentionally omits `notes`: keeping it would mean
  // pulling every note body on every request, and the list payload already
  // drops notes for slimming — so including it here is what made /graph and
  // /contacts disagree about the same contact's ring.
  const raws = rows.map((c) => {
    const contactDomain = c.email?.trim().toLowerCase().split("@")[1] ?? null;
    return computeRawCloseness(
      {
        ...c,
        notes: null,
        tags: c.contactTags.map((ct) => ct.tag.name),
        hasLoggedInteraction: everInteracted.has(c.id),
        emailDomainMatchesUser:
          !!userDomain && !!contactDomain && contactDomain === userDomain,
        companyConcentration: c.company
          ? (companyCounts.get(c.company.trim().toLowerCase()) ?? 0) / maxCompany
          : 0,
        schoolConcentration: c.school
          ? (schoolCounts.get(c.school.trim().toLowerCase()) ?? 0) / maxSchool
          : 0,
        coveredByConnectedSource: mailConnected && !!c.email,
      },
      goals,
      touchCounts.get(c.id) ?? 0
    );
  });

  const cohort = buildClosenessCohort(raws);

  const byId = new Map<string, ClosenessBreakdown>();
  rows.forEach((c, i) => {
    byId.set(c.id, applyClosenessCohort(raws[i], cohort));
  });

  const averageRaw = raws.length
    ? raws.reduce((sum, r) => sum + r.raw, 0) / raws.length
    : 0;

  return {
    cohort,
    byId,
    averageRaw,
    goals,
    touchCounts,
    interactedIds: everInteracted,
    constellationSignals: signalsFromRows(touchRows),
    inputs: { maxCompany, maxSchool, userDomain, mailConnected },
  };
}
