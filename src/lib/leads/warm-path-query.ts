/**
 * Runs the who-knows-whom statements for a viewer. Reciprocity first: a viewer with no team
 * or with sharing off gets a status, not a query. Then two statements for any number of
 * targets — the Leads pipeline must never issue one per row.
 */
import type { ClosenessTier } from "@/db/schema";
import { getDb, rowsOf } from "@/db";
import type { IdentityKind } from "@/lib/duplicates";
import { teammateDisplayName } from "@/lib/team-domain";
import { getViewerTeam } from "@/lib/teams";
import {
  identityPairs,
  rankWarmth,
  TIER_RANK,
  type TargetIdentity,
  type WarmPath,
  type WarmPathLookup,
} from "./warm-path";
import { accountPathsStatement, directPathsStatement } from "./warm-path-sql";

export type KeyedTarget = TargetIdentity & { key: string };

type MateRow = { user_id: string; first_name: string | null; last_name: string | null; email: string | null };
type DirectRow = MateRow & {
  target_key: string;
  tier: ClosenessTier;
  matched_on: IdentityKind;
};
type AccountRow = MateRow & { target_key: string; count: number; best_rank: number };

const RANK_TIER: ClosenessTier[] = ["inner", "mid", "outer"];

function teammate(r: MateRow) {
  return {
    userId: r.user_id,
    name: teammateDisplayName({ firstName: r.first_name, lastName: r.last_name, email: r.email }),
    email: r.email,
  };
}

export async function warmPathsForTargets(
  viewerUserId: string,
  targets: ReadonlyArray<KeyedTarget>
): Promise<{ status: "no_team" | "not_sharing" } | { status: "ok"; paths: Map<string, WarmPath> }> {
  const membership = await getViewerTeam(viewerUserId);
  if (!membership) return { status: "no_team" };
  if (!membership.shareNetwork) return { status: "not_sharing" };

  const paths = new Map<string, WarmPath>();
  for (const t of targets) paths.set(t.key, { warmth: "cold", direct: [], account: [] });

  const identityTargets = targets.flatMap((t) =>
    identityPairs(t).map((p) => ({ key: t.key, kind: p.kind, value: p.value }))
  );
  const companyTargets = targets.flatMap((t) =>
    t.companyNormalized ? [{ key: t.key, company: t.companyNormalized }] : []
  );

  const db = await getDb();
  if (identityTargets.length) {
    const rows = rowsOf<DirectRow>(
      await db.execute(directPathsStatement(membership.teamId, viewerUserId, identityTargets))
    );
    for (const r of rows) {
      paths.get(r.target_key)?.direct.push({
        teammate: teammate(r),
        tier: r.tier,
        matchedOn: r.matched_on,
      });
    }
  }
  if (companyTargets.length) {
    // The target's own identities are excluded in SQL by an anti-join in
    // `accountPathsStatement`, so `count` and `bestTier` describe other people at the
    // company, not the direct match too.
    const rows = rowsOf<AccountRow>(
      await db.execute(
        accountPathsStatement(membership.teamId, viewerUserId, companyTargets, identityTargets)
      )
    );
    for (const r of rows) {
      paths.get(r.target_key)?.account.push({
        teammate: teammate(r),
        count: Number(r.count),
        bestTier: RANK_TIER[Number(r.best_rank)] ?? "outer",
      });
    }
  }
  for (const path of paths.values()) {
    // Best tier first (rows already arrive best-contact-first per teammate from `distinct
    // on`), then teammate name so the order is deterministic without a score to break ties.
    path.direct.sort(
      (a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.teammate.name.localeCompare(b.teammate.name)
    );
    path.account.sort((a, b) => b.count - a.count || TIER_RANK[a.bestTier] - TIER_RANK[b.bestTier]);
    path.warmth = rankWarmth(path.direct, path.account);
  }
  return { status: "ok", paths };
}

/** One target. */
export async function findWarmPaths(viewerUserId: string, target: TargetIdentity): Promise<WarmPathLookup> {
  const result = await warmPathsForTargets(viewerUserId, [{ ...target, key: "target" }]);
  if (result.status !== "ok") return result;
  return { status: "ok", path: result.paths.get("target")! };
}
