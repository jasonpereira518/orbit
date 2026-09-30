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
  ADMIN_AGGREGATES_TTL_MS,
  buildPlanBreakdown,
  loadAdminUserRows,
  subscriptionsNeedingAttention,
} from "@/lib/admin-metrics";
import { mrrReconciliation } from "@/lib/billing-events";
import { loadCreditsMoney, planDistribution } from "@/lib/credits/admin-credits";
import { getManagedAiSwitchState } from "@/lib/managed-ai-switch";
import { ManagedAiSwitch } from "@/components/admin/managed-ai-switch";
import { PLAN_LABELS } from "@/lib/plans/plan-config";
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
    // Plans and billing columns come from user_settings and are always live; only the
    // per-account counts may lag, by the same TTL the overview uses.
    loadAdminUserRows({ aggregatesMaxAgeMs: ADMIN_AGGREGATES_TTL_MS }),
    countLifetimePurchases().catch(() => 0),
    mrrReconciliation(),
    mrrMovementSeries("month", 6),
    cashFlowSeries(3),
    revenueAtRiskCents(),
    compedForegoneCents(),
    recentMovements(12),
  ]);

  const spendable = new Set(rows.filter((r) => r.plan === "orbit" || r.plan === "max").map((r) => r.userId));
  const [credits, distribution, managedSwitch] = await Promise.all([
    loadCreditsMoney(spendable),
    planDistribution(rows),
    getManagedAiSwitchState(),
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
            hint="invoices, credit packs, legacy Lifetime"
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

        <AdminPanel title="Plans">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div data-plan="free">
              <MetricTile label={PLAN_LABELS.free} value={distribution.free} hint="accounts" />
            </div>
            {(["orbit", "max", "lifetime"] as const).map((plan) => {
              const d = distribution[plan];
              return (
                <div key={plan} data-plan={plan} className="rounded-xl border-l-2 border-tier-border">
                  <MetricTile
                    label={PLAN_LABELS[plan]}
                    value={d.founding + d.standard}
                    hint={plan === "lifetime" ? "admin-granted or bought before v2" : `${d.founding} founding · ${d.standard} standard`}
                  />
                </div>
              );
            })}
          </div>
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Founding means a paying subscription whose founding discount is still running. Comped
            accounts count under their plan and are never founding.
          </p>
        </AdminPanel>

        <AdminPanel title="Credits and included AI, last 30 days">
          {!credits.reconciliation.ok && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <p>
                Pack ledger and grants disagree: {credits.reconciliation.packsBooked} pack sales booked vs{" "}
                {credits.reconciliation.packGrants} packs granted. A webhook was dropped or a grant failed — check
                webhook deliveries.
              </p>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricTile
              label="Credit packs"
              value={formatCents(credits.packs.cashInWindowCents)}
              hint={`${credits.packs.soldInWindow} sold · one-time, not MRR${
                credits.packs.revokedAllTime > 0 ? ` · ${credits.packs.revokedAllTime} revoked ever` : ""
              }`}
            />
            <MetricTile
              label="Pack liability"
              value={formatCents(credits.liability.cents)}
              tone={credits.liability.cents > 0 ? "accent" : "muted"}
              hint={`${credits.liability.unusedCredits} unused credits${
                credits.liability.frozenCents > 0 ? ` · ${formatCents(credits.liability.frozenCents)} frozen` : ""
              }`}
            />
            <MetricTile
              label="Allowance used"
              value={
                credits.allowance.grantedCredits > 0
                  ? `${Math.round((credits.allowance.usedCredits / credits.allowance.grantedCredits) * 100)}%`
                  : "—"
              }
              hint={`${credits.allowance.usedCredits} of ${credits.allowance.grantedCredits} credits · ${credits.allowance.accounts} accounts this cycle`}
            />
            <MetricTile
              label="Included AI cost"
              value={formatCents(Math.round(credits.managedAi.costMicros / 10_000))}
              hint={`${credits.managedAi.calls} calls · ${credits.managedAi.accounts} accounts`}
            />
          </div>

          <div className="mt-4 border-t border-border/60 pt-4">
            <ManagedAiSwitch state={managedSwitch} />
          </div>

          {credits.managedAi.topSpenders.length > 0 && (
            <div className="mt-4 border-t border-border/60 pt-4">
              <AdminTable
                minWidth="sm"
                head={
                  <>
                    <Th>Account</Th>
                    <Th numeric>Calls</Th>
                    <Th numeric>Model cost</Th>
                  </>
                }
              >
                {credits.managedAi.topSpenders.map((row) => (
                  <tr key={row.userId} className="border-b border-border/40 last:border-b-0">
                    <Td>
                      <Link href={`/admin/users/${encodeURIComponent(row.userId)}`} className="hover:text-primary">
                        {row.userId}
                      </Link>
                    </Td>
                    <Td numeric>{row.calls}</Td>
                    <Td numeric>{formatCents(Math.round(row.micros / 10_000))}</Td>
                  </tr>
                ))}
              </AdminTable>
            </div>
          )}
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Liability is what buyers paid for the pack credits they have not used yet — the most a
            refund of every live pack could return. Frozen credits belong to accounts no longer on
            Pro or Max and come back if they resubscribe. Included AI cost is real model cost on
            Orbit&apos;s keys; it is also a line of burn on the Runway page.
          </p>
        </AdminPanel>

        <AdminPanel title="Subscription health">
          {needsAttention.length === 0 ? (
            <EmptyState>Every subscription is current.</EmptyState>
          ) : (
            <AdminTable minWidth="sm"
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
