import { EventsHeader } from "@/components/events/events-header";
import { EventsListSkeleton } from "@/components/loading/page-skeletons";
import { PageShell } from "@/components/layout/page-shell";

/** Mirrors page.tsx's shell (real header + same skeleton) for a seamless handoff. */
export default function EventsLoading() {
  return (
    <PageShell width="wide" spacing="tight">
      <EventsHeader />
      <EventsListSkeleton />
    </PageShell>
  );
}
