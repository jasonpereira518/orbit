"use client";

import { cn } from "@/lib/utils";
import type { PipelineFilter } from "@/lib/outreach-types";

const FILTERS: Array<{ id: PipelineFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "needs_draft", label: "Needs draft" },
  { id: "ready", label: "Ready" },
  { id: "sent", label: "Sent" },
  { id: "awaiting_reply", label: "Awaiting reply" },
  { id: "follow_up_due", label: "Follow-up due" },
  { id: "replied", label: "Replied" },
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
  return (
    <div className="flex flex-wrap gap-2">
      {FILTERS.map((filter) => {
        const count = counts[filter.id];
        const active = value === filter.id;
        return (
          <button
            key={filter.id}
            type="button"
            onClick={() => onChange(filter.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border/70 bg-card text-muted-foreground hover:text-foreground"
            )}
          >
            {filter.label}
            {typeof count === "number" ? ` (${count})` : ""}
          </button>
        );
      })}
    </div>
  );
}
