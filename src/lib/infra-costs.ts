import { desc, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { infraCosts } from "@/db/schema";

/**
 * What Orbit pays to keep the lights on.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Before this table, "money out" on the console was
 * AI spend — and production is strictly BYOK, so most of that is the *user's* spend, not
 * Orbit's. The console was therefore not merely missing a cost figure; the one it showed
 * pointed the wrong way. Gross margin could not be computed and the number that looked
 * most like a cost was mostly not one.
 *
 * ENTERED BY HAND, on purpose. Five numbers a month does not justify a third-party
 * integration, an auth flow, a token to rotate and a new way for the Money screen to fail.
 * The table shape is identical either way, so automating later costs nothing now — and if
 * typing five numbers a month ever becomes tedious, that tedium is the signal that the
 * integration is finally worth it.
 */

/** Providers Orbit actually pays. Free-text in the column so a new one needs no migration. */
export const KNOWN_PROVIDERS = [
  "vercel",
  "neon",
  "blob",
  "clerk",
  "resend",
  "twilio",
  "apollo",
  "domain",
] as const;

/** Normalise any date to the first instant of its month, so a month has one row. */
export function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/**
 * Record or correct one provider's bill for one month.
 *
 * Upserts on `(provider, period_month)`: bills get restated, and the second entry should
 * replace the first rather than double the total.
 */
export async function setInfraCost(input: {
  provider: string;
  month: Date;
  amountCents: number;
  note?: string | null;
}): Promise<void> {
  const db = await getDb();
  const provider = input.provider.trim().toLowerCase();
  const periodMonth = monthStart(input.month);

  await db
    .insert(infraCosts)
    .values({
      provider,
      periodMonth,
      amountCents: Math.round(input.amountCents),
      note: input.note?.trim() || null,
    })
    .onConflictDoUpdate({
      target: [infraCosts.provider, infraCosts.periodMonth],
      set: {
        amountCents: Math.round(input.amountCents),
        note: input.note?.trim() || null,
        updatedAt: new Date(),
      },
    });
}

/** Total fixed cost for one month, in cents. */
export async function monthlyInfraCents(month: Date): Promise<number> {
  const db = await getDb();
  const start = monthStart(month);
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${infraCosts.amountCents}), 0)` })
    .from(infraCosts)
    .where(sql`${infraCosts.periodMonth} = ${start}`);

  const n = Number(rows[0]?.total ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Per-provider breakdown for a month, largest first. */
export async function infraBreakdown(month: Date) {
  const db = await getDb();
  const start = monthStart(month);
  return db
    .select()
    .from(infraCosts)
    .where(sql`${infraCosts.periodMonth} = ${start}`)
    .orderBy(desc(infraCosts.amountCents));
}

/** Recent months, for the trend and for spotting a month nobody entered. */
export async function recentInfraMonths(months = 6) {
  const db = await getDb();
  const since = monthStart(new Date());
  since.setUTCMonth(since.getUTCMonth() - months);

  return db
    .select({
      periodMonth: infraCosts.periodMonth,
      total: sql<string>`coalesce(sum(${infraCosts.amountCents}), 0)`,
    })
    .from(infraCosts)
    .where(gte(infraCosts.periodMonth, since))
    .groupBy(infraCosts.periodMonth)
    .orderBy(desc(infraCosts.periodMonth));
}

/**
 * How many paying subscribers it takes to cover fixed cost.
 *
 * Returns null rather than `Infinity` when contribution per account is zero or negative —
 * "you cannot get there from here" is a different answer from a very large number, and a
 * screen rendering `Infinity` reads as a bug rather than as the finding it is.
 */
export function breakEvenSubscribers(
  fixedMonthlyCents: number,
  contributionPerSubscriberCents: number
): number | null {
  if (contributionPerSubscriberCents <= 0) return null;
  return Math.ceil(fixedMonthlyCents / contributionPerSubscriberCents);
}
