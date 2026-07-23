"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "@/lib/toast";
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
import { FollowUpDraftComposer } from "@/components/follow-up/follow-up-draft-composer";

export function FollowUpDraftSheet({
  open,
  onOpenChange,
  contactId,
  contactName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  contactName: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
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
    setSendOptions(null);

    start(async () => {
      try {
        const [options, result] = await Promise.all([
          getContactFollowUpSendOptions(contactId),
          draftContactFollowUp(contactId),
        ]);
        if (session !== sessionRef.current) return;
        setSendOptions(options);
        setDraft(result.body);
      } catch (err) {
        if (session !== sessionRef.current) return;
        toast.error(
          err instanceof Error ? err.message : "Could not draft follow-up"
        );
      }
    });
  }, [open, contactId]);

  function regenerate() {
    start(async () => {
      try {
        const result = await draftContactFollowUp(contactId);
        setDraft(result.body);
        toast.success("Draft ready");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not draft follow-up"
        );
      }
    });
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
        await sendContactFollowUpEmail(contactId, draft);
        finishAndClose(`Email sent to ${contactName}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not send email");
      }
    });
  }

  function markSent(channel: "email" | "linkedin_message" | "note") {
    startMark(async () => {
      try {
        await completeFollowUpWithTouch(contactId, {
          channel,
          notes: draft.trim() || undefined,
        });
        finishAndClose("Follow-up marked sent");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not mark follow-up sent"
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
          <SheetTitle>Follow up with {contactName}</SheetTitle>
          <SheetDescription>
            Draft a warm message, then send or mark it sent to clear this due
            item.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 px-4 pb-6">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={regenerate}
            >
              <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} />
              {pending ? "Drafting…" : draft ? "Regenerate" : "Generate"}
            </Button>
          </div>
          <FollowUpDraftComposer
            contactName={contactName}
            draft={draft}
            onDraftChange={setDraft}
            sendOptions={sendOptions}
            pending={pending}
            sending={sending}
            marking={marking}
            onCopy={() => {
              if (!draft.trim()) return;
              void navigator.clipboard.writeText(draft);
              toast.success("Copied to clipboard");
            }}
            onSendEmail={sendEmail}
            onMarkSent={markSent}
            onOpenLinkedIn={(url) => {
              if (draft.trim()) {
                void navigator.clipboard.writeText(draft);
                toast.success("Copied to clipboard");
              }
              window.open(url, "_blank", "noopener,noreferrer");
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
