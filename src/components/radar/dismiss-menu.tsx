"use client";

import { X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RADAR_DISMISS_LABELS, RADAR_DISMISS_REASONS, type RadarDismissReason } from "@/lib/radar/types";

/**
 * The card's ✕: asks why before hiding it, because the answer changes future picks
 * (`RADAR_DISMISS_REASONS`). Shared by person cards and opportunity finds.
 */
export function DismissMenu({
  label,
  disabled,
  onDismiss,
}: {
  /** The trigger's accessible name, e.g. "Dismiss the suggestion about Priya". */
  label: string;
  disabled?: boolean;
  onDismiss: (reason: RadarDismissReason) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        title="Hide this"
        disabled={disabled}
        className="tap-target inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-ink disabled:opacity-50"
      >
        <X className="size-4" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Why hide this?</DropdownMenuLabel>
        {RADAR_DISMISS_REASONS.map((reason) => (
          <DropdownMenuItem key={reason} onClick={() => onDismiss(reason)}>
            {RADAR_DISMISS_LABELS[reason]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
