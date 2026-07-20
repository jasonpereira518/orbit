"use client";

import { useEffect, useState, useTransition, type ReactElement, type ReactNode } from "react";
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
  OUTREACH_CHANNELS,
  OUTREACH_TONES,
  type OutreachChannel,
} from "@/lib/outreach-types";

const CAMPAIGN_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
] as const;

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
        toast.error(err instanceof Error ? err.message : "Failed to save");
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
            <Label htmlFor="edit-status">Status</Label>
            <select
              id="edit-status"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {CAMPAIGN_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
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
              <Label htmlFor="edit-tone">Tone</Label>
              <select
                id="edit-tone"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={tone}
                onChange={(e) => setTone(e.target.value)}
              >
                {OUTREACH_TONES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-channel">Default channel</Label>
              <select
                id="edit-channel"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={channel}
                onChange={(e) => setChannel(e.target.value as OutreachChannel)}
              >
                {OUTREACH_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
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
