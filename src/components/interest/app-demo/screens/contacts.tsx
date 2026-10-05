"use client";

import { useState } from "react";
import { Building2, CalendarClock, ChevronDown, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { daysLabel, DEMO_PEOPLE } from "../demo-cast";
import { useDemo } from "../demo-context";
import { closenessOf, followUpOf, lastTouchOf, visibleContacts, type ContactsFilter } from "../demo-state";
import { Avatar, BTN, BTN_PRIMARY, CARD, ClosenessChip, DISPLAY, LinkedInGlyph, TierBadge } from "../demo-ui";

/**
 * The real contacts list (`app/…/contacts/page.tsx`, `contacts-filters.tsx`,
 * `contacts-list.tsx`): the header's actions and Contacts | Recruiters toggle, the pill search
 * with its Company and Strength chips, and rows with the LinkedIn, follow-up and delete
 * affordances. The A–Z scrubber is left out; the sticky letters are there.
 */
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
  const [menu, setMenu] = useState(false);
  const people = visibleContacts(state);
  const groups = new Map<string, typeof people>();
  for (const p of people) {
    const letter = p.name[0]!.toUpperCase();
    groups.set(letter, [...(groups.get(letter) ?? []), p]);
  }
  const strengthLabel = STRENGTHS.find((s) => s.n === state.strength)?.label ?? "Any";
  const icon = "inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground";

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div>
          <h2 className={cn(DISPLAY, "text-4xl")}>Contacts</h2>
          <p className="mt-1 text-muted-foreground">{DEMO_PEOPLE.length} people in your network</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Refresh
          </button>
          <button type="button" className={BTN}>AI capture</button>
          <button type="button" className={BTN_PRIMARY}>
            <Plus className="size-3.5" aria-hidden="true" />
            Add contact
          </button>
          <div className="flex items-center rounded-lg border border-border bg-muted/40 p-0.5 text-sm" role="group" aria-label="List">
            <span className="rounded-md bg-primary px-3 py-1 font-medium text-primary-foreground">Contacts</span>
            <span className="px-3 py-1 text-muted-foreground">Recruiters</span>
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex h-11 min-w-72 flex-1 items-center rounded-full border border-input bg-card pl-4 pr-2">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <label className="sr-only" htmlFor="demo-contacts-search">
            Search contacts
          </label>
          <input
            id="demo-contacts-search"
            data-demo-target="contacts-search"
            value={state.search}
            onChange={(e) => dispatch({ type: "search", q: e.target.value })}
            placeholder="Search contacts…"
            className="min-w-0 flex-1 bg-transparent px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            autoComplete="off"
          />
          <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          <span className="inline-flex items-center gap-1.5 px-2 text-sm text-muted-foreground">
            <Building2 className="size-3.5" aria-hidden="true" />
            Company
            <ChevronDown className="size-3" aria-hidden="true" />
          </span>
          <div className="relative">
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={menu}
              onClick={() => setMenu((m) => !m)}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-sm text-muted-foreground hover:text-ink"
            >
              Strength{state.strength > 0 ? `: ${strengthLabel}` : ""}
              <ChevronDown className="size-3" aria-hidden="true" />
            </button>
            {menu && (
              <ul role="listbox" aria-label="Strength" className="absolute right-0 top-full z-30 mt-2 w-28 rounded-xl border border-border bg-popover p-1 shadow-xl">
                {STRENGTHS.map((s) => (
                  <li key={s.n}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={state.strength === s.n}
                      onClick={() => {
                        dispatch({ type: "strength", n: s.n });
                        setMenu(false);
                      }}
                      className={cn(
                        "flex w-full items-center rounded-lg px-2.5 py-1.5 text-sm",
                        state.strength === s.n ? "bg-white/10 text-ink" : "text-muted-foreground hover:text-ink"
                      )}
                    >
                      {s.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {state.contactsFilter !== "all" && (
          <button
            type="button"
            onClick={() => dispatch({ type: "contactsFilter", filter: "all" })}
            className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary"
          >
            {FILTER_LABEL[state.contactsFilter]}
            <X className="size-3" aria-label="Clear filter" />
          </button>
        )}
      </div>

      <div className={cn(CARD, "overflow-hidden")}>
        {people.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">No one matches that. Try another name, company or tag.</p>
        )}
        {[...groups.entries()].map(([letter, list]) => (
          <div key={letter}>
            <p className="sticky top-0 z-10 border-b border-border/60 bg-card/95 px-5 py-1.5 text-xs font-semibold text-muted-foreground backdrop-blur">
              {letter}
            </p>
            <ul className="divide-y divide-border/60">
              {list.map((p) => {
                const c = closenessOf(state, p);
                const fu = followUpOf(state, p);
                return (
                  <li key={p.id} className="flex items-center gap-1 pr-3 transition-colors hover:bg-white/[0.03]">
                    <button
                      type="button"
                      data-demo-target={`contact-${p.id}`}
                      onClick={() => dispatch({ type: "openProfile", id: p.id })}
                      className="flex min-w-0 flex-1 items-center gap-3 px-5 py-3.5 text-left"
                    >
                      <Avatar person={p} size={44} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-ink">{p.name}</p>
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink/80">
                          <span className="truncate">
                            {p.title} at {p.company}
                          </span>
                          <TierBadge closeness={c} />
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {p.city} · Last touch {daysLabel(lastTouchOf(state, p))}
                          {fu !== null && fu < 0 && <span className="text-warning"> · Overdue</span>}
                        </p>
                      </div>
                      <ClosenessChip closeness={c} />
                    </button>
                    <span className="hidden items-center lg:flex">
                      <span className={icon} aria-hidden="true">
                        <LinkedInGlyph className="size-4" />
                      </span>
                      <span className={icon} aria-hidden="true">
                        <CalendarClock className="size-4" />
                      </span>
                      <span className={icon} aria-hidden="true">
                        <Trash2 className="size-4" />
                      </span>
                    </span>
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
