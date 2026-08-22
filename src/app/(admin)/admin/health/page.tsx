import Link from "next/link";
import { AlertTriangle, CircleAlert, Mail, Calendar, Upload } from "lucide-react";
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
import { getAdminHealth } from "@/lib/admin-health";

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
export default async function AdminHealthPage() {
  const health = await getAdminHealth();

  const inspector = (userId: string) =>
    `/admin/users/${encodeURIComponent(userId)}`;

  const who = (userId: string, email: string | null) => (
    <Link href={inspector(userId)} className="truncate hover:text-primary">
      {email ?? userId}
    </Link>
  );

  const totalBroken =
    health.connections.length +
    health.calendars.length +
    health.imports.length +
    health.missingKeyAccounts.length;

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
      />

      <div className="space-y-6">
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
      </div>
    </>
  );
}
