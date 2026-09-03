import { AlertTriangle } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  EmptyState,
  MetricTile,
  MiniBars,
} from "@/components/admin/primitives";
import { MoneyTabs } from "@/components/admin/money-tabs";
import {
  RankedBars,
  RevenueCostChart,
  formatCents,
  formatMicros,
} from "@/components/admin/charts";
import { CostEntryForm } from "@/components/admin/money/cost-forms";
import { MONTHLY_CENTS } from "@/lib/billing-events";
import { breakEvenSubscribers, infraBreakdown, monthStart } from "@/lib/infra-costs";
import {
  acquisitionByChannel,
  estimatedStripeFeesCents,
} from "@/lib/money-costs";
import {
  cashFlowSeries,
  costToRunBreakdown,
  paidSignupsByChannel,
} from "@/lib/money-metrics";

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
 * like a cost (AI spend) is mostly the USERS' spend, because production is strictly BYOK.
 * The console was pointing at the wrong number entirely.
 */
export default async function MoneyCostsPage() {
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 86_400_000);

  const [flow, infra, acquisition, channels, aiSpend] = await Promise.all([
    cashFlowSeries(6),
    infraBreakdown(monthStart(now)),
    acquisitionByChannel(since, now),
    paidSignupsByChannel(since),
    costToRunBreakdown(30),
  ]);

  const thisMonth = flow.at(-1);
  const fixedMonthlyCents = thisMonth?.costs.totalCents ?? 0;

  // Stripe's cut, estimated from what was actually collected. Charge count is approximated
  // by the payment rows behind `cashInCents`; at this volume the fixed 30c term is the
  // part that matters and it is labelled as an estimate on screen either way.
  const grossCents = thisMonth?.cashInCents ?? 0;
  const feeCents = estimatedStripeFeesCents(grossCents, grossCents > 0 ? 1 : 0);

  // Contribution per subscriber is revenue less the variable cost of serving them. Orbit
  // has essentially none — BYOK means the AI bill is the user's — so it is the price less
  // Stripe's cut, and the fixed infrastructure is what has to be cleared.
  const contributionPerSubscriberCents =
    MONTHLY_CENTS - Math.round(MONTHLY_CENTS * 0.029 + 30);
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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
            hint="estimated, 2.9% + 30¢"
          />
          <MetricTile
            label="Break-even"
            value={breakEven ?? "—"}
            hint={
              breakEven === null
                ? "no positive contribution"
                : `subscribers at ${formatCents(contributionPerSubscriberCents)} each`
            }
          />
          <MetricTile
            label="On Orbit's AI key"
            value={formatMicros(aiSpend.orbitKeyMicros)}
            tone={aiSpend.orbitKeyMicros > 0 ? "danger" : "muted"}
            hint={
              aiSpend.orbitKeyMicros > 0 ? "should be zero in production" : "BYOK holding"
            }
          />
        </div>

        {/*
         * `keyOwner: "orbit"` can only be written where `allowEnvProviderKeys()` returns
         * true, which is anywhere that is not Vercel. A non-zero figure in production data
         * therefore means either local-dev rows reaching a shared database, or Orbit's own
         * keys actually serving users. Both are worth knowing immediately.
         */}
        {aiSpend.orbitKeyMicros > 0 && (
          <AdminPanel title="AI on Orbit's key" className="border-destructive/50 bg-destructive/5">
            <div className="flex items-start gap-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <p>
                {formatMicros(aiSpend.orbitKeyMicros)} of AI spend in the last 30 days was
                billed to Orbit&apos;s own keys. Production is strictly bring-your-own-key,
                so this is either local development writing into a shared database, or
                users genuinely running on Orbit&apos;s credit. The second is an unbounded
                cost.
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
              <EmptyState>No acquisition spend logged in the last 30 days.</EmptyState>
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
                emptyLabel="No acquisition spend logged in the last 30 days."
              />
            )}
            <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              Spend in dollars, paid signups beside it. Attribution is first-touch, so a
              channel keeps credit for someone who read for a week and then typed the URL
              directly.
            </p>
          </AdminPanel>
        </div>
      </div>
    </>
  );
}
