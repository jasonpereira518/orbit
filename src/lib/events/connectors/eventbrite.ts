/**
 * Eventbrite, as a source of events and attendee lists.
 *
 * Fetch and map only — no database statement anywhere in this module, so it is testable
 * against fixtures with no database. Same contract as `luma.ts` and
 * `src/lib/connectors/google-calendar.ts`.
 *
 * ## Organiser scope, and what that means
 *
 * `/v3/events/{id}/attendees/` requires the token to own the event's organisation. So, as
 * with Luma, this returns attendee lists for events **you organised** and nothing else. A
 * ticket you bought gives you no API access to who else was there. Everything produced here
 * is therefore marked `role: "hosted"`.
 *
 * Note also that Eventbrite removed public event *search* in 2020, so there is no discovery
 * path either — only the organisations the token can already see.
 *
 * ## Pagination
 *
 * Eventbrite pages with a `continuation` token inside a `pagination` object, and signals the
 * end with `has_more_items: false`. Reading `page_number`/`page_count` instead is the common
 * mistake: those are absent on continuation-based endpoints, and treating a missing page
 * count as "one page" silently truncates every list past the first 50.
 */
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import type { ProviderAttendee, ProviderEvent, ProviderPage } from "@/lib/events/types";

const BASE = "https://www.eventbriteapi.com/v3";
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

export type EventbriteDeps = { fetch: typeof fetch };

export class EventbriteAuthError extends Error {}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoffMs(attempt: number) {
  return 300 * 2 ** attempt + Math.floor(Math.random() * 250);
}

async function eventbriteFetch(
  path: string,
  token: string,
  params: Record<string, string | undefined>,
  deps: EventbriteDeps
): Promise<Record<string, unknown>> {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await deps.fetch(url.href, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // A revoked or expired token is a consent problem, not a transport one — it must not
    // walk the connection up the backoff ladder.
    if (res.status === 401 || res.status === 403) {
      throw new EventbriteAuthError("Eventbrite rejected that connection.");
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) {
      if (!res.ok) throw new Error(`Eventbrite returned ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    }
    if (attempt === MAX_ATTEMPTS - 1) {
      await recordErrorEvent({
        source: ERROR_SOURCES.eventProviderSync,
        kind: "retry_exhausted",
        message: `Eventbrite returned ${res.status} after ${MAX_ATTEMPTS} attempts`,
        context: { status: res.status, attempts: MAX_ATTEMPTS, provider: "eventbrite" },
      });
      throw new Error(`Eventbrite returned ${res.status}`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 8_000)
        : jitteredBackoffMs(attempt)
    );
  }
  throw new Error("Eventbrite request failed");
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Eventbrite wraps most text as `{ text, html }` and dates as `{ utc, timezone, local }`. */
function textOf(value: unknown): string | null {
  if (typeof value === "string") return str(value);
  if (value && typeof value === "object") return str((value as Record<string, unknown>).text);
  return null;
}

function utcDate(value: unknown): Date | null {
  if (!value || typeof value !== "object") return null;
  const raw = str((value as Record<string, unknown>).utc);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function toProviderEvent(raw: Record<string, unknown>): ProviderEvent | null {
  const id = str(raw.id);
  const title = textOf(raw.name);
  if (!id || !title) return null;

  const venue = (raw.venue ?? null) as Record<string, unknown> | null;
  const address = (venue?.address ?? null) as Record<string, unknown> | null;
  const logo = (raw.logo ?? null) as Record<string, unknown> | null;
  const original = (logo?.original ?? null) as Record<string, unknown> | null;
  const start = raw.start as Record<string, unknown> | undefined;

  return {
    providerEventId: id,
    title,
    startsAt: utcDate(raw.start),
    endsAt: utcDate(raw.end),
    timezone: start ? str(start.timezone) : null,
    venue: venue ? str(venue.name) : null,
    city: address ? str(address.city) : null,
    url: str(raw.url),
    description: textOf(raw.description),
    // `logo.original.url` is the full-size graphic; `logo.url` is a thumbnail. The hero wants
    // the former, so prefer it and fall back rather than always taking the small one.
    coverImageUrl: (original ? str(original.url) : null) ?? (logo ? str(logo.url) : null),
    attendeeCount: null,
  };
}

export function toProviderAttendee(raw: Record<string, unknown>): ProviderAttendee | null {
  // A refunded or cancelled order is not someone who was in the room.
  if (raw.cancelled === true || raw.refunded === true) return null;

  const profile = (raw.profile ?? {}) as Record<string, unknown>;
  const name = str(profile.name);
  const email = str(profile.email);
  if (!name && !email) return null;

  return {
    externalRef: str(raw.id),
    fullName: name,
    email,
    company: str(profile.company),
    title: str(profile.job_title),
    linkedinUrl: null,
    xHandle: null,
    attendeeRole: "attendee",
  };
}

function pagination(payload: Record<string, unknown>): string | null {
  const page = (payload.pagination ?? {}) as Record<string, unknown>;
  return page.has_more_items === true ? str(page.continuation) : null;
}

/** The organisations this token can act for. The first is used as the connection's account. */
export async function listOrganizations(
  token: string,
  deps: EventbriteDeps = { fetch }
): Promise<Array<{ id: string; name: string | null }>> {
  const payload = await eventbriteFetch("/users/me/organizations/", token, {}, deps);
  const list = Array.isArray(payload.organizations) ? payload.organizations : [];
  return (list as Record<string, unknown>[])
    .map((o) => ({ id: str(o.id) ?? "", name: str(o.name) }))
    .filter((o) => o.id !== "");
}

export async function listOrganizationEvents(
  token: string,
  organizationId: string,
  cursor: string | null,
  deps: EventbriteDeps = { fetch }
): Promise<ProviderPage<ProviderEvent>> {
  const payload = await eventbriteFetch(
    `/organizations/${organizationId}/events/`,
    token,
    { continuation: cursor ?? undefined, expand: "venue,logo", order_by: "start_desc" },
    deps
  );
  const list = Array.isArray(payload.events) ? payload.events : [];
  return {
    items: (list as Record<string, unknown>[])
      .map(toProviderEvent)
      .filter((e): e is ProviderEvent => e !== null),
    nextCursor: pagination(payload),
  };
}

/** One page of an event's attendees. Organiser scope only — see the header. */
export async function listEventAttendees(
  token: string,
  eventId: string,
  cursor: string | null,
  deps: EventbriteDeps = { fetch }
): Promise<ProviderPage<ProviderAttendee>> {
  const payload = await eventbriteFetch(
    `/events/${eventId}/attendees/`,
    token,
    { continuation: cursor ?? undefined },
    deps
  );
  const list = Array.isArray(payload.attendees) ? payload.attendees : [];
  return {
    items: (list as Record<string, unknown>[])
      .map(toProviderAttendee)
      .filter((a): a is ProviderAttendee => a !== null),
    nextCursor: pagination(payload),
  };
}
