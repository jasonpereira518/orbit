import { cn } from "@/lib/utils";

/**
 * One metered allowance on the Plan and usage card: label and what's left on one line, a thin
 * bar, and a footnote with at most one action. The card lays these out side by side. No hooks,
 * so the server card (contacts, voice) and the client credits meter share it.
 */
export function UsageTile({
  label,
  value,
  valueClassName,
  segments,
  foot,
  action,
  children,
}: {
  label: string;
  value: string;
  /** Tints the value: the allowance is used up. */
  valueClassName?: string;
  /** Bar fills, left to right, in percent of the whole. Omit for no bar. */
  segments?: { percent: number; className: string }[];
  foot?: React.ReactNode;
  action?: React.ReactNode;
  /** Notices and folded detail, under the footnote. */
  children?: React.ReactNode;
}) {
  const used = Math.min(100, Math.round((segments ?? []).reduce((sum, s) => sum + s.percent, 0)));
  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-card/60 px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("font-medium tabular-nums", valueClassName)}>{value}</span>
      </div>
      {segments && (
        <div
          className="flex h-1 overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-label={`${label} used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={used}
        >
          {segments.map((s, i) => (
            <div
              key={i}
              className={cn("h-full transition-[width]", s.className)}
              style={{ width: `${Math.min(100, s.percent)}%` }}
            />
          ))}
        </div>
      )}
      {(foot || action) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{foot}</span>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

/** Folded detail inside a tile. Native, so it works in the server card too. */
export function TileDetails({ label = "Details", children }: { label?: string; children: React.ReactNode }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer list-none rounded font-medium text-tier-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/70 [&::-webkit-details-marker]:hidden">
        {label}
      </summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}
