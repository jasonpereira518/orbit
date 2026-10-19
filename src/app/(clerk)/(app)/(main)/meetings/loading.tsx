import { PageHeaderSkeleton } from "@/components/loading/page-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors /meetings: header with the search form in its actions slot, then the list rows. */
export default function MeetingsLoading() {
  return (
    <div className="max-w-3xl space-y-8">
      <PageHeaderSkeleton actions />
      <div className="space-y-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
