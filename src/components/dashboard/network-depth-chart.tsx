import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { NetworkMetrics } from "@/lib/network-metrics";
import { cn } from "@/lib/utils";

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
    color: "bg-sky-500",
    text: "text-sky-700 dark:text-sky-300",
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
  { key: "oneToTwo" as const, label: "1–2 links", color: "bg-sky-500/70" },
  { key: "threePlus" as const, label: "3+ links", color: "bg-amber-500/80" },
];

function pct(count: number, total: number) {
  if (total === 0) return 0;
  return Math.round((count / total) * 100);
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

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Network depth</CardTitle>
        <p className="text-sm text-muted-foreground">
          How close your network feels and how people connect to each other
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Closeness tiers
          </p>
          <div className="flex h-3 overflow-hidden rounded-full bg-muted/40">
            {TIER_META.map((t) => {
              const count = tierCounts[t.key];
              const width = pct(count, tierTotal);
              if (width === 0) return null;
              return (
                <div
                  key={t.key}
                  className={cn(t.color, "transition-all")}
                  style={{ width: `${width}%` }}
                  title={`${t.label}: ${count}`}
                />
              );
            })}
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {TIER_META.map((t) => {
              const count = tierCounts[t.key];
              return (
                <div key={t.key} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2">
                    <span className={cn("h-2 w-2 rounded-full", t.color)} />
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

        <div className="space-y-3 border-t border-border/60 pt-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Peer connections
          </p>
          <div className="grid grid-cols-3 gap-3">
            <StatMini label="Contacts" value={totalContacts} />
            <StatMini label="Peer links" value={totalPeerEdges} />
            <StatMini label="Avg links" value={avgPeerDegree} />
          </div>
          <div className="space-y-2">
            {DEGREE_BUCKETS.map((b) => {
              const count = degreeBuckets[b.key];
              const width = pct(count, bucketTotal);
              return (
                <div key={b.key} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{b.label}</span>
                    <span className="tabular-nums font-medium">{count}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted/40">
                    <div
                      className={cn("h-full rounded-full", b.color)}
                      style={{ width: `${Math.max(width, count > 0 ? 4 : 0)}%` }}
                    />
                  </div>
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
    <div className="rounded-xl border border-border/60 bg-card/50 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 font-[family-name:var(--font-display)] text-xl text-primary">
        {value}
      </p>
    </div>
  );
}
