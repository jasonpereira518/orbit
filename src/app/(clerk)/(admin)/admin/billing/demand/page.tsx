import {
  AdminPageHeader,
  AdminPanel,
  MetricTile,
} from "@/components/admin/primitives";
import { MoneyTabs } from "@/components/admin/money-tabs";
import { RankedBars } from "@/components/admin/charts";
import { loadAdminUserRows } from "@/lib/admin-metrics";
import { FREE_CONTACT_LIMIT } from "@/lib/plan-limits";
import { KNOWN_GATES, gateDemand } from "@/lib/money-metrics";

export const metadata = { title: "Admin · Money · Demand" };

/** Human labels for the gate keys, which are `FeatureKey` values plus the contact cap. */
const GATE_LABELS: Record<string, string> = {
  contacts: `Contact cap (${FREE_CONTACT_LIMIT})`,
  outreach: "Outreach",
  hostedSending: "Hosted sending",
  hostedEnrichment: "Hosted enrichment",
  recruiters: "Recruiter tools",
  sync: "Calendar / mail sync",
  extension: "Browser extension",
};

/**
 * Revenue that wanted to arrive and could not.
 *
 * `usage_events` records what happened and by construction cannot record what someone
 * tried to do and was refused, which makes `gate_events` the only evidence of demand for a
 * feature nobody could reach. It is the direct input to the pricing question, and it is
 * the one money stream that was already being written in production before this section
 * existed — so unlike the revenue ledger, there is real history here from day one.
 */
export default async function MoneyDemandPage() {
  const [demand, rows] = await Promise.all([gateDemand(30), loadAdminUserRows()]);

  const byFeature = new Map(demand.map((d) => [d.feature, d]));

  // Every known gate is listed, including the ones nothing hit. A wall nobody reaches is a
  // finding — the feature is in the wrong tier, or nobody knows it exists — and filtering
  // empty rows out would hide precisely that.
  const rowsForChart = KNOWN_GATES.map((feature) => {
    const hit = byFeature.get(feature);
    return {
      label: GATE_LABELS[feature] ?? feature,
      count: hit?.distinctUsers ?? 0,
      sub: hit?.converted ?? 0,
      subLabel: "upgraded within 30 days",
      detail: hit
        ? `${hit.hits} refusals across ${hit.distinctUsers} ${
            hit.distinctUsers === 1 ? "person" : "people"
          } · ${hit.freeUsers} on the free plan · ${hit.converted} upgraded within 30 days`
        : "Nobody reached this wall in the last 30 days.",
    };
  }).sort((a, b) => b.count - a.count);

  const totalRefused = demand.reduce((sum, d) => sum + d.distinctUsers, 0);
  const totalConverted = demand.reduce((sum, d) => sum + d.converted, 0);
  const nearCap = rows.filter(
    (r) => r.plan === "free" && r.counts.contacts >= FREE_CONTACT_LIMIT * 0.8
  );

  return (
    <>
      <AdminPageHeader
        title="Demand"
        subtitle="Who hit a wall, and whether they paid to get past it"
      />
      <MoneyTabs />

      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricTile
            label="Refused, 30 days"
            value={totalRefused}
            hint="distinct people, not hits"
          />
          <MetricTile
            label="Upgraded after"
            value={totalConverted}
            tone={totalConverted > 0 ? "accent" : "muted"}
            hint="within 30 days of the wall"
          />
          <MetricTile
            label="Near the free cap"
            value={nearCap.length}
            tone={nearCap.length > 0 ? "accent" : "muted"}
            hint={`free accounts at 80%+ of ${FREE_CONTACT_LIMIT}`}
          />
        </div>

        <AdminPanel title="Which wall, and who got past it">
          <RankedBars rows={rowsForChart} />
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            People, not refusals — someone who hits a wall forty times is one person who
            wanted the feature, and counting hits would make the noisiest wall look like
            the most valuable one. The green segment is how many of them paid within thirty
            days. Hover a row for the full breakdown.
          </p>
        </AdminPanel>

        <AdminPanel title="How to read this">
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>
              <strong className="text-foreground">A tall bar with green in it</strong> is a
              wall doing its job: people want the feature and some of them pay for it.
            </li>
            <li>
              <strong className="text-foreground">A tall bar with no green</strong> is
              demand that is not converting. Either the price is wrong for what is behind
              it, or the upgrade path from that refusal is broken.
            </li>
            <li>
              <strong className="text-foreground">An empty bar</strong> is a feature in the
              wrong tier — nobody is reaching it, so gating it earns nothing. That is why
              unhit walls are listed rather than filtered out.
            </li>
          </ul>
          <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Conversion is attributed generously: any recurring revenue within thirty days
            of a refusal counts, whether or not that wall is what prompted it. It is an
            upper bound, and reading it as proof of causation is the mistake to avoid.
          </p>
        </AdminPanel>
      </div>
    </>
  );
}
