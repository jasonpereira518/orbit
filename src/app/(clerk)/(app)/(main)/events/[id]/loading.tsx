import { EventDetailSkeleton } from "@/components/loading/page-skeletons";
import { PageShell } from "@/components/layout/page-shell";

export default function EventDetailLoading() {
  return (
    <PageShell width="wide" spacing="tight">
      <EventDetailSkeleton />
    </PageShell>
  );
}
