"use client";

import { MessageSquarePlus } from "lucide-react";
import { useEffect, useState } from "react";
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
/**
 * How long the button stays darkened after a press.
 *
 * Long enough to be seen: a click can be shorter than the eye registers, so `:active`
 * alone flashes nothing on a quick tap. The button's own 120ms background transition then
 * carries it back, so the whole acknowledgement runs about 300ms.
 */
const PRESS_MS = 180;

export function FeedbackTrigger({
  className,
  tooltip = false,
}: {
  className?: string;
  /** Desktop rail only. Touch has no hover, and the bell beside it has none either. */
  tooltip?: boolean;
}) {
  const state = useFeedbackPanelState();

  /**
   * A brief darkening on press, then back.
   *
   * Timed rather than `:active`, which only holds while the pointer is down — and it is
   * deliberately NOT the `aria-expanded` darkening the outline variant provides, which
   * stayed on for as long as the window was open and read as the button being stuck. This
   * is an acknowledgement of the press itself: it happens, then it is over.
   *
   * Declared before the `capturing` bail-out below, because hooks cannot sit behind an
   * early return — and the effect's cleanup is what stops the timer surviving the unmount
   * that bail-out causes.
   */
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    if (!pressed) return;
    const timer = setTimeout(() => setPressed(false), PRESS_MS);
    return () => clearTimeout(timer);
  }, [pressed]);

  // Gone from the tree, not merely transparent: `getDisplayMedia` photographs the
  // composited output, so a faded button would still be in the picture.
  if (state === "capturing") return null;

  const button = (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label="Send feedback"
      // A disclosure for a docked region, not a popup: the panel is not a dialog and does not
      // trap focus. Pressing this while it is open just brings you back into it — the panel
      // closes only from its own close control.
      aria-controls="feedback-dock"
      aria-expanded={state === "open"}
      // Hidden while the panel is open, like the bell: the panel has its own close control and
      // this button would just sit beside it pointing at the thing already on screen.
      // `invisible` (not `hidden`) keeps its place so nothing shifts, and takes it out of the
      // tab order; it is back the moment the close is requested, so focus can return to it.
      //
      // `aria-expanded:bg-background/90` cancels the `aria-expanded:bg-muted` the outline
      // variant applies, for the frame or two it is still showing as it fades out.
      className={cn(
        "size-10 rounded-full border-border/70 bg-background/90 shadow-md backdrop-blur-md hover:bg-background aria-expanded:bg-background/90",
        // Beats both the resting fill and the hover, so the press still reads while the
        // pointer is sitting on the button — which it always is.
        pressed && "bg-muted hover:bg-muted aria-expanded:bg-muted",
        "transition-[opacity,visibility,background-color] duration-base motion-reduce:transition-none",
        state === "open" && "pointer-events-none invisible opacity-0",
        className
      )}
      // `e.currentTarget` rather than a ref: every copy anchors itself, so nothing has to
      // plumb a ref across the mount boundary to the widget.
      onClick={(e) => {
        setPressed(true);
        requestFeedbackOpen(anchorBelowTrigger(e.currentTarget));
      }}
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
