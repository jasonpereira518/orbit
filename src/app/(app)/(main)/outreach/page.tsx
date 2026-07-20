import Link from "next/link";
import { Plus } from "lucide-react";
import { listCampaigns } from "@/actions/outreach";
import { OutreachCampaignCard } from "@/components/outreach/outreach-campaign-card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default async function OutreachPage() {
  const campaigns = await listCampaigns();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
            Outreach
          </h1>
          <p className="mt-1 text-muted-foreground">
            Find cold prospects, generate drafts, and send from your apps
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

      {campaigns.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 p-12 text-center">
          <p className="text-muted-foreground">No campaigns yet.</p>
          <Link
            href="/outreach/new"
            className={cn(buttonVariants({ variant: "outline" }), "mt-4 inline-flex")}
          >
            Start your first campaign
          </Link>
        </div>
      ) : (
        <div className="grid gap-4">
          {campaigns.map((campaign) => (
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
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
