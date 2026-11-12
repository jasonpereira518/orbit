import Link from "next/link";
import { desc, like } from "drizzle-orm";
import { AdminPanel, AdminTable, AdminTr, EmptyState, Td, Th } from "@/components/admin/primitives";
import { RelativeTime } from "@/components/admin/relative-time";
import { RefreshJobCard } from "@/components/admin/refresh-job-card";
import { getDb } from "@/db";
import { adminAuditLog } from "@/db/schema";
import { getCronHealth } from "@/lib/admin-system";
import { REFRESH_JOBS } from "@/lib/admin-refresh-jobs";
import { OpsShell } from "../_ops/ops-shell";

export const metadata = { title: "Admin · Ops · Refresh" };

/** The operator's own refresh clicks, newest first. Each degrades on its own. */
async function recentRefreshes() {
  const db = await getDb();
  return db
    .select({
      id: adminAuditLog.id,
      action: adminAuditLog.action,
      targetUserId: adminAuditLog.targetUserId,
      reason: adminAuditLog.reason,
      createdAt: adminAuditLog.createdAt,
    })
    .from(adminAuditLog)
    .where(like(adminAuditLog.action, "refresh.%"))
    .orderBy(desc(adminAuditLog.createdAt))
    .limit(20);
}

/**
 * Ops › Refresh: re-run any background job now, for every account or for one.
 * The jobs and their routes live in `src/lib/admin-refresh-jobs.ts`.
 */
export default async function AdminOpsRefreshPage() {
  const [health, recent] = await Promise.all([
    Promise.all(
      REFRESH_JOBS.map((j) => (j.cronJob ? getCronHealth(j.cronJob).catch(() => null) : null))
    ),
    recentRefreshes().catch(() => null),
  ]);
  const labels = new Map(REFRESH_JOBS.map((j) => [`refresh.${j.key}`, j.label]));

  return (
    <OpsShell>
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          The LinkedIn photo queue and blocked photos stay on{" "}
          <Link href="/admin/product/photos" className="underline underline-offset-2">
            Product › Photos
          </Link>
          .
        </p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {REFRESH_JOBS.map((job, i) => {
            const last = health[i]?.lastRun ?? null;
            return (
              <RefreshJobCard
                key={job.key}
                jobKey={job.key}
                label={job.label}
                description={job.description}
                canRunAll={Boolean(job.allRoute)}
                canRunOne={Boolean(job.runOne)}
                lastRun={
                  last
                    ? {
                        state: last.state,
                        startedAt: last.startedAt.toISOString(),
                        durationMs: last.durationMs,
                        stats: last.stats,
                        error: last.error,
                      }
                    : null
                }
                hasLedger={Boolean(job.cronJob)}
              />
            );
          })}
        </div>
        <AdminPanel title="Recent refreshes">
          {!recent ? (
            <EmptyState>Couldn’t read the audit log.</EmptyState>
          ) : recent.length === 0 ? (
            <EmptyState>No refreshes run from here yet.</EmptyState>
          ) : (
            <AdminTable
              label="Recent refreshes"
              minWidth="sm"
              head={
                <>
                  <Th>Job</Th>
                  <Th>Account</Th>
                  <Th>Reason</Th>
                  <Th>When</Th>
                </>
              }
            >
              {recent.map((r) => (
                <AdminTr key={r.id}>
                  <Td>{labels.get(r.action) ?? r.action}</Td>
                  <Td>
                    {r.targetUserId ? (
                      <Link
                        href={`/admin/users/${r.targetUserId}`}
                        className="underline underline-offset-2"
                      >
                        {r.targetUserId}
                      </Link>
                    ) : (
                      "All accounts"
                    )}
                  </Td>
                  <Td>{r.reason ?? "—"}</Td>
                  <Td>
                    <RelativeTime date={r.createdAt} />
                  </Td>
                </AdminTr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>
      </div>
    </OpsShell>
  );
}
