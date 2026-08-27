import { Suspense } from "react";
import Link from "next/link";
import { AlertTriangle, CircleAlert, Sparkles } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  AdminPanelSkeleton,
  EmptyState,
  MetricTile,
  MiniBars,
  PlanBadge,
  RelativeTime,
} from "@/components/admin/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getAdminOverview,
  loadAdminUserRows,
  type AdminOverview,
} from "@/lib/admin-metrics";
import { decisionsWaiting, type Decision } from "@/lib/admin-decisions";
import { formatCostMicros } from "@/lib/ai-pricing";
import { countLifetimePurchases } from "@/lib/user-settings";
import { LiveProvider, LiveValue } from "@/components/admin/live";
import { SCREEN_TIER } from "@/lib/admin-live-tiers";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Overview" };

/**
 * Triage, not summary.
 *
 * At Orbit's scale the roster *is* the dashboard — every aggregate here is also directly
 * countable from the user list. So this screen's job is to answer "is anything on fire?"
 * in about two seconds, and everything else is secondary.
 *
 * Absolute integers only: no percentages, no rates, no trend sparklines. One new
 * subscriber is +100% MRR growth, and a sparkline of 0,1,0,0,2,1,0 is noise rendered as a
 * shape. Vanity totals (contacts across all accounts) are deliberately absent too — they
 * change no decision.
 *
 * NOT ASYNC, ON PURPOSE. Every promise starts here and is awaited inside the section that
 * needs it, so the shell flushes immediately and each panel arrives on its own query.
 * Before this, the whole screen waited on `decisionsWaiting` — which fans out to eight
 * separate sources — in order to show an alert list that only needs the roster.
 */
export default function AdminOverviewPage() {
  // The Overview and the decisions list both rest on the same six-query roster. Loading
  // it once here and handing the promise to both is what keeps that six from becoming
  // twelve — see `decisionsWaiting` for why this is explicit rather than memoised.
  const rosterPromise = loadAdminUserRows();
  const soldPromise = countLifetimePurchases().catch(() => 0);
  const overviewPromise = getAdminOverview(new Date(), rosterPromise);
  const decisionsPromise = decisionsWaiting(rosterPromise, soldPromise).catch(
    () => []
  );

  return (
    <LiveProvider screen="overview" intervalMs={SCREEN_TIER.overview} initial={{}}>
      <Suspense fallback={<HeaderSkeleton />}>
        <OverviewHeader overview={overviewPromise} />
      </Suspense>

      <div className="space-y-6">
        <Suspense fallback={<AdminPanelSkeleton title="Needs attention" />}>
          <NeedsAttention overview={overviewPromise} />
        </Suspense>

        <Suspense
          fallback={
            <div className="grid gap-6 lg:grid-cols-2">
              <AdminPanelSkeleton title="Activation" />
              <AdminPanelSkeleton title="Signed up recently" />
            </div>
          }
        >
          <ActivationAndRecent overview={overviewPromise} />
        </Suspense>

        <Suspense fallback={<AdminPanelSkeleton title="Money" className="h-20" />}>
          <MoneyPanel overview={overviewPromise} lifetimeSold={soldPromise} />
        </Suspense>

        {/* Below "Needs attention" on purpose. That panel is today's work — things that
            name a person and want a reply. This is the slower list: questions the console
            has been answering for weeks that nobody has acted on, because no single screen
            shouts. Every item is a DECISION rather than a task; anything dispatchable by
            clicking belongs in the panel above.

            Last in the DOM for a second reason now: it is by far the slowest thing on the
            screen, and a panel that streams in above the others would shove everything
            below it down the page while the operator is already reading. */}
        <Suspense fallback={null}>
          <DecisionsPanel decisions={decisionsPromise} />
        </Suspense>
      </div>
    </LiveProvider>
  );
}

/* ------------------------------------------------------------------------ header ---- */

function HeaderSkeleton() {
  return (
    <div className="mb-6">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-2 h-4 w-72" />
    </div>
  );
}

async function OverviewHeader({
  overview,
}: {
  overview: Promise<AdminOverview>;
}) {
  const { totalUsers, plans, alerts } = await overview;
  return (
    <AdminPageHeader
      title="Overview"
      subtitle={
        <>
          <LiveValue name="totalUsers">{totalUsers}</LiveValue> account
          {totalUsers === 1 ? "" : "s"} ·{" "}
          <LiveValue name="paid">{plans.paidTotal}</LiveValue> paid ·{" "}
          <LiveValue name="subscribed">{plans.subscribed}</LiveValue> subscribed ·{" "}
          {alerts.length > 0 ? (
            <span className="text-foreground">
              <span className="tabular-nums">{alerts.length}</span> need
              {alerts.length === 1 ? "s" : ""} attention
            </span>
          ) : (
            "all healthy"
          )}{" "}
          ·{" "}
          <Link
            href="/admin/health"
            className="text-muted-foreground hover:text-primary"
          >
            <LiveValue name="systemIssues">—</LiveValue> system issues
          </Link>
        </>
      }
    />
  );
}

/* --------------------------------------------------------------- needs attention ---- */

async function NeedsAttention({
  overview,
}: {
  overview: Promise<AdminOverview>;
}) {
  const { alerts, totalUsers } = await overview;

  return (
    <AdminPanel title="Needs attention">
      {alerts.length === 0 ? (
        <EmptyState>
          Nothing needs you. {totalUsers} account
          {totalUsers === 1 ? "" : "s"}, all healthy.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border/50">
          {alerts.map((alert, i) => (
            <li key={`${alert.userId}-${i}`}>
              <Link
                href={`/admin/users/${encodeURIComponent(alert.userId)}`}
                className="flex items-center gap-3 py-2 transition-colors duration-fast hover:text-primary"
              >
                {alert.severity === "warn" ? (
                  <AlertTriangle
                    className="size-3.5 shrink-0 text-destructive"
                    aria-hidden
                  />
                ) : (
                  <Sparkles
                    className="size-3.5 shrink-0 text-accent-foreground"
                    aria-hidden
                  />
                )}
                <span className="w-56 shrink-0 truncate">
                  {alert.email ?? alert.userId}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {alert.message}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">→</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AdminPanel>
  );
}

/* ------------------------------------------------------- activation + recent list ---- */

async function ActivationAndRecent({
  overview,
}: {
  overview: Promise<AdminOverview>;
}) {
  const o = await overview;
  const recent = o.rows.slice(0, 6);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <AdminPanel title="Activation">
        <MiniBars rows={o.funnel.map((s) => ({ label: s.label, count: s.count }))} />
        <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground tabular-nums">
          {o.signups.current} new in the last 30 days ({o.signups.previous} in the 30
          before) · {o.activeLast7d} active this week
        </p>
      </AdminPanel>

      <AdminPanel
        title="Signed up recently"
        action={
          <Link
            href="/admin/users"
            className="text-xs text-muted-foreground hover:text-primary"
          >
            All {o.totalUsers} →
          </Link>
        }
      >
        {recent.length === 0 ? (
          <EmptyState>No accounts yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-border/50">
            {recent.map((row) => (
              <li key={row.userId}>
                <Link
                  href={`/admin/users/${encodeURIComponent(row.userId)}`}
                  className="flex items-center gap-3 py-2 transition-colors duration-fast hover:text-primary"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {row.email ?? row.userId}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    <RelativeTime date={row.signupAt} />
                  </span>
                  <PlanBadge plan={row.plan} source={row.planSource} />
                  <span
                    className={cn(
                      "w-20 shrink-0 text-right text-xs tabular-nums",
                      row.counts.contacts === 0 && "text-muted-foreground"
                    )}
                  >
                    {row.counts.contacts} · {row.counts.interactions}
                  </span>
                  {!row.hasProviderKey && (
                    <CircleAlert
                      className="size-3.5 shrink-0 text-destructive"
                      aria-label="No AI key configured"
                    />
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </AdminPanel>
    </div>
  );
}

/* ------------------------------------------------------------------------- money ---- */

async function MoneyPanel({
  overview,
  lifetimeSold,
}: {
  overview: Promise<AdminOverview>;
  lifetimeSold: Promise<number>;
}) {
  const [o, sold] = await Promise.all([overview, lifetimeSold]);
  const totalCost = o.rows.reduce((acc, r) => acc + r.estimatedCostMicros, 0);

  return (
    <AdminPanel
      title="Money"
      action={
        <Link
          href="/admin/billing"
          className="text-xs text-muted-foreground hover:text-primary"
        >
          Full detail →
        </Link>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="Subscribed"
          value={<LiveValue name="subscribed">{o.plans.subscribed}</LiveValue>}
          hint="Orbit Pro, recurring"
        />
        <MetricTile
          label="Lifetime sold"
          value={<LiveValue name="lifetimeSold">{sold}</LiveValue>}
          hint="one-time purchases"
        />
        <MetricTile
          label="Comped"
          value={<LiveValue name="comped">{o.plans.comped}</LiveValue>}
          tone="accent"
          hint="granted by hand"
        />
        <MetricTile
          label="AI spend (BYOK)"
          value={formatCostMicros(totalCost) ?? "—"}
          tone="muted"
          hint="on users' own keys"
        />
      </div>
    </AdminPanel>
  );
}

/* --------------------------------------------------------------------- decisions ---- */

async function DecisionsPanel({ decisions }: { decisions: Promise<Decision[]> }) {
  const list = await decisions;
  if (list.length === 0) return null;

  return (
    <AdminPanel
      title="Decisions waiting"
      action={
        <span className="text-xs text-muted-foreground">nothing here is urgent</span>
      }
    >
      <ul className="space-y-3">
        {list.map((d) => (
          <li key={d.id} className="border-b border-border/40 pb-3 last:border-b-0">
            <Link href={d.href} className="flex items-start gap-2 hover:text-primary">
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  d.tone === "act" ? "bg-destructive" : "bg-muted-foreground/50"
                )}
              />
              <span className="text-sm">{d.headline}</span>
            </Link>
            <p className="ml-3.5 mt-0.5 text-xs text-muted-foreground">{d.detail}</p>
          </li>
        ))}
      </ul>
    </AdminPanel>
  );
}
