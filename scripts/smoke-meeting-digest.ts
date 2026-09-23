/**
 * The meeting analysis with the model stubbed out: a sloppy response still parses, quotes
 * the transcript never said are cleared, a long meeting is split and merged, and the
 * corpus handed to the people parse says who "I" is. Pure — no database, no network.
 * Run: npx tsx scripts/smoke-meeting-digest.ts
 */
import {
  CORPUS_MAX_CHARS,
  MAP_PIECE_CHARS,
  MAP_THRESHOLD_CHARS,
  analyzeMeetingTranscript,
  appearsIn,
  buildMeetingCorpus,
  formatTranscriptSegment,
  groundDigest,
  isSelf,
  meetingDigestSchema,
  normalizeDigest,
  normalizeForContainment,
  speakerLabel,
  splitTranscript,
  type CompleteJsonFn,
} from "../src/lib/meeting-digest";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const TRANSCRIPT = [
  "Thanks for joining. Priya, can you walk us through the pilot? Sure — we're live with three customers and the next milestone is September 30.",
  "The blocker is legal sign-off on the data agreement; we're waiting on Acme's counsel. Marcus said he'd chase that by Friday.",
  "One open question is whether we price per seat or per workspace. Nobody knows yet. I'll send the deck to Priya tomorrow.",
].join("\n\n");

// ── Schema tolerance ─────────────────────────────────────────────────────────────────
{
  const parsed = meetingDigestSchema.parse({
    title: "  Pilot   review ",
    summary: null,
    key_points: ["A", 3, "B"],
    action_items: [
      { text: "Chase legal", owner: "Marcus", due_phrase: "by Friday" },
      { owner: "me" }, // no text: dropped, not fatal
    ],
    blockers: "not a list",
    open_questions: [{ text: "Seat or workspace pricing?", asked_by: null, source_excerpt: "per seat or per workspace" }],
    participants: [{ name: "Priya" }],
  });
  check("whitespace in strings is collapsed", parsed.title === "Pilot review");
  check("a missing list is an empty list", parsed.decisions.length === 0 && parsed.dated_quotes.length === 0);
  check("a non-string in a string list is skipped, not fatal", parsed.key_points.join() === "A,B");
  check("an invalid item is dropped and the rest kept", parsed.action_items.length === 1);
  check("a list sent as a string is treated as empty", parsed.blockers.length === 0);
  check("participants default to present", parsed.participants[0]?.present === true);
}

// ── normalizeDigest ──────────────────────────────────────────────────────────────────
{
  const raw = meetingDigestSchema.parse({
    title: null,
    key_points: ["Pilot live", "pilot live", "  Pilot live  "],
    action_items: [{ text: "Send deck", owner: "Unclear" }],
    participants: [
      { name: "Priya Raman", present: false, context: null },
      { name: "priya raman", present: true, context: "Runs the pilot" },
    ],
  });
  const d = normalizeDigest(raw, "Weekly sync");
  check("the fallback title is used when the model gives none", d.title === "Weekly sync");
  check("duplicate points are merged case-insensitively", d.keyPoints.length === 1);
  check("an 'unclear' owner becomes null", d.actionItems[0]?.owner === null);
  check("the same person across pieces is one participant", d.participants.length === 1);
  check("…present if any piece heard them", d.participants[0]?.present === true);
  check("…with the context that exists", d.participants[0]?.context === "Runs the pilot");
}

// ── Grounding ────────────────────────────────────────────────────────────────────────
{
  const hay = normalizeForContainment(TRANSCRIPT);
  check("containment ignores punctuation and case", appearsIn(hay, "WE'RE waiting on Acme's counsel!"));
  check("containment rejects words that were not said", !appearsIn(hay, "waiting on Globex's counsel"));
  check("an empty needle never matches", !appearsIn(hay, "") && !appearsIn(hay, null));

  const digest = normalizeDigest(
    meetingDigestSchema.parse({
      title: "Pilot",
      action_items: [
        { text: "Chase legal", owner: "Marcus", due_phrase: "by Friday", source_excerpt: "Marcus said he'd chase that by Friday" },
        { text: "Book offsite", owner: null, due_phrase: "on October 12", source_excerpt: "let's book the offsite October 12" },
      ],
      blockers: [{ text: "Legal sign-off", source_excerpt: "waiting on Acme's counsel" }],
      dated_quotes: [
        "the next milestone is September 30",
        "We agreed to launch on November 3.",
      ],
    }),
    "Pilot"
  );
  const g = groundDigest(digest, TRANSCRIPT);
  check("a real due phrase is kept", g.actionItems[0]?.duePhrase === "by Friday");
  check("a real excerpt is kept", g.actionItems[0]?.sourceExcerpt !== null);
  check("an invented due phrase is cleared", g.actionItems[1]?.duePhrase === null);
  check("an invented excerpt is cleared", g.actionItems[1]?.sourceExcerpt === null);
  check("…but the item itself is kept", g.actionItems.length === 2);
  check("a real blocker quote is kept", g.blockers[0]?.sourceExcerpt === "waiting on Acme's counsel");
  check("a dated quote that was never said is dropped", g.datedQuotes.length === 1 && g.datedQuotes[0]!.includes("September 30"));
}

// ── isSelf ───────────────────────────────────────────────────────────────────────────
{
  const me = { firstName: "Jordan", lastName: "Lee" };
  check("the full name is self", isSelf("Jordan Lee", me));
  check("the first name alone is self", isSelf("  jordan ", me));
  check("'me' is self", isSelf("Me", me));
  check("someone else is not", !isSelf("Jordan Smith", me) && !isSelf("Priya", me));
  check("no name on file matches nobody", !isSelf("Jordan", { firstName: null, lastName: null }));
}

// ── Speaker labels ───────────────────────────────────────────────────────────────────
{
  check('speakerLabel maps "you" to "You"', speakerLabel("you") === "You");
  check('speakerLabel maps "speaker-1" to "Speaker 1"', speakerLabel("speaker-1") === "Speaker 1");
  check('speakerLabel maps "speaker-12" to "Speaker 12"', speakerLabel("speaker-12") === "Speaker 12");
  check("speakerLabel of null is null", speakerLabel(null) === null);
  check("speakerLabel of an unrecognized value is null", speakerLabel("narrator") === null);

  check(
    'formatTranscriptSegment prefixes a known speaker as "You: text"',
    formatTranscriptSegment({ speaker: "you", text: "I'll send the deck." }) === "You: I'll send the deck."
  );
  check(
    'formatTranscriptSegment prefixes "speaker-2" as "Speaker 2: text"',
    formatTranscriptSegment({ speaker: "speaker-2", text: "Sounds good." }) === "Speaker 2: Sounds good."
  );
  check(
    "formatTranscriptSegment renders a null speaker as bare text, exactly as today",
    formatTranscriptSegment({ speaker: null, text: "Unlabeled audio." }) === "Unlabeled audio."
  );
}

// ── Splitting ────────────────────────────────────────────────────────────────────────
{
  const para = (n: number) => `${"word ".repeat(n / 5).trim()}.`;
  const paragraphs = Array.from({ length: 12 }, () => para(4_000));
  const pieces = splitTranscript(paragraphs, MAP_PIECE_CHARS);
  check("pieces respect the size limit", pieces.every((p) => p.length <= MAP_PIECE_CHARS), pieces.map((p) => p.length).join(","));
  check("paragraphs are packed, not one per piece", pieces.length < paragraphs.length);
  check(
    "no text is lost when packing",
    pieces.join("\n\n").replace(/\s+/g, "").length === paragraphs.join("").replace(/\s+/g, "").length
  );
  const giant = splitTranscript([`${"Sentence here. ".repeat(3_000)}`], 10_000);
  check("an oversize paragraph is split at sentences", giant.length > 1 && giant.every((p) => p.length <= 10_000));
  check("empty paragraphs are skipped", splitTranscript(["", "  ", "hi"]).join() === "hi");
}

// ── The corpus the people parse reads ────────────────────────────────────────────────
{
  const digest = normalizeDigest(
    meetingDigestSchema.parse({
      title: "Pilot review",
      notes: "Priya walked us through the pilot. Marcus is chasing legal.",
      action_items: [{ text: "Send Priya the deck", owner: "me" }, { text: "Chase legal", owner: "Marcus" }],
      dated_quotes: ["the next milestone is September 30"],
    }),
    "Pilot"
  );
  const corpus = buildMeetingCorpus(digest, {
    title: "Pilot review",
    startedAtIso: "2026-09-11T17:00:00.000Z",
    userName: "Jordan Lee",
    presentNames: ["Priya Raman", "Marcus Lee"],
  });
  check("the corpus says who 'I' is", corpus.includes("I am Jordan Lee"));
  check("…and who was on the call", corpus.includes("On the call: Priya Raman, Marcus Lee."));
  check("…and carries the notes", corpus.includes("Priya walked us through the pilot."));
  check("…the next steps with owners", corpus.includes("- Send Priya the deck (me)") && corpus.includes("- Chase legal (Marcus)"));
  check("…and the verbatim dated lines", corpus.includes('"the next milestone is September 30"'));
  const huge = buildMeetingCorpus({ ...digest, notes: "x".repeat(50_000) }, {
    title: null,
    startedAtIso: "2026-09-11T17:00:00.000Z",
    userName: null,
    presentNames: [],
  });
  check("the corpus is capped", huge.length <= CORPUS_MAX_CHARS);
}

// ── analyzeMeetingTranscript, with the model stubbed ─────────────────────────────────
async function main() {
  const reply = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      title: "Pilot review",
      summary: "We reviewed the pilot.",
      key_points: ["Pilot is live"],
      decisions: [],
      action_items: [{ text: "Chase legal", owner: "Marcus", due_phrase: "by Friday", source_excerpt: "chase that by Friday" }],
      blockers: [{ text: "Legal sign-off", owner: null, source_excerpt: "made-up quote" }],
      open_questions: [],
      participants: [{ name: "Priya", present: true, context: null }],
      dated_quotes: ["next milestone is September 30"],
      notes: "Notes.",
      ...over,
    });

  {
    const calls: { operation?: string; user: string }[] = [];
    const complete: CompleteJsonFn = async (_u, input) => {
      calls.push({ operation: input.operation, user: input.user });
      return reply();
    };
    const d = await analyzeMeetingTranscript(
      "u",
      {
        paragraphs: TRANSCRIPT.split("\n\n"),
        title: "Pilot review",
        startedAtIso: "2026-09-11T17:00:00.000Z",
        userName: "Jordan Lee",
        attendees: ["Priya Raman"],
      },
      { complete, parseJson: JSON.parse }
    );
    check("a short meeting is one call", calls.length === 1 && calls[0]!.operation === "meeting.digest");
    check("…with the transcript and attendees in it", calls[0]!.user.includes("Acme's counsel") && calls[0]!.user.includes("Priya Raman"));
    check("…and the result is grounded", d.blockers[0]?.sourceExcerpt === null && d.actionItems[0]?.duePhrase === "by Friday");
  }

  // The point of this task: a paragraph the caller built with `formatTranscriptSegment`
  // (as `analyzeMeetingSession` in src/actions/meetings.ts now does) carries its speaker
  // prefix into the prompt, the system prompt explains what the prefixes mean instead of
  // denying they exist, and a commitment spoken on a "You:" line comes back owned by
  // "me" — while the SAME commitment with no speaker prefix does not.
  //
  // The stub below is not canned: it decides "owner" by checking whether the prompt it
  // was actually given contains `You: ${COMMITMENT}` as a substring. That makes the
  // "me" assertion capable of failing — delete the prefixing (or never call
  // `formatTranscriptSegment`) and the "you"-speaker run degrades to the same prompt as
  // the null-speaker run, so both would come back with owner null and the first check
  // below would fail. A stub that always returned owner "me" regardless of input, as an
  // earlier version of this test did, could not distinguish "the prompt change did
  // something" from "the pipeline doesn't strip a returned me" — see fix round 1.
  {
    const COMMITMENT = "I'll send Priya the deck by Friday.";
    const COMMITMENT_EXCERPT = "I'll send Priya the deck by Friday";

    const replyDecidingOwnerFromPrompt = (transcriptSentToModel: string) =>
      JSON.stringify({
        title: "Pilot review",
        summary: "We reviewed the pilot.",
        key_points: ["Pilot is live"],
        decisions: [],
        action_items: [
          {
            text: "Send Priya the deck",
            owner: transcriptSentToModel.includes(`You: ${COMMITMENT}`) ? "me" : null,
            due_phrase: "by Friday",
            source_excerpt: COMMITMENT_EXCERPT,
          },
        ],
        blockers: [],
        open_questions: [],
        participants: [],
        dated_quotes: [],
        notes: "Notes.",
      });

    const run = async (commitmentSpeaker: string | null) => {
      const calls: { system: string; user: string }[] = [];
      const complete: CompleteJsonFn = async (_u, input) => {
        calls.push({ system: input.system, user: input.user });
        return replyDecidingOwnerFromPrompt(input.user);
      };
      const paragraphs = [
        formatTranscriptSegment({ speaker: commitmentSpeaker, text: COMMITMENT }),
        formatTranscriptSegment({ speaker: "speaker-1", text: "Sounds great, thanks." }),
        formatTranscriptSegment({ speaker: null, text: "Some recovered audio with no speaker info." }),
      ];
      const d = await analyzeMeetingTranscript(
        "u",
        {
          paragraphs,
          title: "Pilot review",
          startedAtIso: "2026-09-11T17:00:00.000Z",
          userName: "Jordan Lee",
          attendees: [],
        },
        { complete, parseJson: JSON.parse }
      );
      return { d, calls };
    };

    const you = await run("you");
    check(
      "a You: line reaches the prompt with its prefix",
      you.calls[0]!.user.includes(`You: ${COMMITMENT}`)
    );
    check(
      "a speaker-1 line reaches the prompt as Speaker 1:",
      you.calls[0]!.user.includes("Speaker 1: Sounds great, thanks.")
    );
    check(
      "an unlabeled segment stays bare text",
      you.calls[0]!.user.includes("Some recovered audio with no speaker info.") &&
        !you.calls[0]!.user.includes("null: Some recovered audio")
    );
    check(
      "the system prompt explains the speaker prefixes",
      you.calls[0]!.system.includes('"You:" is the user') &&
        you.calls[0]!.system.includes("renumbered after a line saying the recording reconnected")
    );
    check("…and no longer claims there are no speaker labels", !you.calls[0]!.system.includes("NO speaker labels"));
    check(
      'a commitment spoken on a You: line is extracted with owner "me"',
      you.d.actionItems[0]?.owner === "me"
    );
    check(
      "…and its source excerpt still grounds against the prefixed transcript",
      you.d.actionItems[0]?.sourceExcerpt === COMMITMENT_EXCERPT
    );

    const unprefixed = await run(null);
    check(
      "the same commitment with no speaker prefix does NOT reach the prompt as You:",
      !unprefixed.calls[0]!.user.includes(`You: ${COMMITMENT}`)
    );
    check(
      '…and comes back with owner null — proving the "me" above came from the You: prefix, not a canned stub',
      unprefixed.d.actionItems[0]?.owner === null
    );
  }

  {
    const calls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const complete: CompleteJsonFn = async (_u, input) => {
      calls.push(input.operation ?? "");
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return reply({ summary: input.operation });
    };
    const long = Array.from({ length: 80 }, (_, i) => `Minute ${i}. ${"We talked about the pilot rollout. ".repeat(30)}`);
    check("the fixture is over the map threshold", long.join("\n\n").length > MAP_THRESHOLD_CHARS);
    const d = await analyzeMeetingTranscript(
      "u",
      { paragraphs: long, title: null, startedAtIso: "2026-09-11T17:00:00.000Z", userName: null, attendees: [] },
      { complete, parseJson: JSON.parse }
    );
    const maps = calls.filter((c) => c === "meeting.digest.map").length;
    check("a long meeting is split into map calls", maps > 1, String(maps));
    check("…merged by exactly one reduce, last", calls.filter((c) => c === "meeting.digest.reduce").length === 1 && calls.at(-1) === "meeting.digest.reduce");
    check("…with at most three in flight", maxInFlight <= 3, String(maxInFlight));
    check("…and the reduce's answer is the digest", d.summary === "meeting.digest.reduce");
  }

  {
    const complete: CompleteJsonFn = async () => "not json at all";
    let threw = false;
    try {
      await analyzeMeetingTranscript(
        "u",
        { paragraphs: ["hello"], title: null, startedAtIso: "2026-09-11T17:00:00.000Z", userName: null, attendees: [] },
        {
          complete,
          parseJson: (raw) => {
            try {
              return JSON.parse(raw);
            } catch {
              return null;
            }
          },
        }
      );
    } catch (err) {
      threw = err instanceof Error && /unreadable/.test(err.message);
    }
    check("an unreadable answer is a clear error", threw);
  }

  {
    let threw = false;
    try {
      await analyzeMeetingTranscript(
        "u",
        { paragraphs: ["", "  "], title: null, startedAtIso: "2026-09-11T17:00:00.000Z", userName: null, attendees: [] },
        { complete: async () => reply(), parseJson: JSON.parse }
      );
    } catch (err) {
      threw = err instanceof Error && /Nothing was transcribed/.test(err.message);
    }
    check("an empty transcript is refused before any model call", threw);
  }

  console.log("\nsmoke-meeting-digest: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
