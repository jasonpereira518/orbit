/**
 * Client-side page-load timing: how long a page took to show its content.
 *
 * "Content" means no loading skeleton left on screen. Every `loading.tsx` and every
 * streamed Suspense fallback in the product is built from `<Skeleton>`, which carries
 * `data-slot="skeleton"`, so "no such element is visible" is the one signal that means the
 * same thing on every route: the page stopped being a placeholder.
 *
 * TWO POPULATIONS, never mixed:
 *   - `soft`: a client-side navigation. The clock starts at `onRouterTransitionStart`
 *     (`src/instrumentation-client.ts`), so it includes the RSC fetch, React's 300ms
 *     Suspense reveal throttle, and any streamed boundaries below the page.
 *   - `hard`: a full document load. The clock starts at `performance.timeOrigin`, so it
 *     includes TTFB — which is where a cold serverless start shows up.
 *
 * Pure DOM and `window`, no imports: the pageview beacon is mounted in the root layout and
 * must never pull anything that reaches `@/db` into the client bundle.
 */

export type NavType = "hard" | "soft";

type NavStart = { pathname: string; at: number };

/**
 * Stored on `window` rather than in module state. `instrumentation-client.ts` is its own
 * entry, and a module-level variable is only shared with the beacon if the bundler happens
 * to put both importers on the same module instance — a global cannot drift that way.
 */
const NAV_START_KEY = "__orbitNavStart";

/** A start older than this belongs to some navigation that never reached the beacon. */
const NAV_START_MAX_AGE_MS = 30_000;

/** Give up on a page that never settles; a null beats an invented number. */
export const LOAD_WAIT_CAP_MS = 30_000;

type NavWindow = Window & { [NAV_START_KEY]?: NavStart };

/** Called from `onRouterTransitionStart`. Must stay cheap: it runs on every navigation. */
export function markNavStart(url: string): void {
  try {
    const pathname = new URL(url, window.location.href).pathname;
    (window as NavWindow)[NAV_START_KEY] = { pathname, at: performance.now() };
  } catch {
    // A URL we cannot parse is not a navigation we can time.
  }
}

/**
 * The start of the navigation that produced `pathname`, or null when the view did not come
 * from a client-side navigation — i.e. a hard load.
 *
 * READ, NOT CONSUMED. Strict Mode runs the beacon's effect twice in development, and a
 * consuming read handed the second run nothing, so every click was reported as a "hard"
 * load timed from `timeOrigin`. Reuse is already impossible without it: each navigation
 * overwrites the start, a full load starts a fresh `window`, and a stale one fails the
 * pathname or age check below.
 */
export function readNavStart(pathname: string): number | null {
  const start = (window as NavWindow)[NAV_START_KEY];
  if (!start) return null;
  if (start.pathname !== pathname) return null;
  if (performance.now() - start.at > NAV_START_MAX_AGE_MS) return null;
  return start.at;
}

function skeletonVisible(): boolean {
  for (const el of document.querySelectorAll('[data-slot="skeleton"]')) {
    // `getClientRects` is empty for `display: none` and for anything inside a closed
    // popover or a hidden `md:` variant — skeletons that exist but nobody is looking at.
    if ((el as HTMLElement).getClientRects().length > 0) return true;
  }
  return false;
}

/**
 * Resolves with `performance.now()` at the first frame with no visible skeleton, or null
 * when the measurement is not trustworthy: the tab went hidden (rAF stops, so the number
 * would be time-in-background), the cap passed, or `signal` aborted (the visitor left).
 */
export function waitForContent(signal: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    const started = performance.now();
    let frame = 0;
    const finish = (value: number | null) => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onHidden);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") finish(null);
    };
    const onAbort = () => finish(null);
    const tick = () => {
      const now = performance.now();
      if (!skeletonVisible()) return finish(now);
      if (now - started > LOAD_WAIT_CAP_MS) return finish(null);
      frame = requestAnimationFrame(tick);
    };

    if (signal.aborted || document.visibilityState === "hidden") return resolve(null);
    document.addEventListener("visibilitychange", onHidden);
    signal.addEventListener("abort", onAbort);
    tick();
  });
}
