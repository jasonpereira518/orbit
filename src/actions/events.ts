"use server";

import { recordAccountAudit } from "@/lib/account-audit";
/**
 * Server actions for the events surface.
 *
 * Every export is an async function, per the house rule — non-async helpers would fail the
 * "use server" contract, which is why shared logic lives in `src/lib/events/*` instead.
 *
 * Every action re-asserts auth itself. Layouts do not re-run for server-action POSTs, and
 * actions are reachable by direct POST, so a check anywhere else is not a check.
 */
import { cookies } from "next/headers";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireSyncUser, requireUserForReleasedSurface } from "@/lib/plan-guards";
import { requireReleasedSurface } from "@/lib/surface-visibility";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { fetchEventPage, EventPageError } from "@/lib/events/fetch-page";
import { canonicalEventUrlOrRefuse } from "@/lib/events/event-url-input";
import { enrichEvent } from "@/lib/events/enrich";
import { IcsFeedGoneError, syncIcsFeed } from "@/lib/events/discovery/from-ics-feed";
import {
  dismissEventForUser,
  restoreEventForUser,
  tombstoneAliasesForEvent,
} from "@/lib/events/discovery/aliases";
import { findOrCreateEventByLink } from "@/lib/events/discovery/record";
import {
  eventsTogetherForRoster,
  listEventsTogetherForContact,
  listRepeatCoAttendees,
  type EventTogether,
  type RepeatPerson,
} from "@/lib/events/people-store";
import { loadSelfIdentity } from "@/lib/events/self";
import {
  dismissEventCompany,
  loadEventCompanyPanel,
  upsertEventCompanies,
  type EventCompanyRow,
} from "@/lib/events/companies";
import { parseCompanyList } from "@/lib/events/company-list-parse";
import { addTargetCompany } from "@/lib/events/target-companies";
import { whoToTalkTo, type WhoToTalkTo } from "@/lib/events/who-to-talk-to";
import { explainAttendeeForUser } from "@/lib/events/explain";
import { userCanUseAi } from "@/lib/ai";
import { getAiAccessStatus } from "@/lib/ai-access";
import { refusalCopyFor } from "@/lib/ai-access-copy";
import { diffEventAgainstPage, type EventFieldChange } from "@/lib/events/resync";
import { parseRosterCsv, parseRosterText } from "@/lib/events/parse-roster";
import {
  deleteEventForUser,
  getEventForUser,
  listEventsForUser,
  listRosterForUser,
  setSpokeToForUser,
  unlinkAttendeeForUser,
  updateEventForUser,
  updateAttendeeForUser,
  deleteAttendeeForUser,
  upsertEventAttendees,
  type CreateEventInput,
  type EventListRow,
  type UpdateAttendeeResult,
} from "@/lib/events/store";
import {
  connectAttendees,
  previewConnect,
  restampEventInteractions,
  type ConnectPreviewRow,
} from "@/lib/events/connect";
import {
  deleteEventConnection,
  findGmailGrant,
  listEventConnections,
  upsertEventConnection,
  type EventConnectionSummary,
} from "@/lib/events/connections";
import { buildEventbriteAuthUrl, eventbriteOAuthConfig } from "@/lib/events/connectors/eventbrite-oauth";
import { LumaAuthError, listCalendarEvents } from "@/lib/events/connectors/luma";
import { isDemoWorkspace } from "@/lib/demo-workspace";
import type {
  AttendeeRole,
  ConnectSummary,
  EventConnectionProvider,
  RosterRow,
} from "@/lib/events/types";
import type { EventRecord } from "@/db/schema";
import { ActionResult, asActionResult, UserFacingError } from "@/lib/errors";
import { GOOGLE_SCOPES, hasGmailReadScope, hasScope } from "@/lib/google-scopes";
import { actionFailure } from "@/lib/action-failure";
import { optionalClientDate } from "@/lib/input/dates";
import { z } from "zod";
import { anyNumber, uuid, optionalClientDateField } from "@/lib/input/schemas";
import { defineAction, failResult } from "@/lib/input/action";

const OAUTH_STATE_COOKIE = "orbit_eventbrite_oauth_state";
const SURFACE = "page.events";

function revalidateEvents(eventId?: string) {
  revalidatePath("/events");
  if (eventId) revalidatePath(`/events/${eventId}`);
}

/** The events page's two tabs, read together: one auth check, two queries in parallel. */
export const listEventsByTab = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE) },
  async (userId): Promise<{
    upcoming: EventListRow[];
    past: EventListRow[];
  }> => {
    const now = new Date();
    const [upcoming, past] = await Promise.all([
      listEventsForUser(userId, 100, { when: "upcoming", now }),
      listEventsForUser(userId, 100, { when: "past", now }),
    ]);
    return { upcoming, past };
  }
);

/** Everything the user has said "not mine" to, so a mistake is one click from undone. */
export const listHiddenEvents = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE) },
  async (userId): Promise<EventListRow[]> => {
    return listEventsForUser(userId, 100, { hidden: true });
  }
);

/**
 * The people the user keeps running into.
 *
 * Name-only clusters are excluded unless asked for: two different David Kims at two meetups
 * are not a pattern, and a panel that claims they are is worse than an empty one.
 */
export const getRepeatCoAttendees = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([z.looseObject({ limit: anyNumber.optional(), includeWeak: z.boolean().optional() }).optional()]) },
  async (userId, options?: {
    limit?: number;
    includeWeak?: boolean;
  }): Promise<RepeatPerson[]> => {
    const self = await loadSelfIdentity(userId);
    return listRepeatCoAttendees(userId, {
      limit: options?.limit ?? 8,
      includeWeak: options?.includeWeak ?? false,
      // The user is on every one of their own rosters; without this they are the top result.
      selfKeys: self.keyStrings,
    });
  }
);

/** Every event a contact shares with the user. Rendered on the contact page. */
export const getEventsWithContact = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid]) },
  async (userId, contactId: string): Promise<EventTogether[]> => {
    return listEventsTogetherForContact(userId, contactId);
  }
);

export const getEvent = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid]) },
  async (userId, eventId: string): Promise<EventRecord | null> => {
    return getEventForUser(userId, eventId);
  }
);

export const getRoster = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid]) },
  async (userId, eventId: string): Promise<RosterRow[]> => {
    return listRosterForUser(userId, eventId);
  }
);

/**
 * How many events each person on this roster has shared with the user.
 *
 * A separate read from the roster itself so the badge can stream in without holding up the
 * list — it is an aggregate over the user's whole history, and the names matter more.
 */
export const getRosterHistory = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid]) },
  async (userId, eventId: string): Promise<Array<{ attendeeId: string; eventsTogether: number }>> => {
    const history = await eventsTogetherForRoster(userId, eventId);
    return [...history.entries()]
      .filter(([, value]) => value.count > 1)
      .map(([attendeeId, value]) => ({ attendeeId, eventsTogether: value.count }));
  }
);

export const createEvent = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([z.looseObject({ title: z.string(), startsAt: optionalClientDateField("start time"), venue: z.string().nullish(), city: z.string().nullish(), url: z.string().nullish(), role: z.enum(["attended", "hosted"]).optional(), notes: z.string().nullish() })]), invalid: failResult, onGateError: (err) => asActionResult(() => Promise.reject(err)) },
  async (userId, input: {
    title: string;
    startsAt?: string | null;
    venue?: string | null;
    city?: string | null;
    url?: string | null;
    role?: "attended" | "hosted";
    notes?: string | null;
  }): Promise<ActionResult<{ id: string; existing?: boolean }>> => {
    return asActionResult(async () => {
      const title = input.title.trim();
      if (!title) throw new UserFacingError("Give the event a name first");

      // Cleaned before the row is written, not just before it is fetched. Enrichment can fail —
      // the host is down, the link needs a login — and the pasted URL would otherwise persist
      // with the user's own Luma guest token in it, rendered back as a link on the event page.
      // A link that cannot be canonicalised is refused rather than stored as typed (audit
      // L-02): the raw fallback is how a `javascript:` or private-network URL reached the
      // event page's link.
      const url = canonicalEventUrlOrRefuse(input.url);

      // Already here? Discovery may have added this event days ago, and a user pasting its link
      // means "show me this", not "make me a second one". Taking them to the row they already
      // have is also how they find the roster they have already built on it.
      const found = await findOrCreateEventByLink(
        userId,
        {
          title,
          startsAt: optionalClientDate(input.startsAt, "start time"),
          venue: input.venue ?? null,
          city: input.city ?? null,
          url,
          role: input.role ?? "attended",
          notes: input.notes ?? null,
        },
        "manual"
      );
      if (found.existing) {
        revalidateEvents(found.id);
        return { id: found.id, existing: true };
      }
      const event = { id: found.id };

      if (url && input.url) {
        // Off the request path: the user should land on their event, not wait on someone
        // else's web server. `enrich_status` on the row is how the UI shows this is in flight.
        after(() => enrichEvent(userId, event.id, input.url!).catch(() => {}));
      }
      revalidateEvents();
      return { id: event.id };
    });
  }
);

/**
 * Pull details from a public event page.
 *
 * Rate-limited per user because it makes an outbound request to an address the user chose:
 * without a bucket this action is an open proxy for scanning, and the SSRF guard stops it
 * reaching anything internal but does not stop the volume.
 */
export const enrichEventFromUrl = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, z.string()]), invalid: failResult },
  async (userId, eventId: string, url: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await consumeBucket("eventEnrich", userId, RATE_LIMITS.eventEnrich);
    } catch (error) {
      if (isRateLimitedError(error)) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
    const result = await enrichEvent(userId, eventId, url);
    if (result.restamped > 0) revalidatePath("/contacts");
    revalidateEvents(eventId);
    return result;
  }
);

const EVENT_TEXT_MAX = 10_000;
const EVENT_ATTENDANCE_MODES = ["offline", "online", "mixed"] as const;
const EVENT_ROLES = ["attended", "hosted"] as const;

/**
 * The fields an edit may change, copied one by one and type-checked.
 *
 * Never spread the argument: this is a public POST endpoint, and `updateEventForUser`'s
 * `.set()` writes any key that names a real column — `userId` included, which moved an
 * event (with a phishing link or a tracking cover) into someone else's account.
 */
function pickEventEdits(patch: Record<string, unknown>) {
  const text = (key: string, nullable = true): string | null | undefined => {
    const value = patch[key];
    if (value === undefined) return undefined;
    if (value === null && nullable) return null;
    if (typeof value !== "string") throw new UserFacingError(`Invalid ${key}`);
    return value.slice(0, EVENT_TEXT_MAX);
  };
  const out: Partial<Record<string, unknown>> = {};
  const title = text("title", false);
  if (title !== undefined) out.title = title;
  for (const key of ["venue", "city", "description", "organizerName", "organizerUrl", "notes"]) {
    const value = text(key);
    if (value !== undefined) out[key] = value;
  }
  if (patch.attendanceMode !== undefined) {
    const mode = patch.attendanceMode;
    if (mode !== null && !EVENT_ATTENDANCE_MODES.includes(mode as never)) {
      throw new UserFacingError("Invalid attendance mode");
    }
    out.attendanceMode = mode;
  }
  if (patch.role !== undefined) {
    if (!EVENT_ROLES.includes(patch.role as never)) throw new UserFacingError("Invalid role");
    out.role = patch.role;
  }
  return out as Pick<
    CreateEventInput,
    "title" | "venue" | "city" | "description" | "organizerName" | "organizerUrl" | "notes" | "attendanceMode" | "role"
  >;
}

/**
 * Edit an event by hand.
 *
 * Dates arrive as ISO instants already converted from the venue's wall clock by
 * `wall-clock.ts` — deliberately NOT as the raw `datetime-local` string, which carries no
 * zone and would be read here in the server's.
 */
export const updateEvent = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, z.looseObject({ title: z.string().optional(), startsAt: optionalClientDateField("event time"), endsAt: optionalClientDateField("event time"), venue: z.string().nullish(), city: z.string().nullish(), url: z.string().nullish(), description: z.string().nullish(), organizerName: z.string().nullish(), organizerUrl: z.string().nullish(), attendanceMode: z.enum(["offline", "online", "mixed"]).nullish(), notes: z.string().nullish(), role: z.enum(["attended", "hosted"]).optional() })]) },
  async (userId, eventId: string, patch: {
      title?: string;
      startsAt?: string | null;
      endsAt?: string | null;
      venue?: string | null;
      city?: string | null;
      url?: string | null;
      description?: string | null;
      organizerName?: string | null;
      organizerUrl?: string | null;
      attendanceMode?: "offline" | "online" | "mixed" | null;
      notes?: string | null;
      role?: "attended" | "hosted";
    }): Promise<void> => {
    // Read before and after so the interactions already written from this event can be brought
    // back in step — the note and date they carry are derived from exactly these fields.
    const before = await getEventForUser(userId, eventId);

    // A link pasted here goes through the same cleaning as one pasted into "Add event",
    // or editing would be a way to put a personal ticket token back into the database.
    // Same refusal as "Add event" (audit L-02): a link that does not canonicalise is not stored.
    const url = patch.url === undefined ? undefined : canonicalEventUrlOrRefuse(patch.url);

    const asDate = (value: string | null | undefined) =>
      value === undefined ? undefined : optionalClientDate(value, "event time");

    await updateEventForUser(userId, eventId, {
      ...pickEventEdits(patch as Record<string, unknown>),
      ...(url === undefined ? {} : { url: url || null }),
      startsAt: asDate(patch.startsAt),
      endsAt: asDate(patch.endsAt),
    });
    await restampFromEvent(userId, eventId, before);
    revalidateEvents(eventId);
  }
);

/**
 * What a resync would change, without changing it.
 *
 * Rate-limited on the same bucket as enrichment: it is the same outbound request to a
 * user-chosen address, and a preview that were free would make the bucket meaningless.
 */
export const previewResync = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid]), invalid: failResult },
  async (userId, eventId: string): Promise<{ ok: true; changes: EventFieldChange[] } | { ok: false; error: string }> => {
    const event = await getEventForUser(userId, eventId);
    if (!event) return { ok: false, error: "That event no longer exists" };
    if (!event.url) return { ok: false, error: "This event has no link to refresh from" };

    try {
      await consumeBucket("eventEnrich", userId, RATE_LIMITS.eventEnrich);
    } catch (error) {
      if (isRateLimitedError(error)) {
        return { ok: false, error: "Too many lookups just now — try again in a few minutes" };
      }
      throw error;
    }

    try {
      const details = await fetchEventPage(event.url);
      return { ok: true, changes: diffEventAgainstPage(event, details) };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof EventPageError
            ? error.message
            : await actionFailure(error, "Couldn’t read that page — try again?", "events.preview-resync"),
      };
    }
  }
);

/**
 * Apply the refresh.
 *
 * Fetches again rather than trusting values round-tripped through the client: this writes to
 * the database, and a preview's output arriving back from a browser is not evidence of what
 * the page says. The cost is a second request; the alternative is letting the client dictate
 * the contents of a row.
 */
export const resyncEvent = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid]), invalid: failResult },
  async (userId, eventId: string): Promise<{ ok: boolean; error?: string }> => {
    const event = await getEventForUser(userId, eventId);
    if (!event) return { ok: false, error: "That event no longer exists" };
    if (!event.url) return { ok: false, error: "This event has no link to refresh from" };

    try {
      await consumeBucket("eventEnrich", userId, RATE_LIMITS.eventEnrich);
    } catch (error) {
      if (isRateLimitedError(error)) {
        return { ok: false, error: "Too many lookups just now — try again in a few minutes" };
      }
      throw error;
    }

    const result = await enrichEvent(userId, eventId, event.url, { mode: "replace" });
    if (result.restamped > 0) revalidatePath("/contacts");
    revalidateEvents(eventId);
    return result;
  }
);

/**
 * Re-derive this event's interactions after its details changed.
 *
 * Never allowed to fail the edit that triggered it: the user's change is already committed,
 * and a restamp failure means some notes are stale, not that the edit should be undone.
 */
async function restampFromEvent(
  userId: string,
  eventId: string,
  before: EventRecord | null
): Promise<void> {
  if (!before) return;
  try {
    const after = await getEventForUser(userId, eventId);
    if (!after) return;
    const touched = await restampEventInteractions(userId, before, after);
    if (touched > 0) revalidatePath("/contacts");
  } catch {
    // Deliberately swallowed — see above.
  }
}

export const deleteEvent = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid]) },
  async (userId, eventId: string): Promise<void> => {
    // Before the delete, not after: the FK would null these anyway, but a discovery pass
    // running in the gap could otherwise re-create the event from the very keys we are about
    // to orphan — and it would come back with the same link, minutes later, looking like a bug.
    await tombstoneAliasesForEvent(userId, eventId).catch(() => {});
    await deleteEventForUser(userId, eventId);
    revalidateEvents();
  }
);

/**
 * "Not mine" — hide an event discovery added.
 *
 * Hidden rather than deleted, because the user may have connected people from it already and
 * a mis-click must not take their work with it. The keys stay behind pointing at this row,
 * which is what stops the next sync of the same calendar adding it straight back.
 */
export const dismissEvent = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid]) },
  async (userId, eventId: string): Promise<void> => {
    await dismissEventForUser(userId, eventId);
    revalidateEvents(eventId);
  }
);

export const restoreEvent = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid]) },
  async (userId, eventId: string): Promise<void> => {
    await restoreEventForUser(userId, eventId);
    revalidateEvents(eventId);
  }
);

/** The dominant cover colour, sampled in the browser. Ignored once the user picks their own. */
export const setEventThemeColor = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, z.string(), z.enum(["manual", "image"])]) },
  async (userId, eventId: string, color: string, source: "image" | "manual"): Promise<void> => {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    const existing = await getEventForUser(userId, eventId);
    if (!existing) return;
    // A probe must never overwrite a colour the user chose, or the hero would flicker back
    // every time the hero image reloads.
    if (existing.themeLocked === 1 && source === "image") return;
    await updateEventForUser(userId, eventId, {
      themeColor: color.toLowerCase(),
      themeSource: source === "manual" ? "meta" : "image",
      themeLocked: source === "manual" ? 1 : 0,
    });
    revalidateEvents(eventId);
  }
);

export const importAttendeesFromText = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, z.string(), z.enum(["paste", "screenshot"]).optional()]) },
  async (userId, eventId: string, text: string, kind: "paste" | "screenshot" = "paste"): Promise<{ added: number; skipped: number; deduped: number }> => {
    const parsed = parseRosterText(text);
    await upsertEventAttendees(userId, eventId, parsed.attendees, kind);
    revalidateEvents(eventId);
    return { added: parsed.attendees.length, skipped: parsed.skipped, deduped: parsed.deduped };
  }
);

export const importAttendeesFromCsv = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, z.string()]) },
  async (userId, eventId: string, csv: string): Promise<{ added: number; skipped: number; deduped: number }> => {
    const parsed = parseRosterCsv(csv);
    await upsertEventAttendees(userId, eventId, parsed.attendees, "csv");
    revalidateEvents(eventId);
    return { added: parsed.attendees.length, skipped: parsed.skipped, deduped: parsed.deduped };
  }
);

export const setSpokeTo = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, z.array(uuid), z.boolean()]) },
  async (userId, eventId: string, attendeeIds: string[], spokeTo: boolean): Promise<void> => {
    await setSpokeToForUser(userId, eventId, attendeeIds, spokeTo);
    revalidateEvents(eventId);
  }
);

/**
 * Correct one attendee's details.
 *
 * Returns the failure rather than throwing it, because both failure modes are things the
 * user resolves in the dialog: nothing identifying left, or another row on this roster
 * already holding the new identity. See `updateAttendeeForUser` for why the second is a
 * refusal rather than a merge.
 */
export const updateAttendee = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, uuid, z.looseObject({ fullName: z.string().nullable(), email: z.string().nullable(), company: z.string().nullable(), title: z.string().nullable(), linkedinUrl: z.string().nullable(), xHandle: z.string().nullable(), attendeeRole: z.enum(["speaker", "attendee", "host"]).nullable() })]) },
  async (userId, eventId: string, attendeeId: string, patch: {
      fullName: string | null;
      email: string | null;
      company: string | null;
      title: string | null;
      linkedinUrl: string | null;
      xHandle: string | null;
      attendeeRole: AttendeeRole | null;
    }): Promise<UpdateAttendeeResult> => {
    const blank = (value: string | null) => {
      const text = value?.trim();
      return text ? text : null;
    };
    const result = await updateAttendeeForUser(userId, attendeeId, {
      fullName: blank(patch.fullName),
      email: blank(patch.email)?.toLowerCase() ?? null,
      company: blank(patch.company),
      title: blank(patch.title),
      linkedinUrl: blank(patch.linkedinUrl),
      xHandle: blank(patch.xHandle)?.replace(/^@/, "") ?? null,
      attendeeRole: patch.attendeeRole,
    });
    if (result.ok) revalidateEvents(eventId);
    return result;
  }
);

/**
 * Remove one person from the roster.
 *
 * Leaves their contact and this event's interaction alone if they were connected — the
 * roster row is a guest-list entry, not the record of having met them.
 */
export const deleteAttendee = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, uuid]) },
  async (userId, eventId: string, attendeeId: string): Promise<void> => {
    await deleteAttendeeForUser(userId, attendeeId);
    revalidateEvents(eventId);
  }
);

/**
 * Who on this roster is already in your network.
 *
 * Built on `previewConnect` rather than a second, cheaper matcher on purpose. The badge this
 * feeds and the connect preview must never disagree — "already a contact" above a preview
 * that says "create" reads as a bug — and reuse is the only way to guarantee they agree at
 * the same threshold against the same index.
 *
 * Only unconnected rows are asked about: a row with a `contactId` is already known to be
 * linked, and asking would pay for a match we already have.
 */
export const matchRosterToNetwork = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid]) },
  async (userId, eventId: string): Promise<ConnectPreviewRow[]> => {
    const event = await getEventForUser(userId, eventId);
    if (!event) return [];
    const roster = await listRosterForUser(userId, eventId);
    const unlinked = roster.filter((r) => !r.contactId).map((r) => r.id);
    if (unlinked.length === 0) return [];
    return previewConnect(userId, event, unlinked);
  }
);

/** A dry run, so the user sees who will merge and who will be created before committing. */
export const previewConnectAttendees = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, z.array(uuid)]) },
  async (userId, eventId: string, attendeeIds: string[]): Promise<ConnectPreviewRow[]> => {
    const event = await getEventForUser(userId, eventId);
    if (!event) throw new Error("That event no longer exists.");
    return previewConnect(userId, event, attendeeIds);
  }
);

export const addSpokenToConnections = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, z.array(uuid)]) },
  async (userId, eventId: string, attendeeIds: string[]): Promise<ConnectSummary & { remaining: number }> => {
    const event = await getEventForUser(userId, eventId);
    if (!event) throw new Error("That event no longer exists.");

    const summary = await connectAttendees(userId, event, attendeeIds);
    revalidateEvents(eventId);
    // These people are now contacts, so the surfaces that count them are stale.
    revalidatePath("/contacts");
    revalidatePath("/dashboard");
    return summary;
  }
);

export const removeSpokenToConnection = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, uuid]) },
  async (userId, eventId: string, attendeeId: string): Promise<void> => {
    // Deliberately does not delete the contact — see the confirmation copy in the roster.
    await unlinkAttendeeForUser(userId, attendeeId);
    revalidateEvents(eventId);
    revalidatePath("/contacts");
  }
);

// --- Who to talk to ------------------------------------------------------------------------

/**
 * The ranked shortlist for one event: a plan beforehand, a follow-up list afterwards.
 *
 * `aiAvailable` rides along so the card can hide a button that would only ever return "add a
 * key in Settings" — an offer the product cannot keep is worse than no offer.
 */
export const getWhoToTalkTo = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid]) },
  async (userId, eventId: string): Promise<(WhoToTalkTo & { aiAvailable: boolean }) | null> => {
    const event = await getEventForUser(userId, eventId);
    if (!event) return null;
    const [result, aiAvailable] = await Promise.all([
      whoToTalkTo(userId, event, { limit: 5 }),
      userCanUseAi(userId).catch(() => false),
    ]);
    return { ...result, aiAvailable };
  }
);

/**
 * One AI line about a person the SCORE already chose.
 *
 * On demand only, and never part of rendering: a 200-person roster would otherwise be 200
 * model calls against the user's own key, every time the page loads. It also never changes
 * the ranking — the order has to be stable and explainable without a model in the loop.
 *
 * What it is given is the roster row and the reasons already computed. Not the user's notes,
 * not their mail, not anything from `event_aliases`.
 */
export const explainAttendee = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, uuid]), invalid: failResult },
  async (userId, eventId: string, attendeeId: string): Promise<{ ok: boolean; why?: string; opener?: string; error?: string }> => {
    const ai = await getAiAccessStatus(userId);
    if (!ai.ready) {
      // The gate's own words: "add a key", "this month's included AI is used", "still clearing".
      return { ok: false, error: refusalCopyFor(ai.reason, ai.plan) };
    }

    try {
      await consumeBucket("eventWhy", userId, RATE_LIMITS.eventWhy);
    } catch (error) {
      if (isRateLimitedError(error)) {
        return { ok: false, error: "That's a lot of suggestions — try again in a bit." };
      }
      throw error;
    }

    const result = await explainAttendeeForUser(userId, eventId, attendeeId);
    if (result.ok) revalidateEvents(eventId);
    return result;
  }
);

// --- Companies at an event ---------------------------------------------------------------

/** Who was there as an organisation, and who you already know at each. */
export const getEventCompanies = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid]) },
  async (userId, eventId: string): Promise<EventCompanyRow[]> => {
    return loadEventCompanyPanel(userId, eventId);
  }
);

/**
 * Add the employer list from a career fair.
 *
 * Pasted rather than fetched: a fair's exhibitor list is a PDF, a slide, or a page behind a
 * university login as often as it is a web page, and the user already has it on screen.
 */
export const importEventCompanies = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, z.string(), z.enum(["host", "sponsor", "exhibitor", "employer"]).optional()]) },
  async (userId, eventId: string, text: string, role: "exhibitor" | "sponsor" | "host" | "employer" = "employer"): Promise<{ added: number; skipped: number; deduped: number }> => {
    const parsed = parseCompanyList(text);
    const added = await upsertEventCompanies(
      userId,
      eventId,
      parsed.names.map((name) => ({ name, role, source: "paste" as const }))
    );
    revalidateEvents(eventId);
    return { added, skipped: parsed.skipped, deduped: parsed.deduped };
  }
);

/** Wrong ones are hidden rather than deleted, so a bad paste is one click undone. */
export const dismissEventCompanyRow = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, uuid]) },
  async (userId, eventId: string, id: string): Promise<void> => {
    await dismissEventCompany(userId, id);
    revalidateEvents(eventId);
  }
);

/** Star a company from the event panel, where noticing it is most likely. */
export const addTargetCompanyFromEvent = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE), schema: z.tuple([uuid, z.string(), z.union([z.literal(1), z.literal(2), z.literal(3)]).optional()]), invalid: failResult },
  async (userId, eventId: string, name: string, priority: 1 | 2 | 3 = 2): Promise<{ ok: boolean; error?: string }> => {
    const result = await addTargetCompany(userId, name, priority);
    revalidateEvents(eventId);
    return result;
  }
);

// --- Provider connections -------------------------------------------------------------------

export const getEventConnections = defineAction(
  { auth: () => requireUserForReleasedSurface(SURFACE) },
  async (userId): Promise<{
    connections: EventConnectionSummary[];
    eventbriteConfigured: boolean;
    /** Any active Google connection exists. */
    googleConnected: boolean;
    /** That connection may read mail — the confirmation-email scan can run. */
    googleMailGranted: boolean;
    /** That connection may read the calendar — meetings sync. */
    googleCalendarGranted: boolean;
  }> => {
    const [connections, grant, demo] = await Promise.all([
      listEventConnections(userId),
      findGmailGrant(userId),
      isDemoWorkspace(userId),
    ]);
    // The demo workspace stores no OAuth grant but reads as connected everywhere else.
    if (demo) {
      return {
        connections,
        eventbriteConfigured: eventbriteOAuthConfig().configured,
        googleConnected: true,
        googleMailGranted: true,
        googleCalendarGranted: true,
      };
    }
    return {
      connections,
      eventbriteConfigured: eventbriteOAuthConfig().configured,
      googleConnected: grant !== null,
      googleMailGranted: hasGmailReadScope(grant?.scopes),
      googleCalendarGranted: hasScope(grant?.scopes, GOOGLE_SCOPES.calendar),
    };
  }
);

/**
 * Store a Luma API key.
 *
 * Validated by making one real call before it is saved: a key that cannot list a calendar is
 * a key that will fail silently in a background sync three hours from now, and the user is
 * standing right here with the ability to fix it.
 */
export const connectLuma = defineAction(
  { auth: () => requireSyncUser(), schema: z.tuple([z.string()]), invalid: failResult },
  async (userId, apiKey: string): Promise<{ ok: boolean; error?: string }> => {
    await requireReleasedSurface(userId, SURFACE);
    const key = apiKey.trim();
    if (!key) return { ok: false, error: "Paste your Luma API key first" };

    try {
      await listCalendarEvents(key, null);
    } catch (error) {
      // Only a 401/403 means the key is wrong. A Luma outage or a network error used to get
      // the same "didn't accept that key" line, sending people to fix a key that was fine.
      if (!(error instanceof LumaAuthError)) {
        return { ok: false, error: await actionFailure(error, "Couldn’t reach Luma just now — try again", "events.connect-luma") };
      }
      return {
        ok: false,
        error: "Luma didn’t accept that key — it needs to be a calendar key from a Luma Plus account",
      };
    }

    await upsertEventConnection(userId, {
      provider: "luma",
      authKind: "api_key",
      secret: key,
      label: "Luma calendar",
    });
    revalidateEvents();
    return { ok: true };
  }
);

/**
 * Connect a personal Luma or Partiful calendar feed.
 *
 * The most valuable connection in the feature and the cheapest to make: no OAuth app, no paid
 * plan, no scraping — the user pastes the "subscribe to my calendar" link their platform
 * already offers, and every event they register for from then on appears on its own.
 *
 * Validated by fetching it once before it is stored, for the same reason `connectLuma` makes
 * a live call: a link that does not resolve is a link that will fail silently in a background
 * job three hours from now, and the user is standing right here able to fix it.
 *
 * The URL is a secret — it lists everything its holder has registered for — so it is stored
 * encrypted and never echoed back with its query string intact.
 */
export const connectEventFeed = defineAction(
  { auth: () => requireSyncUser(), schema: z.tuple([z.enum(["luma_ics", "partiful_ics"]), z.string()]), invalid: failResult },
  async (userId, provider: "luma_ics" | "partiful_ics", feedUrl: string): Promise<{ ok: boolean; error?: string; found?: number }> => {
    await requireReleasedSurface(userId, SURFACE);
    const raw = feedUrl.trim();
    if (!raw) return { ok: false, error: "Paste your calendar link first" };

    // `webcal:` is what these platforms hand out for a one-click subscribe, and it is https
    // underneath. Rewriting it here means the user can paste exactly what they copied.
    const normalized = raw.replace(/^webcal:\/\//i, "https://");
    if (!/^https:\/\//i.test(normalized)) {
      return { ok: false, error: "That link needs to start with https:// or webcal://" };
    }

    try {
      // Fetching the feed IS the validation, and it is not wasted work: whatever it holds is
      // recorded now, so the user sees their events immediately rather than in fifteen minutes.
      const stats = await syncIcsFeed(userId, normalized, provider);
      await upsertEventConnection(userId, {
        provider,
        authKind: "ics",
        secret: normalized,
        label: provider === "luma_ics" ? "Luma calendar feed" : "Partiful calendar feed",
      });
      revalidateEvents();
      return { ok: true, found: stats.created + stats.attached };
    } catch (error) {
      if (error instanceof IcsFeedGoneError) return { ok: false, error: error.message };
      if (error instanceof EventPageError) {
        // `net-guard` and the fetcher both produce user-facing messages already.
        return { ok: false, error: error.message };
      }
      return {
        ok: false,
        error: await actionFailure(error, "That calendar link couldn’t be read — check it and try again?", "events.connect-feed", { provider }),
      };
    }
  }
);

/**
 * Turn the confirmation-email scan on or off.
 *
 * `gmail.readonly` is a Google RESTRICTED scope. The user granted it for calendar and contact
 * history; reading their mail for event confirmations is a different purpose, so it gets its
 * own explicit switch rather than riding along on a grant made for something else.
 *
 * The connection row IS the consent: no row, no scan. Turning it off deletes the row, which
 * takes the stored scan position with it — there is nothing else to delete, because the scan
 * keeps no message content anywhere.
 */
export const setGmailEventScan = defineAction(
  { auth: () => requireSyncUser(), schema: z.tuple([z.boolean()]), invalid: failResult },
  async (userId, enabled: boolean): Promise<{ ok: boolean; error?: string; needsMailScope?: boolean }> => {
    await requireReleasedSurface(userId, SURFACE);

    if (!enabled) {
      await deleteEventConnection(userId, "gmail");
      revalidateEvents();
      return { ok: true };
    }

    const connection = await findGmailGrant(userId);
    // This switch never widens a grant silently: without gmail.readonly it tells the card to
    // send the person through Google's consent screen for exactly that scope.
    if (!connection || !hasGmailReadScope(connection.scopes)) {
      return {
        ok: false,
        needsMailScope: true,
        error: "Allow mail access first — Orbit asks Google for it next",
      };
    }

    await upsertEventConnection(userId, {
      provider: "gmail",
      authKind: "google_grant",
      // No secret: the token comes from the Gmail connection at scan time, so nothing is
      // duplicated here and revoking Google revokes this too.
      secret: "",
      label: connection.emailAddress ?? "Gmail",
    });
    revalidateEvents();
    return { ok: true };
  }
);

export const startEventbriteOAuth = defineAction(
  { auth: () => requireSyncUser() },
  async (userId): Promise<{ url: string }> => {
    await requireReleasedSurface(userId, SURFACE);
    const config = eventbriteOAuthConfig();
    if (!config.configured) {
      throw new Error(
        "Eventbrite is not configured. Set EVENTBRITE_CLIENT_ID and EVENTBRITE_CLIENT_SECRET."
      );
    }
    const state = `${userId}:${crypto.randomUUID()}`;
    const jar = await cookies();
    jar.set(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    return { url: buildEventbriteAuthUrl(state) };
  }
);

/** Read once and delete, so a state cannot be replayed. */
export const consumeEventbriteOAuthState = defineAction(
  { auth: "public", schema: z.tuple([z.string().nullable()]) },
  async (_caller, state: string | null): Promise<string> => {
    const jar = await cookies();
    const expected = jar.get(OAUTH_STATE_COOKIE)?.value;
    jar.delete(OAUTH_STATE_COOKIE);
    if (!state || !expected || state !== expected) throw new Error("Invalid OAuth state");
    const [userId] = state.split(":");
    if (!userId) throw new Error("Invalid OAuth state");
    return userId;
  }
);

export const disconnectEventProvider = defineAction(
  { auth: () => requireSyncUser(), schema: z.tuple([z.enum(["gmail", "luma", "eventbrite", "luma_ics", "partiful_ics"])]) },
  async (userId, provider: EventConnectionProvider): Promise<void> => {
    await deleteEventConnection(userId, provider);
    await recordAccountAudit({ userId, action: "integration.disconnect", resourceType: provider });
    revalidateEvents();
  }
);
