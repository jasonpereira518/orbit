"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RelativeTime } from "@/components/ui/relative-time";
import {
  CampaignEditor,
  type CampaignEditorInitial,
} from "@/components/outreach/campaign-editor";
import { CARD_HOVER } from "@/lib/interaction";
import { formatReplyRate } from "@/lib/outreach-metrics";
import type { CampaignMetrics } from "@/lib/outreach-types";

/** Stored campaign status → the word on the chip. The stored values never change. */
function labelForCampaignStatus(status: string): { label: string; tone: "neutral" | "success" | "info" } {
  switch (status) {
    case "active":
      return { label: "Active", tone: "success" };
    case "completed":
      return { label: "Completed", tone: "info" };
    case "archived":
      return { label: "Archived", tone: "neutral" };
    default:
      return { label: "Draft", tone: "neutral" };
  }
}

export function OutreachCampaignCard({
  campaign,
}: {
  // No prospect list: the outreach list counts them in SQL (`metrics.prospectCount`)
  // rather than shipping every prospect to the browser to take a `.length`.
  campaign: CampaignEditorInitial & {
    updatedAt: Date;
    metrics: CampaignMetrics;
  };
}) {
  const status = labelForCampaignStatus(campaign.status);
  return (
    <Card className={CARD_HOVER}>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <Link href={`/outreach/${campaign.id}`} className="min-w-0 flex-1">
          <CardTitle as="h2" className="text-lg">
            {campaign.name}
          </CardTitle>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
            {campaign.audienceQuery || "No audience description"}
          </p>
        </Link>
        <div className="flex items-center gap-2">
          <CampaignEditor campaign={campaign} />
          <Badge tone={status.tone} size="sm">
            {status.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <Link href={`/outreach/${campaign.id}`} className="block">
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span className="font-medium text-ink">
              Reply rate {formatReplyRate(campaign.metrics.successfulReplyRate)}
            </span>
            <span>{campaign.metrics.sentCount} sent</span>
            <span>{campaign.metrics.positiveReplyCount} positive</span>
            <span>{campaign.metrics.awaitingReplyCount} awaiting</span>
            <span>{campaign.metrics.prospectCount} prospects</span>
            <span>
              Updated <RelativeTime date={campaign.updatedAt} />
            </span>
          </div>
        </Link>
      </CardContent>
    </Card>
  );
}
