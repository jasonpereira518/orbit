/**
 * Pins the scoring rules `scripts/eval-ai.ts` gates model changes on. If these drift, a
 * cheaper model could "pass" by the scorer getting laxer rather than the model being good.
 *
 * No DB, no network. Run: npx tsx scripts/smoke-eval-ai-score.ts
 */
import {
  characterErrorRate,
  count,
  gate,
  mentions,
  rate,
  sameField,
  sameName,
  scoreResearchAnswer,
  tally,
  wordErrorRate,
} from "./lib/eval-ai-score";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("Names");
check("exact name", sameName("Priya Raman", "Priya Raman"));
check("case and accents", sameName("Chloe Dubois", "CHLOÉ DUBOIS"));
check("a dropped letter still matches", sameName("Siobhan OBriain", "Siobhan OBrian"));
check("a middle initial the fixture left out", sameName("Priya Raman", "Priya K. Raman"));
check("a first name alone does not", !sameName("Priya Raman", "Priya"));
check("a different surname does not", !sameName("Priya Raman", "Priya Ramaswamy"));
check("a different person does not", !sameName("Marcus Lee", "Marisol Vega"));
check("null never matches", !sameName("Priya Raman", null));

console.log("\nFields");
check("longer actual containing expected", sameField("Staff Engineer", "Staff Engineer, Payments"));
check("shorter actual contained in expected", sameField("Larkspur Robotics", "Larkspur"));
check("case-insensitive", sameField("stripe", "Stripe"));
check("empty actual is wrong", !sameField("Larkspur", ""));
check("unrelated value is wrong", !sameField("Larkspur Robotics", "Quillfeather Bank"));

console.log("\nMentions");
check("found inside a sentence", mentions("You could ask Priya Raman at Larkspur.", "priya raman"));
check("absent", !mentions("You could ask Marcus.", "Priya Raman"));
check("an email survives normalization", mentions("write to priya@larkspur.example today", "Priya@Larkspur.example"));
check("empty needle never matches", !mentions("anything", ""));

console.log("\nError rates");
check("identical text has zero CER", characterErrorRate("Met Ada at Larkspur", "met ada at larkspur") === 0);
check("one wrong character in ten", Math.abs(characterErrorRate("abcdefghij", "abcdefghiX") - 0.1) < 1e-9);
check("identical text has zero WER", wordErrorRate("coffee with Ada on Tuesday", "Coffee with Ada on Tuesday.") === 0);
check("one wrong word in five", Math.abs(wordErrorRate("coffee with ada on tuesday", "coffee with ida on tuesday") - 0.2) < 1e-9);
check("nothing heard is a full error", wordErrorRate("coffee with ada", "") === 1);

console.log("\nTallies");
const t = tally();
count(t, true);
count(t, false);
check("hit rate", rate(t) === 0.5);
check("nothing scored is null, not zero", rate(tally()) === null);

console.log("\nThe gate");
const rules = {
  capture: { personRecall: { maxDrop: 0.02 }, phantomParticipants: { maxRise: 0 } },
  ocr: { cer: { maxRise: 0.02 } },
};
check(
  "a drop within tolerance passes",
  gate(rules, { capture: { personRecall: 0.9 } }, { capture: { personRecall: 0.88 } }).length === 0
);
check(
  "a drop past tolerance fails",
  gate(rules, { capture: { personRecall: 0.9 } }, { capture: { personRecall: 0.87 } }).length === 1
);
check(
  "one invented participant fails a zero-rise rule",
  gate(rules, { capture: { phantomParticipants: 0 } }, { capture: { phantomParticipants: 1 } }).length === 1
);
check(
  "an error rate rising past tolerance fails",
  gate(rules, { ocr: { cer: 0.03 } }, { ocr: { cer: 0.06 } }).length === 1
);
check(
  "an improvement never fails",
  gate(rules, { capture: { personRecall: 0.8 }, ocr: { cer: 0.1 } }, { capture: { personRecall: 0.95 }, ocr: { cer: 0.02 } }).length === 0
);
check(
  "a task only one side ran is skipped, not failed",
  gate(rules, { capture: { personRecall: 0.9 } }, {}).length === 0
);

// --- scoreResearchAnswer ---------------------------------------------------------------

const JAMES = { id: "c-james", fullName: "James Okafor" };
const TOM = { id: "c-tom", fullName: "Tomás Rivera" };
const KNOWN = new Set(["c-james", "c-tom", "c-maya"]);
const baseScore = {
  mustMention: [JAMES],
  mustSay: ["treasury"],
  forbidden: ["Series A"],
  knownContactIds: KNOWN,
};

const good = scoreResearchAnswer({
  ...baseScore,
  answer: "James Okafor said Sequoia is leading a seed round for an SMB treasury startup (12 Mar).",
  rawRecommendationIds: ["c-james"],
  keptRecommendationIds: ["c-james"],
});
check("a named person and a stated note fact both count", good.mentioned[0] && good.said[0]);
check("no forbidden claim, no invented id", good.forbiddenHits === 0 && good.inventedIds === 0);

const byRecommendation = scoreResearchAnswer({
  ...baseScore,
  answer: "Your best lead on this is below.",
  rawRecommendationIds: ["c-james"],
  keptRecommendationIds: ["c-james"],
});
check("a person counts as mentioned through a recommendation that survived the filter", byRecommendation.mentioned[0]);

const droppedByFilter = scoreResearchAnswer({
  ...baseScore,
  answer: "Your best lead on this is below.",
  rawRecommendationIds: ["c-james"],
  keptRecommendationIds: [],
});
check(
  "a recommendation the filter dropped reached nobody, so it does not count",
  droppedByFilter.mentioned[0] === false
);
check("and it is reported as filtered, not invented — the id is real", droppedByFilter.filteredOut === 1 && droppedByFilter.inventedIds === 0);

const invented = scoreResearchAnswer({
  ...baseScore,
  answer: "James Okafor.",
  rawRecommendationIds: ["c-james", "c-does-not-exist"],
  keptRecommendationIds: ["c-james"],
});
check("an id that is none of the user's contacts is counted as invented", invented.inventedIds === 1, String(invented.inventedIds));

const unsupported = scoreResearchAnswer({
  ...baseScore,
  answer: "James Okafor is leading a Series A in SMB treasury.",
  rawRecommendationIds: [],
  keptRecommendationIds: [],
});
check("a claim the notes do not support is a forbidden hit", unsupported.forbiddenHits === 1);

const missedFact = scoreResearchAnswer({
  ...baseScore,
  mustMention: [JAMES, TOM],
  answer: "James Okafor is leading a seed round.",
  rawRecommendationIds: [],
  keptRecommendationIds: [],
});
check(
  "each person and each fact is scored on its own",
  missedFact.mentioned.join() === "true,false" && missedFact.said.join() === "false",
  JSON.stringify(missedFact)
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll eval scoring checks passed.");
process.exit(0);
