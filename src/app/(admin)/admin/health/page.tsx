import { Suspense } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Calendar,
  CircleAlert,
  Mail,
  Upload,
} from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  ExportCsvLink,
  AdminPanelSkeleton,
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
import { getAdminHealth } from "@/lib/admin-health";
import { getDataProtection } from "@/lib/admin-data-protection";
import {
  getBugSignatures,
  getCronHealth,
  getErrorEventSummary,
  getOutreachQueueHealth,
  getWebhookHealth,
} from "@/lib/admin-system";
import { SystemStrip } from "@/components/admin/system-strip";
import { LiveProvider, LiveValue } from "@/components/admin/live";
import { SCREEN_TIER } from "@/lib/admin-live-tiers";
import { Skeleton } from "@/components/ui/skeleton";
import { CodeDetail, MiniBars } from "@/components/admin/primitives";

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
 */

type Health = Awaited<ReturnType<typeof getAdminHealth>>;
type Cron = Awaited<ReturnType<typeof getCronHealth>> | null;
type Webhooks = Awaited<ReturnType<typeof getWebhookHealth>> | null;
type Errors = Awaited<ReturnType<typeof getErrorEventSummary>> | null;
type Outreach = Awaited<ReturnType<typeof getOutreachQueueHealth>> | null;
type Bugs = Awaited<ReturnType<typeof getBugSignatures>> | null;
type Protection = Awaited<ReturnType<typeof getDataProtection>> | null;

const inspector = (userId: string) => `/admin/users/${encodeURIComponent(userId)}`;

const who = (userId: string, email: string | null) => (
  <Link href={inspector(userId)} className="truncate hover:text-primary">
    {email ?? userId}
  </Link>
);

/**
 * NOT ASYNC, ON PURPOSE. `getAdminHealth` answers "what is broken for an account";
 * everything else here answers "what is broken about Orbit". They are seven independent
 * sources and this is the densest screen in the console, so each group streams behind its
 * own boundary rather than the whole page waiting on the slowest of the seven.
 *
 * Every section below destructures its awaited values back to the ORIGINAL names, so the
 * panel markup is unchanged from when it all lived in one function.
 *
 * Each loader keeps its own `.catch`, so a missing instrumentation table still costs only
 * its own panel.
 */
export default function AdminHealthPage() {
  const healthPromise = getAdminHealth();
  const cronPromise = getCronHealth().catch(() => null);
  const webhooksPromise = getWebhookHealth().catch(() => null);
  const errorsPromise = getErrorEventSummary().catch(() => null);
  const outreachPromise = getOutreachQueueHealth().catch(() => null);
  const bugsPromise = getBugSignatures().catch(() => null);
  const protectionPromise = getDataProtection().catch(() => null);

  return (
    <LiveProvider screen="health" intervalMs={SCREEN_TIER.health} initial={{}}>
      <Suspense fallback={<HealthHeaderSkeleton />}>
        <HealthHeader healthPromise={healthPromise} />
      </Suspense>

      <Suspense fallback={<Skeleton className="mb-6 h-12 w-full rounded-xl" />}>
        <HealthStrip
          cronPromise={cronPromise}
          outreachPromise={outreachPromise}
          webhooksPromise={webhooksPromise}
          bugsPromise={bugsPromise}
        />
      </Suspense>

      <div className="space-y-6">
        <Suspense fallback={<HealthCoreSkeleton />}>
          <HealthCore healthPromise={healthPromise} />
        </Suspense>

        <Suspense
          fallback={
            <div className="grid gap-6 lg:grid-cols-2">
              <AdminPanelSkeleton title="Nightly job" />
              <AdminPanelSkeleton title="Queued work nothing will drain" />
            </div>
          }
        >
          <CronAndQueue cronPromise={cronPromise} outreachPromise={outreachPromise} />
        </Suspense>

        <Suspense
          fallback={
            <div className="grid gap-6 lg:grid-cols-2">
              <AdminPanelSkeleton title="Failures that used to vanish" />
              <AdminPanelSkeleton title="Inbound webhooks (7 days)" />
            </div>
          }
        >
          <FailuresAndWebhooks
            webhooksPromise={webhooksPromise}
            errorsPromise={errorsPromise}
          />
        </Suspense>

        <Suspense fallback={<AdminPanelSkeleton title="Known bug signatures" />}>
          <BugSignatures bugsPromise={bugsPromise} />
        </Suspense>

        <Suspense fallback={null}>
          <DataProtectionGroup protectionPromise={protectionPromise} />
        </Suspense>
      </div>
    </LiveProvider>
  );
}

function HealthHeaderSkeleton() {
  return (
    <div className="mb-6">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="mt-2 h-4 w-80" />
    </div>
  );
}

function HealthCoreSkeleton() {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
      <AdminPanelSkeleton title="Accounts that cannot use AI at all" />
      <AdminPanelSkeleton title="Failed and stalled imports" />
    </>
  );
}

async function HealthHeader({ healthPromise }: { healthPromise: Promise<Health> }) {
  const health = await healthPromise;
  const totalBroken =
    health.connections.length +
    health.calendars.length +
    health.imports.length +
    health.missingKeyAccounts.length;

  return (
      <AdminPageHeader
        title="Health"
        subtitle={
          <>
            {totalBroken === 0 ? (
              "Nothing is failing across any account."
            ) : (
              <>
                <span className="tabular-nums">{totalBroken}</span> thing
                {totalBroken === 1 ? "" : "s"} need attention across all accounts
              </>
            )}{" "}
            · <LiveValue name="systemIssues">—</LiveValue> system issues
          </>
        }
        action={
          <ExportCsvLink href="/api/admin/export?dataset=health&format=csv" />
        }
      />
  );
}

async function HealthStrip({
  cronPromise,
  outreachPromise,
  webhooksPromise,
  bugsPromise,
}: {
  cronPromise: Promise<Cron>;
  outreachPromise: Promise<Outreach>;
  webhooksPromise: Promise<Webhooks>;
  bugsPromise: Promise<Bugs>;
}) {
  const [cron, outreach, webhooks, bugs] = await Promise.all([
    cronPromise,
    outreachPromise,
    webhooksPromise,
    bugsPromise,
  ]);
  return (
      <SystemStrip
        items={[
          {
            label: "Nightly job",
            value: !cron?.lastRun
              ? "no runs recorded"
              : cron.missed
                ? "has not run in over a day"
                : cron.lastRun.state,
            tone: !cron?.lastRun || cron.missed
              ? "danger"
              : cron.lastRun.state === "ok"
                ? "ok"
                : "warn",
          },
          {
            label: "Overdue sends",
            value: outreach ? `${outreach.overdue}` : "—",
            tone: outreach && outreach.overdue > 0 ? "warn" : "ok",
          },
          {
            label: "Webhooks (7d)",
            value: webhooks
              ? webhooks.byOutcome.map((o) => `${o.count} ${o.outcome}`).join(" · ") || "none"
              : "not instrumented",
            tone: webhooks?.byOutcome.some(
              (o) => o.outcome === "invalid" || o.outcome === "error"
            )
              ? "danger"
              : "ok",
          },
          {
            label: "Search index",
            value:
              !bugs || bugs.embeddingsMissingVector === null
                ? "pgvector unavailable"
                : `${bugs.embeddingsMissingVector} unindexed`,
            tone: bugs?.embeddingsMissingVector ? "warn" : "ok",
          },
        ]}
      />
  );
}

async function HealthCore({ healthPromise }: { healthPromise: Promise<Health> }) {
  const health = await healthPromise;
  return (
    <>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="No AI key"
            value={health.missingKeyAccounts.length}
            tone={health.missingKeyAccounts.length > 0 ? "accent" : "muted"}
            hint="every AI feature fails"
          />
          <MetricTile
            label="Broken connections"
            value={health.connections.length}
            hint="Gmail / Outlook"
          />
          <MetricTile
            label="Failing calendars"
            value={health.calendars.length}
            hint="erroring on sync"
          />
          <MetricTile
            label="Imports to fix"
            value={health.imports.length}
            hint="failed or stalled"
          />
        </div>

        {/* First, because production is strictly BYOK: these accounts hit a hard error on
            their first capture, which makes it a conversion bug rather than a fault. */}
        <AdminPanel title="Accounts that cannot use AI at all">
          {health.missingKeyAccounts.length === 0 ? (
            <EmptyState>Every account has a key for the provider it selected.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/50">
              {health.missingKeyAccounts.map((row) => (
                <li
                  key={row.userId}
                  className="flex items-center gap-3 py-2 text-sm"
                >
                  <CircleAlert
                    className="size-3.5 shrink-0 text-destructive"
                    aria-hidden
                  />
                  <span className="w-64 shrink-0 truncate">
                    {who(row.userId, row.email)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    No {row.provider} key configured
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AdminPanel>

        <AdminPanel title="Failed and stalled imports">
          {health.imports.length === 0 ? (
            <EmptyState>No imports are failed or stuck.</EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Account</Th>
                  <Th>Import</Th>
                  <Th>State</Th>
                  <Th numeric>Rows</Th>
                  <Th numeric>Updated</Th>
                  <Th />
                </>
              }
            >
              {health.imports.map((row) => (
                <tr
                  key={row.importId}
                  className="border-b border-border/40 last:border-b-0 hover:bg-muted/40"
                >
                  <Td className="max-w-56">{who(row.userId, row.email)}</Td>
                  <Td>
                    <span className="flex items-center gap-1.5">
                      <Upload className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate">
                        {row.fileName ?? row.importType}
                      </span>
                    </span>
                  </Td>
                  <Td>
                    <span
                      className={row.stalled ? "text-accent-foreground" : "text-destructive"}
                    >
                      {row.stalled ? "Stalled" : "Failed"}
                    </span>
                    {row.errorMessage && (
                      // System output, shown verbatim — not user prose.
                      <span
                        className="ml-2 text-xs text-muted-foreground"
                        title={row.errorMessage}
                      >
                        {row.errorMessage.slice(0, 60)}
                      </span>
                    )}
                  </Td>
                  <Td numeric>
                    {row.rowsProcessed ?? 0}
                    {row.totalRows ? ` / ${row.totalRows}` : ""}
                  </Td>
                  <Td numeric>
                    <RelativeTime date={row.updatedAt} />
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    <span className="inline-flex gap-1">
                      {row.importType === "linkedin_connections" && (
                        <RetryImportButton
                          targetUserId={row.userId}
                          importId={row.importId}
                          fileName={row.fileName}
                        />
                      )}
                      {row.stalled && (
                        <CancelImportButton
                          targetUserId={row.userId}
                          importId={row.importId}
                        />
                      )}
                    </span>
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>

        <AdminPanel title="Broken mail connections">
          {health.connections.length === 0 ? (
            <EmptyState>Every Gmail and Outlook connection is healthy.</EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Account</Th>
                  <Th>Provider</Th>
                  <Th>Problem</Th>
                  <Th numeric>Last synced</Th>
                  <Th />
                </>
              }
            >
              {health.connections.map((row) => (
                <tr
                  key={`${row.provider}-${row.userId}`}
                  className="border-b border-border/40 last:border-b-0 hover:bg-muted/40"
                >
                  <Td className="max-w-56">{who(row.userId, row.email)}</Td>
                  <Td>
                    <span className="flex items-center gap-1.5 capitalize">
                      <Mail className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                      {row.provider}
                    </span>
                  </Td>
                  <Td className="text-destructive">
                    {row.reason === "expired"
                      ? "Token expired"
                      : `Connection is ${row.status}`}
                  </Td>
                  <Td numeric>
                    <RelativeTime date={row.lastSyncedAt} />
                  </Td>
                  <Td className="text-right">
                    <DisconnectIntegrationButton
                      targetUserId={row.userId}
                      provider={row.provider}
                    />
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>

        <AdminPanel title="Failing calendar feeds">
          {health.calendars.length === 0 ? (
            <EmptyState>Every calendar subscription is syncing.</EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Account</Th>
                  <Th>Feed</Th>
                  <Th>Error</Th>
                  <Th numeric>Last synced</Th>
                  <Th />
                </>
              }
            >
              {health.calendars.map((row) => (
                <tr
                  key={row.subscriptionId}
                  className="border-b border-border/40 last:border-b-0 hover:bg-muted/40"
                >
                  <Td className="max-w-56">{who(row.userId, row.email)}</Td>
                  <Td>
                    <span className="flex items-center gap-1.5">
                      <Calendar
                        className="size-3 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      {row.label ?? "Untitled feed"}
                      {!row.enabled && (
                        <span className="text-xs text-muted-foreground">(disabled)</span>
                      )}
                    </span>
                  </Td>
                  {/* Sync errors are system output, so they are shown in full. */}
                  <Td className="max-w-64 text-destructive">
                    <span className="block truncate" title={row.lastSyncError ?? ""}>
                      {row.lastSyncError ?? "—"}
                    </span>
                  </Td>
                  <Td numeric>
                    <RelativeTime date={row.lastSyncedAt} />
                  </Td>
                  <Td className="text-right">
                    <DisableCalendarFeedButton
                      targetUserId={row.userId}
                      subscriptionId={row.subscriptionId}
                      enabled={row.enabled}
                      label={row.label}
                    />
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>

        {/* Grouped by error kind x model x operation, with an account count per group. That
            count is the point: forty auth failures on one account is a bad key, forty
            across thirty accounts is the provider, and the two need opposite responses. */}
        <AdminPanel
          title="AI failures"
          action={
            <span className="text-xs text-muted-foreground tabular-nums">
              last {health.windowDays} days
            </span>
          }
        >
          {health.aiErrors.length === 0 ? (
            <EmptyState>
              No AI calls have failed in the last {health.windowDays} days.
            </EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Error</Th>
                  <Th>Operation</Th>
                  <Th>Model</Th>
                  <Th numeric>Failures</Th>
                  <Th numeric>Accounts</Th>
                  <Th numeric>Last seen</Th>
                </>
              }
            >
              {health.aiErrors.map((group) => (
                <tr
                  key={`${group.errorKind}-${group.model}-${group.operation}`}
                  className="border-b border-border/40 last:border-b-0"
                >
                  <Td>
                    <span className="flex items-center gap-1.5">
                      <AlertTriangle
                        className="size-3 shrink-0 text-destructive"
                        aria-hidden
                      />
                      {group.errorKind}
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">{group.operation}</Td>
                  <Td className="text-muted-foreground">
                    {group.provider} / {group.model}
                  </Td>
                  <Td numeric>{group.failures}</Td>
                  <Td numeric>
                    <span className={group.accounts > 1 ? "text-destructive" : undefined}>
                      {group.accounts}
                    </span>
                  </Td>
                  <Td numeric>
                    <RelativeTime date={group.lastAt} />
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>
    </>
  );
}

async function CronAndQueue({
  cronPromise,
  outreachPromise,
}: {
  cronPromise: Promise<Cron>;
  outreachPromise: Promise<Outreach>;
}) {
  const [cron, outreach] = await Promise.all([cronPromise, outreachPromise]);
  return (
        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Nightly job">
            {/* Nothing recorded cron runs before this, so "did it fire last night?" had no
                answer — and the import backstop below silently depends on it. */}
            {!cron || cron.recent.length === 0 ? (
              <EmptyState>
                No runs recorded yet. The ledger starts at the next midnight run.
              </EmptyState>
            ) : (
              <AdminTable
                head={
                  <>
                    <Th>Started</Th>
                    <Th>State</Th>
                    <Th numeric>Took</Th>
                    <Th>Result</Th>
                  </>
                }
              >
                {cron.recent.map((run) => (
                  <tr key={run.id} className="border-b border-border/40 last:border-b-0">
                    <Td className="text-muted-foreground">
                      <RelativeTime date={run.startedAt} /> ago
                    </Td>
                    <Td
                      className={
                        run.state === "failed" || run.state === "stale"
                          ? "text-destructive"
                          : run.state === "partial"
                            ? "text-accent-foreground"
                            : undefined
                      }
                    >
                      {run.state}
                    </Td>
                    <Td numeric>
                      {run.durationMs === null
                        ? "—"
                        : `${Math.round(run.durationMs / 1000)}s`}
                    </Td>
                    <Td className="text-xs text-muted-foreground">
                      {run.error ||
                        Object.entries(run.stats)
                          .filter(([, v]) => typeof v === "number" && v > 0)
                          .map(([k, v]) => `${k} ${v}`)
                          .join(" · ") ||
                        "nothing to do"}
                    </Td>
                  </tr>
                ))}
              </AdminTable>
            )}
          </AdminPanel>

          <AdminPanel title="Queued work nothing will drain">
            {!outreach ? (
              <EmptyState>Not instrumented yet.</EmptyState>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <MetricTile
                    label="Overdue sends"
                    value={outreach.overdue}
                    tone={outreach.overdue > 0 ? "danger" : "default"}
                    hint={
                      outreach.oldestOverdueDays !== null
                        ? `oldest ${outreach.oldestOverdueDays}d`
                        : undefined
                    }
                  />
                  <MetricTile
                    label="Not yet due"
                    value={outreach.notYetDue}
                    tone="muted"
                    hint={`across ${outreach.accounts} account${outreach.accounts === 1 ? "" : "s"}`}
                  />
                </div>
                <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                  Scheduled outreach has no runner. It drains only when the owning user
                  opens that campaign, so overdue messages accumulate silently.
                </p>
              </>
            )}
          </AdminPanel>
        </div>
  );
}

async function FailuresAndWebhooks({
  webhooksPromise,
  errorsPromise,
}: {
  webhooksPromise: Promise<Webhooks>;
  errorsPromise: Promise<Errors>;
}) {
  const [webhooks, errors] = await Promise.all([webhooksPromise, errorsPromise]);
  return (
        <div className="grid gap-6 lg:grid-cols-2">
          <AdminPanel title="Failures that used to vanish">
            {!errors ? (
              <EmptyState>Not instrumented yet.</EmptyState>
            ) : errors.grouped.length === 0 ? (
              <EmptyState>Nothing has failed silently in the last 7 days.</EmptyState>
            ) : (
              <>
                <MiniBars
                  rows={errors.grouped.map((g) => ({
                    label: `${g.source} · ${g.kind}`,
                    count: g.count,
                  }))}
                />
                <div className="mt-4 space-y-2 border-t border-border/60 pt-3">
                  {errors.recent.slice(0, 5).map((e, i) => (
                    <div key={i}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-mono text-xs">
                          {e.source} · {e.kind}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          <RelativeTime date={e.at} /> ago
                        </span>
                      </div>
                      <CodeDetail>{e.message}</CodeDetail>
                    </div>
                  ))}
                </div>
              </>
            )}
          </AdminPanel>

          <AdminPanel title="Inbound webhooks (7 days)">
            {!webhooks ? (
              <EmptyState>Not instrumented yet.</EmptyState>
            ) : webhooks.byOutcome.length === 0 ? (
              <EmptyState>No deliveries recorded.</EmptyState>
            ) : (
              <>
                <MiniBars
                  rows={webhooks.byOutcome.map((o) => ({
                    label: o.outcome,
                    count: o.count,
                  }))}
                />
                {webhooks.ignored.length > 0 && (
                  <div className="mt-3 border-t border-border/60 pt-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Arrived but ignored
                    </div>
                    <ul className="mt-1.5 space-y-1 text-sm">
                      {webhooks.ignored.map((r, i) => (
                        <li key={i} className="flex justify-between gap-4">
                          <span className="font-mono text-xs">
                            {r.eventType ?? "—"} · {r.reason ?? "—"}
                          </span>
                          <span className="tabular-nums">{r.count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {webhooks.retried.length > 0 && (
                  <div className="mt-3 border-t border-border/60 pt-3">
                    {/* Only countable because there is no unique index on the delivery id:
                        a repeat means the handler kept failing and Svix kept retrying. */}
                    <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-destructive">
                      <AlertTriangle className="size-3" aria-hidden />
                      Redelivered — the handler is failing
                    </div>
                    <ul className="mt-1.5 space-y-1 text-xs">
                      {webhooks.retried.map((r) => (
                        <li key={r.eventId} className="flex justify-between gap-4">
                          <span className="truncate font-mono">{r.eventId}</span>
                          <span className="tabular-nums">×{r.count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </AdminPanel>
        </div>
  );
}

async function BugSignatures({ bugsPromise }: { bugsPromise: Promise<Bugs> }) {
  const bugs = await bugsPromise;
  return (
    <>
        {bugs && (
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
        )}
    </>
  );
}

async function DataProtectionGroup({
  protectionPromise,
}: {
  protectionPromise: Promise<Protection>;
}) {
  const protection = await protectionPromise;
  return (
    <>
        {/* ------------------------------------------------------- data protection ---- */}

        {protection && (
          <>
            {/* A section heading, not a second `AdminPageHeader`. That component renders
                an h1, and a document with two of them is wrong for a screen reader and
                wrong for the outline — "Health" is the page; this is a group within it. */}
            <div className="mt-2 border-t border-border/60 pt-6">
              <h2 className="text-lg font-medium tracking-tight text-foreground">
                Data protection
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {protection.thirdPartyRecords === null
                  ? "What Orbit holds, and whether erasure actually works"
                  : `${protection.thirdPartyRecords.toLocaleString()} records about people who never signed up`}
              </p>
            </div>

            <AdminPanel title="Rows whose account no longer exists">
              {protection.orphans.length === 0 ? (
                <EmptyState>
                  Nothing orphaned. Every user-scoped table is either purged on account
                  deletion or deliberately anonymised.
                </EmptyState>
              ) : (
                <>
                  <AdminTable
                    head={
                      <>
                        <Th>Table</Th>
                        <Th numeric>Rows</Th>
                      </>
                    }
                  >
                    {protection.orphans.map((o) => (
                      <tr
                        key={o.table}
                        className="border-b border-border/40 last:border-b-0"
                      >
                        <Td className="font-mono text-xs text-destructive">{o.table}</Td>
                        <Td numeric>{o.rows}</Td>
                      </tr>
                    ))}
                  </AdminTable>
                  <p className="mt-3 text-xs text-destructive">
                    These survived an account deletion. Three tables have reached production
                    user-scoped and unpurged so far — each was invisible until something
                    enumerated the schema rather than trusting a list.
                  </p>
                </>
              )}
              <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground">
                Derived from <code className="font-mono">schema.ts</code> at run time, so a
                new user-scoped table appears here the moment it holds an orphan.{" "}
                <code className="font-mono">billing_events</code> is excluded: it is
                anonymised rather than deleted, because financial records have to survive a
                customer leaving.
              </p>
            </AdminPanel>

            <div className="grid gap-6 lg:grid-cols-2">
              <AdminPanel title="What is kept, and for how long">
                <AdminTable
                  head={
                    <>
                      <Th>Data</Th>
                      <Th>Policy</Th>
                      <Th numeric>Rows</Th>
                    </>
                  }
                >
                  {protection.retention.map((r) => (
                    <tr
                      key={r.what}
                      className="border-b border-border/40 last:border-b-0"
                    >
                      <Td>{r.what}</Td>
                      <Td
                        className={
                          r.keptForever ? "text-muted-foreground" : undefined
                        }
                      >
                        {r.policy}
                      </Td>
                      <Td numeric>{r.rows === null ? "—" : r.rows}</Td>
                    </tr>
                  ))}
                </AdminTable>
                <p className="mt-3 text-xs text-muted-foreground">
                  Contact data has no expiry. That is defensible for a CRM — remembering
                  people is the product — but it is worth being a decision rather than an
                  accident, given that the people being remembered did not agree to it.
                </p>
              </AdminPanel>

              <AdminPanel title="Refused attempts to reach this console">
                {protection.denials.length === 0 ? (
                  <EmptyState>
                    Nobody has been turned away. Recorded from the day the gate started
                    logging — earlier attempts left no trace at all.
                  </EmptyState>
                ) : (
                  <AdminTable
                    head={
                      <>
                        <Th>Account</Th>
                        <Th numeric>When</Th>
                      </>
                    }
                  >
                    {protection.denials.map((d, i) => (
                      <tr
                        key={`${d.userId}-${i}`}
                        className="border-b border-border/40 last:border-b-0"
                      >
                        <Td className="font-mono text-xs">{d.userId}</Td>
                        <Td numeric>
                          <RelativeTime date={d.at} />
                        </Td>
                      </tr>
                    ))}
                  </AdminTable>
                )}
                <p className="mt-3 text-xs text-muted-foreground">
                  The gate answers 404 rather than 403 deliberately, so a probe learns
                  nothing — which also meant it left no trace. The response is unchanged;
                  only the record is new. On a console with one legitimate operator, a
                  second name here is worth reading.
                </p>
              </AdminPanel>
            </div>
          </>
        )}
    </>
  );
}
