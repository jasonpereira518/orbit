import type { VoiceMode } from "./contracts";

/** Frame-rate independent attack/release; invalid provider samples settle to silence. */
export function smoothVoiceLevel(previous: number, sample: number, elapsedMs: number) {
  const target = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample * 2.5)) : 0;
  const tau = target > previous ? 45 : 220;
  return previous + (target - previous) * (1 - Math.exp(-Math.max(0, elapsedMs) / tau));
}

export type OrbWeights = Record<VoiceMode, number>;

/** Fully in one mode: the orb's first frame, so it never fades in from nothing. */
export function orbWeights(mode: VoiceMode): OrbWeights {
  return { connecting: 0, listening: 0, thinking: 0, speaking: 0, disconnected: 0, [mode]: 1 };
}

/** Blend toward the current mode; settles in about half a second whatever the frame rate. */
export function easeOrbWeights(previous: OrbWeights, mode: VoiceMode, elapsedMs: number): OrbWeights {
  const k = 1 - Math.exp(-Math.max(0, elapsedMs) / 150);
  const target = orbWeights(mode);
  const next = { ...previous };
  for (const key of Object.keys(next) as VoiceMode[]) next[key] += (target[key] - next[key]) * k;
  return next;
}

/**
 * How the orb looks for blended mode weights and smoothed 0–1 levels. Listening with silence is
 * the idle breath; the user's voice tints it cool and draws the lights in, Orbit's voice tints it
 * warm and ripples the surface. Reduced motion keeps colour and glow, drops all movement.
 */
export function orbParams(w: OrbWeights, input: number, output: number, reduced = false) {
  const hearing = w.listening * input;
  const talking = w.speaking * output;
  const still = reduced ? 0 : 1;
  return {
    scale: reduced ? 1 : 1 + 0.15 * hearing + 0.14 * talking - 0.04 * w.thinking,
    breath: still * (0.04 * (w.listening + w.connecting) + 0.02 * w.speaking),
    wobble: still * (0.02 * (1 - w.disconnected) + 0.09 * w.thinking + 0.04 * hearing),
    morphSpeed: still * (1 + 0.6 * w.thinking),
    ripple: still * 0.025 * talking,
    lightSpeed: still * (1 - w.disconnected) * (0.35 + 0.15 * w.thinking + 0.8 * hearing + 0.8 * talking),
    lightRadius: 0.45 - 0.15 * hearing + 0.05 * talking,
    glow: Math.max(0, 0.35 + 0.35 * hearing + 0.6 * talking + 0.1 * w.thinking - 0.25 * w.disconnected),
    glowPulse: still * 0.15 * w.thinking,
    tint: Math.max(-1, Math.min(1, 0.3 * w.speaking + 0.7 * talking - hearing)),
    opacity: 1 - 0.4 * w.connecting - 0.5 * w.disconnected,
  };
}

export type OrbParams = ReturnType<typeof orbParams>;
