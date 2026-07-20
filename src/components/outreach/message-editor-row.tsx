"use client";

import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  regenerateOutreachDraft,
  updateOutreachMessage,
} from "@/actions/outreach";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { OutreachChannel } from "@/lib/outreach-types";

export function MessageEditorRow({
  campaignId,
  prospectId,
  messageId,
  channel,
  subject,
  body,
  onUpdated,
}: {
  campaignId: string;
  prospectId: string;
  messageId: string;
  channel: OutreachChannel;
  subject: string | null;
  body: string;
  onUpdated?: () => void;
}) {
  const [localSubject, setLocalSubject] = useState(subject || "");
  const [localBody, setLocalBody] = useState(body);
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      try {
        await updateOutreachMessage({
          messageId,
          subject: channel === "email" ? localSubject : null,
          body: localBody,
        });
        toast.success("Draft saved");
        onUpdated?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  function regenerate() {
    start(async () => {
      try {
        const updated = await regenerateOutreachDraft({
          campaignId,
          prospectId,
          channel,
        });
        setLocalSubject(updated.subject || "");
        setLocalBody(updated.body);
        toast.success("Draft regenerated");
        onUpdated?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Regenerate failed");
      }
    });
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-background/50 p-3">
      {channel === "email" && (
        <Input
          value={localSubject}
          onChange={(e) => setLocalSubject(e.target.value)}
          placeholder="Subject"
        />
      )}
      <Textarea
        value={localBody}
        onChange={(e) => setLocalBody(e.target.value)}
        rows={channel === "sms" ? 3 : 5}
        placeholder="Message draft"
      />
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={save} disabled={pending}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={regenerate} disabled={pending}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          Regenerate
        </Button>
      </div>
    </div>
  );
}
