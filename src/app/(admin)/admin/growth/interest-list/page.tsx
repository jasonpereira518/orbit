import Link from "next/link";
import { Download, Eye, MailCheck, MailX, Megaphone, UserCheck, Users } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  MetricTile,
  Td,
  Th,
  TrendBars,
} from "@/components/admin/primitives";
import { Pager } from "@/components/admin/pager";
import {
  InterestListTable,
  type InterestListTableRow,
} from "@/components/admin/interest-list-table";
import { cn } from "@/lib/utils";
import {
  getInterestListSummary,
  INTEREST_LIST_PAGE_SIZE,
  interestListSources,
  interestListTrend,
  isInterestListFilter,
  loadInterestList,
  sourceLabel,
  type InterestListFilter,
} from "@/lib/admin-interest-list";

export const metadata = { title: "Admin · Interest list" };

const FILTERS: Array<{ value: InterestListFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "converted", label: "Converted" },
  { value: "unsubscribed", label: "Unsubscribed" },
];

/** Absolute date, spelled out. The relative label rides alongside it, not instead of it. */
function absolute(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

/**
 * Everyone who filled in the landing page's interest-list form, and when.
 *
 * A page rather than a bigger panel on `/admin/growth`: that panel answers "is anyone
 * joining", which is a number, and this answers "who", which is a roster. Kept as a child
 * route so `isAdminNavActive` keeps Growth lit in the nav.
 *
 * EVERY COLUMN IS FIRST-PARTY. These addresses were typed into Orbit's own form by their
 * owners, which is what separates this from the contact data the export route refuses to
 * emit — nothing here is a third party's information held on someone else's behalf.
 */
export default async function AdminInterestListPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; page?: string; q?: string }>;
}) {
  const params = await searchParams;
  const filter: InterestListFilter = isInterestListFilter(params.filter)
    ? params.filter
    : "all";
  const q = (params.q ?? "").trim();
  const requestedPage = Number.parseInt(params.page ?? "1", 10);

  const [summary, listing, trend, sources] = await Promise.all([
    getInterestListSummary(),
    loadInterestList({
      page: Number.isFinite(requestedPage) ? requestedPage : 1,
      filter,
      q,
    }),
    interestListTrend("week", 12),
    interestListSources(),
  ]);

  const query = (over: Record<string, string | number>) => {
    const sp = new URLSearchParams();
    if (filter !== "all") sp.set("filter", filter);
    if (q) sp.set("q", q);
    for (const [k, v] of Object.entries(over)) sp.set(k, String(v));
    const s = sp.toString();
    return `/admin/growth/interest-list${s ? `?${s}` : ""}`;
  };

  const rows: InterestListTableRow[] = listing.rows.map((row) => ({
    id: row.id,
    email: row.email,
    createdAtIso: row.createdAt.toISOString(),
    createdAtLabel: absolute(row.createdAt),
    source: sourceLabel(row),
    status: row.unsubscribedAt ? "unsubscribed" : row.converted ? "converted" : "active",
    followUpSentAtIso: row.followUpSentAt ? row.followUpSentAt.toISOString() : null,
    planet: row.welcomePlanet,
  }));

  return (
    <>
      <AdminPageHeader
        title="Interest list"
        subtitle={
          <>
            Everyone who filled in the landing page form, newest first.{" "}
            <Link
              href="/admin/growth"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Back to Growth
            </Link>
          </>
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/admin/growth/broadcasts"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-fast hover:text-primary"
            >
              <Megaphone className="size-3.5" aria-hidden />
              Broadcasts
            </Link>
            <a
              href="/api/admin/email-preview?template=welcome"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-fast hover:text-primary"
            >
              <Eye className="size-3.5" aria-hidden />
              Preview emails
            </a>
            <a
              href={`/api/admin/export?dataset=interest-list&filter=${filter}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-fast hover:text-primary"
            >
              <Download className="size-3.5" aria-hidden />
              Export CSV
            </a>
          </div>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile label="Signups" value={summary.total} icon={Users} />
        <MetricTile
          label="Active"
          value={summary.active}
          hint="Subscribed, no account yet — the mailable audience"
          icon={MailCheck}
          tone="accent"
        />
        <MetricTile
          label="Converted"
          value={summary.converted}
          hint="Went on to create an Orbit account"
          icon={UserCheck}
        />
        <MetricTile
          label="Unsubscribed"
          value={summary.unsubscribed}
          hint={`${summary.followUpsSent} day-3 follow-ups sent`}
          icon={MailX}
          tone={summary.unsubscribed > 0 ? "danger" : "muted"}
        />
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <AdminPanel title="Signups by week">
          <TrendBars
            rows={trend.map((p) => ({
              label: p.bucketStart.toISOString().slice(5, 10),
              count: p.count,
            }))}
            emptyLabel="No signups yet."
          />
        </AdminPanel>

        {/* The conversion column is the point: a channel with volume and no accounts is
            the thing worth knowing, and every column here was already being stored. */}
        <AdminPanel title="Where they come from">
          {sources.length === 0 ? (
            <EmptyState>No signups yet.</EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Source</Th>
                  <Th numeric>Signups</Th>
                  <Th numeric>Became accounts</Th>
                </>
              }
            >
              {sources.map((s) => (
                <tr key={s.source} className="border-b border-border/40 last:border-0">
                  <Td className="text-muted-foreground">{s.source}</Td>
                  <Td numeric>{s.count}</Td>
                  <Td numeric className={s.converted === 0 ? "text-muted-foreground/50" : undefined}>
                    {s.converted}
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>
      </div>

      <AdminPanel
        action={
          <div className="flex flex-wrap items-center gap-3">
            {/* A GET form, so a search is linkable and survives a reload — same reasoning
                as the server-rendered pager. */}
            <form method="GET" action="/admin/growth/interest-list" className="flex gap-1.5">
              {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
              <input
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Search email…"
                aria-label="Search by email"
                className="w-44 rounded-lg border border-border/70 bg-transparent px-2.5 py-1 text-xs outline-none focus:border-primary/50"
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
                    href={`/admin/growth/interest-list${s ? `?${s}` : ""}`}
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
        {rows.length === 0 ? (
          <EmptyState>
            {q
              ? `No signups match “${q}”.`
              : filter === "all"
                ? "Nobody has joined yet."
                : "No signups match this filter."}
          </EmptyState>
        ) : (
          <>
            <InterestListTable rows={rows} />
            <Pager
              page={listing.page}
              pageCount={listing.pageCount}
              total={listing.total}
              pageSize={INTEREST_LIST_PAGE_SIZE}
              hrefFor={(page) => query({ page })}
              label="signups"
            />
          </>
        )}
      </AdminPanel>
    </>
  );
}
