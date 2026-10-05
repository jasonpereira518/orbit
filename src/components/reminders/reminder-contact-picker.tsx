"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Check, UserRound, X } from "lucide-react";
import { searchContactsForPicker } from "@/actions/contacts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Option = { id: string; name: string };

const SEARCH_DEBOUNCE_MS = 180;

/**
 * Pick one contact by typing. Replaces a `<select>` of the first fifty contacts
 * alphabetically — which, past fifty people, simply didn't contain most of them.
 *
 * Opens on the most recently touched people (the order a reminder is most likely about),
 * then searches as you type.
 */
export function ReminderContactPicker({
  value,
  onChange,
  placeholder = "Any contact",
  triggerClassName,
  id,
  align = "start",
}: {
  value: Option | null;
  onChange: (next: Option | null) => void;
  placeholder?: string;
  triggerClassName?: string;
  id?: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<Option[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [loading, start] = useTransition();
  const debounce = useRef<number | null>(null);
  const request = useRef(0);
  const listId = useId();

  useEffect(() => () => {
    if (debounce.current) window.clearTimeout(debounce.current);
  }, []);

  function search(term: string) {
    const req = ++request.current;
    start(async () => {
      try {
        const rows = await searchContactsForPicker(term || undefined, 8, "recent");
        if (req !== request.current) return;
        setOptions(rows.map((c) => ({ id: c.id, name: c.preferredName?.trim() || c.fullName })));
        setHighlight(0);
      } catch {
        if (req === request.current) setOptions([]);
      }
    });
  }

  function onQuery(next: string) {
    setQ(next);
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => search(next.trim()), SEARCH_DEBOUNCE_MS);
  }

  function choose(option: Option | null) {
    onChange(option);
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQ("");
          search("");
        }
      }}
    >
      <PopoverTrigger
        id={id}
        type="button"
        className={cn(
          "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-left text-sm transition-colors hover:bg-muted/50",
          triggerClassName
        )}
      >
        <UserRound className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn("min-w-0 flex-1 truncate", !value && "text-muted-foreground")}>
          {value?.name ?? placeholder}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-64 rounded-xl border border-border/70 bg-card p-1.5 shadow-lg ring-0"
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => Math.min(options.length - 1, h + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(0, h - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (options[highlight]) choose(options[highlight]);
            }
          }}
          placeholder="Search people…"
          aria-label="Search people"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={options[highlight] ? `${listId}-${options[highlight].id}` : undefined}
          className="h-8 w-full rounded-lg bg-muted/50 px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        />
        <ul id={listId} role="listbox" className="mt-1 max-h-64 overflow-y-auto overscroll-contain">
          {value && (
            <li>
              <button
                type="button"
                onClick={() => choose(null)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
              >
                <X className="size-3.5" /> No contact
              </button>
            </li>
          )}
          {options.map((o, i) => (
            <li key={o.id} id={`${listId}-${o.id}`} role="option" aria-selected={value?.id === o.id}>
              <button
                type="button"
                tabIndex={-1}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(o)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  i === highlight && "bg-muted"
                )}
              >
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                {value?.id === o.id && <Check className="size-3.5 text-primary" />}
              </button>
            </li>
          ))}
          {!loading && options.length === 0 && (
            <li className="px-2 py-3 text-center text-xs text-muted-foreground">
              {q.trim() ? "No one by that name" : "No contacts yet"}
            </li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
