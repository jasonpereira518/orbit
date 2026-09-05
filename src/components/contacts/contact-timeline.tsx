"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { CircleDashed, FileText, Plus } from "lucide-react";
import { toast } from "@/lib/toast";
import { reorderSameDayInteractions } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  TimelineDateScrubber,
  TimelineJumpMenu,
  monthKeyFromDate,
  monthLabel,
  monthShort,
} from "@/components/contacts/timeline-date-scrubber";
import { InteractionDetailSheet } from "@/components/contacts/interaction-detail-sheet";
import { LogInteractionSheet } from "@/components/contacts/log-interaction-sheet";
import {
  INTERACTION_FLIGHT_EVENT,
  type InteractionFlightDetail,
} from "@/components/contacts/interaction-flight";
import {
  REVEAL_INTERACTION_EVENT,
  type RevealInteractionDetail,
} from "@/components/contacts/reveal-interaction";
import { flashSection } from "@/components/layout/section-flash";
import {
  INTERACTION_FAMILIES,
  interactionFamilySpec,
  interactionTypeFamily,
  interactionTypeIcon,
  interactionTypeLabel,
  type InteractionFamilyValue,
} from "@/lib/interaction-types";
import { EASE_HOUSE } from "@/lib/motion";
import { timelineDayLabel, timelineGapLabel } from "@/lib/timeline-date";
import { useRefreshOnVisible } from "@/lib/use-refresh-on-visible";
import { cn } from "@/lib/utils";

export type TimelineInteraction = {
  id: string;
  interactionType: string;
  interactionDate: Date | string;
  sameDayOrder?: number | null;
  /** `raw_notes` truncated in SQL — enough for the clamped preview and for "has notes". */
  notesPreview: string | null;
  aiSummary: string | null;
};

/** How many rows get a staggered entrance before the cascade is capped. */
const STAGGER_LIMIT = 8;
const STAGGER_STEP_MS = 30;

/**
 * Rows rendered before "show older" appears.
 *
 * This bounds the RENDER, not the query. Every interaction is already on the client, so
 * expanding is instant and — more importantly — a deep link can always reach its target.
 * Windowing the query instead would have quietly broken `formatInteractionFrequency`, which
 * counts rows in a 90-day window from the same array.
 */
const WINDOW_SIZE = 40;

type FilterValue = InteractionFamilyValue | "all";

function dayKey(d: Date | string) {
  return format(new Date(d), "yyyy-MM-dd");
}

/**
 * The line shown on the row. Two rendered lines' worth is the budget — the row clamps it —
 * so this only guards against handing the browser a whole pasted note to lay out.
 */
function preview(i: TimelineInteraction) {
  const text = (i.aiSummary || i.notesPreview || "").replace(/\s+/g, " ").trim();
  if (!text) return "Interaction logged";
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

export function ContactTimeline({
  contactId,
  contactName,
  interactions,
  openActionItems,
  hasApiKey,
}: {
  contactId: string;
  contactName: string;
  interactions: TimelineInteraction[];
  /** Open items for this contact, from the same query the brief card's next steps use. */
  openActionItems: { id: string; interactionId: string }[];
  hasApiKey: boolean;
}) {
  const router = useRouter();
  useRefreshOnVisible();
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const [, start] = useTransition();
  const [activeMonth, setActiveMonth] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [filter, setFilter] = useState<FilterValue>("all");
  const [expanded, setExpanded] = useState(false);
  /** Roving-tabindex position, held by id: `useRefreshOnVisible` replaces the rows on every
      tab focus, and a numeric index would silently drift onto a different interaction. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  const [flight, setFlight] = useState<
    (InteractionFlightDetail & { to: { top: number; left: number } }) | null
  >(null);
  const reducedMotion = useReducedMotion();

  const sorted = useMemo(() => {
    return [...interactions].sort((a, b) => {
      const da = new Date(a.interactionDate).getTime();
      const db = new Date(b.interactionDate).getTime();
      if (db !== da) return db - da;
      return (a.sameDayOrder ?? 0) - (b.sameDayOrder ?? 0);
    });
  }, [interactions]);

  /** interactionId → count of still-open action items, grouped from data the page already has. */
  const openByInteraction = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of openActionItems) {
      map.set(item.interactionId, (map.get(item.interactionId) ?? 0) + 1);
    }
    return map;
  }, [openActionItems]);

  /** Counts come from the whole history, so the chips never offer an empty filter. */
  const familyCounts = useMemo(() => {
    const map = new Map<InteractionFamilyValue, number>();
    for (const i of sorted) {
      const f = interactionTypeFamily(i.interactionType);
      map.set(f, (map.get(f) ?? 0) + 1);
    }
    return map;
  }, [sorted]);

  const filtered = useMemo(
    () =>
      filter === "all"
        ? sorted
        : sorted.filter((i) => interactionTypeFamily(i.interactionType) === filter),
    [sorted, filter]
  );

  const visible = useMemo(
    () => (expanded ? filtered : filtered.slice(0, WINDOW_SIZE)),
    [filtered, expanded]
  );
  const hiddenCount = filtered.length - visible.length;

  const monthGroups = useMemo(() => {
    const groups: Array<{
      monthKey: string;
      label: string;
      shortLabel: string;
      items: TimelineInteraction[];
      /** "11 months quiet" — the silence between this month and the newer one above it. */
      gapLabel: string | null;
    }> = [];
    const map = new Map<string, TimelineInteraction[]>();
    for (const i of visible) {
      const key = monthKeyFromDate(i.interactionDate);
      const list = map.get(key) || [];
      list.push(i);
      map.set(key, list);
    }
    for (const [monthKey, items] of map) {
      const previous = groups[groups.length - 1];
      groups.push({
        monthKey,
        label: monthLabel(items[0].interactionDate),
        shortLabel: monthShort(items[0].interactionDate),
        items,
        // The list runs newest-first, so the newer side of the gap is the previous group's
        // OLDEST row and the older side is this group's newest.
        gapLabel: previous
          ? timelineGapLabel(
              items[0].interactionDate,
              previous.items[previous.items.length - 1].interactionDate
            )
          : null,
      });
    }
    return groups;
  }, [visible]);

  const scrubPoints = useMemo(
    () =>
      monthGroups.map((g) => ({
        id: g.monthKey,
        monthKey: g.monthKey,
        label: g.label,
        shortLabel: g.shortLabel,
      })),
    [monthGroups]
  );

  useEffect(() => {
    if (!activeMonth && monthGroups[0]) {
      setActiveMonth(monthGroups[0].monthKey);
    }
  }, [activeMonth, monthGroups]);

  useEffect(() => {
    const root = listRef.current;
    if (!root) return;

    const sections = root.querySelectorAll<HTMLElement>("[data-month-key]");
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleSections = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visibleSections[0]?.target.getAttribute("data-month-key");
        if (first) setActiveMonth(first);
      },
      { root, rootMargin: "-10% 0px -70% 0px", threshold: 0 }
    );

    sections.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [monthGroups]);

  /** "Recent discussions" can name a row the filter or the window is currently hiding. */
  useEffect(() => {
    function onReveal(event: Event) {
      const id = (event as CustomEvent<RevealInteractionDetail>).detail?.interactionId;
      if (!id || !sorted.some((i) => i.id === id)) return;
      // Already rendered: the caller's own smooth scroll has it, and starting a second one
      // here only makes the two fight. This path exists for the rows it CANNOT reach.
      if (document.getElementById(`interaction-${id}`)) return;
      setFilter("all");
      setExpanded(true);
      setPendingReveal(id);
    }
    window.addEventListener(REVEAL_INTERACTION_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_INTERACTION_EVENT, onReveal);
  }, [sorted]);

  /**
   * A just-logged interaction flies from the button that saved it onto its node on the spine.
   *
   * The row is not on screen yet when the event fires — `router.refresh()` is still in flight —
   * so this waits a few frames for it, and falls back to the head of the spine if it never
   * arrives (a backdated entry outside the window, or a refresh that failed). Better a flight
   * that lands somewhere honest than none at all.
   */
  useEffect(() => {
    function onFlight(event: Event) {
      const detail = (event as CustomEvent<InteractionFlightDetail>).detail;
      if (!detail) return;

      // Clear anything that could be hiding the new row before we go looking for it.
      setFilter("all");
      setExpanded(true);

      let tries = 0;
      const settle = () => {
        tries += 1;
        const row = detail.interactionId
          ? rowRefs.current.get(detail.interactionId)
          : undefined;
        const node =
          row?.querySelector<HTMLElement>("span") ??
          listRef.current?.querySelector<HTMLElement>("[data-interaction-id] span");

        if (!node && tries < 24) {
          window.setTimeout(settle, 40);
          return;
        }
        if (!node) return;

        const r = node.getBoundingClientRect();
        if (reducedMotion) {
          // Keep the signal, drop the motion — the same trade the rest of the app makes.
          if (detail.interactionId) flashSection(`interaction-${detail.interactionId}`);
          return;
        }
        setFlight({ ...detail, to: { top: r.top, left: r.left } });
      };
      window.setTimeout(settle, 40);
    }

    window.addEventListener(INTERACTION_FLIGHT_EVENT, onFlight);
    return () => window.removeEventListener(INTERACTION_FLIGHT_EVENT, onFlight);
  }, [reducedMotion]);

  /**
   * The flight always ends, whether or not its animation does.
   *
   * `onAnimationComplete` never fires if the document stops painting mid-flight — switch tabs
   * during the 660ms and rAF stops — and the disc would then hang over the page until the next
   * navigation. This is the floor: land it, flash the row, and clear.
   */
  useEffect(() => {
    if (!flight) return;
    const timer = window.setTimeout(() => {
      if (flight.interactionId) flashSection(`interaction-${flight.interactionId}`);
      setFlight(null);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [flight]);

  useEffect(() => {
    if (!pendingReveal) return;
    const el = rowRefs.current.get(pendingReveal);
    if (!el) return;
    // Instant, not smooth. This runs in the same commit that cleared the filter and expanded
    // the window, so the list is re-flowing underneath a smooth scroll — which loses the race
    // and leaves the row off screen. The row was hidden a moment ago, so there is no continuity
    // to preserve here anyway; the flash glow is what says "this one".
    el.scrollIntoView({ block: "center" });
    setFocusId(pendingReveal);
    setPendingReveal(null);
  }, [pendingReveal, visible]);

  /**
   * Scrolls the spine, and nothing else.
   *
   * `scrollIntoView` walks every scrollable ancestor, so jumping to a month also dragged the
   * whole page under the reader — the one thing a jump-to control must not do. Setting the
   * list's own `scrollTop` moves the only container that should move.
   */
  function scrollToMonth(monthKey: string, opts?: { instant?: boolean }) {
    setActiveMonth(monthKey);
    const root = listRef.current;
    const el = root?.querySelector<HTMLElement>(`[data-month-key="${monthKey}"]`);
    if (!root || !el) return;
    const top =
      root.scrollTop + (el.getBoundingClientRect().top - root.getBoundingClientRect().top);
    // A scrub fires this on every pointer move; animating each one would queue dozens of
    // competing smooth scrolls and arrive nowhere.
    root.scrollTo({ top, behavior: opts?.instant ? "auto" : "smooth" });
  }

  /**
   * Same-day siblings of `id`, in display order — the basis for the reorder controls.
   *
   * Reads the FULL history, never the filtered view: `reorderSameDayInteractions` rejects any
   * payload that is not exactly the day's complete set, so a filtered subset would throw.
   */
  function sameDaySiblings(id: string) {
    const target = sorted.find((x) => x.id === id);
    if (!target) return { list: [] as TimelineInteraction[], index: -1 };
    const key = dayKey(target.interactionDate);
    const list = sorted.filter((x) => dayKey(x.interactionDate) === key);
    return { list, index: list.findIndex((x) => x.id === id) };
  }

  function move(id: string, direction: -1 | 1) {
    const { list, index } = sameDaySiblings(id);
    const j = index + direction;
    if (index < 0 || !list[j]) return;

    const ordered = list.map((x) => x.id);
    [ordered[index], ordered[j]] = [ordered[j], ordered[index]];

    start(async () => {
      try {
        await reorderSameDayInteractions(
          contactId,
          dayKey(list[index].interactionDate),
          ordered
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not reorder");
      }
    });
  }

  /**
   * A row the filter or a refresh has taken off the list must not stay open behind the sheet.
   *
   * Derived here rather than reconciled in an effect, so it holds for every cause at once — a
   * filter change, a deletion arriving through `useRefreshOnVisible`, anything. `canStep` reads
   * from `visible`, so a selection that is off-list makes both directions false and the detail
   * sheet drops its entire stepper block, stranding the reader inside an interaction with no way
   * forward, no way back, and no explanation.
   */
  const openId =
    selectedId && visible.some((i) => i.id === selectedId) ? selectedId : null;

  const selectedSiblings = openId
    ? sameDaySiblings(openId)
    : { list: [], index: -1 };

  // Position within the VISIBLE list, so stepping never lands on a row the spine behind the
  // sheet is not showing. -1 is newer, 1 is older — the direction the eye moves on the spine.
  const selectedIndex = openId
    ? visible.findIndex((x) => x.id === openId)
    : -1;

  const focusRow = useCallback((id: string) => {
    setFocusId(id);
    rowRefs.current.get(id)?.focus();
  }, []);

  /** The single tab stop: wherever the reader last was, else the open row, else the top. */
  const rovingId =
    (focusId && visible.some((i) => i.id === focusId) && focusId) ||
    openId ||
    visible[0]?.id ||
    null;

  function onListKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const handled = ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"];
    if (!handled.includes(event.key) || visible.length === 0) return;

    // Resolved from the DOM first so two quick presses advance twice, even before the first
    // smooth scroll has settled and state has caught up.
    const activeRow = (document.activeElement as HTMLElement | null)?.closest?.(
      "[data-interaction-id]"
    );
    const activeRowId = activeRow?.getAttribute("data-interaction-id") ?? focusId;
    const index = Math.max(
      0,
      visible.findIndex((i) => i.id === activeRowId)
    );

    const months = visible.map((i) => monthKeyFromDate(i.interactionDate));
    let next = index;

    if (event.key === "ArrowDown") next = Math.min(visible.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = visible.length - 1;
    else if (event.key === "PageDown") {
      const found = months.findIndex((m, k) => k > index && m !== months[index]);
      next = found === -1 ? visible.length - 1 : found;
    } else {
      // Up to the top of this month; if already there, to the top of the one above.
      let startOfMonth = index;
      while (startOfMonth > 0 && months[startOfMonth - 1] === months[index]) startOfMonth -= 1;
      if (startOfMonth === index && index > 0) {
        const previousMonth = months[index - 1];
        let k = index - 1;
        while (k > 0 && months[k - 1] === previousMonth) k -= 1;
        next = k;
      } else {
        next = startOfMonth;
      }
    }

    // Without this the scroll container scrolls natively AND `.focus()` scrolls, which reads
    // as the list jumping twice.
    event.preventDefault();
    focusRow(visible[next].id);
  }

  const filterChips: Array<{
    value: FilterValue;
    label: string;
    count: number;
    active: string;
    dot: string;
  }> = [
    {
      value: "all",
      label: "All",
      count: sorted.length,
      active: "border-ink/25 bg-muted text-ink",
      dot: "bg-muted-foreground",
    },
    ...INTERACTION_FAMILIES.filter((f) => (familyCounts.get(f.value) ?? 0) > 0).map(
      (f) => ({
        value: f.value as FilterValue,
        label: f.label,
        count: familyCounts.get(f.value) ?? 0,
        active: f.chip,
        dot: f.dot,
      })
    ),
  ];

  let rowIndex = 0;

  return (
    <Card
      id="interaction-timeline"
      className="scroll-mt-24 border-border/70 shadow-none"
    >
      <CardHeader className="border-b border-border/50">
        <CardTitle as="h2">Timeline</CardTitle>
        <CardAction>
          <div className="flex items-center gap-1">
            {sorted.length > 0 ? (
              <TimelineJumpMenu
                points={scrubPoints}
                activeMonthKey={activeMonth}
                onSelectMonth={scrollToMonth}
                className="sm:hidden"
              />
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              onClick={() => setLogOpen(true)}
            >
              <Plus className="size-3.5" />
              Log interaction
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="pt-4">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <span className="flex size-11 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground">
              <CircleDashed className="size-5" />
            </span>
            <div>
              <p className="text-sm text-ink">Nothing logged yet</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Every meeting, intro and run-in you record shows up here.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => setLogOpen(true)}
            >
              <Plus className="size-3.5" />
              Log your first interaction
            </Button>
          </div>
        ) : (
          <>
            {filterChips.length > 2 ? (
              <div
                role="group"
                aria-label="Filter the timeline by kind"
                className="mb-3 flex flex-wrap items-center gap-1.5"
              >
                {filterChips.map((chip) => {
                  const on = filter === chip.value;
                  return (
                    <button
                      key={chip.value}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setFilter(on ? "all" : chip.value)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                        "transition-colors duration-(--transition-duration-fast) ease-(--ease-house)",
                        "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                        on
                          ? chip.active
                          : "border-border/60 text-muted-foreground hover:border-border hover:text-ink"
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn("size-1.5 shrink-0 rounded-full", chip.dot)}
                      />
                      {chip.label}
                      <span className="tabular-nums opacity-60">{chip.count}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {visible.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-sm text-ink">Nothing of that kind yet</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setFilter("all")}
                >
                  Show everything
                </Button>
              </div>
            ) : (
              <div className="flex gap-3">
                <div
                  ref={listRef}
                  onKeyDown={onListKeyDown}
                  aria-keyshortcuts="ArrowUp ArrowDown Home End PageUp PageDown"
                  // `pl-1` is not decoration: `overflow-y-auto` makes the box clip on BOTH
                  // axes, and a node swelling to `scale-110` on hover overflows its own edge
                  // by ~1.6px, which the container was shearing off. It also stops the row's
                  // rounded hover background sitting flush against the edge.
                  className="min-h-0 max-h-[28rem] flex-1 overflow-y-auto overscroll-contain px-1"
                >
                  <div className="space-y-6">
                    {monthGroups.map((group) => (
                      <section
                        key={group.monthKey}
                        data-month-key={group.monthKey}
                        id={`timeline-month-${group.monthKey}`}
                        className="scroll-mt-2"
                      >
                        {group.gapLabel ? (
                          <p className="-mt-3 mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span
                              aria-hidden
                              className="ml-[20px] flex h-4 w-[7px] flex-col items-center justify-between"
                            >
                              <span className="size-[3px] rounded-full bg-border" />
                              <span className="size-[3px] rounded-full bg-border" />
                              <span className="size-[3px] rounded-full bg-border" />
                            </span>
                            {group.gapLabel}
                          </p>
                        ) : null}
                        <h3 className="sticky top-0 z-[2] mb-2 bg-card/95 py-1.5 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground backdrop-blur">
                          {group.label}
                        </h3>
                        <ul className="relative">
                          {/* The spine. One continuous rule behind the nodes, fading out at the
                              foot of each month so the line reads as a thread rather than a border. */}
                          <span
                            aria-hidden
                            // 23px = the row's 8px left padding + half of the 32px node.
                            // This, the gap marker's `ml` below, and the row's `pl` are one
                            // measurement in three places: move any of them and the line
                            // stops running through the middle of the nodes.
                            className="absolute left-[23px] top-2 bottom-2 w-px bg-gradient-to-b from-primary/30 via-primary/20 to-transparent"
                          />
                          {group.items.map((i) => {
                            const Icon = interactionTypeIcon(i.interactionType);
                            const family = interactionFamilySpec(i.interactionType);
                            const openCount = openByInteraction.get(i.id) ?? 0;
                            const hasNotes = Boolean(i.notesPreview?.trim());
                            const selected = openId === i.id;
                            const when = new Date(i.interactionDate);
                            const absolute = format(when, "MMM d, yyyy");
                            const delay =
                              rowIndex < STAGGER_LIMIT
                                ? `${rowIndex * STAGGER_STEP_MS}ms`
                                : "0ms";
                            rowIndex += 1;

                            return (
                              <li
                                key={i.id}
                                id={`interaction-${i.id}`}
                                // Clears the sticky month heading, which is taller than the
                                // 1rem the row used to reserve — a keyboard-focused first row
                                // was scrolled to, then covered.
                                className="reveal-mount scroll-mt-8"
                                style={
                                  {
                                    "--reveal-delay": delay,
                                  } as React.CSSProperties
                                }
                              >
                                <button
                                  type="button"
                                  data-interaction-id={i.id}
                                  ref={(el) => {
                                    if (el) rowRefs.current.set(i.id, el);
                                    else rowRefs.current.delete(i.id);
                                  }}
                                  tabIndex={rovingId === i.id ? 0 : -1}
                                  onFocus={() => setFocusId(i.id)}
                                  onClick={() => setSelectedId(i.id)}
                                  aria-expanded={selected}
                                  className={cn(
                                    // `pl-2` is what keeps the hover background off the
                                    // node: with no left padding its rounded corner started
                                    // exactly on the icon and cut across it.
                                    "group relative flex w-full items-start gap-3 rounded-xl p-2 text-left",
                                    "transition-colors duration-(--transition-duration-fast) ease-(--ease-house)",
                                    "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                                    selected ? "bg-muted/50" : "hover:bg-muted/40"
                                  )}
                                >
                                  <span
                                    className={cn(
                                      "relative z-[1] mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border",
                                      "transition-[transform,border-color,background-color] duration-(--transition-duration-fast) ease-(--ease-house)",
                                      "group-hover:scale-110",
                                      // The family classes carry their own background, so the base
                                      // must not set one: two `bg-*` utilities of equal specificity
                                      // are resolved by stylesheet order, not the order written here.
                                      selected
                                        ? cn(family.nodeSelected, "scale-110")
                                        : family.node
                                    )}
                                  >
                                    <Icon className="size-3.5" />
                                  </span>

                                  <span className="min-w-0 flex-1">
                                    <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                                      <time
                                        dateTime={when.toISOString()}
                                        title={absolute}
                                        className="tabular-nums"
                                      >
                                        {timelineDayLabel(when)}
                                      </time>
                                      <span aria-hidden>·</span>
                                      <span>
                                        {interactionTypeLabel(i.interactionType)}
                                      </span>
                                    </span>
                                    <span className="mt-1 line-clamp-2 block text-sm leading-relaxed text-ink">
                                      {preview(i)}
                                    </span>
                                    {openCount > 0 || hasNotes ? (
                                      <span className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                        {openCount > 0 ? (
                                          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5">
                                            <span className="size-1.5 rounded-full bg-primary" />
                                            {openCount} open
                                          </span>
                                        ) : null}
                                        {hasNotes ? (
                                          <span className="inline-flex items-center gap-1">
                                            <FileText className="size-3" />
                                            Notes
                                          </span>
                                        ) : null}
                                      </span>
                                    ) : null}
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    ))}

                    {hiddenCount > 0 ? (
                      <div className="pl-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-8 text-xs text-muted-foreground"
                          onClick={() => setExpanded(true)}
                        >
                          Show {hiddenCount} older
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>

                <TimelineDateScrubber
                  points={scrubPoints}
                  activeMonthKey={activeMonth}
                  onSelectMonth={scrollToMonth}
                  className="hidden sm:flex"
                />
              </div>
            )}
          </>
        )}
      </CardContent>

      <InteractionDetailSheet
        interactionId={openId}
        canReorder={{
          // Reordering writes the whole day at once, so it is only offered on the unfiltered
          // list — under a filter the sibling being swapped with is often not on screen, and
          // the arrows would appear to do nothing.
          up: filter === "all" && selectedSiblings.index > 0,
          down:
            filter === "all" &&
            selectedSiblings.index >= 0 &&
            selectedSiblings.index < selectedSiblings.list.length - 1,
        }}
        onReorder={(direction) => openId && move(openId, direction)}
        canStep={{
          newer: selectedIndex > 0,
          older: selectedIndex >= 0 && selectedIndex < visible.length - 1,
        }}
        onStep={(direction) => {
          const next = visible[selectedIndex + direction];
          if (next) {
            setSelectedId(next.id);
            // Keeps the roving tab stop with the reader: on close, focus returns to the row
            // they ended on rather than the one they originally clicked.
            setFocusId(next.id);
          }
        }}
        onOpenChange={(open) => {
          if (open) return;
          const closing = openId;
          setSelectedId(null);
          if (closing) {
            setTimeout(() => rowRefs.current.get(closing)?.focus(), 0);
          }
        }}
      />

      {/*
        The flight itself: the type you picked, drawn as the node it is about to become,
        arcing from the button to its place on the spine.

        `x`/`y` transforms rather than `top`/`left` so the browser can composite it, and a
        three-stop keyframe rather than a straight line — a lift before the fall is what makes
        it read as something being placed rather than something sliding.
      */}
      <AnimatePresence>
        {flight ? (
          <motion.span
            key="interaction-flight"
            aria-hidden
            className={cn(
              "pointer-events-none fixed z-[60] flex items-center justify-center rounded-full border shadow-lg",
              interactionFamilySpec(flight.interactionType).nodeSelected
            )}
            style={{
              top: flight.from.top,
              left: flight.from.left,
              width: flight.from.height,
              height: flight.from.height,
            }}
            initial={{ x: 0, y: 0, scale: 1, opacity: 0 }}
            animate={{
              x: [0, (flight.to.left - flight.from.left) * 0.6, flight.to.left - flight.from.left],
              y: [
                0,
                (flight.to.top - flight.from.top) * 0.25 - 56,
                flight.to.top - flight.from.top,
              ],
              scale: [0.9, 0.72, 32 / flight.from.height],
              opacity: [0, 1, 1],
            }}
            exit={{ opacity: 0, scale: 32 / flight.from.height }}
            transition={{ duration: 0.66, ease: EASE_HOUSE, times: [0, 0.55, 1] }}
            onAnimationComplete={() => {
              if (flight.interactionId) {
                flashSection(`interaction-${flight.interactionId}`);
              }
              setFlight(null);
            }}
          >
            {(() => {
              const Icon = interactionTypeIcon(flight.interactionType);
              return <Icon className="size-3.5" />;
            })()}
          </motion.span>
        ) : null}
      </AnimatePresence>

      <LogInteractionSheet
        contactId={contactId}
        contactName={contactName}
        hasApiKey={hasApiKey}
        open={logOpen}
        onOpenChange={setLogOpen}
      />
    </Card>
  );
}
