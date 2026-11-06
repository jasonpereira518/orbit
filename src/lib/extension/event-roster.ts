/**
 * Save the guest list the user has open on a Luma or Partiful event page.
 *
 * ## Where the line is
 *
 * The server never reads a guest list (`src/lib/events/platforms/adapters.ts` says why). This
 * is the one way one reaches Orbit: the user opens it in their own signed-in session, clicks
 * the Orbit icon, and presses Save. What arrives is names and the platform's profile links —
 * no emails, no internal API, nothing paginated behind their back — and every row lands on
 * the event as a guest. None becomes a contact; that is a per-guest click on the event page.
 */
import type { EventRosterResponse, PageContext } from "@/lib/extension/contract";
import { ExtensionRouteError } from "@/lib/extension/http";
import { canonicalizeEventUrl } from "@/lib/events/canonical-url";
import { findOrCreateEventByLink } from "@/lib/events/discovery/record";
import { attendeeIdentityKey } from "@/lib/events/identity";
import { platformOf } from "@/lib/events/platforms";
import type { ParsedAttendee } from "@/lib/events/parse-roster";
import { upsertEventAttendees } from "@/lib/events/store";
import { UNTITLED_EVENT } from "@/lib/events/types";
import { requireReleasedSurface, SurfaceHiddenError } from "@/lib/surface-visibility";

export async function saveEventRoster(userId: string, page: PageContext): Promise<EventRosterResponse> {
  const guests = page.roster?.guests ?? [];
  if (guests.length === 0) {
    throw new ExtensionRouteError("invalid_request", "Open the event's guest list first, then save it.");
  }
  // The link names the event, so it has to be the event: a canonical Luma/Partiful URL whose
  // platform is the one the adapter claimed to read.
  const outcome = canonicalizeEventUrl(page.url);
  const url = outcome.kind === "ok" ? outcome.candidates[0]! : null;
  if (!url || (page.site !== "luma" && page.site !== "partiful") || platformOf(url)?.platform !== page.site) {
    throw new ExtensionRouteError("invalid_request", "That isn’t a Luma or Partiful event page.");
  }
  try {
    await requireReleasedSurface(userId, "page.events");
  } catch (error) {
    if (error instanceof SurfaceHiddenError) {
      throw new ExtensionRouteError("not_found", "Events aren’t available on your account yet.");
    }
    throw error;
  }

  const found = await findOrCreateEventByLink(
    userId,
    { title: page.roster?.title.trim() || UNTITLED_EVENT, url },
    "extension"
  );

  // One row per person: a name listed twice (the avatar strip and the full list) would make
  // the single INSERT … ON CONFLICT touch one row twice, which Postgres refuses.
  const byKey = new Map<string, ParsedAttendee>();
  for (const guest of guests) {
    const fullName = guest.name.trim().replace(/\s+/g, " ");
    const identityKey = attendeeIdentityKey({ fullName });
    if (!identityKey || byKey.has(identityKey)) continue;
    byKey.set(identityKey, {
      fullName,
      email: null,
      company: null,
      title: null,
      linkedinUrl: null,
      xHandle: null,
      // The platform's profile link (`luma.com/user/usr-…`) is the stablest handle the page
      // gives; kept for a later re-read to recognise the person by, never shown as theirs.
      externalRef: guest.profileUrl?.slice(0, 500) ?? null,
      identityKey,
    });
  }
  const saved = await upsertEventAttendees(userId, found.id, [...byKey.values()], "extension");
  return { eventId: found.id, saved, existingEvent: found.existing };
}
