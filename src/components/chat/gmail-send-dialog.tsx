"use client";

import { AlertTriangle, Check, Copy, ExternalLink, Loader2, Mail } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "@/lib/toast";

import { startGmailOAuth } from "@/actions/gmail";
import { getChatSendContext, sendChatDraftViaGmail, type ChatSendContext } from "@/actions/chat-send";
import { useChatThreadId } from "@/components/chat/chat-thread-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SEND_SUBJECT_MAX, checkContent } from "@/lib/chat-send";
import { stashSendResume } from "@/lib/chat-send-resume";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

/**
 * The confirmation step before a chat draft is emailed from the user's own Gmail.
 *
 * It shows what will actually happen — From, To, Subject and the final body — and sends only
 * on the button press. The address shown is the contact record's; nothing here lets the person
 * (or the model) type a different recipient, and the server re-checks that it is unchanged.
 *
 * Every state that is not "ready" says what to do next instead of failing after the click: a
 * plan without Gmail send gets Copy and a mail link, a missing permission gets the connect
 * button, a contact with no usable address is told so.
 */
export function GmailSendDialog({
  open,
  onOpenChange,
  messageId,
  contactId,
  name,
  body,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId: string;
  contactId: string;
  name: string;
  /** The draft as it currently reads, including the person's edits. */
  body: string;
  /** Called with the send time; `ambiguous` when Gmail may or may not have accepted it. */
  onSent: (sentAtIso: string, ambiguous: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (busy && !next ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        {/* Mounted only while open, so it fetches fresh and forgets on close. */}
        <SendPanel
          messageId={messageId}
          contactId={contactId}
          name={name}
          body={body}
          busy={busy}
          setBusy={setBusy}
          onClose={() => onOpenChange(false)}
          onSent={onSent}
        />
      </DialogContent>
    </Dialog>
  );
}

function SendPanel({
  messageId,
  contactId,
  name,
  body,
  busy,
  setBusy,
  onClose,
  onSent,
}: {
  messageId: string;
  contactId: string;
  name: string;
  body: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onClose: () => void;
  onSent: (sentAtIso: string, ambiguous: boolean) => void;
}) {
  const id = useId();
  const threadId = useChatThreadId();
  const [ctx, setCtx] = useState<ChatSendContext | null | "unavailable">(null);
  const [subject, setSubject] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getChatSendContext(messageId, contactId)
      .then((res) => {
        if (cancelled) return;
        setCtx(res ?? "unavailable");
        if (res) setSubject(res.defaultSubject);
      })
      .catch(() => {
        if (!cancelled) setCtx("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [messageId, contactId]);

  // What will go, cleaned exactly as the server will clean it.
  const content = checkContent({ subject, body });
  const finalBody = content.ok ? content.body : body;

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      stashSendResume({ threadId, messageId, contactId, body, subject });
      const { url } = await startGmailOAuth({
        purpose: "send",
        returnTo: threadId ? `/chat?thread=${encodeURIComponent(threadId)}` : "/chat",
      });
      window.location.href = url;
    } catch (err) {
      setBusy(false);
      toast.error(friendlyError(err, TOAST_COPY.connectFailed));
    }
  }, [threadId, messageId, contactId, body, subject, setBusy]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(finalBody);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Couldn’t copy that — try selecting the text instead");
    }
  }

  async function send() {
    if (ctx === null || ctx === "unavailable" || !ctx.to || !content.ok) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await sendChatDraftViaGmail({
        messageId,
        contactId,
        subject: content.subject,
        body: content.body,
        shownTo: ctx.to,
      });
      if (res.ok) {
        toast.success(`Sent to ${name}`);
        onSent(res.sentAt, false);
        onClose();
        return;
      }
      if (res.reason === "ambiguous") {
        // Stay honest and stay out of the way: it may have gone, so the card must not offer
        // to send it again, but nothing should claim it did.
        toast.message(res.message);
        onSent(new Date().toISOString(), true);
        onClose();
        return;
      }
      if (res.reason === "already_sent") {
        onSent(new Date().toISOString(), false);
        onClose();
        return;
      }
      if (res.reason === "needs_reconnect" || res.reason === "missing_scope" || res.reason === "not_connected") {
        setCtx({ ...ctx, identity: { ...ctx.identity, canSend: false, connected: res.reason !== "not_connected" } });
      }
      setProblem(res.message);
    } catch (err) {
      setProblem(friendlyError(err, "Couldn’t send that — nothing was sent. Try again?"));
    } finally {
      setBusy(false);
    }
  }

  const mailto =
    ctx && ctx !== "unavailable" && ctx.to
      ? `mailto:${ctx.to}?subject=${encodeURIComponent(content.ok ? content.subject : subject)}&body=${encodeURIComponent(finalBody)}`
      : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Send to {name}</DialogTitle>
        <DialogDescription>
          Check what will be sent. It goes only when you press Send.
        </DialogDescription>
      </DialogHeader>

      {ctx === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Getting ready…
        </p>
      ) : ctx === "unavailable" ? (
        <p className="text-sm text-muted-foreground" role="alert">
          Couldn’t open this draft for sending. Close it and try again.
        </p>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          {ctx.planAllows && ctx.identity.connected && ctx.identity.sendingAs && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">From</dt>
              <dd className="min-w-0 break-words font-medium">
                {ctx.identity.displayName ? `${ctx.identity.displayName} <${ctx.identity.sendingAs}>` : ctx.identity.sendingAs}
              </dd>
              <dt className="text-muted-foreground">To</dt>
              <dd className="min-w-0 break-words font-medium">{ctx.to ?? "—"}</dd>
            </dl>
          )}
          {!(ctx.planAllows && ctx.identity.connected && ctx.identity.sendingAs) && ctx.to && (
            <p>
              <span className="text-muted-foreground">To </span>
              <span className="font-medium">{ctx.to}</span>
            </p>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-subject`} className="text-xs font-medium text-muted-foreground">
              Subject
            </label>
            <Input
              id={`${id}-subject`}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={SEND_SUBJECT_MAX}
              disabled={busy}
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Message</span>
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/70 bg-muted/40 p-2.5 text-sm">
              {finalBody}
            </p>
          </div>

          <Blocker ctx={ctx} name={name} contactId={contactId} onConnect={connect} busy={busy} />

          {ctx.planAllows && ctx.identity.connected && ctx.identity.sendingAs && ctx.identity.canSend && !ctx.recipientProblem && !ctx.alreadySent && (
            <p className="text-xs text-muted-foreground">
              Replies land in this inbox, and the email appears in your Sent folder.
            </p>
          )}

          {problem && (
            <p className="flex items-start gap-2 text-sm text-foreground" role="alert">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>{problem}</span>
            </p>
          )}
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {ctx && ctx !== "unavailable" && !ctx.planAllows ? (
          <>
            <Button type="button" variant="outline" onClick={copy}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />} Copy
            </Button>
            {mailto && (
              <Button type="button" render={<a href={mailto} />}>
                <ExternalLink className="size-4" /> Open in mail app
              </Button>
            )}
          </>
        ) : (
          <Button
            type="button"
            onClick={send}
            disabled={
              busy ||
              ctx === null ||
              ctx === "unavailable" ||
              !ctx.identity.canSend ||
              Boolean(ctx.recipientProblem) ||
              Boolean(ctx.alreadySent) ||
              !content.ok
            }
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Mail className="size-4" aria-hidden />}
            Send email
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/** The one thing standing between this dialog and a send, stated plainly, or nothing. */
function Blocker({
  ctx,
  name,
  contactId,
  onConnect,
  busy,
}: {
  ctx: ChatSendContext;
  name: string;
  contactId: string;
  onConnect: () => void;
  busy: boolean;
}) {
  if (!ctx.planAllows) {
    return (
      <p className="text-sm text-muted-foreground">
        Sending from Gmail is a Pro feature. You can copy this draft or open it in your mail app instead.
      </p>
    );
  }
  if (ctx.alreadySent) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Check className="size-4" aria-hidden /> Already sent to {name}
        {ctx.alreadySent.at ? ` on ${new Date(ctx.alreadySent.at).toLocaleString()}` : ""}.
      </p>
    );
  }
  if (ctx.recipientProblem) {
    const text =
      ctx.recipientProblem === "no_email"
        ? `There’s no email address for ${name} yet.`
        : ctx.recipientProblem === "placeholder"
          ? "That’s a placeholder address, so there’s no real inbox to send to."
          : "The email address on this contact doesn’t look like a single valid address.";
    return (
      <p className="text-sm text-muted-foreground">
        {text}{" "}
        <Link href={`/contacts/${contactId}`} className="underline underline-offset-2 hover:text-foreground">
          Open their profile
        </Link>{" "}
        to fix it.
      </p>
    );
  }
  if (!ctx.identity.connected) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border/70 p-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          Connect Gmail to send from your own address.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onConnect} disabled={busy}>
          Connect Gmail
        </Button>
      </div>
    );
  }
  if (!ctx.identity.canSend) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/40 p-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Allow Gmail to send</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Sending from your own address needs Google’s permission to send as you, which Orbit asks for only when you want it.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onConnect} disabled={busy}>
          Allow
        </Button>
      </div>
    );
  }
  return null;
}
