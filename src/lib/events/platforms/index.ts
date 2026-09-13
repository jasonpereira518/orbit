/**
 * Recognising an event platform from a URL, an email address, or a block of text.
 *
 * Discovery reads things that were never written for us — a calendar invite's description, a
 * confirmation email, an ICS `URL` property — and the question is always the same: is there an
 * event link in here, and which platform's is it?
 *
 * ## Why an id, and not just a link
 *
 * A link is a weak key. The same Luma event is `lu.ma/abc` in an email from 2024,
 * `luma.com/abc` in one copied today, `lu.ma/abc?tk=<token>` in the invite, and
 * `lu.ma/e/evt-XYZ` in the ICS feed. Deduping on any of those alone produces four events.
 * A platform's own id is stable across all of them, so it is extracted wherever the URL
 * carries one and used as the strongest alias key.
 *
 * Where a platform's URL only carries a slug (Partiful, Posh), the slug IS the id — it is
 * stable for that platform even though it tells us nothing on its own.
 *
 * Pure: no network, no database, no DOM.
 */
import { canonicalizeEventUrl } from "@/lib/events/canonical-url";

/** Platforms we can recognise. Not the same set as `provider`, which means "we can sync it". */
export type EventPlatform = "luma" | "partiful" | "eventbrite" | "meetup" | "posh";

export type PlatformMatch = {
  platform: EventPlatform;
  /** The platform's own id, where the URL carries one. Null means "link only". */
  providerEventId: string | null;
};

function hostMatches(hostname: string, base: string): boolean {
  return hostname === base || hostname.endsWith(`.${base}`);
}

/** Eventbrite runs a dozen ccTLDs (.co.uk, .ca, .com.au); match the label, not the suffix. */
function isEventbrite(hostname: string): boolean {
  return /(^|\.)eventbrite\.[a-z]{2,}(\.[a-z]{2,})?$/.test(hostname);
}

/**
 * Luma ids look like `evt-XXXXXXXX`. They appear in the ICS feed's URL property and in
 * management links; a plain `lu.ma/abc` share link carries only the slug, which is NOT an id
 * — two slugs can be re-pointed, so it stays a URL-tier key.
 */
const LUMA_EVENT_ID = /\bevt-[A-Za-z0-9]{4,}\b/;

/**
 * Not an event page: Luma's own marketing, discovery, account and mail-footer routes.
 *
 * The mail-footer ones matter most. A Luma confirmation email is signed, from a platform
 * sender, and full of lu.ma links — and `lu.ma/unsubscribe` is a single-segment path, exactly
 * the shape of an event slug. Without it here, the one link in the footer every such email
 * carries became an event on the user's page.
 */
const LUMA_NON_EVENT =
  /^\/(?:discover|explore|pricing|about|terms|privacy|legal|help|faq|signin|sign-in|login|logout|signup|sign-up|verify|create|home|user|u|calendar|cal|settings|account|notifications|emails?|unsubscribe|manage|dashboard|api|ics|search|map|ios|android|download|blog|careers|contact)(?:\/|$)/i;

const PARTIFUL_NON_EVENT =
  /^\/(?:about|terms|privacy|legal|help|faq|login|logout|signup|create|me|u|settings|account|notifications|unsubscribe|emails?|download|blog|careers)(?:\/|$)/i;

export function platformOf(input: string | URL): PlatformMatch | null {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (hostMatches(host, "lu.ma") || hostMatches(host, "luma.com")) {
    if (LUMA_NON_EVENT.test(path)) return null;
    const fromPath = LUMA_EVENT_ID.exec(path)?.[0] ?? null;
    const slug = path.replace(/^\/(?:e\/)?/, "").replace(/\/+$/, "");
    if (!fromPath && !slug) return null;
    return { platform: "luma", providerEventId: fromPath };
  }

  if (hostMatches(host, "partiful.com")) {
    if (PARTIFUL_NON_EVENT.test(path)) return null;
    // `/e/<id>` is the event route; a bare `/<id>` also resolves.
    const hit = /^\/(?:e\/)?([A-Za-z0-9_-]{4,})\/?$/.exec(path);
    return hit ? { platform: "partiful", providerEventId: hit[1]! } : null;
  }

  if (isEventbrite(host)) {
    // `…-tickets-1234567890` is the canonical shape; `/e/1234567890` is the short one.
    const fromSlug = /-tickets-(\d{6,})(?:\/|$)/.exec(path)?.[1];
    const fromShort = /^\/e\/(\d{6,})(?:\/|$)/.exec(path)?.[1];
    const eid = url.searchParams.get("eid");
    const id = fromSlug ?? fromShort ?? (eid && /^\d{6,}$/.test(eid) ? eid : null);
    if (!id && !/^\/e\//.test(path)) return null;
    return { platform: "eventbrite", providerEventId: id ?? null };
  }

  if (hostMatches(host, "meetup.com")) {
    const hit = /^\/[^/]+\/events\/(\d{6,})(?:\/|$)/.exec(path);
    return hit ? { platform: "meetup", providerEventId: hit[1]! } : null;
  }

  if (hostMatches(host, "posh.vip")) {
    const hit = /^\/e\/([A-Za-z0-9_-]{3,})\/?$/.exec(path);
    return hit ? { platform: "posh", providerEventId: hit[1]! } : null;
  }

  return null;
}

/**
 * The sender domains these platforms actually send from.
 *
 * Deliberately a list of exact domains rather than a substring test. "Does the sender contain
 * lu.ma" is true of `lu.ma.phish.example`, and the whole point of reading a confirmation email
 * is that we then go and fetch a link out of it.
 */
const SENDER_DOMAINS: Array<{ domain: string; platform: EventPlatform }> = [
  { domain: "lu.ma", platform: "luma" },
  { domain: "luma.com", platform: "luma" },
  { domain: "luma-mail.com", platform: "luma" },
  { domain: "partiful.com", platform: "partiful" },
  { domain: "eventbrite.com", platform: "eventbrite" },
  { domain: "order.eventbrite.com", platform: "eventbrite" },
  { domain: "meetup.com", platform: "meetup" },
  { domain: "posh.vip", platform: "posh" },
];

/** Which platform an email address belongs to, by exact domain or subdomain. */
export function platformForEmailDomain(address: string): EventPlatform | null {
  const at = address.lastIndexOf("@");
  const domain = (at >= 0 ? address.slice(at + 1) : address).trim().toLowerCase().replace(/>$/, "");
  if (!domain) return null;
  for (const rule of SENDER_DOMAINS) {
    if (hostMatches(domain, rule.domain)) return rule.platform;
  }
  return null;
}

/** Trailing punctuation a link picks up from prose, and the closing half of a wrapper. */
function trimTrailing(raw: string): string {
  let out = raw.replace(/[).,;:!?'"\]>]+$/, "");
  // Only unbalanced closers were stripped above; put one back if the link opened its own.
  const opens = (out.match(/\(/g) ?? []).length;
  const closes = (out.match(/\)/g) ?? []).length;
  if (opens > closes && raw.slice(out.length).startsWith(")")) out += ")";
  return out;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;

/**
 * Every known-platform event link in a block of text, canonicalised and deduped.
 *
 * Known platforms ONLY. A calendar invite's description is full of links — a Zoom room, a
 * map, a sponsor, an unsubscribe footer — and "the first URL in the description" would make
 * an event out of any of them. Anything the platform matcher does not recognise is not an
 * event as far as discovery is concerned.
 *
 * Personal tokens are stripped on the way through (`canonicalizeEventUrl`), so a guest token
 * from someone's own invite never reaches the database, and an order page is dropped rather
 * than stored as an event nobody else can open.
 */
export function extractEventLinks(text: string, options: { max?: number } = {}): string[] {
  const max = options.max ?? 10;
  const out: string[] = [];
  const seen = new Set<string>();
  if (!text) return out;

  for (const raw of text.match(URL_IN_TEXT) ?? []) {
    if (out.length >= max) break;
    const candidate = trimTrailing(raw);
    if (!platformOf(candidate)) continue;
    const outcome = canonicalizeEventUrl(candidate);
    if (outcome.kind !== "ok") continue;
    const href = outcome.candidates[0]!;
    // Re-checked after canonicalisation: a rewrite can move the path (Eventbrite `/x/` to
    // `/e/`), and the stored link is the one that has to be an event.
    if (!platformOf(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}
