import { Suspense } from "react";
import { getTeamEligibility, listTeamMembersAction } from "@/actions/teams";
import { loadPipelineAction } from "@/actions/leads";
import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { ApolloSearch } from "@/components/leads/apollo-search";
import { FindPath } from "@/components/leads/find-path";
import { LeadsHeader } from "@/components/leads/leads-header";
import { LeadsPipeline } from "@/components/leads/leads-pipeline";
import { TeamPanel } from "@/components/leads/team-panel";
import { LeadsPipelineSkeleton, TeamPanelSkeleton } from "@/components/loading/page-skeletons";
import { requireUserId } from "@/lib/auth";

export default async function LeadsPage() {
  // First, before anything else: a click straight from a sibling route skips the
  // layout-level check (see `pageVisibilityGate`), and nothing below should run for a
  // page that is not out yet. The sections are declared below this function for the same
  // reason — `scripts/smoke-leads-page.ts` checks the gate is the file's first await.
  const gate = await pageVisibilityGate("page.leads");
  if (gate) return gate;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <LeadsHeader />
      <div className="reveal-mount" style={{ "--reveal-delay": "60ms" } as React.CSSProperties}>
        <Suspense fallback={<TeamPanelSkeleton />}>
          <TeamSection />
        </Suspense>
      </div>
      <div className="reveal-mount" style={{ "--reveal-delay": "90ms" } as React.CSSProperties}>
        <FindPath />
      </div>
      <div className="reveal-mount" style={{ "--reveal-delay": "120ms" } as React.CSSProperties}>
        <Suspense fallback={<LeadsPipelineSkeleton />}>
          <PipelineSection />
        </Suspense>
      </div>
      <div className="reveal-mount" style={{ "--reveal-delay": "150ms" } as React.CSSProperties}>
        <ApolloSearch />
      </div>
    </div>
  );
}

async function TeamSection() {
  const [eligibility, userId] = await Promise.all([getTeamEligibility(), requireUserId()]);
  const members = eligibility.kind === "member" ? await listTeamMembersAction() : [];
  return <TeamPanel eligibility={eligibility} members={members} viewerUserId={userId} />;
}

async function PipelineSection() {
  const pipeline = await loadPipelineAction();
  return <LeadsPipeline pipeline={pipeline} />;
}
