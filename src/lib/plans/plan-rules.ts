import { cache } from "react";
import { like } from "drizzle-orm";
import { getDb } from "@/db";
import { appSurfaceFlags } from "@/db/schema";
import { recordAdminAction } from "@/lib/admin-audit";
import {
  FEATURE_KEYS,
  PLANS,
  PLAN_CONFIG,
  type FeatureKey,
  type Plan,
  type PlanConfig,
} from "@/lib/plans/plan-config";
import {
  EMPTY_PLAN_RULES,
  FEATURE_TIERS_PREFIX,
  LIMIT_FIELDS,
  LIMIT_PREFIX,
  applyPlanOverrides,
  featureRuleRow,
  limitOf,
  limitRuleRow,
  parseLimitValue,
  parsePlanRules,
  plansWithFeature,
  type LimitField,
  type LimitValue,
  type PlanRules,
} from "@/lib/plans/plan-overrides";

/**
 * The server half of runtime plan rules: one read of `app_surface_flags`, shared by the
 * surface-visibility reader (pages hidden / coming soon / tier-locked) and the plan table
 * (feature and limit overrides). SERVER ONLY.
 *
 * Across requests, per server instance, for `FLAG_ROWS_TTL_MS`: every gate reads this, and it
 * changes only when an operator saves. The writer clears it at once on its own instance;
 * other instances catch up within the TTL. A read failure is not memoized and fails OPEN to the
 * code defaults (`PLAN_CONFIG`, nothing hidden) for that one request.
 */
const FLAG_ROWS_TTL_MS = 15_000;

type FlagRowsSnapshot = {
  rows: string[];
  rules: PlanRules;
  config: Record<Plan, PlanConfig>;
};
let memo: { snapshot: FlagRowsSnapshot; at: number } | null = null;

/** Forget the cross-request copy. For writers of `app_surface_flags`, including tests. */
export function invalidateAppFlagRows(): void {
  memo = null;
}

/** Every `app_surface_flags` key, or null when the read failed (callers fall back to code defaults). */
export const readAppFlagRows = cache(async (): Promise<FlagRowsSnapshot | null> => {
  const now = Date.now();
  if (memo && now - memo.at < FLAG_ROWS_TTL_MS) return memo.snapshot;
  try {
    const db = await getDb();
    const rows = (await db.select({ key: appSurfaceFlags.surfaceKey }).from(appSurfaceFlags)).map((r) => r.key);
    const rules = parsePlanRules(rows);
    const snapshot = { rows, rules, config: applyPlanOverrides(PLAN_CONFIG, rules) };
    memo = { snapshot, at: now };
    return snapshot;
  } catch {
    return null;
  }
});

/** The operator's feature and limit overrides. Empty when none, or when the read failed. */
export async function getPlanRules(): Promise<PlanRules> {
  return (await readAppFlagRows())?.rules ?? EMPTY_PLAN_RULES;
}

/**
 * THE plan table every server gate reads: `PLAN_CONFIG` with the operator's overrides applied.
 * Same shape as `PLAN_CONFIG`. Code defaults when nothing is overridden or the read failed.
 */
export async function getEffectivePlanConfig(): Promise<Record<Plan, PlanConfig>> {
  return (await readAppFlagRows())?.config ?? PLAN_CONFIG;
}

function assertFeature(feature: string): asserts feature is FeatureKey {
  if (!(FEATURE_KEYS as readonly string[]).includes(feature)) throw new Error(`Unknown feature: ${feature}`);
}

function assertPlan(plan: string): asserts plan is Plan {
  if (!(PLANS as readonly string[]).includes(plan)) throw new Error(`Unknown plan: ${plan}`);
}

function assertLimitField(field: string): asserts field is LimitField {
  if (!(LIMIT_FIELDS as readonly string[]).includes(field)) throw new Error(`Unknown limit: ${field}`);
}

/**
 * Give `feature` to exactly `plans`. An empty list is allowed (nobody gets it) — the console
 * warns. Matching the code default deletes the rule, so a default later changed in code is
 * followed. Takes the admin id and does no auth, like every operator write here; the action
 * gates. Audited.
 */
export async function setFeaturePlans(
  adminUserId: string,
  feature: string,
  plans: readonly string[],
  opts: { reason?: string } = {}
): Promise<void> {
  assertFeature(feature);
  for (const p of plans) assertPlan(p);
  const allowed = PLANS.filter((p) => plans.includes(p));
  const before = plansWithFeature(await getEffectivePlanConfig(), feature);
  const isDefault = plansWithFeature(PLAN_CONFIG, feature).join() === allowed.join();

  const db = await getDb();
  await db.delete(appSurfaceFlags).where(like(appSurfaceFlags.surfaceKey, `${FEATURE_TIERS_PREFIX}${feature}:%`));
  if (!isDefault) {
    await db
      .insert(appSurfaceFlags)
      .values({ surfaceKey: featureRuleRow(feature, allowed), hiddenBy: adminUserId })
      .onConflictDoNothing();
  }
  invalidateAppFlagRows();

  await recordAdminAction({
    adminUserId,
    action: "product.plan.feature",
    resourceType: "plan_rule",
    resourceId: feature,
    detail: { before, plans: allowed, isDefault, ...(opts.reason ? { reason: opts.reason.slice(0, 500) } : {}) },
  });
}

/**
 * Set one numeric limit for one plan. `value` is a non-negative integer, or null for unlimited
 * on a field that allows it (`NULLABLE_LIMIT_FIELDS`). Matching the code default deletes the rule.
 */
export async function setPlanLimit(
  adminUserId: string,
  plan: string,
  field: string,
  value: LimitValue
): Promise<void> {
  assertPlan(plan);
  assertLimitField(field);
  if (value !== null && (!Number.isSafeInteger(value) || parseLimitValue(field, String(value)) === undefined)) {
    throw new Error("That limit must be a whole number, zero or more.");
  }
  if (value === null && parseLimitValue(field, "unlimited") === undefined) {
    throw new Error("That limit cannot be unlimited.");
  }
  const before = limitOf((await getEffectivePlanConfig())[plan], field);
  const isDefault = limitOf(PLAN_CONFIG[plan], field) === value;

  const db = await getDb();
  await db.delete(appSurfaceFlags).where(like(appSurfaceFlags.surfaceKey, `${LIMIT_PREFIX}${plan}:${field}:%`));
  if (!isDefault) {
    await db
      .insert(appSurfaceFlags)
      .values({ surfaceKey: limitRuleRow(plan, field, value), hiddenBy: adminUserId })
      .onConflictDoNothing();
  }
  invalidateAppFlagRows();

  await recordAdminAction({
    adminUserId,
    action: "product.plan.limit",
    resourceType: "plan_rule",
    resourceId: `${plan}:${field}`,
    detail: { before, value, isDefault },
  });
}

/** Drop an override so the code default applies again. */
export async function resetPlanRule(
  adminUserId: string,
  rule: { kind: "feature"; feature: string } | { kind: "limit"; plan: string; field: string }
): Promise<void> {
  if (rule.kind === "feature") {
    assertFeature(rule.feature);
    return setFeaturePlans(adminUserId, rule.feature, plansWithFeature(PLAN_CONFIG, rule.feature));
  }
  assertPlan(rule.plan);
  assertLimitField(rule.field);
  return setPlanLimit(adminUserId, rule.plan, rule.field, limitOf(PLAN_CONFIG[rule.plan], rule.field));
}
