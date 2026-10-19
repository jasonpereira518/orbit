import { OutreachWizard } from "@/components/outreach/outreach-wizard";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { OutreachLocked } from "@/components/locked-feature";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { RenderStamp } from "@/components/layout/render-stamp";

export default async function NewOutreachPage() {
  // See `OutreachPage` for why this comes before the paywall, and `pageVisibilityGate`'s
  // doc comment for why the layout-level check alone is not enough.
  const gate = await pageVisibilityGate("page.outreach");
  if (gate) return gate;

  const { canUseOutreach } = await getEntitlements(await requireUserId());
  if (!canUseOutreach) return <OutreachLocked />;

  return (
    <PageShell width="wide">
      <RenderStamp />
      <PageHeader
        back={{ href: "/outreach", label: "Back to outreach" }}
        title="New outreach campaign"
        description="Define a tight audience, a desired reply, and personalized drafts optimized for response rate."
      />
      <OutreachWizard />
    </PageShell>
  );
}
