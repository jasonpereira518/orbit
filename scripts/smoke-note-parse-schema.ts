/**
 * The people-pass zod schemas must accept model output that omits the new fields (older
 * prompts, terse models) and default them, so the capture path never throws on shape.
 * Run: npx tsx scripts/smoke-note-parse-schema.ts
 */
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-note-parse-schema";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-note-parse-schema";

import { multiPersonNoteParseSchema } from "../src/lib/ai";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const minimalPerson = { name: "Sarah Chen", source_excerpt: "Coffee with Sarah." };
{
  const parsed = multiPersonNoteParseSchema.parse({ people: [minimalPerson] });
  check("presence defaults to participant", parsed.people[0].presence === "participant");
  check("mentions default to []", Array.isArray(parsed.mentions) && parsed.mentions.length === 0);
}
{
  const parsed = multiPersonNoteParseSchema.parse({
    people: [{ ...minimalPerson, presence: "mentioned" }],
    mentions: [{ name: "Raj", context: "her cofounder" }, { name: "Mira", context: null, near_person: "Sarah Chen" }],
  });
  check("presence mentioned round-trips", parsed.people[0].presence === "mentioned");
  check("mentions parsed", parsed.mentions.length === 2 && parsed.mentions[0].near_person === null && parsed.mentions[1].near_person === "Sarah Chen");
}
{
  const parsed = multiPersonNoteParseSchema.parse({ people: [{ ...minimalPerson, presence: "bogus" }] });
  check("unknown presence falls back to participant", parsed.people[0].presence === "participant");
}
console.log("\nsmoke-note-parse-schema: all checks passed");
