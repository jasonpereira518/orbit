import { cn } from "@/lib/utils";

/**
 * The canvas box's height, shared by every stand-in and by the real stage.
 *
 * These had drifted: the loaders used `100dvh-15rem` while the stage itself uses
 * a taller offset, so below `md` the box grew 4.5rem taller the moment the graph appeared —
 * a visible jump at the end of every load. The stage's offset is the correct one: the app's
 * floating bottom nav is a fixed ~4rem pill below `md`, and the shorter box ran the canvas
 * and its Key / fullscreen / home buttons underneath it, where they could not be tapped.
 *
 * Below `md` it is 14.75rem, not the 18.5rem it was: the page's description is hidden on
 * phones (three lines on a 402px screen), and the height it freed went to the chart. The
 * header above the canvas is now just the kicker and title, so its height no longer depends
 * on how the description wraps, and the canvas's bottom edge sits where it always did —
 * clear of the nav. `network-graph.tsx` repeats this value on the real stage; keep the two
 * in step.
 *
 * It also has to be one value because the warp intro is `absolute inset-0` inside this box —
 * if the children disagreed about height, the animation would resize mid-run.
 */
export const CONSTELLATION_STAGE_HEIGHT =
  "h-[calc(100dvh-14.75rem)] md:h-[calc(100dvh-10.5rem)]";

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
