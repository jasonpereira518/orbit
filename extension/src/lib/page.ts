import type { PageContext } from "@contract";

export type PageReadReason =
  | "restricted"
  | "no-tab"
  | "no-permission"
  | "injection-failed";

export type PageReadResult =
  | { ok: true; page: PageContext }
  | { ok: false; reason: PageReadReason; message: string; origin?: string };

/** Pages Chrome refuses to inject into. Worth naming so the panel can say why. */
function restrictedReason(url: string): string | null {
  if (/^(chrome|edge|about|devtools|view-source):/i.test(url)) {
    return "Orbit can't read browser pages.";
  }
  if (/^https:\/\/chromewebstore\.google\.com/i.test(url)) {
    return "Orbit can't read the Chrome Web Store.";
  }
  if (/^file:/i.test(url)) return "Orbit can't read local files.";
  return null;
}

/**
 * Dev-only visibility into the one property the whole capture feature rests on: an
 * ordinary panel-open read must always come back `schemaVersion: 1` with no `profile`, and
 * only an explicit "Capture experience" press may ever produce `schemaVersion: 2`. Gated
 * behind a `chrome.storage.local` flag rather than a source edit, so verifying it by hand
 * doesn't require touching code — from the panel's own DevTools console, run:
 *   `chrome.storage.local.set({ "orbit:debugCapture": true })`
 * and every subsequent read logs its schema version until the flag is cleared again.
 */
async function debugLogSchemaVersion(page: PageContext): Promise<void> {
  try {
    const flag = await chrome.storage.local.get("orbit:debugCapture");
    if (!flag["orbit:debugCapture"]) return;
    console.debug("[orbit] page read", {
      schemaVersion: page.schemaVersion,
      hasProfile: "profile" in page,
      url: page.url,
    });
  } catch {
    // Best-effort diagnostics only — must never affect the real read.
  }
}

function originOf(url: string): string | undefined {
  try {
    const { protocol, hostname } = new URL(url);
    if (!/^https?:$/.test(protocol)) return undefined;
    return `${protocol}//${hostname}/*`;
  } catch {
    return undefined;
  }
}

/**
 * Read the current tab.
 *
 * Two injections rather than one: the extractor is a bundled IIFE, and a
 * bundled IIFE's completion value is not reliably what `executeScript` reports.
 * So the file parks its result on a global and a second trivial call reads it.
 * Both are milliseconds, and it removes a whole class of "works in dev, returns
 * undefined in prod" bundler dependence.
 *
 * Injection happens on demand under `activeTab` — there is no declared content
 * script, so nothing runs on any page until the user clicks the toolbar icon.
 */
export async function readActivePage(): Promise<PageReadResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { ok: false, reason: "no-tab", message: "No active tab." };
  }

  // An empty `url` on a real tab means we hold no permission for it.
  //
  // This is the side panel's central difference from a popup. `activeTab` is
  // granted by "executing an action" — but when the action's job is to open the
  // side panel, Chrome does not fire the action and does not grant it. So a
  // panel opened from the toolbar can see that a tab exists and nothing more,
  // and the only way through is an explicit host permission for the site.
  if (!tab.url) {
    return {
      ok: false,
      reason: "no-permission",
      message: "Orbit needs your go-ahead to read this site.",
    };
  }

  const restricted = restrictedReason(tab.url);
  if (restricted) {
    return { ok: false, reason: "restricted", message: restricted };
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["inject/extract.js"],
    });

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window as unknown as { __orbitPageContext?: unknown }).__orbitPageContext,
    });

    const value = result?.result as PageContext | { error: string } | undefined;
    if (!value) {
      return {
        ok: false,
        reason: "injection-failed",
        message: "Click the Orbit icon again to read this page.",
      };
    }
    if ("error" in value) {
      return { ok: false, reason: "injection-failed", message: value.error };
    }
    await debugLogSchemaVersion(value);
    return { ok: true, page: value };
  } catch {
    // We could see the URL but not run on it — a host permission was revoked,
    // or this is a page Chrome protects. Offer the grant for its origin.
    return {
      ok: false,
      reason: "no-permission",
      message: "Orbit needs your go-ahead to read this site.",
      origin: originOf(tab.url),
    };
  }
}

/**
 * Same preflight as `readActivePage`, but the injection asks the LinkedIn adapter to
 * expand collapsed sections and read the full profile before returning — the one capture
 * path that can click something on the page. Only the panel's explicit "Capture
 * experience" button may call this; see `inject/dom/expand.ts`'s header for the bounds
 * that keep that safe, and `inject/extract.ts`'s header for how the two-injection scheme
 * carries the async result back without polling.
 */
export async function captureActiveProfile(): Promise<PageReadResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { ok: false, reason: "no-tab", message: "No active tab." };
  }

  if (!tab.url) {
    return {
      ok: false,
      reason: "no-permission",
      message: "Orbit needs your go-ahead to read this site.",
    };
  }

  const restricted = restrictedReason(tab.url);
  if (restricted) {
    return { ok: false, reason: "restricted", message: restricted };
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["inject/extract.js"],
    });

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () =>
        (
          window as unknown as {
            __orbitExtract?: { captureProfile?: () => Promise<unknown> };
          }
        ).__orbitExtract?.captureProfile?.(),
    });

    const value = result?.result as PageContext | { error: string } | undefined;
    if (!value) {
      return {
        ok: false,
        reason: "injection-failed",
        message: "Click the Orbit icon again to read this page.",
      };
    }
    if ("error" in value) {
      return { ok: false, reason: "injection-failed", message: value.error };
    }
    await debugLogSchemaVersion(value);
    return { ok: true, page: value };
  } catch {
    return {
      ok: false,
      reason: "no-permission",
      message: "Orbit needs your go-ahead to read this site.",
      origin: originOf(tab.url),
    };
  }
}

/** Best display name for whoever the page is about. */
export function pageDisplayName(page: PageContext): string | null {
  return page.identity.name?.value ?? null;
}

export function pageSubtitle(page: PageContext): string | null {
  const id = page.identity;
  const headline = id.headline?.value;
  if (headline) return headline;
  const title = id.title?.value;
  const company = id.company?.value;
  if (title && company) return `${title} at ${company}`;
  return title ?? company ?? null;
}

const SITE_LABELS: Record<PageContext["site"], string> = {
  linkedin: "LinkedIn",
  x: "X",
  gmail: "Gmail",
  generic: "Web",
};

export function siteLabel(page: PageContext): string {
  return SITE_LABELS[page.site];
}

/** True when the page isn't about a specific person we can act on. */
export function isPersonPage(page: PageContext): boolean {
  return page.kind === "person" || page.kind === "thread" || page.kind === "post";
}
