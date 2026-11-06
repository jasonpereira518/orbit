import { FindPageSkeleton } from "@/components/loading/page-skeletons";
import { FindHeader } from "@/components/find/find-header";

/** Mirrors page.tsx's shell (real header + same skeleton) for a seamless handoff. */
export default function FindLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <FindHeader />
      <FindPageSkeleton />
    </div>
  );
}
