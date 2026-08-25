import Link from "next/link";
import {
  AdminPageHeader,
  AdminPanel,
  ExportCsvLink,
  AdminTable,
  EmptyState,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { Pager } from "@/components/admin/pager";
import { requireAdminUserId } from "@/lib/admin";
import { loadAuditLog } from "@/lib/admin-operations";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Audit" };

/** Anything that changed somebody's data or read past a mask is red. */
const DESTRUCTIVE = new Set([
  "account.delete",
  "account.suspend",
  "integration.disconnect",
  "record.reveal",
  "reveal.grant",
]);

/**
 * Every privileged action, in one place.
 *
 * The inspector shows the last 25 entries for one account, which was a complete record when
 * the console could do two things. It now does fourteen, and "what have I done to anyone's
 * data" stopped being answerable from a per-account window.
 *
 * Entries outlive the accounts they describe: `purgeUserData` deliberately spares this
 * table, so a deleted account's trail remains and the email simply renders as unknown.
 */
export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; target?: string; page?: string }>;
}) {
  // Route-level assert as well as the layout's: this page reads every operator action ever
  // taken, including the reasons, and layouts do not re-run for every navigation path.
  await requireAdminUserId();

  const params = await searchParams;
  const action = params.action;
  const targetUserId = params.target;
  const page = Math.max(Number.parseInt(params.page ?? "1", 10) || 1, 1);

  const log = await loadAuditLog({ action, targetUserId, page });

  const hrefWith = (next: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    const merged = { action, target: targetUserId, page: String(page), ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (!value || (key === "page" && value === "1")) continue;
      search.set(key, value);
    }
    const query = search.toString();
    return `/admin/audit${query ? `?${query}` : ""}`;
  };

  return (
    <>
      <AdminPageHeader
        title="Audit"
        subtitle={
          <>
            <span className="tabular-nums">{log.total}</span> privileged action
            {log.total === 1 ? "" : "s"}
            {action ? ` matching ${action}` : ""}
          </>
        }
        action={
          <ExportCsvLink href="/api/admin/export?dataset=audit&format=csv" />
        }
      />

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <Link
            href={hrefWith({ action: undefined, page: "1" })}
            className={cn(
              "rounded-md px-2 py-1 transition-colors duration-fast",
              !action
                ? "bg-accent/15 text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            All
          </Link>
          {log.actions.map((name) => (
            <Link
              key={name}
              href={hrefWith({ action: name, page: "1" })}
              className={cn(
                "rounded-md px-2 py-1 transition-colors duration-fast",
                action === name
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {name}
            </Link>
          ))}
        </div>

        {targetUserId && (
          <p className="text-xs text-muted-foreground">
            Filtered to one account.{" "}
            <Link
              href={hrefWith({ target: undefined, page: "1" })}
              className="hover:text-primary"
            >
              Show everything →
            </Link>
          </p>
        )}

        <AdminPanel>
          {log.rows.length === 0 ? (
            <EmptyState>No actions match this filter.</EmptyState>
          ) : (
            <>
              <AdminTable
                head={
                  <>
                    <Th numeric>When</Th>
                    <Th>Action</Th>
                    <Th>Account</Th>
                    <Th>Reason</Th>
                    <Th>Detail</Th>
                  </>
                }
              >
                {log.rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border/40 last:border-b-0 hover:bg-muted/40"
                  >
                    <Td numeric className="whitespace-nowrap">
                      <RelativeTime date={row.createdAt} />
                    </Td>
                    <Td>
                      <span
                        className={cn(
                          "font-mono text-xs",
                          DESTRUCTIVE.has(row.action) && "text-destructive"
                        )}
                      >
                        {row.action}
                      </span>
                    </Td>
                    <Td className="max-w-56">
                      {row.targetUserId ? (
                        <Link
                          href={`/admin/users/${encodeURIComponent(row.targetUserId)}`}
                          className="block truncate hover:text-primary"
                        >
                          {row.targetEmail ?? row.targetUserId}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {row.targetUserId && !row.targetEmail && (
                        // The account is gone; the record of what was done to it is not.
                        <span className="block text-xs text-muted-foreground">
                          account deleted
                        </span>
                      )}
                    </Td>
                    <Td className="max-w-72">
                      <span className="block truncate" title={row.reason ?? ""}>
                        {row.reason ?? <span className="text-muted-foreground">—</span>}
                      </span>
                    </Td>
                    <Td className="max-w-56 text-xs text-muted-foreground">
                      <span className="block truncate">
                        {Object.keys(row.detail).length > 0
                          ? Object.entries(row.detail)
                              .map(([k, v]) => `${k}=${String(v)}`)
                              .join(" ")
                          : "—"}
                      </span>
                    </Td>
                  </tr>
                ))}
              </AdminTable>

              <div className="mt-3">
                <Pager
                  page={log.page}
                  pageCount={log.pageCount}
                  total={log.total}
                  pageSize={log.pageSize}
                  hrefFor={(target) => hrefWith({ page: String(target) })}
                  label="entries"
                />
              </div>
            </>
          )}
        </AdminPanel>
      </div>
    </>
  );
}
