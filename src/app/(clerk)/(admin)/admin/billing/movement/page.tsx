import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  PlanBadge,
  RelativeTime,
  Td,
  Th,
  TrendTable,
} from "@/components/admin/primitives";
import { MoneyTabs } from "@/components/admin/money-tabs";
import { formatCents } from "@/lib/format-money";
import { loadAdminUserRows } from "@/lib/admin-metrics";
import { MONTHLY_CENTS } from "@/lib/billing-events";
import { lifetimeOffer } from "@/lib/lifetime-offer";
import { compedForegoneCents, mrrMovementSeries } from "@/lib/money-metrics";

export const metadata = { title: "Admin · Money · Movement" };

const MONTH = new Intl.DateTimeFormat("en", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});

/**
 * Where the recurring number came from, broken into its parts.
 *
 * A table rather than a chart, deliberately: five signed dollar figures per month is
 * exactly the case `TrendTable` was written for, and printed integers read as "basically
 * nothing happened" where an autoscaled shape would read as a dramatic month.
 */
export default async function MoneyMovementPage() {
  const [movements, offer, comps, rows] = await Promise.all([
    mrrMovementSeries("month", 6),
    lifetimeOffer(),
    compedForegoneCents(MONTHLY_CENTS),
    loadAdminUserRows(),
  ]);

  const comped = rows.filter((r) => r.planSource === "comp");
  const totals = movements.reduce(
    (acc, m) => ({
      newCents: acc.newCents + m.newCents,
      reactivationCents: acc.reactivationCents + m.reactivationCents,
      churnCents: acc.churnCents + m.churnCents,
      oneTimeCents: acc.oneTimeCents + m.oneTimeCents,
    }),
    { newCents: 0, reactivationCents: 0, churnCents: 0, oneTimeCents: 0 }
  );

  return (
    <>
      <AdminPageHeader
        title="Movement"
        subtitle="Every change to recurring revenue, and the one-time sales beside it"
      />
      <MoneyTabs />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="Gained, 6mo"
            value={formatCents(totals.newCents + totals.reactivationCents)}
            hint="new and returning"
          />
          <MetricTile
            label="Lost, 6mo"
            value={formatCents(Math.abs(totals.churnCents))}
            tone={totals.churnCents < 0 ? "danger" : "muted"}
            hint="churned"
          />
          <MetricTile
            label="One-time, 6mo"
            value={formatCents(totals.oneTimeCents)}
            hint="Lifetime purchases"
          />
          <MetricTile
            label="Comped away"
            value={`${formatCents(comps.foregoneMonthlyCents)}/mo`}
            tone={comps.comped > 0 ? "accent" : "muted"}
            hint={`${comps.comped} accounts at list price`}
          />
        </div>

        {/*
         * `needsStandardPrice` goes true once the 100 intro seats are gone and the standard
         * price id is still unset. The product then keeps charging $25 rather than advertise
         * a price it cannot take, which is the right call and a standing $50-per-sale leak.
         * Nothing else in the console says it has started.
         */}
        {offer.needsStandardPrice && (
          <AdminPanel title="Lifetime pricing" className="border-destructive/50 bg-destructive/5">
            <div className="flex items-start gap-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <p>
                All {offer.sold} introductory seats are sold, but{" "}
                <code className="font-mono text-xs">
                  STRIPE_LIFETIME_STANDARD_PRICE_ID
                </code>{" "}
                is unset — so Lifetime is still being sold at $
                {offer.priceUsd} instead of $75. That is the correct fallback (advertising a
                price Stripe cannot charge would be worse) and it costs $50 on every sale
                until the price id is configured.
              </p>
            </div>
          </AdminPanel>
        )}

        <AdminPanel title="Recurring movement by month">
          <TrendTable
            columns={["New", "Return", "Expand", "Contract", "Churn", "Net"]}
            rows={movements.map((m) => ({
              period: MONTH.format(m.bucketStart),
              values: [
                Math.round(m.newCents / 100),
                Math.round(m.reactivationCents / 100),
                Math.round(m.expansionCents / 100),
                Math.round(m.contractionCents / 100),
                Math.round(m.churnCents / 100),
                Math.round(m.netCents / 100),
              ],
            }))}
          />
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Whole dollars per month. <strong>Contract</strong> counts a monthly subscriber
            moving to annual: $5/mo becomes $4.17/mo, so recurring revenue genuinely falls
            while cash goes up. Both are true, and the cash side is on the Costs tab.
          </p>
        </AdminPanel>

        <AdminPanel title="One-time sales">
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricTile label="Sold" value={offer.sold} hint="Lifetime purchases" />
            <MetricTile
              label="Current price"
              value={`$${offer.priceUsd}`}
              hint={offer.isIntro ? "introductory rate" : "standard rate"}
            />
            <MetricTile
              label="Intro seats left"
              value={offer.introRemaining ?? "—"}
              tone={offer.introRemaining === null ? "muted" : "default"}
              hint={offer.introRemaining === null ? "intro period over" : "then $75"}
            />
          </div>
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Revenue is booked from what each buyer actually paid, not from today&apos;s
            price — the offer moves at 100 sales, and the historical figure must not move
            with it.
          </p>
        </AdminPanel>

        <AdminPanel title="Comped accounts">
          {comped.length === 0 ? (
            <EmptyState>Nobody has been comped yet.</EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Account</Th>
                  <Th>Plan</Th>
                  <Th>Reason</Th>
                  <Th numeric>Granted</Th>
                  <Th numeric>Worth</Th>
                </>
              }
            >
              {comped.map((row) => (
                <tr key={row.userId} className="border-b border-border/40 last:border-b-0">
                  <Td>
                    <Link
                      href={`/admin/users/${encodeURIComponent(row.userId)}`}
                      className="hover:text-primary"
                    >
                      {row.email ?? row.userId}
                    </Link>
                  </Td>
                  <Td>
                    <PlanBadge plan={row.plan} source={row.planSource} />
                  </Td>
                  <Td className="max-w-xs truncate text-muted-foreground">
                    {row.compedNote ?? "—"}
                  </Td>
                  <Td numeric>
                    <RelativeTime date={row.compedAt} />
                  </Td>
                  <Td numeric>
                    {row.plan === "orbit" ? `${formatCents(MONTHLY_CENTS)}/mo` : "—"}
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Priced so the decision can be reviewed rather than merely accumulated. A comp
            is revenue chosen not to collect, which is a different thing from free.
          </p>
        </AdminPanel>
      </div>
    </>
  );
}
