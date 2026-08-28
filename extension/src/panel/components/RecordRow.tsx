/**
 * A row of the record Orbit is about to save.
 *
 * The distinction this component exists to make: the user is reading a
 * *record*, not filling a *form*. No labels above inputs, no boxes at rest, no
 * visible field count. When a word is wrong you click the word and fix the
 * word. That is the difference between a one-click add that feels trustworthy
 * and one that feels reckless.
 */
import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import type { FieldConfidence } from "@contract";
import { cn } from "@/lib/cn";
import { CompanyMark } from "./ui";

export type FieldOrigin = "page" | "ai" | "server" | "user";

export type RecordField = {
  key: string;
  label: string;
  value: string;
  /** Where the value came from, in the adapter's own words ("url", "h1", …). */
  source: string | null;
  confidence: FieldConfidence | null;
  origin: FieldOrigin;
  /** Rendered with its brand colour rather than as plain text. */
  brand?: boolean;
  /** Identity keys (the LinkedIn URL) are shown but not editable. */
  readOnly?: boolean;
  placeholder?: string;
};

/**
 * Adapter sources are implementation detail. Never ship `ld+json` to a human.
 */
export function humanSource(source: string | null): string {
  switch (source) {
    case "url":
      return "from the address";
    case "ld+json":
    case "og:title":
    case "og:description":
    case "og:image":
      return "from page data";
    case "h1":
      return "from the heading";
    case "document.title":
      return "from the tab title";
    case "headline":
      return "parsed from the headline";
    case "top-card":
      return "from the profile card";
    case "thread-header":
      return "from the conversation";
    case "post-header":
      return "from the post";
    case "page-link":
      return "from a link on the page";
    case "span[email]":
      return "from the email thread";
    case "mailto":
      return "from a mailto link";
    case "ai":
      return "read from the page text";
    default:
      return "read from this page";
  }
}

/**
 * Confidence at a glance, in the slot the reader is already interrogating.
 * Swaps to the human source on hover — same slot, same size, zero layout shift.
 */
function Provenance({
  field,
  hovered,
}: {
  field: RecordField;
  hovered: boolean;
}) {
  if (field.readOnly) return null;

  if (hovered) {
    return (
      <span className="truncate text-[10px] text-[var(--muted-foreground)]">
        {field.origin === "user" ? "you edited this" : humanSource(field.source)}
      </span>
    );
  }

  if (field.origin === "user") {
    return (
      <span
        className="h-[5px] w-[5px] shrink-0 rounded-full bg-[var(--primary)] ring-2 ring-[var(--accent)]"
        aria-label="you edited this"
      />
    );
  }
  if (!field.value) return null;
  if (field.confidence === "high") {
    return (
      <span
        className="h-[5px] w-[5px] shrink-0 rounded-full bg-[var(--primary)]"
        aria-label="confident"
      />
    );
  }
  if (field.confidence === "medium") {
    return (
      <span
        className="h-[5px] w-[5px] shrink-0 rounded-full border border-[var(--primary)]"
        aria-label="probably right"
      />
    );
  }
  return (
    <span className="inline-flex items-center gap-1" aria-label="inferred">
      <Sparkles size={9} className="text-[var(--muted-foreground)]" />
    </span>
  );
}

export function RecordRow({
  field,
  onChange,
  onHover,
  autoFocus,
}: {
  field: RecordField;
  onChange: (value: string) => void;
  onHover?: (field: RecordField | null) => void;
  autoFocus?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(field.value);
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep in step with values that arrive later — but never while the user is
  // mid-edit, and never once they've made the field their own.
  useEffect(() => {
    if (!editing && field.origin !== "user") setDraft(field.value);
  }, [field.value, field.origin, editing]);

  useEffect(() => {
    if (autoFocus) setEditing(true);
  }, [autoFocus]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== field.value) onChange(draft);
  };

  return (
    <div
      className={cn(
        "group flex min-h-[28px] items-center gap-2 py-[5px]",
        field.origin === "user" &&
          "border-l-[1.5px] border-[var(--primary)] -ml-[1.5px] pl-[calc(0.5rem-1.5px)]"
      )}
      onMouseEnter={() => {
        setHovered(true);
        onHover?.(field);
      }}
      onMouseLeave={() => {
        setHovered(false);
        onHover?.(null);
      }}
    >
      <span className="w-[72px] shrink-0 text-[11px] text-[var(--muted-foreground)]">
        {field.label}
      </span>

      <div className="min-w-0 flex-1">
        {editing && !field.readOnly ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(field.value);
                setEditing(false);
              }
            }}
            placeholder={field.placeholder}
            // Negative margin so the focus pill costs no reflow.
            className="-mx-1.5 w-[calc(100%+0.75rem)] rounded-sm bg-[var(--muted)] px-1.5 py-0.5 text-[13px] outline-none ring-0 [border-bottom:1px_solid_var(--ring)]"
          />
        ) : (
          <button
            type="button"
            disabled={field.readOnly}
            onClick={() => setEditing(true)}
            className={cn(
              "block w-full truncate text-left text-[13px] leading-[18px]",
              field.readOnly
                ? "cursor-default text-[var(--muted-foreground)]"
                : "hover:[border-bottom:1px_dotted_var(--border)]",
              !field.value && "text-[var(--muted-foreground)]"
            )}
          >
            {field.value ? (
              field.brand ? (
                <CompanyMark company={field.value} />
              ) : (
                field.value
              )
            ) : (
              (field.placeholder ?? "—")
            )}
          </button>
        )}
      </div>

      <span className="flex h-[5px] w-[92px] shrink-0 items-center justify-end">
        <Provenance field={field} hovered={hovered} />
      </span>
    </div>
  );
}
