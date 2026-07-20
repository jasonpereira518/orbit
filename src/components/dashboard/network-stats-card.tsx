"use client";

import { ChevronDown } from "lucide-react";
import type { NetworkStats } from "@/lib/network-stats";
import { NetworkStatsPanel } from "@/components/dashboard/network-stats-panel";
import { cn } from "@/lib/utils";

export function NetworkStatsCard({ stats }: { stats: NetworkStats }) {
  return (
    <details className="group rounded-2xl border border-border/70 bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-6 [&::-webkit-details-marker]:hidden">
        <div>
          <p className="text-sm font-medium text-primary">Your orbit in numbers</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {stats.headline} — expand for the full breakdown
          </p>
        </div>
        <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className={cn("border-t border-border/60 px-6 pb-6 pt-4")}>
        <NetworkStatsPanel stats={stats} embedded />
      </div>
    </details>
  );
}
