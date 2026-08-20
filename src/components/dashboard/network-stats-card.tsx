"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { NetworkStatItem, NetworkStats } from "@/lib/network-stats";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";

const COUNT_MS = 800;

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
    <details
      ref={detailsRef}
      className="group rounded-2xl border border-border/70 bg-card"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-6 [&::-webkit-details-marker]:hidden">
        <div>
          <p className="text-sm font-medium text-primary">Your orbit in numbers</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{stats.subheadline}</p>
        </div>
        <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-border/60 px-6 pb-6 pt-4">
        <dl className="grid auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {stats.items.map((item) => (
            <div
              key={item.label}
              className="flex h-full min-h-[5.5rem] flex-col rounded-xl border border-border/60 bg-background/60 px-3 py-3"
            >
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {item.label}
              </dt>
              <dd className="mt-1 font-[family-name:var(--font-display)] text-2xl leading-none text-primary">
                <AnimatedStatValue item={item} active={open} />
              </dd>
              <dd className="mt-1.5 min-h-[1rem] text-xs text-muted-foreground">
                {item.detail && !item.empty ? item.detail : "\u00A0"}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}
