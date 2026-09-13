/**
 * Reading a public event page into the event row.
 *
 * This was `enrichEventInternal` inside `src/actions/events.ts`. It moved because the
 * background enrichment queue has to call it: a discovered event arrives as a bare link, and
 * the sync pass — a cron POST with no request, no cookies and no router — is what turns that
 * link into a title, a date, a venue and a cover. A `"use server"` module cannot be imported
 * from there (`after` and `revalidatePath` both need a request), and a second copy of this
 * logic would be a second answer to "what does a refresh overwrite".
 *
 * So the rule is the usual one: the lib does the work and reports what changed, and whichever
 * caller has a request decides what to revalidate. `restamped` exists for exactly that — the
 * action turns a non-zero count into `revalidatePath("/contacts")`, and the cron ignores it.
 *
 * No `next/*` imports, for the reason `store.ts` records: importing `next/server` alone
 * retains the Node event loop and hangs any `tsx` script, and the smoke scripts load this.
 */
import { persistEventCover } from "@/lib/events/cover";
import { EventPageError, type FetchPageDeps } from "@/lib/events/guarded-fetch";
import { fetchEventPage } from "@/lib/events/fetch-page";
import { restampEventInteractions } from "@/lib/events/connect";
import { resolveField } from "@/lib/events/resync";
import {
  peopleToAttendees,
  speakersNotOnRoster,
  speakersToAttendees,
} from "@/lib/events/parse-roster";
import { claimEventAliases } from "@/lib/events/discovery/record";
import {
  getEventForUser,
  listRosterForUser,
  updateEventForUser,
  upsertEventAttendees,
} from "@/lib/events/store";
import { resolveThemeColor } from "@/lib/events/theme";
import { resolveEventTitle } from "@/lib/events/types";

/**
 * `fill` only completes blanks, which is right for a first read and useless afterwards.
 * `replace` lets the page win, which is what a resync is for — see `resync.ts`.
 */
export type EnrichMode = "fill" | "replace";

export type EnrichResult = {
  ok: boolean;
  error?: string;
  /** Interactions re-stamped from the event's new title/date. Zero unless a field moved. */
  restamped: number;
};

export async function enrichEvent(
  userId: string,
  eventId: string,
  url: string,
  options: { mode?: EnrichMode; deps?: FetchPageDeps } = {}
): Promise<EnrichResult> {
  const mode = options.mode ?? "fill";
  try {
    const details = await fetchEventPage(url, options.deps ?? { fetch });
    const theme = resolveThemeColor({
      metaColor: details.themeColor,
      seed: new URL(details.canonicalUrl ?? url).host,
    });

    let coverImageUrl: string | null = null;
    let coverSourceUrl: string | null = null;
    if (details.imageUrl) {
      const cover = await persistEventCover(eventId, details.imageUrl);
      coverImageUrl = cover?.url ?? null;
      coverSourceUrl = cover?.sourceUrl ?? null;
    }

    const existing = await getEventForUser(userId, eventId);
    // `fill` keeps whatever is already stored; `replace` lets the page win — but neither ever
    // CLEARS a field the page simply did not mention, which is what `resolveField` encodes.
    // A host reshuffling their markup must not blank the venue on every event it produced.
    const take = <T>(fetched: T | null, current: T | null): T | null =>
      mode === "replace" ? resolveField(fetched, current) : current ?? fetched;

    await updateEventForUser(userId, eventId, {
      // The untitled placeholder counts as blank in both modes. See `resolveEventTitle`.
      title:
        mode === "replace"
          ? details.title?.trim() || resolveEventTitle(existing?.title, details.title)
          : resolveEventTitle(existing?.title, details.title),
      startsAt: take(details.startsAt, existing?.startsAt ?? null),
      endsAt: take(details.endsAt, existing?.endsAt ?? null),
      timezone: take(details.timezone, existing?.timezone ?? null),
      venue: take(details.venue, existing?.venue ?? null),
      city: take(details.city, existing?.city ?? null),
      description: take(details.description, existing?.description ?? null),
      organizerName: take(details.organizerName, existing?.organizerName ?? null),
      organizerUrl: take(details.organizerUrl, existing?.organizerUrl ?? null),
      attendanceMode: take(details.attendanceMode, existing?.attendanceMode ?? null),
      // The host's own count, which is usually larger than the roster and legitimately so:
      // it is how many people were in the room, not how many we know the names of.
      attendeeCount: take(details.guestCount, existing?.attendeeCount ?? null),
      url: details.canonicalUrl ?? url,
      source: "page",
      // Only overwrite the cover when this read actually produced one, or a page that briefly
      // stops serving `og:image` would strip the artwork off the event.
      ...(coverImageUrl ? { coverImageUrl, coverSourceUrl } : {}),
      // A locked theme is the user's explicit choice and is never overwritten.
      ...(existing?.themeLocked === 1
        ? {}
        : { themeColor: theme.color, themeSource: theme.source }),
      enrichedAt: new Date(),
      enrichError: null,
    });

    // Enrichment can change the title and date too — most visibly when it replaces the
    // untitled placeholder — so the interactions written from this event follow along.
    const restamped = await restampFromEvent(userId, eventId, existing ?? null);

    // Everyone the page itself names, as unconfirmed roster rows tagged `page`.
    //
    // Three kinds, and they are all the same kind of fact: a host advertising their own event.
    // Billed speakers (JSON-LD `performer`), the hosts, and the guests a host chose to FEATURE
    // on the page. None of them is a guest list — see the header of `platforms/adapters.ts`
    // for where that line is and why it is there.
    //
    // Deliberately NOT ingested: `connectAttendees` is still the only path to a contact, and
    // it still needs a human. This only puts names on the roster to confirm or delete.
    const fromPage = [
      ...speakersToAttendees(details.speakers),
      ...peopleToAttendees(details.hosts, "host", details.platform),
      ...peopleToAttendees(details.featuredGuests, "attendee", details.platform),
    ];
    if (fromPage.length > 0) {
      // Filtered against who is already listed, or refreshing would re-add a name-only row
      // for every person whose roster entry the user has since corrected. See
      // `speakersNotOnRoster` for why a name comparison is the right tool here specifically.
      const roster = await listRosterForUser(userId, eventId);
      const fresh = speakersNotOnRoster(fromPage, roster.map((r) => r.fullName));
      if (fresh.length > 0) await upsertEventAttendees(userId, eventId, fresh, "page");
    }

    // The platform's own id for this event, recorded as an alias rather than written to
    // `events.provider_event_id` — the partial unique index there belongs to the host-API
    // sync, and two rows claiming one provider id is a constraint violation, not a merge.
    if (details.platform && details.providerEventId) {
      await claimEventAliases(
        userId,
        eventId,
        [{ kind: "provider", value: `${details.platform}:${details.providerEventId}` }],
        "page"
      ).catch(() => {});
    }
    return { ok: true, restamped };
  } catch (error) {
    const message =
      error instanceof EventPageError ? error.message : "That page could not be read.";
    await updateEventForUser(userId, eventId, {
      enrichedAt: new Date(),
      enrichError: message,
    });
    return { ok: false, error: message, restamped: 0 };
  }
}

/**
 * Re-derive this event's interactions after its details changed.
 *
 * Never allowed to fail the enrichment that triggered it: the row is already written, and a
 * restamp failure means some notes are stale, not that the read should be reported as failed.
 */
async function restampFromEvent(
  userId: string,
  eventId: string,
  before: Awaited<ReturnType<typeof getEventForUser>>
): Promise<number> {
  if (!before) return 0;
  try {
    const after = await getEventForUser(userId, eventId);
    if (!after) return 0;
    return await restampEventInteractions(userId, before, after);
  } catch {
    // Deliberately swallowed — see above.
    return 0;
  }
}
