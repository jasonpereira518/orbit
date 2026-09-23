/**
 * Citations for a chat answer (`src/lib/chat-evidence.ts`): the ledger dedupes by source
 * identity, `citedIds` reads only real `[eN]` markers back out of prose, and
 * `stripUnresolvedMarkers` removes exactly the ones the model was never shown.
 *
 * Pure: no DB. Run: npx tsx scripts/smoke-chat-evidence.ts
 */
import { citedIds, createEvidenceLedger, stripUnresolvedMarkers } from "../src/lib/chat-evidence";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

console.log("minting");
{
  const ledger = createEvidenceLedger();
  const a = ledger.mint({ kind: "interaction", sourceId: "int-1", contactId: "c1", date: "2026-01-01" });
  check("first mint is e1", a === "e1");
  const b = ledger.mint({ kind: "interaction", sourceId: "int-2", contactId: "c1", date: "2026-01-02" });
  check("second, different source, is e2", b === "e2");
  const again = ledger.mint({ kind: "interaction", sourceId: "int-1", contactId: "c1", date: "2026-01-01" });
  check("citing the SAME interaction again returns the SAME id, not a new one", again === a);
  const contact = ledger.mint({ kind: "contact", contactId: "c1" });
  check("a contact-level id is distinct from any of that contact's interaction ids", contact !== a && contact !== b);
  const contactAgain = ledger.mint({ kind: "contact", contactId: "c1" });
  check("and it dedupes the same way", contactAgain === contact);
  const otherContact = ledger.mint({ kind: "contact", contactId: "c2" });
  check("a different contact's contact-level id is distinct", otherContact !== contact);
  check("resolve round-trips what was minted", ledger.resolve(a)?.kind === "interaction" && (ledger.resolve(a) as { sourceId: string }).sourceId === "int-1");
  check("resolve on an unminted id is undefined", ledger.resolve("e99") === undefined);
  check("entries() lists every distinct source minted, in minting order", [...ledger.entries().keys()].join(",") === "e1,e2,e3,e4");
  check("two ledgers never share state", createEvidenceLedger().entries().size === 0);
}

console.log("reading citations out of prose");
{
  check("finds one marker", citedIds("Ada joined in March [e3].").join(",") === "e3");
  check("finds several, in order of first appearance", citedIds("[e5] then [e2] then [e5] again").join(",") === "e5,e2");
  check("ignores something that only looks like one", citedIds("see exhibit [e] or [ex2]").length === 0);
  check("ignores an unrelated bracketed number", citedIds("footnote [3]").length === 0);
  check("no markers at all", citedIds("Nothing to cite here.").length === 0);
  check("a marker glued to punctuation still reads", citedIds("(per [e1]).").join(",") === "e1");
}

console.log("stripping what the model was not shown");
{
  const valid = new Set(["e1", "e2"]);
  const { text, strippedCount } = stripUnresolvedMarkers("Ada joined in March [e1] and left in June [e7].", valid);
  check("the valid marker survives", text.includes("[e1]"));
  check("the invalid one is removed, not replaced with junk", !text.includes("[e7]") && !text.includes("[]"));
  check("exactly one was stripped", strippedCount === 1);
  const clean = stripUnresolvedMarkers("Nothing cited.", valid);
  check("nothing to strip is a no-op, count zero", clean.text === "Nothing cited." && clean.strippedCount === 0);
  const all = stripUnresolvedMarkers("[e1][e2]", valid);
  check("every valid marker can survive at once", all.text === "[e1][e2]" && all.strippedCount === 0);
  const none = stripUnresolvedMarkers("[e9][e10]", valid);
  check("every invalid marker is stripped", none.text === "" && none.strippedCount === 2);
  check("stripping is idempotent against citedIds — nothing left resolves outside validIds", citedIds(stripUnresolvedMarkers("[e1][e9]", valid).text).every((id) => valid.has(id)));
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chat evidence checks passed");
process.exit(0);
