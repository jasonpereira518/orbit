"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Sparkles, Stars, StarOff } from "lucide-react";
import { toast } from "sonner";
import { setConstellationPin } from "@/actions/contacts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type Pin = "in" | "out" | null;

const OPTIONS: { value: Pin; label: string; hint: string }[] = [
  {
    value: null,
    label: "Automatic",
    hint: "Shown once you have notes, a meeting, or a real exchange",
  },
  { value: "in", label: "Always show", hint: "Keep them on the chart regardless" },
  { value: "out", label: "Never show", hint: "Keep them off it regardless" },
];

/**
 * The manual override, as a fourth pill in the profile's stat row.
 *
 * The label states the EFFECTIVE outcome rather than the raw setting, because the question
 * someone actually has standing on a profile is "is this person on my chart?" — answering it
 * should not require opening a menu. So an automatic contact reads "On the chart" or "Not on
 * the chart" depending on where the rule landed, and only a deliberate override says so.
 *
 * A dropdown rather than a cycling button: three states behind one click is unguessable, and
 * this one is worth getting right the first time since two of the three hide someone.
 */
export function ConstellationPinPill({
  contactId,
  pin,
  substantive,
}: {
  contactId: string;
  pin: Pin;
  /** Whether the automatic rule currently admits them — what "Automatic" resolves to. */
  substantive: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<Pin>(pin);
  const [pending, start] = useTransition();

  const shown = current === "in" || (current === null && substantive);

  const label =
    current === "in"
      ? "Always on the chart"
      : current === "out"
        ? "Hidden from the chart"
        : shown
          ? "On the chart"
          : "Not on the chart yet";

  function choose(next: Pin) {
    if (next === current) return;
    const previous = current;
    setCurrent(next);
    start(async () => {
      try {
        await setConstellationPin(contactId, next);
        router.refresh();
      } catch (err) {
        setCurrent(previous);
        toast.error(
          err instanceof Error ? err.message : "Could not change that."
        );
      }
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={pending}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-fast disabled:opacity-60",
          shown
            ? "border-primary/30 bg-primary/10 text-primary"
            : "border-border/70 text-muted-foreground hover:text-foreground"
        )}
        aria-label={`Constellation: ${label}`}
      >
        {shown ? (
          <Stars className="size-3" aria-hidden />
        ) : (
          <StarOff className="size-3" aria-hidden />
        )}
        {label}
        <ChevronDown className="size-3 opacity-60" aria-hidden />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        {OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.label}
            onSelect={() => choose(option.value)}
            className="flex items-start gap-2"
          >
            <span className="mt-0.5 w-3.5 shrink-0">
              {option.value === current && (
                <Check className="size-3.5" aria-hidden />
              )}
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm">
                {option.label}
                {option.value === null && substantive && (
                  <Sparkles className="size-3 text-primary" aria-hidden />
                )}
              </span>
              <span className="block text-xs text-muted-foreground">
                {option.hint}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
