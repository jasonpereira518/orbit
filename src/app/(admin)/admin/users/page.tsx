import Link from "next/link";
import { CircleAlert, Ban, Download } from "lucide-react";
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
import { Pager } from "@/components/admin/pager";
import { UsersFilterBar } from "@/components/admin/users-filter-bar";
import { CompPlanButton } from "@/components/admin/comp-plan-dialog";
import {
  isRosterSort,
  loadAdminRoster,
  ROSTER_PAGE_SIZE,
  type RosterPlanFilter,
  type RosterSort,
  type RosterStateFilter,
} from "@/lib/admin-roster";

export const metadata = { title: "Admin · Users" };

/**
 * The roster.
 *
 * Filtering, sorting and paging all happen in SQL (`src/lib/admin-roster.ts`). This page
 * used to load every account and reduce in JS, on the reasoning that a derived sort ("most
 * contacts") could not be pushed into the base query. That was true of the fan-out shape it
 * used, but not of the problem: as CTEs joined onto `user_settings` the derived columns are
 * in the base query, so the database can do the work it is for.
 *
 * `/admin` still uses the full fan-out, because the funnel and the alert list genuinely
 * need every row.
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    plan?: string;
    sort?: string;
    dir?: string;
    state?: string;
    page?: string;
  }>;
}) {
  const params = await searchParams;

  const q = (params.q ?? "").trim();
  const plan = (params.plan ?? "all") as RosterPlanFilter;
  const state = (params.state ?? "all") as RosterStateFilter;
  const sort: RosterSort = isRosterSort(params.sort) ? params.sort : "signup";
  const dir = params.dir === "asc" ? "asc" : params.dir === "desc" ? "desc" : undefined;
  const page = Math.max(Number.parseInt(params.page ?? "1", 10) || 1, 1);

  const result = await loadAdminRoster({
    q,
    plan,
    state,
    sort,
    dir,
    page,
    pageSize: ROSTER_PAGE_SIZE,
  });

  const hrefWith = (next: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    const merged = { q, plan, state, sort, dir, page: String(page), ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (!value || value === "all") continue;
      if (key === "page" && value === "1") continue;
      if (key === "sort" && value === "signup" && !next.sort) continue;
      search.set(key, value);
    }
    const query = search.toString();
    return `/admin/users${query ? `?${query}` : ""}`;
  };

  /**
   * Clicking the active column flips direction rather than re-sorting by it — the second
   * click on "Contacts" means "show me the other end", which is where the interesting
   * accounts usually are.
   */
  const sortLink = (key: RosterSort, label: string) => {
    const active = sort === key;
    const nextDir =
      active && (dir ?? defaultDirFor(key)) === "desc" ? "asc" : "desc";
    return (
      <Link
        href={hrefWith({ sort: key, dir: nextDir, page: "1" })}
        className={active ? "text-primary" : "hover:text-foreground"}
      >
        {label}
        {active && (
          <span aria-hidden className="ml-0.5">
            {(dir ?? defaultDirFor(key)) === "asc" ? "↑" : "↓"}
          </span>
        )}
      </Link>
    );
  };

  const filtered = q !== "" || plan !== "all" || state !== "all";

  return (
    <>
      <AdminPageHeader
        title="Users"
        subtitle={
          filtered
            ? `${result.total} matching account${result.total === 1 ? "" : "s"}`
            : `${result.total} account${result.total === 1 ? "" : "s"}`
        }
        action={
          // Exports the current filter, not just this page — and account-level columns
          // only. No contact data leaves through here, grant or no grant.
          <a
            href={`/api/admin/export?dataset=roster&format=csv&${new URLSearchParams(
              Object.entries({ q, plan, state, sort }).filter(
                ([, v]) => v && v !== "all"
              ) as [string, string][]
            ).toString()}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground"
          >
            <Download className="size-3" aria-hidden />
            Export CSV
          </a>
        }
      />

      <div className="space-y-4">
        <UsersFilterBar q={q} plan={plan} state={state} sort={sort} dir={dir} />

        <AdminPanel>
          {result.rows.length === 0 ? (
            <EmptyState>No accounts match these filters.</EmptyState>
          ) : (
            <>
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
                {result.rows.map((row) => (
                  <tr
                    key={row.userId}
                    className="border-b border-border/40 last:border-b-0 hover:bg-muted/40"
                  >
                    <Td>
                      <Link
                        href={`/admin/users/${encodeURIComponent(row.userId)}`}
                        className="flex items-center gap-2 hover:text-primary"
                      >
                        <span
                          className={
                            row.suspendedAt
                              ? "truncate text-muted-foreground line-through"
                              : "truncate"
                          }
                        >
                          {row.email ?? row.userId}
                        </span>
                        {row.suspendedAt && (
                          <Ban
                            className="size-3.5 shrink-0 text-destructive"
                            aria-label="Suspended"
                          />
                        )}
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

              <div className="mt-3">
                <Pager
                  page={result.page}
                  pageCount={result.pageCount}
                  total={result.total}
                  pageSize={result.pageSize}
                  hrefFor={(target) => hrefWith({ page: String(target) })}
                />
              </div>
            </>
          )}
        </AdminPanel>
      </div>
    </>
  );
}

function defaultDirFor(key: RosterSort): "asc" | "desc" {
  return key === "email" ? "asc" : "desc";
}
