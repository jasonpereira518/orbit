import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { usageEvents, userSettings } from "@/db/schema";
import { num, type AdminUserRow } from "@/lib/admin-metrics";
import { MONTHLY_CENTS, monthlyValueCents } from "@/lib/billing-events";
import { breakEvenSubscribers, monthStart } from "@/lib/infra-costs";

/**
 * Does each account pay for itself?
 *
 * Orbit is bootstrapped, so this is the question that matters — not "is this a venture
 * curve". And unlike almost everything else on the console it survives twelve accounts
 * intact, because every figure here is *per account* rather than a rate over a population.
 * One user's gross margin is a fact; one user's churn is noise.
 *
 * THE CORRECTION THIS MODULE EXISTS TO MAKE. The Money screen used to show total AI spend
 * as "money out". Production is strictly BYOK — `allowEnvProviderKeys()` returns
 * `!process.env.VERCEL` — so almost all of that is the *user's* bill, paid to their own
 * provider, and Orbit never sees a cent of it. The old figure was not merely incomplete;
 * it pointed the wrong way, and the bigger it got the healthier things looked.
 *
 * `usage_events.key_owner` is what makes the split possible: `"user"` is their spend,
 * `"orbit"` is ours. Only the latter is a cost to serve.
 */

/** Cents per hosted message. Rough, and labelled as such wherever it is rendered. */
const HOSTED_EMAIL_CENTS = 0.1;
const HOSTED_SMS_CENTS = 1;

export type AccountEconomics = {
  userId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  plan: AdminUserRow["plan"];
  planSource: AdminUserRow["planSource"];
  /** Recurring value this account contributes each month, in cents. */
  revenueCents: number;
  /** AI Orbit paid for on its own keys. Zero for every BYOK account, which is most. */
  aiCostCents: number;
  /** Hosted email and SMS, estimated from send counts. */
  sendCostCents: number;
  costCents: number;
  marginCents: number;
  /** Their own AI spend. Not a cost to Orbit — shown so the split is visible. */
  byokCostCents: number;
};

/**
 * Micros (millionths of a dollar) to cents, keeping two decimal places OF A CENT.
 *
 * The sub-cent precision is load-bearing rather than fussy: a single Gemini Flash call
 * costs well under a cent, so rounding to whole cents would report almost every account's
 * AI cost as exactly zero and make the whole column look like there was nothing to see.
 */
function microsToCents(micros: number): number {
  return Math.round(micros / 100) / 100;
}

/**
 * Per-account revenue, cost and margin, worst first.
 *
 * SORTED ASCENDING ON PURPOSE — the accounts losing money sort to the top, which is the
 * only ordering that makes this screen worth opening. Expect comped Orbit Pro accounts to
 * lead: comping Lifetime costs Orbit nothing (`canUseHostedSends: false`, no seat), while
 * comping Pro spends Orbit's own Resend, Twilio and Apollo credits. The comp dialog
 * documents that asymmetry; this is the first screen that makes it visible.
 */
export async function accountEconomics(
  rows: AdminUserRow[],
  now: Date = new Date()
): Promise<AccountEconomics[]> {
  const db = await getDb();

  // Both scans in one wave. They share nothing, and each is a separate HTTPS request on
  // Neon HTTP, so running them in sequence doubled this function's latency for free.
  const [aiRows, sendRows] = await Promise.all([
    // Split AI spend by whose key paid for it. One grouped scan, joined in JS — the same
    // shape every other admin aggregate uses.
    db
      .select({
        userId: usageEvents.userId,
        keyOwner: usageEvents.keyOwner,
        costMicros: sql<string>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)`,
      })
      .from(usageEvents)
      .groupBy(usageEvents.userId, usageEvents.keyOwner),
    // Hosted sends. `outreach_messages` has no `user_id` — it hangs off a prospect, which
    // hangs off a campaign — so the owner comes through the join rather than off the row.
    db.execute(sql`
      SELECT c.user_id AS user_id,
             m.channel  AS channel,
             count(*)::int AS n
      FROM outreach_messages m
      JOIN outreach_prospects p ON p.id = m.prospect_id
      JOIN outreach_campaigns c ON c.id = p.campaign_id
      WHERE m.status = 'sent'
      GROUP BY c.user_id, m.channel
    `),
  ]);

  const orbitAi = new Map<string, number>();
  const userAi = new Map<string, number>();
  for (const r of aiRows) {
    const target = r.keyOwner === "orbit" ? orbitAi : userAi;
    target.set(r.userId, (target.get(r.userId) ?? 0) + num(r.costMicros));
  }

  const sendCost = new Map<string, number>();
  const sendList = Array.isArray(sendRows)
    ? sendRows
    : ((sendRows as { rows?: unknown[] }).rows ?? []);
  for (const raw of sendList as Array<{
    user_id: string;
    channel: string;
    n: number;
  }>) {
    const perMessage =
      raw.channel === "sms" ? HOSTED_SMS_CENTS : HOSTED_EMAIL_CENTS;
    sendCost.set(
      raw.user_id,
      (sendCost.get(raw.user_id) ?? 0) + num(raw.n) * perMessage
    );
  }

  return rows
    .map((row): AccountEconomics => {
      // A comp pays nothing however the billing columns read. Counting comped accounts as
      // revenue is the single easiest way to make this screen say the opposite of the truth.
      const revenueCents =
        row.planSource === "comp"
          ? 0
          : monthlyValueCents(
              row.subscriptionStatus,
              row.subscriptionPeriodEnd,
              now
            );

      const aiCostCents = microsToCents(orbitAi.get(row.userId) ?? 0);
      const sendCostCents = Math.round((sendCost.get(row.userId) ?? 0) * 100) / 100;
      const costCents = aiCostCents + sendCostCents;

      return {
        userId: row.userId,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        plan: row.plan,
        planSource: row.planSource,
        revenueCents,
        aiCostCents,
        sendCostCents,
        costCents,
        marginCents: revenueCents - costCents,
        byokCostCents: microsToCents(userAi.get(row.userId) ?? 0),
      };
    })
    .sort((a, b) => a.marginCents - b.marginCents);
}

export type Concentration = {
  topShareOfRevenue: number | null;
  topShareOfUsage: number | null;
  topRevenueUser: string | null;
  topUsageUser: string | null;
};

/**
 * How much of Orbit rests on one person.
 *
 * The most honest risk metric available at this size, and one of the few that a small n
 * makes MORE meaningful rather than less: if a single account is 80% of activity, then the
 * retention curve, the feature-adoption table and the roadmap are all a story about one
 * person, and every other number on the console should be read in that light.
 *
 * Null when there is nothing to divide — a share of zero revenue is not 0%, it is undefined,
 * and rendering it as 0% would read as "no concentration risk" rather than "no revenue".
 */
export function concentration(rows: AccountEconomics[]): Concentration {
  const totalRevenue = rows.reduce((a, r) => a + r.revenueCents, 0);
  const totalUsage = rows.reduce((a, r) => a + r.aiCostCents + r.byokCostCents, 0);

  const topRevenue = [...rows].sort((a, b) => b.revenueCents - a.revenueCents)[0];
  const topUsage = [...rows].sort(
    (a, b) => b.aiCostCents + b.byokCostCents - (a.aiCostCents + a.byokCostCents)
  )[0];

  return {
    topShareOfRevenue:
      totalRevenue > 0 && topRevenue
        ? Math.round((topRevenue.revenueCents / totalRevenue) * 100)
        : null,
    topShareOfUsage:
      totalUsage > 0 && topUsage
        ? Math.round(
            ((topUsage.aiCostCents + topUsage.byokCostCents) / totalUsage) * 100
          )
        : null,
    topRevenueUser: totalRevenue > 0 ? (topRevenue?.userId ?? null) : null,
    topUsageUser: totalUsage > 0 ? (topUsage?.userId ?? null) : null,
  };
}

export type UnitEconomics = {
  accounts: AccountEconomics[];
  mrrCents: number;
  /** Orbit's own variable cost across all accounts. */
  variableCostCents: number;
  /** What users paid their own providers. Never Orbit's money. */
  byokCostCents: number;
  fixedCostCents: number;
  /** Revenue minus every cost Orbit actually bears. */
  netCents: number;
  contributionPerSubscriberCents: number;
  breakEvenSubscribers: number | null;
  payingCount: number;
  compedCount: number;
  concentration: Concentration;
  /** True when no infra cost has been entered for this month. */
  fixedCostMissing: boolean;
};

export async function getUnitEconomics(
  rows: AdminUserRow[],
  now: Date = new Date()
): Promise<UnitEconomics> {
  const accounts = await accountEconomics(rows, now);

  const db = await getDb();
  const start = monthStart(now);
  const fixed = await db
    .select({ total: sql<string>`coalesce(sum(amount_cents), 0)`, n: sql<string>`count(*)` })
    .from(sql`infra_costs`)
    .where(sql`period_month = ${start}`);

  const fixedCostCents = num(fixed[0]?.total);
  const fixedCostMissing = num(fixed[0]?.n) === 0;

  const mrrCents = accounts.reduce((a, r) => a + r.revenueCents, 0);
  const variableCostCents = accounts.reduce((a, r) => a + r.costCents, 0);
  const byokCostCents = accounts.reduce((a, r) => a + r.byokCostCents, 0);
  const payingCount = accounts.filter((r) => r.revenueCents > 0).length;

  // Per-subscriber contribution, not per-account: the free accounts are the thing the
  // paying ones have to cover, so averaging their zero revenue in would flatter the number
  // and understate how many subscribers break-even actually needs.
  const variableFromPayers = accounts
    .filter((r) => r.revenueCents > 0)
    .reduce((a, r) => a + r.costCents, 0);
  const contributionPerSubscriberCents =
    payingCount > 0
      ? Math.round((mrrCents - variableFromPayers) / payingCount)
      : MONTHLY_CENTS;

  return {
    accounts,
    mrrCents,
    variableCostCents,
    byokCostCents,
    fixedCostCents,
    netCents: mrrCents - variableCostCents - fixedCostCents,
    contributionPerSubscriberCents,
    breakEvenSubscribers: breakEvenSubscribers(
      fixedCostCents,
      contributionPerSubscriberCents
    ),
    payingCount,
    compedCount: accounts.filter((r) => r.planSource === "comp").length,
    concentration: concentration(accounts),
    fixedCostMissing,
  };
}

/**
 * Does the ledger agree with live subscription state?
 *
 * Two independent derivations of MRR: this sums the movements recorded by the webhook, and
 * `getUnitEconomics` reads what the subscription columns say today. They should match.
 * **When they do not, a billing webhook was dropped** — a failure Orbit has already had
 * once, and one that nothing else on the console would ever surface, because each number
 * looks entirely reasonable on its own.
 */
export async function mrrReconciliation(now: Date = new Date()): Promise<{
  ledgerCents: number;
  liveCents: number;
  driftCents: number;
  agrees: boolean;
}> {
  const db = await getDb();

  // The two derivations are independent by design — that is the whole point of
  // reconciling them — so there is no reason to wait for one before starting the other.
  const [ledger, settings] = await Promise.all([
    db
      .select({ total: sql<string>`coalesce(sum(mrr_delta_cents), 0)` })
      .from(sql`billing_events`),
    db
      .select({
        status: userSettings.subscriptionStatus,
        periodEnd: userSettings.subscriptionPeriodEnd,
        plan: userSettings.subscriptionPlan,
        comped: userSettings.compedPlan,
      })
      .from(userSettings),
  ]);
  const ledgerCents = num(ledger[0]?.total);

  const liveCents = settings.reduce((total, r) => {
    if (r.comped) return total;
    if (r.plan !== "orbit") return total;
    return total + monthlyValueCents(r.status, r.periodEnd, now);
  }, 0);

  return {
    ledgerCents,
    liveCents,
    driftCents: liveCents - ledgerCents,
    agrees: liveCents === ledgerCents,
  };
}

/** Formats cents as dollars. Two places, because unlike plan prices these are not round. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
