import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { researchCreditAccounts, researchCreditHolds, researchCreditLedger } from "@/db/schema";
import { getEntitlements } from "@/lib/entitlements";
import { OUTREACH_ALLOWANCES } from "@/lib/outreach/config";

/**
 * Research credits (spec §7.6). neon-http has no interactive transactions, so every movement is
 * ONE statement: a data-modifying CTE that updates the account row (whose row lock serializes
 * concurrent callers, and whose WHERE is re-checked against the latest row version under READ
 * COMMITTED) and inserts the hold/ledger rows from its RETURNING. Nothing reads a balance and
 * then decides in application code.
 */

type Account = typeof researchCreditAccounts.$inferSelect;

export function addMonthsUtc(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/**
 * Pro monthly credits follow exactly the condition that grants hosted enrichment (a live Orbit
 * Pro subscription or an `orbit` comp — which a Lifetime holder with a live subscription also
 * satisfies). Lifetime credits follow the resolved `lifetime` plan (purchase or comp).
 */
export async function creditEligibility(userId: string): Promise<{ monthly: boolean; lifetime: boolean }> {
  const entitlements = await getEntitlements(userId);
  return { monthly: entitlements.canUseHostedEnrichment, lifetime: entitlements.plan === "lifetime" };
}

async function readAccount(userId: string): Promise<Account> {
  const db = await getDb();
  const [row] = await db.select().from(researchCreditAccounts).where(eq(researchCreditAccounts.userId, userId));
  return row;
}

async function recordGrant(userId: string, amountMonthly: number, amountLifetime: number, periodStart: Date | null, key: string, note: string) {
  if (amountMonthly <= 0 && amountLifetime <= 0) return;
  const db = await getDb();
  await db
    .insert(researchCreditLedger)
    .values({ userId, entryType: "grant", amountMonthly, amountLifetime, periodStart, idempotencyKey: key, note })
    .onConflictDoNothing();
}

export async function ensureCreditAccount(userId: string, now: Date = new Date()): Promise<Account> {
  const db = await getDb();
  const { monthly, lifetime } = await creditEligibility(userId);
  const allowance = monthly ? OUTREACH_ALLOWANCES.orbitMonthly : 0;

  const created = await db
    .insert(researchCreditAccounts)
    .values({ userId, monthlyAllowance: allowance, periodStart: now, periodEnd: addMonthsUtc(now, 1), updatedAt: now })
    .onConflictDoNothing()
    // Bare `.returning()`, not `.returning({ userId })` — an explicit field selector defeats
    // Drizzle's overload resolution after `.onConflictDoNothing()` against the union `Db`
    // type (same trap noted in contact-identity.ts, action-items.ts and import-engine.ts).
    .returning();
  if (created.length) {
    await recordGrant(userId, allowance, 0, now, `grant:monthly:${now.toISOString()}`, "Orbit Pro");
  }

  let account = await readAccount(userId);

  if (account.periodEnd.getTime() <= now.getTime()) {
    let months = 1;
    while (addMonthsUtc(account.periodStart, months + 1).getTime() <= now.getTime()) months++;
    const periodStart = addMonthsUtc(account.periodStart, months);
    const rolled = await db
      .update(researchCreditAccounts)
      .set({ periodStart, periodEnd: addMonthsUtc(periodStart, 1), monthlyUsed: 0, monthlyAllowance: allowance, updatedAt: now })
      // Optimistic: only the caller that sees the old period rolls it; others re-read.
      .where(and(eq(researchCreditAccounts.userId, userId), eq(researchCreditAccounts.periodEnd, account.periodEnd)))
      .returning();
    if (rolled.length) {
      account = rolled[0];
      await recordGrant(userId, allowance, 0, periodStart, `grant:monthly:${periodStart.toISOString()}`, "Orbit Pro");
    } else {
      account = await readAccount(userId);
    }
  }

  // Upgrading mid-period tops the allowance up now rather than at the next rollover.
  if (monthly && account.monthlyAllowance < allowance) {
    const topUp = allowance - account.monthlyAllowance;
    const [raised] = await db
      .update(researchCreditAccounts)
      .set({ monthlyAllowance: allowance, updatedAt: now })
      .where(and(eq(researchCreditAccounts.userId, userId), sql`${researchCreditAccounts.monthlyAllowance} < ${allowance}`))
      .returning();
    if (raised) {
      account = raised;
      await recordGrant(userId, topUp, 0, account.periodStart, `grant:monthly-upgrade:${account.periodStart.toISOString()}`, "Upgraded to Orbit Pro");
    }
  }

  if (lifetime && !account.lifetimeGrantedAt) {
    const amount = OUTREACH_ALLOWANCES.lifetimeOnce;
    await db.execute(sql`
      WITH granted AS (
        UPDATE research_credit_accounts
           SET lifetime_remaining = lifetime_remaining + ${amount}::int,
               lifetime_granted_at = ${now},
               updated_at = ${now}
         WHERE user_id = ${userId} AND lifetime_granted_at IS NULL
        RETURNING user_id
      )
      INSERT INTO research_credit_ledger (user_id, entry_type, amount_monthly, amount_lifetime, idempotency_key, note)
      SELECT user_id, 'grant', 0, ${amount}::int, 'grant:lifetime', 'Orbit Lifetime' FROM granted
      ON CONFLICT (user_id, idempotency_key) DO NOTHING
    `);
    account = await readAccount(userId);
  }

  return account;
}

export type CreditBalance = {
  monthlyAllowance: number;
  monthlyAvailable: number;
  lifetimeAvailable: number;
  total: number;
  held: number;
  periodStart: Date;
  periodEnd: Date;
};

export async function getCreditBalance(userId: string, now: Date = new Date()): Promise<CreditBalance> {
  const account = await ensureCreditAccount(userId, now);
  const monthlyAvailable = Math.max(0, account.monthlyAllowance - account.monthlyUsed - account.monthlyHeld);
  const lifetimeAvailable = Math.max(0, account.lifetimeRemaining - account.lifetimeHeld);
  return {
    monthlyAllowance: account.monthlyAllowance,
    monthlyAvailable,
    lifetimeAvailable,
    total: monthlyAvailable + lifetimeAvailable,
    held: account.monthlyHeld + account.lifetimeHeld,
    periodStart: account.periodStart,
    periodEnd: account.periodEnd,
  };
}

async function holdForKey(userId: string, idempotencyKey: string) {
  const db = await getDb();
  const [entry] = await db
    .select({ holdId: researchCreditLedger.holdId })
    .from(researchCreditLedger)
    .where(and(eq(researchCreditLedger.userId, userId), eq(researchCreditLedger.idempotencyKey, idempotencyKey)));
  if (!entry?.holdId) return null;
  const [hold] = await db
    .select()
    .from(researchCreditHolds)
    .where(and(eq(researchCreditHolds.id, entry.holdId), eq(researchCreditHolds.userId, userId)));
  return hold ? { holdId: hold.id, amount: hold.amountMonthly + hold.amountLifetime } : null;
}

/** Reserve up to `want` (at least `min`), monthly first. Replaying `idempotencyKey` returns the same hold. */
export async function reserveCredits(
  userId: string,
  input: { want: number; min?: number; runId?: string | null; idempotencyKey: string },
  now: Date = new Date()
): Promise<{ holdId: string; amount: number } | null> {
  const want = Math.floor(input.want);
  const min = Math.max(1, Math.floor(input.min ?? 1));
  if (want < min) return null;
  const replay = await holdForKey(userId, input.idempotencyKey);
  if (replay) return replay;
  await ensureCreditAccount(userId, now);
  const db = await getDb();
  const monthlyFree = sql.raw("GREATEST(monthly_allowance - monthly_used - monthly_held, 0)");
  const lifetimeFree = sql.raw("GREATEST(lifetime_remaining - lifetime_held, 0)");
  try {
    const result = await db.execute(sql`
      WITH acct AS (
        UPDATE research_credit_accounts
           SET last_hold_monthly = LEAST(${want}::int, ${monthlyFree}),
               last_hold_lifetime = LEAST(${want}::int - LEAST(${want}::int, ${monthlyFree}), ${lifetimeFree}),
               monthly_held = monthly_held + LEAST(${want}::int, ${monthlyFree}),
               lifetime_held = lifetime_held + LEAST(${want}::int - LEAST(${want}::int, ${monthlyFree}), ${lifetimeFree}),
               updated_at = ${now}
         WHERE user_id = ${userId}
           AND ${monthlyFree} + ${lifetimeFree} >= ${min}::int
        RETURNING user_id, last_hold_monthly, last_hold_lifetime, period_start
      ), hold AS (
        INSERT INTO research_credit_holds (user_id, run_id, amount_monthly, amount_lifetime, period_start)
        SELECT user_id, ${input.runId ?? null}::uuid, last_hold_monthly, last_hold_lifetime, period_start FROM acct
        RETURNING id, amount_monthly, amount_lifetime
      ), ledger AS (
        INSERT INTO research_credit_ledger (user_id, entry_type, amount_monthly, amount_lifetime, hold_id, run_id, idempotency_key)
        SELECT ${userId}, 'reserve', -amount_monthly, -amount_lifetime, id, ${input.runId ?? null}::uuid, ${input.idempotencyKey}
          FROM hold
        RETURNING hold_id
      )
      SELECT id, amount_monthly, amount_lifetime FROM hold
    `);
    const [row] = rowsOf<{ id: string; amount_monthly: number; amount_lifetime: number }>(result);
    return row ? { holdId: row.id, amount: Number(row.amount_monthly) + Number(row.amount_lifetime) } : null;
  } catch (err) {
    // A concurrent replay of the same key lost the unique-index race: the statement rolled back
    // whole, so nothing was reserved twice. Return the winner's hold.
    const winner = await holdForKey(userId, input.idempotencyKey);
    if (winner) return winner;
    throw err;
  }
}

/**
 * Charge one credit for a held attempt. Exactly once per attempt: `locked_hold` takes the
 * hold row's lock FIRST (before the attempt row), so `chargeAttempt` and `releaseHold` always
 * lock hold before attempt(s) — the same order — and cannot deadlock against each other. The
 * `SELECT ... FOR UPDATE` also re-reads the hold's newest committed version after waiting on
 * its lock, so two attempts racing for a hold's last credit serialize correctly instead of one
 * reading a stale "credit available" snapshot.
 */
export async function chargeAttempt(userId: string, attemptId: string, now: Date = new Date()): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(sql`
    WITH locked_hold AS (
      SELECT hh.id
        FROM outreach_research_attempts a
        JOIN research_credit_holds hh ON hh.id = a.hold_id
       WHERE a.id = ${attemptId}::uuid
         AND a.user_id = ${userId}
         AND a.credit_state = 'held'
         AND hh.user_id = ${userId}
         AND hh.status = 'active'
         AND (hh.amount_monthly - hh.used_monthly) + (hh.amount_lifetime - hh.used_lifetime) > 0
         FOR UPDATE OF hh
    ), att AS (
      UPDATE outreach_research_attempts
         SET credit_state = 'charged', updated_at = ${now}
       WHERE id = ${attemptId}::uuid AND user_id = ${userId} AND credit_state = 'held'
         AND hold_id = (SELECT id FROM locked_hold)
      RETURNING hold_id, run_id
    ), h AS (
      UPDATE research_credit_holds
         SET last_charge_bucket = CASE WHEN amount_monthly - used_monthly > 0 THEN 'monthly' ELSE 'lifetime' END,
             used_monthly = used_monthly + CASE WHEN amount_monthly - used_monthly > 0 THEN 1 ELSE 0 END,
             used_lifetime = used_lifetime + CASE WHEN amount_monthly - used_monthly > 0 THEN 0 ELSE 1 END,
             updated_at = ${now}
       WHERE id = (SELECT id FROM locked_hold) AND EXISTS (SELECT 1 FROM att)
      RETURNING id, last_charge_bucket
    ), acct AS (
      UPDATE research_credit_accounts
         SET monthly_held = monthly_held - CASE WHEN (SELECT last_charge_bucket FROM h) = 'monthly' THEN 1 ELSE 0 END,
             monthly_used = monthly_used + CASE WHEN (SELECT last_charge_bucket FROM h) = 'monthly' THEN 1 ELSE 0 END,
             lifetime_held = lifetime_held - CASE WHEN (SELECT last_charge_bucket FROM h) = 'lifetime' THEN 1 ELSE 0 END,
             lifetime_remaining = lifetime_remaining - CASE WHEN (SELECT last_charge_bucket FROM h) = 'lifetime' THEN 1 ELSE 0 END,
             updated_at = ${now}
       WHERE user_id = ${userId} AND EXISTS (SELECT 1 FROM h)
      RETURNING user_id
    )
    INSERT INTO research_credit_ledger (user_id, entry_type, amount_monthly, amount_lifetime, hold_id, run_id, attempt_id, idempotency_key)
    SELECT ${userId}, 'charge',
           CASE WHEN h.last_charge_bucket = 'monthly' THEN -1 ELSE 0 END,
           CASE WHEN h.last_charge_bucket = 'lifetime' THEN -1 ELSE 0 END,
           h.id, (SELECT run_id FROM att), ${attemptId}::uuid, 'charge:' || ${attemptId}
      FROM h
    RETURNING id
  `);
  return rowsOf(result).length > 0;
}

/** Release a hold's unused remainder. Attempts still `held` against it become `released`. */
export async function releaseHold(userId: string, holdId: string, now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const result = await db.execute(sql`
    WITH h AS (
      UPDATE research_credit_holds
         SET status = 'released', updated_at = ${now}
       WHERE id = ${holdId}::uuid AND user_id = ${userId} AND status = 'active'
      RETURNING id, run_id, amount_monthly - used_monthly AS free_monthly, amount_lifetime - used_lifetime AS free_lifetime
    ), acct AS (
      UPDATE research_credit_accounts
         SET monthly_held = GREATEST(monthly_held - (SELECT free_monthly FROM h), 0),
             lifetime_held = GREATEST(lifetime_held - (SELECT free_lifetime FROM h), 0),
             updated_at = ${now}
       WHERE user_id = ${userId} AND EXISTS (SELECT 1 FROM h)
      RETURNING user_id
    ), att AS (
      UPDATE outreach_research_attempts
         SET credit_state = 'released', updated_at = ${now}
       WHERE user_id = ${userId} AND hold_id = ${holdId}::uuid AND credit_state = 'held' AND EXISTS (SELECT 1 FROM h)
      RETURNING id
    )
    INSERT INTO research_credit_ledger (user_id, entry_type, amount_monthly, amount_lifetime, hold_id, run_id, idempotency_key)
    SELECT ${userId}, 'release', free_monthly, free_lifetime, id, run_id, 'release:' || id::text FROM h
    RETURNING amount_monthly, amount_lifetime
  `);
  const [row] = rowsOf<{ amount_monthly: number; amount_lifetime: number }>(result);
  return row ? Number(row.amount_monthly) + Number(row.amount_lifetime) : 0;
}

export async function listCreditLedger(userId: string, limit = 20) {
  const db = await getDb();
  return db
    .select()
    .from(researchCreditLedger)
    .where(eq(researchCreditLedger.userId, userId))
    .orderBy(desc(researchCreditLedger.createdAt))
    .limit(limit);
}
