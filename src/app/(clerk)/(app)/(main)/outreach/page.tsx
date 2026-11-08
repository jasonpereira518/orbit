import { listCampaigns } from "@/actions/outreach";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { OutreachLocked } from "@/components/locked-feature";
import { getEffectivePlanConfig } from "@/lib/plans/plan-rules";
import { RenderStamp } from "@/components/layout/render-stamp";
import { UnifiedOutreachHub } from "@/components/outreach/unified-outreach-hub";
import { getBrightDataConfig } from "@/lib/brightdata";
import { get5HourSendQuota } from "@/lib/outreach-send";
import { gmailProvider } from "@/lib/email/providers/gmail";
import { outlookProvider } from "@/lib/email/providers/outlook";

export const metadata = { title: "Outreach" };

export default async function OutreachPage() {
  const gate = await pageVisibilityGate("page.outreach");
  if (gate) return gate;

  const userId = await requireUserId();
  const { canUseOutreach } = await getEntitlements(userId);

  if (!canUseOutreach) {
    return <OutreachLocked config={await getEffectivePlanConfig()} />;
  }

  const [campaigns, quota, gmailIdent, outlookIdent] = await Promise.all([
    listCampaigns(),
    get5HourSendQuota(userId).catch(() => null),
    gmailProvider.identity(userId).catch(() => null),
    outlookProvider.identity(userId).catch(() => null),
  ]);

  const brightDataConfig = getBrightDataConfig();

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

  const quotaData = quota
    ? {
        quota,
        providers: {
          gmail: { connected: Boolean(gmailIdent), email: gmailIdent?.email || null },
          outlook: { connected: Boolean(outlookIdent), email: outlookIdent?.email || null },
        },
      }
    : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <RenderStamp />
      <UnifiedOutreachHub
        campaigns={ranked}
        accountRate={accountRate}
        totals={totals}
        isBrightDataLive={brightDataConfig.isConfigured}
        quotaData={quotaData}
      />
    </div>
  );
}
