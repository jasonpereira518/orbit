"use client";

import { formatDistanceToNow } from "date-fns";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gift } from "lucide-react";
import { ThanksGift } from "@/components/feedback/thanks-gift";
import { FEEDBACK_RECIPIENT } from "@/lib/feedback-report";
import type { FeedbackThread, ThreadMessage } from "@/lib/feedback-thread";
import { cn } from "@/lib/utils";

/**
 * Keep a feedback conversation live: a server-sent event stream
 * (`/api/feedback/[id]/stream`) pushes the thread the moment it changes, so a reply lands on
 * the other side within about a second.
 *
 * Connected only while the tab is visible — a backgrounded tab holding a connection is cost
 * with nobody watching — and reconnected the moment it comes back, when the stream's first
 * event brings it up to date. EventSource reconnects by itself when the server rolls the
 * connection over (about once a minute).
 *
 * Also returns `send`, which shows a message straight away while the server catches up: the
 * pending copy stays until a real message with the same words from the same side arrives.
 */
export function useLiveThread(initial: FeedbackThread, viewer: "user" | "operator") {
  const [thread, setThread] = useState(initial);
  const [pending, setPending] = useState<ThreadMessage[]>([]);

  useEffect(() => {
    const url = `/api/feedback/${initial.id}/stream${viewer === "operator" ? "?as=operator" : ""}`;
    let source: EventSource | null = null;
    const connect = () => {
      if (source || document.visibilityState !== "visible") return;
      source = new EventSource(url);
      source.addEventListener("thread", (event) => {
        try {
          setThread(JSON.parse((event as MessageEvent<string>).data) as FeedbackThread);
        } catch {
          // A malformed frame is skipped; the next change sends the whole thread again.
        }
      });
      source.addEventListener("gone", () => disconnect());
    };
    const disconnect = () => {
      source?.close();
      source = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? connect() : disconnect());
    connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [initial.id, viewer]);

  /** Show it now; returns a function that drops the pending copy (on failure, or once sent). */
  const showPending = useCallback(
    (body: string) => {
      const message: ThreadMessage = {
        id: `pending-${Date.now()}`,
        author: viewer,
        body,
        credits: null,
        createdAt: new Date().toISOString(),
      };
      setPending((prev) => [...prev, message]);
      return () => setPending((prev) => prev.filter((m) => m.id !== message.id));
    },
    [viewer]
  );

  // A pending message disappears as soon as the server's copy of it is in the thread.
  const shown = useMemo<FeedbackThread>(() => {
    const waiting = pending.filter(
      (p) =>
        !thread.messages.some(
          (m) => m.author === p.author && m.body === p.body && Date.parse(m.createdAt) >= Date.parse(p.createdAt) - 10_000
        )
    );
    return waiting.length ? { ...thread, messages: [...thread.messages, ...waiting] } : thread;
  }, [thread, pending]);

  return { thread: shown, setThread, showPending };
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
  onNavigate,
}: {
  thread: FeedbackThread;
  viewer: "user" | "operator";
  /** What the reporter's side is called — "You" for them, their email for the operator. */
  reporterLabel?: string;
  /** The reporter followed a link out of the thread (the gift's "Try them in Chat"). */
  onNavigate?: () => void;
}) {
  const endRef = useRef<HTMLLIElement>(null);
  const count = thread.messages.length;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [count]);

  const bubbles = [
    { id: "report", author: "user" as const, body: thread.report.text ?? "", credits: null, createdAt: thread.report.createdAt },
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
            {/* The thank-you this reply carried. The reporter unwraps it; the operator just
                sees that it went. */}
            {m.credits != null &&
              (viewer === "user" ? (
                <div className="mt-1 w-full">
                  <ThanksGift
                    feedbackId={thread.id}
                    credits={m.credits}
                    seen={thread.thanksSeen}
                    onNavigate={onNavigate}
                  />
                </div>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-gold/15 px-2 py-0.5 text-[0.7rem] text-gold-ink">
                  <Gift className="size-3" aria-hidden />+{m.credits} credits sent
                  {thread.thanksSeen ? " · opened" : ""}
                </span>
              ))}
          </li>
        );
      })}
      <li ref={endRef} aria-hidden className="h-0" />
    </ol>
  );
}
