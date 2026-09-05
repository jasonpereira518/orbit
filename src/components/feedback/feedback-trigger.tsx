"use client";

import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  requestFeedbackOpen,
  useFeedbackPanelState,
} from "@/lib/feedback-events";
import { anchorBelowTrigger } from "@/lib/floating-panel";
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

  const button = (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label="Send feedback"
      aria-haspopup="dialog"
      aria-expanded={state === "open"}
      // Stays visible while the panel is open. The bell ducks out because the notifications
      // window lands ON TOP of it and is pretending to be it; this window opens BELOW the
      // rail instead, so there is nothing to hide behind and fading would just read as the
      // button disappearing.
      //
      // `aria-expanded:bg-background/90` cancels the `aria-expanded:bg-muted` the outline
      // variant applies. That darkening is a reasonable "this is open" cue for a control
      // you can still see the panel next to, but here the panel is a 24rem window directly
      // below the button — nothing about it is ambiguous — and the button just sat there
      // looking pressed for as long as the form was open. The bell keeps the darkening and
      // never shows it, because it fades out.
      className={cn(
        "size-10 rounded-full border-border/70 bg-background/90 shadow-md backdrop-blur-md hover:bg-background aria-expanded:bg-background/90",
        className
      )}
      // `e.currentTarget` rather than a ref: every copy anchors itself, so nothing has to
      // plumb a ref across the mount boundary to the widget.
      onClick={(e) => requestFeedbackOpen(anchorBelowTrigger(e.currentTarget))}
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
