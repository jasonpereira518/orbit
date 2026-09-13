/**
 * Criteria are the contract between the brief, the search, and the ranking. These pin the
 * normalization (bad model output must degrade to "fewer criteria", never to a crash or a
 * silently merged required/preferred list) and the brief → criteria call.
 *
 * Run: npx tsx scripts/smoke-outreach-criteria.ts
 */
import { EMPTY_CRITERIA, briefSchema, criteriaFromBrief, hasAnyCriteria, listCriteria, normalizeCriteria } from "../src/lib/outreach/criteria";
import { parseJsonObject } from "../src/lib/outreach/json";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  check("parses fenced JSON", (parseJsonObject("```json\n{\"a\":1}\n```") as { a: number })?.a === 1);
  check("parses JSON with a preamble", (parseJsonObject("Here: {\"a\":2} thanks") as { a: number })?.a === 2);
  check("returns null for garbage", parseJsonObject("nope") === null);

  const normalized = normalizeCriteria({
    required: [
      { kind: "role", label: " Head of Partnerships ", values: ["Head of Partnerships", "", "VP Partnerships"] },
      { kind: "wizard", label: "Bad kind", values: ["x"] },
      { kind: "organization", label: "", values: ["Stripe"] },
    ],
    preferred: [
      { kind: "geography", label: "Bay Area", values: ["San Francisco"], priority: 9 },
      { kind: "experience", label: "Fintech", values: ["payments"], priority: 2 },
    ],
    exclusions: "not an array",
  });
  check("invalid criteria are dropped, valid ones kept", normalized.required.length === 1, JSON.stringify(normalized.required));
  check("labels and values are trimmed; empty values removed",
    normalized.required[0]?.label === "Head of Partnerships" && normalized.required[0]?.values.length === 2);
  check("every criterion gets an id", normalized.required.every((c) => c.id.length > 0));
  check("preferred priority follows array order", normalized.preferred.map((c) => c.priority).join(",") === "0,1");
  check("a non-array group becomes empty", normalized.exclusions.length === 0);
  check("ids are unique across groups",
    new Set(listCriteria(normalized).map((e) => e.criterion.id)).size === listCriteria(normalized).length);
  check("empty criteria has none", !hasAnyCriteria(EMPTY_CRITERIA));
  check("normalizeCriteria(null) is empty", !hasAnyCriteria(normalizeCriteria(null)));

  check("brief requires a real purpose", !briefSchema.safeParse({ purpose: "hi", desiredOutcome: "intro" }).success);
  check("brief accepts a real one",
    briefSchema.safeParse({ purpose: "Meet fintech partnership leads in NYC", desiredOutcome: "Three intro calls" }).success);

  const brief = { purpose: "Meet partnership leads at fintech startups in New York", desiredOutcome: "Three intro calls" };
  let seen: { operation?: string; user?: string } = {};
  const fromAi = await criteriaFromBrief("u1", brief, async (_userId, input) => {
    seen = input;
    return JSON.stringify({
      required: [{ kind: "role", label: "Partnerships", values: ["Head of Partnerships"] }],
      preferred: [{ kind: "geography", label: "New York", values: ["New York"] }],
      exclusions: [{ kind: "organization", label: "Big banks", values: ["JPMorgan"] }],
    });
  });
  check("AI criteria are used", fromAi.source === "ai" && fromAi.criteria.required.length === 1);
  check("the call is labelled for telemetry", seen.operation === "outreach.criteria");
  check("the brief reaches the prompt", Boolean(seen.user?.includes("partnership leads")));

  const fallback = await criteriaFromBrief("u1", brief, async () => "I cannot help with that");
  check("unparseable output falls back to empty criteria", fallback.source === "fallback" && !hasAnyCriteria(fallback.criteria));
  const thrown = await criteriaFromBrief("u1", brief, async () => {
    throw new Error("no key");
  });
  check("a thrown completer falls back too", thrown.source === "fallback");

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll outreach criteria checks passed.");
}

main();
