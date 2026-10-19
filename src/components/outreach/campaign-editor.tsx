"use client";

import { useEffect, useState, useTransition, type ReactElement, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { updateCampaign } from "@/actions/outreach";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { channelLabel } from "@/lib/outreach-channels";
import {
  OUTREACH_CHANNELS,
  OUTREACH_TONES,
  type OutreachChannel,
} from "@/lib/outreach-types";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

const CAMPAIGN_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
] as const;

/** Stored tone → Title-cased word. The stored values never change. */
function labelForTone(tone: string) {
  return tone.charAt(0).toUpperCase() + tone.slice(1);
}

const TONE_ITEMS = OUTREACH_TONES.map((t) => ({ value: t, label: labelForTone(t) }));
const CHANNEL_ITEMS = OUTREACH_CHANNELS.map((c) => ({ value: c, label: channelLabel(c) }));

export type CampaignEditorInitial = {
  id: string;
  name: string;
  audienceQuery: string | null;
  messageIntent: string | null;
  tone: string | null;
  defaultChannel: string | null;
  status: string;
};

export function CampaignEditor({
  campaign,
  trigger,
}: {
  campaign: CampaignEditorInitial;
  trigger?: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  const [name, setName] = useState(campaign.name);
  const [audienceQuery, setAudienceQuery] = useState(campaign.audienceQuery || "");
  const [messageIntent, setMessageIntent] = useState(campaign.messageIntent || "");
  const [tone, setTone] = useState(campaign.tone || "professional");
  const [channel, setChannel] = useState<OutreachChannel>(
    (campaign.defaultChannel as OutreachChannel) || "email"
  );
  const [status, setStatus] = useState(campaign.status);

  useEffect(() => {
    if (!open) return;
    setName(campaign.name);
    setAudienceQuery(campaign.audienceQuery || "");
    setMessageIntent(campaign.messageIntent || "");
    setTone(campaign.tone || "professional");
    setChannel((campaign.defaultChannel as OutreachChannel) || "email");
    setStatus(campaign.status);
  }, [open, campaign]);

  function save() {
    start(async () => {
      try {
        await updateCampaign(campaign.id, {
          name: name.trim() || "Untitled campaign",
          audienceQuery: audienceQuery.trim(),
          messageIntent: messageIntent.trim() || null,
          tone,
          defaultChannel: channel,
          status,
        });
        toast.success("Campaign updated");
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          trigger
            ? () => trigger as ReactElement
            : () => (
                <Button variant="outline" size="sm">
                  <Pencil className="size-3.5" />
                  Edit campaign
                </Button>
              )
        }
      />
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Edit campaign</SheetTitle>
          <SheetDescription>
            Update audience, messaging, or status anytime. Re-run search or regenerate
            drafts from the campaign workspace after changing audience or message settings.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-4">
          <FormField label="Campaign name" id="edit-name">
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>

          <FormField label="Status" id="edit-status">
            <Select value={status} onValueChange={(v) => setStatus(String(v ?? "draft"))} items={CAMPAIGN_STATUSES}>
              <SelectTrigger id="edit-status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAMPAIGN_STATUSES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField
            label="Audience"
            id="edit-audience"
            required
            hint="Saving updates search filters. Use “Re-run search” to fetch new prospects."
          >
            <Textarea
              id="edit-audience"
              value={audienceQuery}
              onChange={(e) => setAudienceQuery(e.target.value)}
              rows={4}
              placeholder="Who you want to reach"
            />
          </FormField>

          <FormField label="Message intent / CTA" id="edit-intent">
            <Textarea
              id="edit-intent"
              value={messageIntent}
              onChange={(e) => setMessageIntent(e.target.value)}
              rows={3}
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Tone" id="edit-tone">
              <Select value={tone} onValueChange={(v) => setTone(String(v ?? "professional"))} items={TONE_ITEMS}>
                <SelectTrigger id="edit-tone" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TONE_ITEMS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Default channel" id="edit-channel">
              <Select
                value={channel}
                onValueChange={(v) => setChannel((v ?? "email") as OutreachChannel)}
                items={CHANNEL_ITEMS}
              >
                <SelectTrigger id="edit-channel" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_ITEMS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending || !audienceQuery.trim()}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
