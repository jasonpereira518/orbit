import Link from "next/link";
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
import { USAGE_EVENT_RETENTION_DAYS } from "@/lib/admin-health";
import { MIN_RATE_DENOMINATOR } from "@/lib/format-rate";
import { MoneyTabs } from "@/components/admin/admin-tabs";
import { DistributionChart, RankedBars, RevenueCostChart } from "@/components/admin/charts";
import { CostEntryForm } from "@/components/admin/money/cost-forms";
import { formatCents, formatMicros } from "@/lib/format-money";
import { deepgramCostMicros, managedAiCostMicros } from "@/lib/credits/admin-credits";
import { breakEvenSubscribers, infraBreakdown, monthStart } from "@/lib/infra-costs";
import { acquisitionByChannel, estimatedStripeFeesCents } from "@/lib/money-costs";
import {
  cashFlowSeries,
  costToRunBreakdown,
  costToRunPerUser,
  paidSignupsByChannel,
  planUnitEconomics,
  type EconomicsPlan,
} from "@/lib/money-metrics";
import { PLAN_CONFIG, PLAN_LABELS } from "@/lib/plans/plan-config";
import { weeklyActiveNetworkers } from "@/lib/product-metrics";
import { creditRunwayDays } from "@/lib/speech-cost";
import { proSubscriberSpeechSpend, speechCreditState, speechSpendMicros } from "@/lib/speech-credit";

export const metadata = { title: "Admin · Money · Costs" };

const MONTH = new Intl.DateTimeFormat("en", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

const planLabel = (plan: EconomicsPlan) => (plan === "comped" ? "Comped" : PLAN_LABELS[plan]);

/**
 * What Orbit spends, what its users spend running it, and whether what comes in covers it.
 *
 * Two kinds of AI money are on this page and they must not be confused. ORBIT'S: included AI
 * runs on Orbit's keys on every plan (each plan's monthly credits, a hard stop per account),
 * plus Deepgram, priced from `speech_usage` and drawn from a prepaid credit. THE USERS': any
 * account may bring its own key, and that spend is on their provider account. The spend
 * distribution, the by-model and by-operation bars and the heaviest-accounts ranking count
 * BOTH — they answer "what does running Orbit cost", which decides whether BYOK stays viable
 * — while the tiles, the chart and unit economics count only Orbit's.
 */
export default async function MoneyCostsPage() {
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 86_400_000);
  // THE CAC window, shared with /admin/yc/economics: month-aligned, because acquisition spend
  // belongs to one calendar month. Per-channel spend and signups use the same window.
  const window = cacWindow(now);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

  const [
    flow,
    infra,
    cac,
    acquisition,
    channels,
    orbitKeyMicros,
    deepgram30dMicros,
    wan,
    breakdown,
    perUser,
    speechMonthMicros,
    speechWeekMicros,
    credit,
    proSpeech,
    planEconomics,
  ] = await Promise.all([
    cashFlowSeries(6),
    infraBreakdown(monthStart(now)),
    cacFor(window),
    acquisitionByChannel(window.since, window.until),
    paidSignupsByChannel(window.since),
    // The one Orbit-key AI reader, shared with Overview's credits panel and YC Runway.
    managedAiCostMicros(30, now),
    deepgramCostMicros(30, now),
    weeklyActiveNetworkers(now),
    costToRunBreakdown(30),
    costToRunPerUser("month", 6),
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
  const breakEven = breakEvenSubscribers(fixedMonthlyCents, contributionPerSubscriberCents);

  // What Orbit pays (included AI + Deepgram, customers only) per account active in the month.
  const perActiveMicros = wan.mau > 0 ? (orbitKeyMicros + deepgram30dMicros) / wan.mau : null;

  const latest = perUser.points.at(-1);

  // ONE heaviest-accounts table: accounts costing Orbit more than they bring in this month
  // first (worst first), then the heaviest 30-day spenders on any key. Month figures come
  // from unit economics for every account, so both kinds of row carry the same columns.
  const spend30d = new Map(breakdown.topSpenders.map((r) => [r.userId, r]));
  const heavyIds = [
    ...planEconomics.heavyUsers.map((u) => u.userId),
    ...breakdown.topSpenders.map((r) => r.userId),
  ].filter((id, i, all) => all.indexOf(id) === i);

  const cacRows = acquisition.map((spend) => {
    const channel = channels.find((c) => c.channel === spend.channel);
    const paid = channel?.paid ?? 0;
    return {
      label: spend.channel,
      count: Math.round(spend.spendCents / 100),
      sub: paid,
      cac: paid > 0 ? spend.spendCents / paid : null,
    };
  });

  return (
    <>
      <AdminPageHeader
        title="Costs"
        subtitle="What goes out, what running Orbit costs, and whether what comes in covers it"
      />
      <MoneyTabs />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
            label="On Orbit's AI keys"
            value={formatMicros(orbitKeyMicros)}
            tone="muted"
            hint={`included AI, 30 days, every plan · excludes Deepgram${
              perActiveMicros === null
                ? ""
                : ` · ${formatMicros(perActiveMicros)} per active account with Deepgram (${wan.mau} active)`
            }`}
          />
          <MetricTile
            label="Break-even"
            value={breakEven ?? "—"}
            hint={
              breakEven === null
                ? "no positive contribution"
                : `Pro subscribers at ${formatCents(contributionPerSubscriberCents)} each (after ${formatCents(proSpeechCents)} Deepgram)`
            }
          />
        </div>
        <p className="-mt-3 text-xs text-muted-foreground">
          Stripe fees this month ~{formatCents(feeCents)} (estimated: 2.9% + 30¢ a charge + 0.7%
          Billing) · Deepgram this month {formatMicros(speechMonthMicros)}, {formatMicros(creditLeftMicros)} of
          the prepaid credit left
          {runwayDays === null ? "" : `, ~${Math.round(runwayDays)} days at this week’s pace`}. Each
          account stops at its credits ({PLAN_CONFIG.free.monthlyCredits} Free,{" "}
          {PLAN_CONFIG.orbit.monthlyCredits} Pro, {PLAN_CONFIG.max.monthlyCredits} Max,{" "}
          {PLAN_CONFIG.lifetime.monthlyCredits} Lifetime, plus packs); pause included AI for
          everyone on the{" "}
          <Link href="/admin/billing" className="underline hover:text-primary">
            Overview
          </Link>{" "}
          tab, or set <code>ORBIT_MANAGED_AI=off</code>.
        </p>

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
              const costCents = Math.round(row.costMicros / 10_000);
              return (
                <tr key={row.plan} className="border-b border-border/40 last:border-b-0">
                  <Td>{planLabel(row.plan)}</Td>
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
            shows as a cost. Cost is what Orbit pays: included AI on its keys plus Deepgram; calls on
            an account&apos;s own key cost Orbit nothing here. Dollars, not percentages, until a plan
            has {MIN_RATE_DENOMINATOR} accounts. Internal and tester accounts are left out.
          </p>
        </AdminPanel>

        <AdminPanel title="Spend per account, by month">
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <MetricTile
              label="Median, this month"
              value={formatMicros(latest?.p50Micros ?? 0)}
              hint="per active account, every key"
            />
            <MetricTile
              label="90th percentile"
              value={formatMicros(latest?.p90Micros ?? 0)}
              hint="the heavy tail starts here"
            />
            <MetricTile
              label="Heaviest account"
              value={formatMicros(latest?.maxMicros ?? 0)}
              tone={(latest?.maxMicros ?? 0) > (latest?.p50Micros ?? 0) * 10 ? "accent" : "default"}
              hint="this month"
            />
          </div>
          <DistributionChart
            points={perUser.points.map((p) => ({
              label: MONTH.format(p.bucketStart),
              activeUsers: p.activeUsers,
              p50: p.p50Micros,
              p90: p.p90Micros,
              max: p.maxMicros,
            }))}
          />
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            A spread, not an average: one account at fifty times the median is the whole story,
            and a mean reports it as a mild uptick. Counts every key — Orbit&apos;s included AI
            and accounts&apos; own — plus Deepgram.
            {perUser.clamped && (
              <>
                {" "}
                The window stops at {USAGE_EVENT_RETENTION_DAYS} days because the nightly job
                prunes older usage rows; older months would read as a decline that is entirely the
                delete job.
              </>
            )}
          </p>
        </AdminPanel>

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="By model, 30 days">
            {breakdown.byModel.length === 0 ? (
              <EmptyState>No AI calls in the last 30 days.</EmptyState>
            ) : (
              <MiniBars
                rows={breakdown.byModel.map((row) => ({
                  label: row.label,
                  count: Math.round(row.micros / 10_000),
                }))}
              />
            )}
            <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              Cents of estimated spend, every key. Models missing from the price table report no
              cost at all rather than a confident zero, so a new model can make this understate.
            </p>
          </AdminPanel>

          <AdminPanel title="By operation, 30 days">
            {breakdown.byOperation.length === 0 ? (
              <EmptyState>No AI calls in the last 30 days.</EmptyState>
            ) : (
              <MiniBars
                rows={breakdown.byOperation.map((row) => ({
                  label: row.label,
                  count: Math.round(row.micros / 10_000),
                }))}
              />
            )}
            <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              Which parts of the product are expensive to run. The costly call site is the one
              worth caching, not the frequent one.
            </p>
          </AdminPanel>
        </div>

        <AdminPanel title="Heaviest accounts">
          {heavyIds.length === 0 ? (
            <EmptyState>No AI usage recorded in the last 30 days.</EmptyState>
          ) : (
            <AdminTable label="Heaviest accounts" minWidth="sm"
              head={
                <>
                  <Th>Account</Th>
                  <Th>Plan</Th>
                  <Th numeric>Calls, 30d</Th>
                  <Th numeric>All-key spend, 30d</Th>
                  <Th numeric>Orbit&apos;s cost, month</Th>
                  <Th numeric>Revenue, month</Th>
                </>
              }
            >
              {heavyIds.map((userId) => {
                const month = planEconomics.byAccount.get(userId);
                const spend = spend30d.get(userId);
                const losing = !!month && month.costMicros > 0 && month.costMicros / 10_000 > month.revenueCents;
                return (
                  <tr key={userId} className="border-b border-border/40 last:border-b-0">
                    <Td>
                      <Link href={`/admin/users/${encodeURIComponent(userId)}`} className="hover:text-primary">
                        {userId}
                      </Link>
                    </Td>
                    <Td>{month ? planLabel(month.plan) : "—"}</Td>
                    <Td numeric>{spend ? spend.calls : "—"}</Td>
                    <Td numeric>{spend ? formatMicros(spend.micros) : "—"}</Td>
                    <Td numeric>
                      <span className={losing ? "text-destructive" : undefined}>
                        {month ? formatMicros(month.costMicros) : "—"}
                      </span>
                    </Td>
                    <Td numeric>{month ? formatCents(month.revenueCents) : "—"}</Td>
                  </tr>
                );
              })}
            </AdminTable>
          )}
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Account ids only. Accounts costing Orbit more than they bring in this month come first
            (cost in red; a free account qualifies with any cost), then the ten heaviest 30-day
            spenders on any key. All-key spend includes accounts&apos; own keys, charged to them, not
            Orbit — still worth watching: someone paying {formatCents(proCents)}/mo and spending $40
            on AI is a churn risk the revenue figures never show. &ldquo;—&rdquo; in the 30-day
            columns means outside that top ten.
          </p>
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
              differ from the ledger&apos;s). Attribution is first-touch. Internal, tester and comped
              accounts are in neither side.
            </p>
          </AdminPanel>
        </div>

        <AdminPanel title="Record a cost">
          <CostEntryForm />
        </AdminPanel>
      </div>
    </>
  );
}
