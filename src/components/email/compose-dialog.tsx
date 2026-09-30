"use client";

import { Loader2, Send, Sparkles } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { draftComposeWithAi, getComposeContextAction, sendComposedEmail } from "@/actions/email-compose";
import { ConnectMailboxButton } from "@/components/email/connect-mailbox-button";
import { RecipientField } from "@/components/email/recipient-field";
import { showUndoSendToast } from "@/components/email/undo-send-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { clearComposeDraft, composeDraftKey, readComposeDraft, writeComposeDraft } from "@/lib/compose-draft";
import type { ComposeRequest } from "@/lib/compose-events";
import type { ComposeContext, ComposeRecipient } from "@/lib/email/compose";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

/**
 * Write an email and send it from the user's own mailbox. It goes out after a 10-second undo
 * window (the outbox), is logged on every matched contact, and answers their due follow-up.
 * An unsent draft is kept in this browser, per contact.
 *
 * One dialog for every screen size: centered from `sm` up, pinned to the bottom below it —
 * CSS, so the server render and the first client paint agree.
 */
export function ComposeDialog({
  request,
  userId,
  open,
  onOpenChange,
}: {
  request: ComposeRequest;
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const key = composeDraftKey(userId, request.contactId);
  const [ctx, setCtx] = useState<ComposeContext | null | "unavailable">(null);
  const [to, setTo] = useState<string[]>(request.to ?? []);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCopies, setShowCopies] = useState(false);
  const [subject, setSubject] = useState(request.subject ?? "");
  const [body, setBody] = useState(request.body ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, startSend] = useTransition();
  const [drafting, startDraft] = useTransition();

  // Context first; then a saved draft (unless the opener handed in content); then the
  // contact's primary address when To is still empty.
  useEffect(() => {
    let cancelled = false;
    getComposeContextAction(request.contactId)
      .then((c) => {
        if (cancelled) return;
        setCtx(c ?? "unavailable");
        const handed = Boolean(request.to?.length || request.subject || request.body);
        const saved = handed ? null : readComposeDraft(window.localStorage, key);
        if (saved) {
          setTo(saved.to);
          setCc(saved.cc);
          setBcc(saved.bcc);
          setShowCopies(saved.cc.length + saved.bcc.length > 0);
          setSubject(saved.subject);
          setBody(saved.body);
        } else if (!request.to?.length && c?.contact?.emails[0]) {
          setTo([c.contact.emails[0]]);
        }
      })
      .catch(() => {
        if (!cancelled) setCtx("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [request, key]);

  // Keep the draft as it's typed, once the saved one (if any) has been restored.
  useEffect(() => {
    if (ctx === null || ctx === "unavailable") return;
    writeComposeDraft(window.localStorage, key, { to, cc, bcc, subject, body });
  }, [ctx, key, to, cc, bcc, subject, body]);

  const ready = ctx !== null && ctx !== "unavailable" ? ctx : null;
  const contact = ready?.contact ?? null;
  const capability = ready?.capability ?? null;

  const suggestions = useMemo<ComposeRecipient[]>(
    () =>
      contact
        ? contact.emails.map((email) => ({ email, contactId: contact.id, name: contact.name, avatarUrl: contact.avatarUrl }))
        : [],
    [contact]
  );

  const canSend = Boolean(capability?.ok) && to.length > 0 && body.trim().length > 0 && !sending;

  function draftWithAi() {
    const contactId = request.contactId;
    if (!contactId) return;
    startDraft(async () => {
      const res = await draftComposeWithAi(contactId);
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      setBody(res.body);
      setSubject((s) => (s.trim() ? s : "Following up"));
    });
  }

  function send() {
    setProblem(null);
    const snapshot = { to, cc, bcc, subject, body };
    startSend(async () => {
      try {
        const res = await sendComposedEmail({ ...snapshot, contactId: request.contactId });
        if (!res.ok) {
          setProblem(res.message);
          return;
        }
        clearComposeDraft(window.localStorage, key);
        onOpenChange(false);
        const who = contact?.name ?? res.to[0] ?? "them";
        const others = res.to.length - 1;
        showUndoSendToast({
          sendId: res.sendId,
          recipientLabel: others > 0 ? `${who} and ${others} more` : who,
          onUndone: () => {
            // Nothing went out: keep what was written so it can be fixed and sent again.
            writeComposeDraft(window.localStorage, key, snapshot);
            router.refresh();
          },
        });
        router.refresh();
      } catch (err) {
        setProblem(friendlyError(err, "Couldn’t send that — nothing was sent. Try again?"));
      }
    });
  }

  const title = contact ? `Email ${contact.name}` : "New email";
  const lowOnSends = capability?.ok && capability.remainingToday <= Math.ceil(capability.dailyCap / 4);

  return (
    <Dialog open={open} onOpenChange={(next) => (sending && !next ? undefined : onOpenChange(next))}>
      <DialogContent className="gap-3 sm:max-w-xl max-sm:top-auto max-sm:bottom-3 max-sm:max-h-[85dvh] max-sm:translate-y-0 max-sm:overflow-y-auto max-sm:rounded-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Sends from your own email after a 10-second undo window.</DialogDescription>
        </DialogHeader>

        {ctx === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Getting ready…
          </p>
        ) : ctx === "unavailable" ? (
          <p className="text-sm text-muted-foreground" role="alert">
            Couldn’t open the composer. Close it and try again.
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-2 text-sm">
            <div className="flex min-h-9 items-center gap-2 border-b border-border/60 py-1.5">
              <span className="w-10 shrink-0 text-xs font-medium text-muted-foreground">From</span>
              {capability?.ok ? (
                <span className="min-w-0 truncate font-medium">{capability.fromEmail}</span>
              ) : capability && capability.reason !== "cap_reached" ? (
                <ConnectMailboxButton reason={capability.reason} returnTo={pathname || "/contacts"} />
              ) : (
                <span className="text-muted-foreground">You’ve reached today’s email limit</span>
              )}
            </div>
            <div className="flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <RecipientField
                  id="compose-to"
                  label="To"
                  value={to}
                  onChange={setTo}
                  suggestions={suggestions}
                  autoFocus={!to.length}
                />
              </div>
              {!showCopies && (
                <button
                  type="button"
                  className="shrink-0 px-1 pt-2.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setShowCopies(true)}
                >
                  Cc/Bcc
                </button>
              )}
            </div>
            {showCopies && (
              <>
                <RecipientField id="compose-cc" label="Cc" value={cc} onChange={setCc} />
                <RecipientField id="compose-bcc" label="Bcc" value={bcc} onChange={setBcc} />
              </>
            )}
            <Input
              aria-label="Subject"
              placeholder="Subject"
              value={subject}
              maxLength={200}
              onChange={(e) => setSubject(e.target.value)}
              className="rounded-none border-0 border-b border-border/60 px-0 shadow-none focus-visible:ring-0"
              autoFocus={to.length > 0 && !subject}
            />
            <Textarea
              aria-label="Message"
              rows={9}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message…"
              className="min-h-40 resize-y border-0 px-0 shadow-none focus-visible:ring-0"
            />
            {ready?.signature && (
              <p className="whitespace-pre-wrap text-xs text-muted-foreground" aria-label="Signature">
                {`-- \n${ready.signature}`}
              </p>
            )}
            {problem && (
              <p className="text-sm text-destructive" role="alert">
                {problem}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div>
                {request.contactId && (
                  <Button type="button" variant="outline" size="sm" onClick={draftWithAi} disabled={drafting || sending}>
                    {drafting ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                    Draft with AI
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {lowOnSends && capability?.ok && (
                  <span className="text-xs text-muted-foreground">{capability.remainingToday} left today</span>
                )}
                <Button type="button" size="sm" onClick={send} disabled={!canSend}>
                  {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                  Send
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
