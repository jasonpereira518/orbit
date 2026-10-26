import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatReplyRate } from "@/lib/outreach-metrics";
import type { CampaignMetrics } from "@/lib/outreach-types";

const CHANNEL_LABELS: Record<string, string> = { email: "Email", linkedin: "LinkedIn" };

export function OutreachCampaignCard({
  campaign,
}: {
  // No prospect list: the outreach list counts them in SQL (`metrics.prospectCount`)
  // rather than shipping every prospect to the browser to take a `.length`.
  campaign: {
    id: string;
    name: string;
    audienceQuery: string | null;
    defaultChannel: string | null;
    metrics: CampaignMetrics;
  };
}) {
  const { metrics } = campaign;
  const channel = campaign.defaultChannel ?? "email";
  return (
    <Link
      href={`/outreach/${campaign.id}`}
      className="block rounded-2xl border border-border/70 bg-card p-5 outline-none transition-[border-color,box-shadow] hover:border-primary/30 hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-medium text-ink">{campaign.name}</h2>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
            {campaign.audienceQuery || "No audience description"}
          </p>
        </div>
        <Badge variant="outline">{CHANNEL_LABELS[channel] ?? channel}</Badge>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-ink">
          Reply rate {formatReplyRate(metrics.replyRate)}
        </span>
        <span>
          {metrics.prospectCount} {metrics.prospectCount === 1 ? "person" : "people"}
        </span>
        <span>{metrics.sentCount} sent</span>
        <span>{metrics.replyCount} replied</span>
      </div>
    </Link>
  );
}
