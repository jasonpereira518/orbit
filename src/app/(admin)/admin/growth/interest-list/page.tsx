import Link from "next/link";
import { Download, MailCheck, MailX, UserCheck, Users } from "lucide-react";
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
import { Pager } from "@/components/admin/pager";
import { InterestListRowActions } from "@/components/admin/interest-list-actions";
import { cn } from "@/lib/utils";
import {
  getInterestListSummary,
  INTEREST_LIST_PAGE_SIZE,
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
 * route so `isAdminNavActive` keeps Growth lit in the nav rather than adding an eighth
 * top-level item for a list that is checked occasionally.
 *
 * EVERY COLUMN IS FIRST-PARTY. These addresses were typed into Orbit's own form by their
 * owners, which is what separates this from the contact data the export route refuses to
 * emit — nothing here is a third party's information held on someone else's behalf.
 */
export default async function AdminInterestListPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; page?: string }>;
}) {
  const params = await searchParams;
  const filter: InterestListFilter = isInterestListFilter(params.filter)
    ? params.filter
    : "all";
  const requestedPage = Number.parseInt(params.page ?? "1", 10);

  const [summary, listing] = await Promise.all([
    getInterestListSummary(),
    loadInterestList({
      page: Number.isFinite(requestedPage) ? requestedPage : 1,
      filter,
    }),
  ]);

  const hrefFor = (page: number) =>
    `/admin/growth/interest-list?filter=${filter}&page=${page}`;

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
          <a
            href={`/api/admin/export?dataset=interest-list&filter=${filter}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-fast hover:text-primary"
          >
            <Download className="size-3.5" aria-hidden />
            Export CSV
          </a>
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

      <AdminPanel
        action={
          <nav className="flex flex-wrap items-center gap-1" aria-label="Filter">
            {FILTERS.map((option) => {
              const active = option.value === filter;
              return (
                <Link
                  key={option.value}
                  href={`/admin/growth/interest-list?filter=${option.value}`}
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
        }
      >
        {listing.rows.length === 0 ? (
          <EmptyState>
            {filter === "all"
              ? "Nobody has joined yet."
              : "No signups match this filter."}
          </EmptyState>
        ) : (
          <>
            <AdminTable
              head={
                <>
                  <Th>Email</Th>
                  <Th>Signed up</Th>
                  <Th>Source</Th>
                  <Th>Status</Th>
                  <Th>Follow-up</Th>
                  <Th>Planet</Th>
                  <Th className="text-right">Actions</Th>
                </>
              }
            >
              {listing.rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border/40 last:border-0 hover:bg-muted/30"
                >
                  <Td className="font-medium text-ink">{row.email}</Td>
                  <Td>
                    {/* Absolute first — "when did they join" is the question, and a
                        relative label alone stops being an answer after a month. */}
                    <span className="tabular-nums">{absolute(row.createdAt)}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      <RelativeTime date={row.createdAt} /> ago
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">{sourceLabel(row)}</Td>
                  <Td>
                    {row.unsubscribedAt ? (
                      <span className="text-destructive">Unsubscribed</span>
                    ) : row.converted ? (
                      <span className="text-accent-foreground">Converted</span>
                    ) : (
                      <span className="text-muted-foreground">Active</span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">
                    {row.followUpSentAt ? (
                      <RelativeTime date={row.followUpSentAt} />
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="capitalize text-muted-foreground">
                    {row.welcomePlanet ?? "—"}
                  </Td>
                  <Td>
                    <InterestListRowActions
                      id={row.id}
                      email={row.email}
                      unsubscribed={row.unsubscribedAt !== null}
                    />
                  </Td>
                </tr>
              ))}
            </AdminTable>

            <Pager
              page={listing.page}
              pageCount={listing.pageCount}
              total={listing.total}
              pageSize={INTEREST_LIST_PAGE_SIZE}
              hrefFor={hrefFor}
              label="signups"
            />
          </>
        )}
      </AdminPanel>
    </>
  );
}
