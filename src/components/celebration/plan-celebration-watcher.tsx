"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentPlan } from "@/actions/billing";
import type { Plan } from "@/lib/plan-limits";
import {
  PLAN_RANK,
  readLastSeenPlan,
  upgradeKind,
  writeLastSeenPlan,
} from "@/lib/celebration/upgrade-detection";
import { isPaidPlan, tierTheme, type PaidPlan } from "@/lib/celebration/tier-theme";

/** The stage is the only heavy part (a canvas loop); it loads on first
 * celebration and never for the overwhelming majority of sessions that don't
 * upgrade. Same treatment as WarpStage. */
const CelebrationStage = dynamic(
  () =>
    import("@/components/celebration/celebration-stage").then((m) => ({
      default: m.CelebrationStage,
    })),
  { ssr: false },
);

/** Post-checkout: the webhook grants the plan, so the success redirect can
 * land before it exists. Poll hard for a minute, then let the ambient poll
 * and the next page load pick it up. */
const FAST_POLL_MS = 2_000;
const FAST_POLL_ATTEMPTS = 30;

/** Ambient: how long a comped user waits before the fanfare finds them.
 * DueNotificationsWatcher's cadence, slightly tightened. */
const AMBIENT_POLL_MS = 75_000;

type ActiveRun = {
  plan: PaidPlan;
  startAt: "accrete" | "ignite";
  /** Remount handle, so a mid-play tier restart gets a clean stage. */
  key: number;
};

/**
 * Watches the resolved plan and throws the full-screen celebration when it
 * goes up. Renders nothing until then; portals the stage to <body> because
 * the AppShell root is transform-animated during warp, which would break a
 * `fixed` overlay mounted inside it.
 *
 * Detection is client-side only: the server-reported plan against one
 * localStorage key. Writing the key BEFORE starting is the whole dedupe —
 * every competing feed (prop, fast poll, ambient poll, StrictMode's second
 * effect run, another tab via fresh reads) then classifies as "same".
 */
export function PlanCelebrationWatcher({ plan }: { plan: Plan }) {
  const router = useRouter();
  const [active, setActive] = useState<ActiveRun | null>(null);
  const activeRef = useRef<ActiveRun | null>(null);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  // An upgrade seen while the tab is hidden or a warp is mid-flight waits
  // here until the screen is actually watchable.
  const pendingRef = useRef<PaidPlan | null>(null);
  const keyRef = useRef(0);

  const start = useCallback((next: PaidPlan, startAt: "accrete" | "ignite") => {
    keyRef.current += 1;
    pendingRef.current = null;
    setActive({ plan: next, startAt, key: keyRef.current });
  }, []);

  const tryStartPending = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending || activeRef.current) return;
    if (document.visibilityState !== "visible") return;
    if (document.documentElement.hasAttribute("data-warp")) return;
    start(pending, "accrete");
  }, [start]);

  const maybeCelebrate = useCallback(
    (next: Plan) => {
      const running = activeRef.current;
      if (running) {
        // Mid-play upgrade (orbit -> lifetime inside the same seven seconds):
        // record it, then restart at the ignition — the anticipation was
        // already spent.
        if (isPaidPlan(next) && PLAN_RANK[next] > PLAN_RANK[running.plan]) {
          writeLastSeenPlan(next);
          start(next, "ignite");
        }
        return;
      }
      switch (upgradeKind(readLastSeenPlan(), next)) {
        case "first-visit":
        case "downgrade":
          // Silent: seeds a fresh device, re-arms after account switches and
          // comp revocations.
          writeLastSeenPlan(next);
          return;
        case "same":
          return;
        case "upgrade":
          writeLastSeenPlan(next);
          if (!isPaidPlan(next)) return;
          pendingRef.current = next;
          tryStartPending();
      }
    },
    [start, tryStartPending],
  );

  // Deferred starts fire the moment the tab is visible and no warp is flying.
  useEffect(() => {
    const onVisible = () => tryStartPending();
    document.addEventListener("visibilitychange", onVisible);
    const observer = new MutationObserver(() => tryStartPending());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-warp"],
    });
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      observer.disconnect();
    };
  }, [tryStartPending]);

  // Feed 1 — the server-rendered prop, on mount and on every router refresh.
  // Catches upgrades that happened while the user was away, and webhooks that
  // beat the checkout redirect.
  useEffect(() => {
    maybeCelebrate(plan);
  }, [plan, maybeCelebrate]);

  // Feed 2 — fast post-checkout poll, armed by the ?upgraded= param the
  // Stripe success URL carries. The param only arms the poll; the celebrated
  // tier always comes from what the server actually says.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const upgraded = params.get("upgraded");
    if (upgraded !== "pro" && upgraded !== "lifetime") return;

    const url = new URL(window.location.href);
    url.searchParams.delete("upgraded");
    // Strip immediately so a refresh cannot re-arm; the hash (and its scroll
    // target) survives the replace.
    router.replace(url.pathname + url.search + url.hash);

    let attempts = 0;
    let running = false;
    const interval = window.setInterval(async () => {
      if (running) return;
      if (activeRef.current || attempts >= FAST_POLL_ATTEMPTS) {
        window.clearInterval(interval);
        return;
      }
      attempts += 1;
      running = true;
      try {
        maybeCelebrate(await getCurrentPlan());
      } catch {
        // Network blips: the next tick, the ambient poll, or the next page
        // load will get it.
      } finally {
        running = false;
      }
    }, FAST_POLL_MS);
    return () => window.clearInterval(interval);
    // Arm once per mount; the param is gone after the replace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Feed 3 — ambient poll, so a comp granted while the user is in the app
  // finds them within a minute or two (there is no realtime channel).
  useEffect(() => {
    let running = false;
    async function tick() {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      try {
        maybeCelebrate(await getCurrentPlan());
      } catch {
        // ignore network / auth blips
      } finally {
        running = false;
      }
    }
    const interval = window.setInterval(tick, AMBIENT_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [maybeCelebrate]);

  // Dev trigger — the real ones need Stripe or an admin. `NODE_ENV` is inlined
  // at build time, so none of this exists in production bundles. Neither path
  // touches localStorage: infinitely replayable, never corrupts detection.
  // The ref latch keeps StrictMode's second effect run from double-starting.
  const devArmedRef = useRef(false);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;

    if (!devArmedRef.current) {
      devArmedRef.current = true;
      const params = new URLSearchParams(window.location.search);
      const forced = params.get("celebrate");
      if (forced === "orbit" || forced === "lifetime") {
        const url = new URL(window.location.href);
        url.searchParams.delete("celebrate");
        router.replace(url.pathname + url.search + url.hash);
        start(forced, "accrete");
      }
    }

    let last: PaidPlan = "orbit";
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "u")) return;
      e.preventDefault();
      last = last === "orbit" ? "lifetime" : "orbit";
      start(last, "accrete");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDone = useCallback(() => {
    setActive(null);
    // The veil lifts onto a shell that already wears the new tier: sidebar
    // logo ring, plan badges, gates.
    router.refresh();
  }, [router]);

  if (!active) return null;
  return createPortal(
    <CelebrationStage
      key={active.key}
      theme={tierTheme(active.plan)}
      startAt={active.startAt}
      onDone={onDone}
    />,
    document.body,
  );
}
