/**
 * A short, soft "ding" for completing something (ticking off a notification).
 * Synthesized like the celebration sting — the repo ships no audio assets.
 *
 * Best-effort by design: it is called from a click, so the context is normally allowed
 * to start, but any failure (no Web Audio, autoplay policy) just means silence. The
 * context is created lazily on the first ding and reused, since browsers cap how many
 * a page may open.
 */

import { useSyncExternalStore } from "react";

let ctx: AudioContext | null = null;

const MUTED_KEY = "orbit:ding-muted:v1";

/** Per-device, like the sound itself: the choice lives in this browser only. */
export function isDingMuted() {
  try {
    return localStorage.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();

export function setDingMuted(muted: boolean) {
  try {
    if (muted) localStorage.setItem(MUTED_KEY, "1");
    else localStorage.removeItem(MUTED_KEY);
  } catch {
    // Storage blocked: the choice just won't outlive the tab.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab changing the setting.
  const onStorage = (e: StorageEvent) => {
    if (e.key === MUTED_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Reactive read of the mute setting; `false` on the server so hydration agrees. */
export function useDingMuted() {
  return useSyncExternalStore(subscribe, isDingMuted, () => false);
}

export function playDing() {
  try {
    if (isDingMuted()) return;
    if (typeof AudioContext === "undefined") return;
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});

    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.16, t + 0.008);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    out.connect(ctx.destination);

    // A bell-ish pair: a fundamental (E6) with a quieter, slightly inharmonic partial
    // that dies faster, which is what makes it read as struck rather than beeped.
    for (const [freq, level, decay] of [
      [1318.5, 1, 0.7],
      [3520, 0.25, 0.25],
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(level, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(gain).connect(out);
      osc.start(t);
      osc.stop(t + decay + 0.05);
    }
  } catch {
    // Silence is the failure mode.
  }
}
