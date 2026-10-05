/**
 * Length caps measured the way the server measures them — UTF-16 code units, `string.length`
 * — without splitting a surrogate pair. A cut that lands between the two halves of an emoji
 * leaves a lone high surrogate, which JSON serializes as an escape Postgres jsonb refuses.
 * Pure and browser-safe.
 */
export function clampCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 0) return "";
  let end = max;
  const last = s.charCodeAt(end - 1);
  // A high surrogate as the last kept unit: its low half is past the cut, so drop it too.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}
