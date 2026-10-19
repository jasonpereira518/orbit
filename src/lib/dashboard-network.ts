import { sql, type SQL } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, contactTags, contactTouchCounts, tags } from "@/db/schema";
import { ABSOLUTE_TIER_CUTOFFS } from "@/lib/closeness";
import type { ClosenessScalars } from "@/lib/closeness-cohort";
import { IMPORT_SOURCE_TAGS, type ConstellationThresholds } from "@/lib/constellation-eligibility";
import { METRICS_MAX_CONTACTS } from "@/lib/network-metrics";

/**
 * The dashboard's whole-network questions, answered by Postgres from the stored scores.
 *
 * The dashboard used to load four whole-network row sets into memory to answer them —
 * every contact's narrow columns, every contact's closeness scalars, every interacted
 * contact's touch tallies and every tagged contact's tag count: ~300k rows at 100k
 * contacts, on the most visited page. Each function here asks the same question of the
 * same stored values and returns only the answer: the contacts on the chart, the counts the
 * clusters are decided by, the metrics sample, the histogram. `scripts/smoke-dashboard-parity.ts`
 * holds the result to what the in-memory version produced.
 *
 * "Stored" means `ensureStoredScoresCurrent` has run: a contact the cohort read would have
 * left unscored has no breakdown here either, and reads as unscored the same way.
 */

/** A stored breakdown number, or null when absent (or not a number). */
function scalar(key: "raw" | "closeness" | "orbitScore"): SQL {
  return sql.raw(
    `(case when jsonb_typeof(contacts.closeness_breakdown->'${key}') = 'number' then (contacts.closeness_breakdown->>'${key}')::float8 end)`
  );
}

/** The four `ClosenessScalars`, and whether the contact has a stored breakdown at all. */
export const closenessScalarColumns = sql`
  ${scalar("raw")} as raw, ${scalar("closeness")} as closeness, ${scalar("orbitScore")} as orbit_score,
  (contacts.closeness_breakdown->>'tier') as tier, (contacts.closeness_breakdown is not null) as scored`;

/** `closenessScalarColumns` as Drizzle relational `extras`, for a `db.query.contacts` read. */
export const closenessScalarExtras = {
  raw: sql<number | null>`${scalar("raw")}`.as("raw"),
  closeness: sql<number | null>`${scalar("closeness")}`.as("closeness"),
  orbit_score: sql<number | null>`${scalar("orbitScore")}`.as("orbit_score"),
  tier: sql<ClosenessScalars["tier"] | null>`(contacts.closeness_breakdown->>'tier')`.as("tier"),
  scored: sql<boolean>`(contacts.closeness_breakdown is not null)`.as("scored"),
};

export type ScalarRow = {
  raw: number | null;
  closeness: number | null;
  orbit_score: number | null;
  tier: ClosenessScalars["tier"] | null;
  scored: boolean;
};

/** What the cohort's `byId` held for this contact: the scalars when it is scored, else nothing. */
export function scalarsOf(row: ScalarRow): ClosenessScalars | undefined {
  if (!row.scored) return undefined;
  return { raw: row.raw, closeness: row.closeness, orbitScore: row.orbit_score, tier: row.tier } as ClosenessScalars;
}

export type ChartContactRow = ScalarRow & {
  id: string;
  company: string | null;
  school: string | null;
  industry: string | null;
  relationship_score: number;
  next_follow_up_at: Date | string | null;
  interacted: boolean;
  eligible: boolean;
};

/** One (company, school, industry) a contact on the chart has, and how many have it. */
export type ChartGroup = {
  company: string | null;
  school: string | null;
  industry: string | null;
  n: number;
  /** Of `n`, how many `constellationEligibility` passes (all of them when the filter is on). */
  eligible: number;
};

type ChartOptions = { filterActive: boolean; thresholds: ConstellationThresholds };

/**
 * One user's contacts that have notes, as `contacts_with_notes_idx` covers them: the same
 * predicate as `contactHasNotesSql`, spelled exactly as the index's so the planner uses it,
 * which answers "has notes" without reading the notes themselves.
 */
function contactsWithNotes(userId: string): SQL {
  return sql`(select id from ${contacts} where user_id = ${userId} and notes is not null and btrim(notes) <> '')`;
}

/** The import source tags, which never count as a user's own (`userTagCount`). */
function importSourceTagList(): SQL {
  return sql.join(IMPORT_SOURCE_TAGS.map((t) => sql`${t}`), sql`, `);
}

/**
 * `constellationEligibility`, in SQL, over a row of `contacts` joined to its tallies as
 * `touch` (a `contact_touch_counts` row, null when it has none) and its user-tag count as
 * `tagn.n`. `hasNotes` is how the caller knows the contact has notes.
 */
function eligibleSql({ minInbound, minOutbound }: ConstellationThresholds, hasNotes: SQL): SQL {
  const n = (column: string) => sql.raw(`coalesce(touch.${column}, 0)`);
  return sql`(case
      when contacts.constellation_pin = 'out' then false
      when contacts.constellation_pin = 'in' then true
      else (
        ${hasNotes}
        or ${n("note_interactions")} > 0
        or ${n("meeting_interactions")} > 0
        or (case when ${n("message_inbound")} > 0 or ${n("message_outbound")} > 0
                 then ${n("message_inbound")} >= ${minInbound}::int and ${n("message_outbound")} >= ${minOutbound}::int
                 else ${n("message_undirected")} > 0 and ${n("message_undirected")} >= ${minInbound + minOutbound}::int end)
        or contacts.stated_closeness is not null
        or contacts.priority_level >= 1
        or contacts.next_follow_up_at is not null
        or coalesce(tagn.n, 0) > 0
      ) end)`;
}

/**
 * The FROM and the eligibility predicate for the whole network: `contacts` with each
 * contact's touch tallies (`contact_touch_counts`: `constellationSignalAggregates` under
 * `countsAsTouch`, kept by triggers) and user-tag count (import source tags excluded, as the
 * dashboard counted them). `eligible` is `constellationEligibility`, written in SQL.
 */
function chartSource(userId: string, { thresholds }: ChartOptions) {
  const eligible = eligibleSql(thresholds, sql`(noted.id is not null)`);
  const ctes = sql`
      with tagn as (
        select ${contactTags.contactId} as contact_id, count(*)::int as n
          from ${contactTags}
          join ${contacts} on ${contacts.id} = ${contactTags.contactId}
          join ${tags} on ${tags.id} = ${contactTags.tagId}
         where ${contacts.userId} = ${userId}
           and lower(trim(${tags.name})) not in (${importSourceTagList()})
         group by ${contactTags.contactId}
      )`;
  // The touch tallies are stored (`contact_touch_counts`, kept by triggers): aggregating
  // every interaction in the account here was ~350 ms of this statement at 100k contacts.
  // Who has notes comes from `contacts_with_notes_idx` rather than reading every contact's
  // notes to test them, which was another ~380 ms.
  const from = sql`${contacts}
        left join ${contactTouchCounts} as touch on touch.contact_id = contacts.id
        left join tagn on tagn.contact_id = contacts.id
        left join ${contactsWithNotes(userId)} as noted on noted.id = contacts.id`;
  return { ctes, from, eligible };
}

/**
 * The contacts the constellation may draw — the ones `constellationEligibility` passes when
 * the filter is on, everyone when it is off — grouped by the three columns a contact's
 * cluster depends on (`clusterRefFor`). The chart needs to know who clusters with whom,
 * not one row per person: at 100k contacts the per-contact version moved 92k rows.
 */
export async function loadChartGroups(userId: string, opts: ChartOptions): Promise<ChartGroup[]> {
  const db = await getDb();
  const { ctes, from, eligible } = chartSource(userId, opts);
  const rows = rowsOf<ChartGroup>(
    await db.execute(sql`
      ${ctes}
      select contacts.company, contacts.school, contacts.industry,
             count(*)::int as n, (count(*) filter (where ${eligible}))::int as eligible
        from ${from}
       where contacts.user_id = ${userId}
         ${opts.filterActive ? sql`and ${eligible}` : sql``}
       group by contacts.company, contacts.school, contacts.industry
    `)
  );
  return rows.map((r) => ({ ...r, n: Number(r.n), eligible: Number(r.eligible) }));
}

/**
 * The chart contacts with one of `groups`' (company, school, industry), as the preview
 * draws them: the first `limit` in the dashboard's order (`updated_at DESC, id DESC`), or,
 * `byOrbitScore`, the `limit` highest orbit scores (an unscored contact counting as 2) with
 * ties in that order — a stable sort of it.
 */
export async function loadChartContacts(
  userId: string,
  opts: ChartOptions & { groups: Array<Pick<ChartGroup, "company" | "school" | "industry">>; limit: number; byOrbitScore: boolean }
): Promise<ChartContactRow[]> {
  if (opts.groups.length === 0) return [];
  const db = await getDb();
  // Matched as one jsonb value per contact: equal when all three are, nulls included, and
  // hashable. Written as three `IS NOT DISTINCT FROM`s, Postgres 16 could only nest-loop it,
  // and re-ran it per interaction: 430 s at 100k contacts.
  const groupKeys = JSON.stringify(opts.groups.map((g) => [g.company, g.school, g.industry]));
  // The same order inside (by output column) and outside (by the subquery's column).
  const innerOrder = sql.raw(`${opts.byOrbitScore ? "sort_key desc, " : ""}updated_at desc, id desc`);
  const order = sql.raw(`${opts.byOrbitScore ? "contacts.sort_key desc, " : ""}contacts.updated_at desc, contacts.id desc`);
  // Who has notes, probed per row as the outer query reaches it (`contacts_with_notes_idx`):
  // inside the ordered subquery it was worked out for every candidate before the sort.
  const eligible = eligibleSql(
    opts.thresholds,
    sql`exists (select 1 from ${contactsWithNotes(userId)} as noted where noted.id = contacts.id)`
  );
  // The candidates in the preview's order first, then each one's stored tallies as it is
  // reached, stopping at `limit` drawable contacts: aggregating the tallies for the whole
  // network is what made one statement of this 2 s at 100k contacts, for 150 rows.
  return rowsOf<ChartContactRow>(
    await db.execute(sql`
      select contacts.id, contacts.company, contacts.school, contacts.industry,
             contacts.relationship_score, contacts.next_follow_up_at,
             coalesce(touch.total, 0) > 0 as interacted, ${eligible} as eligible,
             contacts.s_raw as raw, contacts.s_closeness as closeness, contacts.s_orbit_score as orbit_score,
             contacts.s_tier as tier, contacts.s_scored as scored
        from (
          -- Narrow, and the sort key as a column, so the outer ORDER BY is this one's order
          -- and the LIMIT can stop the laterals early.
          select contacts.id, contacts.company, contacts.school, contacts.industry,
                 contacts.relationship_score, contacts.next_follow_up_at, contacts.constellation_pin,
                 contacts.stated_closeness, contacts.priority_level, contacts.updated_at,
                 ${scalar("raw")} as s_raw, ${scalar("closeness")} as s_closeness, ${scalar("orbitScore")} as s_orbit_score,
                 (contacts.closeness_breakdown->>'tier') as s_tier, (contacts.closeness_breakdown is not null) as s_scored,
                 coalesce(${scalar("orbitScore")}, 2) as sort_key
            from ${contacts}
           where contacts.user_id = ${userId}
             and jsonb_build_array(contacts.company, contacts.school, contacts.industry)
                 in (select e from jsonb_array_elements(${groupKeys}::jsonb) as k(e))
           order by ${innerOrder}
          offset 0
        ) as contacts
        left join ${contactTouchCounts} as touch on touch.contact_id = contacts.id
        left join lateral (
          select count(*)::int as n
            from ${contactTags}
            join ${tags} on ${tags.id} = ${contactTags.tagId}
           where ${contactTags.contactId} = contacts.id
             and lower(trim(${tags.name})) not in (${importSourceTagList()})
        ) as tagn on true
       ${opts.filterActive ? sql`where ${eligible}` : sql``}
       order by ${order}
       limit ${opts.limit}
    `)
  );
}

/**
 * Per-value tallies for `clusterCountsFromTallies`: how many contacts carry each raw company,
 * school and industry, and for an industry the position of its first contact in the
 * dashboard's order (which spelling labels the cluster).
 */
export async function loadClusterTallies(userId: string) {
  const db = await getDb();
  const rows = rowsOf<{ kind: "c" | "s" | "i"; value: string | null; n: number; first: number }>(
    await db.execute(sql`
      select 'c' as kind, company as value, count(*)::int as n, 0 as first
        from contacts where user_id = ${userId} and company is not null group by company
      union all
      select 's', school, count(*)::int, 0
        from contacts where user_id = ${userId} and school is not null group by school
      union all
      select 'i', industry, count(*)::int, min(pos)::int
        from (select industry, row_number() over (order by updated_at desc, id desc) as pos
                from contacts where user_id = ${userId} and industry is not null) ranked
       group by industry
    `)
  );
  return {
    company: rows.filter((r) => r.kind === "c"),
    school: rows.filter((r) => r.kind === "s"),
    industry: rows.filter((r) => r.kind === "i").map((r) => ({ ...r, first: Number(r.first) })),
  };
}

export type SampleRow = ScalarRow & {
  id: string;
  company: string | null;
  school: string | null;
  relationship_score: number;
};

/**
 * `selectMetricsSample` over the whole network: everyone, in the dashboard's order, when
 * there are at most `METRICS_MAX_CONTACTS`; otherwise the closest that many, ties in that
 * order (a stable sort of it), unscored contacts counting as closeness 0.
 */
export async function loadMetricsSample(userId: string): Promise<SampleRow[]> {
  const db = await getDb();
  return rowsOf<SampleRow>(
    await db.execute(sql`
      select contacts.id, contacts.company, contacts.school, contacts.relationship_score, ${closenessScalarColumns}
        from ${contacts}
       where contacts.user_id = ${userId}
       order by (case when (select count(*) from contacts c2 where c2.user_id = ${userId}) > ${METRICS_MAX_CONTACTS}
                      then coalesce(${scalar("closeness")}, 0) else 0 end) desc,
                contacts.updated_at desc, contacts.id desc
       limit ${METRICS_MAX_CONTACTS}
    `)
  );
}

/**
 * The orbit-score histogram (every contact, an unscored or zero score counting as 2, clamped
 * to 1..5) and the absolute-tier counts over scored contacts (`closenessTier(raw)`).
 */
export async function loadScoreDistribution(userId: string): Promise<{
  scoreCounts: Record<number, number>;
  tierCounts: { inner: number; mid: number; outer: number };
}> {
  const db = await getDb();
  const rows = rowsOf<{ s: number; n: number; inner: number; mid: number; outer: number }>(
    await db.execute(sql`
      select least(5, greatest(1, coalesce(nullif(${scalar("orbitScore")}, 0), 2))) as s,
             count(*)::int as n,
             count(*) filter (where contacts.closeness_breakdown is not null
                                and ${scalar("raw")} >= ${ABSOLUTE_TIER_CUTOFFS.inner}::float8)::int as inner,
             count(*) filter (where contacts.closeness_breakdown is not null
                                and ${scalar("raw")} >= ${ABSOLUTE_TIER_CUTOFFS.mid}::float8
                                and ${scalar("raw")} < ${ABSOLUTE_TIER_CUTOFFS.inner}::float8)::int as mid,
             count(*) filter (where contacts.closeness_breakdown is not null
                                and coalesce(${scalar("raw")} < ${ABSOLUTE_TIER_CUTOFFS.mid}::float8, true))::int as outer
        from ${contacts}
       where contacts.user_id = ${userId}
       group by 1
    `)
  );
  const scoreCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const tierCounts = { inner: 0, mid: 0, outer: 0 };
  for (const r of [...rows].sort((a, b) => Number(a.s) - Number(b.s))) {
    scoreCounts[Number(r.s)] = (scoreCounts[Number(r.s)] || 0) + Number(r.n);
    tierCounts.inner += Number(r.inner);
    tierCounts.mid += Number(r.mid);
    tierCounts.outer += Number(r.outer);
  }
  return { scoreCounts, tierCounts };
}

export type DueCandidateRow = {
  id: string;
  company: string | null;
  school: string | null;
  relationship_score: number;
  priority_level: number;
  next_follow_up_at: Date | string | null;
  tier: ClosenessScalars["tier"] | null;
};

/**
 * Contacts whose follow-up could be due: the SQL bound allows an hour of clock skew, and the
 * caller decides due-ness against its own `now` (see `loadDueFollowUps`).
 */
export async function loadDueCandidates(userId: string): Promise<DueCandidateRow[]> {
  const db = await getDb();
  return rowsOf<DueCandidateRow>(
    await db.execute(sql`
      select contacts.id, contacts.company, contacts.school, contacts.relationship_score,
             contacts.priority_level, contacts.next_follow_up_at,
             (contacts.closeness_breakdown->>'tier') as tier
        from ${contacts}
       where contacts.user_id = ${userId}
         and contacts.next_follow_up_at is not null
         and contacts.next_follow_up_at <= now() + interval '1 hour'
    `)
  );
}
