/**
 * Gmail adapter — identity only, and deliberately no message bodies.
 *
 * Orbit already ingests Gmail properly over OAuth (src/lib/gmail.ts), so
 * reading message content out of the DOM would duplicate that while taking on
 * disproportionate Chrome Web Store review exposure for mail-derived data. What
 * the OAuth path can't do is answer "who am I looking at right now", so that is
 * all this does.
 *
 * `span[email]` is the one hook that has survived a decade of Gmail rewrites.
 */

import { selectionText } from "@/inject/dom/text";
import { isLikelyPersonName } from "@/inject/dom/names";
import { stripTracking } from "@/inject/dom/url";
import {
  attempt,
  emptyIdentity,
  field,
  type PageContext,
  type SiteAdapter,
} from "./types";

const ADAPTER_VERSION = "gmail-1";

function participants(warnings: string[]) {
  return (
    attempt(warnings, "participants", () => {
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>("span[email]")
      );
      const seen = new Map<string, { name: string; subtitle?: string }>();
      for (const node of nodes) {
        const email = node.getAttribute("email")?.trim().toLowerCase();
        if (!email || seen.has(email)) continue;
        const name = (node.getAttribute("name") || node.textContent || "").trim();
        seen.set(email, {
          name: isLikelyPersonName(name) ? name : email,
          subtitle: email,
        });
      }
      return [...seen.entries()].map(([email, v]) => ({ ...v, email }));
    }) ?? []
  );
}

export const gmailAdapter: SiteAdapter = {
  id: "gmail",
  adapterVersion: ADAPTER_VERSION,
  matches: (url) =>
    /^mail\.google\.com$/i.test(url.hostname) && url.pathname.startsWith("/mail"),

  extract(url) {
    const warnings: string[] = [];
    const identity = emptyIdentity();
    const people = participants(warnings);

    // Drop the signed-in user; the popup cross-checks against /me as a backstop.
    const selfEmail = attempt(warnings, "self", () => {
      const label = document
        .querySelector('[aria-label*="Google Account"]')
        ?.getAttribute("aria-label");
      return label?.match(/\(([^)]+@[^)]+)\)/)?.[1]?.toLowerCase() ?? null;
    });
    const others = people.filter((p) => p.email !== selfEmail);

    let candidates: PageContext["candidates"];
    if (others.length === 1) {
      identity.name = field(others[0].name, "span[email]", "medium");
      identity.email = field(others[0].email, "span[email]", "high");
    } else if (others.length > 1) {
      candidates = others.map((p) => ({ name: p.name, subtitle: p.email }));
    }

    const kind = others.length >= 1 ? "thread" : "unknown";
    // Only ever the user's own explicit selection — never the thread body.
    const selection = selectionText(2_000);

    return {
      schemaVersion: 1,
      site: "gmail",
      adapterVersion: ADAPTER_VERSION,
      kind,
      url: stripTracking(url.href),
      sourceUrl: url.href,
      capturedAt: new Date().toISOString(),
      identity,
      candidates,
      text: selection
        ? { ...selection, fromSelection: true }
        : { blob: "", truncated: false, charCount: 0, fromSelection: false },
      warnings,
    };
  },
};
