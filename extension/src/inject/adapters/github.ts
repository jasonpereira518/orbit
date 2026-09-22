/**
 * github.com — a person's profile, or an organization's.
 *
 * GitHub is worth its own adapter mostly for what a profile LINKS to. Its
 * sidebar lists the person's other accounts (`[itemprop="social"]`), and a
 * LinkedIn or X link there is an exact identity the resolver matches on
 * wherever the page is (`identity.links`). So a developer stored only by their
 * LinkedIn is recognized on their GitHub.
 *
 * Only what the page already rendered, like every adapter: no API calls, no
 * following links, no repo pages. A repository page is about code, not a
 * person, and says so ("unknown").
 *
 * The selectors are GitHub's microdata (`itemprop`), which it has kept stable
 * for years precisely because other tools read it. They have not yet been
 * checked against a saved real page — the fixture saver exists for that.
 */
import type { PageKind } from "@contract";
import { cleanText, selectionText } from "../dom/text";
import { canonicalUrl, jsonLdPerson, metaContent } from "../dom/meta";
import { githubLogin, isXProfileUrl, linkedinSlug, canonicalLinkedInUrl } from "../dom/url";
import { isLikelyPersonName } from "../dom/names";
import {
  attempt,
  emptyIdentity,
  field,
  preferField,
  type PageContext,
  type SiteAdapter,
} from "./types";

const ADAPTER_VERSION = "github-1";
const BLOB_CHARS = 6_000;

const text = (selector: string) =>
  document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() || null;

/** One path segment that is a login, optionally with `?tab=…`. */
function loginFromPath(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  return segments.length === 1 ? githubLogin(segments[0]) : "";
}

function isOrganization(): boolean {
  const tag = metaContent("hovercard-subject-tag") ?? "";
  if (tag.startsWith("organization:")) return true;
  if (tag.startsWith("user:")) return false;
  return Boolean(document.querySelector('[itemtype$="/Organization"]'));
}

/** The person's other profiles, from the sidebar's social links. */
function socialLinks(warnings: string[]) {
  return (
    attempt(warnings, "social-links", () => {
      const links: { linkedin?: string; x?: string } = {};
      const anchors = Array.from(
        document.querySelectorAll<HTMLAnchorElement>('[itemprop="social"] a[href], .vcard-details a[href]')
      );
      for (const a of anchors) {
        if (!links.linkedin && linkedinSlug(a.href)) {
          links.linkedin = canonicalLinkedInUrl(a.href) ?? undefined;
        }
        if (!links.x && isXProfileUrl(a.href)) links.x = a.href;
      }
      return links;
    }) ?? {}
  );
}

export const githubAdapter: SiteAdapter = {
  id: "github",
  adapterVersion: ADAPTER_VERSION,
  matches: (url) => /^(www\.)?github\.com$/i.test(url.hostname),

  extract(url) {
    const warnings: string[] = [];
    const login = loginFromPath(url);
    const identity = emptyIdentity();
    let kind: PageKind = "unknown";
    let org: PageContext["org"];

    if (login && isOrganization()) {
      kind = "company";
      const name =
        text('[itemprop="name"]') ??
        text(".org-name") ??
        metaContent("og:title")?.replace(/\s*·\s*GitHub$/i, "") ??
        login;
      org = { name, githubLogin: login };
      identity.company = field(name, "itemprop", "medium");
    } else if (login) {
      kind = "person";
      const ld = attempt(warnings, "ld+json", () => jsonLdPerson());
      // og:title on a profile reads "login (Real Name) · GitHub".
      const ogName = metaContent("og:title")?.match(/\(([^)]+)\)/)?.[1] ?? null;
      const name = preferField(
        field(ld?.name, "ld+json", "high"),
        field(text('[itemprop="name"]'), "itemprop", "high"),
        isLikelyPersonName(ogName) ? field(ogName, "og:title", "medium") : null
      );
      identity.name = name;
      identity.handle = field(login, "url", "high");
      identity.profileUrl = field(`https://github.com/${login}`, "url", "high");
      identity.headline = field(
        attempt(warnings, "bio", () => text("[data-bio-text], .p-note, .user-profile-bio")),
        "bio",
        "medium"
      );
      identity.company = field(
        attempt(warnings, "company", () =>
          text('[itemprop="worksFor"]')?.replace(/^@/, "") ?? null
        ),
        "itemprop",
        "medium"
      );
      identity.location = field(
        attempt(warnings, "location", () => text('[itemprop="homeLocation"]')),
        "itemprop",
        "medium"
      );
      identity.email = field(
        attempt(warnings, "email", () => text('[itemprop="email"] a, [itemprop="email"]')),
        "itemprop",
        "high"
      );
      identity.photoUrl = preferField(
        field(
          attempt(warnings, "avatar", () =>
            document.querySelector<HTMLImageElement>("img.avatar-user, img.avatar")?.src ?? null
          ),
          "avatar",
          "medium"
        ),
        field(metaContent("og:image"), "og:image", "low")
      );
      identity.links = { github: `https://github.com/${login}`, ...socialLinks(warnings) };
    }

    const selection = selectionText(BLOB_CHARS);
    const root =
      kind === "person"
        ? document.querySelector('[itemtype$="/Person"], .js-profile-editable-area, main')
        : null;
    const blob = selection ?? (root ? cleanText(root, BLOB_CHARS) : { blob: "", truncated: false, charCount: 0 });

    return {
      schemaVersion: 1,
      site: "github",
      adapterVersion: ADAPTER_VERSION,
      kind,
      url: login ? `https://github.com/${login}` : (canonicalUrl() ?? url.href),
      sourceUrl: url.href,
      capturedAt: new Date().toISOString(),
      identity,
      org,
      text: { ...blob, fromSelection: Boolean(selection) },
      warnings,
    };
  },
};
