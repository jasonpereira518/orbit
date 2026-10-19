import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { RadarPageSkeleton } from "@/components/loading/page-skeletons";

/** Mirrors page.tsx's shell (the same static header + the same skeleton) for a seamless handoff. */
export default function RadarLoading() {
  return (
    <PageShell width="wide">
      <PageHeader
        title="Radar"
        description="Who to reach out to this week, and why. Orbit checks your network every night."
      />
      <RadarPageSkeleton />
    </PageShell>
  );
}
