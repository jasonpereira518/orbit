/**
 * Radar's proof check (`src/lib/radar/verify.ts`): no proof, no card.
 *
 * A card survives only when its lead reason has evidence whose proof holds against what the
 * run actually read: a quote must appear in the source row's text, a record must be a row the
 * run loaded, a link must be one a source handed over. Evidence that fails is dropped from the
 * card; a card whose lead loses its proof is dropped entirely. Pure: no database.
 *
 * Run: npx tsx scripts/smoke-radar-verify.ts
 */
import { buildProofIndex, proofHolds, verifyPick, verifyPicks } from "../src/lib/radar/verify";
import type { RadarEvidence, RadarReason } from "../src/lib/radar/types";
import { checker } from "./smoke/check";

const t = checker();

const index = buildProofIndex([
  { table: "action_items", id: "a1", text: "Send Priya the deck from the offsite" },
  { table: "interactions", id: "m1" },
  { table: "relationship_digests", id: "d1", text: "Asked whether you could intro her to someone at Stripe" },
  { table: "relationship_digests", id: "d1", text: "Wants the reading list you mentioned" },
  { table: "contact_signals", id: "s1", text: "Shipped our new API today", urls: ["https://www.linkedin.com/posts/priya-123"] },
  { table: "contacts", id: "c1" },
]);

console.log("\nproofs");
t.check("a quote found in its source holds", proofHolds({ type: "quote", table: "action_items", id: "a1", quote: "send priya the deck" }, index));
t.check("whitespace and case do not matter", proofHolds({ type: "quote", table: "action_items", id: "a1", quote: "Send  Priya\nthe DECK" }, index));
t.check("an invented quote does not", !proofHolds({ type: "quote", table: "action_items", id: "a1", quote: "Send Priya the contract" }, index));
t.check("a quote against a row the run never read does not", !proofHolds({ type: "quote", table: "action_items", id: "a2", quote: "Send Priya the deck" }, index));
t.check("a quote against the right id in the wrong table does not", !proofHolds({ type: "quote", table: "contact_opportunities", id: "a1", quote: "Send Priya the deck" }, index));
t.check("an empty quote is no proof", !proofHolds({ type: "quote", table: "action_items", id: "a1", quote: "  " }, index));
t.check("a row with several texts matches any of them", proofHolds({ type: "quote", table: "relationship_digests", id: "d1", quote: "the reading list" }, index));
t.check("a record the run loaded holds", proofHolds({ type: "record", table: "interactions", id: "m1" }, index));
t.check("a record it did not load does not", !proofHolds({ type: "record", table: "interactions", id: "m2" }, index));
t.check("a link a source handed over holds", proofHolds({ type: "url", url: "https://www.linkedin.com/posts/priya-123" }, index));
t.check("a link nobody handed over does not", !proofHolds({ type: "url", url: "https://example.com/made-up" }, index));
t.check("a javascript: link never does", !proofHolds({ type: "url", url: "javascript:alert(1)" }, index));
t.check("no proof is no proof", !proofHolds(undefined, index));

console.log("\ncards");
type Card = { contactId: string; reasons: RadarReason[]; evidence: RadarEvidence[] };
const card = (reasons: RadarReason[], evidence: RadarEvidence[]): Card => ({ contactId: "c1", reasons, evidence });
const owed: RadarReason = { code: "action_item_open", label: "Open item: Send Priya the deck", points: 26 };
const tier: RadarReason = { code: "tier", label: "One of your closest", points: 8 };
const goodEvidence: RadarEvidence = {
  label: "Open for 9 days",
  at: null,
  code: "action_item_open",
  proof: { type: "quote", table: "action_items", id: "a1", quote: "Send Priya the deck" },
};

const kept = verifyPick(card([owed, tier], [goodEvidence]), index);
t.check("a card whose lead is proven survives", kept !== null && kept.evidence.length === 1);

t.check(
  "a card whose lead has no evidence at all is dropped",
  verifyPick(card([owed, tier], []), index) === null
);
t.check(
  "a card whose lead's evidence fails is dropped",
  verifyPick(card([owed], [{ ...goodEvidence, proof: { type: "quote", table: "action_items", id: "a1", quote: "Sign the contract" } }]), index) === null
);
t.check(
  "evidence for a different reason does not prove the lead",
  verifyPick(card([owed], [{ ...goodEvidence, code: "upcoming_meeting" }]), index) === null
);
t.check(
  "a context reason alone (tier) never makes a card",
  verifyPick(card([tier], [{ label: "Inner circle", at: null, code: "tier", proof: { type: "record", table: "contacts", id: "c1" } }]), index) === null
);

const mixed = verifyPick(
  card(
    [owed, { code: "upcoming_meeting", label: "You’re meeting Thursday", points: 20 }],
    [goodEvidence, { label: "Meeting", at: null, code: "upcoming_meeting", proof: { type: "record", table: "interactions", id: "m9" } }]
  ),
  index
);
t.check("an unproven supporting item is stripped, the card kept", mixed !== null && mixed.evidence.length === 1 && mixed.evidence[0]!.code === "action_item_open");

const { kept: list, dropped } = verifyPicks(
  [card([owed], [goodEvidence]), card([owed], []), card([owed], [{ ...goodEvidence, proof: undefined }])],
  index
);
t.check("verifyPicks keeps the proven and counts the rest", list.length === 1 && dropped === 2, `${list.length} kept, ${dropped} dropped`);

console.log("\nnamesakes: a proof belongs to one person");
{
  // Two people the run read, both called Sam. The quote is real and the row is real, but the
  // row is about the other Sam.
  const people = buildProofIndex([
    { table: "action_items", id: "sam-a", contactId: "sam-1", text: "Send Sam the deck" },
    { table: "action_items", id: "sam-b", contactId: "sam-2", text: "Send Sam the deck" },
    // One email event the ranker matched to two people: it backs a card for each.
    { table: "email_events", id: "ev1", contactId: "sam-1" },
    { table: "email_events", id: "ev1", contactId: "sam-2" },
    { table: "contact_signals", id: "post", contactId: "sam-2", text: "Hiring a designer", urls: ["https://www.linkedin.com/posts/sam-2"] },
    { table: "contacts", id: "sam-1", contactId: "sam-1" },
  ]);
  const quoteOf = (id: string) => ({ type: "quote" as const, table: "action_items" as const, id, quote: "Send Sam the deck" });
  t.check("a quote from this person's own row holds", proofHolds(quoteOf("sam-a"), people, "sam-1"));
  t.check("the same quote from the other Sam's row does not", !proofHolds(quoteOf("sam-b"), people, "sam-1"));
  t.check("a shared row holds for every person it was read for", proofHolds({ type: "record", table: "email_events", id: "ev1" }, people, "sam-1") && proofHolds({ type: "record", table: "email_events", id: "ev1" }, people, "sam-2"));
  t.check("but not for someone it was never read for", !proofHolds({ type: "record", table: "email_events", id: "ev1" }, people, "sam-3"));
  t.check("a contact record proves only that contact", proofHolds({ type: "record", table: "contacts", id: "sam-1" }, people, "sam-1") && !proofHolds({ type: "record", table: "contacts", id: "sam-1" }, people, "sam-2"));
  t.check("a link a person's row handed over holds for them", proofHolds({ type: "url", url: "https://www.linkedin.com/posts/sam-2" }, people, "sam-2"));
  t.check("and not for the other Sam", !proofHolds({ type: "url", url: "https://www.linkedin.com/posts/sam-2" }, people, "sam-1"));

  const owedSam: RadarReason = { code: "action_item_open", label: "Open item: Send Sam the deck", points: 26 };
  const namesake = verifyPick(
    { contactId: "sam-1", reasons: [owedSam], evidence: [{ label: "Open", at: null, code: "action_item_open", proof: quoteOf("sam-b") }] },
    people
  );
  t.check("a card proven only by the other Sam's row is dropped", namesake === null);
  const own = verifyPick(
    { contactId: "sam-1", reasons: [owedSam], evidence: [{ label: "Open", at: null, code: "action_item_open", proof: quoteOf("sam-a") }, { label: "Also", at: null, code: "action_item_open", proof: quoteOf("sam-b") }] },
    people
  );
  t.check("on a proven card, the other Sam's evidence is stripped", own !== null && own.evidence.length === 1 && (own.evidence[0]!.proof as { id: string }).id === "sam-a");
}


console.log("\nConnect: two notes, two people");
{
  const notes = buildProofIndex([
    { table: "memory_chunks", id: "na", contactId: "priya", text: "Priya is hiring a product designer" },
    { table: "memory_chunks", id: "nb", contactId: "sam", text: "Sam is looking for a design role" },
  ]);
  const lead: RadarReason = { code: "connect_introduce", label: "Introduce to Sam", points: 30 };
  const mine: RadarEvidence = { label: "Your note on them", at: null, code: "connect_introduce", proof: { type: "quote", table: "memory_chunks", id: "na", quote: "hiring a product designer" } };
  const theirs: RadarEvidence = { label: "Your note on Sam", at: null, code: "connect_introduce", aboutContactId: "sam", proof: { type: "quote", table: "memory_chunks", id: "nb", quote: "looking for a design role" } };
  t.check("both sides proven, each against its own person: the card stands", verifyPick({ contactId: "priya", reasons: [lead], evidence: [mine, theirs] }, notes) !== null);
  t.check("one side alone is not enough", verifyPick({ contactId: "priya", reasons: [lead], evidence: [mine] }, notes) === null);
  t.check(
    "the other side checked against the card's person fails",
    verifyPick({ contactId: "priya", reasons: [lead], evidence: [mine, { ...theirs, aboutContactId: undefined }] }, notes) === null
  );
  t.check(
    "an invented quote on the other side drops the card",
    verifyPick({ contactId: "priya", reasons: [lead], evidence: [mine, { ...theirs, proof: { type: "quote", table: "memory_chunks", id: "nb", quote: "is a famous designer" } }] }, notes) === null
  );
}


t.done("radar proof check");
