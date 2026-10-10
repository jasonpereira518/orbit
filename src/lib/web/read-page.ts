/**
 * Reading a public web page a person pasted, as text a model can pull people out of.
 *
 * The shared reader behind the public-web-data features (paste-a-URL capture first).
 * `guardedFetchText` already owns the SSRF fence, the hand-followed redirects and the body
 * cap; this adds the three things a pasted page needs on top:
 *
 * - Hosts Orbit never reads, refused on EVERY hop, so a short link that redirects to
 *   LinkedIn is refused before the LinkedIn request, not after it. LinkedIn is the one that
 *   matters: the extension's promise is that Orbit reads it only from the user's own tab.
 * - `http://` links upgraded to https, since the fence only speaks https.
 * - The page cut down to its title, description, JSON-LD and visible text, plus `thin` for
 *   a page whose content only appears in a browser.
 *
 * The text is untrusted. Callers fence it before a model sees it, and nothing stores it.
 */
import {
  EventPageError,
  guardedFetchText,
  type FetchPageDeps,
} from "@/lib/events/guarded-fetch";
import { decodeEntities, jsonLdNodes, meta, type JsonLdNode } from "@/lib/events/parse-page";

/** Visible text past this is dropped: enough for a team page, bounded for the prompt. */
export const MAX_PAGE_TEXT = 24_000;

/**
 * Below this much visible text the page probably renders in the browser, so it reads as
 * `thin`. ponytail: a guess; tune it against the paste-a-URL eval fixtures.
 */
export const THIN_TEXT_CHARS = 250;

/**
 * Sites whose pages Orbit does not read. LinkedIn and the social networks forbid it in their
 * terms, and LinkedIn stays inside the extension; Luma pending a legal read (events E0).
 */
const DENIED_HOSTS = [
  "linkedin.com",
  "lnkd.in",
  "facebook.com",
  "fb.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "lu.ma",
  "luma.com",
];

const NEEDS_JS = /(enable|requires?|turn on) javascript|javascript is (disabled|required)/i;

export type WebPage = {
  /** The URL the body finally came from. */
  url: string;
  title: string | null;
  description: string | null;
  jsonLd: JsonLdNode[];
  /** Visible text, at most `MAX_PAGE_TEXT` characters, newlines kept between blocks. */
  text: string;
  /** Too little text to be the real page: it likely needs a browser to render. */
  thin: boolean;
};

export function isDeniedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return DENIED_HOSTS.some((denied) => host === denied || host.endsWith(`.${denied}`));
}

function refuseDenied(url: string): void {
  const host = new URL(url).hostname.toLowerCase();
  if (!isDeniedHost(host)) return;
  throw new EventPageError(
    "blocked",
    /(^|\.)(linkedin\.com|lnkd\.in)$/.test(host)
      ? "Orbit doesn’t read LinkedIn pages. Paste the profile link on its own to add the person."
      : `Orbit doesn’t read pages on ${host}. Copy the text and paste that instead.`
  );
}

/** The pasted link as one Orbit will request: http upgraded, anything else refused. */
function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new EventPageError("blocked", "That doesn’t look like a web link.");
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") throw new EventPageError("blocked", "Paste a link that starts with https://.");
  url.hash = "";
  return url.href;
}

/** Visible text: scripts, styles and markup gone, block boundaries kept as newlines. */
export function visibleText(html: string): string {
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(br|hr)\b[^>]*>|<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|dd|dt)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
  );
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n\s*/g, "\n")
    .trim()
    .slice(0, MAX_PAGE_TEXT);
}

/** Read one pasted page. Throws `EventPageError`, whose messages are user-facing. */
export async function readWebPage(rawUrl: string, deps?: FetchPageDeps): Promise<WebPage> {
  const page = await guardedFetchText(normalizeUrl(rawUrl), { deps, beforeRequest: refuseDenied });
  const text = visibleText(page.text);
  const title =
    meta(page.text, ["og:title", "twitter:title"]) ??
    (/<title[^>]*>([^<]*)<\/title>/i.exec(page.text)?.[1]?.trim() || null);
  return {
    url: page.url,
    title: title ? decodeEntities(title) : null,
    description: meta(page.text, ["og:description", "description", "twitter:description"]),
    jsonLd: jsonLdNodes(page.text, []),
    text,
    thin: text.length < THIN_TEXT_CHARS || (NEEDS_JS.test(text) && text.length < 1_000),
  };
}
