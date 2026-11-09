import { ApolloSearch } from "@/components/leads/apollo-search";
import { FindPath } from "@/components/leads/find-path";
import { LeadsHeader } from "@/components/leads/leads-header";
import { CrmCardSkeleton, LeadsPipelineSkeleton, TeamPanelSkeleton } from "@/components/loading/page-skeletons";

/** Mirrors page.tsx part for part: the three data sections as skeletons, and the two sections that fetch nothing as themselves, so the handoff moves nothing. */
export default function LeadsLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <LeadsHeader />
      <TeamPanelSkeleton />
      <CrmCardSkeleton />
      <FindPath />
      <LeadsPipelineSkeleton />
      <ApolloSearch />
    </div>
  );
}
