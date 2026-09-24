/**
 * The five filters that stand between "the model noticed something" and "the user has 60
 * unticked checkboxes".
 *
 * Implied next steps are the most valuable thing the capture parse can produce and by far
 * the easiest way to flood somebody. Every rule below exists to make the flood impossible,
 * not to make the noticing clever, so each one gets its own case here.
 *
 * Run: npx tsx scripts/smoke-implied-steps.ts
 */

import {
  impliedStepListSchema,
  parsedImpliedStepSchema,
  type ParsedImpliedStep,
} from "../src/lib/ai-opportunity-schema";
import {
  IMPLIED_AUTO_TICK_CONFIDENCE,
  IMPLIED_MIN_CONFIDENCE,
  MAX_IMPLIED_PER_PERSON,
  validateImpliedNextSteps,
} from "../src/lib/implied-next-steps";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

const NOTES =
  "Coffee with Maya. She mentioned her team is hiring two backend engineers this quarter. " +
  "I said I'd send the deck. She is speaking at the Denver summit in March.";

function step(over: Partial<ParsedImpliedStep>): ParsedImpliedStep {
  return parsedImpliedStepSchema.parse({
    text: "send Maya a referral for the backend roles",
    rationale: "her team is hiring and you know candidates",
    source_excerpt: "her team is hiring two backend engineers this quarter",
    confidence: 0.85,
    ...over,
  });
}

const NO_COLLISIONS = { explicitActionItems: [], commitmentTitles: [] };

console.log("\n1. containment — the model must point at the sentence");

{
  const r = validateImpliedNextSteps([step({})], NOTES, NO_COLLISIONS);
  check("a grounded inference survives", r.steps.length === 1, JSON.stringify(r.rejected));
}
{
  const r = validateImpliedNextSteps(
    [step({ source_excerpt: "she said she would personally hire me" })],
    NOTES,
    NO_COLLISIONS
  );
  check("an ungrounded inference is dropped", r.steps.length === 0);
  check("  and counted", r.rejected.unverifiable === 1);
}
{
  const r = validateImpliedNextSteps([step({ source_excerpt: "" })], NOTES, NO_COLLISIONS);
  check("an empty excerpt is not containment", r.steps.length === 0 && r.rejected.unverifiable === 1);
}

console.log("\n2. confidence floor");

{
  const r = validateImpliedNextSteps([step({ confidence: 0.4 })], NOTES, NO_COLLISIONS);
  check("below the floor is dropped", r.steps.length === 0 && r.rejected.lowConfidence === 1);
}
{
  const r = validateImpliedNextSteps([step({ confidence: IMPLIED_MIN_CONFIDENCE })], NOTES, NO_COLLISIONS);
  check("exactly at the floor is kept", r.steps.length === 1);
}

console.log("\n3. collision with what the note already said");

// THE FAILURE THIS PREVENTS: the person pass and the commitments pass read the same note and
// agree constantly. Without this, every explicit item arrives twice — once ticked as an
// action item, once unticked as an "inference" — which reads as a bug, not as insight.
{
  const r = validateImpliedNextSteps([step({ text: "send the deck" })], NOTES, {
    explicitActionItems: ["Send the deck"],
    commitmentTitles: [],
  });
  check("collides with an explicit action item", r.steps.length === 0 && r.rejected.duplicate === 1);
}
{
  const r = validateImpliedNextSteps([step({ text: "send the deck" })], NOTES, {
    explicitActionItems: [],
    commitmentTitles: ["send the deck to Maya"],
  });
  check("collides with a dated commitment title", r.steps.length === 0 && r.rejected.duplicate === 1);
}
{
  const r = validateImpliedNextSteps([step({}), step({})], NOTES, NO_COLLISIONS);
  check("two identical inferences collapse to one", r.steps.length === 1 && r.rejected.duplicate === 1);
}

console.log("\n4. generic filler");

// These are exactly what `saveNoteBatch` step 3 already creates on its own. An "implied"
// item saying "follow up" is duplication dressed as insight.
{
  const generic = [
    "follow up",
    "Follow up with Maya",
    "stay in touch",
    "keep in touch",
    "check in",
    "reach out",
    "touch base",
    "send her a note",
    "reconnect",
  ];
  for (const text of generic) {
    const r = validateImpliedNextSteps([step({ text })], NOTES, NO_COLLISIONS);
    check(`  "${text}" is filler`, r.steps.length === 0 && r.rejected.generic === 1, JSON.stringify(r.rejected));
  }
}
{
  // Specific enough to be worth saying, even though it starts with a filler-ish verb.
  const r = validateImpliedNextSteps(
    [step({ text: "follow up with two backend candidates for her team" })],
    NOTES,
    NO_COLLISIONS
  );
  check("a SPECIFIC follow-up is not filler", r.steps.length === 1, JSON.stringify(r.rejected));
}

console.log("\n5. per-person cap, ranked by confidence");

// A 20-person note dump producing 60 unticked checkboxes is strictly worse than producing
// none, so the cap is absolute — and what survives is the most confident, not the first.
{
  const many = [
    step({ text: "lowest", confidence: 0.61 }),
    step({ text: "highest", confidence: 0.99 }),
    step({ text: "middle", confidence: 0.8 }),
  ];
  const r = validateImpliedNextSteps(many, NOTES, NO_COLLISIONS);
  check(`capped at ${MAX_IMPLIED_PER_PERSON}`, r.steps.length === MAX_IMPLIED_PER_PERSON);
  check("  the most confident survives", r.steps[0]?.text === "highest", r.steps[0]?.text);
  check("  then the next most confident", r.steps[1]?.text === "middle", r.steps[1]?.text);
  check("  overflow counted", r.rejected.capped === 1, JSON.stringify(r.rejected));
}

console.log("\nauto-tick is a SEPARATE bar from the floor");

// The whole point of the confidence bar: between the floor and the auto-tick bar an item is
// offered but never created. Reusing the explicit-item threshold of 60 — or scoring implied
// items 59 to sneak under it — would couple two unrelated meanings.
{
  const r = validateImpliedNextSteps(
    [step({ text: "a confident one", confidence: 0.9 }), step({ text: "a tentative one", confidence: 0.65 })],
    NOTES,
    NO_COLLISIONS
  );
  const confident = r.steps.find((s) => s.text === "a confident one");
  const tentative = r.steps.find((s) => s.text === "a tentative one");
  check("above the bar auto-ticks", confident?.autoTick === true);
  check("between floor and bar does not", tentative?.autoTick === false);
  check("  but is still offered", tentative !== undefined);
  check(`  the bar (${IMPLIED_AUTO_TICK_CONFIDENCE}) is above the floor (${IMPLIED_MIN_CONFIDENCE})`, IMPLIED_AUTO_TICK_CONFIDENCE > IMPLIED_MIN_CONFIDENCE);
  check("  confidence is carried as 0-100", confident?.confidenceScore === 90, String(confident?.confidenceScore));
}

console.log("\nschema tolerance");

{
  check("null list parses to empty", impliedStepListSchema.parse(null).length === 0);
  check("missing list parses to empty", impliedStepListSchema.parse(undefined).length === 0);
  check("textless entries are dropped", impliedStepListSchema.parse([{ text: "  " }]).length === 0);
  const parsed = impliedStepListSchema.parse([{ text: "do a thing" }]);
  check("a bare entry defaults confidence", parsed[0].confidence === 0.5);
  check("  and rationale to null", parsed[0].rationale === null);
}

// The rationale replaces the date phrase in the review UI, so it has to survive.
{
  const r = validateImpliedNextSteps([step({})], NOTES, NO_COLLISIONS);
  check("rationale is preserved", r.steps[0]?.rationale === "her team is hiring and you know candidates", String(r.steps[0]?.rationale));
  check("excerpt is preserved", r.steps[0]?.sourceExcerpt.includes("hiring two backend engineers"));
}

console.log("\nAll implied next-step checks passed.");
