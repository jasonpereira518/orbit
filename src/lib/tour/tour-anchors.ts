/**
 * The real controls the guided tour points at. A component spreads `tourAnchor("…")` on the
 * element; the spotlight finds the first visible `[data-tour="…"]`. The ids are a `const`
 * object rather than free strings so a typo in a stop or a component is a compile error,
 * and `scripts/smoke-tour-stops.ts` proves every id here is actually rendered somewhere.
 *
 * Several rows may carry the same id (every reminder's done button, every contact row):
 * the spotlight takes the first one that is visible, which is the one the copy means.
 */
export const TOUR_ANCHORS = {
  "dashboard.stats": "dashboard.stats",
  "contacts.search": "contacts.search",
  "contacts.row": "contacts.row",
  "contact.log-interaction": "contact.log-interaction",
  "capture.notes": "capture.notes",
  "capture.extract": "capture.extract",
  "capture.keep": "capture.keep",
  "reminders.row-done": "reminders.row-done",
  "reminders.rail-today": "reminders.rail-today",
  "chat.suggestions": "chat.suggestions",
  "chat.composer": "chat.composer",
  "graph.stage": "graph.stage",
  "graph.show-all": "graph.show-all",
  "imports.connections": "imports.connections",
  "imports.dropzone": "imports.dropzone",
  "reminders.new": "reminders.new",
  "contacts.add": "contacts.add",
  "compose.email": "compose.email",
} as const;

export type TourAnchorId = keyof typeof TOUR_ANCHORS;

/**
 * What each anchor is, in words. Cosmo is told which of these are on screen (src/lib/cosmo/screen.ts)
 * so it can say "the New reminder button" and point at it: the label comes from here, never from
 * the page's own text, which can hold anything a record says.
 */
export const TOUR_ANCHOR_LABELS: Record<TourAnchorId, string> = {
  "dashboard.stats": "Network stats on the dashboard",
  "contacts.search": "Contact search box",
  "contacts.row": "A contact in the list",
  "contact.log-interaction": "Log interaction button",
  "capture.notes": "Notes box on Capture",
  "capture.extract": "Extract people button",
  "capture.keep": "Keep this person button",
  "reminders.row-done": "Mark a reminder done",
  "reminders.rail-today": "Today's reminders",
  "chat.suggestions": "Suggested questions in Chat",
  "chat.composer": "Chat message box",
  "graph.stage": "Constellation map",
  "graph.show-all": "Show everyone on the map",
  "imports.connections": "LinkedIn connections import",
  "imports.dropzone": "File drop area for imports",
  "reminders.new": "New reminder button",
  "contacts.add": "Add contact button",
  "compose.email": "Email button",
};

export const TOUR_ANCHOR_ATTR = "data-tour";

/** Spread onto the element the tour should point at. */
export function tourAnchor(id: TourAnchorId): { [TOUR_ANCHOR_ATTR]: TourAnchorId } {
  return { [TOUR_ANCHOR_ATTR]: TOUR_ANCHORS[id] };
}

export function tourAnchorSelector(id: TourAnchorId): string {
  return `[${TOUR_ANCHOR_ATTR}="${TOUR_ANCHORS[id]}"]`;
}
