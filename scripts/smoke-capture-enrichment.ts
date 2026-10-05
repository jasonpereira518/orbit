/**
 * The richer half of a captured person: schema tolerance, verbatim checks on connections
 * and promises, handle normalisation, and what reaches the contact's key facts.
 * Run: npx tsx scripts/smoke-capture-enrichment.ts
 */
import { z } from "zod";
import {
  cleanLines,
  cleanWork,
  enrichmentKeyFacts,
  normalizePhone,
  normalizeWebsite,
  normalizeXHandle,
  personEnrichmentFields,
  promiseReminderTitle,
  promisesNeedingReminders,
  summaryToTakeaways,
  takeawaysToSummary,
  validateConnections,
  validatePromises,
} from "../src/lib/capture/person-enrichment";

function check(label: string, condition: boolean, detail?: unknown) {
  if (!condition) throw new Error(`${label} failed${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok  ${label}`);
}

const schema = z.object(personEnrichmentFields);

// --- schema tolerance ----------------------------------------------------------------
{
  const old = schema.parse({});
  check("a person parsed before these fields existed still parses", old.takeaways === undefined && old.promises === undefined);
  const messy = schema.parse({
    takeaways: ["one", 2, null, "three"],
    connections: [{ name: "Raj", relation: "cofounder", source_excerpt: "x" }, { relation: "no name" }, "junk"],
    promises: [{ direction: "sideways", text: "send deck", source_excerpt: "y" }, { direction: "they_owe", text: "intro", source_excerpt: "z" }],
    work: "not an object",
  });
  check("non-strings are dropped from a string list, not fatal", messy.takeaways?.join() === "one,three");
  check("a malformed connection costs one connection", messy.connections?.length === 1);
  check("an unknown promise direction parses as null", messy.promises?.[0]?.direction === null);
  check("a work field of the wrong shape becomes null", messy.work === null);
}

// --- lines ---------------------------------------------------------------------------
check("bullets the model typed are stripped", cleanLines(["• a", "- b", "1. c", "* d"], 6).join() === "a,b,c,d");
check("blanks and repeats are dropped", cleanLines([" ", "Same", "same "], 6).join() === "Same");
check("takeaways cap", cleanLines(["a", "b", "c", "d", "e", "f", "g"], 6).length === 6);
check("summary ↔ takeaways round-trips", summaryToTakeaways(takeawaysToSummary(["a", "b"])).join() === "a,b");
check("a one-line legacy summary becomes one takeaway", summaryToTakeaways("Great chat about infra.").length === 1);
check("no takeaways → no summary", takeawaysToSummary([]) === null);

// --- handles -------------------------------------------------------------------------
check("x handle from @", normalizeXHandle("@jdoe") === "jdoe");
check("x handle from a URL", normalizeXHandle("https://x.com/jdoe") === "jdoe");
check("x handle rejects prose", normalizeXHandle("she's on twitter") === null);
check("phone keeps formatting", normalizePhone("(415) 555-0199") === "(415) 555-0199");
check("phone needs seven digits", normalizePhone("555-01") === null);
check("website gets a scheme", normalizeWebsite("maya.dev") === "https://maya.dev");
check("a LinkedIn URL is not a website", normalizeWebsite("linkedin.com/in/maya") === null);
check("website rejects prose", normalizeWebsite("her blog") === null);

// --- verbatim ------------------------------------------------------------------------
const notes = `Coffee with Maya Chen. She works with Raj Patel on the infra team.
She said she'd send me the hiring doc by Friday. I promised to intro her to Leo.`;
{
  const connections = validateConnections(
    [
      { name: "Raj Patel", relation: "works with", source_excerpt: "She works with Raj Patel on the infra team." },
      { name: "Priya", relation: "manager", source_excerpt: "Her manager Priya approved it." },
      { name: "Maya Chen", relation: "self", source_excerpt: "Coffee with Maya Chen." },
      { name: "raj patel", relation: "dup", source_excerpt: "She works with Raj Patel on the infra team." },
    ],
    notes,
    "Maya Chen"
  );
  check("a connection with a verbatim excerpt is kept", connections.some((c) => c.name === "Raj Patel"));
  check("an invented connection is dropped", !connections.some((c) => c.name === "Priya"));
  check("a person is never their own connection", !connections.some((c) => c.name === "Maya Chen"));
  check("connections dedupe by name", connections.length === 1);
}
{
  const promises = validatePromises(
    [
      { direction: "they_owe", text: "send me the hiring doc", due_phrase: "by Friday", source_excerpt: "She said she'd send me the hiring doc by Friday." },
      { direction: "you_owe", text: "intro her to Leo", due_phrase: null, source_excerpt: "I promised to intro her to Leo." },
      { direction: "you_owe", text: "buy her lunch", due_phrase: null, source_excerpt: "I owe her lunch." },
      { direction: null, text: "something", due_phrase: null, source_excerpt: "Coffee with Maya Chen." },
    ],
    notes
  );
  check("verbatim promises in both directions are kept", promises.length === 2);
  check("an unverifiable promise is dropped", !promises.some((p) => p.text === "buy her lunch"));
  check("a direction-less promise is dropped", !promises.some((p) => p.text === "something"));

  const needed = promisesNeedingReminders(promises, ["Intro her to Leo"]);
  check("a promise another pass already drafted gets no second reminder", needed.length === 1 && needed[0]!.direction === "they_owe");
  check("they-owe reminder says who you're waiting on", promiseReminderTitle(needed[0]!, "Maya Chen") === "Waiting on Maya Chen: send me the hiring doc");
  check("you-owe reminder is the task itself", promiseReminderTitle(promises[1]!, "Maya") === "Intro her to Leo");
}

// --- key facts -----------------------------------------------------------------------
{
  const facts = enrichmentKeyFacts({
    personal_details: ["Training for the Chicago marathon"],
    work: cleanWork({ team: "Infra", building: null, priorities: ["hiring"], hiring: "two backend engineers", looking_for: null }),
    connections: [{ name: "Raj Patel", relation: "works with", source_excerpt: "" }],
  });
  check("key facts are labelled by kind", facts.join("|") === "Personal: Training for the Chicago marathon|Team: Infra|Priority: hiring|Hiring: two backend engineers|Knows: Raj Patel (works with)");
  check("an all-empty work block is null", cleanWork({ team: " ", priorities: [] }) === null);
}

console.log("\nsmoke-capture-enrichment: all checks passed");
