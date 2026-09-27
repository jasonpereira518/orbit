"use client";

/**
 * Upcoming | Past on the events page.
 *
 * Both lists are rendered on the server and arrive together; this only chooses which one
 * shows. Switching is therefore instant and needs no round trip, and the inactive panel keeps
 * its place (and its scroll-restored images) rather than being thrown away.
 *
 * The opening tab is Upcoming when there is anything coming up, and Past otherwise — a user
 * whose calendar is empty for the next month should land on the events they have been to,
 * not on an empty state.
 *
 * The segmented control is the one `people-list-shell.tsx` set: a sliding pill under the
 * selected label. Arrow keys move between the two tabs, as the ARIA tabs pattern expects.
 */
import { useId, useRef, useState } from "react";
import { motion } from "motion/react";
import { SPRING_PILL } from "@/lib/motion";
import { cn } from "@/lib/utils";

type TabKey = "upcoming" | "past";

export function EventsTabs({
  upcomingCount,
  pastCount,
  upcoming,
  past,
}: {
  upcomingCount: number;
  pastCount: number;
  upcoming: React.ReactNode;
  past: React.ReactNode;
}) {
  const [tab, setTab] = useState<TabKey>(upcomingCount > 0 || pastCount === 0 ? "upcoming" : "past");
  const id = useId();
  const refs = useRef<Record<TabKey, HTMLButtonElement | null>>({ upcoming: null, past: null });

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: "upcoming", label: "Upcoming", count: upcomingCount },
    { key: "past", label: "Past", count: pastCount },
  ];

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: TabKey = tab === "upcoming" ? "past" : "upcoming";
    setTab(next);
    refs.current[next]?.focus();
  }

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Events"
        onKeyDown={onKeyDown}
        className="relative flex w-fit rounded-lg border border-border/70 bg-card p-0.5 text-sm"
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
                "relative z-10 flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors duration-fast ease-house focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                selected ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {selected && (
                <motion.span
                  layoutId={`${id}-pill`}
                  className="absolute inset-0 -z-10 rounded-md bg-primary shadow-sm"
                  transition={SPRING_PILL}
                />
              )}
              <span className="relative">{t.label}</span>
              <span
                className={cn(
                  "relative text-xs tabular-nums",
                  selected ? "text-primary-foreground/80" : "text-muted-foreground/80"
                )}
              >
                {t.count}
              </span>
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
          {t.key === "upcoming" ? upcoming : past}
        </div>
      ))}
    </div>
  );
}
