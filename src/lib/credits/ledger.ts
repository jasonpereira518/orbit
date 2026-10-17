import { and, desc, eq, gt, lte, or, sql } from "drizzle-orm";
import { getDb, rowsOf, runAtomicBatch } from "@/db";
import { creditGrants, creditHolds } from "@/db/schema";
import { FREE_STARTER_CREDITS, PLAN_CONFIG, type Plan } from "@/lib/plans/plan-config";
import { AI_OPERATIONS } from "@/lib/ai-operations";
import { holdEstimateMicros } from "@/lib/managed-ai-policy";
import { creditsToMicros } from "@/lib/credits/grants";

/**
 * The managed-AI credit ledger: allowances, holds, settlement and the balance.
 *
 * THE MODEL (see `creditGrants` in `src/db/schema.ts`). The grant rows are the balance. What
 * is spendable right now is the sum of `micros_remaining` over the account's active grants
 * that are usable now, less its open holds:
 *   - an allowance only inside its own billing period (it never rolls over);
 *   - an admin adjustment always;
 *   - the starter grant always;
 *   - a pack only while the account's plan includes managed AI. A downgrade therefore
 *     FREEZES packs by rule — nothing is written — and a resubscribe finds them intact.
 * Spending takes allowance first, then starter, then adjustments, then packs oldest-first.
 *
 * THE HARD STOP. A managed call first places a HOLD for its estimated cost. The hold is
 * inserted only if spendable-minus-held is still above zero, and the insert runs in the same
 * atomic batch as a touch of the account's `credit_accounts` row. That touch is a row lock,
 * and every later statement in the batch runs on a fresh snapshot (READ COMMITTED), so two
 * concurrent calls for one account serialise: the second sees the first's hold. At zero the
 * only call that can still finish is one already in flight; its real cost may overshoot the
 * last credit, and the overshoot is Orbit's (settlement never takes a grant below zero, and
 * nothing is ever carried into the next cycle or charged).
 *
 * SETTLEMENT is keyed off the usage row every managed call already writes
 * (`recordUsage` → `settleManagedUsage`): the real token cost is deducted and the oldest open
 * hold for that operation released. A grant reused for several calls deducts every call. A
 * hold whose call died without writing usage simply expires, uncharged.
 *
 * No `next/server`: tsx scripts and the batch sweeper reach this module.
 */

/** How long a hold counts against the balance. Longer than the slowest call (300s). */
export const HOLD_TTL_MS = 10 * 60 * 1000;
/** Batch jobs can take a day to come back. */
export const BATCH_HOLD_TTL_MS = 26 * 60 * 60 * 1000;

export type CreditPeriod = { start: Date; end: Date };

/** Whether this plan's packs are spendable (every plan but Lifetime). Frozen there. */
export function packsUsable(plan: Plan): boolean {
  return PLAN_CONFIG[plan].features.creditPacks;
}

function monthWindow(now: Date): CreditPeriod {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

function minusOneMonth(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())
  );
}

/** `d` moved by `months` calendar months, clamped to the target month's last day (as Stripe does). */
function addMonthsClamped(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())
  );
}

/** Anything longer than this is not a monthly billing period (an annual plan). */
const MONTHLY_PERIOD_MAX_MS = 35 * 86_400_000;

/**
 * The month of a long (annual) billing period that contains `now`, counted back from the
 * renewal date so the slices land on the subscription's own monthly anniversaries.
 */
function monthSliceOf(end: Date, now: Date): CreditPeriod {
  for (let k = 0; k < 14; k++) {
    const sliceEnd = addMonthsClamped(end, -k);
    const sliceStart = addMonthsClamped(end, -(k + 1));
    if (sliceStart <= now && now < sliceEnd) return { start: sliceStart, end: sliceEnd };
  }
  return monthWindow(now);
}

/**
 * The allowance's current cycle. A monthly subscriber's is their Stripe billing period, so the
 * allowance resets at each renewal. An ANNUAL subscriber still gets a monthly allowance: the
 * year is cut into months on the subscription's own anniversaries, so a year's credits never
 * arrive as one lump. A comped account has no billing cycle and resets on the calendar month
 * (UTC).
 */
export function creditPeriodFor(
  row: {
    compedPlan?: string | null;
    subscriptionPeriodStart?: Date | null;
    subscriptionPeriodEnd?: Date | null;
  } | null | undefined,
  now = new Date()
): CreditPeriod {
  if (!row?.compedPlan && row?.subscriptionPeriodEnd && row.subscriptionPeriodEnd > now) {
    const end = row.subscriptionPeriodEnd;
    const known = row.subscriptionPeriodStart && row.subscriptionPeriodStart <= now ? row.subscriptionPeriodStart : null;
    // A long period, or an unknown start with more than a month still to run: an annual plan.
    if (known ? end.getTime() - known.getTime() > MONTHLY_PERIOD_MAX_MS : end.getTime() - now.getTime() > MONTHLY_PERIOD_MAX_MS) {
      return monthSliceOf(end, now);
    }
    return { start: known ?? minusOneMonth(end), end };
  }
  return monthWindow(now);
}

/**
 * A Free account's one-time starter grant. `starter:<user>` is unique, so this is idempotent,
 * and a deleted account's anonymised row keeps the key, so the same user id never gets two.
 */
export async function ensureStarterGrant(userId: string): Promise<void> {
  const micros = creditsToMicros(FREE_STARTER_CREDITS);
  const db = await getDb();
  await db
    .insert(creditGrants)
    .values({ userId, kind: "starter", grantKey: `starter:${userId}`, microsGranted: micros, microsRemaining: micros })
    .onConflictDoNothing({ target: creditGrants.grantKey });
}

/**
 * Make sure this cycle's allowance grant exists — the reset.
 *
 * ONE allowance covers any moment. When a grant already covers `now`, it is ADOPTED rather
 * than joined by a second: the first grant of a new subscription is often made on the
 * calendar-month fallback (verify-on-return mirrors the plan before Stripe has sent the
 * billing period), and when the real period arrives that grant moves onto it — credits
 * already used stay used. Two overlapping grants would both be spendable, which is exactly
 * the double allowance this rule exists to prevent. Once a cycle has ended no grant covers
 * `now`, so the next call creates the new cycle's: the reset, with nothing rolled over.
 *
 * When the plan's allowance is larger than the grant (Pro → Max mid-cycle, which Stripe
 * applies immediately) the difference is added to the cycle. Never lowered: a Max → Pro
 * switch takes effect at the next renewal.
 *
 * Free has no billing cycle, so its allowance runs on the calendar month (`creditPeriodFor`
 * gives that period). On Free this also seeds the one-time starter grant (`ensureStarterGrant`,
 * keyed `starter:{userId}`, so never a second one).
 */
export async function ensureAllowance(
  userId: string,
  plan: Plan,
  period: CreditPeriod,
  now = new Date()
): Promise<void> {
  const credits = PLAN_CONFIG[plan].monthlyCredits;
  if (!credits) return;
  if (plan === "free") await ensureStarterGrant(userId);
  const micros = creditsToMicros(credits);
  const grantKey = `allowance:${userId}:${period.start.toISOString()}`;
  const db = await getDb();
  const [current] = await db
    .select()
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.userId, userId),
        eq(creditGrants.kind, "allowance"),
        eq(creditGrants.status, "active"),
        lte(creditGrants.periodStart, now),
        gt(creditGrants.periodEnd, now)
      )
    )
    .orderBy(desc(creditGrants.createdAt))
    .limit(1);

  if (current) {
    const samePeriod =
      current.periodStart?.getTime() === period.start.getTime() && current.periodEnd?.getTime() === period.end.getTime();
    const raise = current.microsGranted < micros;
    if (samePeriod && !raise) return;
    // Only move onto a period that also covers now; a stale mirror never drags a grant
    // somewhere it would stop counting.
    const adopt = !samePeriod && period.start <= now && period.end > now;
    if (!adopt && !raise) return;
    await db
      .update(creditGrants)
      .set({
        ...(adopt ? { periodStart: period.start, periodEnd: period.end, grantKey } : {}),
        ...(raise
          ? {
              plan,
              microsGranted: micros,
              microsRemaining: sql`${creditGrants.microsRemaining} + (${micros} - ${creditGrants.microsGranted})`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(creditGrants.id, current.id))
      .catch(async (err) => {
        // A concurrent call adopted the same period first (grant_key is unique): fine.
        if (!String(err).includes("credit_grants_key_uidx")) throw err;
      });
    return;
  }

  await db
    .insert(creditGrants)
    .values({
      userId,
      kind: "allowance",
      grantKey,
      plan,
      microsGranted: micros,
      microsRemaining: micros,
      periodStart: period.start,
      periodEnd: period.end,
    })
    .onConflictDoNothing({ target: creditGrants.grantKey });
}

/**
 * Whether `ensureAllowance` would leave the ledger exactly as it is, judged from grant rows
 * already read. Mirrors its early returns line for line — when this says false, the caller
 * runs `ensureAllowance` itself, so the write logic lives in one place.
 */
function allowanceIsCurrent(
  rows: Array<typeof creditGrants.$inferSelect>,
  starterKey: string,
  plan: Plan,
  period: CreditPeriod,
  now: Date
): boolean {
  const credits = PLAN_CONFIG[plan].monthlyCredits;
  if (!credits) return true;
  if (plan === "free" && !rows.some((g) => g.grantKey === starterKey)) return false;
  const current = rows
    .filter(
      (g) =>
        g.kind === "allowance" &&
        g.status === "active" &&
        g.periodStart !== null &&
        g.periodEnd !== null &&
        g.periodStart <= now &&
        g.periodEnd > now
    )
    .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0];
  if (!current) return false;
  const samePeriod =
    current.periodStart?.getTime() === period.start.getTime() && current.periodEnd?.getTime() === period.end.getTime();
  const raise = current.microsGranted < creditsToMicros(credits);
  if (samePeriod && !raise) return true;
  const adopt = !samePeriod && period.start <= now && period.end > now;
  return !adopt && !raise;
}

/** SQL: spendable micros for `userId` now, before holds. */
function spendableSql(userId: string, packs: boolean) {
  return sql`(SELECT coalesce(sum(g.micros_remaining), 0) FROM credit_grants g
    WHERE g.user_id = ${userId} AND g.status = 'active' AND g.micros_remaining > 0 AND (
      (g.kind = 'allowance' AND g.period_start <= now() AND g.period_end > now())
      OR g.kind IN ('adjustment', 'starter')
      OR (g.kind = 'pack' AND ${packs})
    ))`;
}

function starterSql(userId: string) {
  return sql`(SELECT coalesce(sum(g.micros_remaining), 0) FROM credit_grants g
    WHERE g.user_id = ${userId} AND g.status = 'active' AND g.kind = 'starter')`;
}

function heldSql(userId: string) {
  return sql`(SELECT coalesce(sum(h.micros), 0) FROM credit_holds h
    WHERE h.user_id = ${userId} AND h.expires_at > now())`;
}

/**
 * Reserve `micros` for a managed call. Returns the hold id, or null when the account is at
 * (or below) zero once the calls already in flight are counted — the hard stop.
 */
export async function placeHold(input: {
  userId: string;
  micros: number;
  operation: string;
  packs: boolean;
  ttlMs?: number;
  /**
   * Refuse unless MORE than this stays spendable. 0 for anything a person is waiting on;
   * half the monthly allowance for background work (`BACKGROUND_FLOOR_SHARE`).
   */
  floorMicros?: number;
  /** Add the starter grant's remaining micros to the floor: Free background work never spends it. */
  reserveStarter?: boolean;
}): Promise<string | null> {
  const db = await getDb();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? HOLD_TTL_MS));
  const results = await runAtomicBatch(db, (tx) => [
    // The lock. Created on first use; every later hold for the account queues behind it.
    tx.execute(sql`INSERT INTO credit_accounts (user_id) VALUES (${input.userId})
      ON CONFLICT (user_id) DO UPDATE SET updated_at = now()`),
    tx.execute(sql`INSERT INTO credit_holds (user_id, micros, operation, expires_at)
      SELECT ${input.userId}, ${Math.max(1, Math.round(input.micros))}, ${input.operation}, ${expiresAt.toISOString()}::timestamptz
      WHERE ${spendableSql(input.userId, input.packs)} - ${heldSql(input.userId)} > ${Math.max(0, Math.round(input.floorMicros ?? 0))}
        + ${input.reserveStarter ? starterSql(input.userId) : sql`0`}
      RETURNING id`),
  ]);
  const inserted = rowsOf<{ id: string }>(results[1] as never);
  return inserted[0]?.id ?? null;
}

/**
 * Deduct a managed call's real cost, allowance first, then starter, then adjustments, then packs
 * oldest-first, and release the oldest open (unexpired) hold for its operation. Never takes a grant
 * below zero. Packs are always eligible here: a call only ran because its plan allowed it.
 */
export async function settleCredits(input: { userId: string; operation: string; micros: number }): Promise<void> {
  const amount = Math.max(0, Math.round(input.micros));
  const db = await getDb();
  await runAtomicBatch(db, (tx) => [
    tx.execute(sql`INSERT INTO credit_accounts (user_id) VALUES (${input.userId})
      ON CONFLICT (user_id) DO UPDATE SET updated_at = now()`),
    tx.execute(sql`WITH usable AS (
        SELECT g.id, g.micros_remaining,
          sum(g.micros_remaining) OVER (
            ORDER BY CASE g.kind WHEN 'allowance' THEN 0 WHEN 'starter' THEN 1 WHEN 'adjustment' THEN 2 ELSE 3 END, g.created_at, g.id
          ) AS running
        FROM credit_grants g
        WHERE g.user_id = ${input.userId} AND g.status = 'active' AND g.micros_remaining > 0 AND (
          (g.kind = 'allowance' AND g.period_start <= now() AND g.period_end > now())
          OR g.kind IN ('starter', 'adjustment', 'pack')
        )
      )
      UPDATE credit_grants g
         SET micros_remaining = least(u.micros_remaining, greatest(0, u.running - ${amount})),
             updated_at = now()
        FROM usable u
       WHERE g.id = u.id AND u.running - u.micros_remaining < ${amount}`),
    tx.execute(sql`DELETE FROM credit_holds WHERE id = (
        SELECT id FROM credit_holds
         WHERE user_id = ${input.userId} AND operation = ${input.operation} AND expires_at > now()
         ORDER BY created_at, id LIMIT 1
      )`),
  ]);
}

/**
 * Release one hold without charging (a batch that finished or failed, a refused call): the one
 * named by `holdId`, else the oldest live one for the operation (the one `settleCredits` would
 * take), falling back to an expired one.
 * Deleting every hold for the operation freed the reservations of concurrent calls still running,
 * so the account could overspend while they finished.
 */
export async function releaseHold(userId: string, operation: string, holdId?: string): Promise<void> {
  const db = await getDb();
  if (holdId) {
    await db.delete(creditHolds).where(and(eq(creditHolds.id, holdId), eq(creditHolds.userId, userId)));
    return;
  }
  await db.execute(sql`DELETE FROM credit_holds WHERE id = (
      SELECT id FROM credit_holds
       WHERE user_id = ${userId} AND operation = ${operation}
       ORDER BY (expires_at > now()) DESC, created_at, id LIMIT 1
    )`);
}

/** Drop holds that expired more than a day ago. Called from the process-stalled cron. */
export async function sweepExpiredHolds(now = new Date()): Promise<number> {
  const db = await getDb();
  const rows = await db
    .delete(creditHolds)
    .where(lte(creditHolds.expiresAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)))
    .returning();
  return rows.length;
}

export type CreditBalance = {
  /** This cycle's allowance, in micros; null when the plan has none. */
  allowance: { granted: number; remaining: number; periodStart: string; periodEnd: string } | null;
  /** A Free account's one-time starter credits still unused, in micros (0 when none). */
  starterRemaining: number;
  /** Purchased pack credits still unused (frozen only on Lifetime). */
  packRemaining: number;
  /** Packs exist but the plan cannot spend them (downgraded): kept, frozen. */
  packsFrozen: boolean;
  /** Packs bought in the current cycle — the Max nudge counts these. */
  packsThisCycle: number;
  /** Micros held by calls in flight. */
  held: number;
  /** What the next call can draw on: allowance + starter + adjustments + usable packs − held. */
  spendable: number;
};

/**
 * The balance for the credits card and the account alerts. Ensures the current allowance
 * exists first, so a new cycle shows its reset before the first call of the cycle is made.
 */
export async function getCreditBalance(
  userId: string,
  plan: Plan,
  row: Parameters<typeof creditPeriodFor>[0],
  now = new Date(),
  opts: { ensure?: boolean } = {}
): Promise<CreditBalance> {
  const period = creditPeriodFor(row, now);
  const db = await getDb();
  const starterKey = `starter:${userId}`;
  // One round: active grants, every pack (revoked ones still count for the nudge), and the
  // starter key under any owner (`ensureStarterGrant`'s conflict target) — so whether
  // `ensureAllowance` has anything to do is answered from rows this read already has.
  const read = () =>
    Promise.all([
      db
        .select()
        .from(creditGrants)
        .where(
          or(
            and(
              eq(creditGrants.userId, userId),
              or(eq(creditGrants.status, "active"), eq(creditGrants.kind, "pack"))
            ),
            eq(creditGrants.grantKey, starterKey)
          )
        ),
      db
        .select({ micros: sql<string>`coalesce(sum(${creditHolds.micros}), 0)` })
        .from(creditHolds)
        .where(and(eq(creditHolds.userId, userId), gt(creditHolds.expiresAt, now))),
    ]);
  let [rows, holds] = await read();
  // Read-only callers (the notification poll) pass `ensure: false`: a missing allowance just
  // reads as none yet, and the next AI call or visit to the card creates it. Everyone else
  // writes only when the rows say a write is due (a new cycle, a raise, a missing starter),
  // then reads again — instead of an INSERT and a SELECT in front of every balance.
  if (
    opts.ensure !== false &&
    PLAN_CONFIG[plan].features.hostedAi &&
    !allowanceIsCurrent(rows, starterKey, plan, period, now)
  ) {
    await ensureAllowance(userId, plan, period, now);
    [rows, holds] = await read();
  }
  const grants = rows.filter((g) => g.userId === userId && g.status === "active");
  const inPeriod = (g: (typeof grants)[number]) =>
    g.periodStart !== null && g.periodEnd !== null && g.periodStart <= now && g.periodEnd > now;
  // The newest covering grant: the one `ensureAllowance` adopts, should an overlap ever exist.
  const allowanceGrant =
    grants
      .filter((g) => g.kind === "allowance" && inPeriod(g))
      .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0] ?? null;
  const packs = grants.filter((g) => g.kind === "pack");
  const packRemaining = packs.reduce((sum, g) => sum + g.microsRemaining, 0);
  const adjustments = grants.filter((g) => g.kind === "adjustment").reduce((sum, g) => sum + g.microsRemaining, 0);
  const starterRemaining = grants.filter((g) => g.kind === "starter").reduce((sum, g) => sum + g.microsRemaining, 0);
  const usable = packsUsable(plan);
  const held = Number(holds[0]?.micros ?? 0);
  const allowanceRemaining = allowanceGrant?.microsRemaining ?? 0;
  const cycleStart = allowanceGrant?.periodStart ?? period.start;
  // Revoked packs still count as bought for the nudge: `rows` carries every pack, any status.
  const n = rows.filter((g) => g.userId === userId && g.kind === "pack" && g.createdAt > cycleStart).length;
  return {
    allowance: allowanceGrant
      ? {
          granted: allowanceGrant.microsGranted,
          remaining: allowanceRemaining,
          periodStart: allowanceGrant.periodStart!.toISOString(),
          periodEnd: allowanceGrant.periodEnd!.toISOString(),
        }
      : null,
    starterRemaining,
    packRemaining,
    packsFrozen: !usable && packRemaining > 0,
    packsThisCycle: n,
    held,
    spendable: Math.max(0, allowanceRemaining + starterRemaining + adjustments + (usable ? packRemaining : 0) - held),
  };
}

/** What an unpriced managed call costs the balance (Whisper and Gemini embeddings report none). */
const UNPRICED_MICROS: Record<string, number> = { transcription: 6_000, embedding: 50 };
const UNPRICED_OTHER_MICROS = 2_000;

/**
 * Settle one managed call from its usage row. Only LLM calls on Orbit's key spend credits:
 * Deepgram has its own hours meter, and a failed call that reported no tokens costs nothing.
 */
/**
 * Failures the PROVIDER still bills in full: the caller walked away (a closed tab, an
 * `AbortSignal`) or Orbit's own deadline fired while the model was mid-answer. A stream
 * reports its token usage only in its final chunk, so these arrive with no counts at all.
 */
const BILLED_FAILURE_KINDS = new Set(["cancelled", "timeout"]);

export async function settleManagedUsage(row: {
  userId: string;
  operation: string;
  provider: string;
  kind: string;
  keyOwner: "user" | "orbit";
  success: number;
  estimatedCostMicros: number | null;
  errorKind?: string | null;
}): Promise<void> {
  if (row.keyOwner !== "orbit" || row.provider === "deepgram" || row.provider === "typesafe") return;
  await settleCredits({ userId: row.userId, operation: row.operation, micros: managedChargeMicros(row) });
}

/**
 * What a managed call costs the account, in micros.
 *
 * Reported or estimated cost when there is one. A successful call with no price on file is
 * charged its pessimistic stand-in. A failed call is free — the provider refused or broke —
 * EXCEPT when the failure is the caller's: an aborted or timed-out stream has already been
 * generated and billed to Orbit in full, and settling it at zero let a client read the whole
 * answer from the SSE stream, abort before the last chunk, and pay nothing (audit H-02).
 * Those settle at the hold estimate for the operation's tier — the same number the call
 * reserved before it ran, never more than the hold the person already saw as pending.
 */
export function managedChargeMicros(row: {
  operation: string;
  kind: string;
  success: number;
  estimatedCostMicros: number | null;
  errorKind?: string | null;
}): number {
  if (row.estimatedCostMicros !== null) return row.estimatedCostMicros;
  if (row.success === 1) return UNPRICED_MICROS[row.kind] ?? UNPRICED_OTHER_MICROS;
  if (row.errorKind && BILLED_FAILURE_KINDS.has(row.errorKind)) {
    const tier = (AI_OPERATIONS as Record<string, { tier?: string }>)[row.operation]?.tier;
    return holdEstimateMicros(tier);
  }
  return 0;
}
