"use client";

import { SegmentedControl } from "@/components/ui/segmented-control";
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
    <SegmentedControl
      ariaLabel="Pipeline stage"
      size="sm"
      className="flex-wrap"
      value={value}
      onChange={(key) => onChange(key)}
      items={FILTERS.map((filter) => ({
        key: filter.id,
        label: filter.label,
        count: counts[filter.id],
      }))}
    />
  );
}
