import { Skeleton } from "@/components/ui/skeleton";

function PageHeaderSkeleton({
  subtitle = true,
  actions = false,
}: {
  subtitle?: boolean;
  actions?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-2">
        <Skeleton className="h-9 w-48" />
        {subtitle && <Skeleton className="h-4 w-64 max-w-full" />}
      </div>
      {actions && (
        <div className="flex gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-28" />
        </div>
      )}
    </div>
  );
}

export function GenericPageSkeleton() {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton />
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
    </div>
  );
}

export function DashboardPageSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-56" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-10 w-full max-w-md rounded-lg" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-80 rounded-2xl" />
        <Skeleton className="h-80 rounded-2xl" />
      </div>
      <Skeleton className="h-48 rounded-2xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    </div>
  );
}

export function ContactsPageSkeleton() {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton actions />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 rounded-lg" />
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl border border-border/70">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-4 last:border-0"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-6 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ContactDetailPageSkeleton() {
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-10 w-56" />
          <Skeleton className="h-4 w-40" />
          <div className="flex gap-2">
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
      <Skeleton className="h-52 w-full rounded-2xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-56 rounded-2xl" />
        <Skeleton className="h-56 rounded-2xl" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-80 w-full rounded-2xl" />
      </div>
    </div>
  );
}

export function FormPageSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div className={`space-y-6 ${wide ? "" : "mx-auto max-w-2xl"}`}>
      <PageHeaderSkeleton />
      <div className="space-y-4 rounded-2xl border border-border/70 p-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        ))}
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="mt-2 h-9 w-32" />
      </div>
    </div>
  );
}

export function ChatPageSkeleton() {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="flex gap-1 lg:hidden">
        <Skeleton className="h-8 w-16 rounded-md" />
        <Skeleton className="h-8 w-16 rounded-md" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <div className="flex min-h-[min(70vh,640px)] flex-col overflow-hidden rounded-2xl border border-border/70">
          <div className="border-b border-border/60 px-4 py-3">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="mt-1.5 h-3 w-40" />
          </div>
          <div className="flex-1 space-y-4 p-4">
            <div className="flex justify-end">
              <Skeleton className="h-12 w-2/3 rounded-2xl" />
            </div>
            <div className="flex justify-start">
              <Skeleton className="h-24 w-4/5 rounded-2xl" />
            </div>
            <div className="flex justify-end">
              <Skeleton className="h-10 w-1/2 rounded-2xl" />
            </div>
            <div className="flex justify-start">
              <Skeleton className="h-20 w-3/4 rounded-2xl" />
            </div>
          </div>
          <div className="space-y-2 border-t border-border/60 p-4">
            <Skeleton className="h-14 w-full rounded-lg" />
            <div className="flex flex-wrap gap-1.5">
              <Skeleton className="h-6 w-28 rounded-full" />
              <Skeleton className="h-6 w-36 rounded-full" />
              <Skeleton className="h-6 w-32 rounded-full" />
            </div>
          </div>
        </div>
        <div className="hidden min-h-[min(70vh,640px)] flex-col overflow-hidden rounded-2xl border border-border/70 lg:flex">
          <div className="border-b border-border/60 px-4 py-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-1.5 h-3 w-48" />
          </div>
          <div className="space-y-3 p-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-36 w-full rounded-lg" />
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-9 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function GraphPageSkeleton() {
  return (
    <div className="space-y-4">
      <div className="space-y-2 px-1">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-9 w-44" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-3 rounded-2xl border border-border/70 p-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-10 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-[min(78vh,720px)] w-full rounded-2xl" />
    </div>
  );
}

export function ImportsPageSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeaderSkeleton />
      <Skeleton className="h-44 w-full rounded-2xl" />
      <Skeleton className="h-44 w-full rounded-2xl" />
      <Skeleton className="h-52 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-48 w-full rounded-2xl" />
    </div>
  );
}

export function OnboardingPageSkeleton() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col justify-center space-y-6">
      <div className="space-y-2 text-center">
        <Skeleton className="mx-auto h-10 w-48" />
        <Skeleton className="mx-auto h-4 w-72" />
      </div>
      <Skeleton className="h-64 w-full rounded-2xl" />
      <Skeleton className="mx-auto h-10 w-36" />
    </div>
  );
}

export function AuthPageSkeleton() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <Skeleton className="mx-auto h-8 w-24" />
          <Skeleton className="mx-auto h-4 w-48" />
        </div>
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    </div>
  );
}

export function MarketingPageSkeleton() {
  return (
    <div className="relative flex min-h-screen flex-col bg-[#05070f]">
      <div className="flex items-center justify-between px-6 py-5 md:px-10">
        <Skeleton className="h-6 w-16 bg-white/10" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-16 bg-white/10" />
          <Skeleton className="h-8 w-24 bg-white/10" />
        </div>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-10 px-6 pb-16 lg:flex-row lg:items-center lg:justify-between lg:px-10">
        <div className="w-full max-w-xl space-y-6">
          <Skeleton className="h-20 w-48 bg-white/10" />
          <Skeleton className="h-8 w-full max-w-md bg-white/10" />
          <Skeleton className="h-5 w-80 max-w-full bg-white/10" />
          <div className="flex gap-3">
            <Skeleton className="h-11 w-32 bg-white/10" />
            <Skeleton className="h-11 w-28 bg-white/10" />
          </div>
        </div>
        <Skeleton className="aspect-square w-full max-w-md rounded-full bg-white/5" />
      </div>
    </div>
  );
}
