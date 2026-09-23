"use server";

import type { MeetingDigest } from "@/db/schema";
import { completeJson, parseAiJson, type CaptureParseHints } from "@/lib/ai";
import { requireUserId } from "@/lib/auth";
import { deepgramEnabled } from "@/lib/deepgram";
import {
  analyzeMeetingTranscript,
  buildMeetingCorpus,
  formatTranscriptSegment,
  isSelf,
} from "@/lib/meeting-digest";
import { requireMeetingsUser } from "@/lib/plan-guards";
import {
  createMeetingSessionRow,
  discardMeetingSessionRow,
  endMeetingSessionRow,
  getMeetingTranscript,
  loadMeetingSelf,
  resumeMeetingSessionRow,
  storeMeetingDigest,
  updateMeetingDetails,
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
    if (deepgramEnabled()) {
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

export async function saveMeetingDetails(
  id: string,
  input: { title?: string | null; attendees?: MeetingAttendee[] }
): Promise<{ ok: true } | Fail> {
  try {
    const userId = await requireUserId();
    const row = await updateMeetingDetails(userId, id, input);
    if (!row) return { ok: false, error: "That meeting no longer exists" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t update the meeting", "meetings.save-meeting-details") };
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

    const paragraphs = t.segments
      .filter((s) => s.text.trim())
      .map((s) => formatTranscriptSegment(s));
    if (!paragraphs.length) {
      return {
        ok: false,
        error: "Nothing was transcribed in that meeting — check that call audio was shared",
      };
    }

    const self = await loadMeetingSelf(userId);
    const userName = [self.firstName, self.lastName].filter(Boolean).join(" ") || null;
    const attendeeNames = (t.session.attendees ?? []).map((a) => a.name);

    let digest = !opts.force ? t.session.digest : null;
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
            email: t.session.attendees.find((a) => a.name.trim().toLowerCase() === name.toLowerCase())?.email ?? null,
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

export async function discardMeetingSession(id: string): Promise<{ ok: true } | Fail> {
  try {
    const userId = await requireUserId();
    await discardMeetingSessionRow(userId, id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: await actionFailure(err, "Couldn’t discard the meeting", "meetings.discard-meeting-session") };
  }
}
