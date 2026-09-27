"use client";

/**
 * The typed opportunities a capture will open, before it opens them.
 *
 * A structural sibling of `suggested-reminders-review.tsx` — same ticks, same excerpt
 * disclosure, a different tint — because the two answer different questions about the same
 * note and nobody should have to learn two interaction models to review one capture.
 *
 * Two things are editable and one deliberately is not:
 *
 *   THE KIND IS EDITABLE, because it is the field the extraction most often gets nearly
 *   right. "They'll forward my resume" is a referral, and a model that files it as
 *   `introduction` has produced something that will not be found when the user searches for
 *   referrals — which is the one thing this taxonomy exists to make possible.
 *
 *   THE TICK IS EDITABLE, because an opportunity is a claim about what somebody offered and
 *   the person who was there is the authority on that.
 *
 *   THE LABEL IS NOT. It is the note's own words, kept verbatim so the row reads as a
 *   record rather than a paraphrase, and it is part of `itemHash` — so editing it here
 *   would quietly defeat the guard that stops a re-pasted note duplicating a pipeline. The
 *   profile section is where a saved opportunity gets reworded.
 */

import { useState } from "react";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  OPPORTUNITY_KINDS,
  type OpportunityKind,
} from "@/lib/opportunity-kinds";
import type { OpportunityReviewItem } from "@/lib/capture/types";

export function SuggestedOpportunitiesReview({
  items,
  onChange,
}: {
  items: OpportunityReviewItem[];
  onChange: (next: OpportunityReviewItem[]) => void;
}) {
  if (!items.length) return null;

  /** By key, never by index — the same rule the reminders list learned the hard way. */
  function update(key: string, patch: Partial<OpportunityReviewItem>) {
    onChange(items.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  const checkedCount = items.filter((i) => i.checked).length;

  return (
    <div className="space-y-3 rounded-2xl border border-violet-500/30 bg-violet-500/[0.04] p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-violet-600 dark:text-violet-300" />
        <h3 className="text-sm font-medium text-foreground">
          Opportunities that will be opened
        </h3>
        <span className="text-xs text-muted-foreground">
          {checkedCount} of {items.length} selected
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Filed on each person&rsquo;s profile so you can find them later — searching for
        &ldquo;referral&rdquo; brings back everyone who offered one. Check the kind:
        it is what the search will match on.
      </p>

      <ul className="space-y-2">
        {items.map((item) => (
          <OpportunityRow key={item.key} item={item} update={update} />
        ))}
      </ul>
    </div>
  );
}

function OpportunityRow({
  item,
  update,
}: {
  item: OpportunityReviewItem;
  update: (key: string, patch: Partial<OpportunityReviewItem>) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="space-y-2 rounded-xl border border-border/60 bg-card p-3">
      <div className="flex items-start gap-2">
        <Checkbox
          checked={item.checked}
          onCheckedChange={(v) => update(item.key, { checked: Boolean(v) })}
          aria-label={`Include ${item.label}`}
          className="mt-1"
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="min-w-0">
            <p className="text-sm text-foreground">{item.label}</p>
            <p className="text-xs text-muted-foreground">
              {item.personName}
              {item.dueDateIso ? ` · by ${item.dueDateIso}` : ""}
              {/* The phrase is quoted rather than resolved silently: "before the deadline"
                  became a date, and the person should be able to see which words did it. */}
              {item.rawDatePhrase ? ` (“${item.rawDatePhrase}”)` : ""}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Label
              htmlFor={`opportunity-kind-${item.key}`}
              className="text-xs text-muted-foreground"
            >
              Kind
            </Label>
            <Select
              value={item.kind}
              onValueChange={(v) =>
                update(item.key, { kind: String(v) as OpportunityKind })
              }
            >
              <SelectTrigger id={`opportunity-kind-${item.key}`} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPPORTUNITY_KINDS.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Same disclosure as a reminder's source line. Every opportunity is verbatim-
              contained in the note by construction, and this is where you check that. */}
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
            >
              {open ? (
                <ChevronUp className="size-3 shrink-0" />
              ) : (
                <ChevronDown className="size-3 shrink-0" />
              )}
              where this came from
            </button>
            {open && (
              <p className="rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground">
                {item.sourceExcerpt}
              </p>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
