import { AdminPanel, EmptyState } from "@/components/admin/primitives";
import type { CrossCheck } from "@/lib/admin-cross-checks";
import { cn } from "@/lib/utils";

/**
 * Where two services should agree and might not. Server-rendered outside the live poll, like
 * "Known bug signatures": these change over hours, not seconds, and each is a database read
 * worth paying once per page load rather than every twenty seconds.
 *
 * Disagreements sort first, so the first row is the one that needs a look; agreeing rows
 * stay listed (greyed) because "checked and fine" is information too.
 */
const ORDER: Record<CrossCheck["tone"], number> = { danger: 0, warn: 1, unknown: 2, ok: 3 };

export function CrossServicePanel({ checks }: { checks: CrossCheck[] | null }) {
  return (
    <AdminPanel title="Cross-service checks">
      {!checks || checks.length === 0 ? (
        <EmptyState>Cross-service checks are unavailable.</EmptyState>
      ) : (
        <ul className="divide-y divide-border/50">
          {[...checks]
            .sort((a, b) => ORDER[a.tone] - ORDER[b.tone])
            .map((c) => (
              <li key={c.id} className="flex items-start gap-3 py-2.5 text-sm">
                <span
                  aria-hidden
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    c.tone === "ok" && "bg-emerald-500",
                    c.tone === "warn" && "bg-amber-500",
                    c.tone === "danger" && "bg-destructive",
                    c.tone === "unknown" && "bg-muted-foreground/40"
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className={cn("font-medium", c.tone === "ok" && "font-normal")}>
                      {c.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {c.between[0]} ↔ {c.between[1]}
                    </span>
                  </div>
                  <p
                    className={cn(
                      "mt-0.5 text-xs",
                      c.tone === "danger"
                        ? "text-destructive"
                        : c.tone === "warn"
                          ? "text-accent-foreground"
                          : "text-muted-foreground"
                    )}
                  >
                    {c.summary}
                  </p>
                </div>
                {c.count ? (
                  <span className="shrink-0 text-sm tabular-nums">{c.count}</span>
                ) : null}
              </li>
            ))}
        </ul>
      )}
    </AdminPanel>
  );
}
