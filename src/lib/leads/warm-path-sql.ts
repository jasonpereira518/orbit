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

/**
 * The `ident(target_key, kind, value)` CTE that `accountPathsStatement` anti-joins against,
 * built from the identified people to exclude from their own company's count. Empty
 * `exclude` (a bare company-only lookup, no identity on the target) still needs a validly
 * shaped, empty relation for the `hit` CTE below to join against either way — `select ...
 * where false` rather than a `('', '', '')` sentinel row, so there is no literal value that
 * could ever accidentally match a real `(kind, value)` pair.
 */
function identCte(exclude: IdentityTarget[]): SQL {
  if (exclude.length === 0) {
    return sql`ident(target_key, kind, value) as (select null::text, null::text, null::text where false)`;
  }
  const values = sql.join(
    exclude.map((t) => sql`(${t.key}::text, ${t.kind}::text, ${t.value}::text)`),
    sql`, `
  );
  return sql`ident(target_key, kind, value) as (values ${values})`;
}

/** Teammates who know a target directly: one row per (target, teammate), best contact first. */
export function directPathsStatement(
  teamId: string,
  viewerUserId: string,
  targets: IdentityTarget[]
): SQL {
  if (targets.length === 0) throw new Error("warm-path: empty target list");
  const values = sql.join(
    targets.map((t) => sql`(${t.key}::text, ${t.kind}::text, ${t.value}::text)`),
    sql`, `
  );
  return sql`with target(target_key, kind, value) as (values ${values}),
${mateCte(teamId, viewerUserId)}
select distinct on (t.target_key, m.user_id)
  t.target_key, m.user_id, m.first_name, m.last_name, m.email,
  coalesce(c.closeness_tier, 'outer') as tier, t.kind as matched_on
from target t
join contact_identities ci on ci.kind = t.kind and ci.value = t.value
join mate m on m.user_id = ci.user_id
join contacts c on c.id = ci.contact_id and c.user_id = ci.user_id and c.team_shared = 1
order by t.target_key, m.user_id, ${TIER_CASE}, c.closeness desc nulls last`;
}

/**
 * Teammates who know anyone at a target's company: a count and the best tier, per teammate.
 * `exclude` names the target person's own identities, so a company lookup run alongside a
 * direct lookup on the same person does not count them among "others at the company".
 *
 * The anti-join is a `hit` CTE, not `where not exists (...)` (forbidden — see the module
 * comment) and not a bare `left join ident ... where i.target_key is null` (not enough: a
 * contact with two identities, one matching and one not, would still pass the `is null` test
 * via its non-matching row). `hit` aggregates matches per `(contact_id, target_key)` first,
 * so a contact is excluded once no matter how many identities the anti-join could pivot on.
 */
export function accountPathsStatement(
  teamId: string,
  viewerUserId: string,
  targets: CompanyTarget[],
  exclude: IdentityTarget[]
): SQL {
  if (targets.length === 0) throw new Error("warm-path: empty target list");
  const values = sql.join(
    targets.map((t) => sql`(${t.key}::text, ${t.company}::text)`),
    sql`, `
  );
  return sql`with target(target_key, company) as (values ${values}),
${mateCte(teamId, viewerUserId)},
${identCte(exclude)},
hit as (
  select x.contact_id, i.target_key
  from contact_identities x
  join ident i on i.kind = x.kind and i.value = x.value
  join mate m on m.user_id = x.user_id
  group by x.contact_id, i.target_key)
select t.target_key, m.user_id, m.first_name, m.last_name, m.email,
  count(*)::int as count, min(${TIER_CASE})::int as best_rank
from target t
join mate m on true
join companies co on co.user_id = m.user_id and co.name_normalized = t.company
join contacts c on c.company_id = co.id and c.user_id = co.user_id and c.team_shared = 1
left join hit h on h.contact_id = c.id and h.target_key = t.target_key
where h.contact_id is null
group by t.target_key, m.user_id, m.first_name, m.last_name, m.email`;
}
