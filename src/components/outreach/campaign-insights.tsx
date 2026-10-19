import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { channelLabel } from "@/lib/outreach-channels";
import { formatReplyRate } from "@/lib/outreach-metrics";
import type { OutreachChannel } from "@/lib/outreach-types";

export function CampaignInsights({
  channelBreakdown,
  stepBreakdown,
}: {
  channelBreakdown: Array<{
    channel: string;
    sent: number;
    positiveReplies: number;
    successfulReplyRate: number | null;
  }>;
  stepBreakdown: Array<{
    stepIndex: number;
    label: string;
    sent: number;
    positiveReplies: number;
    successfulReplyRate: number | null;
  }>;
}) {
  if (!channelBreakdown.length && !stepBreakdown.length) return null;

  const followUpShare = (() => {
    const initial = stepBreakdown.find((s) => s.stepIndex === 0);
    const followUps = stepBreakdown.filter((s) => s.stepIndex > 0);
    const followPositive = followUps.reduce((n, s) => n + s.positiveReplies, 0);
    const totalPositive =
      (initial?.positiveReplies || 0) + followPositive;
    if (!totalPositive) return null;
    return followPositive / totalPositive;
  })();

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card size="sm">
        <CardHeader>
          <CardTitle as="h3">By channel</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {channelBreakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sends yet.</p>
          ) : (
            channelBreakdown.map((row) => (
              <div
                key={row.channel}
                className="flex items-center justify-between text-sm"
              >
                <span className="text-muted-foreground">
                  {channelLabel(row.channel as OutreachChannel)}
                </span>
                <span>
                  {formatReplyRate(row.successfulReplyRate)} · {row.positiveReplies}/
                  {row.sent}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle as="h3">By step</CardTitle>
          {followUpShare != null && (
            <CardDescription className="text-xs">
              Follow-ups drive {Math.round(followUpShare * 100)}% of positive replies
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {stepBreakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sends yet.</p>
          ) : (
            stepBreakdown.map((row) => (
              <div
                key={row.stepIndex}
                className="flex items-center justify-between text-sm"
              >
                <span className="text-muted-foreground">{row.label}</span>
                <span>
                  {formatReplyRate(row.successfulReplyRate)} · {row.positiveReplies}/
                  {row.sent}
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
