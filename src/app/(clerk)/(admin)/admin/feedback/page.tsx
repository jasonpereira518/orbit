import Link from "next/link";
import { CheckCircle2, Download, Image as ImageIcon, Inbox, MessageSquareText } from "lucide-react";
import { Pager } from "@/components/admin/pager";
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
  FEEDBACK_PAGE_SIZE,
  getFeedbackSummary,
  isFeedbackFilter,
  loadFeedbackList,
  type FeedbackFilter,
} from "@/lib/admin-feedback";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Feedback" };

const FILTERS: Array<{ value: FeedbackFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "triaged", label: "Triaged" },
  { value: "resolved", label: "Resolved" },
];

const STATUS_CLASS: Record<string, string> = {
  new: "bg-accent/20 text-accent-foreground",
  triaged: "bg-muted text-muted-foreground",
  resolved: "bg-muted/50 text-muted-foreground/70",
};

/**
 * What people told us, newest first.
 *
 * The first surface in Orbit to read the `feedback` table, which shipped with helpers and
 * no reader. Modelled on the interest-list roster rather than on a dashboard panel: the
 * question here is "who said what, and did anyone deal with it", which is a list with
 * state, not an aggregate.
 */
export default async function AdminFeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; page?: string; q?: string }>;
}) {
  const params = await searchParams;
  const filter: FeedbackFilter = isFeedbackFilter(params.filter) ? params.filter : "all";
  const q = (params.q ?? "").trim();
  const requestedPage = Number.parseInt(params.page ?? "1", 10);

  const [summary, listing] = await Promise.all([
    getFeedbackSummary(),
    loadFeedbackList({
      page: Number.isFinite(requestedPage) ? requestedPage : 1,
      filter,
      q,
    }),
  ]);

  const query = (over: Record<string, string | number>) => {
    const sp = new URLSearchParams();
    if (filter !== "all") sp.set("filter", filter);
    if (q) sp.set("q", q);
    for (const [k, v] of Object.entries(over)) sp.set(k, String(v));
    const s = sp.toString();
    return `/admin/feedback${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <AdminPageHeader
        title="Feedback"
        subtitle="What users told us about Orbit, newest first."
        action={
          <a
            href={`/api/admin/export?dataset=feedback&filter=${filter}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-fast hover:text-primary"
          >
            <Download className="size-3.5" aria-hidden />
            Export CSV
          </a>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="New"
          value={summary.new}
          hint="Nobody has looked at these yet"
          icon={Inbox}
          tone={summary.new > 0 ? "accent" : "muted"}
        />
        <MetricTile label="Triaged" value={summary.triaged} icon={MessageSquareText} />
        <MetricTile label="Resolved" value={summary.resolved} icon={CheckCircle2} />
        <MetricTile
          label="Last 7 days"
          value={summary.last7Days}
          hint={`${summary.withScreenshots} with screenshots`}
          icon={ImageIcon}
        />
      </div>

      <AdminPanel
        action={
          <div className="flex flex-wrap items-center gap-3">
            {/* A GET form, so a search is linkable and survives a reload — same reasoning
                as the server-rendered pager. */}
            <form method="GET" action="/admin/feedback" className="flex gap-1.5">
              {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
              <input
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Search what they wrote…"
                aria-label="Search feedback text"
                className="w-52 rounded-lg border border-border/70 bg-transparent px-2.5 py-1 text-xs outline-none focus:border-primary/50"
              />
              <button
                type="submit"
                className="rounded-lg border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-primary"
              >
                Search
              </button>
            </form>

            <nav className="flex flex-wrap items-center gap-1" aria-label="Filter">
              {FILTERS.map((option) => {
                const active = option.value === filter;
                const sp = new URLSearchParams();
                if (option.value !== "all") sp.set("filter", option.value);
                if (q) sp.set("q", q);
                const s = sp.toString();
                return (
                  <Link
                    key={option.value}
                    href={`/admin/feedback${s ? `?${s}` : ""}`}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "rounded-lg px-2.5 py-1 text-xs transition-colors duration-fast",
                      active
                        ? "bg-accent/15 text-accent-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {option.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        }
      >
        {listing.rows.length === 0 ? (
          <EmptyState>
            {q
              ? `Nothing matches “${q}”.`
              : filter === "all"
                ? "Nobody has sent any feedback yet."
                : "Nothing in this state."}
          </EmptyState>
        ) : (
          <>
            <AdminTable
              head={
                <>
                  <Th>When</Th>
                  <Th>Who</Th>
                  <Th>Area</Th>
                  <Th>Kind</Th>
                  <Th>What they said</Th>
                  <Th numeric>Shots</Th>
                  <Th>Status</Th>
                </>
              }
            >
              {listing.rows.map((row) => (
                <tr key={row.id} className="border-b border-border/40 last:border-0">
                  <Td className="whitespace-nowrap text-muted-foreground">
                    <RelativeTime date={row.createdAt} />
                  </Td>
                  <Td className="text-muted-foreground">
                    {row.submitterEmail ?? (
                      <span className="text-muted-foreground/50">account purged</span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{row.area ?? "—"}</Td>
                  <Td className="text-muted-foreground">
                    {row.category ?? (row.kind === "freeform" ? "—" : row.kind)}
                  </Td>
                  <Td>
                    <Link
                      href={`/admin/feedback/${row.id}`}
                      className="underline underline-offset-2 hover:text-primary"
                    >
                      {row.excerpt?.trim() || <span className="text-muted-foreground">(no text)</span>}
                    </Link>
                  </Td>
                  <Td
                    numeric
                    className={row.screenshotCount === 0 ? "text-muted-foreground/50" : undefined}
                  >
                    {row.screenshotCount}
                  </Td>
                  <Td>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[0.625rem] font-medium",
                        STATUS_CLASS[row.status]
                      )}
                    >
                      {row.status}
                    </span>
                  </Td>
                </tr>
              ))}
            </AdminTable>
            <Pager
              page={listing.page}
              pageCount={listing.pageCount}
              total={listing.total}
              pageSize={FEEDBACK_PAGE_SIZE}
              hrefFor={(page) => query({ page })}
              label="entries"
            />
          </>
        )}
      </AdminPanel>
    </>
  );
}
