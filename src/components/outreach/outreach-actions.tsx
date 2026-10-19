"use client";

import { useState, useTransition } from "react";
import { Copy, ExternalLink, Send } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  markMessageAction,
  sendOutreachMessageAction,
} from "@/actions/outreach";
import { Button } from "@/components/ui/button";
import {
  buildLinkedInUrl,
  buildMailtoUrl,
  buildSmsUrl,
  canAutoSend,
  canOpenInApp,
  channelLabel,
} from "@/lib/outreach-channels";
import type { OutreachChannel } from "@/lib/outreach-types";
import { DangerSendDialog } from "@/components/outreach/danger-send-dialog";
import { UserFacingError, friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

type ProspectInfo = {
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
};

export function OutreachActions({
  messageId,
  channel,
  subject,
  body,
  prospect,
  onUpdated,
}: {
  messageId: string;
  channel: OutreachChannel;
  subject: string | null;
  body: string;
  prospect: ProspectInfo;
  onUpdated?: () => void;
}) {
  const [pending, start] = useTransition();
  const [dangerOpen, setDangerOpen] = useState(false);

  const canOpen = canOpenInApp(channel, prospect);
  const canSend = canAutoSend(channel, prospect);

  function refresh() {
    onUpdated?.();
  }

  function handleCopy() {
    const text =
      channel === "email" && subject
        ? `Subject: ${subject}\n\n${body}`
        : body;
    navigator.clipboard.writeText(text);
    start(async () => {
      try {
        await markMessageAction({ messageId, status: "copied" });
        toast.success(TOAST_COPY.copied);
        refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  }

  function handleOpen() {
    if (channel === "email" && prospect.email) {
      window.open(
        buildMailtoUrl({ email: prospect.email, subject, body }),
        "_blank"
      );
    } else if (channel === "sms" && prospect.phone) {
      window.open(buildSmsUrl({ phone: prospect.phone, body }), "_blank");
    } else if (channel === "linkedin" && prospect.linkedinUrl) {
      navigator.clipboard.writeText(body);
      window.open(buildLinkedInUrl(prospect.linkedinUrl), "_blank");
      toast.success("Draft copied — paste it into LinkedIn");
    }

    start(async () => {
      try {
        await markMessageAction({ messageId, status: "opened" });
        refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  }

  /**
   * Awaited by the confirm dialog, which closes on success and shows the thrown message
   * inline otherwise — so a declined send keeps the dialog open rather than toasting.
   */
  async function sendNow() {
    const res = await sendOutreachMessageAction(messageId);
    if (!res.ok) throw new UserFacingError(res.error);
    toast.success(`${channelLabel(channel)} sent`);
    refresh();
  }

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" onClick={handleCopy} disabled={pending}>
          <Copy className="size-3.5" />
          Copy
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleOpen}
          disabled={pending || !canOpen}
        >
          <ExternalLink className="size-3.5" />
          Open
        </Button>
        {canSend && (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setDangerOpen(true)}
            disabled={pending}
          >
            <Send className="size-3.5" />
            Send
          </Button>
        )}
      </div>

      <DangerSendDialog
        open={dangerOpen}
        onOpenChange={setDangerOpen}
        recipientCount={1}
        channel={channelLabel(channel)}
        onConfirm={sendNow}
      />
    </>
  );
}
