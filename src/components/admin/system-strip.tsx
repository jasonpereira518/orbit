import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * A one-line row of system facts under the Ops header.
 *
 * It leads the page because the nightly cron is the only scheduled job in the product, and
 * every "this will self-heal" claim further down is conditional on it having actually
 * fired. Reading the panels without knowing that first is misleading.
 */
export function SystemStrip({
  items,
}: {
  items: Array<{
    label: string;
    value: string;
    tone: "ok" | "warn" | "danger";
    href?: string;
  }>;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-border/70 bg-card px-4 py-2.5">
      {items.map((item) => {
        const body = (
          <>
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              {item.label}
            </span>
            <span
              className={cn(
                "text-sm tabular-nums",
                item.tone === "danger" && "text-destructive",
                item.tone === "warn" && "text-accent-foreground",
                item.tone === "ok" && "text-foreground"
              )}
            >
              {item.value}
            </span>
          </>
        );
        return item.href ? (
          <Link
            key={item.label}
            href={item.href}
            className="flex items-baseline gap-2 hover:text-primary"
          >
            {body}
          </Link>
        ) : (
          <span key={item.label} className="flex items-baseline gap-2">
            {body}
          </span>
        );
      })}
    </div>
  );
}
