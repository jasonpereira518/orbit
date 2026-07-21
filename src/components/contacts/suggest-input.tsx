"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function SuggestInput({
  value,
  onChange,
  onSelect,
  suggestions,
  placeholder,
  id,
  type = "text",
  autoComplete = "off",
}: {
  value: string;
  onChange: (value: string) => void;
  /** Called when the user picks a suggestion (full value). */
  onSelect?: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
  id?: string;
  type?: string;
  autoComplete?: string;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    const filtered = q
      ? suggestions.filter(
          (s) =>
            s.toLowerCase().includes(q) && s.toLowerCase() !== q
        )
      : suggestions;
    return filtered.slice(0, 8);
  }, [suggestions, value]);

  useEffect(() => {
    setHighlight(0);
  }, [matches]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  function choose(next: string) {
    onChange(next);
    onSelect?.(next);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!open || matches.length === 0) {
      if (event.key === "ArrowDown" && matches.length > 0) {
        setOpen(true);
        event.preventDefault();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((h) => (h + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((h) => (h - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter" && matches[highlight]) {
      event.preventDefault();
      choose(matches[highlight]!);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  const showList = open && matches.length > 0;

  return (
    <div ref={rootRef} className="relative">
      <Input
        id={id}
        type={type}
        autoComplete={autoComplete}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full z-50 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-border bg-popover py-1 text-sm text-popover-foreground shadow-md"
        >
          {matches.map((option, index) => (
            <li key={option} role="option" aria-selected={index === highlight}>
              <button
                type="button"
                className={cn(
                  "flex w-full px-2.5 py-1.5 text-left transition-colors",
                  index === highlight
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted"
                )}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(option)}
              >
                {option}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
