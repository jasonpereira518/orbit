import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { billingEvents, userSettings } from "@/db/schema";
import type { BillingEventKind } from "@/db/schema";

/**
 * What each billing webhook meant financially.
 *
 * WHY THIS EXISTS. The console derived MRR as `subscribers × $5`. That is a headcount
 * wearing a currency symbol: it reports the same number the day before and the day after
 * someone cancels, cannot see a refund at all, and answers "how did revenue change this
 * month" with a shrug. Everything interesting about revenue is a *movement*, and a count
 * of current subscribers has no movements in it.
 *
 * `webhook_deliveries` already records that an event arrived and how many times. This
 * records what it meant: signed `mrrDeltaCents` for recurring changes, `amountCents` for
 * cash that actually moved. Summing the deltas over a period gives real MRR movement.
 *
 * IDEMPOTENT BY CONSTRAINT, not by convention. `(source, event_id)` is unique, so a
 * redelivered webhook cannot be counted twice. That differs from `webhook_deliveries`,
 * which deliberately has no such index because counting retries is its whole signal — but
 * money is not a thing to be careful about, it is a thing to make structurally impossible
 * to get wrong. The retry information is not lost; it still lives one table over.
 *
 * Imports only drizzle and `@/db`. No `next/server` — the webhook route is not the only
 * caller, and a script that reaches this must still be able to exit.
 */

export const MONTHLY_CENTS = 500;
export const ANNUAL_CENTS = 5000;

/** Annual is booked as its monthly equivalent so MRR stays comparable across billing periods. */
export const ANNUAL_MONTHLY_EQUIVALENT_CENTS = Math.round(ANNUAL_CENTS / 12);

/**
 * Re-exported, not redeclared. The union lives beside the column it constrains in
 * `schema.ts`; keeping a second copy here is what let the two drift.
 */
export type { BillingEventKind } from "@/db/schema";

/**
 * The recurring value of a subscription state, in cents per month.
 *
 * `canceled` is worth its full value until the period ends — the user has paid through it
 * and `resolvePlan` honours that time, so booking the churn early would show revenue
 * disappearing while the entitlement is still live.
 */
export function monthlyValueCents(
  status: "active" | "past_due" | "canceled" | null,
  periodEnd: Date | null,
  now: Date = new Date(),
  monthlyCents: number | null = null
): number {
  // Null means "we never recorded what this subscription is worth", which is every row
  // written before the column existed. Falling back to the monthly price keeps those rows
  // reading exactly as they did before, so no historical figure moves on deploy day.
  const value = monthlyCents ?? MONTHLY_CENTS;
  if (status === "active") return value;
  if (status === "past_due") return value;
  if (status === "canceled") {
    return periodEnd && periodEnd.getTime() > now.getTime() ? value : 0;
  }
  return 0;
}

/**
 * Classify a change in recurring value.
 *
 * Takes the before and after rather than reading state itself, because the caller (the
 * webhook) is the only place both are known — by the time this module could look, the
 * mirror has already been overwritten.
 */
export function classifyMovement(
  beforeCents: number,
  afterCents: number,
  opts: { hadPriorRevenue?: boolean } = {}
): { kind: BillingEventKind; deltaCents: number } | null {
  const delta = afterCents - beforeCents;
  if (delta === 0) return null;

  if (beforeCents === 0 && afterCents > 0) {
    // Someone who has paid before and is paying again is a reactivation, not a new
    // customer. The distinction is invisible in the mirror — it has already been
    // overwritten — so it has to be supplied by the caller from the ledger's own history.
    //
    // Note the delta is identical either way, so getting this wrong misfiles a row
    // without ever corrupting `netCents`. That is deliberate: the cheap classification is
    // allowed to be uncertain precisely because the expensive number does not depend on it.
    return {
      kind: opts.hadPriorRevenue ? "reactivation" : "new",
      deltaCents: delta,
    };
  }
  if (beforeCents > 0 && afterCents === 0) {
    return { kind: "churn", deltaCents: delta };
  }
  return { kind: delta > 0 ? "expansion" : "contraction", deltaCents: delta };
}

/**
 * Record one movement. Safe to call twice with the same `(source, eventId)` — the second
 * is dropped by the unique index rather than double-counted.
 *
 * Returns whether a row was actually written, which is what the smoke test asserts on.
 */
export async function recordBillingEvent(input: {
  source: "clerk" | "stripe";
  eventId: string;
  kind: BillingEventKind;
  userId: string | null;
  amountCents?: number;
  mrrDeltaCents?: number;
  effectiveAt?: Date;
  detail?: Record<string, unknown>;
}): Promise<boolean> {
  try {
    const db = await getDb();
    const rows = await db
      .insert(billingEvents)
      .values({
        source: input.source,
        eventId: input.eventId,
        kind: input.kind,
        userId: input.userId,
        amountCents: input.amountCents ?? 0,
        mrrDeltaCents: input.mrrDeltaCents ?? 0,
        effectiveAt: input.effectiveAt ?? new Date(),
        detail: input.detail ?? {},
      })
      .onConflictDoNothing()
      .returning();

    return rows.length > 0;
  } catch {
    // A lost ledger row is bad; a webhook handler that 500s because of one is worse —
    // Svix retries, and the retry would hit the same failure. The delivery ledger still
    // records that the event arrived.
    return false;
  }
}

export type MrrMovement = {
  newCents: number;
  expansionCents: number;
  contractionCents: number;
  churnCents: number;
  reactivationCents: number;
  netCents: number;
  /** One-time revenue. Deliberately outside `netCents` — Lifetime is not recurring. */
  oneTimeCents: number;
  /**
   * Recurring cash actually received: invoices paid. Kept out of `oneTimeCents` because a
   * subscription renewal is not a one-time purchase, and out of `netCents` because cash
   * received is not a change in recurring rate — a renewal moves money and moves MRR by
   * exactly zero.
   */
  paymentCents: number;
  /** All cash in, whatever its shape: `payment` + `lifetime`. */
  cashInCents: number;
  /** Cash in less cash returned. The bottom line for a period. */
  netCashCents: number;
  refundedCents: number;
  failedPayments: number;
};

/**
 * MRR movement over a window.
 *
 * Grouped in SQL and summed in JS rather than one clever query, because at this volume the
 * grouping is a dozen rows and the readable version is worth more than the fast one.
 */
export async function mrrMovement(since: Date, until: Date): Promise<MrrMovement> {
  const db = await getDb();
  const rows = await db
    .select({
      kind: billingEvents.kind,
      delta: sql<string>`coalesce(sum(${billingEvents.mrrDeltaCents}), 0)`,
      amount: sql<string>`coalesce(sum(${billingEvents.amountCents}), 0)`,
      n: sql<string>`count(*)`,
    })
    .from(billingEvents)
    .where(
      and(gte(billingEvents.effectiveAt, since), lt(billingEvents.effectiveAt, until))
    )
    .groupBy(billingEvents.kind);

  const num = (v: string | number | null) => {
    const n = typeof v === "number" ? v : Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };

  const out: MrrMovement = {
    newCents: 0,
    expansionCents: 0,
    contractionCents: 0,
    churnCents: 0,
    reactivationCents: 0,
    netCents: 0,
    oneTimeCents: 0,
    paymentCents: 0,
    cashInCents: 0,
    netCashCents: 0,
    refundedCents: 0,
    failedPayments: 0,
  };

  for (const r of rows) {
    const delta = num(r.delta);
    switch (r.kind) {
      case "new":
        out.newCents += delta;
        break;
      case "expansion":
        out.expansionCents += delta;
        break;
      case "contraction":
        out.contractionCents += delta;
        break;
      case "churn":
        out.churnCents += delta;
        break;
      case "reactivation":
        out.reactivationCents += delta;
        break;
      case "lifetime":
        out.oneTimeCents += num(r.amount);
        break;
      case "payment":
        out.paymentCents += num(r.amount);
        break;
      case "refund":
        out.refundedCents += num(r.amount);
        break;
      case "payment_failed":
        out.failedPayments += num(r.n);
        break;
    }
  }

  // Recurring only. Lifetime and refunds move cash, not MRR, and folding them in here is
  // the single easiest way to produce a number that looks like MRR and is not.
  out.netCents =
    out.newCents +
    out.expansionCents +
    out.contractionCents +
    out.churnCents +
    out.reactivationCents;

  // Cash is summed from `amountCents` and MRR from `mrrDeltaCents`, and no row ever
  // carries both — subscription-shaped events book a rate, invoice- and charge-shaped
  // events book money. That is what makes these two totals independent rather than two
  // views of one number that can be added together by mistake.
  out.cashInCents = out.paymentCents + out.oneTimeCents;
  out.netCashCents = out.cashInCents - out.refundedCents;

  return out;
}

/**
 * Current MRR, computed from subscription state rather than from the ledger.
 *
 * Two independent derivations of the same quantity, on purpose. The ledger is a sum of
 * movements and drifts if any event was ever missed; this is a snapshot of what is true
 * right now. **When they disagree, a webhook was dropped** — which is a real failure mode
 * this codebase has already seen once, and one nothing else would surface.
 */
export async function currentMrrCents(now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({
      status: userSettings.subscriptionStatus,
      periodEnd: userSettings.subscriptionPeriodEnd,
      plan: userSettings.subscriptionPlan,
      comped: userSettings.compedPlan,
    })
    .from(userSettings);

  return rows.reduce((total, r) => {
    // A comped account pays nothing regardless of what its subscription columns say.
    if (r.comped) return total;
    if (r.plan !== "orbit") return total;
    return total + monthlyValueCents(r.status, r.periodEnd, now);
  }, 0);
}

/**
 * Has this account ever produced recurring revenue before?
 *
 * The reactivation gate. `user_settings` cannot answer it — the mirror holds only the
 * current state, and a returning subscriber's row looks exactly like a first-time one.
 * The ledger is the only place the history survives.
 *
 * Indexed by `(user_id, effective_at)`, so this is a cheap existence check, not a scan.
 */
export async function hasPriorRevenue(userId: string, before?: Date): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .select({ id: billingEvents.id })
    .from(billingEvents)
    .where(
      and(
        eq(billingEvents.userId, userId),
        gte(billingEvents.mrrDeltaCents, 1),
        before ? lt(billingEvents.effectiveAt, before) : undefined
      )
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * `recordBillingEvent`, but it throws.
 *
 * The swallowing variant is right for a webhook: Stripe retries, and a handler that 500s
 * over a ledger row turns a recoverable miss into a repeated one. It is wrong for a
 * script. A backfill that quietly drops rows produces a Money screen that is confidently
 * incorrect — the exact failure this ledger exists to prevent — so batch callers get a
 * version that fails loudly instead.
 *
 * Returns whether a row was written; `false` means the event was already recorded, which
 * is a successful no-op, not an error.
 */
export async function recordBillingEventStrict(input: {
  source: "clerk" | "stripe";
  eventId: string;
  kind: BillingEventKind;
  userId: string | null;
  amountCents?: number;
  mrrDeltaCents?: number;
  effectiveAt?: Date;
  detail?: Record<string, unknown>;
}): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .insert(billingEvents)
    .values({
      source: input.source,
      eventId: input.eventId,
      kind: input.kind,
      userId: input.userId,
      amountCents: input.amountCents ?? 0,
      mrrDeltaCents: input.mrrDeltaCents ?? 0,
      effectiveAt: input.effectiveAt ?? new Date(),
      detail: input.detail ?? {},
    })
    .onConflictDoNothing()
    .returning();

  return rows.length > 0;
}

/**
 * The two independent derivations of current MRR, compared.
 *
 * `currentMrrCents` reads live subscription state; summing `mrr_delta_cents` replays every
 * movement ever recorded. They are computed from different tables by different code and
 * should agree exactly. **When they do not, a webhook was dropped** — a failure this
 * codebase has already seen once, which nothing else in the console can detect.
 *
 * This is the one number on the Money screen capable of telling an operator that the rest
 * of the screen is lying, so it belongs above the figures it validates, not below them.
 */
export async function mrrReconciliation(now: Date = new Date()): Promise<{
  ledgerCents: number;
  liveCents: number;
  driftCents: number;
}> {
  const db = await getDb();
  const [liveCents, rows] = await Promise.all([
    currentMrrCents(now),
    db
      .select({ total: sql<string>`coalesce(sum(${billingEvents.mrrDeltaCents}), 0)` })
      .from(billingEvents),
  ]);

  const raw = Number(rows[0]?.total ?? 0);
  const ledgerCents = Number.isFinite(raw) ? raw : 0;

  return { ledgerCents, liveCents, driftCents: liveCents - ledgerCents };
}

/** Most recent movements, for the ledger panel. */
export async function recentBillingEvents(limit = 25) {
  const db = await getDb();
  return db
    .select()
    .from(billingEvents)
    .orderBy(desc(billingEvents.effectiveAt))
    .limit(limit);
}

/** Every movement for one account, for the inspector. */
export async function billingEventsForUser(userId: string, limit = 50) {
  const db = await getDb();
  return db
    .select()
    .from(billingEvents)
    .where(eq(billingEvents.userId, userId))
    .orderBy(desc(billingEvents.effectiveAt))
    .limit(limit);
}
