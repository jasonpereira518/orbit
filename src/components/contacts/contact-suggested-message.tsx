"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, ExternalLink, Mail, RefreshCw } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  draftContactFollowUp,
  sendContactFollowUpEmail,
  type ContactFollowUpSendOptions,
} from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

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

  function copyDraft() {
    if (!draft.trim()) return;
    void navigator.clipboard.writeText(draft);
    toast.success("Copied to clipboard");
  }

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

  const hint = sendOptions.canSendEmail
    ? "You can send this by email with one click."
    : sendOptions.hasLinkedIn
      ? "LinkedIn can’t be sent automatically — copy and open their profile."
      : sendOptions.hasEmail
        ? "Add a Resend API key in Settings to send email from Orbit."
        : "Add an email or LinkedIn URL to send or open a follow-up.";

  return (
    <Card id="suggested-message" className="scroll-mt-24 border-border/70 shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Suggested message</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
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
      <CardContent className="space-y-3">
        {draft ? (
          <>
            <Textarea
              rows={6}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="resize-y text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={copyDraft}>
                <Copy className="size-3.5" />
                Copy
              </Button>
              {sendOptions.canSendEmail ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={sending || !draft.trim()}
                  onClick={sendEmail}
                >
                  <Mail className="size-3.5" />
                  {sending ? "Sending…" : "Send email"}
                </Button>
              ) : null}
              {sendOptions.hasLinkedIn && sendOptions.linkedinUrl ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    copyDraft();
                    window.open(
                      sendOptions.linkedinUrl!,
                      "_blank",
                      "noopener,noreferrer"
                    );
                  }}
                >
                  <ExternalLink className="size-3.5" />
                  Open LinkedIn
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {pending
              ? "Drafting a follow-up…"
              : `Generate a warm follow-up grounded in your history with ${contactName}.`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
