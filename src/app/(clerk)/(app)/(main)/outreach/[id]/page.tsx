import Link from "next/link";
import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { getCampaign } from "@/actions/outreach";
import { userCanUseAi } from "@/lib/ai";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { OutreachLocked } from "@/components/locked-feature";
import { CampaignPeople, type CampaignPerson } from "@/components/outreach/campaign-people";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { campaignKnownNamesForUser } from "@/lib/outreach-people";
import { formatReplyRate } from "@/lib/outreach-metrics";
import { readEnrichment, type OutreachChannel } from "@/lib/outreach-types";
import { findWarmPaths } from "@/lib/warm-paths-server";
import { orgKeysFor } from "@/lib/warm-paths";
import { cn } from "@/lib/utils";
import { RenderStamp } from "@/components/layout/render-stamp";

const TABS = [
  { value: "people", label: "People" },
  { value: "messages", label: "Messages" },
] as const;

/** Request-memoized so `generateMetadata` and the page share one read. */
const loadCampaign = cache((id: string) => getCampaign(id));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const campaign = await loadCampaign(id).catch(() => null);
  return { title: campaign?.name || "Campaign" };
}

export default async function OutreachCampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  // See `OutreachPage` for why this comes before the paywall, and `pageVisibilityGate`'s
  // doc comment for why the layout-level check alone is not enough.
  const gate = await pageVisibilityGate("page.outreach");
  if (gate) return gate;

  const { id } = await params;
  const userId = await requireUserId();
  const { canUseOutreach } = await getEntitlements(userId);
  if (!canUseOutreach) return <OutreachLocked />;

  const tab = (await searchParams).tab === "messages" ? "messages" : "people";

  let campaign;
  try {
    campaign = await loadCampaign(id);
  } catch {
    notFound();
  }

  // Someone removed from the list is kept as `excluded` so a search won’t offer them again;
  // here they are simply not on the campaign.
  const people: CampaignPerson[] = campaign.prospects
    .filter((p) => p.status !== "excluded")
    .map((p) => ({
      id: p.id,
      status: p.status,
      fullName: p.fullName,
      title: p.title,
      company: p.company,
      email: p.email,
      linkedinUrl: p.linkedinUrl,
      contactId: p.contactId,
      enrichment: readEnrichment(p.enrichment),
      messages: p.messages.map((m) => ({
        id: m.id,
        status: m.status,
        outcome: m.outcome,
        stepIndex: m.stepIndex,
        channel: m.channel,
        sentAt: m.sentAt,
        scheduledFor: m.scheduledFor,
      })),
    }));
  const channel: OutreachChannel = campaign.defaultChannel === "linkedin" ? "linkedin" : "email";

  const [warmPaths, knownNames, canUseAi] =
    tab === "people"
      ? await Promise.all([
          findWarmPaths(userId, orgKeysFor(people.map((p) => p.company))).then((paths) =>
            Object.fromEntries(paths)
          ),
          campaignKnownNamesForUser(userId, id),
          userCanUseAi(userId),
        ])
      : [{}, [], false];

  return (
    <div className="space-y-6">
      <RenderStamp />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/outreach"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← All campaigns
          </Link>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl text-ink">
            {campaign.name}
          </h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            {campaign.audienceQuery}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant="outline">{campaign.status}</Badge>
            <Badge variant="outline">{campaign.defaultChannel || "email"}</Badge>
            <Badge variant="outline">{campaign.tone || "professional"}</Badge>
            {campaign.replyCta && (
              <Badge variant="outline">{campaign.replyCta.replaceAll("_", " ")}</Badge>
            )}
            {campaign.lastSearchSource === "demo" && (
              <Badge variant="outline">Demo search</Badge>
            )}
            <Badge variant="outline">
              Reply rate {formatReplyRate(campaign.metrics.replyRate)}
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/outreach/new" className={buttonVariants({ variant: "outline" })}>
            New campaign
          </Link>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Campaign sections"
        className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-1"
      >
        {TABS.map(({ value, label }) => (
          <Link
            key={value}
            id={`campaign-tab-${value}`}
            href={`/outreach/${campaign.id}?tab=${value}`}
            role="tab"
            aria-selected={tab === value}
            aria-controls="campaign-tabpanel"
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
              tab === value ? "bg-background text-ink shadow-sm" : "text-muted-foreground hover:text-ink"
            )}
          >
            {label}
            {value === "people" && <span className="text-muted-foreground">{people.length}</span>}
          </Link>
        ))}
      </div>

      <div role="tabpanel" id="campaign-tabpanel" aria-labelledby={`campaign-tab-${tab}`}>
        {tab === "people" ? (
          <CampaignPeople
            campaign={{ id: campaign.id, audienceQuery: campaign.audienceQuery ?? "" }}
            channel={channel}
            prospects={people}
            warmPaths={warmPaths}
            knownNames={knownNames}
            canUseAi={canUseAi}
          />
        ) : (
          <p className="rounded-2xl border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">
            Drafting and sending arrive here next.
          </p>
        )}
      </div>
    </div>
  );
}
