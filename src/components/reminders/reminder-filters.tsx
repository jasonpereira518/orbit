"use client";

import { forwardRef } from "react";
import { ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import type { ReminderActionKind } from "@/db/schema";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ReminderContactPicker } from "@/components/reminders/reminder-contact-picker";
import { ACTION_KIND_LABELS, REMINDER_ACTION_KINDS } from "@/lib/reminder-action-kind";
import {
  REMINDER_SOURCES,
  REMINDER_SOURCE_LABELS,
  type ReminderSource,
} from "@/lib/reminders-page";
import { cn } from "@/lib/utils";

export type QueueFilters = {
  q: string;
  kinds: ReminderActionKind[];
  sources: ReminderSource[];
  contact: { id: string; name: string } | null;
};

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * Search plus three filter chips in one pill — the /contacts search pill's shape, so the two
 * list pages read alike. Search text is local and debounced by the caller; chips apply on
 * change.
 */
export const ReminderFilters = forwardRef<
  HTMLInputElement,
  {
    filters: QueueFilters;
    onQChange: (q: string) => void;
    onChange: (patch: Partial<QueueFilters>) => void;
  }
>(function ReminderFilters({ filters, onQChange, onChange }, searchRef) {
  const kindActive = filters.kinds.length > 0;
  const sourceActive = filters.sources.length > 0;
  const kindLabel =
    filters.kinds.length === 1
      ? ACTION_KIND_LABELS[filters.kinds[0]]
      : filters.kinds.length > 1
        ? `${filters.kinds.length} types`
        : "Type";
  const sourceLabel =
    filters.sources.length === 1
      ? REMINDER_SOURCE_LABELS[filters.sources[0]]
      : filters.sources.length > 1
        ? `${filters.sources.length} sources`
        : "Source";
  const anyChip = kindActive || sourceActive || Boolean(filters.contact);

  const chip = (active: boolean) =>
    cn(
      "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors",
      active
        ? "bg-primary/10 text-primary"
        : "text-muted-foreground hover:bg-muted hover:text-foreground"
    );

  return (
    <div
      role="search"
      className={cn(
        "flex h-10 w-full min-w-0 items-center gap-1 rounded-full border border-border/70 bg-card pl-3 pr-1 shadow-sm",
        "focus-within:border-primary/40 focus-within:ring-[3px] focus-within:ring-primary/15"
      )}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={searchRef}
        type="text"
        value={filters.q}
        onChange={(e) => onQChange(e.target.value)}
        onKeyDown={(e) => {
          // Escape clears, then leaves — back to the queue, where the shortcuts live.
          if (e.key === "Escape") {
            if (filters.q) onQChange("");
            else e.currentTarget.blur();
          }
        }}
        placeholder="Search reminders…"
        aria-label="Search reminders"
        aria-keyshortcuts="/"
        autoComplete="off"
        className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      {filters.q ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="tap-target relative"
          aria-label="Clear search"
          onClick={() => onQChange("")}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
      <div className="mx-0.5 h-5 w-px shrink-0 bg-border/80" />

      {/* On a phone the three chips collapse into one menu; the contact chip keeps its own
          popover either way, because a type-ahead doesn't fit inside a menu. */}
      <div className="hidden items-center gap-0.5 sm:flex">
        <DropdownMenu>
          <DropdownMenuTrigger className={chip(kindActive)}>
            {kindLabel}
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>Action type</DropdownMenuLabel>
            {REMINDER_ACTION_KINDS.map((k) => (
              <DropdownMenuCheckboxItem
                key={k}
                checked={filters.kinds.includes(k)}
                onCheckedChange={() => onChange({ kinds: toggle(filters.kinds, k) })}
              >
                {ACTION_KIND_LABELS[k]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger className={chip(sourceActive)}>
            {sourceLabel}
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>Where it came from</DropdownMenuLabel>
            {REMINDER_SOURCES.map((s) => (
              <DropdownMenuCheckboxItem
                key={s}
                checked={filters.sources.includes(s)}
                onCheckedChange={() => onChange({ sources: toggle(filters.sources, s) })}
              >
                {REMINDER_SOURCE_LABELS[s]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="sm:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Filters"
            className={chip(kindActive || sourceActive)}
          >
            <SlidersHorizontal className="size-3.5" />
            {kindActive || sourceActive ? filters.kinds.length + filters.sources.length : null}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Action type</DropdownMenuLabel>
            {REMINDER_ACTION_KINDS.map((k) => (
              <DropdownMenuCheckboxItem
                key={k}
                checked={filters.kinds.includes(k)}
                onCheckedChange={() => onChange({ kinds: toggle(filters.kinds, k) })}
              >
                {ACTION_KIND_LABELS[k]}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Where it came from</DropdownMenuLabel>
            {REMINDER_SOURCES.map((s) => (
              <DropdownMenuCheckboxItem
                key={s}
                checked={filters.sources.includes(s)}
                onCheckedChange={() => onChange({ sources: toggle(filters.sources, s) })}
              >
                {REMINDER_SOURCE_LABELS[s]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ReminderContactPicker
        value={filters.contact}
        onChange={(contact) => onChange({ contact })}
        placeholder="Person"
        align="end"
        triggerClassName={cn(
          chip(Boolean(filters.contact)),
          "h-7 max-w-36 border-0 bg-transparent",
          filters.contact && "bg-primary/10 hover:bg-primary/15"
        )}
      />
      {anyChip && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="tap-target relative"
          aria-label="Clear filters"
          title="Clear filters"
          onClick={() => onChange({ kinds: [], sources: [], contact: null })}
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  );
});
