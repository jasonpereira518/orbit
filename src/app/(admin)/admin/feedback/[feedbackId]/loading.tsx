import { Skeleton } from "@/components/ui/skeleton";

/** One feedback entry: header, then the stacked panels that quote it and carry triage. */
export default function AdminFeedbackDetailLoading() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="mt-2 h-4 w-80" />
      </div>
      <div className="grid gap-6">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    </div>
  );
}
