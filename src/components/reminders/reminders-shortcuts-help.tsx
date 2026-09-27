"use client";

import { Keyboard } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TRIAGE_SHORTCUTS } from "@/lib/triage-keys";

/** The `?` key's popover — and a visible way in for anyone who doesn't know to press it. */
export function RemindersShortcutsHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        type="button"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        className="hidden size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [@media(hover:hover)]:inline-flex"
      >
        <Keyboard className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 rounded-2xl border border-border/70 bg-card p-3 shadow-lg ring-0">
        <p className="mb-2 text-sm font-medium">Keyboard shortcuts</p>
        <dl className="space-y-1.5">
          {TRIAGE_SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center justify-between gap-3 text-xs">
              <dt className="text-muted-foreground">{s.label}</dt>
              <dd className="flex shrink-0 gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="min-w-5 rounded border border-border/80 bg-muted/60 px-1 py-px text-center font-mono text-[11px] text-foreground"
                  >
                    {k}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
