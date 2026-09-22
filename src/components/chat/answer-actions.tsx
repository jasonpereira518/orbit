"use client";

import { useState } from "react";
import { Check, Copy, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { setChatMessageFeedback } from "@/actions/chat";

/**
 * Copy, retry and thumbs on a finished answer.
 *
 * Only rendered for answers that were actually saved: an id minted on the client (a stopped
 * or failed turn) has no row to rate, so the feedback buttons would fail on click. Copy and
 * retry still work there, because neither needs the answer to exist server-side.
 */

export type AnswerActionsProps = {
  messageId: string;
  answer: string;
  /** False for a client-only id — a stopped or errored turn that was never persisted. */
  persisted: boolean;
  initialFeedback?: "up" | "down" | null;
  onRetry?: () => void;
  /** "Ask again" by default; the last answer in a thread says "Regenerate" instead. */
  retryLabel?: string;
  className?: string;
};

export function AnswerActions({
  messageId,
  answer,
  persisted,
  initialFeedback = null,
  onRetry,
  retryLabel = "Ask again",
  className,
}: AnswerActionsProps) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(initialFeedback);
  const [saving, setSaving] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(answer);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused outright (permissions, an insecure origin), and
      // there is no fallback worth faking — say so rather than showing a tick that lied.
      toast.error("Couldn’t copy that — try selecting the text instead");
    }
  }

  async function rate(value: "up" | "down") {
    if (saving) return;
    const previous = feedback;
    // Optimistic, because the button is the whole interaction — waiting a round trip to
    // fill in makes it feel broken. Reverted below if the write actually fails.
    const next = feedback === value ? null : value;
    setFeedback(next);
    setSaving(true);
    try {
      const res = await setChatMessageFeedback(messageId, value);
      setFeedback(res.feedback);
      // Silent on un-set — clicking the same thumbs again to take it back isn't an event
      // worth a toast, only actually sending a rating is.
      if (res.feedback) toast.success("Thanks — sent as feedback");
    } catch (err) {
      setFeedback(previous);
      toast.error(friendlyError(err, "Couldn’t save that — try again?"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <ActionButton label={copied ? "Copied" : "Copy answer"} onClick={copy}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </ActionButton>

      {onRetry && (
        <ActionButton label={retryLabel} onClick={onRetry}>
          <RefreshCw className="size-3.5" />
        </ActionButton>
      )}

      {persisted && (
        <>
          <ActionButton
            label="Good answer"
            pressed={feedback === "up"}
            onClick={() => void rate("up")}
          >
            <ThumbsUp className={cn("size-3.5", feedback === "up" && "fill-current")} />
          </ActionButton>
          <ActionButton
            label="Bad answer"
            pressed={feedback === "down"}
            onClick={() => void rate("down")}
          >
            <ThumbsDown className={cn("size-3.5", feedback === "down" && "fill-current")} />
          </ActionButton>
        </>
      )}
    </div>
  );
}

function ActionButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(
        "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        pressed && "text-primary hover:text-primary"
      )}
    >
      {children}
    </button>
  );
}
