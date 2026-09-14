import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PeopleView } from "@/components/campaigns/people-view";
import { SetupSteps } from "@/components/campaigns/setup-steps";
import { OutreachLocked } from "@/components/locked-feature";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { getCampaignV2 } from "@/lib/outreach/campaigns";
import { getCreditBalance } from "@/lib/outreach/credits/ledger";
import { getLatestRun } from "@/lib/outreach/discovery/run";
import { isOutreachNextEnabled } from "@/lib/outreach/gate";
import { getResearchKeyStatus } from "@/lib/outreach/keys";
import { listPeople } from "@/lib/outreach/people";

export default async function PeoplePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireUserId();
  const { canUseOutreach } = await getEntitlements(userId);
  if (!canUseOutreach) return <OutreachLocked />;
  if (!(await isOutreachNextEnabled(userId))) notFound();
  const campaign = await getCampaignV2(userId, id);
  if (!campaign) notFound();
  if (!campaign.criteriaConfirmedAt) redirect(`/outreach/${id}/audience`);

  const [run, page, balance, keys] = await Promise.all([
    getLatestRun(userId, id),
    listPeople(userId, id, { limit: 25 }),
    getCreditBalance(userId),
    getResearchKeyStatus(userId),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link href="/outreach" className="text-sm text-muted-foreground hover:text-foreground">
          ← All campaigns
        </Link>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">{campaign.name}</h1>
        <SetupSteps campaignId={campaign.id} current="people" reached={campaign.setupStep} />
      </div>
      <PeopleView
        campaignId={campaign.id}
        criteria={campaign.criteria}
        initialRun={run}
        initialPage={page}
        credits={{
          total: balance.total,
          monthlyAvailable: balance.monthlyAvailable,
          lifetimeAvailable: balance.lifetimeAvailable,
          periodEnd: balance.periodEnd.toISOString(),
        }}
        keys={keys}
      />
    </div>
  );
}
