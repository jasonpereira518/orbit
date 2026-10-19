import { PageHeaderSkeleton } from "@/components/loading/page-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors /meetings/[id]: back link, title and meta line, then the digest and transcript cards. */
export default function MeetingDetailLoading() {
  return (
    <div className="max-w-3xl space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-4 w-28" />
        <PageHeaderSkeleton />
      </div>
      <Skeleton className="h-8 w-36 rounded-lg" />
      <Skeleton className="h-56 w-full rounded-xl" />
      <div className="space-y-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    </div>
  );
}
