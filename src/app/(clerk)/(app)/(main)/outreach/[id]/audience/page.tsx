import Link from "next/link";
import { notFound } from "next/navigation";
import { BriefCard } from "@/components/campaigns/brief-card";
import { CriteriaEditor } from "@/components/campaigns/criteria-editor";
import { SetupSteps } from "@/components/campaigns/setup-steps";
import { OutreachLocked } from "@/components/locked-feature";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { getCampaignV2 } from "@/lib/outreach/campaigns";
import { isOutreachNextEnabled } from "@/lib/outreach/gate";

export default async function AudiencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireUserId();
  const { canUseOutreach } = await getEntitlements(userId);
  if (!canUseOutreach) return <OutreachLocked />;
  if (!(await isOutreachNextEnabled(userId))) notFound();
  const campaign = await getCampaignV2(userId, id);
  if (!campaign) notFound();

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link href="/outreach" className="text-sm text-muted-foreground hover:text-foreground">
          ← All campaigns
        </Link>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">{campaign.name}</h1>
        <SetupSteps campaignId={campaign.id} current="audience" reached={campaign.setupStep} />
      </div>
      <BriefCard campaignId={campaign.id} name={campaign.name} brief={campaign.brief} senderIntro={campaign.senderIntro} />
      <CriteriaEditor campaignId={campaign.id} initial={campaign.criteria} confirmed={Boolean(campaign.criteriaConfirmedAt)} />
    </div>
  );
}
