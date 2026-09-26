import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  EmptyState,
  Td,
  Th,
} from "@/components/admin/primitives";
import { TrafficTabs } from "@/components/admin/traffic-tabs";
import { FunnelParkingPanel } from "@/components/admin/product-health-panels";
import {
  MIN_RATE_DENOMINATOR,
  RANGES,
  acquisitionFunnel,
  formatRate,
  rangeDays,
  type Range,
} from "@/lib/admin-analytics";
import { analyticsDisabledReason } from "@/lib/analytics-visitor";

export const metadata = { title: "Admin · Conversion" };

/**
 * Visitor through to paid.
 *
 * THIS PAGE BREAKS THE HOUSE RULE, ON PURPOSE AND WITH A LIMIT. `/admin/growth` bans
 * percentages outright — "at this scale a percentage is two people wearing a confidence
 * interval" — and it is right for what it shows. But conversion rate is a ratio or it is
 * nothing, so the compromise is that every stage prints its own fraction, and the
 * percentage is withheld entirely until the denominator reaches
 * {@link MIN_RATE_DENOMINATOR}. "3 of 4" is a fact; "75%" from the same data is a claim
 * about the next hundred visitors that nobody can make yet.
 *
 * THE STAGES ARE NOT ONE CHAIN OF PEOPLE. Stages 1-2 count traffic; 3 counts the interest
 * list; 4-6 count accounts. They are three populations measured over the same days, not a
 * cohort followed through. Nothing connects the visitor who read /pricing on Tuesday to
 * the account created on Thursday, because the visitor hash is salted per day and dies at
 * midnight — the same property that lets the whole pipeline run without a cookie or a
 * consent banner. Presenting this as per-person attribution would be inventing a join
 * that does not exist.
 */
export default async function AdminFunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const params = await searchParams;
  const range: Range = RANGES.includes(params.range as Range)
    ? (params.range as Range)
    : "30d";

  const disabled = analyticsDisabledReason();
  const stages = await acquisitionFunnel(range).catch(() => []);
  const days = rangeDays(range);

  const rangeLink = (value: Range) => (
    <a
      key={value}
      href={`/admin/analytics/funnel${value === "30d" ? "" : `?range=${value}`}`}
      className={
        range === value
          ? "text-primary"
          : "text-muted-foreground hover:text-foreground"
      }
    >
      {value === "7d" ? "7 days" : value === "30d" ? "30 days" : "90 days"}
    </a>
  );

  // Each population is scaled against its own largest stage. One scale across all three drew
  // a few signups as a sliver under thousands of visitor-days — a narrowing funnel of one
  // group of people, which is exactly the reading this page exists to prevent.
  const groupMax = new Map<string, number>();
  for (const stage of stages) {
    groupMax.set(stage.group, Math.max(groupMax.get(stage.group) ?? 1, stage.count));
  }

  return (
    <>
      <AdminPageHeader
        title="Conversion"
        subtitle={`Visitor through to paid, over the last ${days} days.`}
      />

      <TrafficTabs />

      <div className="space-y-6">
        <div className="flex items-center gap-3 text-xs">
          {rangeLink("7d")}
          <span className="text-muted-foreground/40">·</span>
          {rangeLink("30d")}
          <span className="text-muted-foreground/40">·</span>
          {rangeLink("90d")}
        </div>

        <AdminPanel title="The funnel">
          {stages.length === 0 ? (
            <EmptyState>
              {disabled ?? "Nothing recorded in this window yet."}
            </EmptyState>
          ) : (
            <AdminTable minWidth="none"
              head={
                <>
                  <Th>Stage</Th>
                  <Th numeric>Count</Th>
                  <Th>Conversion</Th>
                </>
              }
            >
              {stages.map((stage) => (
                <tr key={stage.label} className="border-b border-border/40">
                  <Td>
                    <div>{stage.label}</div>
                    {stage.note && (
                      <div className="text-xs text-muted-foreground">{stage.note}</div>
                    )}
                  </Td>
                  <Td numeric>{stage.count.toLocaleString()}</Td>
                  <Td>
                    <div className="flex items-center gap-3">
                      {/* Hand-built, like every other bar in this console. */}
                      <div
                        className="h-1.5 shrink-0 rounded-full bg-primary/70"
                        style={{
                          width: `${(stage.count / (groupMax.get(stage.group) ?? 1)) * 100}%`,
                          minWidth: 2,
                        }}
                        aria-hidden
                      />
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {stage.of == null
                          ? "—"
                          : `${formatRate(stage.count, stage.of)} ${stage.ofLabel ?? ""}`.trim()}
                      </span>
                    </div>
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>

        {/* The funnel says how many made it; this says where the rest stopped. Current
            state, not the selected range — an account parked at step 2 is parked now. */}
        <FunnelParkingPanel />

        <AdminPanel title="How to read this">
          <ul className="space-y-2 py-1 text-sm text-muted-foreground">
            <li>
              <span className="text-foreground">These are not one group of people.</span>{" "}
              The first two rows count traffic, the third counts the interest list, and the
              last three count accounts created in the same window. Each group&apos;s bars are
              scaled on their own, and every rate names what it is a fraction of. Nothing links a visitor
              to the account they later create — the visitor hash is salted per day and
              expires at midnight, which is exactly why Orbit needs no tracking cookie.
            </li>
            <li>
              <span className="text-foreground">Visitor-days, not visitors.</span> One
              person visiting on five days counts five times over a 30-day range. Read the
              first row as a ceiling on reach, not a headcount.
            </li>
            <li>
              <span className="text-foreground">
                Percentages appear at {MIN_RATE_DENOMINATOR}.
              </span>{" "}
              Below that only the fraction is shown. Two of three is not 67% of anything
              that will still be true next month.
            </li>
            <li>
              <span className="text-foreground">Interest list joins on email only.</span>{" "}
              There is no key between a list signup and an account, so that row cannot tell
              you which of those people came back.
            </li>
            <li>
              <span className="text-foreground">
                Activated and Paid wait a week.
              </span>{" "}
              Both are counted over accounts at least 7 days old, so a signup from
              yesterday is not scored as a miss. On the 7-day range that leaves nothing to
              count yet.
            </li>
            <li>
              <span className="text-foreground">Orbit&apos;s own accounts are left out.</span>{" "}
              Admins and the showcase account are excluded from every row, interest-list
              signups included when their email matches.
            </li>
            <li>
              <span className="text-foreground">Paid includes Lifetime, net of refunds.</span> A one-off
              purchase moves no recurring revenue, so a paid test written against MRR alone
              would score every Lifetime customer as a non-conversion. An account whose
              payments were refunded in full is not counted.
            </li>
          </ul>
        </AdminPanel>
      </div>
    </>
  );
}
