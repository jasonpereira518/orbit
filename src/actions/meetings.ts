"use server";

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { calendarSources, gmailConnections, meetingSessions, type MeetingDigest } from "@/db/schema";
import { completeJson, parseAiJson, type CaptureParseHints } from "@/lib/ai";
import { requireUserId } from "@/lib/auth";
import { deepgramOpenFor } from "@/lib/speech-credit";
import { ReauthRequiredError } from "@/lib/errors";
import { getValidAccessToken, hasCalendarScope } from "@/lib/gmail";
import { fetchCalendarWindow } from "@/lib/connectors/google-calendar";
import { meetingCandidatesFrom, meetingCandidatesFromRows, type MeetingCandidate } from "@/lib/meeting-calendar";
import { findEventByKey, listUpcomingEvents, matchEventForSession } from "@/lib/calendar-events";
import { buildMeetingRecap, type MeetingRecap } from "@/lib/meeting-recap";
import { listMeetingsFor, type MeetingsPage } from "@/lib/meetings-list";
import {
  analyzeMeetingTranscript,
  buildMeetingCorpus,
  cleanUserNotes,
  formatTranscriptSegment,
  isSelf,
  speakerDisplayNames,
} from "@/lib/meeting-digest";
import { requireMeetingsUser } from "@/lib/plan-guards";
import {
  createMeetingSessionRow,
  lastSeriesMeeting,
  linkMeetingSessionToEvent,
  discardMeetingSessionRow,
  endMeetingSessionRow,
  getMeetingTranscript,
  loadMeetingSelf,
  resumeMeetingSessionRow,
  storeMeetingDigest,
  type MeetingAttendee,
} from "@/lib/meeting-sessions";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import { speechAllowance } from "@/lib/speech-quota";
import { isoDay } from "@/lib/suggested-reminder-utils";
import { actionFailure } from "@/lib/action-failure";

/**
 * Meeting capture's session lifecycle. The audio itself never passes through here — chunks
 * go to `/api/capture/meetings/[id]/chunks`, because server actions run one at a time per
 * client and a chunk upload would block everything else on the page. These are the calls
 * that happen a handful of times per meeting.
 *
 * Every action returns `{ ok: false, error }` as data rather than throwing, the same
 * contract as `src/actions/capture.ts`, so the message survives production builds.
 */

type Fail = { ok: false; error: string };

/**
 * "October 1" — the day the meeting allowance comes back.
 *
 * Fixed to `en-US` deliberately: this runs on a server whose locale is the deployment's, not
 * the reader's, so leaving it to the default would render a US user's date in whatever
 * locale Vercel's runtime happens to carry.
 */
function resetLabel(resetsAt: Date): string {
  return resetsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

export async function createMeetingSession(input: {
  title?: string | null;
  attendees?: MeetingAttendee[];
  includesMic: boolean;
  captureSurface?: string | null;
  recorderId: string;
  calendarEventKey?: string | null;
  calendarSeriesId?: string | null;
}): Promise<{ ok: true; id: string; startedAtIso: string } | Fail> {
  try {
    const userId = await requireMeetingsUser();
    // The entitlement says this plan MAY record; the allowance says whether there is
    // anything left to record with. Without this, an account at 100% got the whole ceremony
    // — a share picker, a started recording — and then an instant "Recording stopped" from
    // the first stream-token 402, leaving an empty session row behind. Refuse up front, and
    // name the day it comes back, which is the only thing the user can act on.
    //
    // A quota that cannot be READ throws, and the catch below turns that into `ok: false`:
    // meetings fail closed here too.
    //
    // Only while DEEPGRAM is the engine. The allowance meters Orbit's own key, and
    // `ORBIT_DEEPGRAM=off` — the incident lever — sends transcription back to the user's own
    // OpenAI or Gemini key, where a recorded hour costs Orbit nothing. Refusing a spent cap
    // in that state would lock a paying account out of a meeting Orbit is not paying for,
    // and tell them their hours are gone when their hours are not what is stopping them. The
    // read is skipped entirely rather than taken and ignored, so no stale number can leak
    // into copy from here.
    //
    // The same holds once the Deepgram credit is spent (`deepgramOpenFor`): a NEW meeting then
    // records on the account's own key, so the cap is not Orbit's to enforce.
    if (await deepgramOpenFor(userId, "meeting")) {
      const allowance = await speechAllowance(userId, "meeting");
      if (allowance.exhausted) {
        return { ok: false, error: `You’ve used this month’s meeting hours — they reset on ${resetLabel(allowance.resetsAt)}` };
      }
    }
    const row = await createMeetingSessionRow(userId, input);
    return { ok: true, id: row.id, startedAtIso: row.startedAt.toISOString() };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t start the meeting", "meetings.create-meeting-session") };
  }
}

export async function resumeMeetingSession(
  id: string,
  recorderId: string
): Promise<
  | { ok: true; id: string; startedAtIso: string; lastSeq: number; durationMs: number }
  | Fail
> {
  try {
    const userId = await requireMeetingsUser();
    const res = await resumeMeetingSessionRow(userId, id, recorderId);
    if (!res.ok) return res;
    return {
      ok: true,
      id: res.session.id,
      startedAtIso: res.session.startedAt.toISOString(),
      lastSeq: res.session.lastSeq,
      durationMs: res.session.durationMs,
    };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t resume the meeting", "meetings.resume-meeting-session") };
  }
}

export async function endMeetingSession(
  id: string,
  durationMs: number
): Promise<{ ok: true } | Fail> {
  try {
    const userId = await requireMeetingsUser();
    const row = await endMeetingSessionRow(userId, id, { durationMs });
    if (!row) return { ok: false, error: "That meeting no longer exists" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t stop the meeting", "meetings.end-meeting-session") };
  }
}
export type MeetingTranscriptView = {
  id: string;
  title: string | null;
  status: string;
  startedAtIso: string;
  durationMs: number;
  segments: { seq: number; startMs: number; endMs: number; text: string }[];
  missingSeqs: number[];
};

/** The stored transcript, for the live list after a resume and for the results page. */
export async function loadMeetingTranscript(
  id: string
): Promise<{ ok: true; transcript: MeetingTranscriptView } | Fail> {
  try {
    const userId = await requireUserId();
    const t = await getMeetingTranscript(userId, id);
    if (!t) return { ok: false, error: "That meeting no longer exists" };
    return {
      ok: true,
      transcript: {
        id: t.session.id,
        title: t.session.title,
        status: t.session.status,
        startedAtIso: t.session.startedAt.toISOString(),
        durationMs: t.session.durationMs,
        segments: t.segments.map(({ seq, startMs, endMs, text }) => ({ seq, startMs, endMs, text })),
        missingSeqs: t.missingSeqs,
      },
    };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t load the transcript", "meetings.load-meeting-transcript") };
  }
}

export type MeetingAnalysis = {
  digest: MeetingDigest;
  /** First-person notes for `parseBulkCaptureNotes` — see `buildMeetingCorpus`. */
  corpus: string;
  hints: CaptureParseHints;
  startedAtIso: string;
  durationMs: number;
  missingSeqs: number[];
};

/**
 * Summarize a finished meeting and prepare the capture handoff.
 *
 * Reuses a stored digest unless `force`: the analysis is the one expensive step, and
 * someone who backs out of review to fix an attendee should not pay for it twice. A
 * resumed recording clears the stored digest, so reuse never serves a stale one.
 */
export async function analyzeMeetingSession(
  id: string,
  opts: {
    force?: boolean;
    /**
     * The day the meeting started, in the browser's timezone. The server runs in UTC, so an
     * evening call on the US west coast would otherwise be anchored to the next day — and
     * every "tomorrow" in it resolved a day late.
     */
    localDateIso?: string;
    /**
     * What the user typed into the notes box during the call. Not stored: it rides along
     * with the request (the browser keeps it), and a stored digest is skipped when there is
     * any, since that digest was made without it.
     */
    notes?: string;
  } = {}
): Promise<{ ok: true; analysis: MeetingAnalysis } | Fail> {
  let userId: string;
  try {
    userId = await requireMeetingsUser();
    await consumeBucket("capture", userId, RATE_LIMITS.capture);
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t analyze the meeting", "meetings.analyze-meeting-session") };
  }

  try {
    const t = await getMeetingTranscript(userId, id);
    if (!t) return { ok: false, error: "That meeting no longer exists" };
    if (t.session.status === "saved") return { ok: false, error: "That meeting was already saved" };

    const notes = cleanUserNotes(opts.notes);

    // The calendar event this was, when known — from the nudge, or matched now by time and guests.
    let event = t.session.calendarEventKey ? await findEventByKey(userId, t.session.calendarEventKey) : null;
    if (!t.session.calendarEventKey) {
      event = await matchEventForSession(userId, t.session.startedAt, {
        title: t.session.title,
        attendees: t.session.attendees ?? [],
      });
      if (event) {
        await linkMeetingSessionToEvent(userId, t.session.id, { eventKey: event.providerEventId, seriesId: event.seriesId });
      }
    }
    const seriesId = t.session.calendarSeriesId ?? event?.seriesId ?? null;
    const last = seriesId ? await lastSeriesMeeting(userId, seriesId, t.session.id) : null;
    const lastOpen = last?.actionItems.map((a) => (a.owner ? `${a.text} (${a.owner})` : a.text)) ?? [];
    // Names only: this goes to the AI provider, and an invitee with no display name would
    // otherwise be their address.
    const invited = event?.guestsHidden ? [] : (event?.attendees ?? []).map((a) => a.name).filter(Boolean);

    // A 1:1's other voice is the other person; the transcript then reads "Priya:" not "Speaker 1:".
    const voices = speakerDisplayNames(t.segments, invited.length ? invited : (t.session.attendees ?? []).map((a) => a.name));
    const paragraphs = t.segments
      .filter((s) => s.text.trim())
      .map((s) => formatTranscriptSegment(s, voices));
    if (!paragraphs.length) {
      return {
        ok: false,
        error: "Nothing was transcribed in that meeting — check that call audio was shared",
      };
    }

    const self = await loadMeetingSelf(userId);
    const userName = [self.firstName, self.lastName].filter(Boolean).join(" ") || null;
    // The user's typed list wins; a recording started without one borrows the invite's guests.
    const sessionAttendees = t.session.attendees ?? [];
    const attendeeNames = sessionAttendees.length ? sessionAttendees.map((a) => a.name) : invited;
    const emailFor = (name: string) => {
      const key = name.trim().toLowerCase();
      return (
        sessionAttendees.find((a) => a.name.trim().toLowerCase() === key)?.email ??
        event?.attendees.find((a) => (a.name || a.email).trim().toLowerCase() === key)?.email ??
        null
      );
    };

    let digest = !opts.force && !notes ? t.session.digest : null;
    if (!digest) {
      try {
        digest = await analyzeMeetingTranscript(
          userId,
          {
            paragraphs,
            title: t.session.title,
            startedAtIso: t.session.startedAt.toISOString(),
            userName,
            attendees: attendeeNames,
            userNotes: notes || undefined,
            invite: event ? { attendees: invited, agenda: event.agenda } : undefined,
            lastTime: lastOpen.length ? { date: isoDay(last!.startedAt), actionItems: lastOpen } : undefined,
          },
          { complete: completeJson, parseJson: parseAiJson }
        );
      } catch (err) {
        const message = await actionFailure(err, "Couldn’t analyze the meeting", "meetings.analyze-digest", {
          sessionId: t.session.id,
        });
        await storeMeetingDigest(userId, t.session.id, { error: message });
        return { ok: false, error: message };
      }
      digest = {
        ...digest,
        participants: digest.participants.filter((p) => !isSelf(p.name, self)),
      };
      await storeMeetingDigest(userId, t.session.id, { digest });
    }

    // Everyone who was on the call: the user's own list first (they typed those names, so
    // those spellings win), then whoever the digest heard speaking.
    const present: string[] = [];
    const seen = new Set<string>();
    for (const name of [...attendeeNames, ...digest.participants.filter((p) => p.present).map((p) => p.name)]) {
      const key = name.trim().toLowerCase();
      if (!key || seen.has(key) || isSelf(name, self)) continue;
      seen.add(key);
      present.push(name.trim());
    }

    const startedAtIso = t.session.startedAt.toISOString();
    const corpus = buildMeetingCorpus(digest, {
      title: t.session.title || digest.title,
      startedAtIso,
      userName,
      presentNames: present,
    });

    return {
      ok: true,
      analysis: {
        digest,
        corpus,
        hints: {
          eventDate:
            opts.localDateIso && /^\d{4}-\d{2}-\d{2}$/.test(opts.localDateIso)
              ? opts.localDateIso
              : isoDay(t.session.startedAt),
          // Only people who were ON the call: the two-pass parse turns every seed into a
          // review card, and someone merely mentioned should be a mention, not a card.
          seedPeople: present.map((name) => ({
            name,
            email: emailFor(name),
          })),
          interactionType: "call",
        },
        startedAtIso,
        durationMs: t.session.durationMs,
        missingSeqs: t.missingSeqs,
      },
    };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t analyze the meeting", "meetings.analyze-meeting-session") };
  }
}

/**
 * The recap email for a summarized meeting: to everyone invited (the calendar event's guests
 * when it is still in the window, else the names typed when recording), from the stored digest.
 * Nothing is sent from here — the page opens it in Compose or the user's own mail app.
 */
export async function getMeetingRecap(id: string): Promise<{ ok: true; recap: MeetingRecap } | Fail> {
  try {
    const userId = await requireMeetingsUser();
    const db = await getDb();
    const session = await db.query.meetingSessions.findFirst({
      where: and(eq(meetingSessions.id, id), eq(meetingSessions.userId, userId)),
      columns: { title: true, digest: true, attendees: true, calendarEventKey: true },
    });
    if (!session?.digest) return { ok: false, error: "That meeting hasn’t been summarized yet" };
    const event = session.calendarEventKey ? await findEventByKey(userId, session.calendarEventKey) : null;
    const typed = (session.attendees ?? []).map((a) => ({ name: a.name, email: a.email ?? null }));
    const invited = (event?.attendees ?? []).map((a) => ({ name: a.name || a.email, email: a.email || null }));
    const self = await loadMeetingSelf(userId);
    return {
      ok: true,
      recap: buildMeetingRecap({
        title: session.title?.trim() || session.digest.title || "our meeting",
        digest: session.digest,
        attendees: invited.length ? invited : typed,
        userFirstName: self.firstName,
        isSelf: (name) => isSelf(name, self),
      }),
    };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t write the recap", "meetings.get-meeting-recap") };
  }
}

export async function discardMeetingSession(id: string): Promise<{ ok: true } | Fail> {
  try {
    const userId = await requireUserId();
    await discardMeetingSessionRow(userId, id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t discard the meeting", "meetings.discard-meeting-session") };
  }
}

export type MeetingCandidatesResult =
  | {
      ok: true;
      /**
       * `ok` — the calendar was read (`events` may be empty). The rest say why it could not
       * be: nothing connected (quiet — most people have not), a Google connection from before
       * calendar existed, or a grant Google has since revoked.
       */
      status: "ok" | "not-connected" | "needs-scope" | "reauth";
      events: MeetingCandidate[];
    }
  | Fail;

/** From a little before now (a meeting that already started) to the next few hours. */
const CANDIDATES_PAST_MS = 45 * 60_000;
const CANDIDATES_FUTURE_MS = 4 * 3_600_000;

/**
 * A minute's memory of each user's answer, so the setup card and the calendar nudge (and a
 * second tab) share one Google read. Per server instance, not shared or durable — the
 * established pattern here, since React `cache()` is a pass-through in Server Actions. Only
 * an answer that read the calendar is kept: a refusal should be re-checked.
 */
const CANDIDATES_TTL_MS = 60_000;
const candidatesCache = new Map<string, { at: number; result: MeetingCandidatesResult }>();

/**
 * The meetings on the user's Google calendar around now, to prefill the setup form.
 *
 * A live read of the primary calendar, nothing stored: it reuses the Google connection Orbit
 * already holds for Gmail, Contacts and calendar sync (no second consent), and asks only for
 * events starting within the window. Failures never block recording — the form works the same
 * without a suggestion — so the caller treats anything but `ok` as "show nothing".
 */
export async function getMeetingCandidates(): Promise<MeetingCandidatesResult> {
  try {
    const userId = await requireMeetingsUser();
    const cached = candidatesCache.get(userId);
    if (cached && Date.now() - cached.at < CANDIDATES_TTL_MS) return cached.result;
    await consumeBucket("meetingCandidates", userId, RATE_LIMITS.meetingCandidates);
    const db = await getDb();
    const conn = await db.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, userId) });
    if (!conn) {
      // Outlook or iCloud: no live read here, but the mirrored window has the same meetings.
      const now = new Date();
      const hasCalendar = await db.query.calendarSources.findFirst({
        where: and(eq(calendarSources.userId, userId), eq(calendarSources.enabled, 1)),
        columns: { id: true },
      });
      if (!hasCalendar) return { ok: true, status: "not-connected", events: [] };
      const rows = await listUpcomingEvents(userId, {
        from: new Date(now.getTime() - CANDIDATES_PAST_MS),
        to: new Date(now.getTime() + CANDIDATES_FUTURE_MS),
        limit: 25,
      });
      const result: MeetingCandidatesResult = { ok: true, status: "ok", events: meetingCandidatesFromRows(rows, now) };
      candidatesCache.set(userId, { at: Date.now(), result });
      return result;
    }
    if (!hasCalendarScope(conn.scopes)) return { ok: true, status: "needs-scope", events: [] };
    if (conn.status !== "active") return { ok: true, status: "reauth", events: [] };

    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(userId);
    } catch (err) {
      if (err instanceof ReauthRequiredError) return { ok: true, status: "reauth", events: [] };
      throw err;
    }

    const now = new Date();
    const page = await fetchCalendarWindow({
      accessToken,
      from: new Date(now.getTime() - CANDIDATES_PAST_MS),
      to: new Date(now.getTime() + CANDIDATES_FUTURE_MS),
      maxResults: 25,
      timeoutMs: 10_000,
    });
    if (page.status === 401) return { ok: true, status: "reauth", events: [] };
    if (page.status === 403) return { ok: true, status: "needs-scope", events: [] };
    if (page.status >= 400) throw new Error(`Google Calendar ${page.status}`);

    const result: MeetingCandidatesResult = { ok: true, status: "ok", events: meetingCandidatesFrom(page.items, now) };
    candidatesCache.set(userId, { at: Date.now(), result });
    return result;
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t read your calendar", "meetings.get-meeting-candidates") };
  }
}

/** One more page of past meetings, for the list's "Load more". */
export async function listMeetingsPage(
  q: string | null,
  cursor: string | null
): Promise<({ ok: true } & MeetingsPage) | Fail> {
  try {
    const userId = await requireMeetingsUser();
    return { ok: true, ...(await listMeetingsFor(userId, { q, cursor })) };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t load your meetings", "meetings.list-meetings-page") };
  }
}
