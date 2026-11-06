/**
 * A meeting's length for people: "under a minute", "42 min", "1 h 5 min".
 *
 * Plain module, not part of `meeting-summary-card.tsx` (a client component): a server
 * component such as /meetings/[id] cannot call a function that lives in a "use client" file,
 * and the engine and panel should not need the whole card to format a number.
 */
export function formatMeetingDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
