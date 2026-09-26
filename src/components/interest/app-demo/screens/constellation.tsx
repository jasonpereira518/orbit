"use client";

import { AnimatePresence, motion } from "motion/react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CLUSTERS, daysLabel, personById, type ClusterId } from "../demo-cast";
import { useDemo } from "../demo-context";
import { closenessOf, lastTouchOf } from "../demo-state";
import { Avatar, BTN_PRIMARY, ClosenessChip, DISPLAY, INPUT, TierBadge } from "../demo-ui";
import { SkyChart } from "../sky-chart";

const FILTERS: { id: ClusterId | "all"; label: string }[] = [
  { id: "all", label: "Everyone" },
  ...(Object.keys(CLUSTERS) as ClusterId[]).map((id) => ({ id, label: id === "michigan" ? "Michigan" : CLUSTERS[id].label })),
];

export function ConstellationScreen() {
  const { state, dispatch, reduced } = useDemo();
  const selected = personById(state.star);

  return (
    <div className="flex h-full flex-col gap-3">
      <header>
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[var(--d-primary)]">Star chart</p>
        <h2 className={cn(DISPLAY, "mt-1 text-3xl")}>Constellation</h2>
        <p className="mt-1 max-w-xl text-sm text-[var(--d-dim)]">
          You are the sun. Companies and schools form constellations around you — each figure traced by its own people.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative w-60">
          <span className="sr-only">Search the sky</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--d-dim)]" aria-hidden="true" />
          <input
            value={state.skyQuery}
            onChange={(e) => dispatch({ type: "skyQuery", q: e.target.value })}
            placeholder="Search name, role, tag…"
            className={cn(INPUT, "py-1.5 pl-9 text-xs")}
          />
        </label>
        <div className="flex items-center gap-1" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={state.cluster === f.id}
              onClick={() => dispatch({ type: "cluster", cluster: f.id })}
              className={cn(
                "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                state.cluster === f.id ? "bg-white/10 text-[var(--d-ink)]" : "text-[var(--d-dim)] hover:text-[var(--d-ink)]"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-[var(--d-border)]/60 bg-[radial-gradient(ellipse_at_center,#131d33,#070b15)]">
        <SkyChart />

        <AnimatePresence>
          {selected && (
            <motion.aside
              key={selected.id}
              initial={reduced ? false : { opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduced ? undefined : { opacity: 0, x: 16 }}
              transition={{ duration: 0.22 }}
              className="absolute right-3 top-3 w-60 rounded-xl border border-[var(--d-border)] bg-[var(--d-card)]/95 p-3.5 shadow-xl backdrop-blur"
              aria-label={`${selected.name} details`}
            >
              <button
                type="button"
                aria-label="Close"
                onClick={() => dispatch({ type: "star", id: null })}
                className="absolute right-2 top-2 rounded-md p-1 text-[var(--d-dim)] hover:text-[var(--d-ink)]"
              >
                <X className="size-3.5" />
              </button>
              <div className="flex items-center gap-2.5">
                <Avatar person={selected} size={36} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[var(--d-ink)]">{selected.name}</p>
                  <p className="truncate text-[11px] text-[var(--d-dim)]">
                    {selected.title} · {selected.company}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <ClosenessChip closeness={closenessOf(state, selected)} />
                <TierBadge closeness={closenessOf(state, selected)} />
              </div>
              <p className="mt-2 text-[11px] text-[var(--d-dim)]">Last touch {daysLabel(lastTouchOf(state, selected))}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-[var(--d-ink)]/85">{selected.nextStep}</p>
              <button
                type="button"
                className={cn(BTN_PRIMARY, "mt-3 w-full")}
                onClick={() => dispatch({ type: "openProfile", id: selected.id })}
              >
                Open profile
              </button>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
