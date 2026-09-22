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
  type PageCandidate,
} from "./types";

const ADAPTER_VERSION = "generic-2";
const MAX_CANDIDATES = 10;
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

/**
 * People on a team, speakers or "about us" page: two or more distinct LinkedIn
 * profiles, each linked from something that reads as a person's name (the
 * anchor text, its label, or its image's alt). A personal site's link to its
 * owner's LinkedIn usually reads "LinkedIn", not a name, so it isn't counted.
 */
function teamCandidates(): PageCandidate[] {
  const seen = new Map<string, PageCandidate>();
  for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    if (seen.size >= MAX_CANDIDATES) break;
    const slug = linkedinSlug(anchor.href);
    if (!slug || seen.has(slug)) continue;
    const name = [
      anchor.textContent?.split("\n")[0],
      anchor.getAttribute("aria-label"),
      anchor.querySelector("img")?.getAttribute("alt"),
    ]
      .map((value) => value?.replace(/\s+/g, " ").trim() ?? "")
      .find((value) => isLikelyPersonName(value) && !looksLikeSiteName(value));
    if (!name) continue;
    seen.set(slug, { name, profileUrl: `https://www.linkedin.com/in/${slug}` });
  }
  return [...seen.values()];
}

export const genericAdapter: SiteAdapter = {
  id: "generic",
  adapterVersion: ADAPTER_VERSION,
  matches: () => true,

  extract(url) {
    const warnings: string[] = [];
    const identity = emptyIdentity();

    // A page about several people is a pick list, decided FIRST. Otherwise the
    // person logic below takes the first LinkedIn link on the page as THE
    // person — a ten-person team page used to read as its first member.
    const team = attempt(warnings, "team", teamCandidates) ?? [];
    if (team.length >= 2) {
      const selection = selectionText(BLOB_CHARS);
      const orgName =
        metaContent("og:site_name") ?? url.hostname.replace(/^www\./i, "");
      return {
        schemaVersion: 1,
        site: "generic",
        adapterVersion: ADAPTER_VERSION,
        kind: "list",
        url: canonicalUrl() ?? stripTracking(url.href),
        sourceUrl: url.href,
        capturedAt: new Date().toISOString(),
        identity,
        candidates: team,
        org: { name: orgName },
        text: selection
          ? { ...selection, fromSelection: true }
          : { blob: "", truncated: false, charCount: 0, fromSelection: false },
        warnings,
      };
    }

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
    identity.links = {
      ...(links.linkedin ? { linkedin: links.linkedin } : {}),
      ...(links.handle ? { x: `https://x.com/${links.handle}` } : {}),
    };
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
