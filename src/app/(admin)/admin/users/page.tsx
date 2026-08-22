import Link from "next/link";
import { CircleAlert } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  PlanBadge,
  RelativeTime,
  Td,
  Th,
} from "@/components/admin/primitives";
import { UsersFilterBar } from "@/components/admin/users-filter-bar";
import { CompPlanButton } from "@/components/admin/comp-plan-dialog";
import { loadAdminUserRows, type AdminUserRow } from "@/lib/admin-metrics";

export const metadata = { title: "Admin · Users" };

type SortKey =
  | "signup"
  | "active"
  | "contacts"
  | "interactions"
  | "ai"
  | "email";

const SORTS: Record<SortKey, (a: AdminUserRow, b: AdminUserRow) => number> = {
  signup: (a, b) => b.signupAt.getTime() - a.signupAt.getTime(),
  active: (a, b) =>
    (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0),
  contacts: (a, b) => b.counts.contacts - a.counts.contacts,
  interactions: (a, b) => b.counts.interactions - a.counts.interactions,
  ai: (a, b) => b.counts.aiCalls - a.counts.aiCalls,
  email: (a, b) => (a.email ?? a.userId).localeCompare(b.email ?? b.userId),
};

/**
 * The roster. No pagination for now: sorting by a derived column ("most contacts") cannot
 * be pushed into the base query, so filtering the aggregates to a page would only work for
 * signup-ordered sorts. At Orbit's size, six GROUP BY scans plus a JS sort is correct for
 * every key. Past a few thousand accounts the fix is a materialized rollup, not paging.
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; plan?: string; sort?: string; state?: string }>;
}) {
  const params = await searchParams;
  const rows = await loadAdminUserRows();

  const q = (params.q ?? "").trim().toLowerCase();
  const planFilter = params.plan ?? "all";
  const stateFilter = params.state ?? "all";
  const sortKey: SortKey = (params.sort as SortKey) in SORTS
    ? (params.sort as SortKey)
    : "signup";

  const filtered = rows
    .filter((row) => {
      if (q) {
        const haystack = `${row.email ?? ""} ${row.userId}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (planFilter !== "all") {
        if (planFilter === "comped" && row.planSource !== "comp") return false;
        if (planFilter !== "comped" && row.plan !== planFilter) return false;
      }
      if (stateFilter === "no-key" && row.hasProviderKey) return false;
      if (stateFilter === "past-due" && row.subscriptionStatus !== "past_due") {
        return false;
      }
      if (stateFilter === "inactive" && row.counts.contacts > 0) return false;
      return true;
    })
    .sort(SORTS[sortKey]);

  const sortLink = (key: SortKey, label: string) => {
    const next = new URLSearchParams();
    if (q) next.set("q", params.q ?? "");
    if (planFilter !== "all") next.set("plan", planFilter);
    if (stateFilter !== "all") next.set("state", stateFilter);
    next.set("sort", key);
    return (
      <Link
        href={`/admin/users?${next.toString()}`}
        className={
          sortKey === key ? "text-primary" : "hover:text-foreground"
        }
      >
        {label}
      </Link>
    );
  };

  return (
    <>
      <AdminPageHeader
        title="Users"
        subtitle={
          filtered.length === rows.length
            ? `${rows.length} account${rows.length === 1 ? "" : "s"}`
            : `${filtered.length} of ${rows.length} accounts`
        }
      />

      <div className="space-y-4">
        <UsersFilterBar
          q={params.q ?? ""}
          plan={planFilter}
          state={stateFilter}
          sort={sortKey}
        />

        <AdminPanel>
          {filtered.length === 0 ? (
            <EmptyState>No accounts match these filters.</EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>{sortLink("email", "Account")}</Th>
                  <Th>Plan</Th>
                  <Th numeric>{sortLink("contacts", "Contacts")}</Th>
                  <Th numeric>{sortLink("interactions", "Logged")}</Th>
                  <Th numeric>{sortLink("ai", "AI calls")}</Th>
                  <Th numeric>{sortLink("active", "Last seen")}</Th>
                  <Th numeric>{sortLink("signup", "Joined")}</Th>
                  <Th />
                </>
              }
            >
              {filtered.map((row) => (
                <tr
                  key={row.userId}
                  className="border-b border-border/40 last:border-b-0 hover:bg-muted/40"
                >
                  <Td>
                    <Link
                      href={`/admin/users/${encodeURIComponent(row.userId)}`}
                      className="flex items-center gap-2 hover:text-primary"
                    >
                      <span className="truncate">{row.email ?? row.userId}</span>
                      {!row.hasProviderKey && (
                        <CircleAlert
                          className="size-3.5 shrink-0 text-destructive"
                          aria-label="No AI key configured"
                        />
                      )}
                    </Link>
                  </Td>
                  <Td>
                    <PlanBadge
                      plan={row.plan}
                      source={row.planSource}
                      title={
                        row.compedNote
                          ? `Comped${row.compedAt ? ` ${row.compedAt.toISOString().slice(0, 10)}` : ""} — ${row.compedNote}`
                          : undefined
                      }
                    />
                  </Td>
                  <Td numeric>{row.counts.contacts}</Td>
                  <Td numeric>{row.counts.interactions}</Td>
                  <Td numeric>
                    {row.counts.aiCalls}
                    {row.counts.aiFailures > 0 && (
                      <span
                        className="ml-1 text-destructive"
                        title={`${row.counts.aiFailures} failed`}
                      >
                        ⚠
                      </span>
                    )}
                  </Td>
                  <Td numeric>
                    <RelativeTime date={row.lastSeenAt} />
                  </Td>
                  <Td numeric>
                    <RelativeTime date={row.signupAt} />
                  </Td>
                  <Td className="text-right">
                    <CompPlanButton
                      targetUserId={row.userId}
                      email={row.email}
                      currentPlan={row.plan}
                      currentSource={row.planSource}
                      contactCount={row.counts.contacts}
                      compedNote={row.compedNote}
                      variant="menu"
                    />
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
