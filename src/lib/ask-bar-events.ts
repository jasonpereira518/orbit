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

const under = (pathname: string, root: string) => pathname === root || pathname.startsWith(`${root}/`);

/**
 * Whether the floating Ask bar shows on a page. The bar IS chat (it streams from `/api/chat`),
 * so it hides wherever chat is hidden, on pages that fill the viewport or own the bottom edge,
 * and on /radar until Radar is on: the Turn on screen's button sits where the bar floats.
 */
export function showAskBarFor(
  pathname: string,
  f: { tourActive: boolean; chatHidden: boolean; radarOn: boolean },
): boolean {
  if (f.tourActive || f.chatHidden) return false;
  if (under(pathname, "/radar")) return f.radarOn;
  return !(
    pathname === "/onboarding" ||
    pathname === "/chat" ||
    under(pathname, "/settings") ||
    under(pathname, "/graph") ||
    pathname === "/reminders" ||
    pathname === "/knowledge"
  );
}
