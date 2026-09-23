/**
 * Pins `parseMeetingTag`/`meetingSessionIdFromTag` (`src/lib/speech-usage-tag.ts`) — the
 * gate between a Deepgram usage-record tag (untrusted, echoed-back input) and the
 * `speech_usage.session_id` uuid column the nightly reconciliation job
 * (`src/app/api/ops/speech-usage/route.ts`) queries with it.
 *
 * A malformed tag must be SKIPPED, never handed to the database: a raw slice with no
 * validation would let one bad tag throw a Postgres cast error and abort the whole run
 * instead of just that one tag.
 *
 * Pure — no database, no network. Run: npx tsx scripts/smoke-speech-usage-tag.ts
 */
import { meetingSessionIdFromTag, parseMeetingTag } from "../src/lib/speech-usage-tag";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}`, extra ?? "");
}

const GOOD_UUID = "5f8d0c1a-9b2e-4f3a-8c7d-1a2b3c4d5e6f";

console.log("parseMeetingTag");
const ok = parseMeetingTag(`meeting:${GOOD_UUID}`);
check("a well-formed meeting tag parses to its session id", ok.kind === "ok" && ok.sessionId === GOOD_UUID, ok);

const malformed = parseMeetingTag("meeting:not-a-uuid");
check("a meeting tag with a malformed id is MALFORMED, not thrown", malformed.kind === "malformed", malformed);

const truncated = parseMeetingTag("meeting:5f8d0c1a-9b2e-4f3a-8c7d");
check("a truncated uuid is MALFORMED", truncated.kind === "malformed", truncated);

const wrongPrefix = parseMeetingTag(`voicenote:${GOOD_UUID}`);
check("a tag with the wrong prefix is NOT-A-MEETING-TAG (skipped silently, not counted as malformed)", wrongPrefix.kind === "not-a-meeting-tag", wrongPrefix);

const noPrefix = parseMeetingTag(GOOD_UUID);
check("a bare uuid with no prefix at all is NOT-A-MEETING-TAG", noPrefix.kind === "not-a-meeting-tag", noPrefix);

const empty = parseMeetingTag("meeting:");
check("an empty id after the prefix is MALFORMED", empty.kind === "malformed", empty);

const nullTag = parseMeetingTag(null);
check("null (no tag on the request at all) is NOT-A-MEETING-TAG", nullTag.kind === "not-a-meeting-tag", nullTag);

const upper = parseMeetingTag(`meeting:${GOOD_UUID.toUpperCase()}`);
check("an uppercase uuid still parses (isUuid is case-insensitive)", upper.kind === "ok" && upper.sessionId === GOOD_UUID.toUpperCase(), upper);

console.log("\nmeetingSessionIdFromTag (the id-or-null convenience wrapper)");
check("good tag -> the session id", meetingSessionIdFromTag(`meeting:${GOOD_UUID}`) === GOOD_UUID);
check("malformed uuid -> null, not thrown", meetingSessionIdFromTag("meeting:not-a-uuid") === null);
check("wrong prefix -> null", meetingSessionIdFromTag(`voicenote:${GOOD_UUID}`) === null);
check("null tag -> null", meetingSessionIdFromTag(null) === null);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
