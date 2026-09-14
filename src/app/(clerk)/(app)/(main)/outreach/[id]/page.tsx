import { enabled } from "@/lib/outreach-v2/store";
import { getOutreachWorkspace, getOutreachSetup } from "@/actions/outreach-v2";
import { OutreachSetup } from "@/components/outreach/outreach-v2-setup";
import { OutreachWorkspace } from "@/components/outreach/outreach-v2-workspace";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCampaign } from "@/actions/outreach";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { OutreachLocked } from "@/components/locked-feature";
import { CampaignEditor } from "@/components/outreach/campaign-editor";
import { CampaignWorkspace } from "@/components/outreach/campaign-workspace";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatReplyRate } from "@/lib/outreach-metrics";
import type { SequenceStep } from "@/lib/outreach-types";
export const maxDuration = 300;

export default async function OutreachCampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { canUseOutreach } = await getEntitlements(await requireUserId());
  if (!canUseOutreach) return <OutreachLocked />;

  let campaign;
  try {
    campaign = await getCampaign(id);
  } catch {
    notFound();
  }

  if (campaign.version === 2) {
    if (!enabled())
      return (
        <div className="space-y-4">
          <h1 className="text-2xl">{campaign.name}</h1>
          <p>
            The revised Outreach workspace is temporarily unavailable. Your
            campaign history is preserved.
          </p>
        </div>
      );
    return <OutreachWorkspace initial={await getOutreachWorkspace(id)} />;
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
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl text-ink">
            {campaign.name}
          </h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            {campaign.audienceQuery}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant="outline">{campaign.status}</Badge>
            <Badge variant="outline">
              {campaign.defaultChannel || "email"}
            </Badge>
            <Badge variant="outline">{campaign.tone || "professional"}</Badge>
            {campaign.replyCta && (
              <Badge variant="outline">
                {campaign.replyCta.replaceAll("_", " ")}
              </Badge>
            )}
            {campaign.lastSearchSource === "demo" && (
              <Badge variant="outline">Demo search</Badge>
            )}
            <Badge variant="outline">
              Reply rate {formatReplyRate(campaign.metrics.successfulReplyRate)}
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!enabled() && <CampaignEditor campaign={editorCampaign} />}
          <Link
            href="/outreach/new"
            className={buttonVariants({ variant: "outline" })}
          >
            New campaign
          </Link>
        </div>
      </div>

      {enabled() && (
        <div className="space-y-4 rounded-lg border p-5">
          <p>
            Historical campaign. Existing messages are preserved; scheduled
            follow-ups require review before sending.
          </p>
          {campaign.defaultChannel !== "sms" && (
            <details>
              <summary className="cursor-pointer font-medium">
                Choose a sender and upgrade this campaign
              </summary>
              <div className="mt-6">
                <OutreachSetup
                  settings={await getOutreachSetup()}
                  legacy={{
                    id,
                    name: campaign.name,
                    description: campaign.audienceQuery ?? campaign.name,
                    outcome: campaign.messageIntent ?? "Start a conversation",
                    channel:
                      campaign.defaultChannel === "linkedin"
                        ? "linkedin"
                        : "email",
                  }}
                />
              </div>
            </details>
          )}
        </div>
      )}

      {enabled() ? (
        <div className="space-y-4">
          {campaign.prospects.map((p) => (
            <details key={p.id} className="rounded-lg border p-4">
              <summary className="cursor-pointer font-medium">
                {p.fullName} · {p.messages.length} messages
              </summary>
              <div className="mt-4 space-y-4">
                {p.messages.map((m) => (
                  <article key={m.id} className="border-t pt-4">
                    <p className="text-sm text-muted-foreground">
                      {m.channel} ·{" "}
                      {m.status === "scheduled"
                        ? "Follow-up suggestion — review required"
                        : m.status}
                    </p>
                    <p className="mt-2 font-medium">{m.subject}</p>
                    <p className="mt-2 whitespace-pre-wrap text-sm">{m.body}</p>
                  </article>
                ))}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <CampaignWorkspace
          campaign={{
            ...campaign,
            sequenceSteps: (campaign.sequenceSteps ?? []) as SequenceStep[],
          }}
        />
      )}
    </div>
  );
}
