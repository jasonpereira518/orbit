import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { NetworkMetrics } from "@/lib/network-metrics";
import { cn } from "@/lib/utils";

const INNER_SLIVER_PCT = 5;

const TIER_META = [
  {
    key: "inner" as const,
    label: "Inner",
    color: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-300",
  },
  {
    key: "mid" as const,
    label: "Mid",
    color: "bg-primary",
    text: "text-primary",
  },
  {
    key: "outer" as const,
    label: "Outer",
    color: "bg-muted-foreground/30",
    text: "text-muted-foreground",
  },
];

const DEGREE_BUCKETS = [
  { key: "none" as const, label: "0 links", color: "bg-muted-foreground/25" },
  { key: "oneToTwo" as const, label: "1–2 links", color: "bg-primary/70" },
  { key: "threePlus" as const, label: "3+ links", color: "bg-amber-500/80" },
];

function pct(count: number, total: number) {
  if (total === 0) return 0;
  return Math.round((count / total) * 100);
}

/** Bar widths with a permanent Inner amber sliver when inner share is 0. */
function tierBarWidths(tierCounts: NetworkMetrics["tierCounts"], total: number) {
  const innerRaw = pct(tierCounts.inner, total);
  const midRaw = pct(tierCounts.mid, total);
  const outerRaw = pct(tierCounts.outer, total);

  const innerWidth = Math.max(innerRaw, INNER_SLIVER_PCT);
  const remaining = 100 - innerWidth;
  const midOuterSum = midRaw + outerRaw;

  if (midOuterSum <= 0) {
    return { inner: innerWidth, mid: 0, outer: Math.max(0, remaining) };
  }

  const scale = remaining / midOuterSum;
  return {
    inner: innerWidth,
    mid: Math.round(midRaw * scale),
    outer: Math.max(0, 100 - innerWidth - Math.round(midRaw * scale)),
  };
}

export function NetworkDepthChart({
  metrics,
}: {
  metrics: NetworkMetrics;
}) {
  const { tierCounts, totalContacts, totalPeerEdges, avgPeerDegree, degreeBuckets } =
    metrics;
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
            Closeness tiers
          </p>
          <div className="flex h-3.5 overflow-hidden rounded-full bg-muted/40">
            {TIER_META.map((t) => {
              const width = barWidths[t.key];
              if (width <= 0) return null;
              return (
                <div
                  key={t.key}
                  className={cn(t.color, "transition-all")}
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
            Strength, recency, and goal alignment combined
          </p>
        </div>

        <div className="space-y-2.5 border-t border-border/60 pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Peer connections
          </p>
          <div className="grid grid-cols-3 gap-4">
            <StatMini label="Contacts" value={totalContacts} />
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
            Links inferred from shared company, event, tags, and mentions
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
      <p className="mt-0.5 font-[family-name:var(--font-display)] text-xl text-primary">
        {value}
      </p>
    </div>
  );
}
