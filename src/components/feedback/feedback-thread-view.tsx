"use client";

import { formatDistanceToNow } from "date-fns";
import { useEffect, useRef, useState } from "react";
import { FEEDBACK_RECIPIENT, THREAD_POLL_MS } from "@/lib/feedback-report";
import type { FeedbackThread } from "@/lib/feedback-thread";
import { cn } from "@/lib/utils";

/**
 * Keep a feedback conversation current while it is on screen: re-read it every
 * `THREAD_POLL_MS`, but only while the tab is visible — a backgrounded tab polling a server
 * action forever is cost with nobody watching. Coming back to the tab reads at once.
 */
export function usePolledThread(
  initial: FeedbackThread,
  load: (id: string) => Promise<FeedbackThread | null>
) {
  const [thread, setThread] = useState(initial);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await loadRef.current(initial.id);
        if (!cancelled && next) setThread(next);
      } catch {
        // A missed poll is not worth a toast; the next one will try again.
      }
    };
    const timer = window.setInterval(tick, THREAD_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [initial.id]);

  return [thread, setThread] as const;
}

/**
 * The conversation as bubbles: the report first, then every message, with the viewer's own
 * on the right. Shared by the reporter's chat page and the operator's console so both sides
 * see the same thing.
 */
export function ThreadMessages({
  thread,
  viewer,
  reporterLabel = "You",
}: {
  thread: FeedbackThread;
  viewer: "user" | "operator";
  /** What the reporter's side is called — "You" for them, their email for the operator. */
  reporterLabel?: string;
}) {
  const endRef = useRef<HTMLLIElement>(null);
  const count = thread.messages.length;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [count]);

  const bubbles = [
    { id: "report", author: "user" as const, body: thread.report.text ?? "", createdAt: thread.report.createdAt },
    ...thread.messages,
  ];

  return (
    <ol className="flex flex-col gap-3" aria-label="Conversation" aria-live="polite">
      {bubbles.map((m) => {
        const mine = m.author === viewer;
        return (
          <li key={m.id} className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
            <div
              className={cn(
                "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                mine ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-muted text-foreground"
              )}
            >
              {m.body || <span className="italic opacity-70">(no text)</span>}
            </div>
            <span className="px-1 text-[0.7rem] text-muted-foreground">
              {m.author === "operator" ? FEEDBACK_RECIPIENT : reporterLabel} ·{" "}
              {formatDistanceToNow(new Date(m.createdAt), { addSuffix: true })}
            </span>
          </li>
        );
      })}
      <li ref={endRef} aria-hidden className="h-0" />
    </ol>
  );
}
