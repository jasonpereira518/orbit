/**
 * Is the Orbit extension installed in THIS browser? Asked of the extension
 * itself, which answers only this app's origin (its manifest's
 * `externally_connectable`) and says nothing about the user — its version and
 * which sites it may follow without a click.
 *
 * Browser-only. Resolves null — never throws, never hangs — when the ID isn't
 * configured, the browser has no extension messaging (Safari, Firefox, mobile),
 * or nothing answers in time.
 */
import { EXTENSION_HELLO, EXTENSION_SESSION_CHANGED, extensionId } from "./links";

export type ExtensionPresence = {
  version: string;
  /** Sites it follows without a click, e.g. ["LinkedIn", "GitHub"]. */
  sites: string[];
};

type ChromeRuntime = {
  sendMessage: (id: string, message: unknown, callback: (response: unknown) => void) => void;
  lastError?: unknown;
};

function runtime(): ChromeRuntime | null {
  if (typeof window === "undefined" || !extensionId()) return null;
  const chrome = (window as unknown as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  // `chrome.runtime.sendMessage` exists on a web page only when some installed
  // extension lists that page in externally_connectable — which is itself a hint.
  return typeof chrome?.runtime?.sendMessage === "function" ? chrome.runtime : null;
}

function ask(message: unknown, timeoutMs: number): Promise<unknown> {
  const rt = runtime();
  const id = extensionId();
  if (!rt || !id) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      rt.sendMessage(id, message, (response) => {
        clearTimeout(timer);
        // Reading lastError is what stops Chrome logging "Could not establish
        // connection" for an extension that isn't installed.
        void rt.lastError;
        resolve(response ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

let pending: Promise<ExtensionPresence | null> | null = null;

/** Asked once per page load; every surface on the page shares the answer. */
export function pingExtension(timeoutMs = 800): Promise<ExtensionPresence | null> {
  pending ??= ask({ type: EXTENSION_HELLO }, timeoutMs).then((response) => {
    const r = response as { ok?: unknown; version?: unknown; sites?: unknown } | null;
    if (!r || r.ok !== true || typeof r.version !== "string") return null;
    const sites = Array.isArray(r.sites) ? r.sites.filter((s): s is string => typeof s === "string") : [];
    return { version: r.version, sites };
  });
  return pending;
}

/**
 * Tell an open panel the web session may have changed (the user just signed
 * in), so a panel showing "sign in" picks the session up without the user
 * pressing "I've signed in". Carries no data. Fire and forget.
 */
export function pokeExtensionSession(): void {
  void ask({ type: EXTENSION_SESSION_CHANGED }, 800);
}

/** Desktop Chrome, Edge, Brave, Arc… — where a Chrome Web Store extension installs. */
export function isDesktopChromium(): boolean {
  if (typeof navigator === "undefined") return false;
  const data = (navigator as unknown as {
    userAgentData?: { mobile?: boolean; brands?: Array<{ brand: string }> };
  }).userAgentData;
  if (data?.brands) {
    return !data.mobile && data.brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand));
  }
  const ua = navigator.userAgent;
  return /Chrome\//.test(ua) && !/Mobile|Android|CriOS/i.test(ua);
}
