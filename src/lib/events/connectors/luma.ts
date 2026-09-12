/**
 * Luma, as a source of events and guest lists.
 *
 * Fetch and map only — this module issues no database statement of any kind, the same
 * contract `src/lib/connectors/google-calendar.ts` holds. That is what lets it be tested
 * against recorded fixtures with no database, and it keeps the write path in exactly one
 * place (`src/lib/events/store.ts`).
 *
 * ## What this can and cannot do, and why
 *
 * A Luma API key is minted per *calendar you own* (luma.com/calendar/manage/api-keys) and
 * requires a paid Luma Plus plan. It therefore returns guest lists for events **you host**
 * and nothing else. There is no endpoint, with any credential, that returns the guest list of
 * an event you merely attended — that is Luma's design, not a gap in this client.
 *
 * So this connector is honest about its scope: everything it produces is marked
 * `role: "hosted"`, and the UI tells the user that attended events need a pasted roster. A
 * connector that quietly returned nothing for attended events would look broken instead.
 *
 * `deps` is injectable so the smoke test runs in the `pure` tier.
 */
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import type { ProviderAttendee, ProviderEvent, ProviderPage } from "@/lib/events/types";

const BASE = "https://public-api.luma.com/v1";
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

export type LumaDeps = { fetch: typeof fetch };

export class LumaAuthError extends Error {}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same ladder as `apolloFetch` in `src/lib/apollo.ts`. */
function jitteredBackoffMs(attempt: number) {
  return 300 * 2 ** attempt + Math.floor(Math.random() * 250);
}

async function lumaFetch(
  path: string,
  apiKey: string,
  params: Record<string, string | undefined>,
  deps: LumaDeps
): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await deps.fetch(url.href, {
      headers: { "x-luma-api-key": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // 401/403 means the key is wrong or the Plus plan lapsed. That is a consent problem the
    // user must fix, not a transport blip, so it must never walk the connection up the
    // backoff ladder — the caller flags `needs_reauth` instead.
    if (res.status === 401 || res.status === 403) {
      throw new LumaAuthError("Luma rejected that API key.");
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) {
      if (!res.ok) throw new Error(`Luma returned ${res.status}`);
      return res.json();
    }
    if (attempt === MAX_ATTEMPTS - 1) {
      await recordErrorEvent({
        source: ERROR_SOURCES.eventProviderSync,
        kind: "retry_exhausted",
        message: `Luma returned ${res.status} after ${MAX_ATTEMPTS} attempts`,
        context: { status: res.status, attempts: MAX_ATTEMPTS, provider: "luma" },
      });
      throw new Error(`Luma returned ${res.status}`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 8_000)
        : jitteredBackoffMs(attempt)
    );
  }
  throw new Error("Luma request failed");
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function date(value: unknown): Date | null {
  const raw = str(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type LumaEntry = { event?: Record<string, unknown> } & Record<string, unknown>;

/**
 * Map one Luma event.
 *
 * Luma nests the event under an `event` key in list responses and returns it bare from the
 * single-event endpoint, so both shapes are accepted rather than assuming one.
 */
export function toProviderEvent(entry: LumaEntry): ProviderEvent | null {
  const raw = (entry.event ?? entry) as Record<string, unknown>;
  const id = str(raw.api_id) ?? str(raw.event_api_id);
  const title = str(raw.name);
  if (!id || !title) return null;

  const geo = (raw.geo_address_info ?? {}) as Record<string, unknown>;
  return {
    providerEventId: id,
    title,
    startsAt: date(raw.start_at),
    endsAt: date(raw.end_at),
    timezone: str(raw.timezone),
    venue: str(geo.address) ?? str(geo.full_address) ?? str(raw.geo_address_visibility),
    city: str(geo.city),
    url: str(raw.url) ? `https://lu.ma/${str(raw.url)}` : null,
    description: str(raw.description) ?? str(raw.description_md),
    coverImageUrl: str(raw.cover_url),
    attendeeCount: typeof raw.guest_count === "number" ? raw.guest_count : null,
  };
}

export function toProviderAttendee(entry: Record<string, unknown>): ProviderAttendee | null {
  const guest = (entry.guest ?? entry) as Record<string, unknown>;
  const name = str(guest.name) ?? str(guest.user_name);
  const email = str(guest.email) ?? str(guest.user_email);
  if (!name && !email) return null;

  // Luma reports the RSVP state here; only people who actually turned up (or at least said
  // they would) belong on a roster of "who was in the room".
  const status = str(guest.approval_status);
  if (status === "declined") return null;

  return {
    externalRef: str(guest.api_id),
    fullName: name,
    email,
    company: null,
    title: null,
    linkedinUrl: null,
    xHandle: null,
    attendeeRole: str(guest.role) === "host" ? "host" : "attendee",
  };
}

function entriesOf(payload: unknown): Record<string, unknown>[] {
  const body = (payload ?? {}) as Record<string, unknown>;
  const list = body.entries ?? body.data ?? [];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

function nextCursor(payload: unknown): string | null {
  const body = (payload ?? {}) as Record<string, unknown>;
  return body.has_more === true ? str(body.next_cursor) : null;
}

/** One page of the connected calendar's events. */
export async function listCalendarEvents(
  apiKey: string,
  cursor: string | null,
  deps: LumaDeps = { fetch }
): Promise<ProviderPage<ProviderEvent>> {
  const payload = await lumaFetch(
    "/calendar/list-events",
    apiKey,
    { pagination_cursor: cursor ?? undefined, pagination_limit: "50" },
    deps
  );
  return {
    items: entriesOf(payload)
      .map(toProviderEvent)
      .filter((e): e is ProviderEvent => e !== null),
    nextCursor: nextCursor(payload),
  };
}

/** One page of an event's guest list. Hosted events only — see the header. */
export async function listEventGuests(
  apiKey: string,
  eventApiId: string,
  cursor: string | null,
  deps: LumaDeps = { fetch }
): Promise<ProviderPage<ProviderAttendee>> {
  const payload = await lumaFetch(
    "/event/get-guests",
    apiKey,
    { event_api_id: eventApiId, pagination_cursor: cursor ?? undefined, pagination_limit: "100" },
    deps
  );
  return {
    items: entriesOf(payload)
      .map(toProviderAttendee)
      .filter((a): a is ProviderAttendee => a !== null),
    nextCursor: nextCursor(payload),
  };
}
