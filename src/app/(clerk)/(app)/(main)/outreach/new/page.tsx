import { OutreachWizard } from "@/components/outreach/outreach-wizard";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { OutreachLocked } from "@/components/locked-feature";
import { RenderStamp } from "@/components/layout/render-stamp";
import { PageHeader } from "@/components/layout/page-header";

export default async function NewOutreachPage() {
  // See `OutreachPage` for why this comes before the paywall, and `pageVisibilityGate`'s
  // doc comment for why the layout-level check alone is not enough.
  const gate = await pageVisibilityGate("page.outreach");
  if (gate) return gate;

  const { canUseOutreach } = await getEntitlements(await requireUserId());
  if (!canUseOutreach) return <OutreachLocked />;

  return (
    <div className="space-y-6">
      <RenderStamp />
      <PageHeader
        back={{ href: "/outreach", label: "All campaigns" }}
        title="New outreach campaign"
        subtitle="Define a tight audience, a desired reply, and personalized drafts optimized for response rate"
      />
      <OutreachWizard />
    </div>
  );
}
