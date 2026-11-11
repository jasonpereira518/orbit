import {
  deduplicateSegments,
  groupSegmentsIntoParagraphs,
  trimBoundaryOverlap,
  formatTranscriptParagraph,
} from "@/lib/transcript-paragraphs";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok   ${msg}`);
}

console.log("\ntrimBoundaryOverlap");
assert(
  trimBoundaryOverlap("I think we should", "we should definitely start") === "definitely start",
  "trims 2 overlapping words"
);
assert(
  trimBoundaryOverlap("Hello there world", "world let us go") === "let us go",
  "trims 1 overlapping word"
);
assert(
  trimBoundaryOverlap("No overlap here", "Completely different text") === "Completely different text",
  "preserves text with no overlap"
);
assert(
  trimBoundaryOverlap("punctuation at end.", "end is here") === "is here",
  "ignores punctuation during overlap comparison"
);

console.log("\ndeduplicateSegments");
const rawSegments = [
  { seq: 1, startMs: 0, endMs: 2000, speaker: "you", text: "Hello everyone." },
  { seq: 2, startMs: 2100, endMs: 4000, speaker: "you", text: "Hello everyone." }, // duplicate
  { seq: 3, startMs: 4100, endMs: 6000, speaker: "you", text: "Thanks for coming." },
  { seq: 4, startMs: 6100, endMs: 8000, speaker: "you", text: "Thanks for coming today." }, // prefix overlap
  { seq: 5, startMs: 8500, endMs: 11000, speaker: "speaker-1", text: "Great to be here." },
];
const deduped = deduplicateSegments(rawSegments);
assert(deduped.length === 3, "drops duplicate and overlaps");
assert(deduped[0]?.text === "Hello everyone.", "keeps first utterance");
assert(deduped[1]?.text === "Thanks for coming today.", "keeps expanded revision");
assert(deduped[2]?.speaker === "speaker-1", "keeps subsequent speaker");

console.log("\ngroupSegmentsIntoParagraphs");
const meetingSegments = [
  { seq: 1, startMs: 1000, endMs: 3000, speaker: "you", text: "Hi team," },
  { seq: 2, startMs: 3200, endMs: 5000, speaker: "you", text: "welcome to the weekly sync." },
  { seq: 3, startMs: 5200, endMs: 7000, speaker: "you", text: "We have three main topics today." },
  // Speaker switch
  { seq: 4, startMs: 8000, endMs: 10000, speaker: "speaker-1", text: "Hey Jason." },
  { seq: 5, startMs: 10200, endMs: 12500, speaker: "speaker-1", text: "I have the Q3 metrics ready to present." },
  // Speaker switch back
  { seq: 6, startMs: 13000, endMs: 15000, speaker: "you", text: "Awesome, let's start with those metrics." },
  // Long pause (8 seconds) from same speaker -> splits into new paragraph
  { seq: 7, startMs: 23500, endMs: 26000, speaker: "you", text: "Also, please keep an eye on the chat for links." },
];

const names = new Map([
  ["you", "You"],
  ["speaker-1", "Sarah"],
]);

const paragraphs = groupSegmentsIntoParagraphs(meetingSegments, names);
assert(paragraphs.length === 4, "groups into 4 coherent paragraphs");

assert(paragraphs[0]?.speaker === "you", "paragraph 0 is from 'you'");
assert(paragraphs[0]?.speakerName === "You", "paragraph 0 has display name 'You'");
assert(
  paragraphs[0]?.text === "Hi team, welcome to the weekly sync. We have three main topics today.",
  "paragraph 0 combines 3 short utterances into one continuous sentence"
);
assert(paragraphs[0]?.startMs === 1000 && paragraphs[0]?.endMs === 7000, "paragraph 0 spans start to end");

assert(paragraphs[1]?.speaker === "speaker-1", "paragraph 1 is Sarah");
assert(paragraphs[1]?.speakerName === "Sarah", "paragraph 1 display name is Sarah");
assert(
  paragraphs[1]?.text === "Hey Jason. I have the Q3 metrics ready to present.",
  "paragraph 1 combines Sarah's utterances"
);

assert(paragraphs[2]?.speaker === "you", "paragraph 2 is You");
assert(paragraphs[2]?.text === "Awesome, let's start with those metrics.", "paragraph 2 text is correct");

assert(paragraphs[3]?.speaker === "you", "paragraph 3 is You after long pause");
assert(paragraphs[3]?.startMs === 23500, "paragraph 3 starts at timestamp after pause");
assert(paragraphs[3]?.text === "Also, please keep an eye on the chat for links.", "paragraph 3 text is correct");

console.log("\nformatTranscriptParagraph");
assert(
  formatTranscriptParagraph(paragraphs[1]!) === "Sarah: Hey Jason. I have the Q3 metrics ready to present.",
  "formats with Speaker: text"
);

console.log("\nAll transcript paragraph checks passed!\n");
