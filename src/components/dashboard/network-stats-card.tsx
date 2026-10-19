"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/card";
import type { NetworkStatItem, NetworkStats } from "@/lib/network-stats";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

// The `--transition-duration-celestial` tier (700ms) is the repo's set-piece beat, and
// this is the one deliberately-slow number on the dashboard. 800 was off the scale
// entirely; this keeps the count readable without being the slowest thing on screen.
const COUNT_MS = 700;

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function AnimatedStatValue({
  item,
  active,
}: {
  item: NetworkStatItem;
  active: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const spanRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<number | null>(null);

  // Count-up writes textContent directly — a React render per frame for
  // every visible stat is wasted work.
  useEffect(() => {
    const span = spanRef.current;
    if (!span || item.empty) return;

    if (frameRef.current != null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    const write = (v: number) => {
      span.textContent = `${v.toLocaleString()}${item.suffix ?? ""}`;
    };

    if (!active || reduced || item.value === 0) {
      write(item.value);
      return;
    }

    write(0);
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_MS);
      write(Math.round(easeOutCubic(t) * item.value));
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        frameRef.current = null;
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [active, reduced, item.empty, item.value, item.suffix]);

  if (item.empty) {
    return <span>—</span>;
  }

  // Server-rendered content is the final value; the effect rewinds and
  // counts up only when the card becomes active.
  return (
    <span ref={spanRef}>
      {item.value.toLocaleString()}
      {item.suffix}
    </span>
  );
}

/**
 * "Your orbit in numbers": a collapsed `<details>` in an ordinary card. It used to be a
 * night-sky panel with its own hex palette and a canvas starfield at the foot of an
 * otherwise token-based page; the numbers (and their count-up, which is one rAF per stat
 * and only while the panel is open) were the point, so those stay and the sky goes.
 */
export function NetworkStatsCard({ stats }: { stats: NetworkStats }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = detailsRef.current;
    if (!el) return;

    const onToggle = () => setOpen(el.open);
    el.addEventListener("toggle", onToggle);
    setOpen(el.open);
    return () => el.removeEventListener("toggle", onToggle);
  }, []);

  return (
    // The card's padding is on the summary and the panel rather than the card, so the
    // summary's hover wash reaches the card's edges.
    <Card className="gap-0 py-0">
      <details ref={detailsRef} className="group">
        {/* The summary is this card's only control. */}
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-5 py-4 transition-colors duration-fast ease-house hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset focus-ring-fallback [&::-webkit-details-marker]:hidden">
          <div className="min-w-0">
            <CardTitle as="h2">Your orbit in numbers</CardTitle>
            <p className="mt-0.5 text-sm text-muted-foreground">{stats.subheadline}</p>
          </div>
          <ChevronDown
            className="size-5 shrink-0 text-muted-foreground transition-transform duration-slow ease-house group-open:rotate-180"
            aria-hidden
          />
        </summary>
        {/* The chevron used to animate while the panel it points at teleported open —
            animating the indicator but not the thing indicated is worse than animating
            neither. `grid-rows` 0fr->1fr is the repo's height-collapse technique
            (contacts-list.tsx:434); `group-open:` drives it straight off the native
            <details> state, so no JS is involved in the motion.

            `<details>` sets `content-visibility: hidden` on its collapsed content, which
            would skip the transition, so the panel is force-shown and the grid row does
            the hiding instead. */}
        <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-slow ease-house group-open:grid-rows-[1fr] [content-visibility:visible]">
          <div className="overflow-hidden">
            <div className="border-t border-border-subtle px-5 pb-5 pt-4">
              <dl className="grid auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {stats.items.map((item) => (
                  <div
                    key={item.label}
                    className="flex h-full min-h-[5.5rem] flex-col rounded-lg border border-border-subtle bg-surface-inset px-3 py-3"
                  >
                    <dt className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                      {item.label}
                    </dt>
                    <dd className="mt-1 font-heading text-2xl leading-none text-ink">
                      <AnimatedStatValue item={item} active={open} />
                    </dd>
                    <dd className="mt-1.5 min-h-[1rem] text-xs text-muted-foreground">
                      {item.detail && !item.empty ? item.detail : " "}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      </details>
    </Card>
  );
}
