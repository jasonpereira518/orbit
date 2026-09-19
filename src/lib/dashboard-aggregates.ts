import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { COMET_DORMANT_DAYS } from "@/lib/comet";

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

export type DashboardCounts = {
  totalContacts: number;
  dormantCount: number;
  overdueCount: number;
  /**
   * `<= now()`, where `overdueCount` is `< now()`. The two predicates differ and both are
   * kept, because the JavaScript they replace used `<=` for the stat and `<` for the chart
   * and quietly reporting one number for both would be a behaviour change smuggled in as a
   * refactor.
   */
  dueFollowUpCount: number;
};

export type DashboardVocabularies = {
  companies: string[];
  schools: string[];
  tags: string[];
};

/**
 * ## Two aggregates that deliberately are NOT here
 *
 * The score histogram and the tier counts look like they belong in this file, and both were
 * written here before being removed. Neither is a translation this module can make honestly:
 *
 * **They are not derived from the columns.** The dashboard's orbit score is
 * `closeness?.orbitScore ?? 2` — the value from the stored *breakdown*, not the
 * `orbit_score` column, and the tier likewise comes from `closenessTier(breakdown.raw)`.
 * The two agree for a scored contact and diverge for an unscored one: the JavaScript gives
 * it 2, while `coalesce(orbit_score, relationship_score)` gives it whatever its
 * relationship score happens to be. That is a moved bar on a chart with nothing failing —
 * the exact class of bug the `ORBIT_SCORE_SQL` comment in this file's history warned about.
 *
 * **They are already in memory, for free.** Both read the closeness cohort, which the
 * dashboard loads anyway to render rings and tiers. Counting a map it already holds costs
 * nothing; asking Postgres for it costs an HTTPS round trip to compute a number the process
 * is already holding the inputs for.
 *
 * What is below earns its place by a different test: each one lets a COLUMN come off the
 * network scan. `dormantCount` retires `last_interaction_at` (the widest field on the row at
 * 46 bytes), and the vocabularies retire the `contact_tags` join.
 */

/**
 * One statement for the three counts. They share a scan, and on `neon-http` every statement
 * is a separate HTTPS round trip, so splitting them would cost three.
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
      count(*) filter (
        where next_follow_up_at is not null and next_follow_up_at <= now()
      )::int as due
    from contacts
    where user_id = ${userId}
  `);

  const row = rowsOf<{
    total: number; dormant: number; overdue: number; due: number;
  }>(result)[0];

  return {
    totalContacts: Number(row?.total ?? 0),
    dormantCount: Number(row?.dormant ?? 0),
    overdueCount: Number(row?.overdue ?? 0),
    dueFollowUpCount: Number(row?.due ?? 0),
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

  // All three in one statement. They are three different shapes over two tables, but on
  // `neon-http` every statement is its own HTTPS round trip, so a `union all` with a
  // discriminator column costs one where three queries cost three.
  const result = await db.execute(sql`
    select 'company' as kind, btrim(company) as name
      from contacts
     where user_id = ${userId} and btrim(coalesce(company, '')) <> ''
     group by btrim(company)
    union all
    select 'school' as kind, btrim(school) as name
      from contacts
     where user_id = ${userId} and btrim(coalesce(school, '')) <> ''
     group by btrim(school)
    union all
    -- Tags reachable from this user's contacts, not every tag the user owns. An unused tag
    -- in the filter list is a filter that can only ever return nothing.
    select 'tag' as kind, t.name as name
      from tags t
      join contact_tags ct on ct.tag_id = t.id
      join contacts c on c.id = ct.contact_id
     where c.user_id = ${userId}
     group by t.name
     order by kind, name
  `);

  const companies: string[] = [];
  const schools: string[] = [];
  const tags: string[] = [];
  for (const row of rowsOf<{ kind: string; name: string }>(result)) {
    if (row.kind === "company") companies.push(row.name);
    else if (row.kind === "school") schools.push(row.name);
    else tags.push(row.name);
  }

  return { companies, schools, tags };
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
 *
 * The tiebreaker is not cosmetic and is not free to choose. Goal relevance saturates —
 * on a real account a good number of contacts score exactly 1 — so with a single goal the
 * top five are ALL ties and the tiebreaker alone decides who the card shows. The
 * JavaScript this replaces sorted the scan with `b.goalRelevance - a.goalRelevance`, and
 * `Array.prototype.sort` is stable, so ties came back in scan order: `updated_at DESC, id
 * DESC`. Ordering by `id ASC` here instead would have shown five different people and
 * nothing would have failed.
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
    order by ${relevance} desc, updated_at desc, id desc
    limit ${limit}
  `);

  return rowsOf<{ id: string; goal_relevance: number }>(result).map((r) => ({
    id: r.id,
    goalRelevance: Number(r.goal_relevance),
  }));
}

export type NetworkStatsCounts = {
  totalContacts: number;
  /** `daysAgo(last_interaction_at) >= 30`, matching `network-stats.ts`. */
  dormant30: number;
  /** `next_follow_up_at <= now()`. */
  overdueFollowUps: number;
  oldestContactAt: Date | null;
};

/**
 * The four whole-network figures `getNetworkStats` used to derive by looping every contact.
 *
 * It took the dashboard's scan as a donation to do that, which is why `last_interaction_at`
 * and `created_at` had to be selected for the entire account — two of the widest columns on
 * the row, feeding a loop that produced four integers. As SQL it is one statement and the
 * scan is free of both.
 *
 * A different 30 to `getDashboardCounts`'s dormancy: this one is "quiet for a month", the
 * other is `COMET_DORMANT_DAYS` (a year) and drives the comets on the star chart. Two
 * genuinely different questions that both happen to be called dormant.
 */
export async function getNetworkStatsCounts(userId: string): Promise<NetworkStatsCounts> {
  const db = await getDb();
  const result = await db.execute(sql`
    select
      count(*)::int as total,
      count(*) filter (
        where last_interaction_at is not null
          and last_interaction_at <= now() - make_interval(days => 30)
      )::int as dormant30,
      count(*) filter (
        where next_follow_up_at is not null and next_follow_up_at <= now()
      )::int as overdue,
      min(created_at) as oldest
    from contacts
    where user_id = ${userId}
  `);

  const row = rowsOf<{
    total: number; dormant30: number; overdue: number; oldest: string | Date | null;
  }>(result)[0];

  return {
    totalContacts: Number(row?.total ?? 0),
    dormant30: Number(row?.dormant30 ?? 0),
    overdueFollowUps: Number(row?.overdue ?? 0),
    oldestContactAt: row?.oldest ? new Date(row.oldest) : null,
  };
}
