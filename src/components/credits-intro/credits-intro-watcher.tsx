"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { claimCreditsIntro } from "@/actions/credits";
import { useViewerPlan } from "@/components/viewer-plan";
import { previewNumbers, type CreditsIntroNumbers } from "@/lib/credits-intro-scene";
import { PLANS, type Plan } from "@/lib/plans/plan-config";

/** The stage only loads for the one page load that shows it. */
const CreditsIntroStage = dynamic(
  () => import("@/components/credits-intro/credits-intro-stage").then((m) => ({ default: m.CreditsIntroStage })),
  { ssr: false },
);

/**
 * Let the page the user came for paint first. Also keeps the claim — a server action — clear
 * of the mount-time `router.replace` calls other shell watchers make: an action queued during
 * one of those is dropped and never resolves.
 */
const SETTLE_MS = 1000;
/** Re-check cadence while something else (a dialog, the upgrade celebration) holds the screen. */
const RETRY_MS = 2000;

/**
 * Plays the full-screen "your AI credits are here" moment once per account, on the first app
 * page load after included AI ships. A copy of `LinkedInReminderWatcher`: `due` comes from the
 * app layout (`isCreditsIntroDue`) but only arms this — the server action takes the single
 * showing atomically, so a second tab rendered from the same `due` draws nothing.
 *
 * It never interrupts another takeover: it waits for a visible tab, no warp, no upgrade
 * celebration and no open modal dialog, re-checking every couple of seconds.
 */
export function CreditsIntroWatcher({ due }: { due: boolean }) {
  const { plan } = useViewerPlan();
  const [show, setShow] = useState<{ plan: Plan; numbers: CreditsIntroNumbers } | null>(null);
  const settledRef = useRef(false);
  const claimingRef = useRef(false);

  const tryClaim = useCallback(() => {
    if (!due || settledRef.current || claimingRef.current) return;
    if (document.visibilityState !== "visible") return;
    const root = document.documentElement;
    if (root.hasAttribute("data-warp") || root.hasAttribute("data-celebration")) return;
    if (document.querySelector('[role="dialog"][aria-modal="true"], [data-slot="dialog-content"]')) return;
    claimingRef.current = true;
    claimCreditsIntro()
      .then(({ claimed, numbers }) => {
        // A resolved claim is a decision either way; only a transport failure retries.
        settledRef.current = true;
        if (claimed && numbers) setShow({ plan, numbers });
      })
      .catch(() => {})
      .finally(() => {
        claimingRef.current = false;
      });
  }, [due, plan]);

  useEffect(() => {
    if (!due) return;
    let interval = 0;
    const timeout = window.setTimeout(() => {
      tryClaim();
      interval = window.setInterval(() => {
        if (settledRef.current) window.clearInterval(interval);
        else tryClaim();
      }, RETRY_MS);
    }, SETTLE_MS);
    const onVisible = () => tryClaim();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [due, tryClaim]);

  // Dev preview: `?credits-intro=free|orbit|max|lifetime` draws the stage without claiming, so
  // it can be looked at on any account and replayed. `NODE_ENV` is inlined at build time, so
  // this branch does not exist in production bundles.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const param = new URLSearchParams(window.location.search).get("credits-intro");
    const forced = PLANS.find((p) => p === param);
    if (!forced) return;
    const timeout = window.setTimeout(() => setShow({ plan: forced, numbers: previewNumbers(forced) }), SETTLE_MS);
    return () => window.clearTimeout(timeout);
  }, []);

  if (!show) return null;
  return <CreditsIntroStage plan={show.plan} numbers={show.numbers} onDone={() => setShow(null)} />;
}
