"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import {
  draftContactFollowUp,
  getContactFollowUpSendOptions,
  sendContactFollowUpEmail,
  type ContactFollowUpSendOptions,
} from "@/actions/contacts";
import { completeFollowUpWithTouch } from "@/actions/reminders";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { DraftPurposeRow, editedPurpose } from "@/components/follow-up/draft-purpose-row";
import { FollowUpDraftComposer } from "@/components/follow-up/follow-up-draft-composer";
import { showUndoSendToast } from "@/components/email/undo-send-toast";
import { AiKeyNotice } from "@/components/ai-key-notice";
import { aiDenialFromMessage } from "@/lib/ai-access-copy";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import { recordDraftOutcome } from "@/actions/settings";

export function FollowUpDraftSheet({
  open,
  onOpenChange,
  contactId,
  contactName,
  initialDraft,
  intent,
  subject,
  title,
  description,
  onSent,
  onUndone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  contactName: string;
  /**
   * A draft already written for this person (Radar writes one overnight for Today's cards).
   * Shown the moment the sheet opens, with no model call; Regenerate still asks for a new one.
   */
  initialDraft?: string | null;
  /** Why this message exists ("Congratulate them on …"); every draft asked for here is told. */
  intent?: string;
  /** The email's subject; the send action's "Following up · Name" when absent. */
  subject?: string;
  title?: string;
  description?: string;
  /** The email is queued, or the message was marked sent; `onUndone` follows if Undo takes an email back. */
  onSent?: () => void;
  onUndone?: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [aiDraft, setAiDraft] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("");
  const [pickedPurpose, setPickedPurpose] = useState("");
  // Which channel the draft was written for: picked by Orbit from the intent and the history
  // (`channelFromWords` / `channelFromHistory`), or switched here. Null: no cue, a short DM.
  const [channel, setChannel] = useState<"email" | "linkedin" | null>(null);
  const [draftSubject, setDraftSubject] = useState("");
  // Set when the person edits the purpose; cleared when they empty it or the sheet reopens.
  const [purposeOverridden, setPurposeOverridden] = useState(false);
  const [sendOptions, setSendOptions] =
    useState<ContactFollowUpSendOptions | null>(null);
  const [pending, start] = useTransition();
  const [sending, startSend] = useTransition();
  const [marking, startMark] = useTransition();
  const sessionRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const session = ++sessionRef.current;
    setDraft("");
    setAiDraft(null);
    setAiError(null);
    setPurpose("");
    setPickedPurpose("");
    setPurposeOverridden(false);
    setSendOptions(null);
    setChannel(null);
    setDraftSubject("");

    start(async () => {
      // Two independent reads, each shown as soon as it lands. They used to share one
      // `Promise.all`, so the quick send-options read waited on the model call behind the
      // draft, and a draft that failed (no AI key, a provider error) left "Loading send
      // options…" on screen for good — with the send buttons it gates. Server Actions go out
      // one at a time anyway, so asking for the options first costs the draft nothing.
      let reported = false;
      const report = (err: unknown) => {
        if (session !== sessionRef.current || reported) return;
        reported = true;
        toast.error(friendlyError(err, TOAST_COPY.draftFollowUpFailed));
      };
      const optionsRead = getContactFollowUpSendOptions(contactId).then(
        (options) => {
          if (session === sessionRef.current) setSendOptions(options);
        },
        report
      );
      // Opening the sheet shows the draft already written for this context; only
      // Regenerate below pays for a new one. A draft handed in (Radar's) needs no read at all.
      const handed = initialDraft?.trim();
      if (handed) {
        setDraft(handed);
        setAiDraft(handed);
      }
      const draftRead = handed
        ? Promise.resolve()
        : draftContactFollowUp(contactId, { reuse: true, intent }).then(
            (result) => {
              if (session !== sessionRef.current) return;
              if (!result.ok) return setAiError(result.error);
              setAiError(null);
              setDraft(result.body);
              setAiDraft(result.body);
              setPurpose(result.purpose);
              setPickedPurpose(result.purpose);
              setChannel(result.channel === "sms" ? null : result.channel);
              setDraftSubject(result.subject);
            },
            report
          );
      await Promise.all([optionsRead, draftRead]);
    });
    // `initialDraft` is read when the sheet opens, not tracked: a draft arriving while the
    // sheet is open must not overwrite what the person is editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contactId]);

  /** A fresh draft; `to` switches the channel, otherwise the current one is kept. */
  function regenerate(to?: "email" | "linkedin") {
    start(async () => {
      try {
        const result = await draftContactFollowUp(contactId, {
          intent,
          purpose: editedPurpose(purpose, purposeOverridden),
          channel: to ?? channel ?? undefined,
        });
        if (!result.ok) {
          setAiError(result.error);
          return;
        }
        setAiError(null);
        setDraft(result.body);
        setAiDraft(result.body);
        setPurpose(result.purpose);
        setPickedPurpose(result.purpose);
        setChannel(result.channel === "sms" ? null : result.channel);
        setDraftSubject(result.subject);
        toast.success("Draft ready");
      } catch (err) {
        toast.error(
          friendlyError(err, TOAST_COPY.draftFollowUpFailed)
        );
      }
    });
  }

  /** Orbit's draft next to the text used, to learn edits made again and again. */
  function recordUse() {
    if (!aiDraft || !draft.trim()) return;
    void recordDraftOutcome({ surface: "follow_up", kind: channel ?? "other", aiText: aiDraft, finalText: draft }).catch(() => {});
  }

  function finishAndClose(message: string) {
    toast.success(message);
    onOpenChange(false);
    router.refresh();
  }

  function sendEmail() {
    if (!draft.trim()) return;
    startSend(async () => {
      try {
        // A subject handed in wins; otherwise the one the email draft wrote for itself.
        const res = await sendContactFollowUpEmail(contactId, draft, subject ?? (draftSubject.trim() || undefined));
        if (!res.ok) {
          toast.error(res.message);
          return;
        }
        recordUse();
        showUndoSendToast({
          sendId: res.sendId,
          recipientLabel: contactName,
          onUndone: () => {
            onUndone?.();
            router.refresh();
          },
        });
        onSent?.();
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "That email didn’t send — try again?"));
      }
    });
  }

  function markSent(channel: "email" | "linkedin_message" | "note") {
    recordUse();
    startMark(async () => {
      try {
        await completeFollowUpWithTouch(contactId, {
          channel,
          notes: draft.trim() || undefined,
        });
        onSent?.();
        finishAndClose(channel === "linkedin_message" ? "Marked sent on LinkedIn" : "Follow-up marked sent");
      } catch (err) {
        toast.error(
          friendlyError(err, "Couldn’t mark that follow-up sent — try again?")
        );
      }
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle>{title ?? `Follow up with ${contactName}`}</SheetTitle>
          <SheetDescription>
            {description ??
              "Draft a warm message, then send or mark it sent to clear this due item."}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 px-4 pb-6">
          <div className="flex items-center justify-between gap-2">
            <div role="group" aria-label="Write it as" className="flex items-center gap-1 text-xs">
              <span className="mr-1 text-muted-foreground">Write it as</span>
              {(["email", "linkedin"] as const).map((c) => (
                <Button
                  key={c}
                  type="button"
                  size="sm"
                  variant={channel === c ? "secondary" : "ghost"}
                  aria-pressed={channel === c}
                  disabled={pending}
                  onClick={() => channel !== c && regenerate(c)}
                >
                  {c === "email" ? "Email" : "LinkedIn"}
                </Button>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => regenerate()}
            >
              <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} />
              {pending ? "Drafting…" : draft ? "Regenerate" : "Generate"}
            </Button>
          </div>
          {aiError && <AiKeyNotice feature="draft" reason={aiDenialFromMessage(aiError)} compact />}
          {pickedPurpose ? (
            <DraftPurposeRow
              value={purpose}
              onChange={(v) => {
                setPurpose(v);
                setPurposeOverridden(v.trim() !== "");
              }}
            />
          ) : null}
          <FollowUpDraftComposer
            contactName={contactName}
            draft={draft}
            aiDraft={aiDraft}
            onDraftChange={setDraft}
            sendOptions={sendOptions}
            pending={pending}
            sending={sending}
            marking={marking}
            onCopy={async () => {
              if (!draft.trim()) return;
              recordUse();
              if (await copyText(draft)) toast.success(TOAST_COPY.copied);
              else toast.error(TOAST_COPY.copyFailed);
            }}
            onSendEmail={sendEmail}
            onMarkSent={markSent}
            onOpenLinkedIn={(url) => {
              // The tab opens inside the click (popup blockers); the toast waits on the copy.
              const copied = draft.trim() ? copyText(draft) : null;
              recordUse();
              window.open(url, "_blank", "noopener,noreferrer");
              void copied?.then((ok) =>
                ok ? toast.success(TOAST_COPY.copied) : toast.error(TOAST_COPY.copyFailed)
              );
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
