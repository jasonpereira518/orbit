/**
 * Dispatched (from the mobile "More" sheet and from Settings → Help) to open the feedback
 * panel on surfaces where the floating button is not shown. Mirrors
 * `src/lib/ask-bar-events.ts` — one mounted widget, several doors into it.
 */
export const OPEN_FEEDBACK_EVENT = "orbit:open-feedback";
