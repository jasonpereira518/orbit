import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { NetworkMetrics } from "@/lib/network-metrics";
import { cn } from "@/lib/utils";

/**
 * Labels here are deliberately NOT "Inner / Mid / Outer".
 *
 * A contact's orbit badge is its rank inside your network — the top slice is Inner
 * however warm or cold the whole network is. This chart counts by absolute score
 * instead (see `network-metrics.ts`), which is the more useful measure: it actually
 * moves when relationships warm up. But sharing the badge's words made the product
 * contradict itself out loud — three people badged INNER ORBIT on /contacts while
 * this card read "Inner 0 (0%)". Same colours, different nouns.
 */
const TIER_META = [
  {
    key: "inner" as const,
    label: "Close",
    color: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  {
    key: "mid" as const,
    label: "Warm",
    color: "bg-sky-500",
    text: "text-sky-700 dark:text-sky-300",
  },
  {
    key: "outer" as const,
    label: "Cool",
    color: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-300",
  },
];

const DEGREE_BUCKETS = [
  { key: "none" as const, label: "0 links", color: "bg-muted-foreground/25" },
  { key: "oneToTwo" as const, label: "1–2 links", color: "bg-sky-500/70" },
  { key: "threePlus" as const, label: "3+ links", color: "bg-emerald-500/80" },
];

function pct(count: number, total: number) {
  if (total === 0) return 0;
  return Math.round((count / total) * 100);
}

/** Honest bar widths from the real Close/Warm/Cool shares. */
function tierBarWidths(tierCounts: NetworkMetrics["tierCounts"], total: number) {
  return {
    inner: pct(tierCounts.inner, total),
    mid: pct(tierCounts.mid, total),
    outer: pct(tierCounts.outer, total),
  };
}

export function NetworkDepthChart({
  metrics,
}: {
  metrics: NetworkMetrics;
}) {
  const {
    tierCounts,
    totalContacts,
    totalPeerEdges,
    avgPeerDegree,
    degreeBuckets,
    metricsSampleSize,
  } = metrics;
  // Peer-link analysis compares every pair, so past a few hundred contacts it runs on the
  // closest ones only. Say so rather than presenting a subset's numbers as the whole
  // network's — the tier bars above still cover everyone.
  const sampled = metricsSampleSize > 0 && metricsSampleSize < totalContacts;
  const tierTotal =
    tierCounts.inner + tierCounts.mid + tierCounts.outer || 1;
  const bucketTotal =
    degreeBuckets.none + degreeBuckets.oneToTwo + degreeBuckets.threePlus || 1;
  const barWidths = tierBarWidths(tierCounts, tierTotal);

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="pb-4">
        <CardTitle className="text-base">Network depth</CardTitle>
        <p className="text-sm text-muted-foreground">
          How close your network feels and how people connect to each other
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Relationship strength
          </p>
          <div className="flex h-3.5 overflow-hidden rounded-full bg-muted/40">
            {TIER_META.map((t) => {
              const width = barWidths[t.key];
              if (width <= 0) return null;
              return (
                <div
                  key={t.key}
                  className={cn(t.color, "transition-[width] duration-slow ease-house")}
                  style={{ width: `${width}%` }}
                  title={`${t.label}: ${tierCounts[t.key]}`}
                />
              );
            })}
          </div>
          <div className="grid gap-1.5 sm:grid-cols-3 sm:gap-3">
            {TIER_META.map((t) => {
              const count = tierCounts[t.key];
              return (
                <div
                  key={t.key}
                  className="flex items-baseline justify-between gap-2 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <span className={cn("h-2 w-2 shrink-0 rounded-full", t.color)} />
                    <span className={t.text}>{t.label}</span>
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {count}{" "}
                    <span className="text-xs">({pct(count, tierTotal)}%)</span>
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Strength, recency, cadence, and goal alignment combined — measured on
            its own terms, not ranked against the rest of your network
          </p>
        </div>

        <div className="space-y-2.5 border-t border-border/60 pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Peer connections
            </p>
            {sampled && (
              <p className="text-xs text-muted-foreground/80">
                across your closest {metricsSampleSize.toLocaleString()}
              </p>
            )}
          </div>
          <div className="grid grid-cols-3 gap-4">
            <StatMini
              label="Contacts"
              value={sampled ? metricsSampleSize : totalContacts}
            />
            <StatMini label="Peer links" value={totalPeerEdges} />
            <StatMini label="Avg links" value={avgPeerDegree} />
          </div>
          <div className="space-y-2 pt-1">
            {DEGREE_BUCKETS.map((b) => {
              const count = degreeBuckets[b.key];
              const width = pct(count, bucketTotal);
              return (
                <div key={b.key} className="flex items-center gap-3 text-xs">
                  <span className="w-16 shrink-0 text-muted-foreground">
                    {b.label}
                  </span>
                  <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/40">
                    <div
                      className={cn("h-full rounded-full", b.color)}
                      style={{
                        width: `${Math.max(width, count > 0 ? 4 : 0)}%`,
                      }}
                    />
                  </div>
                  <span className="w-6 shrink-0 text-right tabular-nums font-medium">
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Links inferred from shared company, school, tags, interests, and
            mentions
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function StatMini({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 font-[family-name:var(--font-display)] text-xl text-ink">
        {value}
      </p>
    </div>
  );
}
