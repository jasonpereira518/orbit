"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentPlan } from "@/actions/billing";
import { useAppPulse } from "@/lib/app-pulse-store";
import {
  downgradePlaybackDecision,
  downgradeStorageKey,
  observePlanForDowngrade,
} from "@/lib/celebration/downgrade-detection";
import type { PaidPlan } from "@/lib/celebration/tier-theme";
import type { Plan } from "@/lib/plan-limits";

const PlanDowngradeStage = dynamic(
  () =>
    import("@/components/celebration/plan-downgrade-stage").then((module) => ({
      default: module.PlanDowngradeStage,
    })),
  { ssr: false },
);

function canPlay() {
  const root = document.documentElement;
  return (
    document.visibilityState === "visible" &&
    !root.hasAttribute("data-warp") &&
    !root.hasAttribute("data-celebration") &&
    !root.hasAttribute("data-plan-upgrade-active")
  );
}

/** The first observation in each browser profile is silent. Later effective
 * paid-to-Free transitions are claimed in storage before playback, and the
 * current server plan is checked again after any deferral. */
export function PlanDowngradeWatcher({
  userId,
  plan,
}: {
  userId: string;
  plan: Plan;
}) {
  const router = useRouter();
  const pulsePlan = useAppPulse().pulse?.plan;
  const [active, setActive] = useState<PaidPlan | null>(null);
  const pendingRef = useRef<PaidPlan | null>(null);
  const activeRef = useRef(false);
  const checkingRef = useRef(false);
  const mountedRef = useRef(true);
  const accountRef = useRef(userId);
  const tryStartPendingRef = useRef<() => void>(() => {});

  const tryStartPending = useCallback(() => {
    if (!pendingRef.current || activeRef.current || checkingRef.current || !canPlay()) return;
    checkingRef.current = true;
    const account = accountRef.current;
    let deferredDuringCheck = false;
    void getCurrentPlan()
      .then((current) => {
        if (!mountedRef.current || account !== accountRef.current) return;
        const decision = downgradePlaybackDecision(current, canPlay());
        if (decision === "cancel") {
          pendingRef.current = null;
          observePlanForDowngrade(account, current);
          router.refresh();
          return;
        }
        if (decision === "defer") {
          deferredDuringCheck = true;
          return;
        }
        if (!pendingRef.current) return;
        activeRef.current = true;
        const fromPlan = pendingRef.current;
        pendingRef.current = null;
        setActive(fromPlan);
      })
      .catch(() => {
        // Keep the claimed transition pending until another feed or visibility
        // change gives us a chance to verify the current server plan.
      })
      .finally(() => {
        checkingRef.current = false;
        // Visibility or an overlay can change while the server request is in
        // flight. If it clears before this finally runs, no event remains to
        // wake the pending stage unless we make this one follow-up check.
        if (deferredDuringCheck) tryStartPendingRef.current();
      });
  }, [router]);

  useEffect(() => {
    tryStartPendingRef.current = tryStartPending;
  }, [tryStartPending]);

  const observe = useCallback(
    (next: Plan) => {
      const fromPlan = observePlanForDowngrade(userId, next);
      if (fromPlan) {
        pendingRef.current = fromPlan;
        router.refresh();
        tryStartPending();
      } else if (next !== "free") {
        pendingRef.current = null;
      }
    },
    [userId, router, tryStartPending],
  );

  useEffect(() => {
    observe(plan);
  }, [plan, observe]);

  useEffect(() => {
    if (pulsePlan) observe(pulsePlan);
  }, [pulsePlan, observe]);

  useEffect(() => {
    mountedRef.current = true;
    const onVisible = () => tryStartPending();
    const onStorage = (event: StorageEvent) => {
      if (event.key === downgradeStorageKey(accountRef.current) && event.newValue !== "free") {
        pendingRef.current = null;
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onStorage);
    const observer = new MutationObserver(onVisible);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-warp", "data-celebration", "data-plan-upgrade-active"],
    });
    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onStorage);
      observer.disconnect();
    };
  }, [tryStartPending]);

  const onDone = useCallback(() => {
    activeRef.current = false;
    setActive(null);
    router.refresh();
  }, [router]);

  if (!active) return null;
  return createPortal(
    <PlanDowngradeStage fromPlan={active} onDone={onDone} />,
    document.body,
  );
}
