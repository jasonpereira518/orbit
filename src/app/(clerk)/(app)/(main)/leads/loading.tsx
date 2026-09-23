import { LeadsHeader } from "@/components/leads/leads-header";
import { GenericPageSkeleton } from "@/components/loading/page-skeletons";

/** Mirrors page.tsx's shell (real header + a skeleton) for a seamless handoff. */
export default function LeadsLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <LeadsHeader />
      <GenericPageSkeleton />
    </div>
  );
}
