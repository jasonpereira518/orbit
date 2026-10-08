"use client";

import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import type { YouField } from "@/lib/career-profile";
import { cn } from "@/lib/utils";

/**
 * The review for the LinkedIn files about the user: what Orbit holds now beside what the file
 * says, one tickable row per field. The people review's counterpart — same selection plumbing
 * (`QueuedImport.ids`), but the "rows" are fields and the value is a before/after.
 */
export function ImportYouReview({
  fields,
  selected,
  onChange,
}: {
  fields: YouField[];
  selected: ReadonlySet<string>;
  onChange: (next: string[]) => void;
}) {
  const base = useId();

  function toggle(key: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    onChange([...next]);
  }

  return (
    <ul className="divide-y divide-border/50 rounded-xl border border-border/60">
      {fields.map((field) => {
        const checked = selected.has(field.key);
        const id = `${base}-${field.key}`;
        return (
          <li key={field.key} className={cn("flex gap-3 px-3 py-2.5", !checked && "opacity-60")}>
            <Checkbox
              id={id}
              checked={checked}
              onCheckedChange={(v) => toggle(field.key, v === true)}
              className="mt-0.5"
            />
            <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer space-y-1 text-sm">
              <span className="block font-medium text-ink">{field.label}</span>
              <span className="block text-xs text-muted-foreground">
                Orbit has: {field.before ?? "nothing yet"}
              </span>
              <span className="block break-words text-xs">LinkedIn has: {field.after}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
