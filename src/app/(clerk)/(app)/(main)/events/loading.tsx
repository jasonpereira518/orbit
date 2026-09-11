import { EventsHeader } from "@/components/events/events-header";
import { EventsListSkeleton } from "@/components/loading/page-skeletons";

/** Mirrors page.tsx's shell (real header + same skeleton) for a seamless handoff. */
export default function EventsLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <EventsHeader />
      <EventsListSkeleton />
    </div>
  );
}
