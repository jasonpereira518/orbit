"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronRight, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { EASE_HOUSE } from "@/lib/motion";
import { dueLabel, personById } from "../demo-cast";
import { useDemo } from "../demo-context";
import { activeSuggestions, dueList, stats, type ContactsFilter } from "../demo-state";
import { Avatar, BTN, BTN_PRIMARY, CARD, DISPLAY, ReasonPill } from "../demo-ui";
import { SkyChart } from "../sky-chart";

export function DashboardScreen() {
  const { state, dispatch, reduced } = useDemo();
  const s = stats(state);
  const suggestions = activeSuggestions(state);
  const due = dueList(state);

  const cards: { label: string; value: number; hint: string; filter: ContactsFilter }[] = [
    { label: "Contacts", value: s.contacts, hint: "People in your network", filter: "all" },
    { label: "Due follow-ups", value: s.due, hint: "Needs attention", filter: "due" },
    { label: "Strong ties", value: s.strong, hint: "Close + warm", filter: "inner" },
    { label: "Reminders", value: s.reminders, hint: "Follow-ups set", filter: "reminders" },
  ];

  return (
    <div className="space-y-6">
      <header>
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--d-primary)]">Your network</p>
        <h2 className={cn(DISPLAY, "mt-1 text-3xl")}>Stay in orbit</h2>
        <p className="mt-1.5 max-w-xl text-sm text-[var(--d-dim)]">
          Follow-ups, dormant connections, and people worth reaching out to — in one place.
        </p>
      </header>

      <div className="grid grid-cols-4 gap-3">
        {cards.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={() => dispatch({ type: "go", screen: "contacts", filter: c.filter })}
            className={cn(CARD, "p-4 text-left transition-colors hover:border-[var(--d-primary)]/40")}
          >
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--d-dim)]">{c.label}</p>
            <p className={cn(DISPLAY, "mt-1 text-3xl tabular-nums")}>{c.value}</p>
            <p className="mt-0.5 text-[11px] text-[var(--d-dim)]">{c.hint}</p>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-4">
        <section className={cn(CARD, "col-span-3 p-4")} aria-labelledby="demo-suggested">
          <div className="flex items-center justify-between">
            <h3 id="demo-suggested" className="flex items-center gap-2 text-sm font-medium text-[var(--d-ink)]">
              <Sparkles className="size-4 text-amber-300" aria-hidden="true" />
              Suggested outreach
            </h3>
            <span className="text-[11px] text-[var(--d-dim)]">Ranked by Orbit</span>
          </div>
          <ul className="mt-3 space-y-2">
            <AnimatePresence initial={false}>
              {suggestions.map((sg) => {
                const p = personById(sg.personId)!;
                return (
                  <motion.li
                    key={sg.personId}
                    layout={!reduced}
                    initial={false}
                    exit={reduced ? undefined : { opacity: 0, height: 0, marginTop: 0 }}
                    transition={{ duration: 0.28, ease: EASE_HOUSE }}
                    className="overflow-hidden"
                  >
                    <div
                      data-demo-target={`suggestion-${p.id}`}
                      className="rounded-xl border border-[var(--d-border)]/60 bg-[var(--d-card)] p-3"
                    >
                      <div className="flex items-start gap-3">
                        <Avatar person={p} size={34} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium text-[var(--d-ink)]">Reach out to {p.name}</p>
                            <ReasonPill reason={sg.reason} />
                          </div>
                          <p className="text-xs text-[var(--d-dim)]">
                            {p.title} · {p.company}
                          </p>
                          <p className="mt-1 text-xs text-[var(--d-ink)]/85">{sg.why}</p>
                          <div className="mt-2.5 flex flex-wrap gap-2">
                            <button
                              type="button"
                              className={BTN}
                              onClick={() => dispatch({ type: "setFollowUp", id: p.id, days: 7 })}
                            >
                              Set follow-up
                            </button>
                            <button
                              type="button"
                              data-demo-target={`suggest-open-${p.id}`}
                              className={BTN_PRIMARY}
                              onClick={() => dispatch({ type: "openProfile", id: p.id })}
                            >
                              Open contact
                            </button>
                          </div>
                        </div>
                        <button
                          type="button"
                          aria-label={`Dismiss ${p.name}`}
                          className="rounded-md p-1 text-[var(--d-dim)] hover:bg-white/5 hover:text-[var(--d-ink)]"
                          onClick={() => dispatch({ type: "dismiss", id: p.id })}
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
          {suggestions.length === 0 && (
            <p className="mt-3 rounded-xl border border-dashed border-[var(--d-border)] p-4 text-center text-xs text-[var(--d-dim)]">
              Nobody has gone quiet. Log an interaction and Orbit will keep watching.
            </p>
          )}
        </section>

        <div className="col-span-2 space-y-4">
          <section className={cn(CARD, "p-4")} aria-labelledby="demo-due">
            <h3 id="demo-due" className="text-sm font-medium text-[var(--d-ink)]">
              Due follow-ups
            </h3>
            <ul className="mt-2.5 space-y-1.5">
              {due.map(({ p, days }) => (
                <li key={p.id} className="flex items-center gap-2.5 rounded-lg px-1 py-1">
                  <button
                    type="button"
                    aria-label={`Mark ${p.name}'s follow-up done`}
                    onClick={() => dispatch({ type: "completeFollowUp", id: p.id })}
                    className="group inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border border-[var(--d-border)] hover:border-emerald-300"
                  >
                    <Check className="size-3 text-emerald-300 opacity-0 group-hover:opacity-100" />
                  </button>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    onClick={() => dispatch({ type: "openProfile", id: p.id })}
                  >
                    <Avatar person={p} size={28} />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-[var(--d-ink)]">
                        {state.followUps[p.id] !== undefined ? `Catch up with ${p.name.split(" ")[0]}` : p.followUpLabel ?? `Catch up with ${p.name}`}
                      </span>
                      <span className="block truncate text-[11px] text-[var(--d-dim)]">{p.name}</span>
                    </span>
                  </button>
                  <span className={cn("shrink-0 text-[10px] font-medium", days < 0 ? "text-amber-300" : "text-[var(--d-dim)]")}>
                    {dueLabel(days)}
                  </span>
                </li>
              ))}
              {due.length === 0 && <li className="py-2 text-xs text-[var(--d-dim)]">All caught up.</li>}
            </ul>
          </section>

          <button
            type="button"
            onClick={() => dispatch({ type: "go", screen: "constellation" })}
            className={cn(CARD, "group block w-full overflow-hidden p-0 text-left")}
          >
            <div className="flex items-center justify-between px-4 pt-3">
              <span className="text-sm font-medium text-[var(--d-ink)]">Constellation preview</span>
              <ChevronRight className="size-4 text-[var(--d-dim)] transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </div>
            <div className="h-[132px] px-2 pb-2">
              <SkyChart mini />
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
