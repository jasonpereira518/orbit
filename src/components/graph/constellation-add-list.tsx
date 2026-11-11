"use client";

import { useEffect, useId, useState, type RefObject } from "react";
import { Plus } from "lucide-react";
// Type only: the module is plain data code, but nothing here needs its runtime.
import type { KeywordSearchHit } from "@/lib/keyword-search";
import { cn } from "@/lib/utils";

const label = (h: KeywordSearchHit) => (h.preferredName || "").trim() || h.fullName;

/**
 * People the search found who are not in the sky being viewed, under the search box.
 *
 * A listbox driven from the search input (focus never leaves it): ArrowUp/ArrowDown move the
 * active option, Enter adds it. A click or tap on a row adds it too (its Add pill is only a visual cue).
 * The input is wired up here, in an effect, so the box in `NetworkGraph` stays one component
 * that works the same with or without a sky.
 */
export function ConstellationAddList({
  hits,
  inputRef,
  onAdd,
  announcement,
}: {
  hits: KeywordSearchHit[];
  inputRef: RefObject<HTMLInputElement | null>;
  /** Resolves true once the person is in the sky. */
  onAdd: (hit: KeywordSearchHit) => Promise<boolean>;
  /** "Added Jane", kept by the parent because adding redraws the sky and this list with it. */
  announcement: string;
}) {
  const listId = useId();
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState<string | null>(null);
  const [prevHits, setPrevHits] = useState(hits);
  // A new result set starts with nothing active (adjusting state during render, not in an effect).
  if (prevHits !== hits) {
    setPrevHits(hits);
    setActive(-1);
  }

  const add = async (hit: KeywordSearchHit) => {
    if (busy) return;
    setBusy(hit.id);
    try {
      await onAdd(hit);
    } finally {
      setBusy(null);
    }
  };

  // Latest-render closure for the native listener below.
  const handleKey = (e: KeyboardEvent) => {
    if (hits.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + hits.length) % hits.length);
    } else if (e.key === "Enter" && active >= 0 && hits[active]) {
      e.preventDefault();
      void add(hits[active]);
    }
  };
  const optionId = (i: number) => `${listId}-${i}`;
  const open = hits.length > 0;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onKey = (e: KeyboardEvent) => handleKey(e);
    input.addEventListener("keydown", onKey);
    return () => input.removeEventListener("keydown", onKey);
    // handleKey closes over hits/active/busy; re-binding on each render keeps it current.
  });

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", String(open));
    if (open) input.setAttribute("aria-controls", listId);
    else input.removeAttribute("aria-controls");
    if (open && active >= 0) input.setAttribute("aria-activedescendant", optionId(active));
    else input.removeAttribute("aria-activedescendant");
    return () => {
      for (const a of ["role", "aria-autocomplete", "aria-expanded", "aria-controls", "aria-activedescendant"])
        input.removeAttribute(a);
    };
    // optionId is derived from listId alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputRef, open, active, listId]);

  return (
    <div className="absolute inset-x-0 top-full mt-1.5">
      {open && (
        <div className="overflow-hidden rounded-xl border border-white/15 bg-[#080b12]/95 text-white shadow-lg backdrop-blur">
          <p className="px-3 pb-1 pt-2 text-3xs uppercase tracking-[0.14em] text-white/45">
            Not in this constellation
          </p>
          <ul id={listId} role="listbox" aria-label="People to add" className="max-h-56 overflow-y-auto pb-1">
            {hits.map((h, i) => (
              <li
                key={h.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                aria-disabled={busy !== null || undefined}
                onMouseEnter={() => setActive(i)}
                // The option itself is the click target; mousedown is cancelled so focus stays in the search box.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void add(h)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 px-3 py-1.5",
                  i === active ? "bg-white/10" : "hover:bg-white/8"
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{label(h)}</span>
                  {(h.title || h.company) && (
                    <span className="block truncate text-xs text-white/50">
                      {[h.title, h.company].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </span>
                {/* Looks like a button, is not one: an interactive control inside role=option is invalid. */}
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-white/20 px-3 text-xs",
                    busy !== null && "opacity-50"
                  )}
                >
                  <Plus className="size-3" />
                  {busy === h.id ? "Adding…" : "Add"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p
        aria-live="polite"
        className={cn(
          "mt-1 rounded-full bg-[#080b12]/92 px-3 py-1 text-xs text-white/80",
          open && "sr-only",
          !announcement && "sr-only"
        )}
      >
        {announcement}
      </p>
    </div>
  );
}
