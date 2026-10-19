import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { FindPageSkeleton } from "@/components/loading/page-skeletons";

/** Mirrors page.tsx's shell (the same static header + the same skeleton) for a seamless handoff. */
export default function FindLoading() {
  return (
    <PageShell width="default">
      <PageHeader
        title="Find people"
        description="Research someone outside your network from the public web, then save them to Orbit."
      />
      <FindPageSkeleton />
    </PageShell>
  );
}
