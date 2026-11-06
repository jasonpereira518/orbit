/**
 * Operator overrides of the plan table, applied on top of the code defaults in `PLAN_CONFIG`.
 *
 * PURE AND CLIENT-SAFE: no DB, no env. The server reads the rows (`plan-rules.ts`) and every
 * gate goes through `getEffectivePlanConfig()`; client copy and tests call
 * `applyPlanOverrides` directly with rules they were handed.
 *
 * STORAGE. Rows in `app_surface_flags` (no schema change), beside the page `tiers:` rows:
 *
 *   tiers:feature:<featureKey>:<plan,plan>   the plans that get the feature ("-" = no plan)
 *   limit:<plan>:<field>:<value>             one numeric limit; value is a non-negative
 *                                            integer, or "unlimited" for a nullable field
 *
 * A missing row means the code default. Anything unrecognised — an unknown feature, plan or
 * field, a non-integer, a negative number, "unlimited" on a field that cannot be unlimited —
 * is dropped on parse, so a hand-edited row can never break a gate; it just does nothing.
 */
import {
  FEATURE_KEYS,
  PLANS,
  PLAN_SHORT_LABELS,
  type FeatureKey,
  type Plan,
  type PlanConfig,
} from "@/lib/plans/plan-config";

export const FEATURE_TIERS_PREFIX = "tiers:feature:";
export const LIMIT_PREFIX = "limit:";
/** The plan list a feature rule stores when no plan gets it. */
const NO_PLANS = "-";

/** The numeric fields of `PlanConfig` an operator may change. */
export const LIMIT_FIELDS = [
  "contactLimit",
  "monthlyCredits",
  "speech.meetingSeconds",
  "speech.shortformSeconds",
  "googleMicrosoftConnections",
] as const;
export type LimitField = (typeof LIMIT_FIELDS)[number];

/** Fields whose `null` means "no limit", and so accept "unlimited". */
export const NULLABLE_LIMIT_FIELDS: ReadonlySet<LimitField> = new Set<LimitField>([
  "contactLimit",
  "googleMicrosoftConnections",
]);

/** Smallest value a field accepts. A Google/Microsoft limit of 0 has no enforcement behind it. */
export const LIMIT_MIN: Record<LimitField, number> = {
  contactLimit: 0,
  monthlyCredits: 0,
  "speech.meetingSeconds": 0,
  "speech.shortformSeconds": 0,
  googleMicrosoftConnections: 1,
};

/** `null` = unlimited. */
export type LimitValue = number | null;

export type PlanRules = {
  /** Feature → the plans that get it. Absent = code default. */
  features: Partial<Record<FeatureKey, Plan[]>>;
  /** Plan → field → value. Absent = code default. */
  limits: Partial<Record<Plan, Partial<Record<LimitField, LimitValue>>>>;
};

export const EMPTY_PLAN_RULES: PlanRules = { features: {}, limits: {} };

const isFeature = (k: string): k is FeatureKey => (FEATURE_KEYS as readonly string[]).includes(k);
const isPlan = (k: string): k is Plan => (PLANS as readonly string[]).includes(k);
const isLimitField = (k: string): k is LimitField => (LIMIT_FIELDS as readonly string[]).includes(k);

/** A limit value as stored, or undefined when it is not valid for `field`. */
export function parseLimitValue(field: LimitField, raw: string): LimitValue | undefined {
  if (raw === "unlimited") return NULLABLE_LIMIT_FIELDS.has(field) ? null : undefined;
  if (!/^\d{1,12}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= LIMIT_MIN[field] ? n : undefined;
}

export function featureRuleRow(feature: FeatureKey, plans: readonly Plan[]): string {
  const ordered = PLANS.filter((p) => plans.includes(p));
  return `${FEATURE_TIERS_PREFIX}${feature}:${ordered.length ? ordered.join(",") : NO_PLANS}`;
}

export function limitRuleRow(plan: Plan, field: LimitField, value: LimitValue): string {
  return `${LIMIT_PREFIX}${plan}:${field}:${value === null ? "unlimited" : value}`;
}

/** Whether a flag row is a plan rule (so the visibility reader never counts it as hidden). */
export function isPlanRuleRow(row: string): boolean {
  return row.startsWith(FEATURE_TIERS_PREFIX) || row.startsWith(LIMIT_PREFIX);
}

/** Flag rows → plan rules. Ignores every row that is not a well-formed plan rule. */
export function parsePlanRules(rows: Iterable<string>): PlanRules {
  const rules: PlanRules = { features: {}, limits: {} };
  for (const row of rows) {
    if (row.startsWith(FEATURE_TIERS_PREFIX)) {
      const [feature, list, ...extra] = row.slice(FEATURE_TIERS_PREFIX.length).split(":");
      if (extra.length || !feature || list === undefined || !isFeature(feature)) continue;
      const listed = list === NO_PLANS ? [] : list.split(",");
      if (listed.some((p) => !isPlan(p))) continue;
      rules.features[feature] = PLANS.filter((p) => listed.includes(p));
    } else if (row.startsWith(LIMIT_PREFIX)) {
      const [plan, field, raw, ...extra] = row.slice(LIMIT_PREFIX.length).split(":");
      if (extra.length || !plan || !field || raw === undefined || !isPlan(plan) || !isLimitField(field)) continue;
      const value = parseLimitValue(field, raw);
      if (value === undefined) continue;
      (rules.limits[plan] ??= {})[field] = value;
    }
  }
  return rules;
}

export function limitOf(config: PlanConfig, field: LimitField): LimitValue {
  switch (field) {
    case "speech.meetingSeconds":
      return config.speech.meetingSeconds;
    case "speech.shortformSeconds":
      return config.speech.shortformSeconds;
    default:
      return config[field];
  }
}

/**
 * The plan table with `rules` applied. Returns new objects; `base` is never mutated.
 *
 * `extraConnections` and `googleMicrosoftConnections` describe one thing (may a plan connect
 * both Google and Microsoft), so either knob moves both: a feature rule sets the limit to
 * unlimited / 1, and a limit rule — applied after, so it wins — sets the feature.
 */
export function applyPlanOverrides(
  base: Record<Plan, PlanConfig>,
  rules: PlanRules
): Record<Plan, PlanConfig> {
  const out = {} as Record<Plan, PlanConfig>;
  for (const plan of PLANS) {
    const config: PlanConfig = {
      ...base[plan],
      speech: { ...base[plan].speech },
      features: { ...base[plan].features },
    };
    for (const feature of FEATURE_KEYS) {
      const plans = rules.features[feature];
      if (!plans) continue;
      config.features[feature] = plans.includes(plan);
      if (feature === "extraConnections") {
        config.googleMicrosoftConnections = config.features.extraConnections ? null : 1;
      }
    }
    for (const [field, value] of Object.entries(rules.limits[plan] ?? {}) as [LimitField, LimitValue][]) {
      if (field === "speech.meetingSeconds") config.speech.meetingSeconds = value ?? 0;
      else if (field === "speech.shortformSeconds") config.speech.shortformSeconds = value ?? 0;
      else if (field === "monthlyCredits") config.monthlyCredits = value;
      else if (field === "contactLimit") config.contactLimit = value;
      else if (field === "googleMicrosoftConnections") {
        config.googleMicrosoftConnections = value;
        config.features.extraConnections = value === null || value >= 2;
      }
    }
    out[plan] = config;
  }
  return out;
}

/** The plans that get `feature` under `config`. */
export function plansWithFeature(config: Record<Plan, PlanConfig>, feature: FeatureKey): Plan[] {
  return PLANS.filter((p) => config[p].features[feature]);
}


/**
 * One line per override that differs from the code default, e.g. "recruiters: Free, Pro, Max,
 * Lifetime (default Pro, Max, Lifetime)" or "Free contactLimit: 1000 (default 500)". For the
 * console's reminder that the hand-edited Terms and Privacy pages do not follow these.
 */
export function describeOverrides(rules: PlanRules, defaults: Record<Plan, PlanConfig>): string[] {
  const names = (plans: readonly Plan[]) => (plans.length ? plans.map((p) => PLAN_SHORT_LABELS[p]).join(", ") : "no plan");
  const value = (v: LimitValue) => (v === null ? "unlimited" : String(v));
  const lines: string[] = [];
  for (const feature of FEATURE_KEYS) {
    const plans = rules.features[feature];
    const before = plansWithFeature(defaults, feature);
    if (plans && plans.join() !== before.join()) lines.push(`${feature}: ${names(plans)} (default ${names(before)})`);
  }
  for (const plan of PLANS) {
    for (const [field, v] of Object.entries(rules.limits[plan] ?? {}) as [LimitField, LimitValue][]) {
      const before = limitOf(defaults[plan], field);
      if (v !== before) lines.push(`${PLAN_SHORT_LABELS[plan]} ${field}: ${value(v)} (default ${value(before)})`);
    }
  }
  return lines;
}
