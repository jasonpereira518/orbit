import Link from "next/link";
import { AdminPageHeader, AdminPanel, DefinitionRow, MetricTile } from "@/components/admin/primitives";
import {
  EstimatedChurnForm,
  LogAcquisitionSpendForm,
} from "@/components/admin/yc/economics-forms";
import { loadUnitEconomics } from "@/lib/admin-yc-metrics";
import { formatCents } from "@/lib/format-money";

export const metadata = { title: "Admin · Unit Economics" };

const usd = (value: number) => `$${Math.round(value).toLocaleString()}`;
const MONTH = new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" });

/**
 * CAC, LTV and payback, from the billing ledger.
 *
 * CAC is the same number the Money > Costs page shows (`cacFor`). LTV is built from observed
 * revenue, margin and churn once the window has enough subscriber time; before that it falls
 * back to the typed churn estimate and says so, in words, on the tile.
 */
export default async function UnitEconomicsPage() {
  const e = await loadUnitEconomics();
  const { ltv } = e;
  const windowLabel = `${MONTH.format(e.cacWindow.since)} to now (${e.cacWindow.months} months, this one so far)`;

  const ltvHint =
    ltv.basis === "observed"
      ? `observed churn ${ltv.churnPct.toFixed(1)}%/mo over ${e.trailingDays} days`
      : ltv.basis === "estimate"
        ? `ESTIMATE — typed churn ${ltv.churnPct}%/mo; ${Math.round(e.subscriberMonths)} of ${e.minSubscriberMonths} subscriber-months observed`
        : ltv.reason;

  return (
    <>
      <AdminPageHeader
        title="Unit Economics"
        subtitle="CAC from logged acquisition spend; LTV and payback from the billing ledger. Internal, tester and comped accounts are left out of every figure."
      />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="CAC"
            value={e.cac === null ? "—" : `$${e.cac.toFixed(0)}`}
            hint={`${usd(e.spendUsd)} / ${e.newSubscribers} new · ${windowLabel}`}
          />
          <MetricTile
            label={ltv.basis === "estimate" ? "LTV (estimate)" : "LTV"}
            value={ltv.ltvUsd === null ? "—" : usd(ltv.ltvUsd)}
            tone={ltv.basis === "estimate" ? "muted" : "default"}
            hint={ltvHint}
          />
          <MetricTile
            label="LTV : CAC"
            value={e.ltvToCac === null ? "—" : `${e.ltvToCac.toFixed(1)}x`}
            tone={e.ltvToCac !== null && e.ltvToCac < 3 ? "danger" : "default"}
            hint={ltv.basis === "estimate" ? "uses the estimated LTV" : undefined}
          />
          <MetricTile
            label="Payback"
            value={e.paybackMonths === null ? "—" : `${e.paybackMonths.toFixed(1)} mo`}
            hint="CAC ÷ (ARPA × gross margin)"
          />
        </div>

        <AdminPanel title={`How LTV is built (trailing ${e.trailingDays} days)`}>
          <dl className="space-y-0">
            <DefinitionRow label="ARPA">
              {e.arpaUsd === null ? (
                "no paying subscriber time yet"
              ) : (
                <>
                  {`$${e.arpaUsd.toFixed(2)}`} per paying account per month · recurring only, so the plan
                  mix, annual discounts and founding prices are in it and Lifetime and packs are not
                </>
              )}
            </DefinitionRow>
            <DefinitionRow label="Gross margin">
              {e.grossMargin === null ? (
                "no revenue in the window"
              ) : (
                <>
                  {`${Math.round(e.grossMargin * 100)}%`} · {formatCents(e.revenueCents)} revenue less{" "}
                  {formatCents(e.costBreakdown.aiCents)} included AI, {formatCents(e.costBreakdown.speechCents)}{" "}
                  Deepgram and {formatCents(e.costBreakdown.feesCents)} Stripe fees (estimated)
                </>
              )}
            </DefinitionRow>
            <DefinitionRow label="Monthly churn">
              {e.subscriberMonths >= e.minSubscriberMonths && e.observedChurnPct !== null ? (
                <>
                  {`${e.observedChurnPct.toFixed(1)}%`} observed · {e.churnedLogos} lost over{" "}
                  {Math.round(e.subscriberMonths)} subscriber-months
                </>
              ) : (
                <>
                  not shown — {e.churnedLogos} lost over {Math.round(e.subscriberMonths)} of{" "}
                  {e.minSubscriberMonths} subscriber-months needed. With this few, one cancellation
                  moves the rate by points.
                </>
              )}
            </DefinitionRow>
            <DefinitionRow label="Typed estimate">
              {e.estimatedMonthlyChurnPct === null ? (
                "not set"
              ) : (
                <>
                  {`${e.estimatedMonthlyChurnPct}%`}/mo · one site-wide value, stored on{" "}
                  {e.churnOverrideOwnerId ? (
                    <Link href={`/admin/users/${encodeURIComponent(e.churnOverrideOwnerId)}`} className="underline hover:text-primary">
                      the first admin account that set it
                    </Link>
                  ) : (
                    "an admin account"
                  )}
                  ; used only until the observed rate is trusted
                </>
              )}
            </DefinitionRow>
          </dl>
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            CAC window: acquisition spend logged for {windowLabel}, divided by ledger &ldquo;new&rdquo;
            subscribers in the same window. The current month is included, and its spend is usually
            entered after the fact, so it flatters CAC until it is. Each spend row belongs to one
            calendar month, so it can never be counted twice. LTV = ARPA × gross margin ÷ monthly
            churn.
          </p>
        </AdminPanel>

        <AdminPanel title="Update">
          <div className="space-y-4">
            <EstimatedChurnForm currentPct={e.estimatedMonthlyChurnPct} />
            <LogAcquisitionSpendForm />
          </div>
        </AdminPanel>
      </div>
    </>
  );
}
