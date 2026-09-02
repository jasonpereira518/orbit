/**
 * Mention resolution: who "Raj" or "Sarah from Stripe" is, given the user's contacts.
 * Pure — no DB, no AI.
 * Run: npx tsx scripts/smoke-mention-resolution.ts
 */
import { resolveMentions } from "../src/lib/mention-resolution";
import type { DuplicateSubject } from "../src/lib/duplicates";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}
function subject(id: string, fullName: string, company: string | null = null): DuplicateSubject {
  return { id, fullName, company, email: null, linkedinUrl: null, xHandle: null, title: null };
}

const contacts = [
  subject("raj", "Raj Patel", "Acme"),
  subject("sarah-stripe", "Sarah Chen", "Stripe"),
  subject("sarah-other", "Sarah Kim", "Figma"),
  subject("dev", "Dev Patel", null),
  subject("mira", "Mira Okafor", "Stripe"),
];

// 1. Exact unique full name → exact_name.
{
  const { resolved, unresolved } = resolveMentions(contacts, [{ name: "Raj Patel", context: "her cofounder" }]);
  check("exact full name resolves", resolved.length === 1 && resolved[0].contactId === "raj" && resolved[0].matchedBy === "exact_name");
  check("  confidence 0.8", resolved[0].confidence === 0.8);
  check("  nothing unresolved", unresolved.length === 0);
}
// 2. Name + company → name_company at 0.9.
{
  const { resolved } = resolveMentions(contacts, [{ name: "Sarah Chen", context: null, company: "Stripe" }]);
  check("name + company", resolved[0]?.contactId === "sarah-stripe" && resolved[0].matchedBy === "name_company" && resolved[0].confidence === 0.9);
}
// 3. Unique first name → first_name_unique at 0.7.
{
  const { resolved } = resolveMentions(contacts, [{ name: "Mira", context: null }]);
  check("unique first name", resolved[0]?.contactId === "mira" && resolved[0].matchedBy === "first_name_unique" && resolved[0].confidence === 0.7);
}
// 4. Ambiguous first name → unresolved.
{
  const { resolved, unresolved } = resolveMentions(contacts, [{ name: "Sarah", context: "from the panel" }]);
  check("ambiguous first name unresolved", resolved.length === 0 && unresolved.length === 1 && unresolved[0].text === "Sarah");
  check("  context preserved", unresolved[0].context === "from the panel");
}
// 5. Ambiguous first name + company disambiguates.
{
  const { resolved } = resolveMentions(contacts, [{ name: "Sarah", context: null, company: "Figma" }]);
  check("first name + company disambiguates", resolved[0]?.contactId === "sarah-other" && resolved[0].matchedBy === "first_name_unique");
}
// 6. Unknown name → unresolved.
{
  const { resolved, unresolved } = resolveMentions(contacts, [{ name: "Priya Nair", context: null }]);
  check("unknown full name unresolved", resolved.length === 0 && unresolved.length === 1);
}
// 7. Participants are excluded as targets.
{
  const { resolved, unresolved } = resolveMentions(contacts, [{ name: "Raj Patel", context: null }], { excludeContactIds: ["raj"] });
  check("participant excluded", resolved.length === 0 && unresolved.length === 1);
}
// 8. Case/whitespace/punctuation insensitive; duplicates in the input collapse.
{
  const { resolved } = resolveMentions(contacts, [{ name: "  raj PATEL. ", context: null }, { name: "Raj Patel", context: null }]);
  check("normalized + deduped", resolved.length === 1 && resolved[0].contactId === "raj");
}
// 9. Two contacts with the same full name and no company on the mention → unresolved.
{
  const dupes = [...contacts, subject("raj2", "Raj Patel", "Globex")];
  const { resolved, unresolved } = resolveMentions(dupes, [{ name: "Raj Patel", context: null }]);
  check("duplicate full names unresolved without company", resolved.length === 0 && unresolved.length === 1);
  const withCo = resolveMentions(dupes, [{ name: "Raj Patel", context: null, company: "Globex" }]);
  check("  company picks one", withCo.resolved[0]?.contactId === "raj2");
}
// 10. Two contacts with the same full name AND company → ambiguous even with company.
{
  const twins = [...contacts, subject("raj-twin", "Raj Patel", "Acme")];
  const { resolved, unresolved } = resolveMentions(twins, [{ name: "Raj Patel", context: null, company: "Acme" }]);
  check("tied name+company candidates unresolved", resolved.length === 0 && unresolved.length === 1);
}

// 11. A nameless candidate is dropped, not thrown on. The people pass can emit a
//     `presence: "mentioned"` entry with a blank or null name; one bad row must not take
//     the whole parse down.
{
  let threw = false;
  let out: ReturnType<typeof resolveMentions> | null = null;
  try {
    out = resolveMentions(contacts, [
      { name: "", context: null },
      { name: null as unknown as string, context: "no name at all" },
    ]);
  } catch {
    threw = true;
  }
  check("nameless candidates do not throw", !threw);
  check("  and produce no output", out !== null && out.resolved.length === 0 && out.unresolved.length === 0, JSON.stringify(out));
}

console.log("\nsmoke-mention-resolution: all checks passed");
