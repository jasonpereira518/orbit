"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react";

/**
 * Dismiss a toast by clicking anywhere on it.
 *
 * Sonner has no `closeOnClick`, and it does not put the toast id in the DOM, so
 * there is nothing to hand `toast.dismiss()`. But with `closeButton` on, every
 * toast contains a real close button — so a body click can just forward to it.
 * No id plumbing, no per-call-site changes, and it routes through sonner's own
 * dismiss path, so `onDismiss` callbacks still fire.
 *
 * Being delegated at the document level, this also covers the handful of files
 * that import `toast` straight from `sonner` rather than from `@/lib/toast`,
 * without touching them.
 */
function useDismissOnBodyClick() {
  useEffect(() => {
    let downX = 0;
    let downY = 0;

    function onDown(event: PointerEvent) {
      downX = event.clientX;
      downY = event.clientY;
    }

    function onUp(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      const toast = target?.closest<HTMLElement>("[data-sonner-toast]");
      if (!toast) return;

      // Anything genuinely interactive keeps its own click: the `action` button,
      // the "See more" expander in `lib/toast.tsx`, the close button itself.
      if (
        target?.closest(
          "button, a, [role='button'], input, textarea, select, label, [data-button]"
        )
      ) {
        return;
      }

      // A drag that happened to end on the toast is a swipe, not a click.
      //
      // Distance is the only usable signal here. Sonner's own `data-swiping` is
      // set on pointerDOWN and cleared in its pointerup handler, which runs
      // after this capture-phase one — so it reads "true" for every genuine
      // click, and testing it rejects all of them. `data-swipe-out` is set on
      // that same later handler and is likewise always stale at this point.
      // Movement is measured from our own recorded pointerdown, so it does not
      // depend on sonner's ordering, and a swipe that actually dismisses
      // travels far more than this threshold.
      if (
        Math.abs(event.clientX - downX) > 6 ||
        Math.abs(event.clientY - downY) > 6
      ) {
        return;
      }

      toast.querySelector<HTMLButtonElement>("[data-close-button]")?.click();
    }

    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
    };
  }, []);
}

/**
 * Dismiss a toast by pushing it right with a two-finger trackpad swipe.
 *
 * Sonner's own swipe is pointer-driven — press, move, release — and a trackpad
 * two-finger swipe emits `wheel` events with a horizontal delta and no pointer
 * at all, so none of that machinery ever fires. This adds the gesture on top.
 *
 * It drives its own `--orbit-wheel-x` rather than sonner's `--swipe-amount-x`,
 * because the rule that reads that variable also sets `transition: none` and
 * owns the whole transform for the duration — the CSS in globals.css keeps
 * `var(--y)` in front of our translate instead, so the stacking maths
 * underneath is untouched while the toast slides.
 */
function useWheelSwipeDismiss() {
  useEffect(() => {
    /** Travel that counts as "gone" rather than a nudge. */
    const DISMISS_PX = 96;
    /** No wheel for this long ends an unfinished gesture. */
    const IDLE_MS = 120;
    /** Send-off and spring-back both take this long; matches the CSS. */
    const GLIDE_MS = 160;

    let active: HTMLElement | null = null;
    let offset = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    function clear(el: HTMLElement) {
      el.style.removeProperty("--orbit-wheel-x");
      el.removeAttribute("data-orbit-wheel");
    }

    function fling(el: HTMLElement) {
      active = null;
      offset = 0;
      el.setAttribute("data-orbit-wheel", "flinging");
      el.style.setProperty("--orbit-wheel-x", `${el.offsetWidth + 48}px`);
      setTimeout(() => {
        // Dismiss through sonner's own path, so `onDismiss` still runs and the
        // notification center still gets anything worth keeping.
        el.querySelector<HTMLButtonElement>("[data-close-button]")?.click();
        clear(el);
      }, GLIDE_MS);
    }

    function settle() {
      const el = active;
      active = null;
      offset = 0;
      if (!el) return;
      el.setAttribute("data-orbit-wheel", "settling");
      el.style.setProperty("--orbit-wheel-x", "0px");
      setTimeout(() => clear(el), GLIDE_MS);
    }

    function onWheel(event: WheelEvent) {
      const target = event.target as HTMLElement | null;
      const el = target?.closest<HTMLElement>("[data-sonner-toast]");
      if (!el || el.dataset.orbitWheel === "flinging") return;

      // Vertical intent belongs to the description's own scroller, which is the
      // only thing inside a toast that scrolls.
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;

      // Without this, macOS reads the same gesture as a back-navigation swipe.
      event.preventDefault();

      if (active !== el) {
        if (active) clear(active);
        active = el;
        offset = 0;
      }

      // Under natural scrolling — the macOS default — fingers moving right
      // report a negative deltaX, so the toast follows the fingers. Clamped at
      // zero because right is the only direction that dismisses, matching the
      // `swipeDirections` given to the Toaster.
      offset = Math.max(0, offset - event.deltaX);
      el.setAttribute("data-orbit-wheel", "dragging");
      el.style.setProperty("--orbit-wheel-x", `${offset}px`);

      clearTimeout(idleTimer);
      if (offset >= DISMISS_PX) {
        fling(el);
        return;
      }
      idleTimer = setTimeout(settle, IDLE_MS);
    }

    // Capture phase so this sees the event before the description's scroller,
    // and non-passive so `preventDefault` is allowed at all.
    document.addEventListener("wheel", onWheel, {
      passive: false,
      capture: true,
    });
    return () => {
      clearTimeout(idleTimer);
      document.removeEventListener("wheel", onWheel, true);
      if (active) clear(active);
    };
  }, []);
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  useDismissOnBodyClick();
  useWheelSwipeDismiss();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="bottom-right"
      closeButton
      // Constrain the gesture to the direction the toast exits in, so a swipe
      // and a timeout look like the same departure.
      swipeDirections={["right"]}
      // Both offsets read the SAME variable on purpose. Sonner switches to
      // `mobileOffset` at 600px, but the app's bottom nav only disappears at
      // `md` (768px) — using sonner's breakpoint would leave a 600-768px band
      // where toasts sit on a nav that is still there. See `--orbit-corner-*`
      // in globals.css. Strings pass through to the CSS vars verbatim.
      offset={{
        bottom: "var(--orbit-toast-bottom)",
        right: "var(--orbit-corner-right)",
      }}
      mobileOffset={{
        bottom: "var(--orbit-toast-bottom)",
        right: "var(--orbit-corner-right)",
        left: "var(--orbit-corner-right)",
      }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      // Match the job progress widget's width so the two surfaces share both
      // vertical edges when they stack (`jobs/global-job-progress-bar.tsx`).
      style={
        { "--width": "min(20rem, calc(100vw - 1.5rem))" } as React.CSSProperties
      }
      toastOptions={{
        // Sonner injects its stylesheet unlayered at runtime, so every rule it
        // writes beats a Tailwind utility no matter how specific. While
        // `data-styled` is true its own surface styling therefore cannot be
        // overridden by classes at all — which is why this file used to reach
        // for `--normal-bg` and friends. Turning it off is what makes the class
        // list below live.
        //
        // Elevation, hairline and the variant rail are NOT here: all three want
        // `box-shadow`, as does `ring-1`, and they are composed into a single
        // declaration in globals.css so they merge instead of erasing each other.
        // Same for `transition`, which sonner declares on the element directly.
        unstyled: true,
        classNames: {
          // No `relative` — sonner sets `position: absolute` on the toast from
          // its unlayered sheet, so the class would be dead weight and the close
          // button is positioned against it either way.
          toast:
            "orbit-toast group/toast flex w-full cursor-pointer items-start gap-3 " +
            // A little more room than `p-3`, which was tight for a two-line title over
            // a description. `pr-9` keeps the close button's lane clear.
            "rounded-xl bg-popover py-3 pl-3.5 pr-9 text-popover-foreground",
          // The hard cap, and the reason "See more" can be unbounded: expanding
          // a description grows the toast until it hits this, then scrolls, so
          // a stack trace can be read in full without becoming a full-height
          // panel. Nothing collapsed comes near 224px — a two-line title over a
          // three-line description is about 100px — so this only bites once the
          // reader has asked for more.
          //
          // `min-h-0` because a flex child will not shrink below its content
          // without it, and the cap would do nothing. Sonner puts
          // `touch-action: none` on the toast for its swipe, which also kills
          // touch scrolling in here — `pan-y` gives the vertical axis back
          // while leaving the horizontal swipe to dismiss.
          content:
            "flex min-h-0 max-h-56 min-w-0 flex-1 touch-pan-y flex-col gap-1 overflow-y-auto overscroll-contain",
          icon: "orbit-toast-icon mt-px flex size-6 shrink-0 items-center justify-center rounded-md",
          title: "text-[13px] leading-5 font-medium break-words whitespace-pre-wrap",
          // No clamp here on purpose. A string description is wrapped in
          // `ExpandableText` by `maybeExpandableDescription` in lib/toast.tsx,
          // which owns the three-line clamp and the "See more" — a clamp on
          // this wrapper would keep cutting at three lines even once expanded.
          // These styles still apply to a description passed as a ReactNode,
          // which nothing does today but the API allows.
          description:
            "text-[13px] leading-5 text-muted-foreground break-words whitespace-pre-wrap",
          actionButton:
            "shrink-0 self-center rounded-md bg-primary px-2.5 py-1 text-xs font-medium " +
            "text-primary-foreground transition-colors duration-fast hover:bg-primary/90",
          cancelButton:
            "shrink-0 self-center rounded-md bg-secondary px-2.5 py-1 text-xs font-medium " +
            "text-secondary-foreground transition-colors duration-fast hover:bg-secondary/80",
          // Revealed on hover, but always reachable by keyboard — an error toast
          // runs for ten seconds and hover now pauses that timer, so one parked
          // under a resting cursor never leaves on its own.
          closeButton:
            "absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-md " +
            "text-muted-foreground opacity-0 transition-opacity duration-fast " +
            "hover:bg-accent hover:text-accent-foreground " +
            "focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring " +
            "group-hover/toast:opacity-100",
          // Feeds the icon chip and the left rail in globals.css. `default`
          // (the `toast.message` call sites) deliberately sets none.
          success: "[--toast-accent:var(--success)]",
          // Not `--destructive`: that is the delete-button red, out of gamut and the
          // loudest colour on the page. See `--toast-error` in globals.css.
          error: "[--toast-accent:var(--toast-error)]",
          warning: "[--toast-accent:var(--warning)]",
          info: "[--toast-accent:var(--info)]",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
