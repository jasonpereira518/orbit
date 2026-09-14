import { Skeleton } from "@/components/ui/skeleton";

export default function AdminUsersLoading() {
  return (
    <div className="space-y-4">
      <div>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="mt-2 h-4 w-40" />
      </div>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  );
}
