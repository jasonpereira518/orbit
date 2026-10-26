import Link from "next/link";
import { Plus } from "lucide-react";
import { listCampaigns } from "@/actions/outreach";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { OutreachLocked } from "@/components/locked-feature";
import { OutreachCampaignCard } from "@/components/outreach/outreach-campaign-card";
import { buttonVariants } from "@/components/ui/button";
import { formatReplyRate } from "@/lib/outreach-metrics";
import { cn } from "@/lib/utils";
import { RenderStamp } from "@/components/layout/render-stamp";

export const metadata = { title: "Outreach" };

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
      acc.replies += c.metrics.replyCount;
      return acc;
    },
    { sent: 0, bounced: 0, replies: 0 }
  );
  const eligible = Math.max(0, totals.sent - totals.bounced);
  const accountRate = eligible > 0 ? totals.replies / eligible : null;

  const ranked = [...campaigns].sort((a, b) => {
    const aRate = a.metrics.replyRate;
    const bRate = b.metrics.replyRate;
    if (aRate == null && bRate == null) {
      return b.metrics.sentCount - a.metrics.sentCount;
    }
    if (aRate == null) return 1;
    if (bRate == null) return -1;
    if (bRate !== aRate) return bRate - aRate;
    return b.metrics.replyCount - a.metrics.replyCount;
  });

  return (
    <div className="space-y-6">
      <RenderStamp />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
            Outreach
          </h1>
          <p className="mt-1 text-muted-foreground">
            Reach people you don’t know yet — from your own email
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

      {campaigns.length > 0 && (
        <div className="rounded-2xl border border-border/70 bg-card px-5 py-4">
          <div className="text-xs text-muted-foreground">Account reply rate</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-4">
            <span className="font-[family-name:var(--font-display)] text-3xl text-ink">
              {formatReplyRate(accountRate)}
            </span>
            <span className="text-sm text-muted-foreground">
              {totals.replies} replied · {totals.sent} sent
            </span>
          </div>
        </div>
      )}

      {ranked.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 p-12 text-center">
          <p className="text-muted-foreground">
            No campaigns yet. Describe who you want to reach and why.
          </p>
          <Link
            href="/outreach/new"
            className={cn(buttonVariants({ variant: "outline" }), "mt-4 inline-flex")}
          >
            Start your first campaign
          </Link>
        </div>
      ) : (
        <div className="grid gap-4">
          {ranked.map((campaign) => (
            <OutreachCampaignCard key={campaign.id} campaign={campaign} />
          ))}
        </div>
      )}
    </div>
  );
}
