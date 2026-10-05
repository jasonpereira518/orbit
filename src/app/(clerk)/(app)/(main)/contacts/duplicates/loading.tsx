import { Skeleton } from "@/components/ui/skeleton";
import { DuplicatesListSkeleton } from "@/components/loading/page-skeletons";

/**
 * Its own skeleton: without this file the nearest one was `/contacts`', a list of people,
 * which then jumped to a header and a stack of pair cards. Same frame as the page.
 */
export default function DuplicatesLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
      <DuplicatesListSkeleton />
    </div>
  );
}
