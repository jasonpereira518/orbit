"use client";

import { useEffect, useRef, useState } from "react";

// EMA blend weight given to each new throughput sample vs. the running average.
const RATE_EMA_NEW_WEIGHT = 0.45;
const ETA_MIN_ELAPSED_MS = 500;
const ETA_TICK_MS = 250;
// When the latest estimate would require the countdown to jump up, decay it at this
// fraction of real time instead — visibly still counting down, just slower, so it never
// appears to gain time.
const ETA_SLOWDOWN_FACTOR = 0.25;

/**
 * Estimated time remaining for a determinate running task, formatted for display.
 *
 * Shared by the bottom-right job widget (`GlobalJobProgressBar`) and the in-page import
 * progress card (`ImportProgress`) so the two surfaces read from one algorithm rather than
 * two that could quietly drift apart or disagree. Originally written for the widget; lifted
 * out unchanged (same constants, same shape) so this extraction is behavior-preserving there.
 *
 * Based on a smoothed (EMA) recent-throughput rate, and guaranteed to never tick upward — if
 * the task falls behind pace the countdown decays more slowly instead of jumping to a larger
 * number. A rising countdown reads as the task going backwards, which is worse than being
 * vague, so "never increases" is the property every caller actually needs.
 */
export function useEtaCountdown({
  active,
  done,
  total,
  startedAt,
}: {
  /** Whether there's a determinate, in-progress run to estimate at all. */
  active: boolean;
  done: number;
  total: number;
  /** Epoch ms. Changing this while `active` marks a new run and resets the clock. */
  startedAt: number;
}): string | null {
  const [displayRemainingMs, setDisplayRemainingMs] = useState<number | null>(null);
  const rateEmaRef = useRef<number | null>(null);
  const lastDoneRef = useRef(0);
  const lastTickRef = useRef<number | null>(null);
  const knownStartedAtRef = useRef<number | null>(null);

  // One effect owns the whole lifecycle (rate tracking + the tick interval) so "this is a
  // fresh run" can be decided once and threaded through to the interval's setState callback,
  // instead of resetting display state from a separate effect body.
  useEffect(() => {
    if (!active) return;

    const isNewRun = knownStartedAtRef.current !== startedAt;
    if (isNewRun) {
      knownStartedAtRef.current = startedAt;
      rateEmaRef.current = null;
      lastDoneRef.current = 0;
      lastTickRef.current = null;
    }

    if (lastDoneRef.current !== done) {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= ETA_MIN_ELAPSED_MS) {
        lastDoneRef.current = done;
        const instantRate = done / elapsedMs; // items per ms
        if (instantRate > 0) {
          rateEmaRef.current =
            rateEmaRef.current == null
              ? instantRate
              : rateEmaRef.current * (1 - RATE_EMA_NEW_WEIGHT) +
                instantRate * RATE_EMA_NEW_WEIGHT;
        }
      }
    }

    const id = window.setInterval(() => {
      const nowTick = Date.now();
      const tickDeltaMs =
        lastTickRef.current == null ? 0 : Math.max(0, nowTick - lastTickRef.current);
      lastTickRef.current = nowTick;

      const rate = rateEmaRef.current;
      if (rate == null || rate <= 0) return;
      const targetRemainingMs = (total - done) / rate;

      setDisplayRemainingMs((prev) => {
        if (isNewRun || prev == null) return targetRemainingMs;
        const naturalNext = prev - tickDeltaMs;
        const onPaceOrAhead = targetRemainingMs <= naturalNext;
        const effectiveDelta = onPaceOrAhead
          ? tickDeltaMs
          : tickDeltaMs * ETA_SLOWDOWN_FACTOR;
        return Math.max(0, prev - effectiveDelta);
      });
    }, ETA_TICK_MS);

    return () => window.clearInterval(id);
  }, [active, done, total, startedAt]);

  // Stale once the task stops being active — the guard below hides it immediately
  // regardless, so there's nothing to reset here.
  if (!active) return null;
  return formatEtaSeconds(displayRemainingMs != null ? displayRemainingMs / 1000 : null);
}

function formatEtaSeconds(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.max(0, Math.ceil(seconds));
  if (whole <= 1) return "~1s left";
  if (whole < 60) return `~${whole}s left`;
  const minutes = Math.floor(whole / 60);
  const rem = whole % 60;
  if (minutes < 60) {
    return rem > 0 ? `~${minutes}m ${rem}s left` : `~${minutes}m left`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `~${hours}h ${mins}m left` : `~${hours}h left`;
}
