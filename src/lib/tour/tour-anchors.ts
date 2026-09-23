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
  "capture.keep": "capture.keep",
  "reminders.row-done": "reminders.row-done",
  "reminders.rail-today": "reminders.rail-today",
  "chat.suggestions": "chat.suggestions",
  "chat.composer": "chat.composer",
  "graph.stage": "graph.stage",
  "graph.show-all": "graph.show-all",
  "imports.connections": "imports.connections",
} as const;

export type TourAnchorId = keyof typeof TOUR_ANCHORS;

export const TOUR_ANCHOR_ATTR = "data-tour";

/** Spread onto the element the tour should point at. */
export function tourAnchor(id: TourAnchorId): { [TOUR_ANCHOR_ATTR]: TourAnchorId } {
  return { [TOUR_ANCHOR_ATTR]: TOUR_ANCHORS[id] };
}

export function tourAnchorSelector(id: TourAnchorId): string {
  return `[${TOUR_ANCHOR_ATTR}="${TOUR_ANCHORS[id]}"]`;
}
