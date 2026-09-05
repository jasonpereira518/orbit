/**
 * Asks the contact timeline to bring one interaction into view before anything tries to scroll
 * to it or glow it.
 *
 * `ContactBriefCard` and `ContactTimeline` are siblings on the profile with no shared state, and
 * the timeline can now hide a row two ways — a family filter, or the "show older" window. A
 * plain `#interaction-<id>` scroll has no answer to either: `flashSection` retries for two
 * seconds and then gives up silently, so a "recent discussion" link would simply do nothing.
 *
 * Modelled on `flashSection`'s own event rather than lifting state into the page: the page is a
 * Server Component, and the alternative is making it a client component to hold a boolean that
 * is almost always false.
 */
export const REVEAL_INTERACTION_EVENT = "orbit:reveal-interaction";

export type RevealInteractionDetail = { interactionId: string };

export function requestInteractionReveal(interactionId: string) {
  if (typeof window === "undefined" || !interactionId) return;
  window.dispatchEvent(
    new CustomEvent<RevealInteractionDetail>(REVEAL_INTERACTION_EVENT, {
      detail: { interactionId },
    })
  );
}
