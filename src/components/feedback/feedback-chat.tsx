"use client";

import { ArrowUp } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { markFeedbackTyping, sendFeedbackMessage } from "@/actions/feedback";
import { ThreadMessages, useLiveThread, useTypingPing } from "@/components/feedback/feedback-thread-view";
import { refreshPulse } from "@/lib/app-pulse-store";
import {
  AREA_LABELS,
  FEEDBACK_AREAS,
  FEEDBACK_RECIPIENT,
  MAX_THREAD_MESSAGE,
  type FeedbackArea,
} from "@/lib/feedback-report";
import type { FeedbackThread } from "@/lib/feedback-thread";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<FeedbackThread["status"], string> = {
  new: "Sent",
  triaged: `${FEEDBACK_RECIPIENT}'s looking at it`,
  resolved: "Done",
};

const KIND_LABEL: Record<string, string> = {
  bug: "Broken",
  idea: "Idea",
  confusing: "Confusing",
  praise: "Worked well",
};

/** The conversation's one-line context: kind · area · status ("Idea · Contacts · Done"). */
export function threadMeta(thread: FeedbackThread): string {
  const area = thread.report.area;
  return [
    thread.category ? KIND_LABEL[thread.category] : null,
    area && (FEEDBACK_AREAS as readonly string[]).includes(area) ? AREA_LABELS[area as FeedbackArea] : null,
    STATUS_LABEL[thread.status],
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The reporter's side of a feedback conversation, laid out like a messages app: the thread
 * scrolls and a rounded reply field sits pinned at the bottom. Live while it is open
 * (streamed, see `useLiveThread`), with typing dots both ways. The reply field appears once the
 * operator has replied, because that is when there is someone on the other end.
 *
 * Fills its parent's height; the parent supplies the header (subject and context line).
 */
export function FeedbackChat({
  initial,
  onNavigate,
}: {
  initial: FeedbackThread;
  /** Called when they follow a link out of the chat — the panel uses it to close itself. */
  onNavigate?: () => void;
}) {
  const { thread, setThread, showPending } = useLiveThread(initial, "user");
  const [body, setBody] = useState("");
  const [, start] = useTransition();
  const typed = useTypingPing(thread.id, markFeedbackTyping);

  // Opening it marked the conversation read on the server; ask the bell to re-read now rather
  // than on its next 90-second tick, so the "replied" item clears while you're looking.
  useEffect(() => {
    void refreshPulse(true);
  }, []);

  const send = () => {
    const text = body.trim();
    if (!text) return;
    // On screen at once, like any message; the server's copy replaces it when it lands.
    const drop = showPending(text);
    setBody("");
    start(async () => {
      const result = await sendFeedbackMessage(thread.id, text);
      drop();
      if (!result.ok) {
        toast.error(result.message);
        setBody(text);
        return;
      }
      setThread(result.thread);
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <ThreadMessages thread={thread} viewer="user" onNavigate={onNavigate} />
      </div>

      {thread.open ? (
        <form
          className="flex shrink-0 items-end gap-2 border-t border-border/60 px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            value={body}
            maxLength={MAX_THREAD_MESSAGE}
            rows={1}
            placeholder={`Message ${FEEDBACK_RECIPIENT}`}
            aria-label={`Message ${FEEDBACK_RECIPIENT}`}
            className="field-sizing-content max-h-32 min-h-9 flex-1 resize-none rounded-2xl border border-border bg-background px-3.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
            onChange={(e) => {
              setBody(e.target.value);
              if (e.target.value.trim()) typed();
            }}
            // Enter sends like a message, on a fine pointer only — the same rule as the
            // new-message form (`feedback-panel.tsx`).
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              if (!window.matchMedia("(pointer: fine)").matches) return;
              e.preventDefault();
              send();
            }}
          />
          <button
            type="submit"
            aria-label="Send"
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity",
              !body.trim() && "opacity-40"
            )}
          >
            <ArrowUp className="size-4" aria-hidden />
          </button>
        </form>
      ) : (
        <p className="shrink-0 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
          {FEEDBACK_RECIPIENT} hasn&apos;t replied yet. You&apos;ll get a notification when he does, and
          you can carry on the conversation right here.
        </p>
      )}
    </div>
  );
}
