import { Skeleton } from "@/components/ui/skeleton";

export default function AdminBillingLoading() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="mt-2 h-4 w-64" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-60 w-full rounded-xl" />
        <Skeleton className="h-60 w-full rounded-xl" />
      </div>
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}
