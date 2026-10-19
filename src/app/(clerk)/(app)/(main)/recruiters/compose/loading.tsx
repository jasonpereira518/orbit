import { PageHeaderSkeleton } from "@/components/loading/page-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/** The compose page: back link + header, the send-identity card, then the intent card. */
export default function Loading() {
  return (
    <div className="max-w-3xl space-y-8">
      <div className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <PageHeaderSkeleton />
      </div>
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  );
}
