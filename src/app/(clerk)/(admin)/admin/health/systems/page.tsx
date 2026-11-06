import {
  AdminPanel,
  AdminTable,
  EmptyState,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { SystemsPanels } from "@/components/admin/ops-panels";
import { ProviderRefreshButton } from "@/components/admin/provider-refresh-button";
import { routeLoadTimes } from "@/lib/admin-analytics";
import { isProviderProblem, loadProviderStatuses } from "@/lib/admin-providers";
import { getErrorEventSummary, getOutreachQueueHealth } from "@/lib/admin-system";
import { cn } from "@/lib/utils";
import { OpsShell } from "../_ops/ops-shell";
import { loadCron, loadOps, loadWebhooks } from "../_ops/data";

export const metadata = { title: "Admin · Ops · Systems" };

/** 840 → "840 ms", 2310 → "2.3 s". */
function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Ops › Systems: what is broken about Orbit itself — no person to name, no button to press,
 * which is precisely why none of it was visible before. Each read degrades on its own.
 */
export default async function AdminOpsSystemsPage() {
  const [ops, cron, webhooks, errors, outreach, providers, loads] = await Promise.all([
    loadOps(),
    loadCron(),
    loadWebhooks(),
    getErrorEventSummary().catch(() => null),
    getOutreachQueueHealth().catch(() => null),
    // Cached for sixty seconds per provider; the panel's own button forces a re-check.
    loadProviderStatuses().catch(() => null),
    routeLoadTimes("7d").catch(() => []),
  ]);
  const now = new Date();

  const providerPanel = (
    <AdminPanel title="Provider status" action={<ProviderRefreshButton />}>
      {!providers || providers.length === 0 ? (
        <EmptyState>Provider checks are unavailable.</EmptyState>
      ) : (
        <ul className="divide-y divide-border/50">
          {providers.map((p) => (
            <li key={p.provider} className="flex items-center gap-3 py-2 text-sm">
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  p.status === "healthy" && "bg-emerald-500",
                  p.status === "degraded" && "bg-amber-500",
                  p.status === "unavailable" && "bg-destructive",
                  p.status === "unconfigured" && "bg-muted-foreground/40"
                )}
              />
              <a
                href={p.href}
                target="_blank"
                rel="noreferrer noopener"
                className="w-36 shrink-0 truncate hover:text-primary"
              >
                {p.label}
              </a>
              <span
                className={cn(
                  "w-28 shrink-0 text-xs",
                  p.status === "unconfigured" || p.status === "healthy"
                    ? "text-muted-foreground"
                    : "text-destructive"
                )}
              >
                {p.status}
                {p.stale && " (stale)"}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{p.detail}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                <RelativeTime date={p.checkedAt} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </AdminPanel>
  );

  const loadSpeedPanel = (
    <AdminPanel
      title="Page load speed"
      action={<span className="text-xs text-muted-foreground">last 7 days</span>}
    >
      {loads.length === 0 ? (
        <EmptyState>
          No page loads measured in this window. A view is timed from navigation start until
          no loading skeleton is left on screen.
        </EmptyState>
      ) : (
        <AdminTable
          label="Page load speed"
          minWidth="sm"
          head={
            <>
              <Th>Route</Th>
              <Th>Kind</Th>
              <Th numeric>Samples</Th>
              <Th numeric>p50</Th>
              <Th numeric>p75</Th>
              <Th numeric>p95</Th>
            </>
          }
        >
          {loads.map((r) => (
            <tr key={`${r.route}:${r.navType}`} className="border-b border-border/40">
              <Td className="font-mono text-xs">{r.route}</Td>
              {/* Full loads include TTFB and cold starts; in-app clicks start at the router.
                  Different populations, so they get separate rows. */}
              <Td className="text-muted-foreground">
                {r.navType === "hard" ? "Full load" : "In-app click"}
              </Td>
              <Td numeric>{r.samples.toLocaleString()}</Td>
              <Td numeric>{formatMs(r.p50Ms)}</Td>
              <Td numeric>{formatMs(r.p75Ms)}</Td>
              <Td numeric className="text-muted-foreground">
                {formatMs(r.p95Ms)}
              </Td>
            </tr>
          ))}
        </AdminTable>
      )}
    </AdminPanel>
  );

  return (
    <OpsShell providerProblems={providers?.filter(isProviderProblem).length ?? 0}>
      <SystemsPanels
        ops={ops}
        cron={cron}
        webhooks={webhooks}
        errors={errors}
        outreach={outreach}
        providerPanel={providerPanel}
        loadSpeedPanel={loadSpeedPanel}
        now={now}
      />
    </OpsShell>
  );
}
