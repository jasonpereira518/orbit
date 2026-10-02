import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { getDb, rowsOf, runAtomicBatch } from "@/db";
import { creditGrants, creditHolds } from "@/db/schema";
import { PLAN_CONFIG, type Plan } from "@/lib/plans/plan-config";
import { creditsToMicros } from "@/lib/credits/grants";

/**
 * The managed-AI credit ledger: allowances, holds, settlement and the balance.
 *
 * THE MODEL (see `creditGrants` in `src/db/schema.ts`). The grant rows are the balance. What
 * is spendable right now is the sum of `micros_remaining` over the account's active grants
 * that are usable now, less its open holds:
 *   - an allowance only inside its own billing period (it never rolls over);
 *   - an admin adjustment always;
 *   - a pack only while the account's plan includes managed AI. A downgrade therefore
 *     FREEZES packs by rule — nothing is written — and a resubscribe finds them intact.
 * Spending takes allowance first, then adjustments, then packs oldest-first.
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

/** Whether this plan's packs are spendable (Pro and Max). Frozen everywhere else. */
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
 */
export async function ensureAllowance(
  userId: string,
  plan: Plan,
  period: CreditPeriod,
  now = new Date()
): Promise<void> {
  const credits = PLAN_CONFIG[plan].monthlyCredits;
  if (!credits || (plan !== "orbit" && plan !== "max")) return;
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

/** SQL: spendable micros for `userId` now, before holds. */
function spendableSql(userId: string, packs: boolean) {
  return sql`(SELECT coalesce(sum(g.micros_remaining), 0) FROM credit_grants g
    WHERE g.user_id = ${userId} AND g.status = 'active' AND g.micros_remaining > 0 AND (
      (g.kind = 'allowance' AND g.period_start <= now() AND g.period_end > now())
      OR g.kind = 'adjustment'
      OR (g.kind = 'pack' AND ${packs})
    ))`;
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
      RETURNING id`),
  ]);
  const inserted = rowsOf<{ id: string }>(results[1] as never);
  return inserted[0]?.id ?? null;
}

/**
 * Deduct a managed call's real cost, allowance first, then adjustments, then packs
 * oldest-first, and release the oldest open hold for its operation. Never takes a grant
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
            ORDER BY CASE g.kind WHEN 'allowance' THEN 0 WHEN 'adjustment' THEN 1 ELSE 2 END, g.created_at, g.id
          ) AS running
        FROM credit_grants g
        WHERE g.user_id = ${input.userId} AND g.status = 'active' AND g.micros_remaining > 0 AND (
          (g.kind = 'allowance' AND g.period_start <= now() AND g.period_end > now())
          OR g.kind IN ('adjustment', 'pack')
        )
      )
      UPDATE credit_grants g
         SET micros_remaining = least(u.micros_remaining, greatest(0, u.running - ${amount})),
             updated_at = now()
        FROM usable u
       WHERE g.id = u.id AND u.running - u.micros_remaining < ${amount}`),
    tx.execute(sql`DELETE FROM credit_holds WHERE id = (
        SELECT id FROM credit_holds
         WHERE user_id = ${input.userId} AND operation = ${input.operation}
         ORDER BY created_at, id LIMIT 1
      )`),
  ]);
}

/** Release a hold without charging (a batch that finished or failed, a refused call). */
export async function releaseHold(userId: string, operation: string): Promise<void> {
  const db = await getDb();
  await db.delete(creditHolds).where(and(eq(creditHolds.userId, userId), eq(creditHolds.operation, operation)));
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
  /** Purchased pack credits still unused (spendable only on Pro and Max). */
  packRemaining: number;
  /** Packs exist but the plan cannot spend them (downgraded): kept, frozen. */
  packsFrozen: boolean;
  /** Packs bought in the current cycle — the Max nudge counts these. */
  packsThisCycle: number;
  /** Micros held by calls in flight. */
  held: number;
  /** What the next call can draw on: allowance + usable packs + adjustments − held. */
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
  // Read-only callers (the notification poll) pass `ensure: false`: a missing allowance just
  // reads as none yet, and the next AI call or visit to the card creates it.
  if (opts.ensure !== false && PLAN_CONFIG[plan].features.hostedAi) await ensureAllowance(userId, plan, period, now);
  const db = await getDb();
  const [grants, holds] = await Promise.all([
    db
      .select()
      .from(creditGrants)
      .where(and(eq(creditGrants.userId, userId), eq(creditGrants.status, "active"))),
    db
      .select({ micros: sql<string>`coalesce(sum(${creditHolds.micros}), 0)` })
      .from(creditHolds)
      .where(and(eq(creditHolds.userId, userId), gt(creditHolds.expiresAt, now))),
  ]);
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
  const usable = packsUsable(plan);
  const held = Number(holds[0]?.micros ?? 0);
  const allowanceRemaining = allowanceGrant?.microsRemaining ?? 0;
  const cycleStart = allowanceGrant?.periodStart ?? period.start;
  // Revoked packs still count as bought for the nudge, so read them separately.
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(creditGrants)
    .where(and(eq(creditGrants.userId, userId), eq(creditGrants.kind, "pack"), gt(creditGrants.createdAt, cycleStart)));
  return {
    allowance: allowanceGrant
      ? {
          granted: allowanceGrant.microsGranted,
          remaining: allowanceRemaining,
          periodStart: allowanceGrant.periodStart!.toISOString(),
          periodEnd: allowanceGrant.periodEnd!.toISOString(),
        }
      : null,
    packRemaining,
    packsFrozen: !usable && packRemaining > 0,
    packsThisCycle: n,
    held,
    spendable: Math.max(0, allowanceRemaining + adjustments + (usable ? packRemaining : 0) - held),
  };
}

/** What an unpriced managed call costs the balance (Whisper and Gemini embeddings report none). */
const UNPRICED_MICROS: Record<string, number> = { transcription: 6_000, embedding: 50 };
const UNPRICED_OTHER_MICROS = 2_000;

/**
 * Settle one managed call from its usage row. Only LLM calls on Orbit's key spend credits:
 * Deepgram has its own hours meter, and a failed call that reported no tokens costs nothing.
 */
export async function settleManagedUsage(row: {
  userId: string;
  operation: string;
  provider: string;
  kind: string;
  keyOwner: "user" | "orbit";
  success: number;
  estimatedCostMicros: number | null;
}): Promise<void> {
  if (row.keyOwner !== "orbit" || row.provider === "deepgram" || row.provider === "typesafe") return;
  const micros =
    row.estimatedCostMicros ??
    (row.success === 1 ? (UNPRICED_MICROS[row.kind] ?? UNPRICED_OTHER_MICROS) : 0);
  await settleCredits({ userId: row.userId, operation: row.operation, micros });
}
