"use client";

import { useEffect, useState, useTransition } from "react";
import { sendFeedbackMessage } from "@/actions/feedback";
import { ThreadMessages, useLiveThread } from "@/components/feedback/feedback-thread-view";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { refreshPulse } from "@/lib/app-pulse-store";
import { FEEDBACK_RECIPIENT, MAX_THREAD_MESSAGE } from "@/lib/feedback-report";
import type { FeedbackThread } from "@/lib/feedback-thread";
import { toast } from "@/lib/toast";

const STATUS_LABEL: Record<FeedbackThread["status"], string> = {
  new: "Sent",
  triaged: `${FEEDBACK_RECIPIENT}'s looking at it`,
  resolved: "Done",
};

/**
 * The reporter's side of a feedback conversation. Live while it is open (streamed, see
 * `useLiveThread`); the composer appears once the operator has replied, because that is
 * when there is someone on the other end.
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
  const [pending, start] = useTransition();

  // The page marked the conversation read on the server; ask the bell to re-read now rather
  // than on its next 90-second tick, so the "replied" item clears while you're looking.
  useEffect(() => {
    void refreshPulse(true);
  }, []);

  const send = () => {
    const text = body.trim();
    if (!text || pending) return;
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
    <div className="grid gap-4">
      {thread.report.subject && (
        <h3 className="text-base font-medium text-foreground">{thread.report.subject}</h3>
      )}
      <p className="text-xs text-muted-foreground">
        Status: <span className="font-medium text-foreground">{STATUS_LABEL[thread.status]}</span>
      </p>

      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <ThreadMessages thread={thread} viewer="user" onNavigate={onNavigate} />
      </div>

      {thread.open ? (
        <div className="grid gap-2">
          <Textarea
            value={body}
            maxLength={MAX_THREAD_MESSAGE}
            rows={3}
            placeholder={`Reply to ${FEEDBACK_RECIPIENT}…`}
            aria-label={`Reply to ${FEEDBACK_RECIPIENT}`}
            onChange={(e) => setBody(e.target.value)}
            // Enter sends like a message, on a fine pointer only — the same rule as the
            // feedback window (`feedback-panel.tsx`).
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              if (!window.matchMedia("(pointer: fine)").matches) return;
              e.preventDefault();
              send();
            }}
          />
          <div className="flex justify-end">
            <Button size="sm" disabled={!body.trim() || pending} onClick={send}>
              {pending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {FEEDBACK_RECIPIENT} hasn&apos;t replied yet. You&apos;ll get a notification when he does, and
          you can carry on the conversation right here.
        </p>
      )}
    </div>
  );
}
