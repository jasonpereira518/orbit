import { OutreachWizard } from "@/components/outreach/outreach-wizard";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { OutreachLocked } from "@/components/locked-feature";
import { RenderStamp } from "@/components/layout/render-stamp";

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
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          New outreach campaign
        </h1>
        <p className="mt-1 text-muted-foreground">
          Define a tight audience, a desired reply, and personalized drafts optimized for response rate
        </p>
      </div>
      <OutreachWizard />
    </div>
  );
}
