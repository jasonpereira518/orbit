/**
 * What each platform's public page says, beyond the JSON-LD everybody publishes.
 *
 * ## The line this draws, and why it is where it is
 *
 * A public event page publishes two very different things about people. The host line-up and
 * the guests a host has chosen to FEATURE on the page are marketing: published deliberately,
 * by the host, about people who agreed to be on the bill. The full guest list is not — it is a
 * roomful of people who did not consent to appear in a stranger's CRM, and every platform's
 * terms draw the line there too.
 *
 * So this reads hosts, featured guests, and counts. It never reads a guest list, never sends a
 * cookie, never calls an internal endpoint, and never paginates anything. That rule is the
 * reason this feature can exist at all, and it is not a rule to relax quietly later.
 *
 * The counts (`guest_count`, `goingGuestCount`) are numbers a page renders to everyone. They
 * tell the user how big the room was; they name nobody.
 *
 * Pure: no network, no database, no DOM.
 */
import {
  findNode,
  linkedinUrlFrom,
  num,
  readNextData,
  str,
  xHandleFrom,
} from "@/lib/events/platforms/next-data";
import type { EventPlatform } from "@/lib/events/platforms";

/** One person a page names, with whatever identity it publishes alongside them. */
export type PagePerson = {
  name: string;
  /** The platform's own id for them (`usr-…`), where it publishes one. */
  externalRef: string | null;
  linkedinUrl: string | null;
  xHandle: string | null;
  bio: string | null;
};

export type PlatformPageData = {
  platform: EventPlatform;
  providerEventId: string | null;
  /** The people running it. Rendered as `host` roster rows. */
  hosts: PagePerson[];
  /** Guests the HOST chose to show on the page. Never a full guest list — see the header. */
  featuredGuests: PagePerson[];
  /** How many people the page says are going. A number, not people. */
  guestCount: number | null;
  organizerName: string | null;
  /** An IANA zone name, which beats the offset JSON-LD carries. */
  timezone: string | null;
  /** True when the page had platform JSON but no event in it — markup drift, worth logging. */
  zeroYield: boolean;
};

/** Both caps are hostile-input bounds; real line-ups are far smaller. */
const MAX_HOSTS = 25;
const MAX_FEATURED = 50;

export type PlatformAdapter = {
  id: EventPlatform;
  matches(hostname: string): boolean;
  /**
   * How much of the page to read.
   *
   * `__NEXT_DATA__` sits at the END of the body, so the default 512 KB — chosen when only
   * `<head>` mattered — truncates it on a page of any size, and a truncated JSON blob parses
   * as nothing at all. Raised only for hosts we know publish it.
   */
  maxBytes: number;
  parse(html: string, url: URL): PlatformPageData | null;
};

function hostMatches(hostname: string, base: string): boolean {
  return hostname === base || hostname.endsWith(`.${base}`);
}

function person(
  node: Record<string, unknown>,
  keys: { name?: string[]; id?: string[] } = {}
): PagePerson | null {
  const name =
    str(node[keys.name?.[0] ?? "name"]) ??
    str(node["full_name"]) ??
    str(node["displayName"]) ??
    str(node["username"]);
  if (!name) return null;
  return {
    name,
    externalRef: str(node[keys.id?.[0] ?? "api_id"]) ?? str(node["id"]) ?? null,
    linkedinUrl: linkedinUrlFrom(node["linkedin_handle"] ?? node["linkedin"] ?? node["linkedinUrl"]),
    xHandle: xHandleFrom(node["twitter_handle"] ?? node["twitter"] ?? node["x_handle"]),
    bio: str(node["bio_short"]) ?? str(node["bio"]) ?? null,
  };
}

function dedupePeople(people: PagePerson[], limit: number): PagePerson[] {
  const seen = new Set<string>();
  const out: PagePerson[] = [];
  for (const item of people) {
    const key = (item.externalRef ?? item.linkedinUrl ?? item.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** Luma events are `evt-…`; users are `usr-…`. Both ids are stable and public. */
const LUMA_EVENT_NODE = (node: Record<string, unknown>) =>
  typeof node.api_id === "string" && node.api_id.startsWith("evt-") && typeof node.name === "string";

const luma: PlatformAdapter = {
  id: "luma",
  matches: (host) => hostMatches(host, "lu.ma") || hostMatches(host, "luma.com"),
  maxBytes: 2_000_000,
  parse(html) {
    const data = readNextData(html);
    if (!data) return null;

    const event = findNode(data, LUMA_EVENT_NODE);
    if (!event) {
      return {
        platform: "luma",
        providerEventId: null,
        hosts: [],
        featuredGuests: [],
        guestCount: null,
        organizerName: null,
        timezone: null,
        zeroYield: true,
      };
    }

    // Hosts and featured guests are the same shape in Luma's payload and live under keys
    // whose names have been stable for years — but they are found by walking from the event
    // node rather than by path, so a wrapper appearing above them changes nothing.
    const hostsNode = findNode(data, (node) => Array.isArray(node.hosts))?.hosts;
    const featuredNode = findNode(data, (node) => Array.isArray(node.featured_guests))
      ?.featured_guests;

    const hosts = Array.isArray(hostsNode)
      ? dedupePeople(
          (hostsNode as Record<string, unknown>[])
            .map((node) => person(node))
            .filter((p): p is PagePerson => p !== null),
          MAX_HOSTS
        )
      : [];
    const featuredGuests = Array.isArray(featuredNode)
      ? dedupePeople(
          (featuredNode as Record<string, unknown>[])
            .map((node) => person(node))
            .filter((p): p is PagePerson => p !== null),
          MAX_FEATURED
        )
      : [];

    const calendar = findNode(data, (node) => typeof node.calendar === "object" && node.calendar !== null)
      ?.calendar as Record<string, unknown> | undefined;

    return {
      platform: "luma",
      providerEventId: str(event.api_id),
      hosts,
      featuredGuests,
      guestCount: num(event.guest_count) ?? num(event.ticket_count),
      organizerName: calendar ? str(calendar.name) : null,
      timezone: str(event.timezone),
      zeroYield: false,
    };
  },
};

const partiful: PlatformAdapter = {
  id: "partiful",
  matches: (host) => hostMatches(host, "partiful.com"),
  maxBytes: 2_000_000,
  parse(html, url) {
    const data = readNextData(html);
    if (!data) return null;

    const event = findNode(
      data,
      (node) =>
        typeof node.title === "string" &&
        (Array.isArray(node.hosts) || node.guestStatusCounts !== undefined)
    );
    const hostsNode = event?.hosts ?? findNode(data, (node) => Array.isArray(node.hosts))?.hosts;
    const hosts = Array.isArray(hostsNode)
      ? dedupePeople(
          (hostsNode as Record<string, unknown>[])
            .map((node) => person(node, { name: ["displayName"], id: ["id"] }))
            .filter((p): p is PagePerson => p !== null),
          MAX_HOSTS
        )
      : [];

    const counts = findNode(data, (node) => node.guestStatusCounts !== undefined)
      ?.guestStatusCounts as Record<string, unknown> | undefined;
    const going =
      num(event?.goingGuestCount) ?? (counts ? num(counts.GOING) ?? num(counts.going) : null);

    // Partiful's id IS the slug: `/e/<id>`. Read from the URL because the payload spells it
    // half a dozen different ways depending on the route.
    const idFromPath = /^\/(?:e\/)?([A-Za-z0-9_-]{4,})\/?$/.exec(url.pathname)?.[1] ?? null;

    return {
      platform: "partiful",
      providerEventId: idFromPath,
      hosts,
      featuredGuests: [],
      guestCount: going,
      organizerName: hosts[0]?.name ?? null,
      timezone: null,
      zeroYield: !event && hosts.length === 0,
    };
  },
};

const meetup: PlatformAdapter = {
  id: "meetup",
  matches: (host) => hostMatches(host, "meetup.com"),
  maxBytes: 2_000_000,
  parse(html, url) {
    const data = readNextData(html);
    if (!data) return null;

    // Meetup ships an Apollo cache: a flat map of normalised objects rather than a tree, so
    // the hosts are found by shape (`__typename: "Member"`-ish nodes referenced as hosts).
    const hostsNode = findNode(data, (node) => Array.isArray(node.eventHosts))?.eventHosts;
    const hosts = Array.isArray(hostsNode)
      ? dedupePeople(
          (hostsNode as Record<string, unknown>[])
            .map((node) => {
              const memberNode = (node.member ?? node) as Record<string, unknown>;
              return person(memberNode, { name: ["name"], id: ["id"] });
            })
            .filter((p): p is PagePerson => p !== null),
          MAX_HOSTS
        )
      : [];

    const going = findNode(data, (node) => num(node.goingCount) !== null);
    const group = findNode(
      data,
      (node) => typeof node.groupName === "string" || node.__typename === "Group"
    );

    return {
      platform: "meetup",
      providerEventId: /^\/[^/]+\/events\/(\d{6,})/.exec(url.pathname)?.[1] ?? null,
      hosts,
      featuredGuests: [],
      guestCount: going ? num(going.goingCount) : null,
      organizerName: group ? str(group.groupName) ?? str(group.name) : null,
      timezone: null,
      zeroYield: hosts.length === 0 && !going,
    };
  },
};

/**
 * Eventbrite and Posh publish no useful embedded JSON about people — the JSON-LD organizer is
 * the whole story, and `parse-page.ts` already reads it. They are listed only so the byte cap
 * and the provider id come from one place.
 */
const eventbrite: PlatformAdapter = {
  id: "eventbrite",
  matches: (host) => /(^|\.)eventbrite\.[a-z]{2,}(\.[a-z]{2,})?$/.test(host),
  maxBytes: 1_000_000,
  parse(_html, url) {
    const id =
      /-tickets-(\d{6,})(?:\/|$)/.exec(url.pathname)?.[1] ??
      /^\/e\/(\d{6,})(?:\/|$)/.exec(url.pathname)?.[1] ??
      null;
    if (!id) return null;
    return {
      platform: "eventbrite",
      providerEventId: id,
      hosts: [],
      featuredGuests: [],
      guestCount: null,
      organizerName: null,
      timezone: null,
      zeroYield: false,
    };
  },
};

const posh: PlatformAdapter = {
  id: "posh",
  matches: (host) => hostMatches(host, "posh.vip"),
  maxBytes: 1_000_000,
  parse(_html, url) {
    const id = /^\/e\/([A-Za-z0-9_-]{3,})\/?$/.exec(url.pathname)?.[1] ?? null;
    if (!id) return null;
    return {
      platform: "posh",
      providerEventId: id,
      hosts: [],
      featuredGuests: [],
      guestCount: null,
      organizerName: null,
      timezone: null,
      zeroYield: false,
    };
  },
};

const ADAPTERS: PlatformAdapter[] = [luma, partiful, meetup, eventbrite, posh];

export function adapterForHost(hostname: string): PlatformAdapter | null {
  const host = hostname.toLowerCase();
  return ADAPTERS.find((adapter) => adapter.matches(host)) ?? null;
}

/** How many bytes of a page are worth reading, given where it is. */
export function maxBytesForUrl(url: string): number | null {
  try {
    return adapterForHost(new URL(url).hostname)?.maxBytes ?? null;
  } catch {
    return null;
  }
}

/** Parse a page with its platform's adapter, if we have one. */
export function parsePlatformPage(html: string, sourceUrl: string): PlatformPageData | null {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  const adapter = adapterForHost(url.hostname);
  if (!adapter) return null;
  try {
    return adapter.parse(html, url);
  } catch {
    // Same rule as every extraction in `parse-page.ts`: a page we cannot fully read is still
    // worth the parts we can.
    return null;
  }
}
