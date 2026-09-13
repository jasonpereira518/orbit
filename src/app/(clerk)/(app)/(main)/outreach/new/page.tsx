import { OutreachWizard } from "@/components/outreach/outreach-wizard";
import { DescribeForm } from "@/components/campaigns/describe-form";
import { SetupSteps } from "@/components/campaigns/setup-steps";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { OutreachLocked } from "@/components/locked-feature";
import { getDefaultSenderIntro } from "@/lib/outreach/campaigns";
import { isOutreachNextEnabled } from "@/lib/outreach/gate";

export default async function NewOutreachPage() {
  const userId = await requireUserId();
  const { canUseOutreach } = await getEntitlements(userId);
  if (!canUseOutreach) return <OutreachLocked />;

  if (await isOutreachNextEnabled(userId)) {
    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">New campaign</h1>
          <SetupSteps campaignId={null} current="describe" reached="describe" />
        </div>
        <DescribeForm defaultIntro={await getDefaultSenderIntro(userId)} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          New outreach campaign
        </h1>
        <p className="mt-1 text-muted-foreground">
          Define a tight audience, a desired reply, and personalized drafts optimized for response rate
        </p>
      </div>
      <OutreachWizard />
    </div>
  );
}
