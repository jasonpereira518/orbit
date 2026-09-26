/**
 * Turns a Deepgram usage-record tag back into the `speech_usage` row it reconciles against —
 * a meeting session for `meeting:<uuid>`, an account for `shortform:<speechTagId>`, where the
 * tag id is the opaque per-account value `src/lib/speech-tag-id.ts` mints and resolves.
 *
 * A tag is untrusted, echoed-back input: Deepgram returns whatever string a live connection
 * set on `listenParams`' `tag` option, with no guarantee it survived intact. Slicing off
 * `"meeting:"` and handing the remainder straight to a `WHERE session_id = ...` query against
 * a uuid column would let one malformed tag throw a Postgres cast error and 503 the entire
 * nightly reconciliation run instead of just skipping that one tag — `isUuid` (the same guard
 * `getMeetingSession` in `meeting-sessions.ts` uses before a session lookup) is what keeps a
 * bad tag a skip, not an outage. A short-form tag id reaches a text column and so cannot fail
 * the same way, but it is shape-checked for the same reason: a tag that does not look like
 * one Orbit built is not one worth querying for.
 *
 * The prefixes themselves live in `deepgram-params.ts`, with the builders, so the two halves
 * cannot drift — and because that file is client-safe while this one reaches the database.
 */
import { MEETING_TAG_PREFIX, SHORTFORM_TAG_PREFIX, isSpeechTagId } from "@/lib/deepgram-params";
import { isUuid } from "@/lib/meeting-sessions";

export { MEETING_TAG_PREFIX, SHORTFORM_TAG_PREFIX };

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

export type ShortformTagParse =
  | { kind: "not-a-shortform-tag" }
  | { kind: "malformed"; raw: string }
  | { kind: "ok"; speechTagId: string };

/**
 * A short-form tag carries the account's OPAQUE tag id, never its user id — a tag lives on
 * in Deepgram's usage records, which their zero-retention flag does not cover. Resolving one
 * to an account is `userIdForSpeechTagId` in `src/lib/speech-tag-id.ts`, one indexed lookup
 * (the daily reconcile in `/api/ops/speech-usage` resolves every tag it sees in one join);
 * that is deliberately a second step rather than something this parser does, so this file
 * stays a pure shape check the way the meeting half is.
 *
 * `isSpeechTagId` is the same check `shortformTag` applies when it builds one, imported from
 * the same client-safe module for the same anti-drift reason as the prefixes.
 */
export function parseShortformTag(tag: string | null): ShortformTagParse {
  if (!tag || !tag.startsWith(SHORTFORM_TAG_PREFIX)) return { kind: "not-a-shortform-tag" };
  const raw = tag.slice(SHORTFORM_TAG_PREFIX.length);
  return isSpeechTagId(raw) ? { kind: "ok", speechTagId: raw } : { kind: "malformed", raw };
}
