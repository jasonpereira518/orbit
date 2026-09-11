/**
 * Turning an event page's HTML into the handful of facts Orbit wants from it.
 *
 * Pure: no network, no database, no DOM. That is what lets its smoke test run in the `pure`
 * tier, where the fixtures in `scripts/smoke-event-parse.ts` stand in for real pages — when
 * Luma reshuffles its markup, a failing assertion there is what says so.
 *
 * Worth knowing the limit of that net: those fixtures are hand-written to resemble each
 * platform, not captured from it, so they catch a regression in THIS parser and cannot catch
 * a platform changing its markup underneath us.
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
 * ## What this reads about people — a narrowed rule, narrowed once more
 *
 * #140 said flatly: no attendee data is ever read from a page. That became: only `performer`
 * is read — the billed speakers a host published — and no general guest list ever is. This
 * revision widens it by exactly one step, and the step is worth stating precisely.
 *
 * Read: the HOSTS, and the guests a host chose to FEATURE on their own event page. Both are
 * the host advertising their own event, about people who agreed to be on the bill. Also read:
 * the guest COUNT, a number the page renders to everyone, which names nobody.
 *
 * Still never read: the guest list. Nothing here looks at RSVPs, "who's going" widgets or
 * ticket holders; nothing sends a cookie or calls an internal endpoint; nothing paginates.
 * An attendee list is a roomful of people who did not consent to appear in a stranger's CRM,
 * and every platform's terms draw the line in the same place.
 *
 * Everyone read here arrives as UNCONFIRMED roster rows tagged `source: "page"`. #140's other
 * rule — nobody becomes a contact without a human saying so — is untouched.
 */

import { parsePlatformPage, type PagePerson } from "@/lib/events/platforms/adapters";
import type { EventPlatform } from "@/lib/events/platforms";

/** A billed speaker, as published by the host. See the header on why only these are read. */
export type EventSpeaker = { name: string; url: string | null };

/** A line-up, not a guest list. Real ones are small; the cap is a hostile-input bound. */
export const MAX_SPEAKERS = 50;

export type EventPageDetails = {
  /** The URL actually read, after redirects — the canonical link we store. */
  sourceUrl: string;
  canonicalUrl: string | null;
  title: string | null;
  description: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  /**
   * The UTC offset the page published (`-08:00`, `Z`), or null when it published a
   * floating local time. Null is a real answer, not a missing one — see `parseDate`.
   */
  timezone: string | null;
  venue: string | null;
  city: string | null;
  /** Who ran it. Inert: displayed on the event, never turned into a contact. */
  organizerName: string | null;
  organizerUrl: string | null;
  /** `eventAttendanceMode`. Explains a blank venue instead of it looking broken. */
  attendanceMode: "offline" | "online" | "mixed" | null;
  /** `performer` only. Never a guest list — see the header. */
  speakers: EventSpeaker[];
  /** Which platform's page this was, when we recognise it. */
  platform: EventPlatform | null;
  /** The platform's own id for the event — the strongest dedup key there is. */
  providerEventId: string | null;
  /** The people running it, as the page itself names them. */
  hosts: PagePerson[];
  /**
   * Guests the HOST chose to feature on the page.
   *
   * Not a guest list, and the distinction is the whole basis of this feature: these are people
   * a host put on their own event's page, the same way a speaker line-up is. Nothing here
   * reads RSVPs, "who's going" widgets, or ticket holders, and no cookie is ever sent.
   */
  featuredGuests: PagePerson[];
  /** How many people the page says are going. A number, naming nobody. */
  guestCount: number | null;
  imageUrl: string | null;
  /** `<meta name="theme-color">`, the strongest rung of the theming ladder. */
  themeColor: string | null;
  /**
   * Which signals were missing or malformed. Diagnostic, not user-facing copy: `fetch-page.ts`
   * reads `no-jsonld-event` as one half of its sign-in-wall test, and `no-timezone` is what
   * makes the null `timezone` above legible to a reader of this object.
   *
   * (Nothing renders these. The one caveat a user needs — an unstated time zone — reaches the
   * UI through the stored `timezone` column being null, not through this array.)
   */
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

/** `Z` or `±HH:MM` / `±HHMM` at the end of an ISO datetime. */
const UTC_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse a JSON-LD date, and say what zone it was expressed in.
 *
 * The bug this fixes is quiet and environment-dependent. `new Date("2026-03-04T18:00:00")` —
 * an ISO datetime with no offset, which hosts publish routinely — is interpreted in the
 * RUNTIME's zone. So the same event page yields one instant on a laptop in New York and a
 * different one on Vercel, where the runtime is UTC; a 6pm event could store and display as
 * a different day depending on where the parse happened.
 *
 * Appending `Z` makes it deterministic. That is not the same as making it correct: without
 * an offset the host's intended wall-clock time is genuinely unknowable, so `timezone`
 * comes back null and the caller records `no-timezone` rather than implying certainty.
 */
function parseDate(raw: unknown): { date: Date | null; timezone: string | null } {
  if (typeof raw !== "string" || raw.trim() === "") return { date: null, timezone: null };
  const text = raw.trim();
  const offset = UTC_OFFSET.exec(text)?.[1] ?? null;
  // Only when a time is present: a bare `2026-03-04` is already spec'd as UTC.
  const normalized = offset || !/\d{1,2}:\d{2}/.test(text) ? text : `${text}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return { date: null, timezone: null };
  return { date, timezone: offset };
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

/** JSON-LD `organizer` is a string, a Person/Organization, or an array of either. */
function organizerOf(node: JsonLdNode): { name: string | null; url: string | null } {
  const raw = node["organizer"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first === "string") return { name: clean(first), url: null };
  if (first && typeof first === "object") {
    const record = first as JsonLdNode;
    return { name: stringField(record, "name"), url: stringField(record, "url") };
  }
  return { name: null, url: null };
}

/**
 * `eventAttendanceMode`, published as a schema.org URL, a bare enum name, or occasionally an
 * array. Matched on the distinguishing word so all three spellings land the same.
 *
 * `mixed` is tested first only for readability — the three names share no substring
 * ("Offline" does not contain "online"), so the order does not actually decide anything.
 */
function attendanceModeOf(node: JsonLdNode): "offline" | "online" | "mixed" | null {
  const raw = node["eventAttendanceMode"];
  const text = typeof raw === "string" ? raw : Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : null;
  if (!text) return null;
  if (/mixed/i.test(text)) return "mixed";
  if (/online/i.test(text)) return "online";
  if (/offline/i.test(text)) return "offline";
  return null;
}

/**
 * JSON-LD `performer` — the billed line-up, and the ONLY people-bearing field read from a
 * page. Deduped by name, since a host listing someone as both performer and subEvent
 * performer is common and two identical roster rows are not.
 */
function speakersOf(node: JsonLdNode): EventSpeaker[] {
  const raw = node["performer"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: EventSpeaker[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (out.length >= MAX_SPEAKERS) break;
    let name: string | null = null;
    let url: string | null = null;
    if (typeof entry === "string") {
      name = clean(entry);
    } else if (entry && typeof entry === "object") {
      name = stringField(entry as JsonLdNode, "name");
      url = stringField(entry as JsonLdNode, "url");
    }
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, url });
  }
  return out;
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

  const starts = event
    ? attempt(warnings, "startDate", () => parseDate(event["startDate"]))
    : null;
  const ends = event ? attempt(warnings, "endDate", () => parseDate(event["endDate"])) : null;
  const organizer = event
    ? attempt(warnings, "organizer", () => organizerOf(event))
    : null;
  const speakers = event ? attempt(warnings, "performer", () => speakersOf(event)) : null;

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
    startsAt: starts?.date ?? null,
    endsAt: ends?.date ?? null,
    timezone: starts?.timezone ?? null,
    venue: place.venue,
    city: place.city,
    organizerName: organizer?.name ?? null,
    // Resolved against the page: hosts write organizer URLs relative surprisingly often.
    organizerUrl: absolute(organizer?.url ?? null, sourceUrl),
    attendanceMode: event
      ? attempt(warnings, "eventAttendanceMode", () => attendanceModeOf(event))
      : null,
    speakers: speakers ?? [],
    platform: null,
    providerEventId: null,
    hosts: [],
    featuredGuests: [],
    guestCount: null,
    imageUrl: absolute(ogImage ?? ldImage, sourceUrl),
    themeColor: attempt(warnings, "theme-color", () => {
      const value = meta(head, ["theme-color", "msapplication-TileColor"]);
      // Only a hex colour is useful downstream; `theme.ts` cannot clamp `rebeccapurple`.
      return value && /^#[0-9a-f]{3,8}$/i.test(value) ? value : null;
    }),
    warnings,
  };

  if (!event) warnings.push("no-jsonld-event");
  // The host published a wall-clock time with no zone, so the instant above is a guess.
  // Recorded rather than hidden — `fetch-page.ts` and the UI both read these.
  if (details.startsAt && !details.timezone) warnings.push("no-timezone");

  // The platform overlay, where the page belongs to a platform we know.
  //
  // It wins on three fields and only three: the event's own id (JSON-LD has none), the IANA
  // zone name (JSON-LD can only carry an offset, which is wrong half the year), and the
  // people — because JSON-LD's `performer` is empty on every one of these platforms while
  // their embedded JSON names the hosts outright.
  const platform = attempt(warnings, "platform", () => parsePlatformPage(html, sourceUrl));
  if (platform) {
    details.platform = platform.platform;
    details.providerEventId = platform.providerEventId;
    details.hosts = platform.hosts;
    details.featuredGuests = platform.featuredGuests;
    details.guestCount = platform.guestCount;
    details.organizerName = details.organizerName ?? platform.organizerName;
    if (platform.timezone) details.timezone = platform.timezone;
    // A known platform whose page yielded no event is markup drift, and the one failure this
    // parser cannot notice on its own — everything else degrades to a missing field.
    if (platform.zeroYield) warnings.push("platform-zero-yield");
  }
  return details;
}
