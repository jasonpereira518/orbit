"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
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
  monthKeyFromDate,
  monthLabel,
  monthShort,
} from "@/components/contacts/timeline-date-scrubber";
import { InteractionDetailSheet } from "@/components/contacts/interaction-detail-sheet";
import { LogInteractionSheet } from "@/components/contacts/log-interaction-sheet";
import {
  interactionTypeIcon,
  interactionTypeLabel,
  isWarmInteractionType,
} from "@/lib/interaction-types";
import { useRefreshOnVisible } from "@/lib/use-refresh-on-visible";
import { cn } from "@/lib/utils";

export type TimelineInteraction = {
  id: string;
  interactionType: string;
  interactionDate: Date | string;
  sameDayOrder?: number | null;
  rawNotes: string | null;
  aiSummary: string | null;
  actionItems: string[] | null;
};

/** How many rows get a staggered entrance before the cascade is capped. */
const STAGGER_LIMIT = 8;
const STAGGER_STEP_MS = 30;

function dayKey(d: Date | string) {
  return format(new Date(d), "yyyy-MM-dd");
}

/**
 * The line shown on the row. Two rendered lines' worth is the budget — the row clamps it —
 * so this only guards against handing the browser a whole pasted note to lay out.
 */
function preview(i: TimelineInteraction) {
  const text = (i.aiSummary || i.rawNotes || "").replace(/\s+/g, " ").trim();
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
  const [, start] = useTransition();
  const [activeMonth, setActiveMonth] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);

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

  const monthGroups = useMemo(() => {
    const groups: Array<{
      monthKey: string;
      label: string;
      shortLabel: string;
      items: TimelineInteraction[];
    }> = [];
    const map = new Map<string, TimelineInteraction[]>();
    for (const i of sorted) {
      const key = monthKeyFromDate(i.interactionDate);
      const list = map.get(key) || [];
      list.push(i);
      map.set(key, list);
    }
    for (const [monthKey, items] of map) {
      groups.push({
        monthKey,
        label: monthLabel(items[0].interactionDate),
        shortLabel: monthShort(items[0].interactionDate),
        items,
      });
    }
    return groups;
  }, [sorted]);

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
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0]?.target.getAttribute("data-month-key");
        if (first) setActiveMonth(first);
      },
      { root, rootMargin: "-10% 0px -70% 0px", threshold: 0 }
    );

    sections.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [monthGroups]);

  function scrollToMonth(monthKey: string) {
    setActiveMonth(monthKey);
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-month-key="${monthKey}"]`
    );
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** Same-day siblings of `id`, in display order — the basis for the reorder controls. */
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

  const selectedSiblings = selectedId
    ? sameDaySiblings(selectedId)
    : { list: [], index: -1 };

  // Position in the whole timeline (newest first), so the detail panel can step through it
  // without closing. -1 is newer, 1 is older — the direction the eye moves on the spine.
  const selectedIndex = selectedId
    ? sorted.findIndex((x) => x.id === selectedId)
    : -1;

  let rowIndex = 0;

  return (
    <Card
      id="interaction-timeline"
      className="scroll-mt-24 border-border/70 shadow-none"
    >
      <CardHeader className="border-b border-border/50">
        <CardTitle as="h2">Timeline</CardTitle>
        <CardAction>
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
          <div className="flex gap-3">
            <div
              ref={listRef}
              className="min-h-0 max-h-[28rem] flex-1 overflow-y-auto overscroll-contain pr-1"
            >
              <div className="space-y-6">
                {monthGroups.map((group) => (
                  <section
                    key={group.monthKey}
                    data-month-key={group.monthKey}
                    id={`timeline-month-${group.monthKey}`}
                    className="scroll-mt-2"
                  >
                    <h3 className="sticky top-0 z-[2] mb-2 bg-card/95 py-1.5 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground backdrop-blur">
                      {group.label}
                    </h3>
                    <ul className="relative">
                      {/* The spine. One continuous rule behind the nodes, fading out at the
                          foot of each month so the line reads as a thread rather than a border. */}
                      <span
                        aria-hidden
                        className="absolute left-[15px] top-2 bottom-2 w-px bg-gradient-to-b from-primary/30 via-primary/20 to-transparent"
                      />
                      {group.items.map((i) => {
                        const Icon = interactionTypeIcon(i.interactionType);
                        const warm = isWarmInteractionType(i.interactionType);
                        const openCount = openByInteraction.get(i.id) ?? 0;
                        const hasNotes = Boolean(i.rawNotes?.trim());
                        const selected = selectedId === i.id;
                        const delay =
                          rowIndex < STAGGER_LIMIT
                            ? `${rowIndex * STAGGER_STEP_MS}ms`
                            : "0ms";
                        rowIndex += 1;

                        return (
                          <li
                            key={i.id}
                            id={`interaction-${i.id}`}
                            className="reveal-mount scroll-mt-4"
                            style={
                              {
                                "--reveal-delay": delay,
                              } as React.CSSProperties
                            }
                          >
                            <button
                              type="button"
                              onClick={() => setSelectedId(i.id)}
                              aria-expanded={selected}
                              className={cn(
                                "group relative flex w-full items-start gap-3 rounded-xl py-2 pr-2 text-left",
                                "transition-colors duration-(--transition-duration-fast) ease-(--ease-house)",
                                "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                                selected ? "bg-muted/50" : "hover:bg-muted/40"
                              )}
                            >
                              <span
                                className={cn(
                                  "relative z-[1] mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border bg-card",
                                  "transition-[transform,border-color,background-color] duration-(--transition-duration-fast) ease-(--ease-house)",
                                  "group-hover:scale-110",
                                  warm
                                    ? "border-primary/40 bg-primary/10 text-primary"
                                    : "border-border text-muted-foreground",
                                  selected &&
                                    "scale-110 border-primary bg-primary/15 text-primary"
                                )}
                              >
                                <Icon className="size-3.5" />
                              </span>

                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                                  <time
                                    dateTime={new Date(
                                      i.interactionDate
                                    ).toISOString()}
                                    className="tabular-nums"
                                  >
                                    {format(
                                      new Date(i.interactionDate),
                                      "MMM d, yyyy"
                                    )}
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
      </CardContent>

      <InteractionDetailSheet
        interactionId={selectedId}
        canReorder={{
          up: selectedSiblings.index > 0,
          down:
            selectedSiblings.index >= 0 &&
            selectedSiblings.index < selectedSiblings.list.length - 1,
        }}
        onReorder={(direction) => selectedId && move(selectedId, direction)}
        canStep={{
          newer: selectedIndex > 0,
          older: selectedIndex >= 0 && selectedIndex < sorted.length - 1,
        }}
        onStep={(direction) => {
          const next = sorted[selectedIndex + direction];
          if (next) setSelectedId(next.id);
        }}
        onOpenChange={(open) => !open && setSelectedId(null)}
      />

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
