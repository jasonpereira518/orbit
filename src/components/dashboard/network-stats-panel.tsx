import type { NetworkStats } from "@/lib/network-stats";
import { cn } from "@/lib/utils";

export function NetworkStatsPanel({
  stats,
  embedded = false,
}: {
  stats: NetworkStats;
  embedded?: boolean;
}) {
  return (
    <div className={cn(!embedded && "space-y-6 rounded-2xl border border-border/70 bg-card p-6")}>
      <div>
        <h2
          className={cn(
            "text-primary",
            embedded
              ? "font-[family-name:var(--font-display)] text-xl"
              : "font-[family-name:var(--font-display)] text-2xl"
          )}
        >
          {stats.headline}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{stats.subheadline}</p>
      </div>

      <div className="space-y-8">
        {stats.sections.map((section) => (
          <div key={section.title}>
            <div className="mb-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-primary">
                {section.title}
              </h3>
              {section.subtitle && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {section.subtitle}
                </p>
              )}
            </div>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {section.items.map((item) => (
                <div
                  key={`${section.title}-${item.label}`}
                  className={cn(
                    "rounded-xl border border-border/60 bg-background/60 px-3 py-3",
                    item.fun &&
                      "border-primary/20 bg-primary/[0.04] dark:bg-primary/[0.06]"
                  )}
                >
                  <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {item.label}
                  </dt>
                  <dd className="mt-1 font-[family-name:var(--font-display)] text-2xl leading-none text-primary">
                    {item.value}
                  </dd>
                  {item.detail && (
                    <dd className="mt-1.5 text-xs text-muted-foreground">
                      {item.detail}
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}
