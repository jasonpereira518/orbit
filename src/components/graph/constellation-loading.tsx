import { cn } from "@/lib/utils";

/**
 * Stand-in for the star chart while its (large) chunk and data load.
 *
 * A bare `<Skeleton>` was doing this job, but on the canvas's near-black ground
 * `animate-pulse` is invisible — the page showed a plain black rectangle for as long
 * as the chunk took, which reads as "the graph is broken", especially projected.
 * This keeps the same ground and adds the two things a wait needs: a sign of life and
 * a sentence saying what is happening.
 */
export function ConstellationLoading({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative flex w-full items-center justify-center overflow-hidden rounded-2xl bg-[#05070c]",
        className
      )}
      role="status"
      aria-live="polite"
    >
      <div aria-hidden className="constellation-loading-glow absolute inset-0" />
      <p className="relative flex items-center gap-2.5 text-sm text-white/55">
        <span
          aria-hidden
          className="constellation-loading-star size-1.5 rounded-full bg-white/80"
        />
        Charting your constellation…
      </p>
    </div>
  );
}
