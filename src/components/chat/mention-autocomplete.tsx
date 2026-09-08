"use client";

/**
 * The type-ahead that opens when you start typing `@` in the composer.
 *
 * Presentational and keyboard-passive: the textarea keeps focus the whole time, so arrow
 * keys and Enter are handled by the composer's own `keydown` and arrive here as a plain
 * `activeIndex`. That is what lets you type through the menu without it stealing the
 * caret — the thing that makes an `@` menu feel native rather than modal.
 */

import { useEffect, useRef } from "react";
import { CalendarDays } from "lucide-react";

import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { cn } from "@/lib/utils";

/** One row, flattened from either source so the list can be one keyboard sequence. */
export type MentionOption =
  | {
      kind: "person";
      id: string;
      title: string;
      subtitle: string | null;
      contactId: string;
      firstName: string | null;
      fullName: string;
      avatarUrl: string | null;
      /** Preferred name first, then full name — the caller takes the first free one. */
      nameCandidates: string[];
    }
  | {
      kind: "event";
      id: string;
      title: string;
      subtitle: string | null;
      /** The prose this row splices in. Events carry no `@` token — see the composer. */
      text: string;
    };

export function MentionAutocomplete({
  options,
  activeIndex,
  loading,
  listboxId,
  optionId,
  onPick,
}: {
  options: readonly MentionOption[];
  activeIndex: number;
  loading: boolean;
  listboxId: string;
  /** Builds the id the textarea's `aria-activedescendant` points at. */
  optionId: (index: number) => string;
  onPick: (option: MentionOption) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Arrowing past the fold has to bring the row with it; the caret never leaves the
  // textarea, so the browser will not scroll this for us.
  useEffect(() => {
    const row = listRef.current?.children[activeIndex];
    if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!options.length) {
    return (
      <Shell>
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          {loading ? "Searching…" : "No one matches that."}
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div ref={listRef} id={listboxId} role="listbox" className="max-h-56 overflow-y-auto p-1">
        {options.map((option, i) => (
          <button
            key={option.id}
            id={optionId(i)}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            // The composer must keep focus: losing it would collapse the caret position
            // the splice depends on, and blur would race the click.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(option)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
              i === activeIndex ? "bg-muted" : "hover:bg-muted/60",
            )}
          >
            {option.kind === "person" ? (
              <ContactAvatar
                contactId={option.contactId}
                firstName={option.firstName}
                fullName={option.fullName}
                profileImageUrl={option.avatarUrl}
                size="sm"
                className="size-7"
              />
            ) : (
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                <CalendarDays className="size-3.5 text-muted-foreground" aria-hidden />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-foreground">{option.title}</span>
              {option.subtitle && (
                <span className="block truncate text-xs text-muted-foreground">
                  {option.subtitle}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
    </Shell>
  );
}

/**
 * The floating panel.
 *
 * Anchored to the composer's left edge rather than to the caret: measuring a caret inside a
 * textarea needs a mirror layer, and the composer already runs two of those. Left-aligned
 * is what Notion and Linear do, and it cannot drift out of the pill.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-slot="mention-autocomplete"
      className={cn(
        "absolute bottom-full left-0 z-30 mb-2 w-full max-w-sm overflow-hidden",
        "rounded-xl border border-border/70 bg-popover shadow-lg",
      )}
    >
      {children}
    </div>
  );
}
