"use client";

import { useRef, useState, useTransition } from "react";
import { getFeedbackThreadAdminAction, replyToFeedbackAction } from "@/actions/admin";
import { ThreadMessages, usePolledThread } from "@/components/feedback/feedback-thread-view";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/errors";
import {
  MAX_THREAD_MESSAGE,
  QUICK_ANSWERS,
  THANKS_CREDIT_OPTIONS,
  type ThanksCredits,
} from "@/lib/feedback-report";
import type { FeedbackThread } from "@/lib/feedback-thread";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Talk to the person who sent this report.
 *
 * The first reply opens the conversation on their side — a bell notification, a chat page, and
 * (by default) an emailed copy they can answer from their inbox. Quick answers drop a starting
 * line into the box to edit; nothing is sent until Send.
 */
export function FeedbackConversation({
  initial,
  reporterLabel,
  hasEmail,
}: {
  initial: FeedbackThread;
  reporterLabel: string;
  hasEmail: boolean;
}) {
  const [thread, setThread] = usePolledThread(initial, getFeedbackThreadAdminAction);
  const [body, setBody] = useState("");
  const [resolve, setResolve] = useState(initial.status !== "resolved");
  const [credits, setCredits] = useState<ThanksCredits | null>(null);
  // Emailing the FIRST reply is what tells them the conversation exists; after that the bell
  // does, and an email per message would be noise.
  const [email, setEmail] = useState(hasEmail && !initial.open);
  const [pending, start] = useTransition();
  const field = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    if (!body.trim() || pending) return;
    start(async () => {
      try {
        const result = await replyToFeedbackAction({
          id: thread.id,
          body,
          resolve,
          thankCredits: credits,
          email,
        });
        setThread(result.thread);
        setBody("");
        setCredits(null);
        setEmail(false);
        setResolve(false);
        const extras = [result.credited && "credits added", result.emailed && "emailed"].filter(Boolean);
        toast.success(extras.length ? `Sent — ${extras.join(", ")}` : "Sent");
        if (email && !result.emailed) toast.error("The email copy didn’t send — they’ll still see it in Orbit");
      } catch (err) {
        toast.error(friendlyError(err, "That reply didn’t send — try again?"));
      }
    });
  };

  return (
    <div className="grid gap-4">
      <div className="max-h-[28rem] overflow-y-auto rounded-xl border border-border/60 p-3">
        <ThreadMessages thread={thread} viewer="operator" reporterLabel={reporterLabel} />
      </div>

      <div className="grid gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick answers">
          {QUICK_ANSWERS.map((answer) => (
            <button
              key={answer.label}
              type="button"
              title={answer.text}
              onClick={() => {
                setBody(answer.text);
                field.current?.focus();
              }}
              className="rounded-full border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              {answer.label}
            </button>
          ))}
        </div>
        <Textarea
          ref={field}
          value={body}
          maxLength={MAX_THREAD_MESSAGE}
          rows={4}
          placeholder={thread.open ? "Reply…" : "Reply to start the conversation…"}
          aria-label="Your reply"
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter sends here: an operator writes longer replies with line breaks.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          {thread.status !== "resolved" && (
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} />
              Mark resolved
            </label>
          )}
          {thread.thanksCredits == null ? (
            <span className="inline-flex items-center gap-1.5" role="group" aria-label="Thank with credits">
              Thank with
              {THANKS_CREDIT_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={credits === n}
                  onClick={() => setCredits(credits === n ? null : n)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 tabular-nums transition-colors",
                    credits === n ? "border-primary bg-primary/10 text-foreground" : "border-border/70 hover:text-foreground"
                  )}
                >
                  {n}
                </button>
              ))}
              credits
            </span>
          ) : (
            <span>Thanked with {thread.thanksCredits} credits</span>
          )}
          <label className={cn("inline-flex items-center gap-1.5", !hasEmail && "opacity-50")}>
            <input type="checkbox" checked={email} disabled={!hasEmail} onChange={(e) => setEmail(e.target.checked)} />
            Also email{hasEmail ? "" : " (no address on file)"}
          </label>
          <Button size="sm" className="ml-auto" disabled={!body.trim() || pending} onClick={send}>
            {pending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
