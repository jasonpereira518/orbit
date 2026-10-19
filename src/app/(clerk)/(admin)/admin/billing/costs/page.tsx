import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  MiniBars,
  Td,
  Th,
} from "@/components/admin/primitives";
import { cacFor, cacWindow } from "@/lib/admin-yc-metrics";
import { MIN_RATE_DENOMINATOR } from "@/lib/format-rate";
import { MoneyTabs } from "@/components/admin/money-tabs";
import { RankedBars, RevenueCostChart } from "@/components/admin/charts";
import { CostEntryForm } from "@/components/admin/money/cost-forms";
import { formatCents, formatMicros } from "@/lib/format-money";
import { breakEvenSubscribers, infraBreakdown, monthStart } from "@/lib/infra-costs";
import {
  acquisitionByChannel,
  estimatedStripeFeesCents,
} from "@/lib/money-costs";
import {
  cashFlowSeries,
  costToRunBreakdown,
  paidSignupsByChannel,
  planUnitEconomics,
} from "@/lib/money-metrics";
import { PLAN_CONFIG, PLAN_LABELS } from "@/lib/plans/plan-config";
import { creditRunwayDays } from "@/lib/speech-cost";
import { proSubscriberSpeechSpend, speechCreditState, speechSpendMicros } from "@/lib/speech-credit";

export const metadata = { title: "Admin · Money · Costs" };

const MONTH = new Intl.DateTimeFormat("en", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

/**
 * What Orbit spends, and whether what comes in covers it.
 *
 * Gross margin was not merely unknown before this screen — the figure that looked most
 * like a cost (AI spend) was mostly the USERS' spend, on their own keys, while the largest
 * cost Orbit actually pays — Deepgram — read as nothing at all. Deepgram is priced from
 * `speech_usage` (`speech-cost.ts`) and drawn from a prepaid credit, so it is shown beside
 * the month's bills rather than inside them: it is not cash out until the credit runs dry.
 */
export default async function MoneyCostsPage() {
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 86_400_000);
  // THE CAC window, shared with /admin/yc/economics: month-aligned, because acquisition spend
  // belongs to one calendar month. Per-channel spend and signups use the same window.
  const window = cacWindow(now);

  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const [flow, infra, cac, acquisition, channels, aiSpend, speechMonthMicros, speechWeekMicros, credit, proSpeech, planEconomics] =
    await Promise.all([
      cashFlowSeries(6),
      infraBreakdown(monthStart(now)),
      cacFor(window),
      acquisitionByChannel(window.since, window.until),
      paidSignupsByChannel(window.since),
      costToRunBreakdown(30),
      speechSpendMicros(monthStart(now)),
      speechSpendMicros(weekAgo),
      speechCreditState(),
      proSubscriberSpeechSpend(since),
      planUnitEconomics(now),
    ]);
  const creditLeftMicros = Math.max(0, credit.capMicros - credit.spentMicros);
  const runwayDays = creditRunwayDays(credit.spentMicros, speechWeekMicros / 7);

  const thisMonth = flow.at(-1);
  const fixedMonthlyCents = thisMonth?.costs.totalCents ?? 0;

  // Stripe's cut, estimated from what was actually collected: 30c per charge (the payment
  // and one-time rows behind `cashInCents`), plus Billing's 0.7% on the recurring part.
  // Labelled as an estimate on screen; `cost/reconcile` checks it against the real fees.
  const grossCents = thisMonth?.cashInCents ?? 0;
  const feeCents = estimatedStripeFeesCents(
    grossCents,
    Math.max(thisMonth?.chargeCount ?? 0, grossCents > 0 ? 1 : 0),
    thisMonth?.recurringCents ?? 0
  );

  // Contribution per subscriber is revenue less the variable cost of serving them: Pro's
  // list price, less Stripe's cut, less the whole included-AI allowance (300 credits = $3),
  // less what the average Pro subscriber spent on Deepgram over the last 30 days.
  // Assuming every credit is spent is the ceiling, so break-even here is never flattering.
  const proCents = PLAN_CONFIG.orbit.monthlyPriceCents ?? 0;
  const proSpeechCents =
    proSpeech.subscribers > 0 ? Math.round(proSpeech.micros / proSpeech.subscribers / 10_000) : 0;
  const contributionPerSubscriberCents =
    proCents -
    estimatedStripeFeesCents(proCents, 1, proCents) -
    (PLAN_CONFIG.orbit.monthlyCredits ?? 0) -
    proSpeechCents;
  const breakEven = breakEvenSubscribers(
    fixedMonthlyCents,
    contributionPerSubscriberCents
  );

  const cacRows = acquisition.map((spend) => {
    const channel = channels.find((c) => c.channel === spend.channel);
    const paid = channel?.paid ?? 0;
    return {
      label: spend.channel,
      count: Math.round(spend.spendCents / 100),
      sub: paid,
      subLabel: "paid signups",
      cac: paid > 0 ? spend.spendCents / paid : null,
    };
  });

  return (
    <>
      <AdminPageHeader
        title="Costs"
        subtitle="What goes out, and whether what comes in covers it"
      />
      <MoneyTabs />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <MetricTile
            label="CAC"
            value={cac.cac === null ? "—" : formatCents(Math.round(cac.cac * 100))}
            hint={`${formatCents(Math.round(cac.spendUsd * 100))} spend / ${cac.newSubscribers} new subscribers · ${MONTH.format(window.since)} to now`}
          />
          <MetricTile
            label="Cost this month"
            value={thisMonth?.infraMissing ? "—" : formatCents(fixedMonthlyCents)}
            tone={thisMonth?.infraMissing ? "muted" : "default"}
            hint={
              thisMonth?.infraMissing ? "no bills entered" : "infra + one-off + acquisition"
            }
          />
          <MetricTile
            label="Stripe fees"
            value={formatCents(feeCents)}
            hint="estimated, 2.9% + 30¢ a charge + 0.7% Billing"
          />
          <MetricTile
            label="Deepgram this month"
            value={formatMicros(speechMonthMicros)}
            hint={`est. · ${formatMicros(creditLeftMicros)} of the credit left${
              runwayDays === null ? "" : ` · ~${Math.round(runwayDays)} days at this week’s pace`
            }`}
          />
          <MetricTile
            label="Break-even"
            value={breakEven ?? "—"}
            hint={
              breakEven === null
                ? "no positive contribution"
                : `subscribers at ${formatCents(contributionPerSubscriberCents)} each (after ${formatCents(proSpeechCents)} Deepgram)`
            }
          />
          <MetricTile
            label="On Orbit's AI keys"
            value={formatMicros(aiSpend.orbitKeyMicros)}
            tone="muted"
            hint={`Pro and Max included AI · ${PLAN_CONFIG.orbit.monthlyCredits} / ${PLAN_CONFIG.max.monthlyCredits} credits per account per cycle · excludes Deepgram`}
          />
        </div>

        {/*
         * `keyOwner: "orbit"` is written only for calls the AI gate (`src/lib/ai-access.ts`)
         * ran on a MANAGED key: Pro and Max accounts on included AI. It is a real cost with a
         * hard per-account ceiling (the credit ledger's hard stop), and the ops sweep pages
         * when it outpaces the revenue behind it.
         */}
        {aiSpend.orbitKeyMicros > 0 && (
          <AdminPanel title="AI on Orbit's keys">
            <div className="flex items-start gap-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <p>
                {formatMicros(aiSpend.orbitKeyMicros)} of AI spend in the last 30 days ran on
                Orbit&apos;s managed keys — Pro and Max accounts on included AI. Each account stops at
                its credits ({PLAN_CONFIG.orbit.monthlyCredits} on Pro, {PLAN_CONFIG.max.monthlyCredits} on Max, plus
                any packs); pause managed AI from the Access page, or set{" "}
                <code>ORBIT_MANAGED_AI=off</code> to stop it for everyone at once.
              </p>
            </div>
          </AdminPanel>
        )}

        <AdminPanel title="Cash in against cost out">
          <RevenueCostChart
            points={flow.map((point) => ({
              label: MONTH.format(point.month),
              inCents: point.cashInCents - point.refundedCents,
              outCents: point.costs.totalCents,
              costMissing: point.infraMissing,
            }))}
            breakEvenCents={fixedMonthlyCents > 0 ? fixedMonthlyCents : null}
          />
        </AdminPanel>

        <AdminPanel title={`Unit economics by plan, ${MONTH.format(planEconomics.monthStart)} so far`}>
          <AdminTable label="Unit economics by plan" minWidth="sm"
            head={
              <>
                <Th>Plan</Th>
                <Th numeric>Accounts</Th>
                <Th numeric>Revenue</Th>
                <Th numeric>Cost</Th>
                <Th numeric>Margin</Th>
              </>
            }
          >
            {planEconomics.rows.map((row) => {
              const label = row.plan === "comped" ? "Comped" : PLAN_LABELS[row.plan];
              const costCents = Math.round(row.costMicros / 10_000);
              return (
                <tr key={row.plan} className="border-b border-border/40 last:border-b-0">
                  <Td>{label}</Td>
                  <Td numeric>{row.accounts}</Td>
                  <Td numeric>{formatCents(row.revenueCents)}</Td>
                  <Td numeric>{formatCents(costCents)}</Td>
                  <Td numeric>
                    <span className={row.marginCents < 0 ? "text-destructive" : undefined}>
                      {formatCents(row.marginCents)}
                    </span>
                    {/* A percentage only once the plan has enough accounts to mean something. */}
                    {row.accounts >= MIN_RATE_DENOMINATOR && row.revenueCents > 0 && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({Math.round((row.marginCents / row.revenueCents) * 100)}%)
                      </span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </AdminTable>
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Revenue is each account&apos;s value this month: a subscription&apos;s monthly value (annual
            spread over twelve), a Lifetime purchase spread over 36 months, and credit-pack cash.
            Free and comped accounts earn nothing — comped is its own row so the decision to comp
            shows as a cost. Cost is what Orbit pays: included AI on its keys plus Deepgram; accounts
            on their own AI keys cost Orbit nothing here. Dollars, not percentages, until a plan has{" "}
            {MIN_RATE_DENOMINATOR} accounts. Internal and tester accounts are left out.
          </p>

          <h3 className="mt-4 text-sm font-medium">Costing more than they bring in</h3>
          {planEconomics.heavyUsers.length === 0 ? (
            <EmptyState>No account&apos;s cost this month exceeds its revenue.</EmptyState>
          ) : (
            <AdminTable label="Accounts whose cost exceeds their revenue" minWidth="sm"
              head={
                <>
                  <Th>Account</Th>
                  <Th>Plan</Th>
                  <Th numeric>Revenue</Th>
                  <Th numeric>Cost</Th>
                </>
              }
            >
              {planEconomics.heavyUsers.map((user) => (
                <tr key={user.userId} className="border-b border-border/40 last:border-b-0">
                  <Td>
                    <Link href={`/admin/users/${encodeURIComponent(user.userId)}`} className="hover:text-primary">
                      {user.userId}
                    </Link>
                  </Td>
                  <Td>{user.plan === "comped" ? "Comped" : PLAN_LABELS[user.plan]}</Td>
                  <Td numeric>{formatCents(user.revenueCents)}</Td>
                  <Td numeric>{formatMicros(user.costMicros)}</Td>
                </tr>
              ))}
            </AdminTable>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Account ids only. Free accounts qualify with any cost at all (their revenue is 0), and
            comped accounts are listed separately by plan, not netted against anyone.
          </p>
        </AdminPanel>

        <AdminPanel title="Record a cost">
          <CostEntryForm />
        </AdminPanel>

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Provider bills, this month">
            {infra.length === 0 ? (
              <EmptyState>
                No bills entered for {MONTH.format(monthStart(now))}. Margin stays blank
                until they are — an unentered cost is not a zero cost.
              </EmptyState>
            ) : (
              <MiniBars
                rows={infra.map((row) => ({
                  label: row.provider,
                  count: Math.round(row.amountCents / 100),
                }))}
              />
            )}
          </AdminPanel>

          <AdminPanel title="Acquisition and CAC">
            {cacRows.length === 0 ? (
              <EmptyState>No acquisition spend logged since {MONTH.format(window.since)}.</EmptyState>
            ) : (
              <RankedBars
                rows={cacRows.map((row) => ({
                  label: row.label,
                  count: row.count,
                  sub: row.sub,
                  subLabel: "paid signups",
                  detail:
                    row.cac === null
                      ? "No paid signups yet — CAC is undefined, not infinite."
                      : `${formatCents(Math.round(row.cac))} per paid signup`,
                }))}
                emptyLabel="No acquisition spend logged."
              />
            )}
            <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              Headline CAC above is {formatCents(Math.round(cac.spendUsd * 100))} of spend logged for{" "}
              {MONTH.format(window.since)} to now, over {cac.newSubscribers} new subscribers in the same
              months — the same figure as Unit Economics. This panel splits the spend by channel
              against signups from those months that are paid today (a cohort, so its counts can
              differ from the ledger&apos;s). Attribution is first-touch, so a channel keeps credit for
              someone who read for a week and then typed the URL directly. Internal, tester and comped
              accounts are in neither side.
            </p>
          </AdminPanel>
        </div>
      </div>
    </>
  );
}
