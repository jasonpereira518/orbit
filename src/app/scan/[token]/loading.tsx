import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the phone capture page: a title line, the viewfinder, and the shutter row. */
export default function ScanLoading() {
  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-5 pt-5"
      style={{ paddingTop: "calc(1.25rem + env(safe-area-inset-top))" }}
    >
      <div className="space-y-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <Skeleton className="aspect-[3/4] w-full rounded-xl" />
      <Skeleton className="h-10 w-full rounded-lg" />
    </main>
  );
}
