import { RadarPageSkeleton } from "@/components/loading/page-skeletons";
import { RadarHeader } from "@/components/radar/radar-header";

/** Mirrors page.tsx's shell (real header + same skeleton) for a seamless handoff. */
export default function RadarLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <RadarHeader />
      <RadarPageSkeleton />
    </div>
  );
}
