"use client";

/**
 * Hide an event by clicking the 'X' at the top right, or bring a hidden one back.
 *
 * When an event is active (hidden=false), clicking the 'X' removes it from the active
 * list and moves it to the hidden pool at the bottom.
 *
 * When in the hidden pool (hidden=true), clicking "Add back" restores it to active events.
 *
 * Undo is offered via toast so an accidental hide is instant to reverse.
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, X } from "lucide-react";
import { runToastAction } from "@/lib/toast";
import { dismissEvent, restoreEvent } from "@/actions/events";

function useSafeRouter() {
  try {
    return useRouter();
  } catch {
    return null;
  }
}

export function DismissEventButton({
  eventId,
  title,
  hidden = false,
}: {
  eventId: string;
  title: string;
  hidden?: boolean;
}) {
  const router = useSafeRouter();
  const [pending, start] = useTransition();

  function act(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    start(async () => {
      await runToastAction({
        run: () => (hidden ? restoreEvent(eventId) : dismissEvent(eventId)),
        success: hidden ? `“${title}” is back` : `Hidden — “${title}” won’t come back`,
        failure: hidden ? "Couldn’t restore that event" : "Couldn’t hide that event",
        refresh: () => router?.refresh(),
        undo: hidden ? undefined : () => () => restoreEvent(eventId),
        undone: "Back on your events",
      });
    });
  }

  if (hidden) {
    return (
      <button
        type="button"
        onClick={act}
        disabled={pending}
        className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-1 text-2xs font-medium text-white shadow-sm transition-all hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Add back ${title}`}
      >
        {pending ? (
          <Loader2 className="size-3 animate-spin" aria-hidden />
        ) : (
          <Plus className="size-3" aria-hidden />
        )}
        <span>Add back</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={act}
      disabled={pending}
      className="absolute right-2 top-2 z-10 flex size-6 items-center justify-center rounded-full bg-black/60 text-white/90 backdrop-blur-sm transition-all hover:bg-black/85 hover:text-white hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Hide ${title}`}
      title="Hide this event"
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <X className="size-3.5" aria-hidden />
      )}
    </button>
  );
}
