import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
        {/* The only Fraunces on the page. */}
        <h1 className="font-[family-name:var(--font-display)] text-2xl text-primary">
          {title}
        </h1>
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
  value: string | number;
  hint?: string;
  icon?: LucideIcon;
  tone?: "default" | "accent" | "muted";
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
  rows: Array<{ label: string; count: number; href?: string }>;
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
                className="block h-full rounded-full bg-primary/70 transition-[width] duration-slow ease-house"
                style={{ width: `${pct}%` }}
              />
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
 * Gold marks anything Jason did by hand, consistently throughout the console.
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

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>
  );
}

export { RelativeTime };
