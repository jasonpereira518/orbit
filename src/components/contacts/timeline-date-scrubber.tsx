"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { CalendarRange } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type TimelineScrubPoint = {
  id: string;
  /** yyyy-MM */
  monthKey: string;
  label: string;
  /** Short label for dense scrubber, e.g. "Mar" or "3" */
  shortLabel: string;
};

/**
 * Past this many months the rail stops trying to draw one dot per month and buckets by year.
 * The rail is 448px at most and a dot plus its label needs roughly 30px, so a five-year history
 * would otherwise overlap itself into an unreadable smear.
 */
const YEAR_BUCKET_THRESHOLD = 14;

function bucket(points: TimelineScrubPoint[]): {
  items: TimelineScrubPoint[];
  byYear: boolean;
} {
  const months = new Map<string, TimelineScrubPoint>();
  for (const p of points) if (!months.has(p.monthKey)) months.set(p.monthKey, p);
  const unique = [...months.values()];
  if (unique.length <= YEAR_BUCKET_THRESHOLD) {
    return { items: unique, byYear: false };
  }

  // One entry per year, pointing at that year's first month in list order (the newest, since
  // the timeline runs newest-first) so selecting it lands at the top of the year.
  const years = new Map<string, TimelineScrubPoint>();
  for (const p of unique) {
    const year = p.monthKey.slice(0, 4);
    if (!years.has(year)) {
      years.set(year, { ...p, label: year, shortLabel: year });
    }
  }
  return { items: [...years.values()], byYear: true };
}

function useScrubItems(points: TimelineScrubPoint[]) {
  return useMemo(() => bucket(points), [points]);
}

/**
 * Vertical month scrubber — one clickable node per month (or per year on a long history) to jump
 * the timeline.
 */
export function TimelineDateScrubber({
  points,
  activeMonthKey,
  onSelectMonth,
  className,
}: {
  points: TimelineScrubPoint[];
  activeMonthKey: string | null;
  /** `instant` is set while scrubbing, where an animated scroll per pointer move arrives nowhere. */
  onSelectMonth: (monthKey: string, opts?: { instant?: boolean }) => void;
  className?: string;
}) {
  const { items, byYear } = useScrubItems(points);
  const navRef = useRef<HTMLElement>(null);
  // Two representations on purpose: the ref is the gesture's source of truth, because a
  // `pointermove` can arrive in the same tick as the `pointerdown` that started it and would
  // read stale state; the state exists only to restyle the active node while dragging.
  const scrubbingRef = useRef(false);
  const [scrubbing, setScrubbing] = useState(false);

  /**
   * The index of the node nearest a given Y.
   *
   * Measured from the DOM rather than mapped proportionally: the nodes are laid out
   * `justify-between`, so their spacing is a fact of the layout, and reading it back is what
   * keeps the active month under the reader's finger rather than near it.
   */
  const nodeIndexAtY = useCallback((clientY: number) => {
    const buttons = [
      ...(navRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ];
    let best = -1;
    let bestDistance = Infinity;
    buttons.forEach((b, i) => {
      const r = b.getBoundingClientRect();
      const distance = Math.abs(r.top + r.height / 2 - clientY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    return best;
  }, []);

  if (items.length === 0) return null;

  // Deliberately not clamped to 0 on a miss: `activeMonthKey` can point at a month the current
  // filter has emptied out, and falling back to the first entry made the footer confidently
  // name the newest month while the list was scrolled somewhere else entirely.
  const activeIdx = byYear
    ? items.findIndex((p) => p.monthKey.slice(0, 4) === activeMonthKey?.slice(0, 4))
    : items.findIndex((p) => p.monthKey === activeMonthKey);
  const footer = activeIdx >= 0 ? items[activeIdx].label : null;

  function moveFocus(nextIdx: number) {
    const buttons = navRef.current?.querySelectorAll<HTMLButtonElement>("button");
    buttons?.[Math.max(0, Math.min(buttons.length - 1, nextIdx))]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    const keys = ["ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const buttons = [
      ...(navRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    if (event.key === "ArrowDown") moveFocus(current + 1);
    else if (event.key === "ArrowUp") moveFocus(current - 1);
    else if (event.key === "Home") moveFocus(0);
    else moveFocus(buttons.length - 1);
  }

  return (
    <div
      className={cn(
        "flex h-full min-h-[12rem] w-14 shrink-0 flex-col items-center select-none",
        className
      )}
    >
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Jump
      </p>
      <nav
        ref={navRef}
        onKeyDown={onKeyDown}
        // Drag anywhere on the rail to run through the months. `setPointerCapture` keeps the
        // gesture alive once the pointer leaves the 56px-wide rail, which it does almost at
        // once — without it a scrub dies the moment the hand drifts sideways.
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          // Throws on a pointer the browser no longer considers active; the scrub still works
          // without capture, it just ends early if the hand leaves the rail.
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {}
          scrubbingRef.current = true;
          setScrubbing(true);
          const index = nodeIndexAtY(event.clientY);
          if (index >= 0) onSelectMonth(items[index].monthKey, { instant: true });
        }}
        onPointerMove={(event) => {
          if (!scrubbingRef.current) return;
          const index = nodeIndexAtY(event.clientY);
          if (index >= 0 && items[index].monthKey !== activeMonthKey) {
            onSelectMonth(items[index].monthKey, { instant: true });
          }
        }}
        onPointerUp={(event) => {
          scrubbingRef.current = false;
          setScrubbing(false);
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch {}
        }}
        onPointerCancel={() => {
          scrubbingRef.current = false;
          setScrubbing(false);
        }}
        // Without this a touch drag scrolls the page instead of scrubbing it.
        style={{ touchAction: "none" }}
        className={cn(
          "relative flex h-full min-h-0 w-full flex-1 cursor-ns-resize flex-col justify-between py-1",
          scrubbing && "select-none"
        )}
        aria-label={byYear ? "Timeline years" : "Timeline months"}
      >
        <div
          className="pointer-events-none absolute inset-y-3 left-1/2 w-px -translate-x-1/2 bg-border"
          aria-hidden
        />
        {items.map((p) => {
          const isActive = byYear
            ? p.monthKey.slice(0, 4) === activeMonthKey?.slice(0, 4)
            : p.monthKey === activeMonthKey;
          return (
            <button
              key={p.monthKey}
              type="button"
              title={p.label}
              aria-label={`Jump to ${p.label}`}
              aria-current={isActive ? "true" : undefined}
              onClick={() => onSelectMonth(p.monthKey)}
              // The rail owns the pointer; a button starting its own drag fights the capture.
              onPointerDown={(event) => event.preventDefault()}
              className={cn(
                "group relative z-[1] flex w-full flex-col items-center gap-1 rounded-md py-0.5",
                // The house ring, not this file's old ring-offset variant: an offset ring is
                // clipped by the timeline's own scroll container at the top and bottom edges.
                "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              )}
            >
              <span
                className={cn(
                  "size-2.5 rounded-full border-2 transition-[background-color,border-color,scale]",
                  isActive
                    ? cn(
                        "border-primary bg-primary shadow-sm",
                        // Swells under the finger so the thing you are dragging is the thing
                        // you can see.
                        scrubbing ? "scale-150" : "scale-125"
                      )
                    : "border-muted-foreground/50 bg-card group-hover:border-primary group-hover:bg-primary/20"
                )}
              />
              <span
                className={cn(
                  "text-[10px] leading-none transition-colors",
                  isActive
                    ? "font-semibold text-primary"
                    : "text-muted-foreground group-hover:text-foreground"
                )}
              >
                {p.shortLabel}
              </span>
            </button>
          );
        })}
      </nav>
      <p className="mt-2 max-w-full truncate text-center text-[10px] text-muted-foreground">
        {footer ?? "—"}
      </p>
    </div>
  );
}

/**
 * The same month list as a popover, for viewports too narrow to carry the rail.
 *
 * Below `sm` the rail was simply hidden, which left the sticky month headings as the only way
 * to know where you were and no way at all to travel — the case that needs jumping most, since
 * a phone shows fewer rows per screen.
 */
export function TimelineJumpMenu({
  points,
  activeMonthKey,
  onSelectMonth,
  className,
}: {
  points: TimelineScrubPoint[];
  activeMonthKey: string | null;
  onSelectMonth: (monthKey: string) => void;
  className?: string;
}) {
  const { items, byYear } = useScrubItems(points);

  if (items.length < 2) return null;

  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label="Jump to a month"
        className={cn(
          "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors",
          "hover:bg-muted hover:text-ink",
          "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
          className
        )}
      >
        <CalendarRange className="size-3.5" />
        Jump
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-72 w-44 overflow-y-auto p-1">
        <ul aria-label={byYear ? "Timeline years" : "Timeline months"}>
          {items.map((p) => {
            const isActive = byYear
              ? p.monthKey.slice(0, 4) === activeMonthKey?.slice(0, 4)
              : p.monthKey === activeMonthKey;
            return (
              <li key={p.monthKey}>
                <button
                  type="button"
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => onSelectMonth(p.monthKey)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                    isActive
                      ? "bg-muted font-medium text-ink"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-ink"
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      isActive ? "bg-primary" : "bg-muted-foreground/40"
                    )}
                  />
                  {p.label}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function monthKeyFromDate(d: Date | string) {
  return format(new Date(d), "yyyy-MM");
}

export function monthLabel(d: Date | string) {
  return format(new Date(d), "MMM yyyy");
}

export function monthShort(d: Date | string) {
  return format(new Date(d), "MMM");
}
