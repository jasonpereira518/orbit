/**
 * "Capture this" from the command palette: text typed anywhere in the app, carried to the
 * capture page's textarea.
 *
 * sessionStorage, not the URL. A note can run to paragraphs, a query string has a length
 * limit and ends up in history and server logs, and this only ever has to survive one
 * navigation inside one tab. The event covers the case where there is no navigation at all
 * — the palette was opened on /capture itself, and the panel is already mounted.
 *
 * Pure apart from the `Storage` it is handed; see `scripts/smoke-capture-draft.ts`.
 */

export const CAPTURE_HANDOFF_EVENT = "orbit:capture-handoff";

const KEY = "orbit:capture-handoff";

/**
 * Older than this and it was not meant for the page now opening. A handoff is written and
 * taken within one navigation; anything left over is from a tab that went somewhere else.
 */
export const HANDOFF_MAX_AGE_MS = 2 * 60 * 1000;

export function writeCaptureHandoff(
  storage: Pick<Storage, "setItem">,
  text: string,
  now = Date.now()
) {
  try {
    storage.setItem(KEY, JSON.stringify({ text, at: now }));
  } catch {
    // Storage is unavailable; the capture page simply opens empty.
  }
}

/** The waiting text, removed as it is read so it can only ever be taken once. */
export function takeCaptureHandoff(
  storage: Pick<Storage, "getItem" | "removeItem">,
  now = Date.now()
): string | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(KEY);
    if (raw) storage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; at?: unknown };
    if (typeof parsed.text !== "string" || typeof parsed.at !== "number") return null;
    if (now - parsed.at > HANDOFF_MAX_AGE_MS) return null;
    return parsed.text.trim() || null;
  } catch {
    return null;
  }
}

/** Write the handoff and tell a capture page that may already be open. */
export function handOffToCapture(text: string) {
  writeCaptureHandoff(window.sessionStorage, text);
  window.dispatchEvent(new Event(CAPTURE_HANDOFF_EVENT));
}

/** Append a handed-off note to whatever is already in the box, a blank line between. */
export function appendHandoff(existing: string, text: string) {
  const base = existing.trimEnd();
  return base ? `${base}\n\n${text}` : text;
}
