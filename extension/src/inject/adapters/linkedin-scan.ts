/**
 * "Scan this page for people I know" (Radar PR 11): the posts already rendered on a LinkedIn
 * feed or on someone's activity page, read ONCE, because the person pressed Scan.
 *
 * The LinkedIn adapter's rule still stands for everything else: opening the panel never reads
 * the feed. This runs only in the extractor's scan mode, which the panel sets for that click.
 * Like the adapter it never scrolls, expands "see more", or loads more: it reads what the
 * person's own browser has already drawn, at most `SCAN_MAX_POSTS`.
 *
 * What it returns is not sent as is. The panel sends Orbit only the authors' profile links
 * first, and then only the posts of the authors Orbit says are contacts.
 *
 * Pure over a root node and a URL, so a smoke can run it on saved HTML.
 */

export const SCAN_MAX_POSTS = 25;
export const SCAN_EXCERPT_CHARS = 1000;

export type ScannedPost = {
  /** https://www.linkedin.com/in/<slug>, lowercased slug. */
  authorProfileUrl: string;
  authorName: string | null;
  excerpt: string;
  /** The post's own page, from its activity urn. */
  url: string | null;
};

/** Where Scan is offered: the feed, and a person's activity pages. */
export function isScanPath(pathname: string): boolean {
  return /^\/feed\/?$/i.test(pathname) || /^\/in\/[^/]+\/recent-activity(\/|$)/i.test(pathname);
}

function slugOf(href: string | null | undefined): string {
  const m = (href ?? "").match(/linkedin\.com\/in\/([^/?#]+)/i) ?? (href ?? "").match(/^\/in\/([^/?#]+)/i);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return m[1].toLowerCase();
  }
}

function textOf(el: Element | null): string {
  if (!el) return "";
  // innerText on the live page (it skips LinkedIn's visually hidden duplicate spans);
  // textContent where there is no layout (a smoke's parsed HTML).
  const raw = (el as HTMLElement).innerText ?? el.textContent ?? "";
  return raw.replace(/\s+/g, " ").trim();
}

/** The post's author: the link in its actor header, never a commenter or someone mentioned. */
function authorOf(post: Element): { slug: string; name: string | null } | null {
  const actor = post.querySelector(".update-components-actor, .feed-shared-actor");
  const link =
    actor?.querySelector<HTMLAnchorElement>('a[href*="/in/"]') ??
    // Older markup with no actor wrapper: the first profile link outside the comments.
    Array.from(post.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')).find(
      (a) => !a.closest(".comments-comments-list, .comments-comment-list, .feed-shared-update-v2__comments-container")
    ) ??
    null;
  const slug = slugOf(link?.getAttribute("href"));
  if (!slug) return null;
  const nameEl =
    actor?.querySelector('.update-components-actor__title span[aria-hidden="true"]') ??
    actor?.querySelector(".update-components-actor__name, .feed-shared-actor__name") ??
    null;
  const name = textOf(nameEl) || null;
  return { slug, name };
}

export function scanLinkedinPosts(root: ParentNode, pageUrl: URL): ScannedPost[] {
  if (!isScanPath(pageUrl.pathname)) return [];
  // On someone's activity page every post is theirs unless its header says otherwise.
  const pageOwner = slugOf(pageUrl.pathname);
  const nodes = Array.from(root.querySelectorAll('[data-urn^="urn:li:activity:"], .feed-shared-update-v2'));
  // A post's wrapper and its inner update are both matched: keep the outermost of each.
  const posts = nodes.filter((n) => !nodes.some((other) => other !== n && other.contains(n)));
  const out: ScannedPost[] = [];
  const seen = new Set<string>();
  for (const post of posts) {
    if (out.length >= SCAN_MAX_POSTS) break;
    const author = authorOf(post) ?? (pageOwner && /recent-activity/i.test(pageUrl.pathname) ? { slug: pageOwner, name: null } : null);
    // A company page, an ad or a post with no person behind it: nothing to match.
    if (!author) continue;
    const bodyEl =
      post.querySelector(".update-components-text") ??
      post.querySelector(".feed-shared-inline-show-more-text") ??
      post.querySelector(".feed-shared-text");
    const excerpt = textOf(bodyEl).slice(0, SCAN_EXCERPT_CHARS);
    if (!excerpt) continue;
    const urn =
      post.getAttribute("data-urn") ??
      post.querySelector('[data-urn^="urn:li:activity:"]')?.getAttribute("data-urn") ??
      null;
    const url = urn && /^urn:li:activity:\d+$/.test(urn) ? `https://www.linkedin.com/feed/update/${urn}/` : null;
    const key = url ?? `${author.slug}:${excerpt.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ authorProfileUrl: `https://www.linkedin.com/in/${author.slug}`, authorName: author.name, excerpt, url });
  }
  return out;
}
