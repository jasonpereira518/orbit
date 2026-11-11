/** Frame-rate independent attack/release; invalid provider samples settle to silence. */
export function smoothVoiceLevel(previous: number, sample: number, elapsedMs: number) {
  const target = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample * 2.5)) : 0;
  const tau = target > previous ? 45 : 220;
  return previous + (target - previous) * (1 - Math.exp(-Math.max(0, elapsedMs) / tau));
}
