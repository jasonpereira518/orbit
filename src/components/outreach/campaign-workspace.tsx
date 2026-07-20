"use client";

import { useRouter } from "next/navigation";
import {
  BulkActionBar,
} from "@/components/outreach/bulk-action-bar";
import {
  ProspectTable,
  useSelectedProspectIds,
  type ProspectRow,
} from "@/components/outreach/prospect-table";
import { Button } from "@/components/ui/button";
import {
  generateOutreachDrafts,
  searchProspects,
} from "@/actions/outreach";
import { useTransition } from "react";
import { toast } from "sonner";
import type { OutreachChannel } from "@/lib/outreach-types";

export function CampaignWorkspace({
  campaign,
}: {
  campaign: {
    id: string;
    name: string;
    audienceQuery: string | null;
    messageIntent: string | null;
    tone: string | null;
    defaultChannel: string | null;
    status: string;
    prospects: Array<{
      id: string;
      fullName: string;
      title: string | null;
      company: string | null;
      email: string | null;
      phone: string | null;
      linkedinUrl: string | null;
      status: string;
      contactId: string | null;
      messages: Array<{
        id: string;
        channel: string;
        subject: string | null;
        body: string;
        status: string;
      }>;
    }>;
  };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const defaultChannel = (campaign.defaultChannel || "email") as OutreachChannel;

  const prospects: ProspectRow[] = campaign.prospects.map((p) => ({
    id: p.id,
    fullName: p.fullName,
    title: p.title,
    company: p.company,
    email: p.email,
    phone: p.phone,
    linkedinUrl: p.linkedinUrl,
    status: p.status,
    contactId: p.contactId,
    message: p.messages[0]
      ? {
          id: p.messages[0].id,
          channel: p.messages[0].channel as OutreachChannel,
          subject: p.messages[0].subject,
          body: p.messages[0].body,
          status: p.messages[0].status,
        }
      : null,
  }));

  const selectedIds = useSelectedProspectIds(prospects);

  const bulkRows = prospects
    .filter((p) => p.message)
    .map((p) => ({
      prospectId: p.id,
      messageId: p.message!.id,
      channel: p.message!.channel,
      subject: p.message!.subject,
      body: p.message!.body,
      email: p.email,
      phone: p.phone,
      linkedinUrl: p.linkedinUrl,
    }));

  function refresh() {
    router.refresh();
  }

  function rerunSearch() {
    start(async () => {
      try {
        const result = await searchProspects(campaign.id);
        toast.success(`Imported ${result.imported} prospects`);
        refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Search failed");
      }
    });
  }

  function regenerateSelected() {
    start(async () => {
      try {
        await generateOutreachDrafts({
          campaignId: campaign.id,
          prospectIds: selectedIds,
          channel: defaultChannel,
        });
        toast.success("Drafts regenerated");
        refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Regenerate failed");
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={rerunSearch} disabled={pending}>
          Re-run search
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={regenerateSelected}
          disabled={pending || !selectedIds.length}
        >
          Regenerate selected drafts
        </Button>
      </div>

      <BulkActionBar
        campaignId={campaign.id}
        rows={bulkRows}
        selectedProspectIds={selectedIds}
        onUpdated={refresh}
      />

      <ProspectTable
        campaignId={campaign.id}
        prospects={prospects}
        defaultChannel={defaultChannel}
        onUpdated={refresh}
      />
    </div>
  );
}
