import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  MiniBars,
  PlanBadge,
  RelativeTime,
  Td,
  Th,
  TrendBars,
} from "@/components/admin/primitives";
import {
  buildPlanBreakdown,
  loadAdminUserRows,
  subscriptionsNeedingAttention,
} from "@/lib/admin-metrics";
import {
  activationTrend,
  activeTrend,
  aiVolumeTrend,
  featureAdoption,
  retentionCohorts,
  signupTrend,
  type Grain,
} from "@/lib/admin-trends";
import { formatCostMicros } from "@/lib/ai-pricing";
import {
  getReliabilitySummary,
  operationalEventTrend,
} from "@/lib/operational-events";
import { LIFETIME_INTRO_SEATS } from "@/lib/plan-limits";
import { MONTHLY_AMOUNT } from "@/lib/plan-copy";
import { countLifetimePurchases } from "@/lib/user-settings";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Metrics" };

const VIEWS = [
  ["growth", "Growth"],
  ["activation", "Activation & retention"],
  ["revenue", "Revenue"],
  ["ai", "AI usage"],
  ["reliability", "Reliability"],
] as const;
type View = (typeof VIEWS)[number][0];

const WINDOW_DAYS = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 } as const;

export default async function AdminMetricsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; window?: string }>;
}) {
  const params = await searchParams;
  const view: View = VIEWS.some(([id]) => id === params.view)
    ? (params.view as View)
    : "growth";
  const windowKey = params.window && params.window in WINDOW_DAYS
    ? (params.window as keyof typeof WINDOW_DAYS)
    : "30d";
  const days = WINDOW_DAYS[windowKey];
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const previousStart = new Date(windowStart.getTime() - days * 24 * 60 * 60 * 1000);
  const grain: Grain = days >= 90 ? "month" : "week";
  const buckets = grain === "month" ? 12 : 12;

  const href = (target: View) => `/admin/metrics?view=${target}&window=${windowKey}`;

  return (
    <>
      <AdminPageHeader
        title="Metrics"
        subtitle={`Business and operating signals for the last ${days === 1 ? "24 hours" : `${days} days`}.`}
      />

      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-border/70" aria-label="Metric views">
        {VIEWS.map(([id, label]) => (
          <Link
            key={id}
            href={href(id)}
            aria-current={view === id ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2 text-sm transition-colors",
              view === id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </Link>
        ))}
      </nav>

      {view === "growth" && <GrowthMetrics grain={grain} buckets={buckets} windowStart={windowStart} />}
      {view === "activation" && <ActivationMetrics grain={grain} buckets={buckets} />}
      {view === "revenue" && <RevenueMetrics />}
      {view === "ai" && <AiMetrics grain={grain} buckets={buckets} windowStart={windowStart} />}
      {view === "reliability" && (
        <ReliabilityMetrics days={days} windowStart={windowStart} previousStart={previousStart} />
      )}
    </>
  );
}

function dateLabel(date: Date, grain: Grain) {
  return grain === "month"
    ? date.toISOString().slice(0, 7)
    : date.toISOString().slice(5, 10);
}

async function GrowthMetrics({
  grain,
  buckets,
  windowStart,
}: {
  grain: Grain;
  buckets: number;
  windowStart: Date;
}) {
  const [signups, actives, rows] = await Promise.all([
    signupTrend(grain, buckets),
    activeTrend(grain, buckets),
    loadAdminUserRows(),
  ]);
  const inWindow = rows.filter((row) => row.signupAt >= windowStart).length;
  const active = rows.filter((row) => row.lastSeenAt && row.lastSeenAt >= windowStart).length;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Signups" value={inWindow} hint="in selected window" />
        <MetricTile label="Active accounts" value={active} hint="seen in selected window" />
        <MetricTile label="Paid accounts" value={rows.filter((row) => row.plan !== "free").length} />
        <MetricTile label="Total accounts" value={rows.length} tone="muted" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <AdminPanel title={`Signups by ${grain}`}>
          <TrendBars rows={signups.map((point) => ({ label: dateLabel(point.bucketStart, grain), count: point.count }))} />
        </AdminPanel>
        <AdminPanel title={`Accounts writing by ${grain}`}>
          <TrendBars rows={actives.map((point) => ({ label: dateLabel(point.bucketStart, grain), count: point.count }))} />
        </AdminPanel>
      </div>
    </div>
  );
}

async function ActivationMetrics({ grain, buckets }: { grain: Grain; buckets: number }) {
  const [activation, cohorts, adoption] = await Promise.all([
    activationTrend(grain, buckets),
    retentionCohorts(6),
    featureAdoption(),
  ]);
  return (
    <div className="space-y-6">
      <AdminPanel title="Activation by signup cohort">
        {activation.every((point) => point.signed === 0) ? (
          <EmptyState>No signups in this window.</EmptyState>
        ) : (
          <AdminTable head={<><Th>Joined</Th><Th numeric>Signed up</Th><Th numeric>Onboarded</Th><Th numeric>Added a contact</Th></>}>
            {activation.map((point) => (
              <tr key={point.bucketStart.toISOString()} className="border-b border-border/40 last:border-b-0">
                <Td>{dateLabel(point.bucketStart, grain)}</Td>
                <Td numeric>{point.signed}</Td>
                <Td numeric className={point.onboarded === 0 && point.signed > 0 ? "text-destructive" : undefined}>{point.onboarded}</Td>
                <Td numeric>{point.firstContact}</Td>
              </tr>
            ))}
          </AdminTable>
        )}
      </AdminPanel>
      <div className="grid gap-6 xl:grid-cols-2">
        <AdminPanel title="Monthly retention">
          <AdminTable head={<><Th>Cohort</Th><Th numeric>Signed up</Th><Th numeric>Returned after 30d</Th><Th numeric>Active now</Th></>}>
            {cohorts.map((cohort) => (
              <tr key={cohort.cohortStart.toISOString()} className="border-b border-border/40 last:border-b-0">
                <Td>{cohort.cohortStart.toISOString().slice(0, 7)}</Td>
                <Td numeric>{cohort.size}</Td>
                <Td numeric>{cohort.returnedAfter30d}</Td>
                <Td numeric>{cohort.activeNow}</Td>
              </tr>
            ))}
          </AdminTable>
        </AdminPanel>
        <AdminPanel title="Feature adoption">
          <MiniBars rows={Object.entries(adoption).map(([label, value]) => ({ label, count: value })).sort((a, b) => b.count - a.count)} />
        </AdminPanel>
      </div>
    </div>
  );
}

async function RevenueMetrics() {
  const [rows, lifetimeSold] = await Promise.all([
    loadAdminUserRows(),
    countLifetimePurchases().catch(() => 0),
  ]);
  const plans = buildPlanBreakdown(rows);
  const attention = subscriptionsNeedingAttention(rows);
  const comped = rows.filter((row) => row.planSource === "comp");
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="MRR" value={`$${plans.subscribed * MONTHLY_AMOUNT}`} hint={`${plans.subscribed} subscriptions`} />
        <MetricTile label="Lifetime seats" value={`${lifetimeSold}/${LIFETIME_INTRO_SEATS}`} hint={`${Math.max(0, LIFETIME_INTRO_SEATS - lifetimeSold)} remaining`} />
        <MetricTile label="Comped" value={plans.comped} tone={plans.comped > 0 ? "accent" : "muted"} />
        <MetricTile label="Past due" value={attention.length} tone={attention.length > 0 ? "accent" : "muted"} />
      </div>
      <AdminPanel title="Subscription health">
        {attention.length === 0 ? <EmptyState>Every subscription is current.</EmptyState> : (
          <AdminTable head={<><Th>Account</Th><Th>Status</Th><Th numeric>Access ends</Th><Th numeric>Contacts</Th></>}>
            {attention.map((row) => (
              <tr key={row.userId} className="border-b border-border/40 last:border-b-0">
                <Td><Link href={`/admin/users/${encodeURIComponent(row.userId)}`} className="hover:text-primary">{row.email ?? row.userId}</Link></Td>
                <Td><span className={cn("inline-flex items-center gap-1", row.subscriptionStatus === "past_due" && "text-destructive")}>{row.subscriptionStatus === "past_due" && <AlertTriangle className="size-3" aria-hidden />}{row.subscriptionStatus}</span></Td>
                <Td numeric>{row.subscriptionPeriodEnd?.toISOString().slice(0, 10) ?? "—"}</Td>
                <Td numeric>{row.counts.contacts}</Td>
              </tr>
            ))}
          </AdminTable>
        )}
      </AdminPanel>
      <AdminPanel title="Comped accounts">
        {comped.length === 0 ? <EmptyState>Nobody has been comped.</EmptyState> : (
          <AdminTable head={<><Th>Account</Th><Th>Plan</Th><Th>Reason</Th><Th numeric>Granted</Th></>}>
            {comped.map((row) => (
              <tr key={row.userId} className="border-b border-border/40 last:border-b-0">
                <Td><Link href={`/admin/users/${encodeURIComponent(row.userId)}`} className="hover:text-primary">{row.email ?? row.userId}</Link></Td>
                <Td><PlanBadge plan={row.plan} source={row.planSource} /></Td>
                <Td className="max-w-xs truncate text-muted-foreground">{row.compedNote ?? "—"}</Td>
                <Td numeric><RelativeTime date={row.compedAt} /></Td>
              </tr>
            ))}
          </AdminTable>
        )}
      </AdminPanel>
    </div>
  );
}

async function AiMetrics({ grain, buckets, windowStart }: { grain: Grain; buckets: number; windowStart: Date }) {
  const [volume, rows] = await Promise.all([aiVolumeTrend(grain, buckets), loadAdminUserRows()]);
  const calls = rows.reduce((sum, row) => sum + row.counts.aiCalls, 0);
  const failures = rows.reduce((sum, row) => sum + row.counts.aiFailures, 0);
  const spend = rows.reduce((sum, row) => sum + row.estimatedCostMicros, 0);
  const active = rows.filter((row) => row.lastSeenAt && row.lastSeenAt >= windowStart).length;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Recorded calls" value={calls} />
        <MetricTile label="Failures" value={failures} tone={failures > 0 ? "accent" : "muted"} />
        <MetricTile label="Estimated BYOK spend" value={formatCostMicros(spend) ?? "—"} />
        <MetricTile label="Active accounts" value={active} tone="muted" />
      </div>
      <AdminPanel title={`AI calls by ${grain}`} action={<span className="text-xs text-muted-foreground">failures in red</span>}>
        <TrendBars rows={volume.map((point) => ({ label: dateLabel(point.bucketStart, grain), count: point.count, secondary: point.failures, secondaryLabel: "failures" }))} />
      </AdminPanel>
    </div>
  );
}

async function ReliabilityMetrics({ days, windowStart, previousStart }: { days: number; windowStart: Date; previousStart: Date }) {
  const [summary, trend] = await Promise.all([
    getReliabilitySummary(windowStart, previousStart),
    operationalEventTrend(days),
  ]);
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Operational events" value={summary.total} />
        <MetricTile label="Errors" value={summary.failures} tone={summary.failures > 0 ? "accent" : "muted"} />
        <MetricTile label="Warnings" value={summary.warnings} tone={summary.warnings > 0 ? "accent" : "muted"} />
        <MetricTile label="Prior-window errors" value={summary.previousFailures} tone="muted" />
      </div>
      <AdminPanel title="Events by day" action={<span className="text-xs text-muted-foreground">errors in red</span>}>
        <TrendBars rows={trend.map((point) => ({ label: point.bucketStart.toISOString().slice(5, 10), count: point.total, secondary: point.errors, secondaryLabel: "errors" }))} emptyLabel="No operational events in this window." />
      </AdminPanel>
    </div>
  );
}
