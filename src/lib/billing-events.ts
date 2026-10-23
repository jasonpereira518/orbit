import { and, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { billingEvents, userSettings } from "@/db/schema";
import type { BillingEventKind } from "@/db/schema";
import { internalAccountSql } from "@/lib/analytics-internal";
import { PLAN_CONFIG } from "@/lib/plans/plan-config";

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
 * Imports drizzle, `@/db`, the plan table and the shared internal-account predicate
 * (`analytics-internal`, which every money query must use). It loads without a request and a
 * script that reaches it still exits — `scripts/smoke-money-correctness.ts` pins that.
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
 * What a subscription row is worth per month when `subscription_monthly_cents` was never
 * recorded (every row written before the column existed).
 *
 * TIER-AWARE, not a flat $5: a null on a Max row used to be valued at the legacy $5 here and
 * at Max's list price in `revenueAtRiskCents`, so one account was two different amounts on
 * two screens. Null on Pro (or an unknown tier) is a legacy $5 subscription — the only kind
 * that predates the column — so it keeps reading exactly as it always did.
 */
export function fallbackMonthlyCents(plan?: string | null): number {
  if (plan === "max") return PLAN_CONFIG.max.monthlyPriceCents ?? MONTHLY_CENTS;
  return MONTHLY_CENTS;
}

/**
 * The recurring value of a subscription state, in cents per month.
 *
 * `canceled` is worth its full value until the period ends — the user has paid through it
 * and `resolvePlan` honours that time, so booking the churn early would show revenue
 * disappearing while the entitlement is still live.
 *
 * `past_due` keeps its full value: the subscription is still entitled and Stripe is still
 * retrying. The money that is wobbling is reported separately as the "at risk" figure
 * (`currentMrrDetail().pastDueCents`, `revenueAtRiskCents`) rather than by quietly shrinking MRR.
 */
export function monthlyValueCents(
  status: "active" | "past_due" | "canceled" | null,
  periodEnd: Date | null,
  now: Date = new Date(),
  monthlyCents: number | null = null,
  plan: string | null = null
): number {
  // Null means "we never recorded what this subscription is worth", which is every row
  // written before the column existed. The tier-aware fallback keeps those rows reading as
  // they did before, so no historical figure moves on deploy day.
  const value = monthlyCents ?? fallbackMonthlyCents(plan);
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

/** The ledger kinds that move recurring revenue. Everything else is cash or a status change. */
export const MRR_KINDS = ["new", "expansion", "contraction", "churn", "reactivation"] as const;

/**
 * SQL: whether an account is comped right now (`comped_plan IS NOT NULL`). Never null.
 * Revenue metrics exclude these (a comp pays nothing); product metrics keep them.
 */
export function compedAccountSql(column: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM user_settings cp WHERE cp.user_id = ${column} AND cp.comped_plan IS NOT NULL)`;
}

/**
 * SQL: should this ledger row count toward revenue figures?
 *
 *  - Internal and tester accounts never count (audit I2): the operator's own test
 *    subscription is not MRR, a new subscriber, cash in, or a CAC denominator.
 *  - Comped accounts are excluded from the MRR-moving kinds only. Live MRR already skips them
 *    (`currentMrrCents`), so the ledger must too or every comp-over-a-paying-subscriber is
 *    permanent "drift" (audit I5); but the CASH they went on to pay was real money.
 *  - A null `user_id` (a backfilled refund, a row anonymised by account deletion) is kept:
 *    there is no account to test, and dropping it would lose real cash.
 */
export function ledgerRowCountsSql(userId: SQL, kind: SQL = sql`${billingEvents.kind}`): SQL {
  const mrrKinds = sql.join(
    MRR_KINDS.map((k) => sql`${k}`),
    sql`, `
  );
  return sql`(NOT ${internalAccountSql(userId)} AND (${kind} NOT IN (${mrrKinds}) OR NOT ${compedAccountSql(userId)}))`;
}

/**
 * SQL: has this account been refunded in full — refunds summed against everything it paid
 * (payments, Lifetime, packs) are at least that total? Per account and in cash, so a
 * subscriber refunded one month of three is NOT fully refunded, and a buyer whose only charge
 * was refunded is. Rows with a null `user_id` cannot be attributed, so a backfilled refund
 * never un-pays anyone (audit M11). Never null.
 */
export function fullyRefundedSql(userId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM billing_events pr
    WHERE pr.user_id = ${userId}
    GROUP BY pr.user_id
    HAVING coalesce(sum(pr.amount_cents) FILTER (WHERE pr.kind IN ('lifetime', 'payment', 'credit_pack')), 0) > 0
       AND coalesce(sum(pr.amount_cents) FILTER (WHERE pr.kind = 'refund'), 0)
           >= coalesce(sum(pr.amount_cents) FILTER (WHERE pr.kind IN ('lifetime', 'payment', 'credit_pack')), 0)
  )`;
}

/**
 * SQL: is this account PAID — the one definition every reader shares (audit M6).
 *
 *   (a Lifetime purchase  OR  any recurring revenue ever booked  OR  a lifetime booking)
 *   AND NOT fully refunded
 *   AND NOT internal/tester
 *   [AND NOT comped, unless `includeComped`]
 *
 * Takes the user-id column as SQL (`sql\`s.user_id\``) so it composes into any query. Used by
 * `paidSignupsByChannel` and `gateDemand` here; the Conversion funnel (`acquisitionFunnel`)
 * and the overview's plan breakdown should adopt it rather than keep their own variants.
 */
export function paidAccountSql(
  userId: SQL,
  opts: { includeComped?: boolean } = {}
): SQL {
  const comped = opts.includeComped ? sql`true` : sql`NOT ${compedAccountSql(userId)}`;
  return sql`(
    (
      EXISTS (SELECT 1 FROM user_settings pl WHERE pl.user_id = ${userId} AND pl.lifetime_purchased_at IS NOT NULL)
      OR EXISTS (
        SELECT 1 FROM billing_events pb
        WHERE pb.user_id = ${userId} AND (pb.mrr_delta_cents > 0 OR pb.kind = 'lifetime')
      )
    )
    AND NOT ${fullyRefundedSql(userId)}
    AND NOT ${internalAccountSql(userId)}
    AND ${comped}
  )`;
}

export type MrrMovement = {
  newCents: number;
  expansionCents: number;
  contractionCents: number;
  churnCents: number;
  reactivationCents: number;
  netCents: number;
  /** One-time revenue (Lifetime and credit packs). Deliberately outside `netCents` — neither is recurring. */
  oneTimeCents: number;
  /**
   * Recurring cash actually received: invoices paid. Kept out of `oneTimeCents` because a
   * subscription renewal is not a one-time purchase, and out of `netCents` because cash
   * received is not a change in recurring rate — a renewal moves money and moves MRR by
   * exactly zero.
   */
  paymentCents: number;
  /** How many charges brought that cash in — Stripe's fixed fee is per charge, not per month. */
  chargeCount: number;
  /** All cash in, whatever its shape: `payment` + `lifetime` + `credit_pack`. */
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
      and(
        gte(billingEvents.effectiveAt, since),
        lt(billingEvents.effectiveAt, until),
        ledgerRowCountsSql(sql`${billingEvents.userId}`)
      )
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
    chargeCount: 0,
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
      // A $5 credit pack is one-time cash exactly like Lifetime. It was missing from this
      // switch, so every "cash in", "one-time", contribution and net-cash figure that says
      // it includes packs silently left them out (audit M1). It is a separate Stripe
      // charge, so it also counts toward the per-charge fixed fee.
      case "credit_pack":
        out.oneTimeCents += num(r.amount);
        out.chargeCount += num(r.n);
        break;
      case "payment":
        out.paymentCents += num(r.amount);
        out.chargeCount += num(r.n);
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
 *
 * Comped accounts and internal/tester accounts (admins, the showcase, `account_kind`) are
 * excluded: neither pays. `pastDueCents` is the part of the total whose payment is failing
 * right now — still counted (the subscription is entitled and Stripe is retrying), but
 * reported beside the total so the number is never read as safer than it is.
 */
export async function currentMrrDetail(
  now: Date = new Date()
): Promise<{ mrrCents: number; pastDueCents: number }> {
  const db = await getDb();
  const rows = await db
    .select({
      status: userSettings.subscriptionStatus,
      periodEnd: userSettings.subscriptionPeriodEnd,
      plan: userSettings.subscriptionPlan,
      comped: userSettings.compedPlan,
      monthlyCents: userSettings.subscriptionMonthlyCents,
    })
    .from(userSettings)
    .where(sql`NOT ${internalAccountSql(sql`${userSettings.userId}`)}`);

  let mrrCents = 0;
  let pastDueCents = 0;
  for (const r of rows) {
    // A comped account pays nothing regardless of what its subscription columns say.
    if (r.comped) continue;
    if (r.plan !== "orbit" && r.plan !== "max") continue;
    // The stored value is what the webhook booked (founding discount included), so the two
    // derivations agree for every price, not only the legacy $5 one.
    const value = monthlyValueCents(r.status, r.periodEnd, now, r.monthlyCents, r.plan);
    mrrCents += value;
    if (r.status === "past_due") pastDueCents += value;
  }
  return { mrrCents, pastDueCents };
}

export async function currentMrrCents(now: Date = new Date()): Promise<number> {
  return (await currentMrrDetail(now)).mrrCents;
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

/** Σ `mrr_delta_cents` the ledger holds for one account: what it currently believes they pay. */
export async function ledgerMrrCents(userId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${billingEvents.mrrDeltaCents}), 0)` })
    .from(billingEvents)
    .where(eq(billingEvents.userId, userId));
  const n = Number(row?.total ?? 0);
  return Number.isFinite(n) ? n : 0;
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
    // The same population as the live side: no internal/tester accounts, no comped ones.
    // Without this an operator's own test subscription (or a comp placed over a paying
    // subscriber) is permanent "drift" that blames a dropped webhook (audit I2, I5).
    db
      .select({ total: sql<string>`coalesce(sum(${billingEvents.mrrDeltaCents}), 0)` })
      .from(billingEvents)
      .where(ledgerRowCountsSql(sql`${billingEvents.userId}`)),
  ]);

  const raw = Number(rows[0]?.total ?? 0);
  const ledgerCents = Number.isFinite(raw) ? raw : 0;

  return { ledgerCents, liveCents, driftCents: liveCents - ledgerCents };
}
