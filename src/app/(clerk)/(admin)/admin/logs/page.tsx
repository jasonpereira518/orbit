import Link from "next/link";
import { Download, Search } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { LogDetails } from "@/components/admin/log-details";
import {
  loadOperationalEvents,
  type OperationalSeverity,
  type OperationalSource,
} from "@/lib/operational-events";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Logs" };

const SOURCES: OperationalSource[] = ["app", "job", "webhook", "integration", "provider", "admin"];
const SEVERITIES: OperationalSeverity[] = ["info", "warn", "error"];
const WINDOW_DAYS = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 } as const;

export default async function AdminLogsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const windowKey = params.window && params.window in WINDOW_DAYS ? params.window as keyof typeof WINDOW_DAYS : "7d";
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS[windowKey] * 24 * 60 * 60 * 1000);
  const severity = SEVERITIES.includes(params.severity as OperationalSeverity) ? params.severity as OperationalSeverity : undefined;
  const source = SOURCES.includes(params.source as OperationalSource) ? params.source as OperationalSource : undefined;
  const before = params.before ? new Date(params.before) : undefined;
  const page = await loadOperationalEvents({
    severity,
    source,
    eventType: params.type?.trim() || undefined,
    userId: params.user?.trim() || undefined,
    q: params.q?.trim() || undefined,
    since,
    before: before && !Number.isNaN(before.getTime()) ? before : undefined,
    limit: 50,
  });

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ window: windowKey, severity, source, type: params.type, user: params.user, q: params.q })) {
    if (value) query.set(key, value);
  }
  const exportQuery = new URLSearchParams(query);
  exportQuery.set("dataset", "events");
  exportQuery.set("format", "csv");

  return (
    <>
      <AdminPageHeader
        title="Logs"
        subtitle="Redacted app, job, webhook, provider, and operator events."
        action={
          <a href={`/api/admin/export?${exportQuery}`} className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
            <Download className="size-3" aria-hidden /> Export CSV
          </a>
        }
      />

      <form className="mb-4 grid gap-2 rounded-xl border border-border/70 bg-card p-3 md:grid-cols-[minmax(14rem,1fr)_9rem_9rem_12rem_12rem_auto]">
        <label className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input name="q" defaultValue={params.q} placeholder="Search messages or correlation ID" className="h-8 w-full rounded-md border border-border/70 bg-background pl-8 pr-2 text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary/15" />
        </label>
        <select name="severity" defaultValue={severity ?? ""} aria-label="Severity" className="h-8 rounded-md border border-border/70 bg-background px-2 text-xs">
          <option value="">All levels</option>
          {SEVERITIES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select name="source" defaultValue={source ?? ""} aria-label="Source" className="h-8 rounded-md border border-border/70 bg-background px-2 text-xs">
          <option value="">All sources</option>
          {SOURCES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <input name="type" defaultValue={params.type} placeholder="Event type" aria-label="Event type" className="h-8 rounded-md border border-border/70 bg-background px-2 text-xs" />
        <input name="user" defaultValue={params.user} placeholder="Account ID" aria-label="Account ID" className="h-8 rounded-md border border-border/70 bg-background px-2 text-xs" />
        <button type="submit" className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground">Filter</button>
        <input type="hidden" name="window" value={windowKey} />
      </form>

      <AdminPanel>
        {page.rows.length === 0 ? (
          <EmptyState>No operational events match these filters.</EmptyState>
        ) : (
          <>
            <AdminTable head={<><Th numeric>When</Th><Th>Level</Th><Th>Source</Th><Th>Event</Th><Th>Message</Th><Th>Account</Th><Th /></>}>
              {page.rows.map((event) => (
                <tr key={event.id} className="border-b border-border/40 last:border-b-0 hover:bg-muted/40">
                  <Td numeric className="whitespace-nowrap"><RelativeTime date={event.occurredAt} /></Td>
                  <Td><span className={cn("font-mono text-xs uppercase", event.severity === "error" ? "text-destructive" : event.severity === "warn" ? "text-tier-lifetime" : "text-muted-foreground")}>{event.severity}</span></Td>
                  <Td className="font-mono text-xs text-muted-foreground">{event.source}</Td>
                  <Td className="max-w-52"><span className="block truncate font-mono text-xs" title={event.eventType}>{event.eventType}</span></Td>
                  <Td className="max-w-96"><span className="block truncate text-muted-foreground" title={event.message}>{event.message}</span></Td>
                  <Td className="max-w-48">{event.userId ? <Link href={`/admin/users/${encodeURIComponent(event.userId)}`} className="block truncate hover:text-primary">{event.userId}</Link> : <span className="text-muted-foreground">—</span>}</Td>
                  <Td className="text-right"><LogDetails event={{
                    eventType: event.eventType,
                    message: event.message,
                    severity: event.severity,
                    source: event.source,
                    occurredAt: event.occurredAt.toISOString(),
                    success: event.success,
                    userId: event.userId,
                    resourceType: event.resourceType,
                    resourceId: event.resourceId,
                    correlationId: event.correlationId,
                    durationMs: event.durationMs,
                    metadata: event.metadata ?? {},
                  }} /></Td>
                </tr>
              ))}
            </AdminTable>
            {page.hasMore && page.nextBefore && (
              <div className="mt-3 border-t border-border/50 pt-3 text-right">
                <Link href={`/admin/logs?${new URLSearchParams([...query.entries(), ["before", page.nextBefore]]).toString()}`} className="text-xs text-muted-foreground hover:text-primary">Older events →</Link>
              </div>
            )}
          </>
        )}
      </AdminPanel>
    </>
  );
}
