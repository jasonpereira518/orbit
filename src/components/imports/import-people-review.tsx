"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export type ReviewPerson = {
  id: string;
  name: string;
  subtitle?: string;
  isRepeat: boolean;
  repeatReason?: string | null;
  meta?: string;
};

/**
 * Rows mounted at first, and added each time the list is scrolled near its end.
 *
 * A LinkedIn export can be tens of thousands of people, and this list used to mount a row
 * with a checkbox for every one of them at once, then re-render all of them on every toggle.
 * The counts and Select all still cover everyone; only the DOM is windowed.
 */
const RENDER_CHUNK = 200;

export function ImportPeopleReview({
  people,
  selectedIds,
  onSelectedIdsChange,
  onRemove,
  emptyLabel = "No people left to import.",
}: {
  people: ReviewPerson[];
  selectedIds: Set<string>;
  onSelectedIdsChange: (next: Set<string>) => void;
  onRemove: (id: string) => void;
  emptyLabel?: string;
}) {
  const selectedCount = people.filter((p) => selectedIds.has(p.id)).length;
  const allSelected = people.length > 0 && selectedCount === people.length;
  const repeatCount = people.filter((p) => p.isRepeat).length;

  // Read through refs so `toggle` keeps one identity across renders: with a new function per
  // selection change, every memoised row would re-render on every click.
  const selectedRef = useRef(selectedIds);
  const onChangeRef = useRef(onSelectedIdsChange);
  const onRemoveRef = useRef(onRemove);
  useEffect(() => {
    selectedRef.current = selectedIds;
    onChangeRef.current = onSelectedIdsChange;
    onRemoveRef.current = onRemove;
  });

  const toggle = useCallback((id: string, checked: boolean) => {
    const next = new Set(selectedRef.current);
    if (checked) next.add(id);
    else next.delete(id);
    onChangeRef.current(next);
  }, []);
  const remove = useCallback((id: string) => onRemoveRef.current(id), []);

  function selectAll(checked: boolean) {
    if (checked) onSelectedIdsChange(new Set(people.map((p) => p.id)));
    else onSelectedIdsChange(new Set());
  }

  const [rendered, setRendered] = useState(RENDER_CHUNK);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);
  const moreToRender = rendered < people.length;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !moreToRender) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setRendered((n) => n + RENDER_CHUNK);
      },
      { root: scrollerRef.current, rootMargin: "400px 0px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [moreToRender, rendered]);

  if (people.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {selectedCount} of {people.length} selected
          {repeatCount > 0 ? ` · ${repeatCount} already in your network` : ""}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => selectAll(true)}
          >
            Select all
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => selectAll(false)}
          >
            Deselect all
          </Button>
        </div>
      </div>

      <div ref={scrollerRef} className="max-h-[28rem] overflow-auto rounded-xl border border-border/60">
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border/60 bg-muted/80 px-3 py-2 text-xs font-medium backdrop-blur">
          <Checkbox
            checked={allSelected}
            onCheckedChange={(v) => selectAll(v === true)}
            aria-label="Select all people"
          />
          <span className="flex-1">Person</span>
          <span className="w-36 text-right sm:w-44">Status</span>
          <span className="w-8" />
        </div>

        <ul>
          {people.slice(0, rendered).map((person) => (
            <ReviewRow
              key={person.id}
              person={person}
              checked={selectedIds.has(person.id)}
              onToggle={toggle}
              onRemove={remove}
            />
          ))}
          {moreToRender ? (
            <li ref={sentinelRef} className="border-t border-border/50 px-3 py-2.5 text-center text-xs text-muted-foreground">
              Showing {rendered.toLocaleString()} of {people.length.toLocaleString()}. Scroll for more.
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

const ReviewRow = memo(function ReviewRow({
  person,
  checked,
  onToggle,
  onRemove,
}: {
  person: ReviewPerson;
  checked: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-3 border-t border-border/50 px-3 py-2.5 text-sm",
        !checked && "opacity-55",
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onToggle(person.id, v === true)}
        aria-label={`Select ${person.name}`}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-ink">{person.name}</p>
        {person.subtitle ? (
          <p className="truncate text-xs text-muted-foreground">
            {person.subtitle}
          </p>
        ) : null}
        {person.meta ? (
          <p className="truncate text-xs text-muted-foreground">
            {person.meta}
          </p>
        ) : null}
      </div>
      <div className="w-36 shrink-0 text-right sm:w-44">
        {person.isRepeat ? (
          <div className="flex flex-col items-end gap-0.5">
            <Badge variant="secondary">Already in orbit</Badge>
            {person.repeatReason ? (
              <span className="text-[10px] text-muted-foreground">
                {person.repeatReason}
              </span>
            ) : null}
          </div>
        ) : (
          <Badge variant="outline">New</Badge>
        )}
      </div>
      <button
        type="button"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={`Remove ${person.name}`}
        onClick={() => onRemove(person.id)}
      >
        <X className="size-4" />
      </button>
    </li>
  );
});
