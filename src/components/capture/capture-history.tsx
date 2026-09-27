import { listCaptureHistory } from "@/actions/capture";
import { CaptureHistoryList } from "@/components/capture/capture-history-list";
import { Skeleton } from "@/components/ui/skeleton";
import { CAPTURE_HISTORY_FIRST_PAGE } from "@/lib/capture-history";

/**
 * The capture page's history: the first few captures rendered here, the rest paged in by
 * the list itself. Streamed behind its own Suspense boundary so the form above it never
 * waits on this query.
 *
 * A failed read renders nothing rather than an error card — the page's job is the form,
 * and history that could not load is not a reason to put a red box under it.
 */
export async function CaptureHistory() {
  const page = await listCaptureHistory(null, CAPTURE_HISTORY_FIRST_PAGE).catch(() => null);
  if (!page) return null;
  return <CaptureHistoryList initial={page} />;
}

export function CaptureHistorySkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      <Skeleton className="h-5 w-36" />
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-[74px] w-full rounded-xl" />
      ))}
    </div>
  );
}
