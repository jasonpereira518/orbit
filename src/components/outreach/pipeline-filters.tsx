"use client";

import { cn } from "@/lib/utils";
import type { PipelineFilter } from "@/lib/outreach-types";
import { ChevronRight, Clock, MessageSquare, Send, Sparkles, Users } from "lucide-react";

type StepperStage = {
  id: PipelineFilter;
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ className?: string }>;
};

const MAIN_PIPELINE: StepperStage[] = [
  { id: "all", label: "1. Discovered", shortLabel: "Found", icon: Users },
  { id: "ready", label: "2. Ready", shortLabel: "Drafted", icon: Sparkles },
  { id: "sent", label: "3. Sent", shortLabel: "Outreach", icon: Send },
  { id: "follow_up_due", label: "4. Follow-up Due", shortLabel: "Follow-up", icon: Clock },
  { id: "replied", label: "5. Replied", shortLabel: "Converted", icon: MessageSquare },
];

const SECONDARY_FILTERS: Array<{ id: PipelineFilter; label: string }> = [
  { id: "needs_draft", label: "Needs draft" },
  { id: "awaiting_reply", label: "Awaiting reply" },
  { id: "closed", label: "Closed" },
];

export function PipelineFilters({
  value,
  counts,
  onChange,
}: {
  value: PipelineFilter;
  counts: Partial<Record<PipelineFilter, number>>;
  onChange: (value: PipelineFilter) => void;
}) {
  const sentCount = counts.sent || 0;
  const repliedCount = counts.replied || 0;
  const responseRate = sentCount > 0 ? Math.round((repliedCount / sentCount) * 100) : null;

  return (
    <div className="w-full space-y-2.5">
      {/* Visual Pipeline Stepper */}
      <div className="flex flex-col gap-1 rounded-2xl border border-border/80 bg-card/80 p-1.5 shadow-xs sm:flex-row sm:items-stretch sm:justify-between">
        {MAIN_PIPELINE.map((stage, idx) => {
          const count = counts[stage.id] ?? 0;
          const active = value === stage.id;
          const Icon = stage.icon;

          return (
            <div key={stage.id} className="flex flex-1 items-center">
              <button
                type="button"
                onClick={() => onChange(stage.id)}
                className={cn(
                  "group relative flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left transition-all",
                  active
                    ? "bg-primary text-primary-foreground shadow-xs ring-1 ring-primary/20"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Icon
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      active ? "text-primary-foreground" : "text-muted-foreground group-hover:text-foreground"
                    )}
                  />
                  <div className="min-w-0 leading-tight">
                    <span className="block truncate text-xs font-medium">
                      {stage.label}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-2xs font-semibold tabular-nums",
                      active
                        ? "bg-primary-foreground/20 text-primary-foreground"
                        : "bg-muted text-muted-foreground group-hover:bg-muted/80"
                    )}
                  >
                    {count}
                  </span>
                </div>
              </button>

              {idx < MAIN_PIPELINE.length - 1 && (
                <div className="hidden px-0.5 text-border sm:block">
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Secondary Quick Filters & Conversion Badge */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-2xs font-medium mr-1">Other views:</span>
          {SECONDARY_FILTERS.map((filter) => {
            const count = counts[filter.id];
            const active = value === filter.id;
            return (
              <button
                key={filter.id}
                type="button"
                onClick={() => onChange(filter.id)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-2xs font-medium transition-colors",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/60 bg-card text-muted-foreground hover:text-foreground hover:border-border"
                )}
              >
                {filter.label}
                {typeof count === "number" && count > 0 ? ` (${count})` : ""}
              </button>
            );
          })}
        </div>

        {responseRate !== null && (
          <div className="flex items-center gap-1 text-2xs text-muted-foreground">
            <span className="font-medium text-ink">Pipeline Conversion:</span>
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">
              {responseRate}% reply rate
            </span>
            <span>({repliedCount}/{sentCount})</span>
          </div>
        )}
      </div>
    </div>
  );
}
