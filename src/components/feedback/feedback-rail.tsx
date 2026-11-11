import { FeedbackTrigger } from "@/components/feedback/feedback-trigger";
import { cn } from "@/lib/utils";

/**
 * The desktop rail copy of the feedback button, directly under the notifications bell.
 *
 * Its own component, mounted straight from `(app)/layout.tsx`, rather than part of
 * `FeedbackWidget`: the widget is a client-only lazy chunk (draft state, screenshot capture),
 * so a button rendered by it appeared a beat after the bell, which comes with the shell's
 * HTML. This is server-rendered with the page; a press before the widget has loaded is not
 * lost, because `requestFeedbackOpen` waits until the widget subscribes
 * (`src/lib/feedback-events.ts`).
 *
 * The offset matches the bell's in `app-shell.tsx`, and moves with the page's right edge the
 * same way (`--orbit-dock-w`, including the dock's 1.25rem tuck).
 */
export function FeedbackRail({ viewingAsUser = false }: { viewingAsUser?: boolean }) {
  return (
    <div
      className={cn(
        "fixed right-5 z-30 hidden md:block md:right-[calc(2rem+var(--orbit-dock-w)-min(1.25rem,var(--orbit-dock-w)))] md:transition-[right] md:duration-slow md:ease-house",
        viewingAsUser ? "top-[5.5rem]" : "top-[4.25rem] md:top-[4.75rem]"
      )}
    >
      <FeedbackTrigger tooltip />
    </div>
  );
}
