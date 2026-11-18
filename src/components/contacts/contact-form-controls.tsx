"use client";

/**
 * The contact form's quick-entry controls: tap or key a value instead of typing a number
 * into a box. Each one is a plain ARIA pattern (radiogroup, or a text box with chips), so
 * the keyboard does what a screen reader announces.
 */

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

type Option<T> = { value: T; label: string };

/**
 * A radiogroup with a roving tab stop: Tab lands on the selected option (or the first),
 * arrows move and select, and the number keys 1–9 jump straight to that option.
 */
function useRadioKeys<T>(options: readonly Option<T>[], value: T | null, onChange: (v: T) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = options.findIndex((o) => o.value === value);

  function select(i: number) {
    const next = (i + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    const at = index < 0 ? 0 : index;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") select(at + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") select(at - 1);
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= options.length) select(Number(e.key) - 1);
    else return;
    e.preventDefault();
  }

  return { refs, index, onKeyDown };
}

function GroupLabel({ id, children, hint }: { id: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <span id={id} className="text-sm font-medium text-foreground">
        {children}
      </span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** Strength 1–5 as dots. `value` null = never rated, shown empty rather than as a guess. */
export function StrengthDots({
  value,
  onChange,
  dotClassName,
}: {
  value: number | null;
  onChange: (value: number) => void;
  /** The filled dot's colour. */
  dotClassName: string;
}) {
  const labelId = useId();
  const options = [1, 2, 3, 4, 5].map((n) => ({ value: n, label: `${n} of 5` }));
  const { refs, index, onKeyDown } = useRadioKeys(options, value, onChange);

  return (
    <div>
      <GroupLabel id={labelId} hint={value == null ? "Not rated" : `${value} of 5`}>
        Strength
      </GroupLabel>
      <div role="radiogroup" aria-labelledby={labelId} className="flex items-center gap-1" onKeyDown={onKeyDown}>
        {options.map((o, i) => (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={i === index}
            aria-label={o.label}
            tabIndex={i === (index < 0 ? 0 : index) ? 0 : -1}
            onClick={() => onChange(o.value)}
            className="group grid size-7 place-items-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span
              aria-hidden
              className={cn(
                "size-3.5 rounded-full transition-[background-color,scale] duration-fast group-hover:scale-110",
                value != null && o.value <= value ? dotClassName : "bg-foreground/15",
              )}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/** One choice out of a few, as a row of pills. `allowClear`: pressing the selected pill clears it. */
export function ChoicePills<T extends string | number>({
  label,
  options,
  value,
  onChange,
  selectedClassName,
  allowClear = false,
}: {
  label: string;
  options: readonly Option<T>[];
  value: T | null;
  onChange: (value: T | null) => void;
  selectedClassName: string;
  allowClear?: boolean;
}) {
  const labelId = useId();
  const { refs, index, onKeyDown } = useRadioKeys(options, value, onChange);

  return (
    <div>
      <GroupLabel id={labelId}>{label}</GroupLabel>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-1.5" onKeyDown={onKeyDown}>
        {options.map((o, i) => {
          const selected = i === index;
          return (
            <button
              key={String(o.value)}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={i === (index < 0 ? 0 : index) ? 0 : -1}
              onClick={() => onChange(selected && allowClear ? null : o.value)}
              className={cn(
                "h-7 rounded-full px-3 text-sm outline-none transition-colors duration-fast focus-visible:ring-3 focus-visible:ring-ring/50",
                selected ? selectedClassName : "bg-card text-muted-foreground ring-1 ring-border hover:text-foreground",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Tags as chips. Enter or comma adds what was typed, Backspace in an empty box takes the last
 * one back into the box to edit, and a pasted "a, b, c" becomes three tags.
 */
export function TagInput({
  value,
  onChange,
  chipClassName,
  placeholder = "Add a tag",
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  chipClassName: string;
  placeholder?: string;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState("");

  function add(raw: string) {
    const seen = new Set(value.map((t) => t.toLowerCase()));
    const next = [...value];
    for (const part of raw.split(",")) {
      const tag = part.trim();
      if (tag && !seen.has(tag.toLowerCase())) {
        seen.add(tag.toLowerCase());
        next.push(tag);
      }
    }
    if (next.length !== value.length) onChange(next);
    setDraft("");
  }

  return (
    <div>
      <GroupLabel id={`${inputId}-label`}>
        <label htmlFor={inputId}>Tags</label>
      </GroupLabel>
      <div
        className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input bg-card px-1.5 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
        onClick={(e) => (e.currentTarget.querySelector("input"))?.focus()}
      >
        {value.map((tag) => (
          <span key={tag} className={cn("inline-flex h-6 items-center gap-0.5 rounded-full pr-1 pl-2.5 text-xs font-medium", chipClassName)}>
            {tag}
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              onClick={() => onChange(value.filter((t) => t !== tag))}
              className="grid size-4 place-items-center rounded-full opacity-70 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          value={draft}
          autoComplete="off"
          dir="auto"
          placeholder={value.length ? "" : placeholder}
          onChange={(e) => {
            const v = e.target.value;
            if (v.includes(",")) add(v);
            else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && value.length) {
              e.preventDefault();
              setDraft(value[value.length - 1]);
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => draft.trim() && add(draft)}
          className="h-6 min-w-24 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
      </div>
    </div>
  );
}
