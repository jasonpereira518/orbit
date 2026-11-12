import { Skeleton } from "@/components/ui/skeleton";

/**
 * The meeting detail page reads the session, its digest and every transcript segment before
 * it renders. Without its own boundary the list's skeleton (`../loading.tsx`) stood in for a
 * page of a different shape; this one matches the detail layout: back link, title and meta
 * line, the recap card, then transcript rows.
 */
export default function MeetingDetailLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-6" aria-busy="true">
      <Skeleton className="h-4 w-24" />
      <div className="space-y-2">
        <Skeleton className="h-9 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-48 w-full rounded-2xl" />
      <div className="space-y-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
