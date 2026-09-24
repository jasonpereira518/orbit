/**
 * Mention resolution: who "Raj" or "Sarah from Stripe" is, given the user's contacts.
 * Pure — no DB, no AI.
 * Run: npx tsx scripts/smoke-mention-resolution.ts
 */
import { resolveMentions, resolveMentionsWithPicks } from "../src/lib/mention-resolution";
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

// 12. `@`-picks: chosen from a menu, so never re-litigated — and never double-counted.
{
  const picked = resolveMentionsWithPicks(contacts, [], [{ id: "mira", name: "Mira" }]);
  check("a pick resolves to exactly who was picked", picked.resolved.length === 1 && picked.resolved[0].contactId === "mira");
  check("  marked user_pick, at full confidence", picked.resolved[0].matchedBy === "user_pick" && picked.resolved[0].confidence === 1);
}
// An id that is not in the subject list is not the caller's — forged, or a contact deleted
// between the pick and the save. Either way there is nobody to link to.
{
  const forged = resolveMentionsWithPicks(contacts, [], [{ id: "someone-elses-contact", name: "Mallory" }]);
  check("a pick for a contact the user does not own is dropped", forged.resolved.length === 0 && forged.unresolved.length === 0);
}
// The reason picked names leave the fuzzy pool: both would resolve, and the two rows then
// collapse under the unique index on `interaction_mentions` — so the save reports two
// mentions and writes one.
{
  const both = resolveMentionsWithPicks(
    contacts,
    [{ name: "Mira", context: "came up again later" }],
    [{ id: "mira", name: "Mira" }]
  );
  check("a picked name is not also matched by the fuzzy pass", both.resolved.length === 1, JSON.stringify(both.resolved));
  check("  and it is the pick that survives", both.resolved[0].matchedBy === "user_pick");
}
// The token may be a disambiguated variant; the note spells the person's real name. Both
// have to leave the pool or the second one comes back as a separate mention.
{
  const variant = resolveMentionsWithPicks(
    contacts,
    [{ name: "Mira Okafor", context: null }],
    [{ id: "mira", name: "Mira (Stripe)" }]
  );
  check("the contact's real name leaves the pool too", variant.resolved.length === 1 && variant.resolved[0].matchedBy === "user_pick");
}
// Everything the user did NOT point at still goes through the ordinary tiers.
{
  const mixed = resolveMentionsWithPicks(
    contacts,
    [{ name: "Raj Patel", context: null }],
    [{ id: "mira", name: "Mira" }]
  );
  check("unpicked names still resolve normally", mixed.resolved.length === 2);
  check("  picks first", mixed.resolved[0].contactId === "mira" && mixed.resolved[1].matchedBy === "exact_name");
}
// A pick who turned out to be a PARTICIPANT of this batch is not also a mention of it —
// otherwise the review screen offers them as "also mentioned" while they are standing on
// their own card above it, and `saveNoteBatch` would drop the row regardless.
{
  const participant = resolveMentionsWithPicks(contacts, [], [{ id: "raj", name: "Raj Patel" }], {
    excludeContactIds: ["raj"],
  });
  check("a pick who became a participant is not also a mention", participant.resolved.length === 0 && participant.unresolved.length === 0);
}
// ...but their name still leaves the fuzzy pool. Dropping the pick and then letting the
// tiers have another go at the same name is how the participant comes back as a mention of
// themselves by the back door.
{
  const participant = resolveMentionsWithPicks(
    contacts,
    [{ name: "Raj Patel", context: "he said" }],
    [{ id: "raj", name: "Raj Patel" }],
    { excludeContactIds: ["raj"] }
  );
  check("  and the prose does not bring them back as one", participant.resolved.length === 0 && participant.unresolved.length === 0, JSON.stringify(participant));
}
// Picking the same person twice (two tokens, one contact) is one link.
{
  const twice = resolveMentionsWithPicks(contacts, [], [
    { id: "mira", name: "Mira" },
    { id: "mira", name: "Mira Okafor" },
  ]);
  check("one contact picked twice is one mention", twice.resolved.length === 1);
}

console.log("\nsmoke-mention-resolution: all checks passed");
