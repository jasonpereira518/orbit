/**
 * Fallback adapter for any other page.
 *
 * Small, but high leverage: a conference speaker bio or a company team page
 * very often links to the person's LinkedIn or X profile, which hands us an
 * exact-match key for free — the same key the deep adapters work hard to build.
 */

import { cleanText, selectionText } from "@/inject/dom/text";
import { canonicalUrl, jsonLdPerson, metaContent, parseTitle } from "@/inject/dom/meta";
import {
  isLikelyPersonName,
  looksLikeSiteName,
  stripTitlePrefix,
} from "@/inject/dom/names";
import {
  canonicalLinkedInUrl,
  isXProfileUrl,
  linkedinSlug,
  stripTracking,
  xHandle,
} from "@/inject/dom/url";
import {
  attempt,
  emptyIdentity,
  field,
  preferField,
  type PageKind,
  type SiteAdapter,
} from "./types";

const ADAPTER_VERSION = "generic-1";
const BLOB_CHARS = 6_000;

function socialLinks(warnings: string[]) {
  return attempt(warnings, "social-links", () => {
    let linkedin: string | null = null;
    let handle: string | null = null;
    for (const anchor of Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href]")
    )) {
      const href = anchor.href;
      if (!linkedin && linkedinSlug(href)) linkedin = canonicalLinkedInUrl(href);
      if (!handle && isXProfileUrl(href)) handle = xHandle(href);
      if (linkedin && handle) break;
    }
    return { linkedin, handle };
  });
}

export const genericAdapter: SiteAdapter = {
  id: "generic",
  adapterVersion: ADAPTER_VERSION,
  matches: () => true,

  extract(url) {
    const warnings: string[] = [];
    const identity = emptyIdentity();

    const ld = attempt(warnings, "ld+json", () => jsonLdPerson());
    const links = socialLinks(warnings) ?? { linkedin: null, handle: null };
    const personName = (raw: string | null | undefined) => {
      const text = stripTitlePrefix((raw ?? "").trim());
      if (!text || looksLikeSiteName(text)) return null;
      return isLikelyPersonName(text) ? text : null;
    };
    const h1 = attempt(warnings, "h1", () => {
      const nodes = Array.from(document.querySelectorAll("h1"));
      if (nodes.length !== 1) return null;
      return personName(nodes[0].textContent);
    });
    const titleName = attempt(warnings, "title", () =>
      personName(parseTitle(document.title, []).name)
    );

    identity.name = preferField(
      field(ld?.name, "ld+json", "high"),
      field(h1, "h1", "medium"),
      field(titleName, "document.title", "low")
    );
    identity.title = field(ld?.jobTitle, "ld+json", "high");
    identity.company = field(ld?.worksFor, "ld+json", "high");
    identity.location = field(ld?.address, "ld+json", "medium");
    identity.school = field(ld?.alumniOf, "ld+json", "medium");
    identity.headline = field(metaContent("og:description", "description"), "og:description", "low");
    identity.photoUrl = preferField(
      field(ld?.image, "ld+json", "medium"),
      field(metaContent("og:image"), "og:image", "low")
    );
    identity.profileUrl = field(links.linkedin, "page-link", "high");
    identity.handle = field(links.handle, "page-link", "medium");
    identity.email = preferField(
      field(ld?.email, "ld+json", "high"),
      attempt(warnings, "mailto", () => {
        const mailto = document.querySelector<HTMLAnchorElement>('a[href^="mailto:"]');
        const address = mailto?.href.replace(/^mailto:/i, "").split("?")[0];
        return field(address, "mailto", "medium");
      }) ?? null
    );

    // Only claim this is a person when something corroborates it. A lone
    // heading is not evidence — most pages have one, and on a personal site it
    // is usually the site's name rather than a human's.
    const corroborated =
      Boolean(links.linkedin) ||
      Boolean(ld?.name) ||
      Boolean((h1 || titleName) && (links.handle || identity.email?.value));
    const kind: PageKind = corroborated ? "person" : "unknown";

    const selection = selectionText(BLOB_CHARS);
    const root =
      document.querySelector("main, article, [role='main']") ?? document.body;
    const text = selection ?? cleanText(root, BLOB_CHARS);

    return {
      schemaVersion: 1,
      site: "generic",
      adapterVersion: ADAPTER_VERSION,
      kind,
      url: canonicalUrl() ?? stripTracking(url.href),
      sourceUrl: url.href,
      capturedAt: new Date().toISOString(),
      identity,
      text: { ...text, fromSelection: Boolean(selection) },
      warnings,
    };
  },
};
