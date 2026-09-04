"use client";

import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  requestFeedbackOpen,
  useFeedbackPanelState,
} from "@/lib/feedback-events";
import { originFromTrigger } from "@/lib/floating-panel";
import { cn } from "@/lib/utils";

/**
 * The "Send feedback" button, wherever it appears.
 *
 * One component for both the desktop rail and the mobile header, rather than the two
 * hand-kept-in-step copies the notifications bell has — the classes, the fade, the
 * accessible name and the capture bail-out all live here and cannot drift apart.
 *
 * It carries no panel of its own. Every copy asks the single mounted `FeedbackWidget` to
 * open, via `src/lib/feedback-events.ts`, because that widget owns one shared draft.
 */
export function FeedbackTrigger({
  className,
  tooltip = false,
}: {
  className?: string;
  /** Desktop rail only. Touch has no hover, and the bell beside it has none either. */
  tooltip?: boolean;
}) {
  const state = useFeedbackPanelState();

  // Gone from the tree, not merely transparent: `getDisplayMedia` photographs the
  // composited output, so a faded button would still be in the picture.
  if (state === "capturing") return null;

  const open = state === "open";

  const button = (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label="Send feedback"
      aria-haspopup="dialog"
      aria-expanded={open}
      className={cn(
        "size-10 rounded-full border-border/70 bg-background/90 shadow-md backdrop-blur-md transition-opacity hover:bg-background",
        // The open window covers this exact spot, and the glass is see-through enough that
        // the button would read as a smudge underneath it. Hiding it also sells the
        // illusion that the button became the panel. Opacity rather than `hidden`, so it
        // stays focusable for the focus Base UI returns here on close. Straight from
        // `notifications-panel.tsx` — the two windows open the same way.
        open
          ? "pointer-events-none opacity-0 duration-fast"
          : // Held back until the closing window has almost finished collapsing onto this
            // spot, so the two are never on screen together.
            "opacity-100 delay-100 duration-base",
        className
      )}
      // `e.currentTarget` rather than a ref: every copy anchors itself, so nothing has to
      // plumb a ref across the mount boundary to the widget.
      onClick={(e) => requestFeedbackOpen(originFromTrigger(e.currentTarget))}
    >
      <MessageSquarePlus className="h-4 w-4" />
    </Button>
  );

  if (!tooltip) return button;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="left">Send feedback</TooltipContent>
    </Tooltip>
  );
}
