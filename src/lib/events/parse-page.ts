/**
 * Turning an event page's HTML into the handful of facts Orbit wants from it.
 *
 * Pure: no network, no database, no DOM. That is what lets its smoke test run in the `pure`
 * tier and what makes the fixtures in `scripts/fixtures/events/` a real regression net — when
 * Luma reshuffles its markup, a recorded page and a failing assertion say so.
 *
 * ## Why regexes rather than a DOM parser
 *
 * `linkedom` sits in devDependencies but is imported nowhere in this repo, so reaching for it
 * would mean promoting a dependency (and probably adding it to `serverExternalPackages`) to
 * read three meta tags out of an input that `fetch-page.ts` has already capped at 512 KB.
 * The scope here is genuinely small — OpenGraph tags, a `theme-color`, and any JSON-LD blocks,
 * which are parsed with `JSON.parse` rather than pattern-matched. Everything below is anchored
 * and bounded; none of it backtracks over the whole document.
 *
 * ## Everything degrades
 *
 * Every field is optional and every extraction is independently guarded. A malformed JSON-LD
 * block must not cost us the OpenGraph title — this is the same rule the browser extension's
 * `attempt()` helper enforces for its adapters, for the same reason: a page we cannot fully
 * read is still worth the parts we can.
 *
 * NOTE: there is deliberately no attendee field on `EventPageDetails`. Guest lists are never
 * scraped from a page; see the header of `fetch-page.ts`.
 */

export type EventPageDetails = {
  /** The URL actually read, after redirects — the canonical link we store. */
  sourceUrl: string;
  canonicalUrl: string | null;
  title: string | null;
  description: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  venue: string | null;
  city: string | null;
  imageUrl: string | null;
  /** `<meta name="theme-color">`, the strongest rung of the theming ladder. */
  themeColor: string | null;
  /** Which JSON-LD/OG signals were actually present. Surfaced so the UI can be honest. */
  warnings: string[];
};

/** Run one extraction without letting it cost the others. Mirrors the extension's `attempt`. */
function attempt<T>(warnings: string[], label: string, fn: () => T): T | null {
  try {
    return fn() ?? null;
  } catch {
    warnings.push(`parse-failed:${label}`);
    return null;
  }
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    // Last, or it would corrupt the entities decoded above.
    .replace(/&amp;/g, "&");
}

function clean(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = decodeEntities(raw).replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

/**
 * Read one `<meta>` tag's content.
 *
 * Attribute order is not fixed in real markup (`content` sometimes precedes `property`), so
 * both orders are tried. `[^>]*` keeps each match inside a single tag, which is what stops
 * this from running away across the document.
 */
function meta(html: string, names: string[]): string | null {
  for (const name of names) {
    const key = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta[^>]*(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, "i"),
      new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, "i"),
    ];
    for (const pattern of patterns) {
      const hit = pattern.exec(html);
      const value = clean(hit?.[1]);
      if (value) return value;
    }
  }
  return null;
}

function canonical(html: string): string | null {
  const hit = /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html);
  return clean(hit?.[1]);
}

function parseDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

type JsonLdNode = Record<string, unknown>;

/**
 * Every JSON-LD object on the page, flattened.
 *
 * `@graph` and top-level arrays are both common, and an event is routinely nested inside one
 * rather than sitting alone — so the tree is walked instead of only reading the root.
 */
function jsonLdNodes(html: string, warnings: string[]): JsonLdNode[] {
  const out: JsonLdNode[] = [];
  const blocks = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const block of blocks) {
    const raw = block[1];
    if (!raw) continue;
    // Per-block try/catch, not one around the loop: one malformed block on a page with three
    // must not discard the two that parse.
    try {
      const walk = (node: unknown) => {
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (!node || typeof node !== "object") return;
        const record = node as JsonLdNode;
        out.push(record);
        if ("@graph" in record) walk(record["@graph"]);
      };
      walk(JSON.parse(raw));
    } catch {
      warnings.push("parse-failed:ld+json");
    }
  }
  return out;
}

function isEventNode(node: JsonLdNode): boolean {
  const type = node["@type"];
  const types = Array.isArray(type) ? type : [type];
  // Schema.org subtypes all end in "Event" (BusinessEvent, SocialEvent, Festival is the
  // exception but rare enough not to chase). Substring match keeps this open to subtypes.
  return types.some((t) => typeof t === "string" && /event/i.test(t));
}

function stringField(node: JsonLdNode, key: string): string | null {
  const value = node[key];
  if (typeof value === "string") return clean(value);
  return null;
}

/** JSON-LD `location` is a string, a Place, or a PostalAddress-bearing Place. */
function locationOf(node: JsonLdNode): { venue: string | null; city: string | null } {
  const location = node["location"];
  if (typeof location === "string") return { venue: clean(location), city: null };
  if (!location || typeof location !== "object") return { venue: null, city: null };
  const place = (Array.isArray(location) ? location[0] : location) as JsonLdNode;
  if (!place || typeof place !== "object") return { venue: null, city: null };
  const address = place["address"];
  let city: string | null = null;
  if (address && typeof address === "object" && !Array.isArray(address)) {
    city = stringField(address as JsonLdNode, "addressLocality");
  } else if (typeof address === "string") {
    city = clean(address);
  }
  return { venue: stringField(place, "name"), city };
}

/** JSON-LD `image` is a string, an array, or an ImageObject. */
function imageOf(node: JsonLdNode): string | null {
  const image = node["image"];
  if (typeof image === "string") return clean(image);
  if (Array.isArray(image) && typeof image[0] === "string") return clean(image[0]);
  if (image && typeof image === "object") return stringField(image as JsonLdNode, "url");
  return null;
}

function absolute(url: string | null, base: string): string | null {
  if (!url) return null;
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

/**
 * Parse an event page.
 *
 * Precedence is by trustworthiness, not convenience: JSON-LD wins for dates and place (it is
 * typed data the host published on purpose, where OpenGraph has no date field at all), while
 * OpenGraph wins for the image (`og:image` is the one the host chose for sharing, and is
 * reliably a real, large graphic — JSON-LD `image` is often a logo).
 */
export function parseEventPage(html: string, sourceUrl: string): EventPageDetails {
  const warnings: string[] = [];
  // Metadata lives in <head>; bounding the search there keeps a long body off every regex.
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd > 0 ? html.slice(0, headEnd) : html;

  const nodes = attempt(warnings, "ld+json", () => jsonLdNodes(html, warnings)) ?? [];
  const event = nodes.find(isEventNode) ?? null;
  const place = event ? locationOf(event) : { venue: null, city: null };

  const ogImage = attempt(warnings, "og:image", () =>
    meta(head, ["og:image", "twitter:image", "twitter:image:src"])
  );
  const ldImage = event ? attempt(warnings, "ld:image", () => imageOf(event)) : null;

  const details: EventPageDetails = {
    sourceUrl,
    canonicalUrl: absolute(
      attempt(warnings, "canonical", () => canonical(head) ?? meta(head, ["og:url"])),
      sourceUrl
    ),
    title:
      (event && stringField(event, "name")) ??
      attempt(warnings, "og:title", () => meta(head, ["og:title", "twitter:title"])) ??
      attempt(warnings, "title", () => {
        const hit = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(head);
        return clean(hit?.[1]);
      }),
    description:
      (event && stringField(event, "description")) ??
      attempt(warnings, "og:description", () =>
        meta(head, ["og:description", "description", "twitter:description"])
      ),
    startsAt: event ? parseDate(event["startDate"]) : null,
    endsAt: event ? parseDate(event["endDate"]) : null,
    venue: place.venue,
    city: place.city,
    imageUrl: absolute(ogImage ?? ldImage, sourceUrl),
    themeColor: attempt(warnings, "theme-color", () => {
      const value = meta(head, ["theme-color", "msapplication-TileColor"]);
      // Only a hex colour is useful downstream; `theme.ts` cannot clamp `rebeccapurple`.
      return value && /^#[0-9a-f]{3,8}$/i.test(value) ? value : null;
    }),
    warnings,
  };

  if (!event) warnings.push("no-jsonld-event");
  return details;
}
