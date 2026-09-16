import { Skeleton } from "@/components/ui/skeleton";

export default function AdminUserDetailLoading() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-2 h-3 w-48" />
      </div>
      <div className="flex gap-8">
        <Skeleton className="hidden h-64 w-40 shrink-0 lg:block" />
        <div className="min-w-0 flex-1 space-y-6">
          <Skeleton className="h-52 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
