"use client";

import { Check, Globe } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { WebChoice } from "@/lib/chat-web-decision";
import { cn } from "@/lib/utils";

const OPTIONS: ReadonlyArray<{ value: WebChoice; label: string; hint: string }> = [
  { value: "auto", label: "Auto", hint: "Searches the web only when a question needs it" },
  { value: "on", label: "On", hint: "May search the web for every question in this chat" },
  { value: "off", label: "Off", hint: "Answers only from your own records" },
];

/**
 * The composer's web-search switch: auto (the default) / on / off, remembered per chat.
 *
 * Auto is the question's call (`decideWebForTurn`); an explicit off beats it. `note` is the
 * last answer's own words about what auto did (the step trail's line), so the button can show
 * that it turned itself on and say why without the person opening anything. `autoOn` and
 * `blocked` only count while the choice is still auto.
 */
export function WebSearchControl({
  choice,
  onChange,
  autoOn,
  blocked,
  note,
  disabled,
}: {
  choice: WebChoice;
  onChange: (next: WebChoice) => void;
  /** The last answer was one auto turned the web on for. */
  autoOn: boolean;
  /** The last answer wanted the web and could not have it (paused, or no provider that searches). */
  blocked: boolean;
  /** The step trail's line for either. */
  note: string | null;
  disabled?: boolean;
}) {
  const lit = choice === "on" || (choice === "auto" && autoOn);
  const state =
    choice === "auto"
      ? autoOn
        ? "auto, on for the last answer"
        : blocked
          ? "auto, unavailable"
          : "auto"
      : choice;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Web search: ${state}`}
            title={`Web search: ${state}. ${OPTIONS.find((o) => o.value === choice)!.hint}`}
            disabled={disabled}
            className={cn(
              "relative size-9 shrink-0 rounded-full",
              lit ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/30 hover:bg-primary/20 hover:text-primary" : "text-muted-foreground"
            )}
          >
            <Globe className="size-4" />
            {choice === "auto" && (
              <span
                aria-hidden
                className="absolute -bottom-0.5 -right-0.5 rounded-full bg-background px-1 text-3xs font-semibold leading-3.5 text-muted-foreground ring-1 ring-border"
              >
                A
              </span>
            )}
            {choice === "off" && (
              <span aria-hidden className="absolute left-1/2 top-1/2 h-px w-5 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-current" />
            )}
          </Button>
        }
      />
      <PopoverContent align="start" side="top" className="w-72 p-1.5">
        <div role="radiogroup" aria-label="Web search" className="flex flex-col gap-0.5">
          {OPTIONS.map((o) => {
            const selected = o.value === choice;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onChange(o.value)}
                className={cn(
                  "flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                  selected && "bg-muted/60"
                )}
              >
                <Check className={cn("mt-0.5 size-3.5 shrink-0", selected ? "text-primary" : "opacity-0")} aria-hidden />
                <span className="min-w-0">
                  <span className="block font-medium">{o.label}</span>
                  <span className="block text-xs text-muted-foreground">{o.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        {choice === "auto" && note && (autoOn || blocked) && (
          <p className="mt-1.5 border-t border-border/60 px-2 pt-1.5 text-xs text-muted-foreground">{note}</p>
        )}
      </PopoverContent>
      {/* Announced, not shown: the button's look changing says nothing to a screen reader. */}
      <span className="sr-only" role="status" aria-live="polite">
        {choice === "auto" && (autoOn || blocked) ? note : ""}
      </span>
    </Popover>
  );
}
