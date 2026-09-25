import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches the waitlist page — centred hero, the join card, the 3-up pillars, the three
 * steps, four FAQ rows, the closing CTA and the two-item footer — on the same dark
 * landing-root ground. The page is dynamic, so this shows while its first request runs.
 *
 * Its own module, not a member of `loading/page-skeletons.tsx`: that file carries every
 * app page's skeleton and imports app components, and nothing the waitlist ships may.
 */
export function WaitlistSkeleton() {
  return (
    <div className="landing-root relative overflow-x-clip bg-[#03050c] text-[#e8f3f1]">
      <main className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-20 pt-6 md:px-10 md:pt-10">
        <section className="flex flex-col items-center gap-4 pt-10 text-center md:pt-16">
          <Skeleton className="h-3 w-40 bg-white/5" />
          <Skeleton className="h-10 w-full max-w-lg bg-white/10 sm:h-14" />
          <div className="w-full max-w-md space-y-2">
            <Skeleton className="mx-auto h-4 w-full bg-white/10" />
            <Skeleton className="mx-auto h-4 w-4/5 bg-white/10" />
          </div>
        </section>

        <div className="mx-auto mt-12 max-w-xl rounded-3xl border border-white/10 bg-white/[0.02] p-6 sm:p-8 md:mt-16">
          <Skeleton className="h-3 w-28 bg-white/5" />
          <Skeleton className="mt-3 h-5 w-64 max-w-full bg-white/10" />
          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            <Skeleton className="h-14 flex-1 rounded-xl bg-white/5" />
            <Skeleton className="h-14 w-full rounded-xl bg-white/10 sm:w-40" />
          </div>
          <div className="mt-4 flex items-center justify-center gap-2">
            <Skeleton className="h-3.5 w-10 rounded-full bg-white/10" />
            <Skeleton className="h-3 w-40 max-w-full bg-white/5" />
          </div>
        </div>

        <section className="mt-20">
          <ul className="grid gap-6 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="flex gap-3.5">
                <Skeleton className="mt-0.5 size-[18px] shrink-0 rounded-full bg-white/10" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-36 bg-white/10" />
                  <Skeleton className="h-3.5 w-full bg-white/5" />
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-24 md:mt-32">
          <Skeleton className="mx-auto h-8 w-72 max-w-full bg-white/10" />
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-full rounded-2xl border border-white/10 bg-white/[0.03]" />
            ))}
          </div>
        </section>

        <section className="mt-24 md:mt-32">
          <Skeleton className="mx-auto h-8 w-56 max-w-full bg-white/10" />
          <div className="mt-10 grid gap-3 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-2xl border border-white/10 bg-white/[0.03]" />
            ))}
          </div>
        </section>

        <section className="mt-24 text-center md:mt-32">
          <Skeleton className="mx-auto h-8 w-full max-w-sm bg-white/10" />
          <Skeleton className="mx-auto mt-4 h-4 w-full max-w-xs bg-white/5" />
          <Skeleton className="mx-auto mt-8 h-11 w-40 rounded-full bg-white/10" />
        </section>
      </main>

      <footer className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 pb-10 md:px-10">
        <Skeleton className="h-3 w-10 bg-white/5" />
        <Skeleton className="h-3 w-12 bg-white/5" />
      </footer>
    </div>
  );
}
