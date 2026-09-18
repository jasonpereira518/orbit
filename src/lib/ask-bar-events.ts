/** Dispatched (e.g. from the mobile "More" sheet) to open the floating ask
 * bar on screens where it isn't persistently visible. */
export const OPEN_ASK_BAR_EVENT = "orbit:open-ask-bar";

/**
 * What `OPEN_ASK_BAR_EVENT` may carry. A bare `Event` still just opens the bar; a
 * `CustomEvent` with a `question` opens it and asks — which is how the command palette
 * hands over whatever was typed into it.
 */
export type OpenAskBarDetail = { question?: string };

export function requestAskBar(detail: OpenAskBarDetail = {}) {
  window.dispatchEvent(new CustomEvent<OpenAskBarDetail>(OPEN_ASK_BAR_EVENT, { detail }));
}

/** Opens the command palette from anywhere — the sidebar button, the mobile header. */
export const OPEN_COMMAND_PALETTE_EVENT = "orbit:open-command-palette";
