"use client";

import { useRef, useState, useTransition } from "react";
import { markFeedbackTypingAdminAction, replyToFeedbackAction } from "@/actions/admin";
import { ThreadMessages, useLiveThread, useTypingPing } from "@/components/feedback/feedback-thread-view";
import {
  ArrowUp,
  Camera,
  CircleCheck,
  CircleHelp,
  Gift,
  Heart,
  ListPlus,
  Mail,
  MessageSquareText,
  SearchX,
  Users,
  Ban,
  type LucideIcon,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/errors";
import {
  MAX_THANKS_CREDITS,
  MAX_THREAD_MESSAGE,
  QUICK_ANSWERS,
  THANKS_CREDIT_OPTIONS,
  type ThanksCredits,
} from "@/lib/feedback-report";
import type { FeedbackThread } from "@/lib/feedback-thread";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** An icon for each quick answer, by its label in `QUICK_ANSWERS`. */
const QUICK_ICON: Record<string, LucideIcon> = {
  Fixed: CircleCheck,
  "On the list": ListPlus,
  "Need detail": CircleHelp,
  "Screenshot?": Camera,
  "Can't reproduce": SearchX,
  "Not planned": Ban,
  "Thank you": Heart,
};

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
  related = [],
}: {
  initial: FeedbackThread;
  reporterLabel: string;
  hasEmail: boolean;
  /** Other open reports about the same thing (triage's duplicates), to answer all at once. */
  related?: { id: string; label: string }[];
}) {
  const { thread, setThread, showPending } = useLiveThread(initial, "operator");
  // The reporter sees your typing dots while you write.
  const typed = useTypingPing(initial.id, markFeedbackTypingAdminAction);
  const [body, setBody] = useState("");
  const [resolve, setResolve] = useState(initial.status !== "resolved");
  const [credits, setCredits] = useState<ThanksCredits | null>(null);
  /** What's typed in the custom amount box; a valid number there is also `credits`. */
  const [custom, setCustom] = useState("");
  // Emailing the FIRST reply is what tells them the conversation exists; after that the bell
  // does, and an email per message would be noise.
  const [email, setEmail] = useState(hasEmail && !initial.open);
  // On by default: telling everyone who hit it is the point of a "fixed" reply.
  const [toRelated, setToRelated] = useState(related.length > 0);
  const [pending, start] = useTransition();
  const field = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const text = body.trim();
    if (!text || pending) return;
    // On screen at once; the server's copy (with any gift on it) replaces it when it lands.
    const drop = showPending(text);
    setBody("");
    start(async () => {
      try {
        const result = await replyToFeedbackAction({
          id: thread.id,
          body: text,
          resolve,
          thankCredits: credits,
          email,
          includeRelated: toRelated && related.length > 0,
        });
        drop();
        setThread(result.thread);
        setCredits(null);
        setCustom("");
        setEmail(false);
        setResolve(false);
        setToRelated(false);
        const extras = [
          result.credited && "credits added",
          result.emailed && "emailed",
          result.alsoSent > 0 && `also sent to ${result.alsoSent} other${result.alsoSent === 1 ? "" : "s"}`,
        ].filter(Boolean);
        toast.success(extras.length ? `Sent — ${extras.join(", ")}` : "Sent");
        if (email && !result.emailed) toast.error("The email copy didn’t send — they’ll still see it in Orbit");
      } catch (err) {
        drop();
        setBody(text);
        toast.error(friendlyError(err, "That reply didn’t send — try again?"));
      }
    });
  };

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border/60">
      {/* The conversation as the person sees it, with room to read. */}
      <div className="max-h-[60vh] min-h-72 overflow-y-auto p-4">
        <ThreadMessages thread={thread} viewer="operator" reporterLabel={reporterLabel} />
      </div>

      <div className="grid gap-2 border-t border-border/60 bg-muted/20 p-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick answers">
          {QUICK_ANSWERS.map((answer) => {
            const Icon = QUICK_ICON[answer.label] ?? MessageSquareText;
            return (
              <button
                key={answer.label}
                type="button"
                title={answer.text}
                onClick={() => {
                  setBody(answer.text);
                  field.current?.focus();
                }}
                className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
              >
                <Icon className="size-3.5" aria-hidden />
                {answer.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-end gap-2">
          <Textarea
            ref={field}
            value={body}
            maxLength={MAX_THREAD_MESSAGE}
            rows={2}
            placeholder={thread.open ? "Reply to them…" : "Reply to start the conversation…"}
            aria-label="Your reply"
            className="min-h-10 flex-1 resize-none rounded-2xl bg-background"
            onChange={(e) => {
              setBody(e.target.value);
              if (e.target.value.trim()) typed();
            }}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter sends here: an operator writes longer replies with line breaks.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            type="button"
            aria-label={pending ? "Sending" : "Send reply"}
            title="Send (⌘↵)"
            disabled={!body.trim() || pending}
            onClick={send}
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
          >
            <ArrowUp className="size-4" aria-hidden />
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {thread.status !== "resolved" && (
            <OptionCard
              icon={CircleCheck}
              title="Resolve on send"
              hint="Marks it done for them"
              checked={resolve}
              onChange={setResolve}
            />
          )}
          <OptionCard
            icon={Mail}
            title="Also email"
            hint={hasEmail ? "A copy they can answer from their inbox" : "No address on file"}
            checked={email}
            disabled={!hasEmail}
            onChange={setEmail}
          />
          {related.length > 0 && (
            <OptionCard
              icon={Users}
              title={`+${related.length} who reported this`}
              hint="Send the same reply to each"
              checked={toRelated}
              onChange={setToRelated}
              tooltip={related.map((r) => r.label).join("\n")}
            />
          )}
          {thread.thanksCredits == null ? (
            <div
              role="group"
              aria-label="Thank with credits"
              className={cn(
                "grid gap-2 rounded-xl border p-3 transition-colors sm:col-span-2",
                credits ? "border-gold/60 bg-gold/10" : "border-border/60 bg-background"
              )}
            >
              <div className="flex items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-full bg-gold/15">
                  <Gift className="size-3.5 text-gold-ink" aria-hidden />
                </span>
                <span className="grid">
                  <span className="text-sm font-medium">Thank with credits</span>
                  <span className="text-xs text-muted-foreground">
                    {credits ? `They unwrap ${credits} AI credits with this reply` : "A gift they unwrap in the chat"}
                  </span>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {THANKS_CREDIT_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={credits === n && !custom}
                    onClick={() => {
                      setCustom("");
                      setCredits(credits === n && !custom ? null : n);
                    }}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-medium tabular-nums transition-colors",
                      credits === n && !custom
                        ? "border-gold bg-gold/20 text-gold-ink"
                        : "border-border/70 bg-background text-muted-foreground hover:border-gold/60 hover:text-foreground"
                    )}
                  >
                    {n}
                  </button>
                ))}
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_THANKS_CREDITS}
                  step={1}
                  value={custom}
                  placeholder="Custom"
                  aria-label={`Custom amount, 1 to ${MAX_THANKS_CREDITS} credits`}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setCustom(raw);
                    const n = Number(raw);
                    setCredits(raw && Number.isInteger(n) && n >= 1 && n <= MAX_THANKS_CREDITS ? n : null);
                  }}
                  className={cn(
                    "h-7 w-24 rounded-full border bg-background px-3 text-xs tabular-nums outline-none focus-visible:border-gold focus-visible:ring-3 focus-visible:ring-gold/30",
                    custom ? "border-gold text-gold-ink" : "border-border/70"
                  )}
                />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-gold/40 bg-gold/10 p-3 text-sm sm:col-span-2">
              <Gift className="size-4 text-gold-ink" aria-hidden />
              Thanked with {thread.thanksCredits} credits
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One reply option as a card: icon, title, a line on what it does, and Orbit's checkbox. */
function OptionCard({
  icon: Icon,
  title,
  hint,
  checked,
  disabled,
  onChange,
  tooltip,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  tooltip?: string;
}) {
  return (
    <label
      title={tooltip}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-xl border p-3 transition-colors",
        checked ? "border-primary/50 bg-primary/5" : "border-border/60 bg-background hover:border-primary/30",
        disabled && "cursor-not-allowed opacity-50"
      )}
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full",
          checked ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
        )}
      >
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="grid min-w-0 flex-1">
        <span className="text-sm font-medium">{title}</span>
        <span className="truncate text-xs text-muted-foreground">{hint}</span>
      </span>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} />
    </label>
  );
}
