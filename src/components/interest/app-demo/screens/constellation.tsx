"use client";

import { AnimatePresence, motion } from "motion/react";
import { Filter, Home, KeyRound, Maximize2, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CLUSTERS, daysLabel, personById, type ClusterId } from "../demo-cast";
import { useDemo } from "../demo-context";
import { closenessOf, lastTouchOf } from "../demo-state";
import { Avatar, BTN_PRIMARY, ClosenessChip, DISPLAY, TierBadge } from "../demo-ui";
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
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-primary">Star chart</p>
        <h2 className={cn(DISPLAY, "mt-1 text-3xl")}>Constellation</h2>
        <p className="mt-1.5 max-w-xl text-muted-foreground">
          You are the sun. Companies and schools form constellations around you — each figure traced by its own people.
        </p>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/10 bg-[#03050a]">
        {/* The stage's controls, as the app lays them over the sky (`network-graph.tsx`). */}
        <div className="absolute inset-x-3 top-3 z-10 flex items-center gap-2">
          <span className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-card/80 px-3 text-sm text-ink backdrop-blur">
            <Sparkles className="size-3.5" aria-hidden="true" />
            Clusters
            <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{Object.keys(CLUSTERS).length}</span>
          </span>
          <label className="relative flex h-9 min-w-40 flex-1 items-center rounded-lg border border-border bg-card/80 pl-3 backdrop-blur">
            <span className="sr-only">Search the sky</span>
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              value={state.skyQuery}
              onChange={(e) => dispatch({ type: "skyQuery", q: e.target.value })}
              placeholder="Search name, role, school, keywords…"
              className="min-w-0 flex-1 bg-transparent px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              autoComplete="off"
            />
          </label>
          <div className="flex items-center gap-1 rounded-full border border-border bg-card/80 p-0.5 backdrop-blur" role="group" aria-label="Show">
            <Filter className="ml-2 size-3.5 text-muted-foreground" aria-hidden="true" />
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={state.cluster === f.id}
                onClick={() => dispatch({ type: "cluster", cluster: f.id })}
                className={cn(
                  "rounded-full px-2 py-1 text-xs font-medium transition-colors",
                  state.cluster === f.id ? "bg-white/10 text-ink" : "text-muted-foreground hover:text-ink"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-card/80 text-ink backdrop-blur" role="img" aria-label="Refresh">
            <RefreshCw className="size-3.5" aria-hidden="true" />
          </span>
        </div>
        <span className="absolute bottom-3 left-3 z-10 inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-card/80 px-3 text-sm text-ink backdrop-blur">
          <KeyRound className="size-3.5" aria-hidden="true" />
          Key
        </span>
        <span className="absolute bottom-3 right-3 z-10 flex gap-2">
          {[Maximize2, Home].map((Icon, k) => (
            <span key={k} className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-card/80 text-muted-foreground backdrop-blur" aria-hidden="true">
              <Icon className="size-4" />
            </span>
          ))}
        </span>
        <div className="absolute inset-0 pb-12 pt-12">
        <SkyChart />
        </div>

        <AnimatePresence>
          {selected && (
            <motion.aside
              key={selected.id}
              data-demo-target="star-card"
              initial={reduced ? false : { opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduced ? undefined : { opacity: 0, x: 16 }}
              transition={{ duration: 0.22 }}
              className="absolute right-3 top-16 z-20 w-60 rounded-xl border border-border bg-card/95 p-3.5 shadow-xl backdrop-blur"
              aria-label={`${selected.name} details`}
            >
              <button
                type="button"
                aria-label="Close"
                onClick={() => dispatch({ type: "star", id: null })}
                className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
              <div className="flex items-center gap-2.5">
                <Avatar person={selected} size={36} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{selected.name}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {selected.title} · {selected.company}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <ClosenessChip closeness={closenessOf(state, selected)} />
                <TierBadge closeness={closenessOf(state, selected)} />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">Last touch {daysLabel(lastTouchOf(state, selected))}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink/85">{selected.nextStep}</p>
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
