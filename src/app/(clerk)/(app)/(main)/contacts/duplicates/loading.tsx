import { PageShell } from "@/components/layout/page-shell";
import {
  DuplicatesListSkeleton,
  PageHeaderSkeleton,
} from "@/components/loading/page-skeletons";

/**
 * Its own skeleton: without this file the nearest one was `/contacts`', a list of people,
 * which then jumped to a header and a stack of pair cards. Same frame as the page.
 */
export default function DuplicatesLoading() {
  return (
    <PageShell>
      <PageHeaderSkeleton />
      <DuplicatesListSkeleton />
    </PageShell>
  );
}
