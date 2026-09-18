"use client";

/**
 * The reminders a capture will create, before it creates them.
 *
 * Two groups, deliberately not one list. Dated commitments are things the notes SAID, and
 * they arrive ticked. Implied next steps are things Orbit inferred, and — unless they clear
 * the higher auto-tick bar in `review-reducer.ts` — they arrive unticked under their own
 * heading that says so. Reading the two in a single list invites somebody to treat an
 * inference as something they were told, which is the failure this split exists to prevent.
 */

import { useState } from "react";
import { CalendarClock, ChevronDown, ChevronUp, Lightbulb } from "lucide-react";
import type { SuggestionReviewItem } from "@/components/chat/bulk-notes-panel";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePickerButton } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { shortDayLabel } from "@/lib/reminder-due-bucket";
import { cn } from "@/lib/utils";
import type { RejectedCounts } from "@/lib/date-commitment-extract";
import { skippedNoteText } from "@/lib/capture/skipped-note";

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
  skipped?: RejectedCounts | null;
}) {
  if (!items.length) {
    return <SkippedNote skipped={skipped} />;
  }

  /**
   * Patches by KEY rather than by index. The list is rendered in two slices, so an index
   * into either one is not an index into `items` — patching by position would edit the
   * wrong row the moment a note produced both kinds.
   */
  function update(key: string, patch: Partial<SuggestionReviewItem>) {
    onChange(items.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  const checkedCount = items.filter((i) => i.checked).length;
  const explicit = items.filter((i) => i.origin !== "implied");
  const implied = items.filter((i) => i.origin === "implied");

  return (
    <div className="space-y-3 rounded-2xl border border-amber-500/30 bg-amber-500/[0.04] p-4">
      <div className="flex items-center gap-2">
        <CalendarClock className="size-4 text-amber-600 dark:text-amber-300" />
        <h3 className="text-sm font-medium text-foreground">
          Reminders that will be created
        </h3>
        <span className="text-xs text-muted-foreground">
          {checkedCount} of {items.length} selected
        </span>
      </div>

      {explicit.length > 0 && (
        <ul className="space-y-2">
          {explicit.map((item) => (
            <ReminderRow key={item.key} item={item} people={people} update={update} />
          ))}
        </ul>
      )}

      {implied.length > 0 && (
        <div className="space-y-2 rounded-xl border border-border/60 bg-background/40 p-3">
          <div className="flex items-center gap-2">
            <Lightbulb className="size-4 text-muted-foreground" />
            <h4 className="text-sm font-medium text-foreground">
              Suggested from the discussion
            </h4>
          </div>
          {/* Saying this plainly is what makes an unticked block read as an offer rather
              than as something Orbit failed to do. */}
          <p className="text-xs text-muted-foreground">
            Nobody said these — Orbit inferred them from what you wrote. Tick the ones that
            are right.
          </p>
          <ul className="space-y-2">
            {implied.map((item) => (
              <ReminderRow key={item.key} item={item} people={people} update={update} />
            ))}
          </ul>
        </div>
      )}

      <SkippedNote skipped={skipped} />
    </div>
  );
}

function ReminderRow({
  item,
  people,
  update,
}: {
  item: SuggestionReviewItem;
  people: ReviewablePerson[];
  update: (key: string, patch: Partial<SuggestionReviewItem>) => void;
}) {
  return (
    <li className="space-y-2 rounded-xl border border-border/60 bg-card p-3">
      <div className="flex items-start gap-2">
        <Checkbox
          checked={item.checked}
          onCheckedChange={(v) => update(item.key, { checked: Boolean(v) })}
          aria-label={`Include ${item.title}`}
          className="mt-1"
        />
        <div className="min-w-0 flex-1 space-y-2">
          <Input
            value={item.title}
            onChange={(e) => update(item.key, { title: e.target.value })}
            aria-label="Reminder title"
          />

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Date</Label>
              <DatePickerButton
                value={item.dueDateIso}
                onSelect={(ymd) => update(item.key, { dueDateIso: ymd })}
                label={item.dueDateIso ? shortDayLabel(item.dueDateIso) : "Pick a date"}
                className={cn("w-full justify-start font-normal", item.yearInferred && "ring-1 ring-amber-500/50")}
              />
              {item.yearInferred && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  Year not stated — assumed {item.dueDateIso.slice(0, 4)}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Contact</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={item.personNameOverride ?? ""}
                onChange={(e) =>
                  update(item.key, { personNameOverride: e.target.value || null })
                }
              >
                <option value="">
                  {item.personName ? `Match by name (${item.personName})` : "No contact"}
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
  );
}

function SourceLine({ item }: { item: SuggestionReviewItem }) {
  const [open, setOpen] = useState(false);
  const implied = item.origin === "implied";
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronUp className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
        {/* An implied step has no date phrase to quote — nobody named a date. The rationale
            takes the slot instead, which is the only answer to "why is this here at all". */}
        {implied
          ? item.rationale || "inferred from what you wrote"
          : `from “${item.rawDatePhrase ?? ""}”`}
      </button>
      {!implied && item.dateBasis !== "absolute" && (
        <span className="text-[11px] text-muted-foreground">
          {" "}
          · counted from {item.anchorIso}
          {item.dateBasis === "vague" ? " (no date given, default 2 weeks)" : ""}
        </span>
      )}
      {open && (
        <p className="rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground">
          {item.sourceExcerpt}
        </p>
      )}
    </div>
  );
}

/**
 * Surfaces what the extractor threw away, so it's visible that Orbit is being
 * deliberately careful rather than looking like it simply missed things.
 */
function SkippedNote({ skipped }: { skipped?: RejectedCounts | null }) {
  const text = skippedNoteText(skipped);
  if (!text) return null;
  return <p className="text-xs text-muted-foreground">{text}</p>;
}
