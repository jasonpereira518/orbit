"use client";

import { useEffect, useId, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "@/lib/toast";
import { draftMessages, editDraft } from "@/actions/outreach-messages";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/errors";
import { EDITABLE_STATUSES } from "@/lib/outreach-message-view";
import { LINKEDIN_NOTE_MAX, type OutreachChannel } from "@/lib/outreach-types";
import { TOAST_COPY } from "@/lib/toast-copy";
import { cn } from "@/lib/utils";

/**
 * One message, as the Messages tab shows it: editable while it is a draft, read-only after.
 *
 * Save writes through `editDraft`; Rewrite asks `draftMessages` for a fresh first message for
 * this person (drafting only rewrites first messages, so a follow-up has no Rewrite). What is
 * on screen is what is typed, but what gets sent or copied is what is saved, so the row tells
 * its parent while there are unsaved edits or a Save or Rewrite is running (`onDirtyChange`).
 */
export function MessageEditorRow({
  campaignId,
  prospectId,
  messageId,
  channel,
  status,
  stepIndex = 0,
  subject,
  body,
  canRewrite = true,
  onUpdated,
  onDirtyChange,
}: {
  campaignId: string;
  prospectId: string;
  messageId: string;
  channel: OutreachChannel;
  status: string;
  /** 0 for the first message, 1 for the follow-up. */
  stepIndex?: number;
  subject: string | null;
  body: string;
  /** Rewrite spends the user’s AI key. */
  canRewrite?: boolean;
  onUpdated?: () => void;
  onDirtyChange?: (messageId: string, dirty: boolean) => void;
}) {
  const counterId = useId();
  const editable = EDITABLE_STATUSES.includes(status);
  const isFollowUp = stepIndex > 0;
  // A follow-up goes out as "Re: <the first subject>", worked out when it is sent, so whatever
  // is typed here would be ignored: show it instead of offering it.
  const subjectLocked = channel === "email" && isFollowUp;

  const [localSubject, setLocalSubject] = useState(subject ?? "");
  const [localBody, setLocalBody] = useState(body);
  // When what is saved changes (a Rewrite landed, or it was saved) the boxes show it.
  const [seen, setSeen] = useState({ subject: subject ?? "", body });
  if (seen.subject !== (subject ?? "") || seen.body !== body) {
    setSeen({ subject: subject ?? "", body });
    setLocalSubject(subject ?? "");
    setLocalBody(body);
  }
  const [busy, setBusy] = useState<"save" | "rewrite" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The server trims what it saves, so a trailing space alone is not a change to protect.
  const dirty =
    editable &&
    (localBody.trim() !== body.trim() ||
      (channel === "email" && !subjectLocked && localSubject.trim() !== (subject ?? "").trim()));
  // A Save or Rewrite in flight counts too: server actions run one at a time, so a send or a
  // copy pressed meanwhile would queue behind it and then take the text it just wrote, which
  // the user has not seen.
  useEffect(() => {
    onDirtyChange?.(messageId, dirty || busy !== null);
  }, [onDirtyChange, messageId, dirty, busy]);
  // A row that goes away (sent, removed) no longer has edits to protect.
  useEffect(() => () => onDirtyChange?.(messageId, false), [onDirtyChange, messageId]);

  async function save() {
    if (busy) return;
    setBusy("save");
    setProblem(null);
    try {
      const res = await editDraft(messageId, {
        subject: channel === "email" ? (subjectLocked ? subject : localSubject) : null,
        body: localBody,
      });
      if (!res.ok) setProblem(res.error);
      else {
        toast.success("Draft saved");
        onUpdated?.();
      }
    } catch (err) {
      setProblem(friendlyError(err, TOAST_COPY.saveFailed));
    } finally {
      setBusy(null);
    }
  }

  async function rewrite() {
    if (busy) return;
    setBusy("rewrite");
    setProblem(null);
    try {
      const res = await draftMessages(campaignId, [prospectId]);
      if (!res.ok) setProblem(res.error);
      else if (!res.value.drafted) setProblem(TOAST_COPY.draftRefineFailed);
      else {
        toast.success("Draft rewritten");
        onUpdated?.();
      }
    } catch (err) {
      setProblem(friendlyError(err, TOAST_COPY.draftRefineFailed));
    } finally {
      setBusy(null);
    }
  }

  if (!editable) {
    return (
      <div className="space-y-1.5 rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
        {channel === "email" && subject && (
          <p>
            <span className="text-muted-foreground">Subject </span>
            {subject}
          </p>
        )}
        <p className="whitespace-pre-wrap text-ink/90">{body}</p>
      </div>
    );
  }

  // `.length`, as the server counts, of the text it would save (trimmed).
  const length = localBody.trim().length;
  const over = channel === "linkedin" && length > LINKEDIN_NOTE_MAX;

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-background/50 p-3">
      {channel === "email" &&
        (subjectLocked ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Subject </span>
            {subject}
            <span className="block text-xs text-muted-foreground">Sent as a reply in the same thread</span>
          </p>
        ) : (
          <Input
            value={localSubject}
            onChange={(e) => setLocalSubject(e.target.value)}
            placeholder="Subject"
            aria-label="Subject"
            maxLength={200}
          />
        ))}
      <Textarea
        value={localBody}
        onChange={(e) => setLocalBody(e.target.value)}
        rows={channel === "linkedin" ? 4 : 6}
        maxLength={5000}
        placeholder="Message draft"
        aria-label="Message draft"
        aria-describedby={channel === "linkedin" ? counterId : undefined}
      />
      {channel === "linkedin" && (
        <div className="flex flex-wrap items-baseline gap-x-3">
          <p id={counterId} className={cn("text-xs", over ? "text-destructive" : "text-muted-foreground")}>
            {length} / {LINKEDIN_NOTE_MAX}
          </p>
          {/* Said once when the note goes over, not on every keystroke after. */}
          <p role="status" className="text-xs text-destructive empty:hidden">
            {over ? `Over LinkedIn’s ${LINKEDIN_NOTE_MAX}-character limit — shorten it to copy` : ""}
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={save} disabled={busy !== null || !dirty}>
          {busy === "save" && <Loader2 className="animate-spin" aria-hidden />}
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
        {!isFollowUp && (
          <Button
            size="sm"
            variant="ghost"
            onClick={rewrite}
            disabled={busy !== null || !canRewrite}
            title={canRewrite ? undefined : "Add an AI key to rewrite drafts"}
          >
            {busy === "rewrite" ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            {busy === "rewrite" ? "Rewriting…" : "Rewrite"}
          </Button>
        )}
        {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
      </div>
      <p role="status" className="text-xs text-destructive empty:hidden">
        {problem}
      </p>
    </div>
  );
}
