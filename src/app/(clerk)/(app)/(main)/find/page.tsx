import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { FindHeader } from "@/components/find/find-header";
import { FindPeople } from "@/components/find/find-people";
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
    <div className="mx-auto max-w-3xl space-y-6">
      <RenderStamp />
      <FindHeader />
      <div className="reveal-mount" style={{ "--reveal-delay": "90ms" } as React.CSSProperties}>
        <FindPeople canUseAi={canUseAi} recent={recent} />
      </div>
    </div>
  );
}
