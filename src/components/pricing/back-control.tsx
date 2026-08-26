"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

/**
 * Returns the visitor wherever they came from.
 *
 * /pricing is reached from the marketing landing *and* from inside the app (Settings,
 * the locked-feature screens), so a hardcoded link home would strand app users on the
 * marketing site. History is read at click time rather than held in state: nothing
 * renders differently either way, and reading it during render would break hydration.
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

  function navigate() {
    // A direct load or a shared link has no entry to go back to.
    if (window.history.length > 1) router.back();
    else router.push("/");
  }

  return (
    <button
      type="button"
      onClick={() => (onBeforeNavigate ? onBeforeNavigate(navigate) : navigate())}
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
