import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { FindHeader } from "@/components/find/find-header";
import { FindPeople } from "@/components/find/find-people";
import { RenderStamp } from "@/components/layout/render-stamp";
import { userCanUseAi } from "@/lib/ai";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { listCampaignChoicesForUser } from "@/lib/outreach-people";
import type { CampaignChoice } from "@/lib/outreach-types";
import { isSurfaceLive } from "@/lib/surface-visibility";
import { listRecentResearch } from "@/lib/web-research";

export const metadata = { title: "Find people" };

/**
 * The campaigns "Add to campaign" offers. None unless this viewer's plan has Outreach AND
 * Outreach is live for them, so a person never gets a button into a page they cannot open.
 */
async function campaignChoices(userId: string): Promise<CampaignChoice[]> {
  const { canUseOutreach } = await getEntitlements(userId);
  return canUseOutreach && (await isSurfaceLive(userId, "page.outreach")) ? listCampaignChoicesForUser(userId) : [];
}

export default async function FindPage() {
  // The gate first, and only then any load. See `pageVisibilityGate`.
  const gate = await pageVisibilityGate("page.find");
  if (gate) return gate;

  const userId = await requireUserId();
  const [canUseAi, recent, campaigns] = await Promise.all([
    userCanUseAi(userId),
    listRecentResearch(userId),
    campaignChoices(userId),
  ]);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <RenderStamp />
      <FindHeader />
      <div className="reveal-mount" style={{ "--reveal-delay": "90ms" } as React.CSSProperties}>
        <FindPeople canUseAi={canUseAi} recent={recent} campaigns={campaigns} />
      </div>
    </div>
  );
}
