import Link from "next/link";
import { Download, Image as ImageIcon, Inbox } from "lucide-react";
import { FeedbackTabs } from "@/components/admin/admin-tabs";
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
  getFeedbackThemes,
  isFeedbackArea,
  isFeedbackCategory,
  isFeedbackFilter,
  loadFeedbackList,
  type FeedbackFilter,
} from "@/lib/admin-feedback";
import { FeedbackInboxLive } from "@/components/admin/feedback-inbox-live";
import { LogFeedbackDialog } from "@/components/admin/log-feedback-dialog";
import { SOURCE_LABELS, isFeedbackSource } from "@/lib/feedback-report";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Feedback" };

const FILTERS: Array<{ value: FeedbackFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "triaged", label: "Triaged" },
  { value: "resolved", label: "Resolved" },
];

const SEVERITY_CLASS: Record<string, string> = {
  high: "bg-destructive/15 text-destructive",
  medium: "bg-accent/20 text-accent-foreground",
  low: "bg-muted text-muted-foreground",
};

const STATUS_CLASS: Record<string, string> = {
  new: "bg-accent/20 text-accent-foreground",
  triaged: "bg-muted text-muted-foreground",
  resolved: "bg-muted/50 text-muted-foreground-subtle",
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
  searchParams: Promise<{ filter?: string; page?: string; q?: string; area?: string; category?: string }>;
}) {
  const params = await searchParams;
  const filter: FeedbackFilter = isFeedbackFilter(params.filter) ? params.filter : "all";
  const q = (params.q ?? "").trim();
  const area = isFeedbackArea(params.area) ? params.area : null;
  const category = isFeedbackCategory(params.category) ? params.category : null;
  const requestedPage = Number.parseInt(params.page ?? "1", 10);

  const [summary, listing, themes] = await Promise.all([
    getFeedbackSummary(),
    loadFeedbackList({
      page: Number.isFinite(requestedPage) ? requestedPage : 1,
      filter,
      q,
      area,
      category,
    }),
    getFeedbackThemes(28),
  ]);
  // Triaged and Resolved are states to filter by, not numbers to watch, so their counts ride
  // on the filter chips rather than taking a tile each.
  const filterCount: Record<FeedbackFilter, number> = {
    all: summary.total,
    new: summary.new,
    triaged: summary.triaged,
    resolved: summary.resolved,
  };

  const query = (over: Record<string, string | number>) => {
    const sp = new URLSearchParams();
    if (filter !== "all") sp.set("filter", filter);
    if (q) sp.set("q", q);
    if (area) sp.set("area", area);
    if (category) sp.set("category", category);
    for (const [k, v] of Object.entries(over)) sp.set(k, String(v));
    const s = sp.toString();
    return `/admin/feedback${s ? `?${s}` : ""}`;
  };

  const clearFacetsHref = (() => {
    const sp = new URLSearchParams();
    if (filter !== "all") sp.set("filter", filter);
    if (q) sp.set("q", q);
    const s = sp.toString();
    return `/admin/feedback${s ? `?${s}` : ""}`;
  })();

  return (
    <>
      <AdminPageHeader
        title="Feedback"
        subtitle="What users told us about Orbit, newest first."
        action={
          <div className="flex items-center gap-2">
          <LogFeedbackDialog />
          <a
            href={`/api/admin/export?dataset=feedback&filter=${filter}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-fast hover:text-primary"
          >
            <Download className="size-3.5" aria-hidden />
            Export CSV
          </a>
          </div>
        }
      />
      <FeedbackTabs />
      <FeedbackInboxLive />

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <MetricTile
          label="New"
          value={summary.new}
          hint="Nobody has looked at these yet"
          icon={Inbox}
          tone={summary.new > 0 ? "accent" : "muted"}
        />
        <MetricTile
          label="Last 7 days"
          value={summary.last7Days}
          hint={`${summary.withScreenshots} with screenshots`}
          icon={ImageIcon}
        />
      </div>

      <AdminPanel title={`What people are saying · last ${themes.days} days`}>
        {themes.byCategory.length === 0 ? (
          <EmptyState>No feedback in this window.</EmptyState>
        ) : (
          <div className="grid gap-6 py-1 sm:grid-cols-2">
            <div>
              <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">By kind</div>
              <ul className="space-y-1 text-sm">
                {themes.byCategory.map((c) => (
                  <li key={c.category} className="flex items-center justify-between gap-3">
                    <Link
                      href={isFeedbackCategory(c.category) ? query({ category: c.category, page: 1 }) : query({ page: 1 })}
                      className={cn("underline-offset-2 hover:underline", category === c.category && "text-primary")}
                    >
                      {c.category}
                      {c.sentiment && <span className="ml-2 text-xs text-muted-foreground">{c.sentiment}</span>}
                    </Link>
                    <span className="tabular-nums">{c.count}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">By area</div>
              <ul className="space-y-1 text-sm">
                {themes.byArea.slice(0, 8).map((a) => (
                  <li key={a.area} className="flex items-center justify-between gap-3">
                    <Link
                      href={isFeedbackArea(a.area) ? query({ area: a.area, page: 1 }) : query({ page: 1 })}
                      className={cn("underline-offset-2 hover:underline", area === a.area && "text-primary")}
                    >
                      {a.area}
                    </Link>
                    <span className="tabular-nums">
                      {a.count}
                      {a.negative > 0 && <span className="ml-1 text-xs text-destructive">{a.negative} negative</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <p className="mt-3 border-t border-border/40 pt-2 text-xs text-muted-foreground">
          {themes.contactableOpen} unresolved {themes.contactableOpen === 1 ? "entry" : "entries"} where the person said we may contact them.
          {(area || category) && (
            <>
              {" "}
              Filtering by {[category, area].filter(Boolean).join(" · ")}.{" "}
              <Link href={clearFacetsHref} className="underline underline-offset-2">
                Clear
              </Link>
            </>
          )}
        </p>
      </AdminPanel>

      <AdminPanel
        className="mt-6"
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
                className="w-52 rounded-lg border border-border/70 bg-transparent px-2.5 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
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
                    {option.label}{" "}
                    <span className="tabular-nums text-muted-foreground">{filterCount[option.value]}</span>
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
              label="Feedback"
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
                    {row.contactOk && <span className="ml-1 text-[0.625rem] text-accent-foreground" title="Said we may contact them">✉</span>}
                  </Td>
                  <Td>
                    {/* The triage line when there is one: a sentence someone wrote for
                        reading at a glance beats the first 180 characters of a report. */}
                    <Link
                      href={`/admin/feedback/${row.id}`}
                      className="underline underline-offset-2 hover:text-primary"
                    >
                      {row.subject ? (
                        <span className="font-medium">{row.subject}</span>
                      ) : (
                        row.triage?.summary ||
                        row.excerpt?.trim() || <span className="text-muted-foreground">(no text)</span>
                      )}
                    </Link>
                    {row.subject && row.triage?.summary && (
                      <span className="block text-xs text-muted-foreground">{row.triage.summary}</span>
                    )}
                    {isFeedbackSource(row.source) && (
                      <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 align-middle text-[0.625rem] text-muted-foreground">
                        via {SOURCE_LABELS[row.source]}
                      </span>
                    )}
                    {row.unreadReply && (
                      <span className="ml-2 rounded-full bg-primary/15 px-1.5 py-0.5 align-middle text-[0.625rem] font-medium text-primary">
                        new reply
                      </span>
                    )}
                    {row.triage && (
                      <span className="ml-2 inline-flex items-center gap-1.5 align-middle">
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium",
                            SEVERITY_CLASS[row.triage.severity]
                          )}
                        >
                          {row.triage.severity}
                        </span>
                        {row.triage.duplicateOf && (
                          <Link
                            href={`/admin/feedback/${row.triage.duplicateOf}`}
                            className="text-[0.625rem] text-muted-foreground underline-offset-2 hover:underline"
                            title="Looks like an earlier open report"
                          >
                            ↳ dup
                          </Link>
                        )}
                      </span>
                    )}
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
