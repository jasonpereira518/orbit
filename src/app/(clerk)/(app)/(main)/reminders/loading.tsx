import { RemindersHeader } from "@/components/reminders/reminders-header";
import { RemindersViewSkeleton } from "@/components/loading/page-skeletons";

/** Mirrors page.tsx's shell (real header + same skeleton) for a seamless handoff. */
export default function RemindersLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <RemindersHeader />
      <RemindersViewSkeleton />
    </div>
  );
}
