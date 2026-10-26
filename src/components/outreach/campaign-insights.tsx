import { formatReplyRate } from "@/lib/outreach-metrics";

export function CampaignInsights({
  channelBreakdown,
  stepBreakdown,
}: {
  channelBreakdown: Array<{
    channel: string;
    sent: number;
    replies: number;
    replyRate: number | null;
  }>;
  stepBreakdown: Array<{
    stepIndex: number;
    label: string;
    sent: number;
    replies: number;
    replyRate: number | null;
  }>;
}) {
  if (!channelBreakdown.length && !stepBreakdown.length) return null;

  const followUpShare = (() => {
    const initial = stepBreakdown.find((s) => s.stepIndex === 0);
    const followUps = stepBreakdown.filter((s) => s.stepIndex > 0);
    const followReplies = followUps.reduce((n, s) => n + s.replies, 0);
    const totalReplies = (initial?.replies || 0) + followReplies;
    if (!totalReplies) return null;
    return followReplies / totalReplies;
  })();

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-border/70 bg-card p-4">
        <h3 className="text-sm font-medium text-ink">By channel</h3>
        <div className="mt-3 space-y-2">
          {channelBreakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sends yet.</p>
          ) : (
            channelBreakdown.map((row) => (
              <div
                key={row.channel}
                className="flex items-center justify-between text-sm"
              >
                <span className="capitalize text-muted-foreground">
                  {row.channel}
                </span>
                <span>
                  {formatReplyRate(row.replyRate)} · {row.replies}/
                  {row.sent}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-border/70 bg-card p-4">
        <h3 className="text-sm font-medium text-ink">By step</h3>
        {followUpShare != null && (
          <p className="mt-1 text-xs text-muted-foreground">
            Follow-ups drive {Math.round(followUpShare * 100)}% of replies
          </p>
        )}
        <div className="mt-3 space-y-2">
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
                  {formatReplyRate(row.replyRate)} · {row.replies}/
                  {row.sent}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
