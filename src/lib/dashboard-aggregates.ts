import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { COMET_DORMANT_DAYS } from "@/lib/comet";
import { ABSOLUTE_TIER_CUTOFFS } from "@/lib/closeness";

/**
 * The dashboard's whole-network counts, computed by Postgres instead of by loading the
 * network and counting it in JavaScript.
 *
 * ## Why these are here and not in the snapshot
 *
 * The dashboard's expensive figures split cleanly in two, and the split is not "cheap vs
 * expensive" — it is **whether the answer changes when nothing does**.
 *
 *   - `dormantCount` and `overdueCount` compare stored timestamps against `now()`. A
 *     contact becomes overdue at a moment nobody writes anything: the clock passes their
 *     follow-up date. Materialising those two would mean a dashboard that under-reports
 *     overdue follow-ups until the next unrelated write happened to refresh it, and the
 *     overdue count is one of the few numbers on the page a user actually acts on.
 *   - Everything else here (`totalContacts`, the score histogram, the company/school/tag
 *     vocabularies) is not clock-dependent, but is a single indexed aggregate — cheaper to
 *     ask Postgres for than to store, invalidate and keep honest.
 *
 * What genuinely belongs in a snapshot is the work that is expensive *and* stable: the
 * O(n²) peer-link analysis, constellation clustering, and goal relevance over each
 * contact's text. That lives in `dashboard-snapshot.ts`.
 *
 * ## Fidelity
 *
 * Every expression below is a translation of JavaScript that ran over the full scan, and a
 * translation that drifts is worse than no translation at all — the page would keep
 * rendering, with different numbers. `scripts/smoke-dashboard-aggregates.ts` asserts these
 * against the in-JS originals over the same fixture, which is the only thing that makes
 * replacing them safe.
 */

export type DashboardScoreCounts = Record<1 | 2 | 3 | 4 | 5, number>;

export type DashboardCounts = {
  totalContacts: number;
  dormantCount: number;
  overdueCount: number;
  scoreCounts: DashboardScoreCounts;
};

export type DashboardVocabularies = {
  companies: string[];
  schools: string[];
  tags: string[];
};

/**
 * The displayed orbit score, as SQL.
 *
 * Mirrors `Math.min(5, Math.max(1, (c.orbitScore ?? c.relationshipScore) || 2))` exactly,
 * and the two coalesces are not interchangeable:
 *
 *   - the inner `COALESCE(orbit_score, relationship_score)` is the `??` — it falls through
 *     only on NULL, so a stored orbit score of 0 stays 0 here;
 *   - `NULLIF(…, 0)` then the outer `COALESCE(…, 2)` is the `|| 2`, which treats that 0 as
 *     absent. Writing it as one `COALESCE(orbit_score, relationship_score, 2)` would score
 *     a zeroed contact as 1 after the clamp instead of 2, moving a bar on the chart.
 */
const ORBIT_SCORE_SQL = sql`least(5, greatest(1, coalesce(nullif(coalesce(orbit_score, relationship_score), 0), 2)))`;

/**
 * One statement for the four counts. They share a scan, and on `neon-http` every statement
 * is a separate HTTPS round trip, so splitting them would cost four.
 *
 * `now()` is Postgres's clock rather than the lambda's. That is the intended reading of
 * "overdue" — the database is the one authority both a page render and a cron job agree on
 * — and it removes the question of what a skewed function clock would do to the number.
 */
export async function getDashboardCounts(userId: string): Promise<DashboardCounts> {
  const db = await getDb();
  // `>=` on whole days, matching `isCometContact` -> `daysAgo(...) >= COMET_DORMANT_DAYS`,
  // where daysAgo floors. A contact last touched exactly 365 days ago is dormant in both.
  const dormantCutoff = sql`now() - make_interval(days => ${COMET_DORMANT_DAYS})`;

  const result = await db.execute(sql`
    select
      count(*)::int as total,
      count(*) filter (
        where last_interaction_at is not null and last_interaction_at <= ${dormantCutoff}
      )::int as dormant,
      count(*) filter (
        where next_follow_up_at is not null and next_follow_up_at < now()
      )::int as overdue,
      count(*) filter (where ${ORBIT_SCORE_SQL} = 1)::int as s1,
      count(*) filter (where ${ORBIT_SCORE_SQL} = 2)::int as s2,
      count(*) filter (where ${ORBIT_SCORE_SQL} = 3)::int as s3,
      count(*) filter (where ${ORBIT_SCORE_SQL} = 4)::int as s4,
      count(*) filter (where ${ORBIT_SCORE_SQL} = 5)::int as s5
    from contacts
    where user_id = ${userId}
  `);

  const row = rowsOf<{
    total: number; dormant: number; overdue: number;
    s1: number; s2: number; s3: number; s4: number; s5: number;
  }>(result)[0];

  return {
    totalContacts: Number(row?.total ?? 0),
    dormantCount: Number(row?.dormant ?? 0),
    overdueCount: Number(row?.overdue ?? 0),
    scoreCounts: {
      1: Number(row?.s1 ?? 0),
      2: Number(row?.s2 ?? 0),
      3: Number(row?.s3 ?? 0),
      4: Number(row?.s4 ?? 0),
      5: Number(row?.s5 ?? 0),
    },
  };
}

/**
 * The company, school and tag vocabularies behind the graph preview's filters.
 *
 * Companies and schools come back in one statement rather than two: they are the same
 * predicate over the same rows, and a `union all` with a discriminator column costs one
 * round trip where two queries cost two.
 *
 * Sorted in SQL with a plain `order by`, NOT with `localeCompare` as the JavaScript did.
 * These are the only figures here whose ordering can differ from the old code — Postgres
 * collation and ICU disagree about punctuation and case in edge cases — and the ordering
 * is presentational (it fills a filter dropdown), so it is a trade taken knowingly rather
 * than a difference to be surprised by later.
 */
export async function getDashboardVocabularies(userId: string): Promise<DashboardVocabularies> {
  const db = await getDb();

  const namesResult = await db.execute(sql`
    select 'company' as kind, btrim(company) as name
      from contacts
     where user_id = ${userId} and btrim(coalesce(company, '')) <> ''
     group by btrim(company)
    union all
    select 'school' as kind, btrim(school) as name
      from contacts
     where user_id = ${userId} and btrim(coalesce(school, '')) <> ''
     group by btrim(school)
     order by kind, name
  `);

  const companies: string[] = [];
  const schools: string[] = [];
  for (const row of rowsOf<{ kind: string; name: string }>(namesResult)) {
    (row.kind === "company" ? companies : schools).push(row.name);
  }

  // Tags reachable from this user's contacts — not every tag the user owns. An unused tag
  // in the filter list is a filter that can only ever return nothing.
  const tagsResult = await db.execute(sql`
    select t.name
      from tags t
      join contact_tags ct on ct.tag_id = t.id
      join contacts c on c.id = ct.contact_id
     where c.user_id = ${userId}
     group by t.name
     order by t.name
  `);

  return {
    companies,
    schools,
    tags: rowsOf<{ name: string }>(tagsResult).map((r) => r.name),
  };
}

export type DashboardTierCounts = { inner: number; mid: number; outer: number };

/**
 * Tier counts, from the breakdown already stored on each contact.
 *
 * Two things here are easy to get subtly wrong, and both are load-bearing.
 *
 * **It buckets on `raw`, not on `closeness`.** `computeNetworkMetrics` counts by absolute
 * score rather than by the contact's displayed tier, and its own comment says why: the
 * displayed tier is quota-assigned, so counting those would pin the distribution to the
 * same shape no matter how healthy the network is. `closeness_tier` — the column — is the
 * quota tier, so it is the wrong thing to group by despite being right there.
 *
 * **It counts only contacts that have a breakdown.** The JavaScript skips a contact with no
 * stored score (`if (!breakdown) continue`), so the `is not null` is what keeps the totals
 * equal rather than a tidiness filter. An unscored contact is one recalibration away from
 * being counted, and counting it as `outer` in the meantime would be an invented number.
 *
 * Raw SQL because `closeness_breakdown` is deliberately absent from the Drizzle schema —
 * see the note on the `contacts` table in `schema.ts`. The thresholds are interpolated from
 * `ABSOLUTE_TIER_CUTOFFS` rather than written out, so this cannot drift from `closenessTier`.
 */
export async function getDashboardTierCounts(userId: string): Promise<DashboardTierCounts> {
  const db = await getDb();
  const raw = sql`(closeness_breakdown->>'raw')::float8`;

  const result = await db.execute(sql`
    select
      count(*) filter (where ${raw} >= ${ABSOLUTE_TIER_CUTOFFS.inner})::int as inner_count,
      count(*) filter (
        where ${raw} >= ${ABSOLUTE_TIER_CUTOFFS.mid} and ${raw} < ${ABSOLUTE_TIER_CUTOFFS.inner}
      )::int as mid_count,
      count(*) filter (where ${raw} < ${ABSOLUTE_TIER_CUTOFFS.mid})::int as outer_count
    from contacts
    where user_id = ${userId} and closeness_breakdown is not null
  `);

  const row = rowsOf<{ inner_count: number; mid_count: number; outer_count: number }>(result)[0];
  return {
    inner: Number(row?.inner_count ?? 0),
    mid: Number(row?.mid_count ?? 0),
    outer: Number(row?.outer_count ?? 0),
  };
}

/**
 * The contacts most relevant to the user's active goals, most relevant first.
 *
 * Goal relevance is not recomputed here. It is a component of the closeness breakdown,
 * computed against each contact's text during recalibration and stored — so the dashboard's
 * "top 5 by goal relevance" is an ordered read of a stored number, not a pass over every
 * contact's summary, key facts and shared interests. That is the single biggest reason the
 * wide text columns do not need to be on the dashboard's critical path.
 *
 * `> 0` matches the JavaScript's `.filter((c) => c.goalRelevance > 0)`: with no active
 * goals every contact scores zero, and the card renders nothing rather than an arbitrary
 * five people.
 */
export async function getGoalAlignedContactIds(
  userId: string,
  limit: number
): Promise<Array<{ id: string; goalRelevance: number }>> {
  const db = await getDb();
  const relevance = sql`(closeness_breakdown->>'goalRelevance')::float8`;

  const result = await db.execute(sql`
    select id, ${relevance} as goal_relevance
    from contacts
    where user_id = ${userId}
      and closeness_breakdown is not null
      and ${relevance} > 0
    order by ${relevance} desc, id asc
    limit ${limit}
  `);

  return rowsOf<{ id: string; goal_relevance: number }>(result).map((r) => ({
    id: r.id,
    goalRelevance: Number(r.goal_relevance),
  }));
}
