import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { resolvePlan, type Plan, type PlanSource } from "@/lib/entitlements";
import type { AdminUserRow } from "@/lib/admin-metrics";

/**
 * The paginated roster query.
 *
 * `/admin/users` used to load every account and filter, sort and slice in JS. Its comment
 * said paging was impossible because a derived sort ("most contacts") could not be pushed
 * into the base query. That was true of the *shape* it used — six independent aggregate
 * scans joined in JS afterwards — but not of the problem: as CTEs joined onto
 * `user_settings`, the derived columns are in the base query, so ORDER BY and LIMIT can
 * live in SQL where they belong. The CTEs each scan their table once, exactly as the old
 * fan-out did, so the cost is unchanged while the result set stops growing with the
 * account count.
 *
 * `loadAdminUserRows()` in `admin-metrics.ts` is deliberately kept for `/admin` and
 * `/admin/billing`, which genuinely need every row to build the funnel and the alert list.
 *
 * DRIFT HAZARD, read before editing: `PLAN_SQL` below re-implements `resolvePlan`'s
 * precedence in SQL. Two implementations of the paywall's identity rule is exactly the kind
 * of thing that rots, so `scripts/smoke-admin-roster.ts` asserts the SQL-filtered set
 * equals the `resolvePlan`-filtered set row by row, for every filter. The badge the UI
 * renders still comes from `resolvePlan` in JS, so what is *displayed* can never disagree
 * with what the paywall enforces — only the filter could, and that is what the test covers.
 */

export type RosterSort =
  | "signup"
  | "active"
  | "contacts"
  | "interactions"
  | "ai"
  | "email";

export type RosterPlanFilter = "all" | "free" | "orbit" | "lifetime" | "comped";

export type RosterStateFilter =
  | "all"
  | "no-key"
  | "past-due"
  | "inactive"
  | "failing-ai"
  | "suspended";

export type RosterQuery = {
  q?: string;
  plan?: RosterPlanFilter;
  state?: RosterStateFilter;
  sort?: RosterSort;
  dir?: "asc" | "desc";
  /** 1-based. */
  page?: number;
  pageSize?: number;
};

export type AdminRosterPage = {
  rows: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export const ROSTER_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** Export cap. High enough to be a non-issue at Orbit's scale, low enough to bound memory. */
export const ROSTER_EXPORT_LIMIT = 5000;

/**
 * Sort expressions, looked up by key — never interpolated from `searchParams`.
 *
 * NULLS LAST on every key, and `s.user_id` as the tiebreaker: without a total order,
 * LIMIT/OFFSET is free to return the same row on two different pages, which is the classic
 * way a pager silently drops records.
 */
const ORDER_BY: Record<RosterSort, string> = {
  signup: "s.created_at",
  active: "greatest(s.last_active_at, agg.last_write_at)",
  contacts: "agg.contacts",
  interactions: "agg.interactions",
  ai: "agg.ai_calls",
  email: "lower(coalesce(s.email, s.user_id))",
};

const DEFAULT_SORT_DIR: Record<RosterSort, "asc" | "desc"> = {
  signup: "desc",
  active: "desc",
  contacts: "desc",
  interactions: "desc",
  ai: "desc",
  email: "asc",
};

export function isRosterSort(value: unknown): value is RosterSort {
  return typeof value === "string" && value in ORDER_BY;
}

/**
 * Mirrors `resolvePlan` precedence: comp > lifetime > subscription > free.
 *
 * Only the resolved *plan* is expressed in SQL, not the source. The one filter that needs
 * the source — "comped" — is `comped_plan IS NOT NULL`, which is the source rule stated
 * directly, so a second CASE would be a second thing to keep in sync for no gain.
 */
const PLAN_SQL = `
  CASE
    WHEN s.comped_plan = 'lifetime' THEN 'lifetime'
    WHEN s.comped_plan = 'orbit' THEN 'orbit'
    WHEN s.lifetime_purchased_at IS NOT NULL THEN 'lifetime'
    WHEN s.subscription_plan = 'orbit'
     AND (s.subscription_status = 'active' OR s.subscription_period_end > now())
      THEN 'orbit'
    ELSE 'free'
  END`;

/** True when the user has a personal key for the provider they actually selected. */
const HAS_PROVIDER_KEY_SQL = `
  CASE coalesce(s.ai_provider, 'gemini')
    WHEN 'openai' THEN s.openai_api_key_encrypted IS NOT NULL
    WHEN 'anthropic' THEN s.anthropic_api_key_encrypted IS NOT NULL
    ELSE s.gemini_api_key_encrypted IS NOT NULL
  END`;

type RosterRecord = {
  user_id: string;
  email: string | null;
  created_at: string | Date;
  last_active_at: string | Date | null;
  onboarding_completed_at: string | Date | null;
  wizard_completed_at: string | Date | null;
  ai_provider: string | null;
  ai_model: string | null;
  has_provider_key: boolean;
  comped_plan: "orbit" | "lifetime" | null;
  comped_note: string | null;
  comped_at: string | Date | null;
  lifetime_purchased_at: string | Date | null;
  subscription_plan: "orbit" | null;
  subscription_status: "active" | "past_due" | "canceled" | null;
  subscription_period_end: string | Date | null;
  stripe_customer_id: string | null;
  suspended_at: string | Date | null;
  contacts: number;
  interactions: number;
  imports: number;
  chat_messages: number;
  ai_calls: number;
  ai_failures: string | number;
  in_tokens: string | number;
  out_tokens: string | number;
  cost_micros: string | number;
  first_interaction_at: string | Date | null;
  last_write_at: string | Date | null;
  total_count: string | number;
};

/** `sum(int4)` promotes to bigint, which both drivers serialize as a string. */
function num(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Raw `sql<Date>` aggregates come back as strings on PGlite and Neon alike. */
function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function maxDate(...values: Array<Date | string | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const raw of values) {
    const d = toDate(raw);
    if (!d) continue;
    if (!best || d.getTime() > best.getTime()) best = d;
  }
  return best;
}

function toRow(record: RosterRecord): AdminUserRow {
  // Plan comes from `resolvePlan` over the billing columns, NOT from PLAN_SQL. The SQL
  // expression exists only to filter; what the UI renders stays on the one implementation
  // every gate in the app already uses.
  const { plan, source } = resolvePlan({
    compedPlan: record.comped_plan,
    lifetimePurchasedAt: toDate(record.lifetime_purchased_at),
    subscriptionPlan: record.subscription_plan,
    subscriptionStatus: record.subscription_status,
    subscriptionPeriodEnd: toDate(record.subscription_period_end),
  });

  const lastWriteAt = toDate(record.last_write_at);

  return {
    userId: record.user_id,
    email: record.email,
    plan,
    planSource: source,
    compedNote: record.comped_note,
    compedAt: toDate(record.comped_at),
    subscriptionStatus: record.subscription_status,
    subscriptionPeriodEnd: toDate(record.subscription_period_end),
    lifetimePurchasedAt: toDate(record.lifetime_purchased_at),
    stripeCustomerId: record.stripe_customer_id,
    signupAt: toDate(record.created_at) ?? new Date(0),
    lastActiveAt: toDate(record.last_active_at),
    lastWriteAt,
    lastSeenAt: maxDate(record.last_active_at, lastWriteAt),
    onboardedAt: toDate(record.onboarding_completed_at),
    wizardCompletedAt: toDate(record.wizard_completed_at),
    aiProvider: record.ai_provider,
    aiModel: record.ai_model,
    hasProviderKey: Boolean(record.has_provider_key),
    suspendedAt: toDate(record.suspended_at),
    counts: {
      contacts: num(record.contacts),
      interactions: num(record.interactions),
      imports: num(record.imports),
      chatMessages: num(record.chat_messages),
      aiCalls: num(record.ai_calls),
      aiFailures: num(record.ai_failures),
    },
    aiTokens: { input: num(record.in_tokens), output: num(record.out_tokens) },
    estimatedCostMicros: num(record.cost_micros),
    firstInteractionAt: toDate(record.first_interaction_at),
  };
}

/**
 * Predicates are built as parameterised fragments and ANDed together. Nothing from
 * `searchParams` is ever concatenated into SQL text — only the sort key, which is a lookup
 * in `ORDER_BY` and can therefore only ever be one of six literal strings.
 */
function buildPredicates(query: RosterQuery) {
  const parts = [sql`true`];

  const q = query.q?.trim();
  if (q) {
    // Prefix rather than substring, so the index stays usable and the box cannot be used to
    // enumerate accounts by fragment. Matched against the user id as well as the email:
    // pasting a Clerk id — whole or partial — is the most common way this box gets used.
    const prefix = `${q.toLowerCase()}%`;
    parts.push(
      sql`(lower(coalesce(s.email, '')) LIKE ${prefix} OR lower(s.user_id) LIKE ${prefix})`
    );
  }

  const plan = query.plan ?? "all";
  if (plan === "comped") {
    parts.push(sql`s.comped_plan IS NOT NULL`);
  } else if (plan !== "all") {
    parts.push(sql`${sql.raw(PLAN_SQL)} = ${plan}`);
  }

  switch (query.state ?? "all") {
    case "no-key":
      parts.push(sql`NOT (${sql.raw(HAS_PROVIDER_KEY_SQL)})`);
      break;
    case "past-due":
      parts.push(sql`s.subscription_status = 'past_due'`);
      break;
    case "inactive":
      parts.push(sql`coalesce(agg.contacts, 0) = 0`);
      break;
    case "failing-ai":
      parts.push(
        sql`coalesce(agg.ai_failures, 0) >= 3
            AND coalesce(agg.ai_failures, 0) * 4 >= coalesce(agg.ai_calls, 0)`
      );
      break;
    case "suspended":
      parts.push(sql`s.suspended_at IS NOT NULL`);
      break;
  }

  return sql.join(parts, sql` AND `);
}

function rosterSql(query: RosterQuery, limit: number, offset: number) {
  const sort: RosterSort = isRosterSort(query.sort) ? query.sort : "signup";
  const dir = query.dir ?? DEFAULT_SORT_DIR[sort];
  const direction = dir === "asc" ? "ASC" : "DESC";

  return sql`
    WITH agg AS (
      SELECT
        u.user_id,
        max(u.contacts)          AS contacts,
        max(u.interactions)      AS interactions,
        max(u.imports)           AS imports,
        max(u.chat_messages)     AS chat_messages,
        max(u.ai_calls)          AS ai_calls,
        max(u.ai_failures)       AS ai_failures,
        max(u.in_tokens)         AS in_tokens,
        max(u.out_tokens)        AS out_tokens,
        max(u.cost_micros)       AS cost_micros,
        max(u.first_interaction_at) AS first_interaction_at,
        max(u.last_write_at)     AS last_write_at
      FROM (
        SELECT user_id, count(*)::int AS contacts, 0 AS interactions, 0 AS imports,
               0 AS chat_messages, 0 AS ai_calls, 0::bigint AS ai_failures,
               0::bigint AS in_tokens, 0::bigint AS out_tokens, 0::bigint AS cost_micros,
               NULL::timestamptz AS first_interaction_at, max(created_at) AS last_write_at
        FROM contacts GROUP BY user_id
        UNION ALL
        SELECT user_id, 0, count(*)::int, 0, 0, 0, 0::bigint, 0::bigint, 0::bigint,
               0::bigint, min(created_at), max(created_at)
        FROM interactions GROUP BY user_id
        UNION ALL
        SELECT user_id, 0, 0, count(*)::int, 0, 0, 0::bigint, 0::bigint, 0::bigint,
               0::bigint, NULL::timestamptz, max(created_at)
        FROM imports GROUP BY user_id
        UNION ALL
        SELECT user_id, 0, 0, 0, count(*)::int, 0, 0::bigint, 0::bigint, 0::bigint,
               0::bigint, NULL::timestamptz, max(created_at)
        FROM chat_messages GROUP BY user_id
        UNION ALL
        SELECT user_id, 0, 0, 0, 0, count(*)::int,
               coalesce(sum(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0),
               coalesce(sum(input_tokens), 0),
               coalesce(sum(output_tokens), 0),
               coalesce(sum(estimated_cost_micros), 0),
               NULL::timestamptz, max(created_at)
        FROM usage_events GROUP BY user_id
      ) u
      GROUP BY u.user_id
    )
    SELECT
      s.user_id, s.email, s.created_at, s.last_active_at,
      s.onboarding_completed_at, s.wizard_completed_at,
      s.ai_provider, s.ai_model,
      (${sql.raw(HAS_PROVIDER_KEY_SQL)}) AS has_provider_key,
      s.comped_plan, s.comped_note, s.comped_at,
      s.lifetime_purchased_at, s.subscription_plan, s.subscription_status,
      s.subscription_period_end, s.stripe_customer_id, s.suspended_at,
      coalesce(agg.contacts, 0)      AS contacts,
      coalesce(agg.interactions, 0)  AS interactions,
      coalesce(agg.imports, 0)       AS imports,
      coalesce(agg.chat_messages, 0) AS chat_messages,
      coalesce(agg.ai_calls, 0)      AS ai_calls,
      coalesce(agg.ai_failures, 0)   AS ai_failures,
      coalesce(agg.in_tokens, 0)     AS in_tokens,
      coalesce(agg.out_tokens, 0)    AS out_tokens,
      coalesce(agg.cost_micros, 0)   AS cost_micros,
      agg.first_interaction_at,
      agg.last_write_at,
      count(*) OVER () AS total_count
    FROM user_settings s
    LEFT JOIN agg ON agg.user_id = s.user_id
    WHERE ${buildPredicates(query)}
    ORDER BY ${sql.raw(ORDER_BY[sort])} ${sql.raw(direction)} NULLS LAST, s.user_id ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

/** One page of the roster. Filtering, sorting and paging all happen in SQL. */
export async function loadAdminRoster(
  query: RosterQuery = {}
): Promise<AdminRosterPage> {
  const db = await getDb();
  const pageSize = Math.min(Math.max(query.pageSize ?? ROSTER_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const page = Math.max(query.page ?? 1, 1);

  const result = await db.execute(rosterSql(query, pageSize, (page - 1) * pageSize));
  const records = rowsOf<RosterRecord>(result);

  // `count(*) OVER ()` rides along on every row, so the total costs no second query — but
  // it is absent when the page is empty, which is exactly when it reads as zero anyway.
  const total = records.length > 0 ? num(records[0].total_count) : 0;

  return {
    rows: records.map(toRow),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Export path: same filters, no paging, hard-capped. */
export async function loadAdminRosterAll(
  query: Omit<RosterQuery, "page" | "pageSize"> = {}
): Promise<AdminUserRow[]> {
  const db = await getDb();
  const result = await db.execute(rosterSql(query, ROSTER_EXPORT_LIMIT, 0));
  return rowsOf<RosterRecord>(result).map(toRow);
}

export type { Plan, PlanSource };
