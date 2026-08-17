"use client";

import { useState } from "react";
import { CalendarClock, ChevronDown, ChevronUp } from "lucide-react";
import type { SuggestionReviewItem } from "@/components/chat/bulk-notes-panel";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type ReviewablePerson = { key: string; name: string };

export function SuggestedRemindersReview({
  items,
  people,
  onChange,
  skipped,
}: {
  items: SuggestionReviewItem[];
  /** Accepted people from this same capture, for the contact picker. */
  people: ReviewablePerson[];
  onChange: (next: SuggestionReviewItem[]) => void;
  skipped?: { relative: number; unverifiable: number; past: number } | null;
}) {
  if (!items.length) {
    return <SkippedNote skipped={skipped} />;
  }

  function update(index: number, patch: Partial<SuggestionReviewItem>) {
    onChange(items.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }

  const checkedCount = items.filter((i) => i.checked).length;

  return (
    <div className="space-y-3 rounded-2xl border border-amber-500/30 bg-amber-500/[0.04] p-4">
      <div className="flex items-center gap-2">
        <CalendarClock className="size-4 text-amber-600 dark:text-amber-300" />
        <h3 className="text-sm font-medium text-foreground">
          Dates found in these notes
        </h3>
        <span className="text-xs text-muted-foreground">
          {checkedCount} of {items.length} selected
        </span>
      </div>

      <ul className="space-y-2">
        {items.map((item, index) => (
          <li
            key={item.key}
            className="space-y-2 rounded-xl border border-border/60 bg-card p-3"
          >
            <div className="flex items-start gap-2">
              <Checkbox
                checked={item.checked}
                onCheckedChange={(v) => update(index, { checked: Boolean(v) })}
                aria-label={`Include ${item.title}`}
                className="mt-1"
              />
              <div className="min-w-0 flex-1 space-y-2">
                <Input
                  value={item.title}
                  onChange={(e) => update(index, { title: e.target.value })}
                  aria-label="Reminder title"
                />

                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Date</Label>
                    <Input
                      type="date"
                      value={item.dueDateIso}
                      onChange={(e) =>
                        update(index, { dueDateIso: e.target.value })
                      }
                      className={cn(
                        item.yearInferred && "ring-1 ring-amber-500/50"
                      )}
                    />
                    {item.yearInferred && (
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        Year not stated — assumed{" "}
                        {item.dueDateIso.slice(0, 4)}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      Contact
                    </Label>
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      value={item.personNameOverride ?? ""}
                      onChange={(e) =>
                        update(index, {
                          personNameOverride: e.target.value || null,
                        })
                      }
                    >
                      <option value="">
                        {item.personName
                          ? `Match by name (${item.personName})`
                          : "No contact"}
                      </option>
                      {people.map((p) => (
                        <option key={p.key} value={p.name}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <SourceLine item={item} />
              </div>
            </div>
          </li>
        ))}
      </ul>

      <SkippedNote skipped={skipped} />
    </div>
  );
}

function SourceLine({ item }: { item: SuggestionReviewItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronUp className="size-3" />
        ) : (
          <ChevronDown className="size-3" />
        )}
        from &ldquo;{item.rawDatePhrase}&rdquo;
      </button>
      {open && (
        <p className="rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground">
          {item.sourceExcerpt}
        </p>
      )}
    </div>
  );
}

/**
 * Surfaces what the extractor threw away, so the absolute-dates-only rule is visible
 * rather than looking like the AI simply missed things.
 */
function SkippedNote({
  skipped,
}: {
  skipped?: { relative: number; unverifiable: number; past: number } | null;
}) {
  if (!skipped) return null;
  const parts: string[] = [];
  if (skipped.relative) {
    parts.push(
      `${skipped.relative} relative ${skipped.relative === 1 ? "date" : "dates"} ("next Tuesday")`
    );
  }
  if (skipped.past) {
    parts.push(`${skipped.past} past ${skipped.past === 1 ? "date" : "dates"}`);
  }
  if (skipped.unverifiable) {
    parts.push(`${skipped.unverifiable} unverified`);
  }
  if (!parts.length) return null;

  return (
    <p className="text-xs text-muted-foreground">
      Skipped {parts.join(", ")}. Orbit only schedules dates written out in full.
    </p>
  );
}
