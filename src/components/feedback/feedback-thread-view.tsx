"use client";

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
        shots: [],
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
 * Throttled "I'm typing" pings for the dots on the other side: at most one every couple of
 * seconds while keys are going, so a fast typist costs a request every 2.5s, not per key.
 */
export function useTypingPing(feedbackId: string, ping: (id: string) => Promise<void>) {
  const lastRef = useRef(0);
  return useCallback(() => {
    const now = Date.now();
    if (now - lastRef.current < 2_500) return;
    lastRef.current = now;
    void ping(feedbackId).catch(() => {});
  }, [feedbackId, ping]);
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "just now", "4 min ago", "3 hr ago", "2 days ago" — alongside the clock time. */
function agoLabel(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.floor(hr / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** A clock that ticks every 30s, so "2 min ago" doesn't sit there saying 2 forever. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** The round avatar beside the other side's messages. */
export function ThreadAvatar({ label, size = 22 }: { label: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full bg-primary/10 font-medium text-primary"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * The conversation as a messages app draws it: day separators, the viewer's own bubbles on the
 * right in teal, the other side's on the left in grey with an avatar beside the last of a run,
 * a "Read" under your last message once the other side has opened it, the thank-you gift
 * under the reply that carried it, and typing dots while the other side is writing.
 *
 * Shared by the reporter's panel and the operator's console so both see the same thing.
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
  const other = viewer === "user" ? "operator" : "user";
  const otherLabel = other === "operator" ? FEEDBACK_RECIPIENT : reporterLabel;
  const bubbles: ThreadMessage[] = [
    {
      id: "report",
      author: "user",
      body: thread.report.text ?? "",
      credits: null,
      shots: thread.report.shots,
      createdAt: thread.report.createdAt,
    },
    ...thread.messages,
  ];

  // Where "Read" goes: under the viewer's newest message, when the other side opened the
  // conversation after it was sent. Pending (unsent) copies never count.
  const mineSent = bubbles.filter((m) => m.author === viewer && !m.id.startsWith("pending-"));
  const lastMine = mineSent.at(-1);
  const otherReadAt = thread.readAt[other];
  const readId =
    lastMine && otherReadAt && Date.parse(otherReadAt) >= Date.parse(lastMine.createdAt) ? lastMine.id : null;
  const typing = thread.typing[other];
  const now = useNow();

  const endRef = useRef<HTMLLIElement>(null);
  const count = thread.messages.length;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [count, typing]);

  return (
    <ol className="flex flex-col gap-1" aria-label="Conversation" aria-live="polite">
      {bubbles.map((m, i) => {
        const mine = m.author === viewer;
        const prev = bubbles[i - 1];
        const next = bubbles[i + 1];
        const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
        // The avatar sits beside the LAST bubble of a run from the other side.
        const endOfRun = !next || next.author !== m.author || m.credits != null;
        const pending = m.id.startsWith("pending-");
        return (
          <li key={m.id} className="flex flex-col">
            {newDay && (
              <span className="my-2 self-center text-[0.7rem] text-muted-foreground">{dayLabel(m.createdAt)}</span>
            )}
            <div className={cn("flex items-end gap-1.5", mine ? "justify-end" : "justify-start")}>
              {!mine && (endOfRun ? <ThreadAvatar label={otherLabel} /> : <span className="w-[22px] shrink-0" />)}
              <div
                title={timeLabel(m.createdAt)}
                className={cn(
                  "max-w-[78%] whitespace-pre-wrap px-3 py-1.5 text-sm leading-relaxed",
                  mine
                    ? "rounded-2xl rounded-br-md bg-primary text-primary-foreground"
                    : "rounded-2xl rounded-bl-md bg-muted text-foreground",
                  pending && "opacity-70"
                )}
              >
                {m.body || <span className="italic opacity-70">(no text)</span>}
              </div>
            </div>
            {/* Screenshots sent with it: tap one for the full picture. */}
            {m.shots.length > 0 && (
              <div className={cn("mt-1 flex flex-wrap gap-1.5", mine ? "justify-end" : "pl-7")}>
                {m.shots.map((shotId, n) => (
                  <a
                    key={shotId}
                    href={`/api/feedback/screenshots/${shotId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="block overflow-hidden rounded-xl border border-border focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- served by an auth-checked route */}
                    <img
                      src={`/api/feedback/screenshots/${shotId}`}
                      alt={`Screenshot ${n + 1}`}
                      loading="lazy"
                      className="h-24 w-36 object-cover"
                    />
                  </a>
                ))}
              </div>
            )}
            {/* The time under the last message of a run: clock time and how long ago, plus
                "Read" on your newest once the other side has seen it. */}
            {(pending || endOfRun || m.id === readId) && (
              <span
                className={cn(
                  "mt-0.5 text-[0.7rem] text-muted-foreground",
                  mine ? "self-end pr-1" : "pl-8"
                )}
              >
                {pending ? (
                  "Sending…"
                ) : (
                  <>
                    <time dateTime={m.createdAt}>{timeLabel(m.createdAt)}</time> · {agoLabel(m.createdAt, now)}
                    {m.id === readId && " · Read"}
                  </>
                )}
              </span>
            )}
            {/* The thank-you this reply carried. The reporter unwraps it; the operator just
                sees that it went. */}
            {m.credits != null &&
              (() => {
                // Each gift is opened or not by when it came: unwrapping stamps a time, and a
                // thank-you sent after it is a new one, still wrapped.
                const opened = thread.thanksSeenAt != null && thread.thanksSeenAt >= m.createdAt;
                return viewer === "user" ? (
                <div className="mt-1.5 pl-7">
                  <ThanksGift feedbackId={thread.id} credits={m.credits} seen={opened} onNavigate={onNavigate} />
                </div>
              ) : (
                <span className="mt-1 inline-flex w-fit items-center gap-1 self-end rounded-full bg-gold/15 px-2 py-0.5 text-[0.7rem] text-gold-ink">
                  <Gift className="size-3" aria-hidden />+{m.credits} credits sent
                  {opened ? " · opened" : ""}
                </span>
              );
              })()}
          </li>
        );
      })}
      {typing && (
        <li className="mt-1 flex items-end gap-1.5" aria-label={`${otherLabel} is typing`}>
          <ThreadAvatar label={otherLabel} />
          <span className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-muted px-3 py-2.5">
            {[0, 1, 2].map((d) => (
              <span
                key={d}
                className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 motion-reduce:animate-none"
                style={{ animationDelay: `${d * 140}ms` }}
              />
            ))}
          </span>
        </li>
      )}
      <li ref={endRef} aria-hidden className="h-0" />
    </ol>
  );
}
