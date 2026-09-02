"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Eye, Send, TestTube2 } from "lucide-react";
import { ConfirmActionDialog } from "@/components/admin/confirm-action-dialog";
import {
  createBroadcastAction,
  sendBroadcastTestAction,
} from "@/actions/admin";
import { BODY_MAX, SUBJECT_MAX } from "@/lib/broadcast-limits";
import { cn } from "@/lib/utils";

/**
 * Compose a note to the interest list.
 *
 * SAVING AND SENDING ARE SEPARATE, deliberately. This screen only ever creates a draft; the
 * send lives on the draft's own row behind its own confirmation. A compose-and-send button
 * is one mis-click away from mailing everybody, and unlike every other action in this
 * console that one cannot be undone.
 *
 * The body is plain text. The send wraps it in the same shell the welcome note uses, so an
 * operator writes prose rather than markup and a broadcast cannot ship broken HTML to a
 * whole list.
 */
export function BroadcastComposer({ audienceSize }: { audienceSize: number }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [testTo, setTestTo] = useState("");
  const [pending, startTransition] = useTransition();

  const ready = subject.trim().length >= 3 && body.trim().length >= 20;

  const saveDraft = () =>
    startTransition(async () => {
      try {
        await createBroadcastAction({ subject, body });
        toast.success("Draft saved. Send it from the list below.");
        setSubject("");
        setBody("");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't save that.");
      }
    });

  const sendTest = () =>
    startTransition(async () => {
      try {
        await sendBroadcastTestAction({ subject, body, to: testTo.trim() });
        toast.success(`Test sent to ${testTo.trim()}.`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "The test send failed.");
      }
    });

  return (
    <div className="space-y-4">
      <label className="block space-y-1.5">
        <span className="flex items-baseline justify-between text-xs font-medium">
          Subject
          <span
            className={cn(
              "tabular-nums",
              subject.length > SUBJECT_MAX ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {subject.length}/{SUBJECT_MAX}
          </span>
        </span>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="What's new in Orbit"
          className="w-full rounded-lg border border-border/70 bg-transparent px-3 py-2 text-sm outline-none focus:border-primary/50"
        />
      </label>

      <label className="block space-y-1.5">
        <span className="flex items-baseline justify-between text-xs font-medium">
          Body
          <span
            className={cn(
              "tabular-nums",
              body.length > BODY_MAX ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {body.length}/{BODY_MAX}
          </span>
        </span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          placeholder={
            "Plain text. A blank line starts a new paragraph.\n\nThe first paragraph is set larger, as the opening line."
          }
          className="w-full resize-y rounded-lg border border-border/70 bg-transparent px-3 py-2 text-sm leading-relaxed outline-none focus:border-primary/50"
        />
        <span className="block text-xs text-muted-foreground">
          The Orbit header, sign-off and unsubscribe footer are added automatically.
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-4">
        <ConfirmActionDialog
          trigger={
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-sm transition-colors duration-fast",
                ready
                  ? "text-primary hover:border-primary/50"
                  : "pointer-events-none text-muted-foreground/40"
              )}
            >
              <Send className="size-3.5" aria-hidden />
              Save draft
            </span>
          }
          title="Save this as a draft?"
          description={
            <>
              Nothing is sent yet. It goes to the list below, where sending is a separate,
              confirmed step — the audience is currently{" "}
              <span className="font-medium text-ink">{audienceSize}</span>{" "}
              {audienceSize === 1 ? "person" : "people"}.
            </>
          }
          confirmLabel="Save draft"
          onConfirm={async () => saveDraft()}
        />

        <span className="mx-1 h-4 w-px bg-border/60" aria-hidden />

        <input
          type="email"
          value={testTo}
          onChange={(e) => setTestTo(e.target.value)}
          placeholder="you@example.com"
          aria-label="Send a test to"
          className="w-48 rounded-lg border border-border/70 bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-primary/50"
        />
        <button
          type="button"
          disabled={!ready || !testTo.includes("@") || pending}
          onClick={sendTest}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-xs text-muted-foreground transition-colors duration-fast hover:text-primary disabled:pointer-events-none disabled:opacity-40"
        >
          <TestTube2 className="size-3.5" aria-hidden />
          Send test
        </button>

        <a
          href="/api/admin/email-preview?template=broadcast"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors duration-fast hover:text-primary"
        >
          <Eye className="size-3.5" aria-hidden />
          Preview shell
        </a>
      </div>
    </div>
  );
}
