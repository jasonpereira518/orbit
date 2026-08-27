"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useWarp } from "@/components/warp/warp-provider";

/**
 * Returns the visitor wherever they came from.
 *
 * /pricing is reached from the marketing landing *and* from inside the app (Settings,
 * the locked-feature screens), so a hardcoded link home would strand app users on the
 * marketing site. History is read at click time rather than held in state: nothing
 * renders differently either way, and reading it during render would break hydration.
 *
 * Visitors who arrived by lift-off fall back down rather than cross-fading — short,
 * bumpy, and deliberately less of an occasion than the climb out. Anyone who came from
 * the marketing landing is already in space and never sees it. The browser's own back
 * button is left alone on purpose: hijacking browser chrome to play an animation is
 * worse than the animation is good.
 */
export function BackControl({
  onBeforeNavigate,
}: {
  /**
   * Lets a page intercept the click to run an exit transition first. Called with the real
   * navigation function instead of navigating immediately; the caller is responsible for
   * invoking it once ready. Omit for the default, instant behavior.
   */
  onBeforeNavigate?: (navigate: () => void) => void;
}) {
  const router = useRouter();
  const { reenter, skip, run } = useWarp();

  function navigate() {
    // A direct load or a shared link has no entry to go back to.
    if (window.history.length > 1) router.back();
    else router.push("/");
  }

  return (
    <button
      type="button"
      onClick={() => {
        // A second press during a chrono rewind means "stop waiting", not
        // "go back twice" — the arc is long enough that it would otherwise
        // read as a dead button.
        if (run.phase !== "idle") {
          if (run.journey === "chrono") skip();
          else router.back();
          return;
        }
        // A direct load or a shared link has no entry to go back to.
        if (window.history.length <= 1) {
          router.push("/");
          return;
        }
        // reenter() owns the router.back() call so the arc and the navigation
        // start together; it returns false when no journey delivered this
        // visitor, in which case the plain navigation still has to happen.
        if (reenter()) return;
        // Let a page play an exit transition first; it owns the timing and
        // calls navigate() when it is ready. Pages that pass nothing keep the
        // instant behaviour.
        if (onBeforeNavigate) {
          onBeforeNavigate(navigate);
          return;
        }
        router.back();
      }}
      className="group -ml-2 inline-flex items-center gap-2 rounded-lg border border-transparent px-2.5 py-1.5 text-sm text-[#9aada8] transition-colors duration-200 hover:border-[#e8f3f1]/25 hover:bg-[#e8f3f1]/10 hover:text-[#e8f3f1] hover:shadow-[0_0_0_1px_rgba(232,243,241,0.06)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f2c14e]"
    >
      <ArrowLeft
        className="size-4 transition-transform duration-300 ease-out group-hover:-translate-x-0.5"
        aria-hidden="true"
      />
      Back
    </button>
  );
}
