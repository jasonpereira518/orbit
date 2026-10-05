/**
 * The note window: the model reads the part of a note that answers the question.
 *
 * The bug this pins is the one where retrieval is right and the answer is wrong. A contact
 * ranks first because their note mentions "Series A" — and the prompt then carried
 * `notes.slice(0, 1200)`, which for a long note is 1,200 characters that never say it. The
 * model answers that it has nothing on that, about the person it just surfaced BECAUSE of
 * that sentence.
 *
 * Also pins the two ways this could go wrong quietly: a short note must come through
 * untouched (the old behaviour for the overwhelming majority of notes), and a query with no
 * content words must fall back to the head rather than to an arbitrary window.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-note-window.ts
 */
import { pickNoteWindow } from "../src/lib/note-window";
import { budgetContactsContext } from "../src/lib/chat-retrieval";
import type { RankedContact } from "../src/lib/hybrid-search";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const FILLER =
  "We met at the conference and talked about nothing in particular for a while. " +
  "The weather was fine and the coffee was bad. ";

/** A note with the interesting sentence buried well past any head slice. */
function noteWithBuriedFact(fact: string, depth: number): string {
  let head = "";
  while (head.length < depth) head += FILLER;
  return `${head}${fact} ${FILLER.repeat(4)}`;
}

// --- the buried fact -------------------------------------------------------------------

const buried = noteWithBuriedFact("She is raising a Series A for her fintech startup.", 3000);
check(
  "the fixture really does bury the fact past the old 1200-char head slice",
  buried.indexOf("Series A") > 1200,
  `index ${buried.indexOf("Series A")}`
);
check(
  "the old behaviour would have missed it",
  !buried.slice(0, 1200).includes("Series A")
);

const window = pickNoteWindow(buried, "who is raising a Series A?", 1200);
check("the window contains the buried fact", window.text.includes("Series A"), window.text.slice(0, 120));
check("the window is marked as not starting at the head", window.text.startsWith("…"), window.text.slice(0, 40));
check("the window reports a non-zero offset", window.offset > 0, String(window.offset));
check("the window counts the terms it matched", window.matched > 0, String(window.matched));
check(
  "the window never exceeds the budget it was given",
  window.text.length <= 1200,
  String(window.text.length)
);

// --- the cases that must behave exactly as before ---------------------------------------

const short = "Met at On Deck. Runs platform at Ramp.";
const shortWindow = pickNoteWindow(short, "who works at Ramp?", 1200);
check("a note shorter than the budget comes through whole", shortWindow.text === short, shortWindow.text);
check("a short note is not marked with an ellipsis", !shortWindow.text.startsWith("…"));

const stopwordsOnly = pickNoteWindow(buried, "who do I know?", 1200);
check(
  "a query of nothing but stopwords falls back to the head",
  stopwordsOnly.offset === 0 && !stopwordsOnly.text.startsWith("…"),
  String(stopwordsOnly.offset)
);

const noMatch = pickNoteWindow(buried, "kubernetes migration timeline", 1200);
check(
  "a query that matches nothing falls back to the head rather than an arbitrary window",
  noMatch.offset === 0 && noMatch.matched === 0,
  `offset ${noMatch.offset}, matched ${noMatch.matched}`
);

check("an empty note yields an empty window", pickNoteWindow("", "anything", 1200).text === "");
check("a null note yields an empty window", pickNoteWindow(null, "anything", 1200).text === "");

// --- the window reaches the budgeted contact, which is what the prompt renders -----------

function rankedContact(notes: string): RankedContact {
  return {
    id: "c1",
    fullName: "Priya Raman",
    preferredName: null,
    company: "Fintech Co",
    school: null,
    title: "Founder",
    location: null,
    email: null,
    industry: null,
    notes,
    aiSummary: null,
    keyFacts: [],
    opportunities: [],
    relationshipScore: 50,
    priorityLevel: 3,
    closenessTier: null,
    tags: [],
    rrfScore: 1,
    relevance: 1,
    matchedArms: [],
    filterMatched: true,
  } as RankedContact;
}

const budgeted = budgetContactsContext(
  [rankedContact(buried)],
  new Map(),
  new Map(),
  "who is raising a Series A?"
);
check(
  "budgetContactsContext carries the windowed note, not the head",
  budgeted[0].notes?.includes("Series A") === true,
  (budgeted[0].notes ?? "").slice(0, 120)
);

// The eval harness and two older smoke scripts call this with three arguments. That path
// must keep doing exactly what it did, or a behaviour change hides inside a measurement.
const budgetedNoQuery = budgetContactsContext([rankedContact(buried)], new Map());
check(
  "with no query the old head-slice behaviour is preserved exactly",
  budgetedNoQuery[0].notes === buried.slice(0, 1200),
  (budgetedNoQuery[0].notes ?? "").slice(0, 80)
);

console.log(failures === 0 ? "\nsmoke-note-window: all checks passed" : `\nsmoke-note-window: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
