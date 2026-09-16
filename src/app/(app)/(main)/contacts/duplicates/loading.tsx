import { Skeleton } from "@/components/ui/skeleton";

/**
 * Without this, `/contacts/duplicates` inherited `contacts/loading.tsx` — a Suspense
 * boundary covers its own segment AND everything nested under it — so opening the duplicate
 * review flashed the contacts LIST skeleton: a search bar and rows, for a page that has
 * neither. An inherited skeleton of the wrong shape is worse than none, because the layout
 * moves twice.
 *
 * Mirrors the real page: back link, heading, the paragraph explaining what merging does, and
 * the review list.
 */
export default function DuplicatesLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
