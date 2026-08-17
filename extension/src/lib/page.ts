import type { PageContext } from "@contract";

export type PageReadResult =
  | { ok: true; page: PageContext }
  | { ok: false; reason: "restricted" | "no-tab" | "injection-failed"; message: string };

/** Pages Chrome refuses to inject into. Worth naming so the popup can say why. */
function restrictedReason(url: string | undefined): string | null {
  if (!url) return "Orbit can't read this page.";
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
    return { ok: true, page: value };
  } catch {
    // activeTab is granted per click and revoked on cross-origin navigation.
    return {
      ok: false,
      reason: "injection-failed",
      message: "Click the Orbit icon again to read this page.",
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
