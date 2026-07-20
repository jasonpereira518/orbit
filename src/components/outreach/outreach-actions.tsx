"use client";

import { useTransition } from "react";
import { Copy, ExternalLink, Send } from "lucide-react";
import { toast } from "sonner";
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
import { useState } from "react";

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
      await markMessageAction({ messageId, status: "copied" });
      toast.success("Copied to clipboard");
      refresh();
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
      toast.success("Draft copied — paste in LinkedIn messaging");
    }

    start(async () => {
      await markMessageAction({ messageId, status: "opened" });
      refresh();
    });
  }

  function handleSend() {
    start(async () => {
      try {
        await sendOutreachMessageAction(messageId);
        toast.success(`${channelLabel(channel)} sent`);
        setDangerOpen(false);
        refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Send failed");
      }
    });
  }

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" onClick={handleCopy} disabled={pending}>
          <Copy className="mr-1 h-3.5 w-3.5" />
          Copy
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleOpen}
          disabled={pending || !canOpen}
        >
          <ExternalLink className="mr-1 h-3.5 w-3.5" />
          Open
        </Button>
        {canSend && (
          <Button
            size="sm"
            variant="outline"
            className="border-destructive text-destructive hover:bg-destructive/10"
            onClick={() => setDangerOpen(true)}
            disabled={pending}
          >
            <Send className="mr-1 h-3.5 w-3.5" />
            Send
          </Button>
        )}
      </div>

      <DangerSendDialog
        open={dangerOpen}
        onOpenChange={setDangerOpen}
        recipientCount={1}
        channel={channelLabel(channel)}
        onConfirm={handleSend}
        pending={pending}
      />
    </>
  );
}
