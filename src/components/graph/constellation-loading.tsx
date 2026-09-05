import { cn } from "@/lib/utils";

/**
 * The canvas box's height, shared by every stand-in and by the real stage.
 *
 * These had drifted: the loaders used `100dvh-15rem` while the stage itself uses
 * `100dvh-19.5rem`, so below `md` the box grew 4.5rem taller the moment the graph appeared —
 * a visible jump at the end of every load. 19.5rem is the correct one: the app's floating
 * bottom nav is a fixed ~5rem pill below `md`, and the shorter box ran the canvas and its
 * Key / fullscreen / home buttons underneath it, where they could not be tapped.
 *
 * It also has to be one value because the warp intro is `absolute inset-0` inside this box —
 * if the children disagreed about height, the animation would resize mid-run.
 */
export const CONSTELLATION_STAGE_HEIGHT =
  "h-[calc(100dvh-19.5rem)] md:h-[calc(100dvh-10.5rem)]";

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
