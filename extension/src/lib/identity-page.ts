/**
 * A PageContext for a person the panel knows only by a link or a list row —
 * never by visiting their page.
 *
 * Used when the user picks someone from a list (search results, a team page, a
 * group thread) and when they right-click a profile link. In both cases Orbit
 * has an exact identity (the profile URL, a handle, an address) and maybe a
 * name, and that is all `/resolve` needs to answer "do I know them?". The page
 * itself is never fetched: reading only what the user's own browser rendered
 * is the extension's line, and a link is not a rendered page.
 *
 * `text` is empty and `warnings` says why, so the server makes no AI calls
 * over it and the panel knows not to offer page-derived features.
 */
import type { ExtractedField, PageContext, PageSite } from "@contract";
import { canonicalLinkedInUrl, githubLogin, isXProfileUrl, linkedinSlug, xHandle } from "@/inject/dom/url";

export const IDENTITY_ONLY = "identity-only";

const listField = (value: string | undefined): ExtractedField =>
  value?.trim() ? { value: value.trim(), source: "list", confidence: "medium" } : null;
const urlField = (value: string): ExtractedField => ({ value, source: "url", confidence: "high" });

export type IdentityHint = {
  name?: string;
  profileUrl?: string;
  email?: string;
  subtitle?: string;
};

/** Which site a link is a profile on, and its canonical form. Null: not a profile. */
export function profileFromLink(href: string): { site: PageSite; url: string; handle: string } | null {
  const slug = linkedinSlug(href);
  if (slug) return { site: "linkedin", url: canonicalLinkedInUrl(href)!, handle: slug };
  if (isXProfileUrl(href)) {
    const handle = xHandle(href);
    return { site: "x", url: `https://x.com/${handle}`, handle };
  }
  try {
    const host = new URL(href).hostname.toLowerCase();
    if (host === "github.com" || host === "www.github.com") {
      const login = githubLogin(href);
      // A repo URL names its owner; only a bare profile path is a person.
      const segments = new URL(href).pathname.split("/").filter(Boolean);
      if (login && segments.length === 1) {
        return { site: "github", url: `https://github.com/${login}`, handle: login };
      }
    }
  } catch {
    // not a URL
  }
  return null;
}

export function identityOnlyPage(hint: IdentityHint): PageContext | null {
  const profile = hint.profileUrl ? profileFromLink(hint.profileUrl) : null;
  if (!profile && !hint.email) return null;

  const url = profile?.url ?? `mailto:${hint.email}`;
  return {
    schemaVersion: 1,
    site: profile?.site ?? "gmail",
    adapterVersion: "identity-1",
    kind: "person",
    url,
    sourceUrl: hint.profileUrl ?? url,
    capturedAt: new Date().toISOString(),
    identity: {
      name: listField(hint.name),
      headline: listField(hint.subtitle),
      title: null,
      company: null,
      location: null,
      school: null,
      email: hint.email ? { value: hint.email, source: "list", confidence: "high" } : null,
      handle: profile ? urlField(profile.handle) : null,
      profileUrl: profile ? urlField(profile.url) : null,
      photoUrl: null,
      links: profile ? { [profile.site === "x" ? "x" : profile.site]: profile.url } : undefined,
    },
    text: { blob: "", truncated: false, charCount: 0, fromSelection: false },
    warnings: [IDENTITY_ONLY],
  };
}
