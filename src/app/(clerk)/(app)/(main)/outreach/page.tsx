import Link from "next/link";
import { Plus } from "lucide-react";
import { listCampaigns } from "@/actions/outreach";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { OutreachLocked } from "@/components/locked-feature";
import { OutreachCampaignCard } from "@/components/outreach/outreach-campaign-card";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatReplyRate } from "@/lib/outreach-metrics";
import { RenderStamp } from "@/components/layout/render-stamp";

export default async function OutreachPage() {
  // Before the paywall on purpose: coming-soon is a stronger fact than "buy a plan to
  // unlock this" — nobody can unlock a page that is not out yet. See `pageVisibilityGate`'s
  // doc comment for why the layout-level check alone does not catch a click straight from a
  // sibling route.
  const gate = await pageVisibilityGate("page.outreach");
  if (gate) return gate;

  const { canUseOutreach } = await getEntitlements(await requireUserId());

  if (!canUseOutreach) {
    return <OutreachLocked />;
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
    <PageShell width="wide">
      <RenderStamp />
      <PageHeader
        title="Outreach"
        description="Optimize for successful replies — quality ICP, personalized drafts, and logged outcomes."
        actions={
          <Link href="/outreach/new" className={buttonVariants()}>
            <Plus className="size-4" />
            New campaign
          </Link>
        }
      />

      {campaigns.length > 0 && (
        <Card size="sm">
          <CardContent>
            <p className="text-xs text-muted-foreground">Account successful reply rate</p>
            <div className="mt-1 flex flex-wrap items-baseline gap-4">
              <span className="font-heading text-3xl text-ink">
                {formatReplyRate(accountRate)}
              </span>
              <span className="text-sm text-muted-foreground">
                {totals.positive} positive · {totals.sent} sent
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {ranked.length === 0 ? (
        <EmptyState
          title="No campaigns yet"
          description="Start with a tight ICP and a clear reply ask."
          action={
            <Link href="/outreach/new" className={buttonVariants({ variant: "outline" })}>
              Start your first campaign
            </Link>
          }
        />
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
                updatedAt: campaign.updatedAt,
                metrics: campaign.metrics,
              }}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}
