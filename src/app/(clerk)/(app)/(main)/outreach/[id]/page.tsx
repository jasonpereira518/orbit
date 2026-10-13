import Link from "next/link";
import { notFound } from "next/navigation";
import { getCampaign } from "@/actions/outreach";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { OutreachLocked } from "@/components/locked-feature";
import { CampaignEditor } from "@/components/outreach/campaign-editor";
import { CampaignWorkspace } from "@/components/outreach/campaign-workspace";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatReplyRate } from "@/lib/outreach-metrics";
import type { SequenceStep } from "@/lib/outreach-types";
import { RenderStamp } from "@/components/layout/render-stamp";
import { PageHeader } from "@/components/layout/page-header";

export default async function OutreachCampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // See `OutreachPage` for why this comes before the paywall, and `pageVisibilityGate`'s
  // doc comment for why the layout-level check alone is not enough.
  const gate = await pageVisibilityGate("page.outreach");
  if (gate) return gate;

  const { id } = await params;
  const { canUseOutreach } = await getEntitlements(await requireUserId());
  if (!canUseOutreach) return <OutreachLocked />;

  let campaign;
  try {
    campaign = await getCampaign(id);
  } catch {
    notFound();
  }

  const editorCampaign = {
    id: campaign.id,
    name: campaign.name,
    audienceQuery: campaign.audienceQuery,
    messageIntent: campaign.messageIntent,
    tone: campaign.tone,
    defaultChannel: campaign.defaultChannel,
    status: campaign.status,
  };

  return (
    <div className="space-y-6">
      <RenderStamp />
      <PageHeader
        back={{ href: "/outreach", label: "All campaigns" }}
        title={campaign.name}
        subtitle={campaign.audienceQuery}
        actions={
          <>
            <CampaignEditor campaign={editorCampaign} />
            <Link href="/outreach/new" className={buttonVariants({ variant: "outline" })}>
              New campaign
            </Link>
          </>
        }
      >
        <Badge variant="outline">{campaign.status}</Badge>
        <Badge variant="outline">{campaign.defaultChannel || "email"}</Badge>
        <Badge variant="outline">{campaign.tone || "professional"}</Badge>
        {campaign.replyCta && (
          <Badge variant="outline">{campaign.replyCta.replaceAll("_", " ")}</Badge>
        )}
        {campaign.lastSearchSource === "demo" && <Badge variant="outline">Demo search</Badge>}
        <Badge variant="outline">
          Reply rate {formatReplyRate(campaign.metrics.successfulReplyRate)}
        </Badge>
      </PageHeader>

      <CampaignWorkspace
        campaign={{
          ...campaign,
          sequenceSteps: (campaign.sequenceSteps ?? []) as SequenceStep[],
        }}
      />
    </div>
  );
}
