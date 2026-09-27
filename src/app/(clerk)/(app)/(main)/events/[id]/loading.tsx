import { EventDetailSkeleton } from "@/components/loading/page-skeletons";

export default function EventDetailLoading() {
  return (
    <div className="mx-auto max-w-5xl">
      <EventDetailSkeleton />
    </div>
  );
}
