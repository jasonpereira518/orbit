/**
 * The hand-off between "I logged this" and "there it is".
 *
 * Logging an interaction closes a panel and, a moment later, a row appears somewhere in a list
 * behind it. Nothing connects the two, so the write reads as a form submission rather than as
 * an addition to a history. The flight is the connection: the type you picked leaves the button
 * you pressed and lands on the spine as the node it is about to become.
 *
 * An event rather than props because the button and the timeline are in different subtrees under
 * a Server Component, the same reason `reveal-interaction` works this way.
 */
export const INTERACTION_FLIGHT_EVENT = "orbit:interaction-flight";

export type InteractionFlightDetail = {
  /** Where the object starts — the rect of the control that was pressed. */
  from: { top: number; left: number; width: number; height: number };
  interactionType: string;
  /** When known, the flight lands on this row's own node instead of the head of the spine. */
  interactionId?: string;
};

export function requestInteractionFlight(detail: InteractionFlightDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<InteractionFlightDetail>(INTERACTION_FLIGHT_EVENT, { detail })
  );
}
