/**
 * Where the extension lives, for every web-app surface that mentions it.
 *
 * Zero imports on purpose: the promo, the welcome page (Clerk-free, prerendered),
 * the Settings tab and the wizard all read this, and none of them should drag
 * anything else into their bundle to learn a URL.
 */

/**
 * The Chrome Web Store listing. Before it is published this falls back to a
 * store search rather than hiding every "Add to Chrome" — the store is the
 * destination either way. Set `NEXT_PUBLIC_EXTENSION_URL` once it is live.
 */
export const EXTENSION_STORE_URL =
  process.env.NEXT_PUBLIC_EXTENSION_URL?.trim() || "https://chromewebstore.google.com/search/orbit";

/**
 * The extension's ID (pinned by the `key` in its manifest). Only needed to ask
 * an installed extension "are you there?" — unset, the app simply never
 * detects it and every surface behaves as if it is not installed.
 */
export function extensionId(): string | null {
  return process.env.NEXT_PUBLIC_EXTENSION_ID?.trim() || null;
}
export const EXTENSION_ID = extensionId();

/** The page the extension opens on install. */
export const EXTENSION_WELCOME_PATH = "/extension/welcome";

/** The messages the extension answers from this app's origin, and nothing else. */
export const EXTENSION_HELLO = "orbit/hello";
export const EXTENSION_SESSION_CHANGED = "orbit/session-changed";
