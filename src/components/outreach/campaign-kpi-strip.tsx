import { Card, CardContent } from "@/components/ui/card";
import { formatReplyRate } from "@/lib/outreach-metrics";
import type { CampaignMetrics } from "@/lib/outreach-types";
import { cn } from "@/lib/utils";

export function CampaignKpiStrip({ metrics }: { metrics: CampaignMetrics }) {
  const items = [
    {
      label: "Successful reply rate",
      value: formatReplyRate(metrics.successfulReplyRate),
      primary: true,
    },
    { label: "Sent", value: String(metrics.sentCount) },
    { label: "Positive replies", value: String(metrics.positiveReplyCount) },
    { label: "Awaiting reply", value: String(metrics.awaitingReplyCount) },
    {
      label: "Follow-ups due",
      value: String(metrics.pendingFollowUpCount),
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {items.map((item) => (
        <Card
          key={item.label}
          size="sm"
          className={item.primary ? "border-primary/25 bg-primary/5" : undefined}
        >
          <CardContent>
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p
              className={cn(
                "mt-1 font-heading text-2xl",
                item.primary ? "text-primary" : "text-foreground"
              )}
            >
              {item.value}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
