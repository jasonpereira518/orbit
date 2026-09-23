/**
 * The who-knows-whom statements, as pure builders.
 *
 * These are raw statements on purpose. The rules they must keep are structural — every
 * join carries a tenant equality, the sharing switches are WHERE terms rather than a JS
 * filter, no correlated EXISTS (the hashed-SubPlan rewrite once stripped tenant scoping
 * from one), and the SELECT list is the whole privacy boundary — and a drizzle query
 * builder cannot hold a column interpolated into a projection qualified. Built without a
 * database so `scripts/smoke-warm-path.ts` can render them and grep for the columns that
 * must never appear.
 *
 * Reciprocity is decided by the CALLER before either runs: a viewer who is not sharing
 * never reaches these.
 */
import { sql, type SQL } from "drizzle-orm";
import type { IdentityKind } from "@/lib/duplicates";

export type IdentityTarget = { key: string; kind: IdentityKind; value: string };
export type CompanyTarget = { key: string; company: string };

/** The teammates whose networks are open to the viewer: same team, sharing, not the viewer. */
function mateCte(teamId: string, viewerUserId: string): SQL {
  return sql`mate as (
    select tm.user_id, us.first_name, us.last_name, us.email
    from team_members tm
    join user_settings us on us.user_id = tm.user_id
    where tm.team_id = ${teamId} and tm.share_network = 1 and tm.user_id <> ${viewerUserId})`;
}

const TIER_CASE = sql`case coalesce(c.closeness_tier, 'outer') when 'inner' then 0 when 'mid' then 1 else 2 end`;

/** Teammates who know a target directly: one row per (target, teammate), best contact first. */
export function directPathsStatement(
  teamId: string,
  viewerUserId: string,
  targets: IdentityTarget[]
): SQL {
  const values = sql.join(
    targets.map((t) => sql`(${t.key}::text, ${t.kind}::text, ${t.value}::text)`),
    sql`, `
  );
  return sql`with target(target_key, kind, value) as (values ${values}),
${mateCte(teamId, viewerUserId)}
select distinct on (t.target_key, m.user_id)
  t.target_key, m.user_id, m.first_name, m.last_name, m.email,
  coalesce(c.closeness_tier, 'outer') as tier, c.closeness, t.kind as matched_on
from target t
join contact_identities ci on ci.kind = t.kind and ci.value = t.value
join mate m on m.user_id = ci.user_id
join contacts c on c.id = ci.contact_id and c.user_id = ci.user_id and c.team_shared = 1
order by t.target_key, m.user_id, ${TIER_CASE}, c.closeness desc nulls last`;
}

/** Teammates who know anyone at a target's company: a count and the best tier, per teammate. */
export function accountPathsStatement(
  teamId: string,
  viewerUserId: string,
  targets: CompanyTarget[]
): SQL {
  const values = sql.join(
    targets.map((t) => sql`(${t.key}::text, ${t.company}::text)`),
    sql`, `
  );
  return sql`with target(target_key, company) as (values ${values}),
${mateCte(teamId, viewerUserId)}
select t.target_key, m.user_id, m.first_name, m.last_name, m.email,
  count(*)::int as count, min(${TIER_CASE})::int as best_rank
from target t
join mate m on true
join companies co on co.user_id = m.user_id and co.name_normalized = t.company
join contacts c on c.company_id = co.id and c.user_id = co.user_id and c.team_shared = 1
group by t.target_key, m.user_id, m.first_name, m.last_name, m.email`;
}
