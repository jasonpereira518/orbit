"use client";

import { Sparkles } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { getMyFeedbackThread, sendFeedbackMessage } from "@/actions/feedback";
import { ThreadMessages, usePolledThread } from "@/components/feedback/feedback-thread-view";
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
 * The reporter's side of a feedback conversation. Live while it is open (polled, see
 * `usePolledThread`); the composer appears once the operator has replied, because that is
 * when there is someone on the other end.
 */
export function FeedbackChat({ initial }: { initial: FeedbackThread }) {
  const [thread, setThread] = usePolledThread(initial, getMyFeedbackThread);
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();

  // The page marked the conversation read on the server; ask the bell to re-read now rather
  // than on its next 90-second tick, so the "replied" item clears while you're looking.
  useEffect(() => {
    void refreshPulse(true);
  }, []);

  const send = () => {
    if (!body.trim() || pending) return;
    start(async () => {
      const result = await sendFeedbackMessage(thread.id, body);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setThread(result.thread);
      setBody("");
    });
  };

  return (
    <div className="grid gap-4">
      <p className="text-xs text-muted-foreground">
        Status: <span className="font-medium text-foreground">{STATUS_LABEL[thread.status]}</span>
      </p>

      {thread.thanksCredits != null && (
        <p className="flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
          <Sparkles className="size-4 shrink-0 text-accent-foreground" aria-hidden />
          {FEEDBACK_RECIPIENT} added {thread.thanksCredits} bonus AI credits to your account as a thank-you.
        </p>
      )}

      <div className="rounded-2xl border border-border/60 bg-card p-4">
        <ThreadMessages thread={thread} viewer="user" />
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
