"use client";

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useGuardedTransition } from "@/lib/single-flight";
import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { updateCampaign } from "@/actions/outreach";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

const STATUS_OPTIONS = CAMPAIGN_STATUSES.map((s) => ({ value: s.value, label: s.label }));

const TONE_OPTIONS = OUTREACH_TONES.map((t) => ({ value: t, label: t }));

const CHANNEL_OPTIONS: { value: OutreachChannel; label: string }[] = OUTREACH_CHANNELS.map((c) => ({
  value: c,
  label: c === "email" ? "Email" : c === "linkedin" ? "LinkedIn" : "SMS",
}));

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
  const [pending, start] = useGuardedTransition();

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
                <Button variant="outline" size="sm" className="rounded-full">
                  <Pencil className="mr-1 h-3.5 w-3.5" />
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

        <div className="mt-6 space-y-4 px-1">
          <div className="space-y-1.5">
            <Label htmlFor="edit-name">Campaign name</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label id="edit-status-label">Status</Label>
            <Select
              value={status}
              onValueChange={(v) => {
                if (v) setStatus(v);
              }}
              items={STATUS_OPTIONS}
            >
              <SelectTrigger aria-labelledby="edit-status-label" className="h-9 w-full rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} className="p-1 rounded-xl">
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s.value} value={s.value} className="py-1.5 pl-2 rounded-lg text-sm">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-audience">Audience</Label>
            <Textarea
              id="edit-audience"
              value={audienceQuery}
              onChange={(e) => setAudienceQuery(e.target.value)}
              rows={4}
              placeholder="Who you want to reach"
            />
            <p className="text-xs text-muted-foreground">
              Saving updates search filters. Use &quot;Re-run search&quot; to fetch new
              prospects.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-intent">Message intent / CTA</Label>
            <Textarea
              id="edit-intent"
              value={messageIntent}
              onChange={(e) => setMessageIntent(e.target.value)}
              rows={3}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label id="edit-tone-label">Tone</Label>
              <Select
                value={tone}
                onValueChange={(v) => {
                  if (v) setTone(v);
                }}
                items={TONE_OPTIONS}
              >
                <SelectTrigger aria-labelledby="edit-tone-label" className="h-9 w-full rounded-xl capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} className="p-1 rounded-xl">
                  {TONE_OPTIONS.map((t) => (
                    <SelectItem key={t.value} value={t.value} className="py-1.5 pl-2 rounded-lg text-sm capitalize">
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label id="edit-channel-label">Default channel</Label>
              <Select
                value={channel}
                onValueChange={(v) => {
                  if (v) setChannel(v as OutreachChannel);
                }}
                items={CHANNEL_OPTIONS}
              >
                <SelectTrigger aria-labelledby="edit-channel-label" className="h-9 w-full rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} className="p-1 rounded-xl">
                  {CHANNEL_OPTIONS.map((c) => (
                    <SelectItem key={c.value} value={c.value} className="py-1.5 pl-2 rounded-lg text-sm">
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              onClick={save}
              disabled={pending || !audienceQuery.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Save changes
            </Button>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
