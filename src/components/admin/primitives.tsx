import Link from "next/link";
import { Download } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PLAN_LABELS, type Plan } from "@/lib/plan-limits";
import type { PlanSource } from "@/lib/entitlements";
import { RelativeTime } from "@/components/admin/relative-time";
import { cn } from "@/lib/utils";

/**
 * Admin-local presentational primitives.
 *
 * Kept out of `src/components/ui/` on purpose: that set is a curated, multi-consumer
 * library, and this repo's consistent posture is not to abstract until there are three
 * call sites (`prospect-table.tsx` hand-writes its table; `plan-settings.tsx` hand-rolls
 * its progress bar; `network-depth-chart.tsx` hand-builds bars rather than adding a chart
 * dependency). Admin is one call site.
 */

/* ---------------------------------------------------------------- page header ------- */

export function AdminPageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        {/* No display serif in the console. A big serif number reads as celebratory,
            and every number on this screen is evidence. */}
        <h1 className="text-2xl font-medium tracking-tight text-primary">{title}</h1>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/* ---------------------------------------------------------------- panels ------------ */

export function AdminPanel({
  title,
  action,
  children,
  className,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-border/70 bg-card",
        className
      )}
    >
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {title}
          </h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/* ---------------------------------------------------------------- metrics ----------- */

/**
 * Deliberately not the product's `StatCard`: no Fraunces, no gradient hover, tighter
 * padding, and `tabular-nums` so columns of figures line up.
 */
export function MetricTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  /** A node, not just a scalar, so `LiveValue` can sit in the slot. */
  value: React.ReactNode;
  hint?: string;
  icon?: LucideIcon;
  tone?: "default" | "accent" | "muted" | "danger";
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-3">
      <div className="flex items-center gap-1.5 text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground">
        {Icon && <Icon className="size-3" aria-hidden />}
        {label}
      </div>
      <div
        className={cn(
          "mt-1.5 text-2xl tabular-nums",
          tone === "accent" && "text-accent-foreground",
          tone === "danger" && "text-destructive",
          tone === "muted" && "text-muted-foreground",
          tone === "default" && "text-foreground"
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/**
 * Horizontal bars sized relative to the largest row.
 *
 * Shows drop-off as a shape without ever printing a percentage — at n≈12 a percentage is
 * actively misleading (one new subscriber is +100% growth). Hand-built, following
 * `network-depth-chart.tsx`; no charting library.
 */
export function MiniBars({
  rows,
}: {
  rows: Array<{
    label: string;
    count: number;
    href?: string;
    /** Rendered as a destructive-toned block inside the same track. */
    sub?: { count: number; label?: string };
  }>;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <ol className="space-y-1.5">
      {rows.map((row) => {
        const pct = (row.count / max) * 100;
        const body = (
          <>
            <span className="w-36 shrink-0 truncate text-muted-foreground">
              {row.label}
            </span>
            <span className="w-10 shrink-0 text-right tabular-nums">
              {row.count}
            </span>
            <span
              aria-hidden
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
            >
              <span
                className="flex h-full rounded-full bg-primary/70 transition-[width] duration-slow ease-house"
                style={{ width: `${pct}%` }}
              >
                {row.sub && row.sub.count > 0 && (
                  <span
                    className="h-full rounded-full bg-destructive/80"
                    style={{
                      width: `${Math.min(100, (row.sub.count / Math.max(1, row.count)) * 100)}%`,
                    }}
                  />
                )}
              </span>
            </span>
          </>
        );
        return (
          <li key={row.label} className="flex items-center gap-3 text-sm">
            {row.href ? (
              <Link
                href={row.href}
                className="flex flex-1 items-center gap-3 hover:text-primary"
              >
                {body}
              </Link>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A trend, as one labelled bar per bucket.
 *
 * Deliberately not a sparkline. The overview's rule against them was written against
 * smoothed shapes with no labels, and it is right: 0,1,0,0,2,1,0 drawn as a squiggle is
 * noise rendered as a shape. The same seven numbers printed next to seven bars is a
 * countable column — the reader gets the integers, and the bars only rank them.
 *
 * `secondary` overlays a second series inside the same bar (failures within calls), which
 * only reads honestly when it is a strict subset of `count`.
 */
export function TrendBars({
  rows,
  emptyLabel = "Nothing in this window yet.",
}: {
  rows: Array<{
    label: string;
    count: number;
    secondary?: number;
    secondaryLabel?: string;
    href?: string;
  }>;
  emptyLabel?: string;
}) {
  if (rows.length === 0) return <EmptyState>{emptyLabel}</EmptyState>;

  // Against the max rather than the sum: the question is "which period was busiest",
  // and a zero-height bar for an empty period is the honest answer for that period.
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <ol className="space-y-1">
      {rows.map((row) => {
        const pct = (row.count / max) * 100;
        const secondaryPct = row.secondary ? (row.secondary / max) * 100 : 0;
        return (
          <li key={row.label} className="flex items-center gap-3 text-sm">
            <span className="w-24 shrink-0 truncate text-xs text-muted-foreground tabular-nums">
              {row.label}
            </span>
            <span className="w-10 shrink-0 text-right tabular-nums">{row.count}</span>
            {row.secondary != null && (
              <span
                className={cn(
                  "w-10 shrink-0 text-right text-xs tabular-nums",
                  row.secondary > 0 ? "text-destructive" : "text-muted-foreground/50"
                )}
                title={row.secondaryLabel}
              >
                {row.secondary > 0 ? row.secondary : "—"}
              </span>
            )}
            <span
              aria-hidden
              className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
            >
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-primary/70 transition-[width] duration-slow ease-house"
                style={{ width: `${pct}%` }}
              />
              {secondaryPct > 0 && (
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-destructive/80"
                  style={{ width: `${secondaryPct}%` }}
                />
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------------------------------------------------------------- plan badge -------- */

const SOURCE_LABEL: Record<PlanSource, string> = {
  comp: "comped",
  lifetime: "purchased",
  subscription: "subscribed",
  free: "free",
};

/**
 * Plan and its source together — the source is what makes the number honest, since comps
 * are currently the only thing writing a paid plan.
 *
 * THE ACCENT MARKS WHAT THE OPERATOR DID BY HAND, and on a monochrome console it is one of
 * only two colours in use (the other is `destructive`, for things that are broken). Older
 * comments here called it gold; it has always rendered teal, because they pointed at
 * `--landing-accent`, which the console does not use.
 */
export function PlanBadge({
  plan,
  source,
  title,
}: {
  plan: Plan;
  source: PlanSource;
  title?: string;
}) {
  const comped = source === "comp";
  return (
    <Badge
      variant={plan === "free" ? "secondary" : "outline"}
      title={title}
      className={cn(
        "gap-1 font-normal tabular-nums",
        comped && "border-accent/50 bg-accent/10 text-accent-foreground",
        !comped && plan !== "free" && "border-primary/40 text-primary"
      )}
    >
      {PLAN_LABELS[plan]}
      {plan !== "free" && (
        <span className="opacity-60">· {SOURCE_LABEL[source]}</span>
      )}
    </Badge>
  );
}

/* ---------------------------------------------------------------- values ------------ */

/**
 * Renders the *presence* of a sensitive value, never the value.
 *
 * Centralized so every place a credential is referenced is greppable — which is what
 * makes the redaction claim auditable rather than aspirational.
 */
export function SecretState({
  present,
  absentLabel = "not set",
}: {
  present: boolean;
  absentLabel?: string;
}) {
  return present ? (
    <span className="text-foreground">set ✓</span>
  ) : (
    <span className="text-muted-foreground">{absentLabel}</span>
  );
}

export function DefinitionRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/40 py-1.5 last:border-b-0">
      <dt className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 text-right text-sm">{children}</dd>
    </div>
  );
}

/* ---------------------------------------------------------------- table ------------- */

export function AdminTable({
  head,
  children,
}: {
  head: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // Wide tables scroll inside their own container so the page body never does.
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wider text-muted-foreground">
            {head}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
  numeric,
}: {
  children?: React.ReactNode;
  className?: string;
  numeric?: boolean;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "px-3 py-2 font-medium",
        numeric && "text-right",
        className
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  numeric,
}: {
  children?: React.ReactNode;
  className?: string;
  numeric?: boolean;
}) {
  return (
    <td
      className={cn(
        "px-3 py-2 align-middle",
        numeric && "text-right tabular-nums",
        className
      )}
    >
      {children}
    </td>
  );
}

/**
 * The placeholder a panel shows while its own query is still in flight.
 *
 * Sized in the same `rounded-xl` box as `AdminPanel` so the page does not reflow when the
 * real panel arrives — the whole point of streaming a panel is defeated if everything
 * below it jumps once it lands.
 */
export function AdminPanelSkeleton({
  title,
  className = "h-40",
}: {
  title?: string;
  className?: string;
}) {
  return (
    <AdminPanel title={title}>
      <Skeleton className={cn("w-full", className)} />
    </AdminPanel>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>
  );
}

export { RelativeTime };

/**
 * A verbatim system error string.
 *
 * Load-bearing distinction: this renders SYSTEM output — import failures, sync errors,
 * provider messages — which is shown in full precisely because it is not user prose. It
 * must never be used for notes, chat content, or anything a person wrote.
 */
export function CodeDetail({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-xs text-muted-foreground">
      {children}
    </pre>
  );
}

/**
 * The console's one export affordance.
 *
 * Extracted because the same 130-character class string was hand-written verbatim on
 * Users, Health and Audit — three copies that had already started to drift from the
 * near-identical button class in `account-actions.tsx`.
 */
export function ExportCsvLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground"
    >
      <Download className="size-3" aria-hidden />
      Export CSV
    </a>
  );
}

/**
 * A panel that is itself the warning.
 *
 * `AdminPanel` was doing double duty for these — the Money screen's two reconciliation
 * warnings and the Overview's decision list rendered in an ordinary panel whose only
 * signal was red body copy, which reads as "a panel that happens to contain bad news"
 * rather than as an alert.
 *
 * On a monochrome console the accent bar carries this, not a fill: a tinted panel
 * background would be the loudest thing on a white screen, and these are worth noticing
 * rather than worth shouting.
 */
export function AdminAlert({
  title,
  tone = "danger",
  action,
  children,
}: {
  title: string;
  tone?: "danger" | "notice";
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-l-2 border-border/70 bg-card",
        tone === "danger" ? "border-l-destructive" : "border-l-accent-foreground"
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
        <h2
          className={cn(
            "text-xs font-medium uppercase tracking-wider",
            tone === "danger" ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {title}
        </h2>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * A table row. The class was hand-written roughly thirty times across eight page files,
 * and `hover:bg-muted/40` was applied on only two of them — so most of the console's
 * tables had no row hover at all, inconsistently.
 */
export function Tr({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <tr
      className={cn(
        "border-b border-border/40 transition-colors duration-fast last:border-b-0 hover:bg-muted/40",
        className
      )}
    >
      {children}
    </tr>
  );
}
