import Link from "next/link";
import { notFound } from "next/navigation";
import { getCampaign } from "@/actions/outreach";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { OutreachLocked } from "@/components/locked-feature";
import { CampaignEditor } from "@/components/outreach/campaign-editor";
import { CampaignWorkspace } from "@/components/outreach/campaign-workspace";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { channelLabel } from "@/lib/outreach-channels";
import { formatReplyRate } from "@/lib/outreach-metrics";
import {
  REPLY_CTA_LABELS,
  type OutreachChannel,
  type OutreachReplyCta,
  type SequenceStep,
} from "@/lib/outreach-types";
import { RenderStamp } from "@/components/layout/render-stamp";

/** Stored campaign status → the word on the chip. The stored values never change. */
function labelForCampaignStatus(status: string): { label: string; tone: "neutral" | "success" | "info" } {
  switch (status) {
    case "active":
      return { label: "Active", tone: "success" };
    case "completed":
      return { label: "Completed", tone: "info" };
    case "archived":
      return { label: "Archived", tone: "neutral" };
    default:
      return { label: "Draft", tone: "neutral" };
  }
}

function labelForTone(tone: string) {
  return tone.charAt(0).toUpperCase() + tone.slice(1);
}

function labelForChannel(channel: string) {
  return channelLabel(channel as OutreachChannel);
}

function labelForReplyCta(cta: string) {
  return REPLY_CTA_LABELS[cta as OutreachReplyCta] ?? cta.replaceAll("_", " ");
}

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

  const status = labelForCampaignStatus(campaign.status);

  return (
    <PageShell width="wide">
      <RenderStamp />
      <PageHeader
        back={{ href: "/outreach", label: "Back to outreach" }}
        title={campaign.name}
        description={
          <>
            {campaign.audienceQuery}
            {/* Spans, not divs: this sits inside the header's description paragraph. */}
            <span className="mt-2 flex flex-wrap gap-2">
              <Badge tone={status.tone} size="sm">
                {status.label}
              </Badge>
              <Badge tone="neutral" size="sm">
                {labelForChannel(campaign.defaultChannel || "email")}
              </Badge>
              <Badge tone="neutral" size="sm">
                {labelForTone(campaign.tone || "professional")}
              </Badge>
              {campaign.replyCta && (
                <Badge tone="neutral" size="sm">
                  {labelForReplyCta(campaign.replyCta)}
                </Badge>
              )}
              {campaign.lastSearchSource === "demo" && (
                <Badge tone="warning" size="sm">
                  Demo search
                </Badge>
              )}
              <Badge tone="accent" size="sm">
                Reply rate {formatReplyRate(campaign.metrics.successfulReplyRate)}
              </Badge>
            </span>
          </>
        }
        actions={
          <>
            <CampaignEditor campaign={editorCampaign} />
            <Link href="/outreach/new" className={buttonVariants({ variant: "outline" })}>
              New campaign
            </Link>
          </>
        }
      />

      <CampaignWorkspace
        campaign={{
          ...campaign,
          sequenceSteps: (campaign.sequenceSteps ?? []) as SequenceStep[],
        }}
      />
    </PageShell>
  );
}
