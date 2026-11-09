import { Skeleton } from "@/components/ui/skeleton";

/**
 * The phone waits on one handoff lookup before the camera button appears. On a cold start
 * over mobile data that is long enough to look like a dead link, so show the page's shape
 * (same outer frame as `page.tsx`) instead of a blank screen.
 */
export default function ScanHandoffLoading() {
  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-5 pt-5"
      style={{ paddingTop: "calc(1.25rem + env(safe-area-inset-top))" }}
      aria-busy="true"
    >
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <Skeleton className="aspect-[3/4] w-full rounded-2xl" />
      <Skeleton className="mx-auto size-16 rounded-full" />
    </main>
  );
}
