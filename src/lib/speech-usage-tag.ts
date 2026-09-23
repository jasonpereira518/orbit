/**
 * Turns a Deepgram usage-record tag into the `speech_usage.session_id` it reconciles against.
 *
 * A tag is untrusted, echoed-back input: Deepgram returns whatever string a live connection
 * set on `listenParams`' `tag` option, with no guarantee it survived intact. Slicing off
 * `"meeting:"` and handing the remainder straight to a `WHERE session_id = ...` query against
 * a uuid column would let one malformed tag throw a Postgres cast error and 503 the entire
 * nightly reconciliation run instead of just skipping that one tag — `isUuid` (the same guard
 * `getMeetingSession` in `meeting-sessions.ts` uses before a session lookup) is what keeps a
 * bad tag a skip, not an outage.
 */
import { isUuid } from "@/lib/meeting-sessions";

export const MEETING_TAG_PREFIX = "meeting:";

export type MeetingTagParse =
  | { kind: "not-a-meeting-tag" }
  | { kind: "malformed"; raw: string }
  | { kind: "ok"; sessionId: string };

/** The full classification — lets a caller count "malformed" separately from "not ours". */
export function parseMeetingTag(tag: string | null): MeetingTagParse {
  if (!tag || !tag.startsWith(MEETING_TAG_PREFIX)) return { kind: "not-a-meeting-tag" };
  const raw = tag.slice(MEETING_TAG_PREFIX.length);
  return isUuid(raw) ? { kind: "ok", sessionId: raw } : { kind: "malformed", raw };
}

/** Convenience for callers that only want a validated id or `null`. */
export function meetingSessionIdFromTag(tag: string | null): string | null {
  const parsed = parseMeetingTag(tag);
  return parsed.kind === "ok" ? parsed.sessionId : null;
}
