"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SECTION_SCROLL_OFFSET,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/components/settings/sections";
import { cn } from "@/lib/utils";

const FIRST_ID = SETTINGS_SECTIONS[0].id;
const LAST_ID = SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1].id;

/**
 * Everything an open row spends beside the label — `px-3`, `gap-3`, tick slot —
 * plus a hairline, so subpixel text metrics can never clip the widest label.
 */
const RAIL_CHROME = 24 + 12 + 24 + 1;

/**
 * Slack past an exact fit. Rows are right-aligned, so it lands ahead of the
 * longest label and keeps the text off the panel's edge instead of flush to it.
 */
const RAIL_BREATHING_ROOM = 16;

/** A section becomes current once its top crosses this line from the top. */
function anchorLine() {
  return Math.min(160, window.innerHeight * 0.25);
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The settings column scrolls the document today, but `AppShell` puts
 * `overflow-auto` on `<main>` and swaps it to a fixed-height scroller on other
 * routes. Resolve the real scroller at runtime so the rail keeps working if
 * that ever changes here.
 */
function scrollerFor(el: Element | null): Element {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight + 1
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

const scrollAnimation = { frame: 0 };

function stopScrollAnimation() {
  if (scrollAnimation.frame) cancelAnimationFrame(scrollAnimation.frame);
  scrollAnimation.frame = 0;
}

/**
 * The section last asked for, honoured only while the scroll sits pinned at its
 * end. The last screenful holds several sections at once, so all of them resolve
 * to the same scroll position and position alone cannot tell them apart; the
 * request can. `settled` marks the travel finished, so an intent survives its
 * own journey through non-end positions but is dropped the moment the reader
 * moves the page somewhere else themselves.
 */
const railIntent: { id: SettingsSectionId | null; settled: boolean } = {
  id: null,
  settled: true,
};

/**
 * Driven by hand rather than `behavior: "smooth"` so the travel rides the house
 * curve at a distance-aware duration, and so a scrub can stay instant while a
 * tap eases — one call site, two feels.
 */
function scrollToSection(id: SettingsSectionId, animate: boolean) {
  const el = document.getElementById(id);
  if (!el) return;

  railIntent.id = id;
  const scroller = scrollerFor(el);
  const isDocument =
    scroller === document.scrollingElement ||
    scroller === document.documentElement;
  const scrollerTop = isDocument ? 0 : scroller.getBoundingClientRect().top;
  const from = scroller.scrollTop;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const to = Math.min(
    max,
    Math.max(
      0,
      from + el.getBoundingClientRect().top - scrollerTop - SECTION_SCROLL_OFFSET,
    ),
  );

  stopScrollAnimation();
  railIntent.settled = false;
  const distance = to - from;
  // A hidden document gets no frames, so an animation there would be a silent
  // no-op rather than a slower arrival.
  if (!animate || document.hidden || reducedMotion() || Math.abs(distance) < 2) {
    scroller.scrollTop = to;
    railIntent.settled = true;
    return;
  }

  const duration = Math.min(560, 200 + Math.abs(distance) * 0.16);
  const start = performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - start) / duration);
    scroller.scrollTop = from + distance * (1 - Math.pow(1 - progress, 4));
    if (progress >= 1) railIntent.settled = true;
    scrollAnimation.frame =
      progress < 1 ? requestAnimationFrame(step) : 0;
  };
  scrollAnimation.frame = requestAnimationFrame(step);
}

export function SettingsSectionNav() {
  const [activeId, setActiveId] = useState<SettingsSectionId>(FIRST_ID);
  const [dragId, setDragId] = useState<SettingsSectionId | null>(null);

  const navRef = useRef<HTMLElement>(null);
  const itemsRef = useRef(new Map<SettingsSectionId, HTMLButtonElement>());
  const labelsRef = useRef(new Map<SettingsSectionId, HTMLSpanElement>());
  const centersRef = useRef<Array<{ id: SettingsSectionId; center: number }>>(
    [],
  );
  const endDragRef = useRef<(() => void) | null>(null);

  // The open rail is exactly as wide as its longest label. CSS cannot animate
  // to `max-content`, so measure the labels and hand the width to the
  // transition as a length. Labels overflow their clipped button rather than
  // shrinking, so their boxes report true text width in either state.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    const measure = () => {
      let widest = 0;
      for (const label of labelsRef.current.values()) {
        widest = Math.max(widest, label.getBoundingClientRect().width);
      }
      // Zero means the rail has no layout yet — styles still landing, or a
      // breakpoint below `xl` where it is display:none. Leave the fallback up;
      // the observer calls back once there is something real to measure.
      if (widest <= 0) return;
      nav.style.setProperty(
        "--rail-open",
        `${Math.ceil(widest) + RAIL_CHROME + RAIL_BREATHING_ROOM}px`,
      );
    };

    measure();
    // Re-measure once the display face lands; fallback metrics are narrower.
    document.fonts?.ready.then(measure).catch(() => {});
    // Covers first layout and breakpoint changes alike, so a measurement taken
    // before the rail existed cannot strand it on the fallback width.
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);

  // Track which section owns the viewport.
  useEffect(() => {
    let frame = 0;

    const compute = () => {
      frame = 0;
      const line = anchorLine();
      let next: SettingsSectionId = FIRST_ID;
      let lastEl: Element | null = null;

      for (const section of SETTINGS_SECTIONS) {
        const el = document.getElementById(section.id);
        if (!el) continue;
        lastEl = el;
        if (el.getBoundingClientRect().top - 1 <= line) next = section.id;
      }

      // The page runs out of scroll before its last sections can reach the
      // anchor, so at the end they all report the same position. Honour the
      // request that put us here, and fall back to the last section for a plain
      // scroll to the bottom.
      const scroller = scrollerFor(lastEl);
      const scrollable = scroller.scrollHeight - scroller.clientHeight;
      if (scrollable > 4 && scroller.scrollTop >= scrollable - 2) {
        next = railIntent.id ?? LAST_ID;
      } else if (railIntent.settled) {
        railIntent.id = null;
      }

      setActiveId(next);
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(compute);
    };

    schedule();
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  const nearestId = useCallback((clientY: number) => {
    let best: SettingsSectionId | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const item of centersRef.current) {
      const distance = Math.abs(item.center - clientY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = item.id;
      }
    }
    return best;
  }, []);

  // One gesture handles both taps and scrubs. Listeners are bound here rather
  // than in an effect so a fast press-release can't outrun them.
  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    endDragRef.current?.();

    centersRef.current = SETTINGS_SECTIONS.flatMap((section) => {
      const el = itemsRef.current.get(section.id);
      if (!el) return [];
      const rect = el.getBoundingClientRect();
      return [{ id: section.id, center: rect.top + rect.height / 2 }];
    });

    const pressedId = nearestId(event.clientY);
    if (!pressedId) return;

    const drag = {
      pointerId: event.pointerId,
      lastId: pressedId,
      scrubbed: false,
    };
    setDragId(pressedId);
    // A scrub drags across the page; without this it selects text underneath.
    document.body.classList.add("select-none");

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== drag.pointerId) return;
      const id = nearestId(moveEvent.clientY);
      if (!id || id === drag.lastId) return;
      drag.lastId = id;
      drag.scrubbed = true;
      setDragId(id);
      // Instant, not smooth: an animated scrub lags behind the pointer.
      scrollToSection(id, false);
    };

    const onEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== drag.pointerId) return;
      if (!drag.scrubbed && endEvent.type === "pointerup") {
        scrollToSection(drag.lastId, true);
      }
      endDragRef.current?.();
    };

    const end = () => {
      endDragRef.current = null;
      document.body.classList.remove("select-none");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      setDragId(null);
    };

    endDragRef.current = end;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  useEffect(() => () => endDragRef.current?.(), []);

  // Never fight the reader: manual scroll input abandons our animation, and
  // hands the position back to them so a stale request stops speaking for it.
  useEffect(() => {
    const release = () => {
      stopScrollAnimation();
      railIntent.settled = true;
    };
    window.addEventListener("wheel", release, { passive: true });
    window.addEventListener("touchstart", release, { passive: true });
    return () => {
      window.removeEventListener("wheel", release);
      window.removeEventListener("touchstart", release);
      stopScrollAnimation();
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    // Step from whatever is focused, not from the scroll-derived current
    // section: two quick presses must advance twice even though the second
    // lands before the first scroll has resolved.
    const focused = SETTINGS_SECTIONS.findIndex(
      (s) => itemsRef.current.get(s.id) === document.activeElement,
    );
    const index =
      focused >= 0
        ? focused
        : SETTINGS_SECTIONS.findIndex((s) => s.id === activeId);
    let nextIndex: number;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        nextIndex = Math.min(index + 1, SETTINGS_SECTIONS.length - 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        nextIndex = Math.max(index - 1, 0);
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = SETTINGS_SECTIONS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const { id } = SETTINGS_SECTIONS[nextIndex];
    itemsRef.current.get(id)?.focus();
    scrollToSection(id, true);
  };

  const shownId = dragId ?? activeId;

  return (
    <nav
      ref={navRef}
      aria-label="Settings sections"
      data-dragging={dragId ? "true" : undefined}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      className={cn(
        // `w-12` is the closed floor: `px-3` plus the full tick slot, so the
        // longer current tick is not clipped down to the inactive width.
        "group fixed right-2 top-1/2 z-30 hidden w-12 -translate-y-1/2 touch-none select-none xl:block",
        "transition-[width] duration-base ease-house",
        "hover:w-[var(--rail-open,11rem)] focus-within:w-[var(--rail-open,11rem)] data-[dragging=true]:w-[var(--rail-open,11rem)]",
      )}
    >
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 rounded-2xl border border-border/70 bg-card/85 opacity-0 shadow-[0_18px_40px_-28px_rgba(15,61,62,0.65)] backdrop-blur-xl",
          "transition-opacity duration-base ease-house",
          "group-hover:opacity-100 group-focus-within:opacity-100 group-data-[dragging=true]:opacity-100",
        )}
      />

      <ul className="relative flex flex-col gap-px px-3 py-2.5">
        {SETTINGS_SECTIONS.map((section) => {
          const isCurrent = section.id === shownId;
          return (
            <li key={section.id}>
              <button
                ref={(node) => {
                  if (node) itemsRef.current.set(section.id, node);
                  else itemsRef.current.delete(section.id);
                }}
                type="button"
                tabIndex={section.id === activeId ? 0 : -1}
                aria-current={isCurrent ? "true" : undefined}
                // Pointer input is owned by the gesture above; `detail === 0`
                // isolates the synthetic click keyboard activation fires.
                onClick={(event) => {
                  if (event.detail === 0) scrollToSection(section.id, true);
                }}
                className={cn(
                  "group/item flex h-7 w-full cursor-pointer items-center justify-end gap-3 overflow-hidden rounded-md",
                  "outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset",
                )}
              >
                {/* Clipped by the button, so it is unhittable while the rail is
                    collapsed and wipes in as the rail widens. One weight for
                    every state: a heavier current row would outgrow the width
                    measured from the others. */}
                <span
                  ref={(node) => {
                    if (node) labelsRef.current.set(section.id, node);
                    else labelsRef.current.delete(section.id);
                  }}
                  className={cn(
                    "shrink-0 whitespace-nowrap text-[0.8125rem] font-medium leading-none opacity-0",
                    "transition-[opacity,color] duration-base ease-house",
                    "group-hover:opacity-100 group-focus-within:opacity-100 group-data-[dragging=true]:opacity-100",
                    isCurrent
                      ? "text-primary"
                      : "text-muted-foreground group-hover/item:text-foreground",
                  )}
                >
                  {section.label}
                </span>
                {/* Fixed slot so the current tick grows leftward instead of
                    nudging the labels off a shared right edge. */}
                <span className="flex w-6 shrink-0 items-center justify-end">
                  <span
                    className={cn(
                      "h-0.5 rounded-full transition-all duration-fast ease-house",
                      isCurrent
                        ? "w-6 bg-primary"
                        : "w-4 bg-foreground/50 group-hover/item:bg-foreground/80",
                    )}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
