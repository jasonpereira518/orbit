export type AudioContextCtor = typeof AudioContext;

/**
 * The browser's AudioContext constructor (Safari before 14.1 only has the `webkit` prefix), or
 * null on the server or where Web Audio is missing. Safe to import anywhere: `window` is read
 * when called, never at load.
 */
export function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}
