import Link from "next/link";
import { notFound } from "next/navigation";
import { getCampaign } from "@/actions/outreach";
import { CampaignEditor } from "@/components/outreach/campaign-editor";
import { CampaignWorkspace } from "@/components/outreach/campaign-workspace";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export default async function OutreachCampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/outreach"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← All campaigns
          </Link>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl text-primary">
            {campaign.name}
          </h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            {campaign.audienceQuery}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant="outline">{campaign.status}</Badge>
            <Badge variant="outline">{campaign.defaultChannel || "email"}</Badge>
            <Badge variant="outline">{campaign.tone || "professional"}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <CampaignEditor campaign={editorCampaign} />
          <Link href="/outreach/new" className={buttonVariants({ variant: "outline" })}>
            New campaign
          </Link>
        </div>
      </div>

      <CampaignWorkspace campaign={campaign} />
    </div>
  );
}
