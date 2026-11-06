import { and, eq, gt, gte, lt, sql, type AnyColumn } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { billingEvents, creditGrants, usageEvents, userSettings } from "@/db/schema";
import { managedCostSql } from "@/lib/ai-access";
import { internalAccountSql } from "@/lib/analytics-internal";
import { MICROS_PER_CREDIT } from "@/lib/credits/grants";
import { speechMicrosSql } from "@/lib/money-costs";
import type { Plan } from "@/lib/plans/plan-config";

/**
 * The Money section's view of credits (pricing v2): packs as one-time revenue, what the
 * unused pack credits are worth as a liability, how much of the included allowance is being
 * used, what managed AI actually cost, and whether the ledger and the grants agree.
 *
 * Read-only. Every figure here is derived from the grant rows and `usage_events`; nothing is
 * cached, because the screen is visited rarely and a stale liability is worse than a slow one.
 *
 * Internal / tester accounts (`internalAccountSql`) are left out of every total here: a pack
 * the operator bought to test checkout is not revenue, a liability, or a top spender.
 */

function num(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export type CreditsMoney = {
  packs: {
    /** Packs sold in the window, and the cash they brought in (before any refund). */
    soldInWindow: number;
    cashInWindowCents: number;
    soldAllTime: number;
    /** Packs whose unused credits were taken back after a refund or a lost dispute. */
    revokedAllTime: number;
  };
  liability: {
    /** Unused credits on live packs, and what the buyers paid for them, pro rata. */
    unusedCredits: number;
    cents: number;
    /** The part of it held by accounts no longer on Pro or Max: frozen, not spendable. */
    frozenCents: number;
  };
  allowance: {
    /** Allowance grants whose period covers now: credits granted and credits used. */
    accounts: number;
    grantedCredits: number;
    usedCredits: number;
  };
  managedAi: {
    /**
     * Real model cost on Orbit's keys in the window: `managedCostSql()`, the one definition
     * the credit cap, the ops sweep and the Runway burn all share. Deepgram is NOT in it.
     */
    costMicros: number;
    /** Deepgram dollars in the window, priced from `speech_usage` seconds (kept apart: it is not credit-settled). */
    deepgramMicros: number;
    calls: number;
    accounts: number;
    /** Ranked by model cost plus Deepgram, so voice-heavy accounts show up. */
    topSpenders: Array<{ userId: string; micros: number; calls: number }>;
  };
  reconciliation: {
    /**
     * `credit_pack` ledger rows vs pack grants, which are written by the same webhook from the
     * same checkout session. (A pack's refund books an ordinary `refund` row, so revocations
     * are reported, not reconciled.)
     */
    packsBooked: number;
    packGrants: number;
    ok: boolean;
  };
};

/**
 * @param spendablePlanUsers accounts on a plan whose packs are spendable (every plan but
 *   Lifetime) — pack credits anywhere else are frozen (derived, never written), so the
 *   liability splits on this set.
 */
export async function loadCreditsMoney(
  spendablePlanUsers: ReadonlySet<string>,
  days = 30,
  now = new Date()
): Promise<CreditsMoney> {
  const db = await getDb();
  const since = new Date(now.getTime() - days * 86_400_000);

  const [packLedger, livePacks, packCounts, allowance, managed, topSpenders, speech] = await Promise.all([
    db
      .select({
        kind: billingEvents.kind,
        n: sql<string>`count(*)`,
        inWindow: sql<string>`count(*) FILTER (WHERE ${billingEvents.effectiveAt} >= ${since})`,
        cashInWindow: sql<string>`coalesce(sum(${billingEvents.amountCents}) FILTER (WHERE ${billingEvents.effectiveAt} >= ${since}), 0)`,
      })
      .from(billingEvents)
      .where(and(eq(billingEvents.kind, "credit_pack"), notInternal(billingEvents.userId)))
      .groupBy(billingEvents.kind),
    db
      .select({
        userId: creditGrants.userId,
        granted: creditGrants.microsGranted,
        remaining: creditGrants.microsRemaining,
        amountCents: creditGrants.amountCents,
      })
      .from(creditGrants)
      .where(
        and(
          eq(creditGrants.kind, "pack"),
          eq(creditGrants.status, "active"),
          gt(creditGrants.microsRemaining, 0),
          notInternal(creditGrants.userId)
        )
      ),
    db
      .select({
        total: sql<string>`count(*)`,
        revoked: sql<string>`count(*) FILTER (WHERE ${creditGrants.status} = 'revoked')`,
      })
      .from(creditGrants)
      .where(and(eq(creditGrants.kind, "pack"), notInternal(creditGrants.userId))),
    db
      .select({
        accounts: sql<string>`count(DISTINCT ${creditGrants.userId})`,
        granted: sql<string>`coalesce(sum(${creditGrants.microsGranted}), 0)`,
        remaining: sql<string>`coalesce(sum(${creditGrants.microsRemaining}), 0)`,
      })
      .from(creditGrants)
      .where(
        and(
          eq(creditGrants.kind, "allowance"),
          sql`${creditGrants.periodStart} <= ${now}`,
          sql`${creditGrants.periodEnd} > ${now}`,
          notInternal(creditGrants.userId)
        )
      ),
    db
      .select({
        micros: sql<string>`coalesce(sum(${managedCostSql()}), 0)::bigint`,
        calls: sql<string>`count(*)`,
        accounts: sql<string>`count(DISTINCT ${usageEvents.userId})`,
      })
      .from(usageEvents)
      .where(managedWindow(since, undefined, false)),
    // Model cost plus Deepgram per account in one ranking. `speech_usage` is unaliased because
    // `speechMicrosSql()` qualifies its columns with the table name.
    db.execute(sql`
      SELECT t.user_id, sum(t.micros)::bigint AS micros, sum(t.calls)::int AS calls
      FROM (
        SELECT usage_events.user_id, ${managedCostSql()}::bigint AS micros, 1 AS calls
        FROM usage_events
        WHERE ${managedWindow(since, undefined, false)}
        UNION ALL
        SELECT speech_usage.user_id, round(${speechMicrosSql()})::bigint, 0
        FROM speech_usage
        WHERE speech_usage.created_at >= ${since}
          AND NOT ${internalAccountSql(sql`speech_usage.user_id`)}
      ) t
      GROUP BY t.user_id
      ORDER BY sum(t.micros) DESC, t.user_id
      LIMIT 10
    `),
    db.execute(sql`
      SELECT round(coalesce(sum(${speechMicrosSql()}), 0))::bigint AS micros
      FROM speech_usage
      WHERE speech_usage.created_at >= ${since}
        AND NOT ${internalAccountSql(sql`speech_usage.user_id`)}
    `),
  ]);

  const booked = packLedger[0];

  let unusedMicros = 0;
  let liabilityCents = 0;
  let frozenCents = 0;
  for (const pack of livePacks) {
    unusedMicros += pack.remaining;
    // Priced at what the buyer paid for the unused share, not at list: a refund of this
    // pack would return exactly that.
    const cents = pack.granted > 0 ? ((pack.amountCents ?? 0) * pack.remaining) / pack.granted : 0;
    liabilityCents += cents;
    if (!pack.userId || !spendablePlanUsers.has(pack.userId)) frozenCents += cents;
  }

  const packsBooked = num(booked?.n);
  const packGrants = num(packCounts[0]?.total);
  const packsRevoked = num(packCounts[0]?.revoked);
  const grantedMicros = num(allowance[0]?.granted);

  return {
    packs: {
      soldInWindow: num(booked?.inWindow),
      cashInWindowCents: num(booked?.cashInWindow),
      soldAllTime: packsBooked,
      revokedAllTime: packsRevoked,
    },
    liability: {
      unusedCredits: Math.round(unusedMicros / MICROS_PER_CREDIT),
      cents: Math.round(liabilityCents),
      frozenCents: Math.round(frozenCents),
    },
    allowance: {
      accounts: num(allowance[0]?.accounts),
      grantedCredits: Math.round(grantedMicros / MICROS_PER_CREDIT),
      usedCredits: Math.round((grantedMicros - num(allowance[0]?.remaining)) / MICROS_PER_CREDIT),
    },
    managedAi: {
      costMicros: num(managed[0]?.micros),
      deepgramMicros: num(rowsOf<{ micros: string }>(speech)[0]?.micros),
      calls: num(managed[0]?.calls),
      accounts: num(managed[0]?.accounts),
      topSpenders: rowsOf<{ user_id: string; micros: string; calls: number }>(topSpenders).map((r) => ({
        userId: r.user_id,
        micros: num(r.micros),
        calls: num(r.calls),
      })),
    },
    reconciliation: {
      packsBooked,
      packGrants,
      ok: packsBooked === packGrants,
    },
  };
}

/** `NOT internal` for a drizzle column (`user_id`), as a where-clause term. */
function notInternal(column: AnyColumn) {
  return sql`NOT ${internalAccountSql(sql`${column}`)}`;
}

/**
 * The managed-AI window: Orbit's keys, Deepgram rows excluded (they are metered by
 * `speech_usage` and never settled against credits), `created_at` in `[since, until)`.
 * `includeInternal` keeps the operator's own accounts for the one caller that wants real
 * spend rather than customer cost (the Runway burn).
 */
function managedWindow(since: Date, until: Date | undefined, includeInternal: boolean) {
  return and(
    eq(usageEvents.keyOwner, "orbit"),
    sql`${usageEvents.provider} <> 'deepgram'`,
    gte(usageEvents.createdAt, since),
    until ? lt(usageEvents.createdAt, until) : undefined,
    includeInternal ? undefined : notInternal(usageEvents.userId)
  );
}

/**
 * Model cost on Orbit's keys over the trailing window, in micros — THE managed-AI cost.
 *
 * One definition: `managedCostSql()` (a priced call at its price, an unpriced successful call
 * at the pessimistic stand-in, a failed one at 0) on Orbit's keys with Deepgram excluded. The
 * credit cap, the ops sweep's margin alert, the Costs and Money screens and the Runway burn
 * all read this number; Deepgram is added beside it, never inside it (audit M5).
 *
 * By default it is what CUSTOMERS cost, so internal / tester accounts are left out. The
 * Runway burn passes `includeInternal`: the operator's own dogfooding is real cash.
 */
export async function managedAiCostMicros(
  days = 30,
  now = new Date(),
  opts: { includeInternal?: boolean } = {}
): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ micros: sql<string>`coalesce(sum(${managedCostSql()}), 0)::bigint` })
    .from(usageEvents)
    .where(managedWindow(new Date(now.getTime() - days * 86_400_000), undefined, opts.includeInternal ?? false));
  return num(row?.micros);
}

/** Deepgram spend over the trailing window, priced from `speech_usage`; same internal rule as above. */
export async function deepgramCostMicros(
  days = 30,
  now = new Date(),
  opts: { includeInternal?: boolean } = {}
): Promise<number> {
  const db = await getDb();
  const since = new Date(now.getTime() - days * 86_400_000);
  const result = await db.execute(sql`
    SELECT round(coalesce(sum(${speechMicrosSql()}), 0))::bigint AS micros
    FROM speech_usage
    WHERE speech_usage.created_at >= ${since}
      ${opts.includeInternal ? sql`` : sql`AND NOT ${internalAccountSql(sql`speech_usage.user_id`)}`}
  `);
  return num(rowsOf<{ micros: string }>(result)[0]?.micros);
}

export type PlanDistribution = Record<Exclude<Plan, "free">, { founding: number; standard: number }> & {
  free: number;
};

/**
 * Accounts per plan, with paying Pro and Max split by whether a founding discount is running
 * on the subscription right now. Comped and Lifetime accounts are never "founding".
 */
export async function planDistribution(
  rows: ReadonlyArray<{ userId: string; plan: Plan; planSource: string }>,
  now = new Date()
): Promise<PlanDistribution> {
  const db = await getDb();
  const founding = new Set(
    rowsOf<{ user_id: string }>(
      await db.execute(sql`
        SELECT ${userSettings.userId} AS user_id FROM ${userSettings}
        WHERE ${userSettings.foundingWindowEndsAt} > ${now}
      `)
    ).map((r) => r.user_id)
  );
  const out: PlanDistribution = {
    free: 0,
    orbit: { founding: 0, standard: 0 },
    max: { founding: 0, standard: 0 },
    lifetime: { founding: 0, standard: 0 },
  };
  for (const row of rows) {
    if (row.plan === "free") {
      out.free++;
      continue;
    }
    const isFounding = row.planSource === "subscription" && founding.has(row.userId);
    out[row.plan][isFounding ? "founding" : "standard"]++;
  }
  return out;
}
