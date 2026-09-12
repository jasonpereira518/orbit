import Link from "next/link";
import {
  ArrowUpRight,
  Calendar,
  CircleAlert,
  Mail,
  Upload,
} from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import {
  CancelImportButton,
  DisableCalendarFeedButton,
  DisconnectIntegrationButton,
  RetryImportButton,
} from "@/components/admin/health-actions";
import { ProviderRefreshButton } from "@/components/admin/provider-refresh-button";
import { getAdminHealth } from "@/lib/admin-health";
import { loadProviderStatuses } from "@/lib/admin-providers";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Systems" };

export default async function AdminSystemsPage() {
  const [providers, health] = await Promise.all([
    loadProviderStatuses(),
    getAdminHealth({ windowDays: 1 }),
  ]);
  const broken = health.connections.length + health.calendars.length + health.imports.length + health.missingKeyAccounts.length;
  const inspector = (userId: string) => `/admin/users/${encodeURIComponent(userId)}`;
  const account = (userId: string, email: string | null) => (
    <Link href={inspector(userId)} className="block truncate hover:text-primary">{email ?? userId}</Link>
  );

  return (
    <>
      <AdminPageHeader
        title="Systems"
        subtitle={`${providers.filter((provider) => provider.status === "healthy").length} of 4 providers healthy · ${broken} account condition${broken === 1 ? "" : "s"} need attention`}
        action={<ProviderRefreshButton />}
      />

      <div className="space-y-6">
        <div className="grid gap-3 xl:grid-cols-4">
          {providers.map((provider) => (
            <section key={provider.provider} className="rounded-xl border border-border/70 bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className={cn("size-2 rounded-full", provider.status === "healthy" ? "bg-emerald-600" : provider.status === "unconfigured" ? "bg-muted-foreground/50" : provider.status === "degraded" ? "bg-tier-lifetime" : "bg-destructive")} aria-label={provider.status} />
                  <h2 className="font-medium">{provider.label}</h2>
                </div>
                <a href={provider.href} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground"><ArrowUpRight className="size-3.5" aria-hidden /><span className="sr-only">Open {provider.label}</span></a>
              </div>
              <p className="mt-3 min-h-10 text-xs leading-5 text-muted-foreground">{provider.detail}</p>
              <dl className="mt-3 space-y-1 border-t border-border/50 pt-3 text-xs">
                {Object.entries(provider.metrics).slice(0, 4).map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-3">
                    <dt className="truncate text-muted-foreground">{key.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
                    <dd className="max-w-[55%] truncate text-right font-mono">{value == null ? "—" : String(value)}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">Checked <RelativeTime date={provider.checkedAt} />{provider.stale ? " · stale" : ""}</p>
            </section>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile label="No AI key" value={health.missingKeyAccounts.length} icon={CircleAlert} tone={health.missingKeyAccounts.length ? "accent" : "muted"} />
          <MetricTile label="Mail connections" value={health.connections.length} icon={Mail} tone={health.connections.length ? "accent" : "muted"} />
          <MetricTile label="Calendar feeds" value={health.calendars.length} icon={Calendar} tone={health.calendars.length ? "accent" : "muted"} />
          <MetricTile label="Imports" value={health.imports.length} icon={Upload} tone={health.imports.length ? "accent" : "muted"} />
        </div>

        <AdminPanel title="Accounts without an AI key">
          {health.missingKeyAccounts.length === 0 ? <EmptyState>Every account has a key for its selected provider.</EmptyState> : (
            <ul className="divide-y divide-border/50">
              {health.missingKeyAccounts.map((row) => (
                <li key={row.userId} className="flex items-center gap-3 py-2">
                  <CircleAlert className="size-3.5 text-destructive" aria-hidden />
                  <span className="w-64 shrink-0 truncate">{account(row.userId, row.email)}</span>
                  <span className="text-muted-foreground">No {row.provider} key configured</span>
                </li>
              ))}
            </ul>
          )}
        </AdminPanel>

        <AdminPanel title="Failed and stalled imports">
          {health.imports.length === 0 ? <EmptyState>No imports are failed or stalled.</EmptyState> : (
            <AdminTable head={<><Th>Account</Th><Th>Import</Th><Th>State</Th><Th numeric>Rows</Th><Th numeric>Updated</Th><Th /></>}>
              {health.imports.map((row) => (
                <tr key={row.importId} className="border-b border-border/40 last:border-b-0 hover:bg-muted/40">
                  <Td className="max-w-56">{account(row.userId, row.email)}</Td>
                  <Td><span className="flex items-center gap-1.5"><Upload className="size-3 text-muted-foreground" aria-hidden />{row.fileName ?? row.importType}</span></Td>
                  <Td className={row.stalled ? "text-tier-lifetime" : "text-destructive"}>{row.stalled ? "stalled" : row.status}</Td>
                  <Td numeric>{row.rowsProcessed ?? 0}{row.totalRows != null ? ` / ${row.totalRows}` : ""}</Td>
                  <Td numeric><RelativeTime date={row.updatedAt} /></Td>
                  <Td className="text-right"><span className="flex justify-end gap-1">{row.importType === "linkedin_connections" && <RetryImportButton targetUserId={row.userId} importId={row.importId} fileName={row.fileName} />}<CancelImportButton targetUserId={row.userId} importId={row.importId} /></span></Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>

        <div className="grid gap-6 xl:grid-cols-2">
          <AdminPanel title="Broken mail connections">
            {health.connections.length === 0 ? <EmptyState>Gmail and Outlook connections are healthy.</EmptyState> : (
              <ul className="divide-y divide-border/50">
                {health.connections.map((row) => (
                  <li key={`${row.provider}-${row.userId}`} className="flex items-center gap-3 py-2">
                    <Mail className="size-3.5 text-destructive" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{account(row.userId, row.email)}</span>
                    <span className="text-xs text-muted-foreground">{row.provider} · {row.reason}</span>
                    <DisconnectIntegrationButton targetUserId={row.userId} provider={row.provider} />
                  </li>
                ))}
              </ul>
            )}
          </AdminPanel>

          <AdminPanel title="Failing calendar feeds">
            {health.calendars.length === 0 ? <EmptyState>Calendar feeds are syncing normally.</EmptyState> : (
              <ul className="divide-y divide-border/50">
                {health.calendars.map((row) => (
                  <li key={row.subscriptionId} className="flex items-center gap-3 py-2">
                    <Calendar className="size-3.5 text-destructive" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{account(row.userId, row.email)}</span>
                    <span className="max-w-48 truncate text-xs text-muted-foreground" title={row.lastSyncError ?? ""}>{row.lastSyncError ?? row.lastSyncStatus}</span>
                    <DisableCalendarFeedButton targetUserId={row.userId} subscriptionId={row.subscriptionId} enabled={row.enabled} label={row.label} />
                  </li>
                ))}
              </ul>
            )}
          </AdminPanel>
        </div>

        <AdminPanel title="AI failures in the last 24 hours" action={<Link href="/admin/logs?source=app&window=1d&type=ai.request_failed" className="text-xs text-muted-foreground hover:text-primary">Open logs →</Link>}>
          {health.aiErrors.length === 0 ? <EmptyState>No AI failures in this window.</EmptyState> : (
            <AdminTable head={<><Th>Kind</Th><Th>Provider / model</Th><Th>Operation</Th><Th numeric>Failures</Th><Th numeric>Accounts</Th><Th numeric>Last</Th></>}>
              {health.aiErrors.map((row) => (
                <tr key={`${row.provider}-${row.operation}-${row.errorKind}`} className="border-b border-border/40 last:border-b-0">
                  <Td className="font-mono text-xs text-destructive">{row.errorKind}</Td>
                  <Td>{row.provider} <span className="text-xs text-muted-foreground">· {row.model}</span></Td>
                  <Td className="font-mono text-xs">{row.operation}</Td>
                  <Td numeric>{row.failures}</Td><Td numeric>{row.accounts}</Td>
                  <Td numeric><RelativeTime date={row.lastAt} /></Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>
      </div>
    </>
  );
}
