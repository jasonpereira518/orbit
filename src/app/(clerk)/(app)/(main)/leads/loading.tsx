import { LeadsHeader } from "@/components/leads/leads-header";
import { LeadsPipelineSkeleton, TeamPanelSkeleton } from "@/components/loading/page-skeletons";

/** Mirrors page.tsx's shell (real header + the same skeletons) for a seamless handoff. */
export default function LeadsLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <LeadsHeader />
      <TeamPanelSkeleton />
      <LeadsPipelineSkeleton />
    </div>
  );
}
