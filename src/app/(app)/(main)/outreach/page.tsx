import Link from "next/link";
import { Plus } from "lucide-react";
import { listCampaigns } from "@/actions/outreach";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { LockedFeature } from "@/components/locked-feature";
import { OutreachCampaignCard } from "@/components/outreach/outreach-campaign-card";
import { buttonVariants } from "@/components/ui/button";
import { formatReplyRate } from "@/lib/outreach-metrics";
import { cn } from "@/lib/utils";

export default async function OutreachPage() {
  const { canUseOutreach } = await getEntitlements(await requireUserId());

  if (!canUseOutreach) {
    return (
      <LockedFeature
        title="Outreach"
        description="Find the right people, draft messages that sound like you, and track what actually gets replies — without leaving Orbit."
        highlights={[
          "Search prospects by role, company, and seniority",
          "Personalized email and SMS drafts from your own notes",
          "Reply tracking and per-campaign quality scores",
          "Sequenced follow-ups that stop when someone replies",
        ]}
        note="On Orbit Lifetime you supply your own Apollo, Resend, and Twilio keys."
      />
    );
  }

  const campaigns = await listCampaigns();

  const totals = campaigns.reduce(
    (acc, c) => {
      acc.sent += c.metrics.sentCount;
      acc.bounced += c.metrics.bouncedCount;
      acc.positive += c.metrics.positiveReplyCount;
      return acc;
    },
    { sent: 0, bounced: 0, positive: 0 }
  );
  const eligible = Math.max(0, totals.sent - totals.bounced);
  const accountRate = eligible > 0 ? totals.positive / eligible : null;

  const ranked = [...campaigns].sort((a, b) => {
    const aRate = a.metrics.successfulReplyRate;
    const bRate = b.metrics.successfulReplyRate;
    if (aRate == null && bRate == null) {
      return b.metrics.sentCount - a.metrics.sentCount;
    }
    if (aRate == null) return 1;
    if (bRate == null) return -1;
    if (bRate !== aRate) return bRate - aRate;
    return b.metrics.positiveReplyCount - a.metrics.positiveReplyCount;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
            Outreach
          </h1>
          <p className="mt-1 text-muted-foreground">
            Optimize for successful replies — quality ICP, personalized drafts, and logged outcomes
          </p>
        </div>
        <Link
          href="/outreach/new"
          className={cn(
            buttonVariants(),
            "bg-primary text-primary-foreground hover:bg-primary/90"
          )}
        >
          <Plus className="mr-1 h-4 w-4" />
          New campaign
        </Link>
      </div>

      {campaigns.length > 0 && (
        <div className="rounded-2xl border border-border/70 bg-card px-5 py-4">
          <div className="text-xs text-muted-foreground">Account successful reply rate</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-4">
            <span className="font-[family-name:var(--font-display)] text-3xl text-primary">
              {formatReplyRate(accountRate)}
            </span>
            <span className="text-sm text-muted-foreground">
              {totals.positive} positive · {totals.sent} sent
            </span>
          </div>
        </div>
      )}

      {ranked.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 p-12 text-center">
          <p className="text-muted-foreground">
            No campaigns yet. Start with a tight ICP and a clear reply ask.
          </p>
          <Link
            href="/outreach/new"
            className={cn(buttonVariants({ variant: "outline" }), "mt-4 inline-flex")}
          >
            Start your first reply-optimized campaign
          </Link>
        </div>
      ) : (
        <div className="grid gap-4">
          {ranked.map((campaign) => (
            <OutreachCampaignCard
              key={campaign.id}
              campaign={{
                id: campaign.id,
                name: campaign.name,
                audienceQuery: campaign.audienceQuery,
                messageIntent: campaign.messageIntent,
                tone: campaign.tone,
                defaultChannel: campaign.defaultChannel,
                status: campaign.status,
                prospects: campaign.prospects,
                updatedAt: campaign.updatedAt,
                metrics: campaign.metrics,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
