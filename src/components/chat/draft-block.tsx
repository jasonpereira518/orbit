"use client";

import { AlertTriangle, Check, Copy, Loader2, Mail, UserPlus } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { saveChatDraftBlock } from "@/actions/chat";
import { GmailSendDialog } from "@/components/chat/gmail-send-dialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DRAFT_MAX_CHARS } from "@/lib/chat-draft";
import {
  DRAFT_SUBJECT_MAX,
  LINKEDIN_NOTE_MAX,
  LINKEDIN_NOTE_STORE_MAX,
  mayUseNote,
  noteStatus,
  noteStatusText,
  type DraftParts,
} from "@/lib/chat-draft-block";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** Quiet this long after the last keystroke, then the edit is saved. */
const SAVE_AFTER_MS = 700;
/** Below this many characters left the counter starts to say so. */
const NEAR_LIMIT = 20;

export type DraftSegment = DraftParts & { index: number; closed: boolean };

/**
 * A draft the assistant wrote into its answer, as a block you can edit where it stands: an
 * email's Subject and Body, or one connection-request note with a live count against
 * LinkedIn's limit (`@/lib/chat-draft-block`). While the answer is still arriving it is a plain
 * preview; once the block is complete it becomes the editor.
 */
export function DraftBlock({
  draft,
  streaming,
  messageId,
  name,
  onSaved,
}: {
  draft: DraftSegment;
  /** The answer is still arriving (or was cut off): show the text, do not edit it. */
  streaming: boolean;
  /** The saved answer this block lives in. Absent until it is saved: edits wait for it. */
  messageId?: string;
  /** Who it is for, when the answer named a contact. */
  name?: string | null;
  /** Told the text each time a save lands, so the message in memory matches what is stored. */
  onSaved?: (index: number, edit: { subject: string; body: string }) => void;
}) {
  if (streaming || !draft.closed) return <DraftPreview draft={draft} name={name} live={streaming} />;
  return <DraftEditorBlock draft={draft} messageId={messageId} name={name} onSaved={onSaved} />;
}

function kindLabel(channel: DraftParts["channel"]) {
  return channel === "email" ? "Email draft" : "LinkedIn connection note";
}

function Header({ channel, name, children }: { channel: DraftParts["channel"]; name?: string | null; children?: React.ReactNode }) {
  const Icon = channel === "email" ? Mail : UserPlus;
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <Badge variant="secondary" className="gap-1 text-3xs">
          <Icon className="size-3" aria-hidden />
          {kindLabel(channel)}
        </Badge>
        {name && <span className="min-w-0 truncate text-xs text-muted-foreground">for {name}</span>}
      </div>
      {children}
    </div>
  );
}

const SHELL = "my-1 rounded-lg border border-border/70 bg-muted/40 p-3 text-sm";

function DraftPreview({ draft, name, live }: { draft: DraftSegment; name?: string | null; live: boolean }) {
  return (
    <div className={SHELL} role="group" aria-label={`${kindLabel(draft.channel)}${live ? ", being written" : ", cut off"}`} aria-busy={live}>
      <Header channel={draft.channel} name={name}>
        <span className="flex items-center gap-1 text-2xs text-muted-foreground">
          {live ? (
            <>
              <Loader2 className="size-3 animate-spin" aria-hidden /> Writing…
            </>
          ) : (
            "Cut off before it finished"
          )}
        </span>
      </Header>
      {draft.channel === "email" && draft.subject && <p className="mb-1 font-medium">{draft.subject}</p>}
      <p className="whitespace-pre-wrap text-foreground/90">{draft.body}</p>
    </div>
  );
}

type SaveState = "idle" | "saving" | "saved" | "failed" | "empty";

function DraftEditorBlock({
  draft,
  messageId,
  name,
  onSaved,
}: {
  draft: DraftSegment;
  messageId?: string;
  name?: string | null;
  onSaved?: (index: number, edit: { subject: string; body: string }) => void;
}) {
  const id = useId();
  const email = draft.channel === "email";
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [save, setSave] = useState<SaveState>("idle");
  const [copied, setCopied] = useState(false);
  const [confirmCopy, setConfirmCopy] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sent, setSent] = useState<{ at: string; maybe: boolean } | null>(null);

  // What was last written and what is waiting to be, read by the timer and the blur handler.
  const latest = useRef({ subject, body });
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageRef = useRef(messageId);
  const savedRef = useRef(onSaved);
  useLayoutEffect(() => {
    messageRef.current = messageId;
    savedRef.current = onSaved;
  });

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const id = messageRef.current;
    if (!dirty.current || !id) return; // an unsaved answer keeps the edit until it has a row
    const { subject: s, body: b } = latest.current;
    if (!b.trim()) {
      setSave("empty");
      return;
    }
    dirty.current = false;
    setSave("saving");
    try {
      const res = await saveChatDraftBlock(id, draft.index, { subject: s, body: b });
      if (res.saved) {
        setSave("saved");
        savedRef.current?.(draft.index, { subject: res.subject ?? s, body: res.body ?? b });
      } else {
        dirty.current = true;
        setSave("failed");
      }
    } catch {
      dirty.current = true;
      setSave("failed");
    }
  }, [draft.index]);

  // The answer was saved after the person started editing: write what they have.
  useEffect(() => {
    if (messageId) void flush();
  }, [messageId, flush]);
  // Leaving with an edit still waiting writes it.
  useEffect(() => () => void flush(), [flush]);

  function edited(nextSubject: string, nextBody: string) {
    latest.current = { subject: nextSubject, body: nextBody };
    dirty.current = true;
    setConfirmCopy(false);
    setSave("idle");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_AFTER_MS);
  }

  const note = noteStatus(body);
  const band = note.over ? "over" : note.remaining <= NEAR_LIMIT ? "near" : "ok";
  // Said once when the band changes, not on every keystroke.
  const [announce, setAnnounce] = useState("");
  const lastBand = useRef(band);
  useEffect(() => {
    if (email || lastBand.current === band) return;
    lastBand.current = band;
    setAnnounce(band === "ok" ? "Back under the LinkedIn limit" : noteStatusText(noteStatus(latest.current.body)));
  }, [band, email]);

  async function copy(acknowledged = false) {
    if (!email) {
      const gate = mayUseNote(body, acknowledged);
      if (!gate.ok) {
        setConfirmCopy(true);
        return;
      }
    }
    try {
      await navigator.clipboard.writeText(email && subject.trim() ? `Subject: ${subject.trim()}\n\n${body.trim()}` : body.trim());
      setConfirmCopy(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Couldn’t copy that — try selecting the text instead");
    }
  }

  const canSend = email && Boolean(messageId && draft.contactId) && body.trim().length > 0;
  const status =
    save === "saving"
      ? "Saving…"
      : save === "saved"
        ? "Saved"
        : save === "failed"
          ? "Couldn’t save — your text is still here"
          : save === "empty"
            ? "Not saved — a draft can’t be empty"
            : "";

  return (
    <div className={SHELL} role="group" aria-label={`${kindLabel(draft.channel)}${name ? ` for ${name}` : ""}`}>
      <Header channel={draft.channel} name={name}>
        <span
          role="status"
          aria-live="polite"
          className={cn("text-2xs", save === "failed" || save === "empty" ? "text-destructive" : "text-muted-foreground")}
        >
          {status}
        </span>
      </Header>

      {email && (
        <div className="mb-2 flex flex-col gap-1">
          <label htmlFor={`${id}-subject`} className="text-xs font-medium text-muted-foreground">
            Subject
          </label>
          <Input
            id={`${id}-subject`}
            value={subject}
            maxLength={DRAFT_SUBJECT_MAX}
            onChange={(e) => {
              setSubject(e.target.value);
              edited(e.target.value, body);
            }}
            onBlur={() => void flush()}
          />
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-body`} className="text-xs font-medium text-muted-foreground">
          {email ? "Message" : "Note"}
        </label>
        <Textarea
          id={`${id}-body`}
          value={body}
          maxLength={email ? DRAFT_MAX_CHARS : LINKEDIN_NOTE_STORE_MAX}
          aria-invalid={!email && note.over ? true : undefined}
          aria-describedby={email ? undefined : `${id}-count`}
          onChange={(e) => {
            setBody(e.target.value);
            edited(subject, e.target.value);
          }}
          onBlur={() => void flush()}
          className="min-h-20 bg-background text-sm md:text-sm"
        />
        {!email && (
          <div className="flex items-center justify-between gap-2 text-xs">
            <span
              id={`${id}-count`}
              className={cn("tabular-nums", note.over ? "font-medium text-destructive" : band === "near" ? "text-foreground" : "text-muted-foreground")}
            >
              {note.over && <AlertTriangle className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />}
              {note.length}/{LINKEDIN_NOTE_MAX}
              {note.over ? ` · ${-note.remaining} over LinkedIn’s limit` : ""}
            </span>
            <span className="sr-only" role="status" aria-live="polite">
              {announce}
            </span>
          </div>
        )}
      </div>

      {confirmCopy && (
        <div
          role="alert"
          className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-foreground"
        >
          <span className="min-w-0 flex-1">
            This note is {-note.remaining} characters over LinkedIn’s {LINKEDIN_NOTE_MAX}-character limit, so LinkedIn will cut it off or
            refuse it.
          </span>
          <span className="flex gap-1.5">
            <button type="button" onClick={() => void copy(true)} className={ACTION}>
              Copy anyway
            </button>
            <button type="button" onClick={() => setConfirmCopy(false)} className={ACTION}>
              Keep editing
            </button>
          </span>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => void copy()} className={ACTION}>
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? "Copied" : email ? "Copy email" : "Copy note"}
        </button>
        {canSend &&
          (sent ? (
            <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Check className="size-3.5" aria-hidden />
              {sent.maybe ? "May have been sent — check your Sent folder" : `Sent${name ? ` to ${name}` : ""}`}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void flush().then(() => setSendOpen(true))}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-2.5 py-1 text-2xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              <Mail className="size-3.5" aria-hidden /> Send email…
            </button>
          ))}
      </div>

      {canSend && (
        <GmailSendDialog
          open={sendOpen}
          onOpenChange={setSendOpen}
          messageId={messageId!}
          contactId={draft.contactId!}
          name={name ?? "them"}
          body={body}
          subject={subject}
          onSent={(at, maybe) => setSent({ at, maybe })}
          onUndone={() => setSent(null)}
        />
      )}
    </div>
  );
}

const ACTION =
  "inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1 text-2xs font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50";
