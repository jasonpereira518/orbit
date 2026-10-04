/**
 * Validation is where the engine stops trusting the model. The load-bearing case: "next
 * Friday" said on 2024-03-12 must resolve to 2024-03-15 (a date in the PAST relative to
 * today), not to a Friday next week.
 *
 * Run: npx tsx scripts/smoke-relationship-validate.ts
 */
import "./smoke/_env";
import { buildWindow } from "../src/lib/relationship-engine/gather";
import { parseDigestAnswer } from "../src/lib/relationship-engine/extract";
import { locateExcerpt, validateDigest } from "../src/lib/relationship-engine/validate";
import type { WindowMessage } from "../src/lib/relationship-engine/types";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const rows: WindowMessage[] = [
  { interactionId: "00000000-0000-4000-8000-000000000001", at: new Date("2024-03-12T15:00:00Z"), direction: "in", speaker: "Maya", text: "Can you send me the deck by next Friday? Also I just joined Ramp as Head of Growth." },
  { interactionId: "00000000-0000-4000-8000-000000000002", at: new Date("2024-03-13T15:00:00Z"), direction: "out", speaker: "Me", text: "Sure, I'll send the deck. Let's grab coffee when you're back in NYC." },
];
const window = buildWindow("c1", rows, ["linkedin"])!;

check("locate: exact excerpt", locateExcerpt(window, "send the deck")?.interactionId === rows[1].interactionId);
check("locate: whitespace-insensitive", locateExcerpt(window, "send  me the\ndeck by next Friday")?.interactionId === rows[0].interactionId);
check("locate: invented excerpt → null", locateExcerpt(window, "wire the money") === null);

const v = validateDigest(
  parseDigestAnswer(
    JSON.stringify({
      what_they_do: "Head of Growth at Ramp",
      job_change: { company: "Ramp", title: "Head of Growth", excerpt: "I just joined Ramp as Head of Growth" },
      summary: "s",
      topics: ["deck"],
      facts: [
        { text: "Joined Ramp", excerpt: "I just joined Ramp" },
        { text: "Invented", excerpt: "she loves sailing" },
      ],
      commitments: [
        { title: "Send Maya the deck", owed_by: "me", raw_date_phrase: "next Friday", date: "", date_kind: "relative", year_stated: false, kind: "email", confidence: 0.9, excerpt: "Can you send me the deck by next Friday?" },
        { title: "Invented date", owed_by: "me", raw_date_phrase: "June 3", date: "2024-06-03", date_kind: "absolute", year_stated: false, kind: null, confidence: 0.9, excerpt: "wire the money June 3" },
      ],
      implied: [
        { text: "Coffee in NYC", owed_by: null, within_days: null, confidence: 0.7, excerpt: "Let's grab coffee when you're back in NYC" },
        { text: "Weak guess", owed_by: null, within_days: null, confidence: 0.4, excerpt: "Sure, I'll send the deck" },
      ],
      closed: [
        { key: "known-key", excerpt: "Sure, I'll send the deck" },
        { key: "unknown-key", excerpt: "Sure, I'll send the deck" },
      ],
    })
  ),
  window,
  new Set(["known-key"])
);

check("facts: invented excerpt dropped", v.facts.length === 1 && v.facts[0] === "Joined Ramp");
check("dated: one survives", v.dated.length === 1, JSON.stringify(v.dated));
check("dated: anchored to its message (2024-03-15)", v.dated[0].dueDate.toISOString().slice(0, 10) === "2024-03-15", v.dated[0].dueDate.toISOString());
check("dated: messageAt is the asking message", v.dated[0].interactionId === rows[0].interactionId);
check("dated: confidence 0–100", v.dated[0].confidence === 90);
check("undated: implied over the floor kept, under dropped", v.undated.length === 1 && v.undated[0].origin === "implied");
check("closed: only known keys", v.closedKeys.length === 1 && v.closedKeys[0] === "known-key");
check("job change: contact's own message", v.jobChange?.company === "Ramp");

const notTheirs = validateDigest(
  parseDigestAnswer(JSON.stringify({ summary: "s", job_change: { company: "Ramp", title: null, excerpt: "Sure, I'll send the deck" } })),
  window,
  new Set()
);
check("job change: excerpt from Me → dropped", notTheirs.jobChange === null);

console.log("\nsmoke-relationship-validate: all checks passed");
