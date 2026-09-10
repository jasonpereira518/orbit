"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { setConstellationPin } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Pin = "in" | "out" | null;

/**
 * Put this person on the star chart, or take them off it.
 *
 * One button, labelled with the action when they are off the chart and with their state when
 * they are on it — the Follow/Following shape. A three-way menu was the first cut and it was
 * the wrong instrument: the common case is "I just wrote about this person, put them up
 * there", and that should be one click with no menu to read.
 *
 * The third state is still reachable, because it is genuinely different: `null` means "decide
 * automatically", which is not the same as a pin that happens to agree with the rule today. It
 * appears as a small reset only once an override actually exists, so it costs nothing to
 * ignore.
 */
export function ConstellationPinButton({
  contactId,
  pin,
  substantive,
}: {
  contactId: string;
  pin: Pin;
  /** Whether the automatic rule admits them — what `null` currently resolves to. */
  substantive: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<Pin>(pin);
  const [pending, start] = useTransition();

  const onChart = current === "in" || (current === null && substantive);

  function set(next: Pin) {
    const previous = current;
    setCurrent(next);
    start(async () => {
      try {
        await setConstellationPin(contactId, next);
        router.refresh();
      } catch (err) {
        setCurrent(previous);
        toast.error(err instanceof Error ? err.message : "Could not change that.");
      }
    });
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant={onChart ? "outline" : "default"}
        disabled={pending}
        // The label says where they ARE; the action is the opposite. Spell the action out
        // here so it is unambiguous to a screen reader and on hover.
        aria-label={
          onChart ? "Remove from your constellation" : "Add to your constellation"
        }
        title={
          onChart
            ? current === "in"
              ? "Pinned to your constellation — click to remove"
              : "On your constellation — click to remove"
            : current === "out"
              ? "Hidden from your constellation — click to add"
              : "Not on your constellation yet — click to add"
        }
        onClick={() => set(onChart ? "out" : "in")}
        className={cn("rounded-full", onChart && "text-muted-foreground")}
      >
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : onChart ? (
          <Check aria-hidden />
        ) : (
          <Plus aria-hidden />
        )}
        {onChart ? "On your constellation" : "Add to constellation"}
      </Button>

      {current !== null && (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={pending}
          aria-label="Decide automatically instead"
          title="Decide automatically — shown once you have notes, a meeting, or a real exchange"
          onClick={() => set(null)}
          className="rounded-full text-muted-foreground"
        >
          <RotateCcw aria-hidden />
        </Button>
      )}
    </span>
  );
}
