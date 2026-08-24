import Link from "next/link";
import { AlertTriangle, TrendingDown } from "lucide-react";
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
} from "@/components/admin/primitives";
import { CopyId } from "@/components/admin/copy-id";
import {
  buildPlanBreakdown,
  displayName,
  loadAdminUserRows,
  subscriptionsNeedingAttention,
} from "@/lib/admin-metrics";
import {
  formatCents,
  getUnitEconomics,
  mrrReconciliation,
} from "@/lib/admin-economics";
import { recentBillingEvents } from "@/lib/billing-events";
import { lifetimeOffer } from "@/lib/lifetime-offer";
import { countLifetimePurchases } from "@/lib/user-settings";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Money" };
export const dynamic = "force-dynamic";

/**
 * Does each account pay for itself, and how many more would it take to break even?
 *
 * A UNIT-ECONOMICS SCREEN, not a growth-story one. Orbit is bootstrapped, so "is this a
 * venture curve" is the wrong question — and it is also the question a dozen accounts
 * cannot answer. Everything here is per-account rather than a rate over a population,
 * which is why it stays meaningful at this size: one account's gross margin is a fact,
 * where one account's churn is 8% and means somebody got busy.
 *
 * WHAT THIS SCREEN CORRECTS. It used to show `subscribers × $5` as MRR — a headcount
 * wearing a currency symbol, reporting the same number the day before and after a
 * cancellation — and total AI spend as "money out". Production is strictly BYOK, so most
 * of that spend is the user's own bill and never touches Orbit. Both numbers were not
 * merely rough; the second pointed the wrong way, so heavier usage looked like higher cost
 * when it was the opposite.
 */
export default async function AdminBillingPage() {
  const [rows, lifetimeSold, offer, ledger, drift] = await Promise.all([
    loadAdminUserRows(),
    countLifetimePurchases().catch(() => 0),
    lifetimeOffer(),
    recentBillingEvents(12).catch(() => []),
    mrrReconciliation().catch(() => null),
  ]);

  const econ = await getUnitEconomics(rows);
  const plans = buildPlanBreakdown(rows);

  const needsAttention = subscriptionsNeedingAttention(rows);
  const comped = rows.filter((r) => r.planSource === "comp");
  const underwater = econ.accounts.filter((a) => a.marginCents < 0);

  return (
    <>
      <AdminPageHeader
        title="Money"
        subtitle={
          <>
            <span className="tabular-nums">{formatCents(econ.mrrCents)}</span>/mo
            recurring · <span className="tabular-nums">{lifetimeSold}</span> Lifetime
            sold · <span className="tabular-nums">{plans.comped}</span> comped
          </>
        }
      />

      <div className="space-y-6">
        {/* A dropped billing webhook is invisible in every other view: both numbers look
            entirely reasonable on their own, and only their disagreement gives it away.
            Orbit has had this failure once already. */}
        {drift && !drift.agrees && (
          <AdminPanel title="Revenue does not reconcile">
            <p className="text-sm text-destructive">
              Live subscriptions total{" "}
              <span className="tabular-nums">{formatCents(drift.liveCents)}</span>/mo, but
              the billing ledger sums to{" "}
              <span className="tabular-nums">{formatCents(drift.ledgerCents)}</span>/mo —
              a gap of{" "}
              <span className="tabular-nums">{formatCents(drift.driftCents)}</span>.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              These are two independent derivations of the same figure. A gap almost always
              means a billing webhook was dropped and never replayed. Subscriptions that
              predate the ledger also show here, and clear themselves on the next renewal.
            </p>
          </AdminPanel>
        )}

        {offer.needsStandardPrice && (
          <AdminPanel title="Lifetime is still selling at the introductory price">
            <p className="text-sm">
              {offer.sold} Lifetime purchases have been made, so the introductory price has
              ended — but <code className="font-mono text-xs">STRIPE_LIFETIME_STANDARD_PRICE_ID</code>{" "}
              is not configured, so buyers are still being charged{" "}
              {formatCents(offer.priceUsd * 100)}.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Deliberate: charging the old price costs money, where advertising one price
              and charging another costs something harder to fix. Add the $49 Stripe price
              to close it.
            </p>
          </AdminPanel>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="In">
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricTile
                label="MRR"
                value={formatCents(econ.mrrCents)}
                hint={`${econ.payingCount} paying account${econ.payingCount === 1 ? "" : "s"}`}
              />
              <MetricTile
                label="Lifetime sold"
                value={String(lifetimeSold)}
                hint={
                  offer.introRemaining !== null
                    ? `${offer.introRemaining} left at $${offer.priceUsd}`
                    : `now $${offer.priceUsd}`
                }
              />
            </div>
          </AdminPanel>

          <AdminPanel title="Out">
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricTile
                label="Variable"
                value={formatCents(econ.variableCostCents)}
                hint="AI on Orbit's key, plus hosted sends"
              />
              <MetricTile
                label="Fixed"
                value={formatCents(econ.fixedCostCents)}
                tone={econ.fixedCostMissing ? "danger" : undefined}
                hint={
                  econ.fixedCostMissing
                    ? "no infra cost entered this month"
                    : "infra, this month"
                }
              />
            </div>
            {/* The correction that matters most on this screen. */}
            <p className="mt-3 text-xs text-muted-foreground">
              Users spent {formatCents(econ.byokCostCents)} on their own provider keys.
              That is their bill, not Orbit&apos;s — production is strictly BYOK — so it is
              deliberately excluded from every figure above.
            </p>
          </AdminPanel>
        </div>

        <AdminPanel title="Break-even">
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricTile
              label="Net this month"
              value={formatCents(econ.netCents)}
              tone={econ.netCents < 0 ? "danger" : undefined}
              hint="revenue − variable − fixed"
            />
            <MetricTile
              label="Per subscriber"
              value={formatCents(econ.contributionPerSubscriberCents)}
              hint="contribution after their variable cost"
            />
            <MetricTile
              label="Subscribers to break even"
              value={
                econ.breakEvenSubscribers === null
                  ? "—"
                  : String(econ.breakEvenSubscribers)
              }
              hint={
                econ.breakEvenSubscribers === null
                  ? "no positive contribution to divide by"
                  : `${econ.payingCount} today`
              }
            />
          </div>
          {econ.fixedCostMissing && (
            <p className="mt-3 text-xs text-destructive">
              No infra cost recorded for this month, so break-even is computed against zero
              fixed cost and reads far better than it is. Add this month&apos;s Vercel, Neon
              and Blob bills to `infra_costs`.
            </p>
          )}
        </AdminPanel>

        <AdminPanel
          title="Margin by account"
          action={
            <span className="text-xs text-muted-foreground">
              worst first
            </span>
          }
        >
          {econ.accounts.length === 0 ? (
            <EmptyState>No accounts yet.</EmptyState>
          ) : (
            <>
              {underwater.length > 0 && (
                <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <TrendingDown className="size-3.5 shrink-0 text-destructive" aria-hidden />
                  {underwater.length} account{underwater.length === 1 ? "" : "s"} cost more
                  than they pay. Comped Orbit Pro is the usual reason — comping Lifetime is
                  free, but comping Pro spends Orbit&apos;s own sending and enrichment credits.
                </p>
              )}
              <AdminTable
                head={
                  <>
                    <Th>Account</Th>
                    <Th>Plan</Th>
                    <Th numeric>Revenue</Th>
                    <Th numeric>Cost</Th>
                    <Th numeric>Margin</Th>
                    <Th numeric>Their own AI</Th>
                  </>
                }
              >
                {econ.accounts.map((a) => (
                  <tr
                    key={a.userId}
                    className="border-b border-border/40 last:border-b-0 hover:bg-muted/40"
                  >
                    <Td>
                      <Link
                        href={`/admin/users/${encodeURIComponent(a.userId)}`}
                        className="hover:text-primary"
                      >
                        {displayName(a)}
                      </Link>
                    </Td>
                    <Td>
                      <PlanBadge plan={a.plan} source={a.planSource} />
                    </Td>
                    <Td numeric>{formatCents(a.revenueCents)}</Td>
                    <Td numeric>{formatCents(a.costCents)}</Td>
                    <Td
                      numeric
                      className={a.marginCents < 0 ? "text-destructive" : undefined}
                    >
                      {formatCents(a.marginCents)}
                    </Td>
                    <Td numeric className="text-muted-foreground">
                      {formatCents(a.byokCostCents)}
                    </Td>
                  </tr>
                ))}
              </AdminTable>
            </>
          )}
        </AdminPanel>

        <AdminPanel title="Concentration">
          <div className="grid gap-3 sm:grid-cols-2">
            <MetricTile
              label="Top account's share of revenue"
              value={
                econ.concentration.topShareOfRevenue === null
                  ? "—"
                  : `${econ.concentration.topShareOfRevenue}%`
              }
              hint={econ.concentration.topRevenueUser ?? "no revenue yet"}
            />
            <MetricTile
              label="Top account's share of AI usage"
              value={
                econ.concentration.topShareOfUsage === null
                  ? "—"
                  : `${econ.concentration.topShareOfUsage}%`
              }
              hint={econ.concentration.topUsageUser ?? "no usage yet"}
            />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            The one risk metric a small user base makes more meaningful rather than less.
            If a single account is most of the activity, then the retention curve, the
            adoption table and the roadmap are all a story about one person.
          </p>
        </AdminPanel>

        <AdminPanel title="Recent billing movements">
          {ledger.length === 0 ? (
            <EmptyState>
              Nothing recorded yet. The ledger fills from Clerk and Stripe webhooks as they
              arrive — it does not backfill, so it stays empty until the next billing event.
            </EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>When</Th>
                  <Th>Movement</Th>
                  <Th>Account</Th>
                  <Th numeric>MRR change</Th>
                  <Th numeric>Cash</Th>
                </>
              }
            >
              {ledger.map((e) => (
                <tr key={e.id} className="border-b border-border/40 last:border-b-0">
                  <Td>
                    <RelativeTime date={e.effectiveAt} />
                  </Td>
                  <Td>{e.kind}</Td>
                  <Td>
                    {e.userId ? (
                      <Link
                        href={`/admin/users/${encodeURIComponent(e.userId)}`}
                        className="hover:text-primary"
                      >
                        <CopyId value={e.userId} />
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">deleted account</span>
                    )}
                  </Td>
                  <Td
                    numeric
                    className={e.mrrDeltaCents < 0 ? "text-destructive" : undefined}
                  >
                    {e.mrrDeltaCents === 0 ? "—" : formatCents(e.mrrDeltaCents)}
                  </Td>
                  <Td numeric>
                    {e.amountCents === 0 ? "—" : formatCents(e.amountCents)}
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>

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
                <tr
                  key={row.userId}
                  className="border-b border-border/40 last:border-b-0"
                >
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
                  <Th numeric>Contacts</Th>
                </>
              }
            >
              {comped.map((row) => (
                <tr
                  key={row.userId}
                  className="border-b border-border/40 last:border-b-0"
                >
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
                  <Td numeric>{row.counts.contacts}</Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>
      </div>
    </>
  );
}
