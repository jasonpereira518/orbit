/**
 * What the ops sweep needs to say about money: the Deepgram credit, month-to-date spend
 * against the budget, and the Monday line with the week's cost per active account.
 *
 * Every figure here is an ESTIMATE built from Orbit's own tables — priced `speech_usage`,
 * Orbit-paid `usage_events`, hand-entered `infra_costs` — and the messages say so.
 * `cost/reconcile` is what holds them to the invoices once a month.
 */
import { and, eq, gt, gte, isNotNull, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { pageViews, speechUsage, usageEvents } from "@/db/schema";
import { managedCostSql } from "@/lib/ai-access";
import { monthStart, monthlyInfraCents } from "@/lib/infra-costs";
import type { SpendOpsFacts } from "@/lib/ops-alerts";
import { DEEPGRAM_CREDIT } from "@/lib/speech-cost";
import { speechSpendMicros } from "@/lib/speech-credit";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `ORBIT_MONTHLY_BUDGET_CENTS`, or null when unset or not a positive number. */
export function monthlyBudgetCents(): number | null {
  const raw = Number(process.env.ORBIT_MONTHLY_BUDGET_CENTS?.trim());
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
}

async function orbitAiMicros(since: Date): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ micros: sql<string>`coalesce(sum(${managedCostSql()}), 0)` })
    .from(usageEvents)
    .where(and(eq(usageEvents.keyOwner, "orbit"), gte(usageEvents.createdAt, since)));
  return Number(row?.micros ?? 0) || 0;
}

export async function loadSpendOpsFacts(now: Date): Promise<SpendOpsFacts> {
  const month = monthStart(now);
  const [creditSpentMicros, speechLast24hMicros, speechLast7dMicros, speechMonthMicros, aiMonthMicros, infraCents] =
    await Promise.all([
      speechSpendMicros(new Date(DEEPGRAM_CREDIT.since)),
      speechSpendMicros(new Date(now.getTime() - DAY_MS)),
      speechSpendMicros(new Date(now.getTime() - 7 * DAY_MS)),
      speechSpendMicros(month),
      orbitAiMicros(month),
      monthlyInfraCents(month),
    ]);
  return {
    creditSpentMicros,
    creditCapMicros: DEEPGRAM_CREDIT.capMicros,
    speechLast24hMicros,
    speechLast7dMicros,
    monthToDateMicros: speechMonthMicros + aiMonthMicros + infraCents * 10_000,
    monthlyBudgetCents: monthlyBudgetCents(),
  };
}

/* ------------------------------------------------------------------ the Monday line ---- */

/** `2026-W43`: the ISO week a report belongs to, so it is sent once per week. */
export function isoWeekKey(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Monday, from 08:00 UTC: after the weekend's traffic is in, before the week gets busy. */
export function weeklyReportDue(now: Date): boolean {
  return now.getUTCDay() === 1 && now.getUTCHours() >= 8;
}

export type WeeklyCostReport = {
  week: string;
  speechMicros: number;
  speechMinutes: number;
  aiMicros: number;
  /** The latest month's entered bills, prorated to seven days. */
  infraMicros: number;
  totalMicros: number;
  weeklyActives: number;
  perActiveMicros: number | null;
  databaseBytes: number | null;
};

export async function loadWeeklyCostReport(now: Date): Promise<WeeklyCostReport> {
  const db = await getDb();
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const [speechMicros, [minutesRow], aiMicros, infraCents, [activesRow], dbSize] = await Promise.all([
    speechSpendMicros(weekAgo),
    db
      .select({ seconds: sql<string>`coalesce(sum(${speechUsage.seconds}), 0)` })
      .from(speechUsage)
      .where(gte(speechUsage.createdAt, weekAgo)),
    orbitAiMicros(weekAgo),
    monthlyInfraCents(monthStart(now)),
    db
      .select({ n: sql<string>`count(distinct ${pageViews.userId})` })
      .from(pageViews)
      .where(
        and(
          isNotNull(pageViews.userId),
          eq(pageViews.isBot, false),
          eq(pageViews.isInternal, false),
          gt(pageViews.createdAt, weekAgo)
        )
      ),
    db
      .execute(sql`SELECT pg_database_size(current_database())::bigint AS bytes`)
      .then((r) => Number(rowsOf<{ bytes: string | number }>(r)[0]?.bytes ?? 0) || null)
      .catch(() => null),
  ]);
  const infraMicros = Math.round((infraCents * 10_000 * 7) / 30);
  const totalMicros = speechMicros + aiMicros + infraMicros;
  const weeklyActives = Number(activesRow?.n ?? 0) || 0;
  return {
    week: isoWeekKey(now),
    speechMicros,
    speechMinutes: Math.round((Number(minutesRow?.seconds ?? 0) || 0) / 60),
    aiMicros,
    infraMicros,
    totalMicros,
    weeklyActives,
    perActiveMicros: weeklyActives > 0 ? totalMicros / weeklyActives : null,
    databaseBytes: dbSize,
  };
}

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/** The one line Slack gets on Monday. Pure, so the smoke test pins its wording. */
export function formatWeeklyCostReport(r: WeeklyCostReport): { title: string; detail: string } {
  const gb = r.databaseBytes === null ? "unknown" : `${(r.databaseBytes / 1024 ** 3).toFixed(2)} GB`;
  return {
    title: `Week ${r.week}: ${usd(r.totalMicros)} estimated spend, ${r.perActiveMicros === null ? "no" : usd(r.perActiveMicros)} per active account`,
    detail:
      `${r.weeklyActives} weekly active account(s). Deepgram ${usd(r.speechMicros)} (${r.speechMinutes} min, from the credit), ` +
      `Orbit-paid AI ${usd(r.aiMicros)}, bills ${usd(r.infraMicros)} (this month's entered bills x 7/30). Database ${gb}. ` +
      `Estimates from Orbit's own tables; cost/reconcile checks them against the invoices.`,
  };
}
