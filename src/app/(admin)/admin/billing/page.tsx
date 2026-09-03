import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  RelativeTime,
  Td,
  Th,
  TrendBars,
} from "@/components/admin/primitives";
import { MoneyTabs } from "@/components/admin/money-tabs";
import { formatCents } from "@/lib/format-money";
import {
  buildPlanBreakdown,
  loadAdminUserRows,
  subscriptionsNeedingAttention,
} from "@/lib/admin-metrics";
import { MONTHLY_CENTS, mrrReconciliation } from "@/lib/billing-events";
import {
  compedForegoneCents,
  cashFlowSeries,
  mrrMovementSeries,
  recentMovements,
  revenueAtRiskCents,
} from "@/lib/money-metrics";
import { countLifetimePurchases } from "@/lib/user-settings";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Money" };

const MONTH = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });

/**
 * Money in, money out, and whether either number can be trusted.
 *
 * The section's landing page stays a ten-second read: the headline figures, the ledger
 * drift alarm, and what needs a decision. Everything that needs a scroll lives behind a
 * tab.
 *
 * MRR is read from the ledger's own reconciliation rather than `subscribers x $5`. The
 * old figure reported the same number the day before and the day after a cancellation.
 */
export default async function AdminMoneyPage() {
  const [
    rows,
    lifetimeSold,
    reconciliation,
    movements,
    flow,
    atRisk,
    comps,
    recent,
  ] = await Promise.all([
    loadAdminUserRows(),
    countLifetimePurchases().catch(() => 0),
    mrrReconciliation(),
    mrrMovementSeries("month", 6),
    cashFlowSeries(3),
    revenueAtRiskCents(),
    compedForegoneCents(MONTHLY_CENTS),
    recentMovements(12),
  ]);

  const plans = buildPlanBreakdown(rows);
  const needsAttention = subscriptionsNeedingAttention(rows);
  const thisMonth = flow.at(-1);
  const drift = reconciliation.driftCents;

  return (
    <>
      <AdminPageHeader
        title="Money"
        subtitle={
          <>
            <span className="tabular-nums">
              {formatCents(reconciliation.liveCents)}
            </span>
            /mo recurring ·{" "}
            <span className="tabular-nums">{lifetimeSold}</span> Lifetime sold ·{" "}
            <span className="tabular-nums">{plans.comped}</span> comped
          </>
        }
      />

      <MoneyTabs />

      <div className="space-y-6">
        {/*
          The one panel that can tell you the rest of the screen is lying, so it sits above
          the figures it validates rather than below them. Two independent derivations of
          the same quantity — live subscription state, and the sum of every recorded
          movement — computed from different tables by different code. They should agree
          exactly; when they do not, a webhook was dropped.
        */}
        {drift !== 0 && (
          <AdminPanel
            title="Ledger drift"
            className="border-destructive/50 bg-destructive/5"
          >
            <div className="flex items-start gap-3 text-sm">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-destructive"
                aria-hidden
              />
              <div>
                <p>
                  Live subscription state says{" "}
                  <span className="tabular-nums">
                    {formatCents(reconciliation.liveCents)}
                  </span>
                  /mo. Replaying every recorded movement says{" "}
                  <span className="tabular-nums">
                    {formatCents(reconciliation.ledgerCents)}
                  </span>
                  /mo — a gap of{" "}
                  <span className="tabular-nums text-destructive">
                    {formatCents(drift)}
                  </span>
                  .
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  These are computed from different tables and should agree exactly. A gap
                  means a webhook never arrived, so every movement figure below is
                  understated by at least this much. Check{" "}
                  <Link href="/admin/health" className="underline hover:text-primary">
                    webhook deliveries
                  </Link>{" "}
                  before trusting anything on this page. Rows written before the ledger
                  existed also show here, and are the one benign cause.
                </p>
              </div>
            </div>
          </AdminPanel>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="Net MRR"
            value={formatCents(reconciliation.liveCents)}
            hint="from live subscription state"
          />
          <MetricTile
            label="ARR"
            value={formatCents(reconciliation.liveCents * 12)}
            hint="MRR × 12, no churn assumption"
          />
          <MetricTile
            label="Cash in, this month"
            value={formatCents(thisMonth?.cashInCents ?? 0)}
            hint="invoices paid + Lifetime"
          />
          <MetricTile
            label="Contribution"
            value={
              thisMonth?.infraMissing
                ? "—"
                : formatCents(thisMonth?.contributionCents ?? 0)
            }
            tone={
              thisMonth?.infraMissing
                ? "muted"
                : (thisMonth?.contributionCents ?? 0) >= 0
                  ? "default"
                  : "danger"
            }
            // An unentered bill is not a zero cost. Saying "—" keeps the most flattering
            // possible margin off the screen until someone types the real number in.
            hint={
              thisMonth?.infraMissing
                ? "no bills entered this month"
                : "cash in less every cost"
            }
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Recurring movement, 6 months">
            <TrendBars
              rows={movements.map((m) => ({
                label: MONTH.format(m.bucketStart),
                count: Math.round((m.newCents + m.reactivationCents) / 100),
                secondary: Math.round(Math.abs(m.churnCents + m.contractionCents) / 100),
                secondaryLabel: "lost",
              }))}
              emptyLabel="No recurring movement recorded yet."
            />
            <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              Dollars per month gained, then lost. Whole dollars, not cents — at this
              volume the cents are noise and the shape is the signal.
            </p>
          </AdminPanel>

          <AdminPanel title="Needs a decision">
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricTile
                label="Past due"
                value={formatCents(atRisk.pastDueCents)}
                tone={atRisk.pastDueCents > 0 ? "danger" : "muted"}
                hint="per month, payment failing"
              />
              <MetricTile
                label="Cancelling"
                value={formatCents(atRisk.cancellingCents)}
                tone={atRisk.cancellingCents > 0 ? "accent" : "muted"}
                hint="per month, still paid through"
              />
              <MetricTile
                label="Comped"
                value={formatCents(comps.foregoneMonthlyCents)}
                tone={comps.comped > 0 ? "accent" : "muted"}
                hint={`${comps.comped} accounts, priced at list`}
              />
              <MetricTile
                label="Lifetime sold"
                value={lifetimeSold}
                hint="one-time purchases"
              />
            </div>
            <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              Money, not headcount. &ldquo;Three past due&rdquo; and &ldquo;
              {formatCents(atRisk.pastDueCents)} past due&rdquo; prompt different
              decisions, and only one of them is the amount at stake.
            </p>
          </AdminPanel>
        </div>

        <AdminPanel title="Subscription health">
          {needsAttention.length === 0 ? (
            <EmptyState>Every subscription is current.</EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Account</Th>
                  <Th>Status</Th>
                  <Th numeric>Access ends</Th>
                  <Th numeric>Contacts</Th>
                </>
              }
            >
              {needsAttention.map((row) => (
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
                    <span
                      className={cn(
                        "inline-flex items-center gap-1",
                        row.subscriptionStatus === "past_due" && "text-destructive"
                      )}
                    >
                      {row.subscriptionStatus === "past_due" && (
                        <AlertTriangle className="size-3" aria-hidden />
                      )}
                      {row.subscriptionStatus}
                    </span>
                  </Td>
                  <Td numeric>
                    {row.subscriptionPeriodEnd
                      ? row.subscriptionPeriodEnd.toISOString().slice(0, 10)
                      : "—"}
                  </Td>
                  <Td numeric>{row.counts.contacts}</Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>

        <AdminPanel title="Recent movements">
          {recent.length === 0 ? (
            <EmptyState>
              Nothing booked yet. Every Stripe event that moves money or changes a
              subscription lands here.
            </EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>When</Th>
                  <Th>Kind</Th>
                  <Th>Account</Th>
                  <Th numeric>Cash</Th>
                  <Th numeric>MRR</Th>
                </>
              }
            >
              {recent.map((row) => (
                <tr key={row.id} className="border-b border-border/40 last:border-b-0">
                  <Td className="text-muted-foreground">
                    <RelativeTime date={row.effectiveAt} />
                  </Td>
                  <Td>{row.kind}</Td>
                  <Td>
                    {row.userId ? (
                      <Link
                        href={`/admin/users/${encodeURIComponent(row.userId)}`}
                        className="hover:text-primary"
                      >
                        {row.userId}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td numeric>
                    {row.amountCents === 0 ? (
                      <span className="text-muted-foreground/50">—</span>
                    ) : (
                      formatCents(row.amountCents)
                    )}
                  </Td>
                  <Td numeric>
                    {row.mrrDeltaCents === 0 ? (
                      <span className="text-muted-foreground/50">—</span>
                    ) : (
                      <span
                        className={
                          row.mrrDeltaCents < 0 ? "text-destructive" : undefined
                        }
                      >
                        {row.mrrDeltaCents > 0 ? "+" : ""}
                        {formatCents(row.mrrDeltaCents)}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            A row carries cash or recurring value, never both — subscription events book a
            rate, invoice and refund events book money. That is what makes the two columns
            safe to sum independently.
          </p>
        </AdminPanel>
      </div>
    </>
  );
}
