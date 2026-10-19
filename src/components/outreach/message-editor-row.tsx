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
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

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
  const [saving, startSave] = useTransition();
  const [regenerating, startRegenerate] = useTransition();
  const pending = saving || regenerating;

  function save() {
    startSave(async () => {
      try {
        await updateOutreachMessage({
          messageId,
          subject: channel === "email" ? localSubject : null,
          body: localBody,
        });
        toast.success("Draft saved");
        onUpdated?.();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  }

  function regenerate() {
    startRegenerate(async () => {
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
        toast.error(friendlyError(err, "Couldn’t regenerate that draft — try again?"));
      }
    });
  }

  return (
    <div className="space-y-2 rounded-lg border border-border-subtle bg-surface-inset p-3">
      {channel === "email" && (
        <Input
          aria-label="Subject"
          value={localSubject}
          onChange={(e) => setLocalSubject(e.target.value)}
          placeholder="Subject"
        />
      )}
      <Textarea
        aria-label="Message draft"
        value={localBody}
        onChange={(e) => setLocalBody(e.target.value)}
        rows={channel === "sms" ? 3 : 5}
        placeholder="Message draft"
      />
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={save} disabled={pending}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={regenerate} disabled={pending}>
          <RefreshCw className={regenerating ? "size-3.5 motion-safe:animate-spin" : "size-3.5"} />
          {regenerating ? "Regenerating…" : "Regenerate"}
        </Button>
      </div>
    </div>
  );
}
