"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

export type ProductTab = {
  id: string;
  label: string;
  /** Shown as a small warning count, e.g. how many surfaces in the tab are hidden. */
  flagged?: number;
  /** Tooltip noun for the count, e.g. "hidden" or "failing". Defaults to "hidden". */
  flaggedTitle?: string;
  content: React.ReactNode;
};

/**
 * The product console's sections, one at a time.
 *
 * Eight stacked panels meant scrolling past the constellation filter to reach the page
 * list. Panels stay mounted (hidden, not unmounted) so an unsaved threshold or an in-flight
 * save survives a tab switch, and the content is server-rendered and handed in, so picking a
 * tab costs no fetch.
 */
export function ProductTabs({
  tabs,
  initial,
  value,
  onValueChange,
}: {
  tabs: ProductTab[];
  initial?: string;
  /** Controlled mode, for a parent that switches tabs itself (the health status banner). */
  value?: string;
  onValueChange?: (id: string) => void;
}) {
  const [inner, setInner] = useState(initial ?? tabs[0]?.id);
  const active = value ?? inner;
  const setActive = (id: string) => {
    setInner(id);
    onValueChange?.(id);
  };

  return (
    <div>
      <div
        role="tablist"
        aria-label="Product sections"
        className="relative mb-4 flex gap-1 overflow-x-auto [scrollbar-width:none]"
      >
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-border/60" />
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`product-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`product-panel-${tab.id}`}
              onClick={() => setActive(tab.id)}
              className={cn(
                "relative flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors",
                selected
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
              {tab.flagged ? (
                <span
                  className="rounded-full bg-destructive/12 px-1.5 text-[0.6875rem] tabular-nums text-destructive"
                  title={`${tab.flagged} ${tab.flaggedTitle ?? "hidden"}`}
                >
                  {tab.flagged}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`product-panel-${tab.id}`}
          aria-labelledby={`product-tab-${tab.id}`}
          hidden={tab.id !== active}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
