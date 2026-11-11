import { Skeleton } from "@/components/ui/skeleton";

/** The history's stand-in while it streams: a few rows of the timeline's rough height. */
export function TimelineSkeleton() {
  return (
    <div role="status" aria-label="Loading history" className="space-y-3">
      <Skeleton className="h-24 w-full rounded-2xl" />
      <Skeleton className="h-24 w-full rounded-2xl" />
      <Skeleton className="h-24 w-full rounded-2xl" />
    </div>
  );
}

/**
 * The dossier's stand-in while it streams: the header, the snapshot, then the history below
 * it, in the same shape the real thing takes.
 */
export function DossierSkeleton() {
  return (
    <div role="status" aria-label="Loading person" className="space-y-5">
      <div className="flex items-start gap-4">
        <Skeleton className="size-12 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-7 w-56 max-w-full" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      <Skeleton className="h-96 w-full rounded-2xl" />
      <TimelineSkeleton />
    </div>
  );
}

/**
 * The whole page's stand-in, shared by `loading.tsx`: the list rail and a dossier.
 */
export function KnowledgePageSkeleton() {
  return (
    <div
      data-fill-route
      className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-4"
    >
      <div className="shrink-0 space-y-2">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-96 w-full rounded-2xl" />
        </div>
        <div className="hidden lg:block">
          <DossierSkeleton />
        </div>
      </div>
    </div>
  );
}
