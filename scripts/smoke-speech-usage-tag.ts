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
 * It also guards what a tag is ALLOWED TO CONTAIN. A tag survives inside Deepgram's usage
 * records, which the zero-retention flag does not cover, so a short-form tag carries an
 * opaque per-account value and never the Clerk user id — both in the builder's own shape
 * check and at the two call sites that build one.
 *
 * Pure — no database, no network; it reads source files, like scripts/smoke-ai-access.ts.
 * Run: npx tsx scripts/smoke-speech-usage-tag.ts
 */
import { readFileSync } from "node:fs";
import { meetingTag, shortformTag } from "../src/lib/deepgram-params";
import { meetingSessionIdFromTag, parseMeetingTag, parseShortformTag } from "../src/lib/speech-usage-tag";

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

console.log("\nparseShortformTag (dictation and voice notes, keyed by an OPAQUE account id)");
const TAG_ID = "Qm9vayBvZiBLZWxsczI"; // 19 chars — deliberately the wrong length, see below
const GOOD_TAG_ID = "AbCdEf0123456789_-xyZ4"; // 22 base64url chars, the shape a mint produces
const sf = parseShortformTag(`shortform:${GOOD_TAG_ID}`);
check("a well-formed shortform tag parses to its tag id", sf.kind === "ok" && sf.speechTagId === GOOD_TAG_ID, sf);
check("a meeting tag is NOT a shortform tag", parseShortformTag(`meeting:${GOOD_UUID}`).kind === "not-a-shortform-tag");
check("null is NOT a shortform tag", parseShortformTag(null).kind === "not-a-shortform-tag");
check("an empty id after the prefix is MALFORMED", parseShortformTag("shortform:").kind === "malformed");
check("an id with a character Orbit would never build is MALFORMED", parseShortformTag("shortform:a b/c").kind === "malformed");
check("an id of the wrong length is MALFORMED", parseShortformTag(`shortform:${TAG_ID}`).kind === "malformed");

// THE FINDING THIS FILE NOW GUARDS. A tag persists in Deepgram's usage records, which the
// zero-retention flag does not cover, so a raw Clerk user id in one would link every
// dictation an account ever makes — in a system Orbit does not control — the way a
// per-recording meeting uuid never can. The builder refuses an id of that shape outright:
// an untagged request is merely invisible to the nightly job, which is the cheaper failure.
console.log("\na raw account id can no longer become a tag");
check("a Clerk-shaped user id is refused by the builder", shortformTag("user_2abcDEF1234567890abcdefgh") === null);
check("…so is a short one that merely looks like a name", shortformTag("demo-user") === null);
check("…and null (an account with no tag id yet) is refused rather than tagged", shortformTag(null) === null);
check(
  "a Clerk-shaped id in a tag Deepgram echoed back is MALFORMED, not an account",
  parseShortformTag("shortform:user_2abcDEF1234567890abcdefgh").kind === "malformed"
);

console.log("\nthe builders and the parsers agree");
// They live in different files — the builders are client-safe, the parsers reach the
// database — so a round trip is what proves the prefixes have not drifted apart.
check("meetingTag -> parseMeetingTag", meetingSessionIdFromTag(meetingTag(GOOD_UUID)) === GOOD_UUID);
const roundTrip = parseShortformTag(shortformTag(GOOD_TAG_ID));
check("shortformTag -> parseShortformTag", roundTrip.kind === "ok" && roundTrip.speechTagId === GOOD_TAG_ID, roundTrip);
check("an id that cannot be tagged is refused rather than rewritten", meetingTag("nope/../etc") === null && shortformTag("") === null);

// The builders take an id and cannot know where it came from, so the guard that matters is
// at the call sites: both places that build a short-form tag must hand it the account's
// opaque value, never the user id they already have in hand.
console.log("\nthe call sites pass the opaque id, not the user id");
for (const file of ["src/app/api/speech/token/route.ts", "src/lib/ai.ts"]) {
  const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const calls = [...code.matchAll(/shortformTag\(([^)]*)\)/g)].map((m) => m[1].trim());
  check(`${file} builds at least one short-form tag`, calls.length > 0, calls);
  check(
    `…and never from a bare userId`,
    calls.every((arg) => !/^userId$/.test(arg) && /speechTagId/i.test(arg)),
    calls
  );
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
