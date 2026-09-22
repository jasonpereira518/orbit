import type { PageContext } from "@contract";
import { browser } from "./browser";

export type PageReadReason =
  | "restricted"
  | "no-tab"
  | "no-permission"
  | "injection-failed";

export type PageReadResult =
  | { ok: true; page: PageContext }
  | { ok: false; reason: PageReadReason; message: string };

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
 * Read the current tab.
 *
 * Injection happens on demand under `activeTab` — there is no declared content
 * script, so nothing runs on any page until the user clicks the toolbar icon.
 */
export async function readActivePage(
  options: { full?: boolean } = {}
): Promise<PageReadResult> {
  const tab = await browser().activeTab();
  if (!tab?.id) {
    return { ok: false, reason: "no-tab", message: "No active tab." };
  }

  // An empty `url` on a real tab means Orbit holds no grant for it: the user
  // hasn't clicked the icon on this tab (or has since left the site it was
  // clicked on), and it isn't a site they've let Orbit follow them on.
  if (!tab.url) {
    return {
      ok: false,
      reason: "no-permission",
      message: "Click the Orbit icon to read this tab.",
    };
  }

  const restricted = restrictedReason(tab.url);
  if (restricted) {
    return { ok: false, reason: "restricted", message: restricted };
  }

  try {
    const value = (await browser().runExtractor(tab.id, options)) as
      | PageContext
      | { error: string }
      | undefined;
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
    // We could see the URL but not run on it — a grant was revoked, or this is
    // a page Chrome protects. Another click on the icon is the way back in.
    return {
      ok: false,
      reason: "no-permission",
      message: "Click the Orbit icon to read this tab.",
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
  github: "GitHub",
  generic: "Web",
};

export function siteLabel(page: PageContext): string {
  return SITE_LABELS[page.site];
}

/** True when the page isn't about a specific person we can act on. */
export function isPersonPage(page: PageContext): boolean {
  return page.kind === "person" || page.kind === "thread" || page.kind === "post";
}
