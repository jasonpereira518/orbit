"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Sparkles } from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import {
  APP_NAV,
  MOBILE_BOTTOM_NAV,
  MOBILE_MORE_NAV,
  isNavActive,
} from "@/components/layout/app-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { clerkAppearance } from "@/lib/clerk-appearance";
import { isHrefHidden } from "@/lib/surfaces";
import { SPRING_PILL, SPRING_TAP } from "@/lib/motion";
import { OPEN_ASK_BAR_EVENT } from "@/lib/ask-bar-events";

// A finger-drag across the row must move at least this far before it counts
// as a slide rather than a tap — filters out ordinary tap jitter.
const DRAG_THRESHOLD_PX = 8;

type DraggableEntry = { type: "more" } | { type: "link"; href: string };

export function MobileNav({
  clerkOn,
  demoMode,
  hidden,
}: {
  clerkOn: boolean;
  demoMode: boolean;
  /** Surfaces hidden from this viewer. Empty for an exempt operator. */
  hidden: ReadonlySet<string>;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const pillTransition = reducedMotion ? { duration: 0 } : SPRING_PILL;

  /**
   * Both lists, filtered, BEFORE anything derives an index from them.
   *
   * The sliding pill is pure index math over `draggableEntries`, and `entryCursor` in the
   * render below walks the bottom bar in lockstep with it. Filtering at the point of
   * render instead would leave the two walking different lists, and the pill would land
   * on the wrong tab. Everything downstream reads these, never the module constants.
   */
  const moreNav = useMemo(
    () => MOBILE_MORE_NAV.filter((item) => !isHrefHidden(item.href, hidden)),
    [hidden]
  );
  const bottomNav = useMemo(
    () =>
      MOBILE_BOTTOM_NAV.filter((item) =>
        // "More" is a door to the overflow sheet: with nothing left behind it, it opens
        // onto an empty sheet.
        "id" in item ? moreNav.length > 0 : !isHrefHidden(item.href, hidden)
      ),
    [hidden, moreNav]
  );

  const moreActive = moreNav.some((item) => isNavActive(pathname, item.href));

  // Capture keeps its own permanent circle rather than joining the shared
  // sliding highlight, so it's excluded from the draggable set — the drag
  // still glides smoothly through its zone by resolving to whichever
  // neighboring item is closer.
  const draggableEntries = useMemo<DraggableEntry[]>(() => {
    const entries: DraggableEntry[] = [];
    for (const item of bottomNav) {
      if ("id" in item) {
        entries.push({ type: "more" });
      } else if (item.href !== "/capture") {
        entries.push({ type: "link", href: item.href });
      }
    }
    return entries;
  }, [bottomNav]);

  const activeEntryIndex = draggableEntries.findIndex((entry) =>
    entry.type === "more" ? moreActive : isNavActive(pathname, entry.href)
  );

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  // Whichever item currently has a finger/pointer down on it — set the
  // instant the press starts (unlike dragIndex, not gated by the drag
  // threshold) and follows the drag if one develops. Independent of which
  // item is the *active* route, so pressing an inactive item still grows
  // its icon/label even though it has no capsule behind it.
  const [pressedItemIndex, setPressedItemIndex] = useState<number | null>(
    null
  );
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const itemCentersRef = useRef<number[]>([]);
  const dragStartXRef = useRef<number | null>(null);
  const draggedPastThresholdRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  // Mirrors `dragIndex` state but updates synchronously and is read on
  // pointerup — the state value can't be trusted there since there's no
  // guarantee React has re-rendered (and rebound this handler via the
  // latest closure) between the final pointermove and the pointerup that
  // follows it, especially for a fast flick.
  const dragIndexRef = useRef<number | null>(null);

  const highlightIndex =
    isDragging && dragIndex !== null ? dragIndex : activeEntryIndex;

  function closestEntryIndexForX(clientX: number) {
    let bestIndex = 0;
    let bestDist = Infinity;
    itemCentersRef.current.forEach((center, i) => {
      const dist = Math.abs(clientX - center);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    });
    return bestIndex;
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLUListElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragStartXRef.current = e.clientX;
    draggedPastThresholdRef.current = false;
    dragIndexRef.current = null;
    itemCentersRef.current = itemRefs.current.map((el) => {
      const r = el?.getBoundingClientRect();
      return r ? r.left + r.width / 2 : 0;
    });
    setPressedItemIndex(closestEntryIndexForX(e.clientX));
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLUListElement>) {
    if (dragStartXRef.current === null) return;
    const dx = Math.abs(e.clientX - dragStartXRef.current);
    if (!draggedPastThresholdRef.current && dx > DRAG_THRESHOLD_PX) {
      draggedPastThresholdRef.current = true;
      setIsDragging(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Invalid/inactive pointer id (e.g. synthetic events) — the drag
        // still works via clientX tracking, capture is just an enhancement.
      }
    }
    if (draggedPastThresholdRef.current) {
      e.preventDefault();
      const idx = closestEntryIndexForX(e.clientX);
      dragIndexRef.current = idx;
      setDragIndex(idx);
      setPressedItemIndex(idx);
    }
  }

  function endDrag(navigate: boolean) {
    const idx = dragIndexRef.current;
    if (navigate && draggedPastThresholdRef.current && idx !== null) {
      // Real touch drags past the browser's own drag threshold never fire a
      // trailing click at all, so this flag would otherwise stay armed
      // forever and silently eat the user's next unrelated tap — clear it
      // on a short timer so it can only ever suppress a click that follows
      // *this* gesture within a beat, not some later one.
      suppressNextClickRef.current = true;
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 500);
      const entry = draggableEntries[idx];
      if (entry.type === "more") {
        setMoreOpen(true);
      } else {
        router.push(entry.href);
      }
    }
    dragStartXRef.current = null;
    draggedPastThresholdRef.current = false;
    dragIndexRef.current = null;
    setIsDragging(false);
    setDragIndex(null);
    setPressedItemIndex(null);
  }

  function handlePointerUp() {
    endDrag(true);
  }

  function handlePointerCancel() {
    endDrag(false);
  }

  function handleClickCapture(e: React.MouseEvent) {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }

  let entryCursor = -1;

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:hidden"
        style={{ viewTransitionName: "app-mobile-nav" }}
        aria-label="Main navigation"
      >
        {/* Scrim behind the now-transparent pill — grounds it against
         * whatever's scrolling underneath so it stays readable without
         * giving the pill itself an opaque fill. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-black/25 via-black/8 to-transparent dark:from-black/55 dark:via-black/20"
        />

        <div className="relative w-full max-w-lg">
          <div className="liquid-glass liquid-glass-pill" aria-hidden="true" />

          <ul
            className="relative z-10 flex touch-none items-stretch justify-around gap-0.5 px-1.5 pt-1 pb-1.5"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onClickCapture={handleClickCapture}
            onDragStart={(e) => e.preventDefault()}
          >
            {bottomNav.map((item) => {
              if ("id" in item && item.id === "more") {
                entryCursor += 1;
                const myIndex = entryCursor;
                const displayActive = myIndex === highlightIndex;
                const Icon = item.icon;
                return (
                  <li key="more" className="flex-1">
                    <button
                      type="button"
                      ref={(el) => {
                        itemRefs.current[myIndex] = el;
                      }}
                      onClick={() => setMoreOpen(true)}
                      className={cn(
                        "flex w-full items-center justify-center py-1 text-[10px] font-medium transition-colors",
                        displayActive
                          ? "text-primary dark:text-white"
                          : "text-muted-foreground hover:text-foreground dark:text-white/75"
                      )}
                    >
                      <span className="relative flex w-[66px] flex-col items-center gap-0.5 rounded-full px-0.5 py-1.5">
                        {displayActive && (
                          <motion.span
                            layoutId="mobile-nav-pill"
                            className="absolute inset-0 rounded-full bg-white/70 shadow-sm ring-1 ring-black/[0.04] dark:bg-white/10 dark:ring-white/10"
                            transition={pillTransition}
                          />
                        )}
                        <span
                          className="relative z-10 flex flex-col items-center gap-0.5 transition-transform duration-150 ease-out"
                          style={{
                            transform:
                              myIndex === pressedItemIndex
                                ? "scale(1.15)"
                                : undefined,
                          }}
                        >
                          <Icon className="h-5 w-5" aria-hidden />
                          <span>{item.label}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              }

              const navItem = item as (typeof APP_NAV)[number];
              const Icon = navItem.icon;
              const isCapture = navItem.href === "/capture";

              if (isCapture) {
                return (
                  <li key={navItem.href} className="flex-1">
                    <Link
                      href={navItem.href}
                      draggable={false}
                      className="relative flex w-full translate-y-1.5 flex-col items-center gap-0.5 px-1 py-1.5 text-[10px] font-medium text-primary"
                    >
                      <span className="h-5 w-5" aria-hidden />
                      <motion.span
                        aria-hidden
                        className="absolute -top-6 left-1/2 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
                        whileTap={reducedMotion ? undefined : { scale: 0.88 }}
                        transition={reducedMotion ? { duration: 0 } : SPRING_TAP}
                      >
                        <Icon className="h-5 w-5" aria-hidden />
                      </motion.span>
                      <span>{navItem.label}</span>
                    </Link>
                  </li>
                );
              }

              entryCursor += 1;
              const myIndex = entryCursor;
              const displayActive = myIndex === highlightIndex;

              return (
                <li key={navItem.href} className="flex-1">
                  <Link
                    href={navItem.href}
                    ref={(el) => {
                      itemRefs.current[myIndex] = el;
                    }}
                    draggable={false}
                    className={cn(
                      "flex w-full items-center justify-center py-1 text-[10px] font-medium transition-colors",
                      displayActive
                        ? "text-primary dark:text-white"
                        : "text-muted-foreground hover:text-foreground dark:text-white/75"
                    )}
                  >
                    <span className="relative flex w-[66px] flex-col items-center gap-0.5 rounded-full px-0.5 py-1.5">
                      {displayActive && (
                        <motion.span
                          layoutId="mobile-nav-pill"
                          className="absolute inset-0 rounded-full bg-white/70 shadow-sm ring-1 ring-black/[0.04] dark:bg-white/10 dark:ring-white/10"
                          transition={pillTransition}
                        />
                      )}
                      <span
                        className="relative z-10 flex flex-col items-center gap-0.5 transition-transform duration-150 ease-out"
                        style={{
                          transform:
                            myIndex === pressedItemIndex
                              ? "scale(1.15)"
                              : undefined,
                        }}
                      >
                        <Icon className="h-5 w-5" aria-hidden />
                        <span>{navItem.label}</span>
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
          </SheetHeader>

          <nav className="flex flex-col gap-1 px-1 py-2">
            <button
              type="button"
              onClick={() => {
                setMoreOpen(false);
                window.dispatchEvent(new Event(OPEN_ASK_BAR_EVENT));
              }}
              className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
            >
              <Sparkles className="h-5 w-5 shrink-0" />
              Ask your network
            </button>
            {moreNav.map((item) => {
              const active = isNavActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition-colors",
                    active
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                  )}
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="mt-4 flex items-center justify-between border-t border-border/70 px-3 py-4">
            <div className="flex items-center gap-3">
              {clerkOn ? (
                <>
                  <UserButton appearance={clerkAppearance} />
                  <span className="text-sm text-muted-foreground">Account</span>
                </>
              ) : demoMode ? (
                <p className="text-xs text-muted-foreground">
                  Demo mode — add Clerk keys to enable auth
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Sign in required</p>
              )}
            </div>
            <ThemeToggle className="h-9 w-9 text-muted-foreground hover:text-foreground" />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
