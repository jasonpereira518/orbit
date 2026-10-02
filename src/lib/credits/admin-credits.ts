import { and, eq, gt, gte, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { billingEvents, creditGrants, usageEvents, userSettings } from "@/db/schema";
import { MICROS_PER_CREDIT } from "@/lib/credits/grants";
import type { Plan } from "@/lib/plans/plan-config";

/**
 * The Money section's view of credits (pricing v2): packs as one-time revenue, what the
 * unused pack credits are worth as a liability, how much of the included allowance is being
 * used, what managed AI actually cost, and whether the ledger and the grants agree.
 *
 * Read-only. Every figure here is derived from the grant rows and `usage_events`; nothing is
 * cached, because the screen is visited rarely and a stale liability is worse than a slow one.
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
    /** Real model cost on Orbit's keys in the window. */
    costMicros: number;
    calls: number;
    accounts: number;
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
 * @param spendablePlanUsers accounts currently on Pro or Max — pack credits anywhere else are
 *   frozen (derived, never written), so the liability splits on this set.
 */
export async function loadCreditsMoney(
  spendablePlanUsers: ReadonlySet<string>,
  days = 30,
  now = new Date()
): Promise<CreditsMoney> {
  const db = await getDb();
  const since = new Date(now.getTime() - days * 86_400_000);

  const [packLedger, livePacks, packCounts, allowance, managed, topSpenders] = await Promise.all([
    db
      .select({
        kind: billingEvents.kind,
        n: sql<string>`count(*)`,
        inWindow: sql<string>`count(*) FILTER (WHERE ${billingEvents.effectiveAt} >= ${since})`,
        cashInWindow: sql<string>`coalesce(sum(${billingEvents.amountCents}) FILTER (WHERE ${billingEvents.effectiveAt} >= ${since}), 0)`,
      })
      .from(billingEvents)
      .where(eq(billingEvents.kind, "credit_pack"))
      .groupBy(billingEvents.kind),
    db
      .select({
        userId: creditGrants.userId,
        granted: creditGrants.microsGranted,
        remaining: creditGrants.microsRemaining,
        amountCents: creditGrants.amountCents,
      })
      .from(creditGrants)
      .where(and(eq(creditGrants.kind, "pack"), eq(creditGrants.status, "active"), gt(creditGrants.microsRemaining, 0))),
    db
      .select({
        total: sql<string>`count(*)`,
        revoked: sql<string>`count(*) FILTER (WHERE ${creditGrants.status} = 'revoked')`,
      })
      .from(creditGrants)
      .where(eq(creditGrants.kind, "pack")),
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
          sql`${creditGrants.periodEnd} > ${now}`
        )
      ),
    db
      .select({
        micros: sql<string>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)`,
        calls: sql<string>`count(*)`,
        accounts: sql<string>`count(DISTINCT ${usageEvents.userId})`,
      })
      .from(usageEvents)
      .where(and(eq(usageEvents.keyOwner, "orbit"), gte(usageEvents.createdAt, since))),
    db
      .select({
        userId: usageEvents.userId,
        micros: sql<string>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)`,
        calls: sql<string>`count(*)`,
      })
      .from(usageEvents)
      .where(and(eq(usageEvents.keyOwner, "orbit"), gte(usageEvents.createdAt, since)))
      .groupBy(usageEvents.userId)
      .orderBy(sql`sum(${usageEvents.estimatedCostMicros}) DESC`)
      .limit(10),
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
      calls: num(managed[0]?.calls),
      accounts: num(managed[0]?.accounts),
      topSpenders: topSpenders
        .filter((r): r is typeof r & { userId: string } => r.userId != null)
        .map((r) => ({ userId: r.userId, micros: num(r.micros), calls: num(r.calls) })),
    },
    reconciliation: {
      packsBooked,
      packGrants,
      ok: packsBooked === packGrants,
    },
  };
}

/** Real model cost on Orbit's keys over the trailing window — the managed-AI line of burn. */
export async function managedAiCostMicros(days = 30, now = new Date()): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ micros: sql<string>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)` })
    .from(usageEvents)
    .where(
      and(eq(usageEvents.keyOwner, "orbit"), gte(usageEvents.createdAt, new Date(now.getTime() - days * 86_400_000)))
    );
  return num(row?.micros);
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
