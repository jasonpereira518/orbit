"use client";

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

  function toggle(id: string, checked: boolean) {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectedIdsChange(next);
  }

  function selectAll(checked: boolean) {
    if (checked) onSelectedIdsChange(new Set(people.map((p) => p.id)));
    else onSelectedIdsChange(new Set());
  }

  if (people.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {selectedCount} of {people.length} selected
          {repeatCount > 0 ? ` · ${repeatCount} repeat connection${repeatCount === 1 ? "" : "s"}` : ""}
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

      <div className="max-h-[28rem] overflow-auto rounded-xl border border-border/60">
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
          {people.map((person) => {
            const checked = selectedIds.has(person.id);
            return (
              <li
                key={person.id}
                className={cn(
                  "flex items-center gap-3 border-t border-border/50 px-3 py-2.5 text-sm",
                  !checked && "opacity-55"
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(v) => toggle(person.id, v === true)}
                  aria-label={`Select ${person.name}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-primary">
                    {person.name}
                  </p>
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
                      <Badge variant="secondary">Repeat connection</Badge>
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
          })}
        </ul>
      </div>
    </div>
  );
}
