import { DuplicatesListSkeleton, PageHeaderSkeleton } from "@/components/loading/page-skeletons";

/**
 * Its own skeleton: without this file the nearest one was `/contacts`', a list of people,
 * which then jumped to a header and a stack of pair cards. Same frame as the page.
 */
export default function DuplicatesLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeaderSkeleton back />
      <DuplicatesListSkeleton />
    </div>
  );
}
