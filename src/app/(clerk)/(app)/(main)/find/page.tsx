import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { revealDelay } from "@/components/dashboard/dashboard-sections";
import { FindPeople } from "@/components/find/find-people";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { RenderStamp } from "@/components/layout/render-stamp";
import { userCanUseAi } from "@/lib/ai";
import { requireUserId } from "@/lib/auth";
import { listRecentResearch } from "@/lib/web-research";

export default async function FindPage() {
  // The gate first, and only then any load. See `pageVisibilityGate`.
  const gate = await pageVisibilityGate("page.find");
  if (gate) return gate;

  const userId = await requireUserId();
  const [canUseAi, recent] = await Promise.all([userCanUseAi(userId), listRecentResearch(userId)]);
  return (
    <PageShell width="default">
      <RenderStamp />
      <PageHeader
        title="Find people"
        description="Research someone outside your network from the public web, then save them to Orbit."
      />
      <div className="reveal-mount" style={revealDelay(90)}>
        <FindPeople canUseAi={canUseAi} recent={recent} />
      </div>
    </PageShell>
  );
}
