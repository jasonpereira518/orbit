"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  draftContactFollowUp,
  sendContactFollowUpEmail,
  type ContactFollowUpSendOptions,
} from "@/actions/contacts";
import { completeFollowUpWithTouch } from "@/actions/reminders";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FollowUpDraftComposer } from "@/components/follow-up/follow-up-draft-composer";

export function ContactSuggestedMessage({
  contactId,
  contactName,
  sendOptions,
}: {
  contactId: string;
  contactName: string;
  sendOptions: ContactFollowUpSendOptions;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [pending, start] = useTransition();
  const [sending, startSend] = useTransition();
  const [marking, startMark] = useTransition();
  const autoStarted = useRef(false);

  function generate() {
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

  useEffect(() => {
    if (autoStarted.current) return;
    if (typeof window === "undefined") return;
    if (window.location.hash !== "#suggested-message") return;
    autoStarted.current = true;
    generate();
    // Only auto-start when landing via #suggested-message
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sendEmail() {
    if (!draft.trim()) return;
    startSend(async () => {
      try {
        await sendContactFollowUpEmail(contactId, draft);
        toast.success(`Email sent to ${contactName}`);
        router.refresh();
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
        toast.success("Follow-up marked sent");
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not mark follow-up sent"
        );
      }
    });
  }

  return (
    <Card id="suggested-message" className="scroll-mt-24 border-border/70 shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Suggested message</CardTitle>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={generate}
        >
          <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} />
          {pending ? "Drafting…" : draft ? "Regenerate" : "Generate"}
        </Button>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}
