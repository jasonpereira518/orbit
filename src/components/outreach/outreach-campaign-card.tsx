"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  CampaignEditor,
  type CampaignEditorInitial,
} from "@/components/outreach/campaign-editor";

export function OutreachCampaignCard({
  campaign,
}: {
  campaign: CampaignEditorInitial & {
    prospects: Array<{ id: string; status: string }>;
    updatedAt: Date;
  };
}) {
  const selected = campaign.prospects.filter((p) => p.status === "selected").length;

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 transition-colors hover:bg-muted/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Link href={`/outreach/${campaign.id}`} className="min-w-0 flex-1">
          <h2 className="text-lg font-medium text-primary">{campaign.name}</h2>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
            {campaign.audienceQuery || "No audience description"}
          </p>
        </Link>
        <div className="flex items-center gap-2">
          <CampaignEditor campaign={campaign} />
          <Badge variant="outline">{campaign.status}</Badge>
        </div>
      </div>
      <Link href={`/outreach/${campaign.id}`} className="mt-3 block">
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>{campaign.prospects.length} prospects</span>
          <span>{selected} selected</span>
          <span>
            Updated{" "}
            {formatDistanceToNow(new Date(campaign.updatedAt), {
              addSuffix: true,
            })}
          </span>
        </div>
      </Link>
    </div>
  );
}
