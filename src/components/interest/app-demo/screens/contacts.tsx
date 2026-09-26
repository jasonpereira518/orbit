"use client";

import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { daysLabel, dueLabel, DEMO_PEOPLE } from "../demo-cast";
import { useDemo } from "../demo-context";
import { closenessOf, followUpOf, lastTouchOf, visibleContacts, type ContactsFilter } from "../demo-state";
import { Avatar, CARD, ClosenessChip, DISPLAY, INPUT, TierBadge } from "../demo-ui";

const FILTER_LABEL: Record<Exclude<ContactsFilter, "all">, string> = {
  due: "Due follow-ups",
  inner: "Strong ties",
  reminders: "Has a follow-up",
};

const STRENGTHS = [
  { n: 0, label: "Any" },
  { n: 2, label: "2+" },
  { n: 3, label: "3+" },
  { n: 4, label: "4+" },
  { n: 5, label: "5" },
];

export function ContactsScreen() {
  const { state, dispatch } = useDemo();
  const people = visibleContacts(state);
  const groups = new Map<string, typeof people>();
  for (const p of people) {
    const letter = p.name[0]!.toUpperCase();
    groups.set(letter, [...(groups.get(letter) ?? []), p]);
  }

  return (
    <div className="space-y-4">
      <header>
        <h2 className={cn(DISPLAY, "text-3xl")}>Contacts</h2>
        <p className="mt-1 text-sm text-[var(--d-dim)]">{DEMO_PEOPLE.length} people in your network</p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-56 flex-1">
          <span className="sr-only">Search contacts</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--d-dim)]" aria-hidden="true" />
          <input
            data-demo-target="contacts-search"
            value={state.search}
            onChange={(e) => dispatch({ type: "search", q: e.target.value })}
            placeholder="Search contacts…"
            className={cn(INPUT, "pl-9")}
          />
        </label>
        <div className="flex items-center gap-1 rounded-lg border border-[var(--d-border)] bg-[var(--d-muted)] p-1" role="group" aria-label="Strength">
          <span className="px-1.5 text-[11px] text-[var(--d-dim)]">Strength</span>
          {STRENGTHS.map((s) => (
            <button
              key={s.n}
              type="button"
              aria-pressed={state.strength === s.n}
              onClick={() => dispatch({ type: "strength", n: s.n })}
              className={cn(
                "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                state.strength === s.n ? "bg-white/10 text-[var(--d-ink)]" : "text-[var(--d-dim)] hover:text-[var(--d-ink)]"
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        {state.contactsFilter !== "all" && (
          <button
            type="button"
            onClick={() => dispatch({ type: "contactsFilter", filter: "all" })}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--d-primary)]/15 px-2.5 py-1 text-[11px] font-medium text-[var(--d-primary)]"
          >
            {FILTER_LABEL[state.contactsFilter]}
            <X className="size-3" aria-label="Clear filter" />
          </button>
        )}
      </div>

      <div className={cn(CARD, "overflow-hidden")}>
        {people.length === 0 && (
          <p className="p-8 text-center text-sm text-[var(--d-dim)]">No one matches that. Try another name, company or tag.</p>
        )}
        {[...groups.entries()].map(([letter, list]) => (
          <div key={letter}>
            <p className="sticky top-0 z-10 border-b border-[var(--d-border)]/50 bg-[var(--d-card)]/95 px-4 py-1 text-[11px] font-semibold text-[var(--d-dim)] backdrop-blur">
              {letter}
            </p>
            <ul className="divide-y divide-[var(--d-border)]/40">
              {list.map((p) => {
                const c = closenessOf(state, p);
                const fu = followUpOf(state, p);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      data-demo-target={`contact-${p.id}`}
                      onClick={() => dispatch({ type: "openProfile", id: p.id })}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.03]"
                    >
                      <Avatar person={p} size={34} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-[var(--d-ink)]">{p.name}</p>
                          <TierBadge closeness={c} />
                        </div>
                        <p className="truncate text-xs text-[var(--d-dim)]">
                          {p.title} · {p.company}
                        </p>
                        <p className="text-[11px] text-[var(--d-dim)]">
                          Last touch {daysLabel(lastTouchOf(state, p))}
                          {fu !== null && fu < 0 && <span className="text-amber-300"> · Overdue</span>}
                        </p>
                      </div>
                      {fu !== null && (
                        <span
                          className={cn(
                            "hidden rounded-full border px-2 py-0.5 text-[10px] font-medium lg:inline",
                            fu < 0 ? "border-amber-300/40 text-amber-200" : "border-[var(--d-border)] text-[var(--d-dim)]"
                          )}
                        >
                          {dueLabel(fu)}
                        </span>
                      )}
                      <ClosenessChip closeness={c} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
