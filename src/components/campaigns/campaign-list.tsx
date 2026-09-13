import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import type { CampaignListItem } from "@/lib/outreach/campaigns";
import { cn } from "@/lib/utils";

const STEP_LABEL: Record<string, string> = {
  describe: "Describing",
  audience: "Choosing an audience",
  people: "Finding people",
  review: "Reviewing drafts",
  send: "Sending",
  tracking: "In conversation",
};

const CHANNEL_LABEL: Record<string, string> = { email: "Email", linkedin: "LinkedIn", sms: "SMS" };

export function CampaignList({ campaigns }: { campaigns: CampaignListItem[] }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">Outreach</h1>
          <p className="mt-1 text-muted-foreground">Find the people worth meeting, and start real conversations with them</p>
        </div>
        <Link href="/outreach/new" className={cn(buttonVariants(), "bg-primary text-primary-foreground hover:bg-primary/90")}>
          <Plus className="mr-1 h-4 w-4" aria-hidden />
          New campaign
        </Link>
      </div>

      {campaigns.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 p-12 text-center">
          <p className="text-muted-foreground">No campaigns yet. Describe who you want to meet and why, and Orbit finds them.</p>
          <Link href="/outreach/new" className={cn(buttonVariants({ variant: "outline" }), "mt-4 inline-flex")}>
            Start a campaign
          </Link>
        </div>
      ) : (
        <ul className="grid gap-3">
          {campaigns.map((campaign) => (
            <li key={campaign.id}>
              <Link
                href={`/outreach/${campaign.id}`}
                className="block rounded-2xl border border-border/70 bg-card px-5 py-4 transition-colors hover:border-primary/40 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-medium text-ink">{campaign.name}</h2>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {campaign.prospectCount} {campaign.prospectCount === 1 ? "person" : "people"}
                      {campaign.selectedCount > 0 ? ` · ${campaign.selectedCount} selected` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline">{CHANNEL_LABEL[campaign.channel ?? "email"] ?? "Email"}</Badge>
                    {campaign.generation === 1 ? (
                      <Badge variant="secondary">Earlier campaign</Badge>
                    ) : (
                      <Badge variant="outline">{STEP_LABEL[campaign.setupStep ?? "audience"]}</Badge>
                    )}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
