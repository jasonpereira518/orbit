import { desc, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  chatMessages,
  contacts,
  imports,
  interactions,
  usageEvents,
  userSettings,
} from "@/db/schema";
import {
  FREE_CONTACT_LIMIT,
  resolvePlan,
  type Plan,
  type PlanSource,
} from "@/lib/entitlements";

/**
 * Cross-user reads for the admin console. The only module in the codebase that queries
 * without a `user_id` filter, apart from the shared recruiters directory.
 *
 * Shape of the whole thing: one six-query fan-out builds a per-user rollup, and the
 * roster, funnel, alerts and most totals are plain JS reductions over that single dataset.
 * Six `GROUP BY user_id` scans are constant in user count, which is what keeps this from
 * being an N+1.
 */

export type AdminUserRow = {
  userId: string;
  email: string | null;
  plan: Plan;
  planSource: PlanSource;
  compedNote: string | null;
  compedAt: Date | null;
  subscriptionStatus: "active" | "past_due" | "canceled" | null;
  subscriptionPeriodEnd: Date | null;
  lifetimePurchasedAt: Date | null;
  stripeCustomerId: string | null;
  signupAt: Date;
  /** Column value; null for accounts predating it. Prefer `lastSeenAt`. */
  lastActiveAt: Date | null;
  /** Derived from write timestamps; works retroactively over all history. */
  lastWriteAt: Date | null;
  /** What the UI should show: the column when present, else the derived value. */
  lastSeenAt: Date | null;
  onboardedAt: Date | null;
  wizardCompletedAt: Date | null;
  aiProvider: string | null;
  aiModel: string | null;
  /** Whether a personal key exists for the provider the user actually selected. */
  hasProviderKey: boolean;
  counts: {
    contacts: number;
    interactions: number;
    imports: number;
    chatMessages: number;
    aiCalls: number;
    aiFailures: number;
  };
  aiTokens: { input: number; output: number };
  estimatedCostMicros: number;
  firstInteractionAt: Date | null;
};

/** `count(*)::int` comes back as a number. */
const countInt = sql<number>`count(*)::int`;

/**
 * `sum(int4)` promotes to bigint, which the drivers serialize as a *string* to avoid
 * precision loss. Typing it as a number and adding it would silently concatenate
 * ("0" + 5 === "05"), so every sum is read as a string and coerced at the join.
 *
 * Deliberately not cast to ::int — token totals will outgrow int4.
 */
function num(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Drizzle only parses columns it maps; a raw `sql<Date>` expression such as `max(...)`
 * comes back as whatever the driver produced — a string on both PGlite and Neon. Every
 * aggregate timestamp goes through here, or `.getTime()` throws at runtime.
 */
function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function maxDate(
  ...dates: Array<Date | string | null | undefined>
): Date | null {
  let best: Date | null = null;
  for (const raw of dates) {
    const d = toDate(raw);
    if (!d) continue;
    if (!best || d.getTime() > best.getTime()) best = d;
  }
  return best;
}

/**
 * The fan-out. Six aggregate queries, joined by userId in JS.
 *
 * Note what is deliberately NOT here: `getEntitlements(userId)` per row. That helper calls
 * `ensureUserSettings`, which is a SELECT *and a possible INSERT* per user — an N+1 that
 * would create rows as a side effect of reading a dashboard. `resolvePlan` is a pure
 * function over billing columns already fetched, which is exactly why the paywall split
 * the two apart.
 */
export async function loadAdminUserRows(): Promise<AdminUserRow[]> {
  const db = await getDb();

  const [settingsRows, contactAgg, interactionAgg, importAgg, chatAgg, usageAgg] =
    await Promise.all([
      db
        .select({
          userId: userSettings.userId,
          email: userSettings.email,
          createdAt: userSettings.createdAt,
          lastActiveAt: userSettings.lastActiveAt,
          onboardingCompletedAt: userSettings.onboardingCompletedAt,
          wizardCompletedAt: userSettings.wizardCompletedAt,
          aiProvider: userSettings.aiProvider,
          aiModel: userSettings.aiModel,
          // Presence booleans only. The encrypted blobs must never be selected into an
          // admin surface, let alone decrypted.
          hasGemini: sql<boolean>`${userSettings.geminiApiKeyEncrypted} is not null`,
          hasOpenai: sql<boolean>`${userSettings.openaiApiKeyEncrypted} is not null`,
          hasAnthropic: sql<boolean>`${userSettings.anthropicApiKeyEncrypted} is not null`,
          compedPlan: userSettings.compedPlan,
          compedNote: userSettings.compedNote,
          compedAt: userSettings.compedAt,
          lifetimePurchasedAt: userSettings.lifetimePurchasedAt,
          subscriptionPlan: userSettings.subscriptionPlan,
          subscriptionStatus: userSettings.subscriptionStatus,
          subscriptionPeriodEnd: userSettings.subscriptionPeriodEnd,
          stripeCustomerId: userSettings.stripeCustomerId,
        })
        .from(userSettings)
        .orderBy(desc(userSettings.createdAt)),

      db
        .select({
          userId: contacts.userId,
          n: countInt,
          lastAt: sql<string | null>`max(${contacts.createdAt})`,
        })
        .from(contacts)
        .groupBy(contacts.userId),

      db
        .select({
          userId: interactions.userId,
          n: countInt,
          // `created_at`, never `interaction_date`: the latter is backdated by LinkedIn
          // and calendar imports, which would smear recent-activity windows across years.
          firstAt: sql<string | null>`min(${interactions.createdAt})`,
          lastAt: sql<string | null>`max(${interactions.createdAt})`,
        })
        .from(interactions)
        .groupBy(interactions.userId),

      db
        .select({
          userId: imports.userId,
          n: countInt,
          lastAt: sql<string | null>`max(${imports.createdAt})`,
        })
        .from(imports)
        .groupBy(imports.userId),

      db
        .select({
          userId: chatMessages.userId,
          n: countInt,
          lastAt: sql<string | null>`max(${chatMessages.createdAt})`,
        })
        .from(chatMessages)
        .groupBy(chatMessages.userId),

      db
        .select({
          userId: usageEvents.userId,
          n: countInt,
          failures: sql<string>`coalesce(sum(case when ${usageEvents.success} = 0 then 1 else 0 end), 0)`,
          inTok: sql<string>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
          outTok: sql<string>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
          costMicros: sql<string>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)`,
          lastAt: sql<string | null>`max(${usageEvents.createdAt})`,
        })
        .from(usageEvents)
        .groupBy(usageEvents.userId),
    ]);

  const byUser = <T extends { userId: string }>(rows: T[]) =>
    new Map(rows.map((r) => [r.userId, r]));

  const contactsBy = byUser(contactAgg);
  const interactionsBy = byUser(interactionAgg);
  const importsBy = byUser(importAgg);
  const chatBy = byUser(chatAgg);
  const usageBy = byUser(usageAgg);

  return settingsRows.map((row): AdminUserRow => {
    const c = contactsBy.get(row.userId);
    const i = interactionsBy.get(row.userId);
    const im = importsBy.get(row.userId);
    const ch = chatBy.get(row.userId);
    const u = usageBy.get(row.userId);

    const { plan, source } = resolvePlan(row);

    const lastWriteAt = maxDate(
      c?.lastAt,
      i?.lastAt,
      im?.lastAt,
      ch?.lastAt,
      u?.lastAt
    );

    // A personal key for the provider the user actually selected. Someone set to
    // Anthropic with only a Gemini key configured still cannot run a capture.
    const provider = row.aiProvider ?? "gemini";
    const hasProviderKey =
      provider === "openai"
        ? row.hasOpenai
        : provider === "anthropic"
          ? row.hasAnthropic
          : row.hasGemini;

    return {
      userId: row.userId,
      email: row.email,
      plan,
      planSource: source,
      compedNote: row.compedNote,
      compedAt: row.compedAt,
      subscriptionStatus: row.subscriptionStatus,
      subscriptionPeriodEnd: row.subscriptionPeriodEnd,
      lifetimePurchasedAt: row.lifetimePurchasedAt,
      stripeCustomerId: row.stripeCustomerId,
      signupAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      lastWriteAt,
      lastSeenAt: maxDate(row.lastActiveAt, lastWriteAt),
      onboardedAt: row.onboardingCompletedAt,
      wizardCompletedAt: row.wizardCompletedAt,
      aiProvider: row.aiProvider,
      aiModel: row.aiModel,
      hasProviderKey,
      counts: {
        contacts: c?.n ?? 0,
        interactions: i?.n ?? 0,
        imports: im?.n ?? 0,
        chatMessages: ch?.n ?? 0,
        aiCalls: u?.n ?? 0,
        aiFailures: num(u?.failures),
      },
      aiTokens: { input: num(u?.inTok), output: num(u?.outTok) },
      estimatedCostMicros: num(u?.costMicros),
      firstInteractionAt: toDate(i?.firstAt),
    };
  });
}

/* ------------------------------------------------------------------------------------
 * Reductions over the rollup
 * --------------------------------------------------------------------------------- */

/**
 * Mirrors `needsOnboarding` (`src/lib/onboarding.ts`), which treats "has any contact or
 * import" as onboarded even when `onboarding_completed_at` is null — it backfills the
 * column later via `after()`. A naive `IS NOT NULL` check would undercount every account
 * that predates that backfill.
 */
function isOnboarded(row: AdminUserRow): boolean {
  return (
    row.onboardedAt != null || row.counts.contacts > 0 || row.counts.imports > 0
  );
}

export type FunnelStage = { label: string; count: number };

export function buildFunnel(rows: AdminUserRow[]): FunnelStage[] {
  return [
    { label: "Signed up", count: rows.length },
    { label: "Onboarded", count: rows.filter(isOnboarded).length },
    {
      label: "Finished wizard",
      count: rows.filter((r) => r.wizardCompletedAt != null).length,
    },
    {
      label: "First contact",
      count: rows.filter((r) => r.counts.contacts > 0).length,
    },
    {
      label: "First interaction",
      count: rows.filter((r) => r.counts.interactions > 0).length,
    },
    {
      label: "10+ contacts",
      count: rows.filter((r) => r.counts.contacts >= 10).length,
    },
  ];
}

export type PlanBreakdown = {
  free: number;
  comped: number;
  lifetime: number;
  subscribed: number;
  paidTotal: number;
};

/**
 * Comped, lifetime and subscribed are kept apart on purpose. Comps are currently the only
 * thing that writes a paid plan — a merged "paying customers" number would flatter itself.
 */
export function buildPlanBreakdown(rows: AdminUserRow[]): PlanBreakdown {
  const comped = rows.filter((r) => r.planSource === "comp").length;
  const lifetime = rows.filter((r) => r.planSource === "lifetime").length;
  const subscribed = rows.filter((r) => r.planSource === "subscription").length;
  return {
    free: rows.filter((r) => r.plan === "free").length,
    comped,
    lifetime,
    subscribed,
    paidTotal: comped + lifetime + subscribed,
  };
}

export type AdminAlert = {
  severity: "warn" | "opportunity";
  userId: string;
  email: string | null;
  message: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The triage queue — the reason the overview screen exists.
 *
 * Ordered warnings first, then upgrade opportunities. Every entry names a person and a
 * reason, and links into their inspector.
 */
export function buildAlerts(
  rows: AdminUserRow[],
  now = new Date()
): AdminAlert[] {
  const alerts: AdminAlert[] = [];
  const ts = now.getTime();

  for (const row of rows) {
    const who = { userId: row.userId, email: row.email };

    if (row.subscriptionStatus === "past_due") {
      alerts.push({
        ...who,
        severity: "warn",
        message: "Subscription is past due",
      });
    }

    // Billing drift, detected without a single Clerk API call. An active subscription
    // always receives a renewal event pushing `period_end` forward, so a live status with
    // a past-dated period means a webhook was dropped — and nothing else in the system
    // would ever notice. `webhook_deliveries` shows which one; this shows that it happened.
    if (
      row.subscriptionStatus === "active" &&
      row.subscriptionPeriodEnd &&
      row.subscriptionPeriodEnd.getTime() < ts
    ) {
      alerts.push({
        ...who,
        severity: "warn",
        message: `Subscription says active but paid through ${row.subscriptionPeriodEnd
          .toISOString()
          .slice(0, 10)} — a Clerk webhook was probably missed`,
      });
    }

    // The highest-value signal in the console. Production is strictly BYOK, so an account
    // with no key for its selected provider hits a hard error on its first capture. This
    // is a conversion bug, surfaced as a metric.
    if (!row.hasProviderKey && isOnboarded(row)) {
      alerts.push({
        ...who,
        severity: "warn",
        message: `No ${row.aiProvider ?? "AI"} key configured — AI features will fail`,
      });
    }

    if (row.counts.aiFailures > 0 && row.counts.aiCalls > 0) {
      const rate = row.counts.aiFailures / row.counts.aiCalls;
      if (rate >= 0.25 && row.counts.aiFailures >= 3) {
        alerts.push({
          ...who,
          severity: "warn",
          message: `${row.counts.aiFailures} of ${row.counts.aiCalls} AI calls failing`,
        });
      }
    }

    if (
      row.subscriptionStatus === "canceled" &&
      row.subscriptionPeriodEnd &&
      row.subscriptionPeriodEnd.getTime() > ts &&
      row.subscriptionPeriodEnd.getTime() - ts < 7 * DAY_MS
    ) {
      alerts.push({
        ...who,
        severity: "opportunity",
        message: "Canceled — access ends within 7 days",
      });
    }

    // Doubles as the upgrade-prospect list, which at this scale is worth more than any
    // conversion funnel.
    if (row.plan === "free" && row.counts.contacts >= FREE_CONTACT_LIMIT) {
      alerts.push({
        ...who,
        severity: "opportunity",
        message: `At the ${FREE_CONTACT_LIMIT}-contact free cap`,
      });
    }

    if (!isOnboarded(row) && ts - row.signupAt.getTime() > 3 * DAY_MS) {
      alerts.push({
        ...who,
        severity: "opportunity",
        message: "Signed up 3+ days ago, never onboarded",
      });
    }
  }

  return alerts.sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1
  );
}

export type WindowCount = { current: number; previous: number };

/** Counts rows created in the last `days`, and in the equal window before it. */
export function windowCount(
  dates: Array<Date | null | undefined>,
  days: number,
  now = new Date()
): WindowCount {
  const ts = now.getTime();
  const since = ts - days * DAY_MS;
  const prevSince = since - days * DAY_MS;

  let current = 0;
  let previous = 0;
  for (const d of dates) {
    if (!d) continue;
    const t = d.getTime();
    if (t >= since) current += 1;
    else if (t >= prevSince) previous += 1;
  }
  return { current, previous };
}

export type AdminOverview = {
  rows: AdminUserRow[];
  totalUsers: number;
  plans: PlanBreakdown;
  funnel: FunnelStage[];
  alerts: AdminAlert[];
  signups: WindowCount;
  activeLast7d: number;
  activeLast30d: number;
  /** Contacts, interactions etc. summed across every account. */
  totals: {
    contacts: number;
    interactions: number;
    imports: number;
    chatMessages: number;
    aiCalls: number;
  };
  /** Accounts that cannot use AI at all because no key is set for their provider. */
  missingKeyCount: number;
};

export async function getAdminOverview(now = new Date()): Promise<AdminOverview> {
  const rows = await loadAdminUserRows();
  const ts = now.getTime();

  const activeSince = (days: number) =>
    rows.filter(
      (r) => r.lastSeenAt && ts - r.lastSeenAt.getTime() <= days * DAY_MS
    ).length;

  const sum = (pick: (r: AdminUserRow) => number) =>
    rows.reduce((acc, r) => acc + pick(r), 0);

  return {
    rows,
    totalUsers: rows.length,
    plans: buildPlanBreakdown(rows),
    funnel: buildFunnel(rows),
    alerts: buildAlerts(rows, now),
    signups: windowCount(
      rows.map((r) => r.signupAt),
      30,
      now
    ),
    activeLast7d: activeSince(7),
    activeLast30d: activeSince(30),
    totals: {
      contacts: sum((r) => r.counts.contacts),
      interactions: sum((r) => r.counts.interactions),
      imports: sum((r) => r.counts.imports),
      chatMessages: sum((r) => r.counts.chatMessages),
      aiCalls: sum((r) => r.counts.aiCalls),
    },
    missingKeyCount: rows.filter((r) => !r.hasProviderKey).length,
  };
}

/**
 * Subscriptions worth a second look: past due, or canceled with paid-through time left.
 *
 * `now` defaults here rather than in the page so callers never have to evaluate
 * `Date.now()` inside a component body (React's purity rule, and a real staleness hazard).
 */
export function subscriptionsNeedingAttention(
  rows: AdminUserRow[],
  now = new Date()
): AdminUserRow[] {
  const ts = now.getTime();
  return rows.filter(
    (r) =>
      r.subscriptionStatus === "past_due" ||
      (r.subscriptionStatus === "canceled" &&
        (r.subscriptionPeriodEnd?.getTime() ?? 0) > ts)
  );
}
