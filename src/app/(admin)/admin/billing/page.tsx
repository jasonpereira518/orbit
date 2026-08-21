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
} from "@/components/admin/primitives";
import {
  buildPlanBreakdown,
  loadAdminUserRows,
  subscriptionsNeedingAttention,
} from "@/lib/admin-metrics";
import { formatCostMicros } from "@/lib/ai-pricing";
import { LIFETIME_SEAT_LIMIT, PLAN_LABELS } from "@/lib/plan-limits";
import { MONTHLY_AMOUNT } from "@/lib/plan-copy";
import { countLifetimePurchases } from "@/lib/user-settings";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Money" };

/**
 * Money in AND money out, on one screen.
 *
 * There is deliberately no separate /admin/usage route: at this scale "who pays me" and
 * "who costs me" are the same question and have to be read together. Split it out past a
 * couple hundred accounts — the queries all live in `admin-metrics.ts`, so it is cheap.
 */
export default async function AdminBillingPage() {
  const [rows, lifetimeSold] = await Promise.all([
    loadAdminUserRows(),
    countLifetimePurchases().catch(() => 0),
  ]);

  const plans = buildPlanBreakdown(rows);
  const mrr = plans.subscribed * MONTHLY_AMOUNT;

  const needsAttention = subscriptionsNeedingAttention(rows);
  const comped = rows.filter((r) => r.planSource === "comp");
  const compedPro = comped.filter((r) => r.plan === "orbit");

  const totalCostMicros = rows.reduce((a, r) => a + r.estimatedCostMicros, 0);

  return (
    <>
      <AdminPageHeader
        title="Money"
        subtitle={
          <>
            <span className="tabular-nums">${mrr}</span>/mo recurring ·{" "}
            <span className="tabular-nums">{lifetimeSold}</span> Lifetime sold ·{" "}
            <span className="tabular-nums">{plans.comped}</span> comped
          </>
        }
      />

      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="In">
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricTile
                label="MRR"
                value={`$${mrr}`}
                hint={`${plans.subscribed} × $${MONTHLY_AMOUNT}/mo`}
              />
              <MetricTile
                label="Lifetime seats"
                value={`${lifetimeSold}/${LIFETIME_SEAT_LIMIT}`}
                hint={`${Math.max(0, LIFETIME_SEAT_LIMIT - lifetimeSold)} left`}
              />
            </div>
            <dl className="mt-3 space-y-1 border-t border-border/60 pt-3 text-sm">
              {(["free", "orbit", "lifetime"] as const).map((plan) => (
                <div key={plan} className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{PLAN_LABELS[plan]}</dt>
                  <dd className="tabular-nums">
                    {rows.filter((r) => r.plan === plan).length}
                  </dd>
                </div>
              ))}
            </dl>
            {lifetimeSold === 0 && (
              <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                Lifetime cannot currently be purchased —{" "}
                <code className="font-mono">setLifetimePurchase()</code> has no callers, so
                the Stripe checkout side is not wired up yet.
              </p>
            )}
          </AdminPanel>

          <AdminPanel title="Out">
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricTile
                label="Comped Orbit Pro"
                value={compedPro.length}
                tone={compedPro.length > 0 ? "accent" : "muted"}
                hint="hosted sends on Orbit's credits"
              />
              <MetricTile
                label="Comped Lifetime"
                value={comped.length - compedPro.length}
                tone="muted"
                hint="costs nothing — BYO send keys"
              />
            </div>
            <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
              AI runs on users&apos; own keys in production (
              <code className="font-mono">allowEnvProviderKeys()</code> returns false on
              Vercel), so their{" "}
              <span className="tabular-nums text-foreground">
                {formatCostMicros(totalCostMicros) ?? "$0.00"}
              </span>{" "}
              of estimated AI spend is theirs, not yours. Per-account
              &ldquo;on Orbit&apos;s key&rdquo; counts are on each inspector page.
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
