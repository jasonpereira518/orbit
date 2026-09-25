import { RemindersStageSkeleton } from "@/components/loading/page-skeletons";

/** The same skeleton page.tsx streams behind, so the handoff doesn't move anything. */
export default function RemindersLoading() {
  return <RemindersStageSkeleton />;
}
