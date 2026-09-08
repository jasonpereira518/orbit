"use client";

/**
 * Every extracted person in one scannable list.
 *
 * This replaced a one-card-at-a-time carousel that demanded an explicit Accept per person
 * even when the extraction was perfect. Rows arrive checked; the work is scanning and
 * unchecking, which is the same shape as `import-people-review.tsx` — and this borrows its
 * idioms deliberately: the "N of M selected" header, select-all, `opacity-55` on a
 * deselected row rather than hiding it, and an aligned New/Update status column.
 *
 * Rows collapse to name, company/role and status; clicking one expands the full editable
 * card in place. That is what keeps the list usable in the two constrained call sites — the
 * 448px chat sheet and the onboarding wizard's centered card — where a stack of full cards
 * would be a scroll with no overview.
 *
 * Scrolling is bounded only when `compact`. The chat sheet is already one `overflow-y-auto`
 * column and the wizard card is `justify-center` + `overflow-hidden`, so both need the list
 * to have its own height; the /capture page has neither constraint, and nesting a scroll
 * area inside a page that scrolls anyway is worse than either alone.
 */

import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "lucide-react";
import type { ReviewItem } from "@/lib/capture-review-item";
import { PersonReviewFields } from "@/components/capture/person-review-fields";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { DUR, EASE_HOUSE } from "@/lib/motion";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { cn } from "@/lib/utils";

export function PersonReviewList({
  items,
  expandedKey,
  onExpandedKeyChange,
  onItemChange,
  onDecisionChange,
  onSelectAll,
  compact,
  preferredContactId,
  preferredContactName,
  lockedParticipantName,
}: {
  items: ReviewItem[];
  expandedKey: string | null;
  onExpandedKeyChange: (key: string | null) => void;
  onItemChange: (key: string, next: ReviewItem) => void;
  onDecisionChange: (key: string, accepted: boolean) => void;
  onSelectAll: (accepted: boolean) => void;
  compact?: boolean;
  preferredContactId?: string | null;
  preferredContactName?: string | null;
  lockedParticipantName?: string | null;
}) {
  const reduced = usePrefersReducedMotion();
  const selectable = items.filter((i) => !i.placeholder);
  const selected = selectable.filter((i) => i.decision === "accepted").length;
  const pendingCount = items.filter((i) => i.placeholder).length;
  const allSelected = selectable.length > 0 && selected === selectable.length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {selected} of {selectable.length} selected
          {pendingCount > 0 ? ` · ${pendingCount} still loading` : ""}
        </p>
        {selectable.length > 1 && (
          <button
            type="button"
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
            onClick={() => onSelectAll(!allSelected)}
          >
            {allSelected ? "Deselect all" : "Select all"}
          </button>
        )}
      </div>

      <ul
        className={cn(
          "divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60",
          // Bounded height only where the container cannot grow. See the note above.
          compact && "max-h-[24rem] overflow-y-auto"
        )}
      >
        {items.map((item) => {
          const expanded = expandedKey === item.key && !item.placeholder;
          const checked = item.decision === "accepted";
          return (
            <li
              key={item.key}
              className={cn(
                "bg-card transition-opacity",
                !checked && !item.placeholder && "opacity-55"
              )}
            >
              <div className="flex items-center gap-2.5 px-3 py-2.5">
                {item.placeholder ? (
                  // Not a disabled Checkbox: a disabled control invites a click that does
                  // nothing. A dot reads as "not ready", which is what it is.
                  <span
                    className="size-4 shrink-0 animate-pulse rounded-full bg-muted-foreground/30"
                    aria-hidden
                  />
                ) : (
                  <Checkbox
                    checked={checked}
                    aria-label={`Save ${item.parsed.name || "this person"}`}
                    onCheckedChange={(v) =>
                      onDecisionChange(item.key, Boolean(v))
                    }
                  />
                )}

                <button
                  type="button"
                  disabled={item.placeholder}
                  aria-expanded={expanded}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 text-left",
                    !item.placeholder && "cursor-pointer"
                  )}
                  onClick={() =>
                    onExpandedKeyChange(expanded ? null : item.key)
                  }
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {item.parsed.name || "Unnamed person"}
                    </span>
                    {item.placeholder ? (
                      <Skeleton className="mt-1 h-3 w-28" />
                    ) : (
                      <span className="block truncate text-xs text-muted-foreground">
                        {[item.parsed.role, item.parsed.company]
                          .filter(Boolean)
                          .join(" · ") || "No company or role found"}
                      </span>
                    )}
                  </span>

                  {/*
                    Auto-width on a narrow screen, fixed above it. A fixed column aligns the
                    badges nicely on desktop, but at 375px it takes ~128px of a ~300px row
                    and the name truncates to "Elena Vasq…" — legibility wins over alignment
                    at that size.
                  */}
                  <span
                    className={cn(
                      "flex shrink-0 items-center justify-end gap-1.5",
                      compact ? "sm:w-24" : "sm:w-32"
                    )}
                  >
                    {item.placeholder ? (
                      <Skeleton className="h-5 w-14 rounded-full" />
                    ) : (
                      <>
                        {(item.parsed.low_confidence_fields || []).length > 0 && (
                          <span
                            title="Some fields were inferred, not read from the notes"
                            className="size-1.5 rounded-full bg-amber-500"
                          />
                        )}
                        <Badge variant="secondary" className="text-[10px]">
                          {item.mergeContactId ? "Update" : "New"}
                        </Badge>
                      </>
                    )}
                  </span>

                  {!item.placeholder && (
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        expanded && "rotate-180"
                      )}
                      aria-hidden
                    />
                  )}
                </button>
              </div>

              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.div
                    initial={reduced ? false : { height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    transition={{ duration: DUR.base, ease: EASE_HOUSE }}
                    className="overflow-hidden"
                  >
                    <div className="border-t border-border/50 bg-muted/20 px-3 py-3">
                      <PersonReviewFields
                        item={item}
                        compact={compact}
                        preferredContactId={preferredContactId}
                        preferredContactName={preferredContactName}
                        lockedParticipantName={lockedParticipantName}
                        onChange={(next) => onItemChange(item.key, next)}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
