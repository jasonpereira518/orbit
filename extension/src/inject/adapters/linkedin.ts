/**
 * LinkedIn adapter.
 *
 * The organising principle: the URL is more durable than any DOM node. If every
 * selector below breaks, `/in/<slug>` still resolves a known contact correctly,
 * and the popup degrades to "we know who this is, we just can't show their
 * headline" rather than "we know nothing". Fields are gathered in trust order
 * and each one is independently fallible.
 *
 * Nothing here navigates, clicks, expands "see more", scrolls to load more, or
 * paginates on an ordinary read. It reads what the user's own browser has already
 * rendered, once, because they clicked the toolbar icon.
 *
 * The one deliberate exception: when `extract` is called with `options.withProfile` on a
 * `person` page — which only happens from an explicit "Capture experience" press in the
 * panel — it runs `expandProfileSections` (see that file's header for the full argument
 * and its bounds) before reading the profile sections, and returns `schemaVersion: 2` with
 * a `profile`. Every other call, including every ordinary panel open, never sets that flag
 * and gets exactly the old `schemaVersion: 1` behavior back, synchronously.
 */

// Relative, not the `@/` alias: these two files are also imported directly by
// `scripts/smoke-contact-profile-format.ts` from repo root (see that file's header), which
// resolves under the ROOT tsconfig — where `@/*` points at the app's `src/`, not this
// extension's. Keeping every import this adapter needs alias-free is what lets that script
// exercise the real `linkedinAdapter`, not a stand-in.
import { cleanText, selectionText } from "../dom/text";
import {
  canonicalUrl,
  jsonLdPerson,
  metaContent,
  parseTitle,
} from "../dom/meta";
import { isLikelyPersonName } from "../dom/names";
import {
  canonicalLinkedInUrl,
  isOpaqueSlug,
  linkedinSlug,
  stripTracking,
} from "../dom/url";
import { expandProfileSections } from "../dom/expand";
import { readProfileSections } from "./linkedin-profile";
import type { PageProfile } from "@contract";
import {
  attempt,
  emptyIdentity,
  field,
  preferField,
  type ExtractOptions,
  type PageContext,
  type PageKind,
  type SiteAdapter,
} from "./types";

const ADAPTER_VERSION = "linkedin-2";
const PROFILE_BLOB_CHARS = 10_000;
const THREAD_BLOB_CHARS = 6_000;
const POST_BLOB_CHARS = 4_000;
const MAX_CANDIDATES = 10;

function pageKind(url: URL): PageKind {
  const path = url.pathname;
  if (/^\/in\//i.test(path)) return "person";
  if (/^\/messaging\//i.test(path)) return "thread";
  if (/^\/search\/results\/people/i.test(path) || /^\/mynetwork/i.test(path)) {
    return "list";
  }
  if (/^\/company\//i.test(path) || /^\/school\//i.test(path)) return "company";
  if (/^\/feed\/update\//i.test(path) || /^\/posts\//i.test(path)) return "post";
  return "unknown";
}

function looksLikeLoginWall(): boolean {
  const path = window.location.pathname;
  if (/^\/(login|uas|checkpoint|authwall)/i.test(path)) return true;
  return Boolean(document.querySelector("form.login__form, #organic-div"));
}

/** Split "VP Engineering at Stripe" into its two halves when it has that shape. */
function splitHeadline(headline: string | null): {
  title: string | null;
  company: string | null;
} {
  if (!headline) return { title: null, company: null };
  const match = headline.match(/^(.{2,80}?)\s+(?:at|@)\s+(.{2,80}?)$/i);
  if (!match) return { title: null, company: null };
  return { title: match[1].trim(), company: match[2].trim() };
}

function profileIdentity(url: URL, warnings: string[]) {
  const identity = emptyIdentity();
  const slug = linkedinSlug(url.href);
  const canonical = canonicalLinkedInUrl(url.href);

  if (slug) {
    identity.handle = field(slug, "url", "high");
    identity.profileUrl = field(canonical, "url", "high");
    if (isOpaqueSlug(slug)) warnings.push("opaque-slug");
  } else {
    warnings.push("no-slug");
  }

  const ld = attempt(warnings, "ld+json", () => jsonLdPerson());
  const titleParts = attempt(warnings, "title", () =>
    parseTitle(document.title, ["| LinkedIn", "- LinkedIn", "LinkedIn"])
  );
  const h1 = attempt(warnings, "h1", () => {
    const node =
      document.querySelector("main h1") ?? document.querySelector("h1");
    const text = node?.textContent?.trim() ?? "";
    return isLikelyPersonName(text) ? text : null;
  });
  const ogTitle = attempt(warnings, "og:title", () => metaContent("og:title"));
  const ogDescription = attempt(warnings, "og:description", () =>
    metaContent("og:description")
  );

  identity.name = preferField(
    field(ld?.name, "ld+json", "high"),
    field(h1, "h1", "high"),
    field(titleParts?.name, "document.title", "medium"),
    field(ogTitle ? parseTitle(ogTitle, ["| LinkedIn"]).name : null, "og:title", "medium")
  );

  const headlineText =
    titleParts?.rest ??
    (ogTitle ? parseTitle(ogTitle, ["| LinkedIn"]).rest : null) ??
    ogDescription;
  identity.headline = field(headlineText, "document.title", "medium");

  const fromHeadline = splitHeadline(headlineText);
  identity.title = preferField(
    field(ld?.jobTitle, "ld+json", "high"),
    field(fromHeadline.title, "headline", "medium")
  );
  identity.company = preferField(
    field(ld?.worksFor, "ld+json", "high"),
    field(fromHeadline.company, "headline", "medium")
  );
  identity.location = preferField(
    field(ld?.address, "ld+json", "high"),
    attempt(warnings, "location", () => {
      // The location line sits directly under the name block. Matching on the
      // "top card" container rather than a hashed class name survives longer.
      const node = document.querySelector(
        "main section:first-of-type .text-body-small:not(.inline)"
      );
      const text = node?.textContent?.trim();
      return text && text.length < 120 ? field(text, "top-card", "low") : null;
    }) ?? null
  );
  identity.school = field(ld?.alumniOf, "ld+json", "medium");
  identity.email = field(ld?.email, "ld+json", "high");

  identity.photoUrl = preferField(
    attempt(warnings, "photo", () => {
      const name = identity.name?.value ?? "";
      const images = Array.from(
        document.querySelectorAll<HTMLImageElement>(
          'img[src*="media.licdn.com"]'
        )
      );
      const match =
        images.find((img) => name && (img.alt ?? "").includes(name)) ??
        images.find((img) => img.width >= 100);
      return field(match?.src, "img", "medium");
    }) ?? null,
    field(ld?.image, "ld+json", "medium"),
    field(metaContent("og:image"), "og:image", "low")
  );

  return identity;
}

function threadIdentity(warnings: string[]) {
  const identity = emptyIdentity();
  const participants = attempt(warnings, "thread-participants", () => {
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        '.msg-thread a[href*="/in/"], .msg-entity-lockup a[href*="/in/"], header a[href*="/in/"]'
      )
    );
    const seen = new Map<string, { name: string; profileUrl: string }>();
    for (const link of links) {
      const slug = linkedinSlug(link.href);
      if (!slug || seen.has(slug)) continue;
      const name = (link.textContent ?? "").trim();
      if (!isLikelyPersonName(name)) continue;
      seen.set(slug, {
        name,
        profileUrl: `https://www.linkedin.com/in/${slug}`,
      });
    }
    return [...seen.values()];
  });

  if (participants?.length === 1) {
    identity.name = field(participants[0].name, "thread-header", "high");
    identity.profileUrl = field(participants[0].profileUrl, "thread-header", "high");
    identity.handle = field(
      linkedinSlug(participants[0].profileUrl),
      "thread-header",
      "high"
    );
  }
  return { identity, participants: participants ?? [] };
}

function postAuthor(warnings: string[]) {
  const identity = emptyIdentity();
  attempt(warnings, "post-author", () => {
    // The author link lives in the post header. Comment authors are ignored on
    // purpose: they're noise, and they're third parties.
    const container =
      document.querySelector(".feed-shared-update-v2") ??
      document.querySelector("article") ??
      document.body;
    const link = container.querySelector<HTMLAnchorElement>('a[href*="/in/"]');
    if (!link) return null;
    const slug = linkedinSlug(link.href);
    const name = (link.textContent ?? "").trim().split("\n")[0].trim();
    if (!slug) return null;
    identity.handle = field(slug, "post-header", "high");
    identity.profileUrl = field(
      `https://www.linkedin.com/in/${slug}`,
      "post-header",
      "high"
    );
    if (isLikelyPersonName(name)) {
      identity.name = field(name, "post-header", "medium");
    }
    return null;
  });
  return identity;
}

function listCandidates(warnings: string[]) {
  return (
    attempt(warnings, "list-candidates", () => {
      const links = Array.from(
        document.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')
      );
      const seen = new Map<string, { name: string; profileUrl: string; subtitle?: string }>();
      for (const link of links) {
        // Only what is already rendered. No scrolling, no pagination — that is
        // the line between reading a page and scraping a site.
        if (seen.size >= MAX_CANDIDATES) break;
        const slug = linkedinSlug(link.href);
        if (!slug || seen.has(slug)) continue;
        const name = (link.textContent ?? "").trim().split("\n")[0].trim();
        if (!isLikelyPersonName(name)) continue;
        const card = link.closest("li, .entity-result, [data-view-name]");
        const subtitle = card
          ?.querySelector(".entity-result__primary-subtitle, .t-14")
          ?.textContent?.trim();
        seen.set(slug, {
          name,
          profileUrl: `https://www.linkedin.com/in/${slug}`,
          subtitle: subtitle || undefined,
        });
      }
      return [...seen.values()];
    }) ?? []
  );
}

export const linkedinAdapter: SiteAdapter = {
  id: "linkedin",
  adapterVersion: ADAPTER_VERSION,
  matches: (url) => /(^|\.)linkedin\.com$/i.test(url.hostname),

  extract(url: URL, options?: ExtractOptions) {
    const warnings: string[] = [];
    const kind = pageKind(url);

    if (looksLikeLoginWall()) warnings.push("login-wall");

    let identity = emptyIdentity();
    let candidates: PageContext["candidates"];
    let blobRoot: Element | null = document.querySelector("main");
    let blobLimit = PROFILE_BLOB_CHARS;

    if (kind === "person") {
      identity = profileIdentity(url, warnings);
    } else if (kind === "thread") {
      const thread = threadIdentity(warnings);
      identity = thread.identity;
      if (thread.participants.length > 1) candidates = thread.participants;
      blobRoot = document.querySelector(".msg-s-message-list, .msg-thread") ?? blobRoot;
      blobLimit = THREAD_BLOB_CHARS;
    } else if (kind === "post") {
      identity = postAuthor(warnings);
      blobRoot =
        document.querySelector(".feed-shared-update-v2") ??
        document.querySelector("article") ??
        blobRoot;
      blobLimit = POST_BLOB_CHARS;
    } else if (kind === "list") {
      candidates = listCandidates(warnings);
      blobRoot = null;
    } else if (kind === "company") {
      identity.company = preferField(
        field(metaContent("og:title"), "og:title", "medium"),
        field(document.title.split("|")[0], "document.title", "low")
      );
      blobRoot = null;
    } else {
      // /feed/ and everything else: deliberately no extraction. Never scrape
      // the feed.
      blobRoot = null;
    }

    // Reads the CURRENT state of `blobRoot`, so calling this after `expandProfileSections`
    // has run picks up the now-expanded sections. That distinction matters: the server's
    // AI fallback (`fallbackParse`) reads exactly this blob, and it only ever fires when
    // the selectors came back empty — precisely the case where the page needs to already
    // be expanded for the fallback to see anything the selectors missed. Computing this
    // once, eagerly, before expansion would silently feed the fallback the collapsed page.
    const computeText = () => {
      const selection = selectionText(blobLimit);
      const text =
        selection ??
        (blobRoot
          ? cleanText(blobRoot, blobLimit)
          : { blob: "", truncated: false, charCount: 0 });
      return { ...text, fromSelection: Boolean(selection) };
    };

    const contextUrl =
      identity.profileUrl?.value ?? canonicalUrl() ?? stripTracking(url.href);

    const buildContext = (
      schemaVersion: 1 | 2,
      text: ReturnType<typeof computeText>,
      profile?: PageProfile
    ): PageContext => ({
      schemaVersion,
      site: "linkedin",
      adapterVersion: ADAPTER_VERSION,
      kind,
      url: contextUrl,
      sourceUrl: url.href,
      capturedAt: new Date().toISOString(),
      identity,
      candidates,
      text,
      warnings,
      ...(profile ? { profile } : {}),
    });

    // The one interaction this adapter ever performs, and only from an explicit
    // "Capture experience" press (see `options.withProfile`'s doc in ./types and
    // `inject/dom/expand.ts`'s header for the bounds). Every other call —
    // including every ordinary panel open — never reaches this branch.
    if (kind === "person" && options?.withProfile) {
      return (async () => {
        const expansion = await expandProfileSections();
        const profile = readProfileSections(document);
        if (expansion.timedOut) warnings.push("expand-timeout");
        if (expansion.capped) warnings.push("expand-capped");
        // "parse-incomplete", not "profile-empty": the server raises the same condition
        // under that name (`src/lib/extension/profile-capture.ts`), and two names for one
        // thing made the stored `warnings` array unreadable.
        if (profile.parseIncomplete) warnings.push("parse-incomplete");
        // AFTER expansion — see `computeText`'s comment.
        return buildContext(2, computeText(), profile);
      })();
    }

    return buildContext(1, computeText());
  },
};
