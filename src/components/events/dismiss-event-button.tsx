"use client";

/**
 * Hide an auto-added event, or bring a hidden one back.
 *
 * Only the restore half is rendered today — the hidden list on the events page — because the
 * card no longer offers "not mine" (see `event-card.tsx`). The hide half is unused for now and
 * kept so the control can return elsewhere without re-deriving its Undo behaviour.
 *
 * Undo is offered rather than a confirmation dialog: the action is reversible and cheap.
 * `runToastAction` already decides how Undo behaves everywhere else in the app.
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { EyeOff, Loader2, Undo2 } from "lucide-react";
import { runToastAction } from "@/lib/toast";
import { dismissEvent, restoreEvent } from "@/actions/events";

export function DismissEventButton({
  eventId,
  title,
  hidden = false,
}: {
  eventId: string;
  title: string;
  hidden?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function act() {
    start(async () => {
      await runToastAction({
        run: () => (hidden ? restoreEvent(eventId) : dismissEvent(eventId)),
        success: hidden ? `“${title}” is back` : `Hidden — “${title}” won’t come back`,
        failure: hidden ? "Couldn’t restore that event" : "Couldn’t hide that event",
        refresh: () => router.refresh(),
        // No Undo on the restore: the button itself is already the inverse, sitting in
        // exactly the place the user is looking.
        undo: hidden ? undefined : () => () => restoreEvent(eventId),
        undone: "Back on your events",
      });
    });
  }

  return (
    <button
      type="button"
      onClick={act}
      disabled={pending}
      // Always reachable, not hover-only: a touch device has no hover, and this is the
      // control that makes an unwanted suggestion go away.
      className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 text-[11px] font-medium text-white opacity-80 transition-opacity hover:opacity-100 focus-visible:opacity-100"
      aria-label={hidden ? `Restore ${title}` : `Hide ${title} — not mine`}
    >
      {pending ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : hidden ? (
        <Undo2 className="size-3" aria-hidden />
      ) : (
        <EyeOff className="size-3" aria-hidden />
      )}
      {hidden ? "Restore" : "Not mine"}
    </button>
  );
}
