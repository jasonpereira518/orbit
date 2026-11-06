/**
 * Elapsed time as `m:ss`, for the recorder's running clock.
 *
 * Its own file, not part of `voice-recording.ts` (which re-exports it): the always-mounted
 * meeting widget needs only this, and importing it from the 15 KB recorder module would put
 * that module in every page's bundle.
 */
export function formatElapsed(ms: number): string {
  const safe = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
