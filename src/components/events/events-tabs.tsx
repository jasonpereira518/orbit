"use client";

/**
 * Upcoming | Past | Recommended on the events page.
 *
 * All lists are rendered on the server and arrive together; this only chooses which one
 * shows. Switching is therefore instant and needs no round trip, and the inactive panel keeps
 * its place rather than being thrown away.
 */
import { useId, useRef, useState } from "react";
import { motion } from "motion/react";
import { Sparkles } from "lucide-react";
import { SPRING_PILL } from "@/lib/motion";
import { cn } from "@/lib/utils";

type TabKey = "upcoming" | "past" | "recommended";

export function EventsTabs({
  upcomingCount,
  pastCount,
  recommendedCount = 0,
  upcoming,
  past,
  recommended,
}: {
  upcomingCount: number;
  pastCount: number;
  recommendedCount?: number;
  upcoming: React.ReactNode;
  past: React.ReactNode;
  recommended?: React.ReactNode;
}) {
  const [tab, setTab] = useState<TabKey>(
    upcomingCount > 0 || pastCount === 0 ? "upcoming" : "past"
  );
  const id = useId();
  const refs = useRef<Record<TabKey, HTMLButtonElement | null>>({
    upcoming: null,
    past: null,
    recommended: null,
  });

  const tabs: { key: TabKey; label: string; count?: number; icon?: boolean }[] = [
    { key: "upcoming", label: "Upcoming", count: upcomingCount },
    { key: "past", label: "Past Events", count: pastCount },
    ...(recommended
      ? [{ key: "recommended" as const, label: "Recommended For You", count: recommendedCount, icon: true }]
      : []),
  ];

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const curIdx = tabs.findIndex((t) => t.key === tab);
    const nextIdx =
      event.key === "ArrowRight"
        ? (curIdx + 1) % tabs.length
        : (curIdx - 1 + tabs.length) % tabs.length;
    const next = tabs[nextIdx].key;
    setTab(next);
    refs.current[next]?.focus();
  }

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Events"
        onKeyDown={onKeyDown}
        className="relative flex flex-wrap w-fit rounded-xl border border-border/70 bg-card p-1 text-sm shadow-sm"
      >
        {tabs.map((t) => {
          const selected = tab === t.key;
          return (
            <button
              key={t.key}
              ref={(node) => {
                refs.current[t.key] = node;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${t.key}`}
              aria-selected={selected}
              aria-controls={`${id}-panel-${t.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(t.key)}
              className={cn(
                "relative z-10 flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 font-medium transition-colors duration-fast ease-house focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                selected ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {selected && (
                <motion.span
                  layoutId={`${id}-pill`}
                  className="absolute inset-0 -z-10 rounded-lg bg-primary shadow-sm"
                  transition={SPRING_PILL}
                />
              )}
              {t.icon && <Sparkles className="size-3.5 text-amber-300" aria-hidden />}
              <span className="relative">{t.label}</span>
              {t.count !== undefined && (
                <span
                  className={cn(
                    "relative text-xs tabular-nums",
                    selected ? "text-primary-foreground/80" : "text-muted-foreground"
                  )}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tabs.map((t) => (
        <div
          key={t.key}
          role="tabpanel"
          id={`${id}-panel-${t.key}`}
          aria-labelledby={`${id}-tab-${t.key}`}
          hidden={tab !== t.key}
        >
          {t.key === "upcoming" ? upcoming : t.key === "past" ? past : recommended}
        </div>
      ))}
    </div>
  );
}
