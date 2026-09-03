/**
 * The constellation eligibility rule, as a truth table.
 *
 * Pure — no database. The tallies this asserts on come from an aggregate the closeness
 * cohort runs; `smoke-constellation-signals.ts` covers that the SQL produces them correctly.
 * This covers what the rule *decides*, which is the part with the sharp edges:
 *
 * - the manual pin beating every signal, in both directions
 * - a meeting qualifying regardless of message volume
 * - the two-sided message rule, and the legacy fallback that only applies when a contact's
 *   rows are ALL undirected
 * - intent signals, which exist because `rateContacts` writes no interaction: without them a
 *   contact the user rated 5/5 "closest" in the setup wizard is hidden from their own sky
 * - the safety floor, which is the difference between a filter and an outage
 *
 * Run: npx tsx scripts/smoke-constellation-eligibility.ts
 */
import {
  clampThresholds,
  constellationEligibility,
  meetsConstellationFloor,
  DEFAULT_CONSTELLATION_THRESHOLDS,
  EMPTY_SIGNAL_COUNTS,
  MAX_MESSAGE_THRESHOLD,
  MIN_MESSAGE_THRESHOLD,
  type ConstellationContactFields,
  type ContactSignalCounts,
  type EligibilityReason,
} from "../src/lib/constellation-eligibility";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** A contact who has done nothing and been marked as nothing. */
const INERT: ConstellationContactFields = {
  pin: null,
  hasNotesText: false,
  statedCloseness: null,
  priorityLevel: 0,
  nextFollowUpAt: null,
  tagCount: 0,
};

function fields(over: Partial<ConstellationContactFields> = {}): ConstellationContactFields {
  return { ...INERT, ...over };
}

function counts(over: Partial<ContactSignalCounts> = {}): ContactSignalCounts {
  return { ...EMPTY_SIGNAL_COUNTS, ...over };
}

function verdict(
  c: Partial<ContactSignalCounts>,
  f: Partial<ConstellationContactFields> = {},
  thresholds = DEFAULT_CONSTELLATION_THRESHOLDS
): EligibilityReason {
  return constellationEligibility(counts(c), fields(f), thresholds).reason;
}

console.log("Nothing at all…");
check(
  "a contact with no signals and no marks is not eligible",
  verdict({}) === "none"
);
check(
  "and an entirely missing tally is treated as zeroes, not as an error",
  constellationEligibility(undefined, INERT, DEFAULT_CONSTELLATION_THRESHOLDS).reason === "none"
);

console.log("\nThe manual pin outranks everything…");
check(
  "pinned in with no evidence whatsoever",
  verdict({}, { pin: "in" }) === "pinned_in"
);
check(
  "pinned out even with notes, a meeting and a full exchange",
  verdict(
    { noteInteractions: 5, meetingInteractions: 2, linkedInInbound: 9, linkedInOutbound: 9 },
    { pin: "out", hasNotesText: true, statedCloseness: 5 }
  ) === "pinned_out"
);

console.log("\nNotes…");
check("a note interaction qualifies", verdict({ noteInteractions: 1 }) === "notes");
check("so does free text on the contact", verdict({}, { hasNotesText: true }) === "notes");

console.log("\nMeetings…");
check(
  "one meeting qualifies regardless of message volume",
  verdict({ meetingInteractions: 1 }) === "meeting"
);
check(
  "a single message alongside a meeting is still a meeting, not a failed exchange",
  verdict({ meetingInteractions: 1, linkedInInbound: 1 }) === "meeting"
);

console.log("\nThe two-sided message rule…");
check(
  "3 in and 3 out clears the default bar",
  verdict({ linkedInInbound: 3, linkedInOutbound: 3 }) === "linkedin_exchange"
);
check(
  "2 and 2 does not",
  verdict({ linkedInInbound: 2, linkedInOutbound: 2 }) === "none"
);
check(
  "nine inbound with nothing back is a broadcast, not a conversation",
  verdict({ linkedInInbound: 9, linkedInOutbound: 0 }) === "none"
);
check(
  "and nine outbound with no reply is not one either",
  verdict({ linkedInInbound: 0, linkedInOutbound: 9 }) === "none"
);

console.log("\nThe legacy fallback for imports that predate direction…");
check(
  "6 undirected messages clear the combined bar",
  verdict({ linkedInUndirected: 6 }) === "linkedin_volume_fallback"
);
check(
  "5 undirected do not",
  verdict({ linkedInUndirected: 5 }) === "none"
);
// This is the one that matters most. Once ANY of a contact's rows carries a direction, that
// contact has been re-uploaded and the strict rule must take over — otherwise a one-sided
// thread would keep qualifying forever on the strength of its own volume.
check(
  "a contact with a known direction is judged strictly, not by volume",
  verdict({ linkedInInbound: 1, linkedInOutbound: 0, linkedInUndirected: 20 }) === "none"
);
check(
  "and the fallback resumes for contacts still entirely undirected",
  verdict({ linkedInUndirected: 20 }) === "linkedin_volume_fallback"
);

console.log("\nIntent — what the user said, not what they did…");
check(
  "a stated closeness qualifies (rateContacts logs no interaction)",
  verdict({}, { statedCloseness: 5 }) === "intent"
);
check(
  "a stated closeness of 1 still counts — rating someone at all is the signal",
  verdict({}, { statedCloseness: 1 }) === "intent"
);
check("a priority flag qualifies", verdict({}, { priorityLevel: 1 }) === "intent");
check(
  "a scheduled follow-up qualifies",
  verdict({}, { nextFollowUpAt: new Date() }) === "intent"
);
check("a tag qualifies", verdict({}, { tagCount: 1 }) === "intent");
check(
  "but an unrated, unflagged, untagged contact does not",
  verdict({}, { statedCloseness: null, priorityLevel: 0, tagCount: 0 }) === "none"
);

console.log("\nOperator thresholds…");
const strict = clampThresholds({ minInbound: 5, minOutbound: 5 });
check(
  "raising the bar excludes an exchange that cleared the default",
  verdict({ linkedInInbound: 3, linkedInOutbound: 3 }, {}, strict) === "none"
);
check(
  "and the fallback bar moves with it",
  verdict({ linkedInUndirected: 9 }, {}, strict) === "none" &&
    verdict({ linkedInUndirected: 10 }, {}, strict) === "linkedin_volume_fallback"
);
check(
  "zero clamps up to 1, so a contact with no messages can never qualify on messages",
  clampThresholds({ minInbound: 0, minOutbound: 0 }).minInbound === MIN_MESSAGE_THRESHOLD &&
    verdict({}, {}, clampThresholds({ minInbound: 0, minOutbound: 0 })) === "none"
);
check(
  "an absurd threshold clamps down rather than emptying the sky",
  clampThresholds({ minInbound: 9999, minOutbound: 9999 }).minInbound === MAX_MESSAGE_THRESHOLD
);
check(
  "garbage falls back to the defaults",
  clampThresholds({ minInbound: NaN, minOutbound: undefined }).minInbound ===
    DEFAULT_CONSTELLATION_THRESHOLDS.minInbound
);
check(
  "a fractional threshold rounds rather than making the comparison undecidable",
  clampThresholds({ minInbound: 2.6 }).minInbound === 3
);

console.log("\nThe safety floor…");
// The LinkedIn *connections* adapter logs no interactions at all, and the setup wizard leads
// with it. Without this floor those users open /graph to an empty sky.
check(
  "a connections-only network (nobody qualifies) does not get filtered",
  !meetsConstellationFloor(0, 800)
);
check(
  "14 qualifying is below the count floor even at a healthy share",
  !meetsConstellationFloor(14, 20)
);
check("15 of 20 clears both", meetsConstellationFloor(15, 20));
check(
  "15 qualifying out of 4,000 is below the share floor — still an empty-looking sky",
  !meetsConstellationFloor(15, 4000)
);
check("800 of 4,000 clears the share floor", meetsConstellationFloor(800, 4000));
check(
  "exactly 20% counts as clearing it",
  meetsConstellationFloor(200, 1000)
);
check("an empty network is never filtered", !meetsConstellationFloor(0, 0));

console.log("\nAll constellation eligibility checks passed.");
