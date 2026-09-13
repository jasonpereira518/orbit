import { Download } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  EmptyState,
  MetricTile,
  RelativeTime,
} from "@/components/admin/primitives";
import {
  HealthLiveBody,
  HealthLiveProvider,
  type HealthLiveData,
} from "@/components/admin/health-live";
import { getAdminHealth } from "@/lib/admin-health";
import { cn } from "@/lib/utils";
import { loadProviderStatuses } from "@/lib/admin-providers";
import { ProviderRefreshButton } from "@/components/admin/provider-refresh-button";
import {
  getBugSignatures,
  getCronHealth,
  getErrorEventSummary,
  getOpsStatus,
  getOutreachQueueHealth,
  getWebhookHealth,
} from "@/lib/admin-system";

export const metadata = { title: "Admin · Health" };

/**
 * What is broken across every account, right now.
 *
 * The inspector has always shown these signals, one account at a time — which means a dead
 * Gmail token was only ever visible if you happened to open the one page it lived on, and
 * nobody opens two hundred pages. Same predicates, gathered by the question they answer.
 *
 * Every row names the account and links into its inspector, and carries the button that
 * fixes it. A triage screen you cannot act on from is a list nobody comes back to.
 *
 * The account-level panels poll for updates rather than sitting static until a manual
 * reload — see `health-live.tsx`. Two panels stay server-rendered either side of that
 * live section, both because a twenty-second poll would tell them nothing new:
 * "Known bug signatures" changes on a data-quality timescale, and "Provider status" reads
 * a snapshot cached for a minute and has its own refresh button.
 */
export default async function AdminHealthPage() {
  // `getAdminHealth` answers "what is broken for an account". Everything below answers
  // "what is broken about Orbit" — no person to name, no button to press, which is
  // precisely why none of it was visible before. Each degrades independently so this page
  // still renders if one instrumentation table is missing.
  const [health, cron, webhooks, errors, outreach, bugs, ops, providers] = await Promise.all([
    getAdminHealth(),
    getCronHealth("imports.process-stalled").catch(() => null),
    getWebhookHealth().catch(() => null),
    getErrorEventSummary().catch(() => null),
    getOutreachQueueHealth().catch(() => null),
    getBugSignatures().catch(() => null),
    getOpsStatus().catch(() => null),
    loadProviderStatuses().catch(() => null),
  ]);

  const totalBroken =
    health.connections.length +
    health.calendars.length +
    health.imports.length +
    health.missingKeyAccounts.length;

  const initialLive: HealthLiveData = { health, cron, webhooks, errors, outreach, ops };

  return (
    <>
      <AdminPageHeader
        title="Health"
        subtitle={
          totalBroken === 0 ? (
            "Nothing is failing across any account."
          ) : (
            <>
              <span className="tabular-nums">{totalBroken}</span> thing
              {totalBroken === 1 ? "" : "s"} need attention across all accounts
            </>
          )
        }
        action={
          <a
            href="/api/admin/export?dataset=health&format=csv"
            className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground"
          >
            <Download className="size-3" aria-hidden />
            Export CSV
          </a>
        }
      />

      <div className="mb-6">
        {/* First on the page: this answers "is Orbit itself up", not "is this account
            broken". Deliberately OUTSIDE HealthLiveProvider and server-rendered, the same
            treatment "Known bug signatures" gets below — `loadProviderStatuses` is cached
            for sixty seconds, so a twenty-second poll would either re-render an identical
            snapshot or, if it forced a refresh, hammer four third-party APIs on a timer.
            The refresh button is the on-demand path. */}
        <AdminPanel
          title="Provider status"
          action={<ProviderRefreshButton />}
        >
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
                    className="w-24 shrink-0 truncate hover:text-primary"
                  >
                    {p.label}
                  </a>
                  <span
                    className={cn(
                      "w-28 shrink-0 text-xs",
                      p.status === "unconfigured"
                        ? "text-muted-foreground"
                        : p.status === "healthy"
                          ? "text-muted-foreground"
                          : "text-destructive"
                    )}
                  >
                    {p.status}
                    {p.stale && " (stale)"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {p.detail}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    <RelativeTime date={p.checkedAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AdminPanel>
      </div>

      <HealthLiveProvider initial={initialLive}>
        <HealthLiveBody bugsEmbeddingsMissingVector={bugs?.embeddingsMissingVector ?? null} />
      </HealthLiveProvider>

      {bugs && (
        <div className="mt-6">
          <AdminPanel title="Known bug signatures">
            <div className="grid gap-3 sm:grid-cols-3">
              <MetricTile
                label="Confirmed, no reminder"
                value={bugs.confirmedWithoutReminder}
                tone={bugs.confirmedWithoutReminder > 0 ? "danger" : "muted"}
                hint="a confirm that half-committed"
              />
              <MetricTile
                label="Unindexed embeddings"
                value={
                  bugs.embeddingsMissingVector === null
                    ? "—"
                    : bugs.embeddingsMissingVector
                }
                tone={bugs.embeddingsMissingVector ? "danger" : "muted"}
                hint="invisible to semantic search"
              />
              <MetricTile
                label="Inlined avatars"
                value={bugs.inlinedAvatars}
                tone={bugs.inlinedAvatars > 0 ? "danger" : "muted"}
                hint="base64 in Postgres — Blob unset"
              />
            </div>
          </AdminPanel>
        </div>
      )}
    </>
  );
}
