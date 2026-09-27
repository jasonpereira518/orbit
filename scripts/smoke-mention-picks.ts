/**
 * Token minting for `@`-picks, and the rule that the TEXT is the fact.
 *
 * Two failures are pinned here. First, two composers must never mint different tokens for
 * the same contact — that is what leaves a person grey and unattached in one box and linked
 * in the other, and it is why `tokenForPerson` was lifted out of `chat-panel.tsx` instead of
 * being reimplemented for capture. Second, a pick whose token the user deleted from the box
 * must stop counting: otherwise a note saves a link to somebody they removed on purpose.
 *
 * Run: npx tsx scripts/smoke-mention-picks.ts
 */

import {
  MAX_MENTION_PICKS,
  activePicks,
  addMentionPick,
  pickNames,
  sanitizeMentionPicks,
  type MentionPick,
} from "../src/lib/mentions/mention-picks";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

const ADA = "11111111-1111-4111-8111-111111111111";
const CHRIS_A = "22222222-2222-4222-8222-222222222222";
const CHRIS_B = "33333333-3333-4333-8333-333333333333";

console.log("\nminting tokens");

{
  const { picks, token } = addMentionPick([], ADA, ["Ada Lovelace"]);
  check("first pick mints a token", token === "@Ada Lovelace", token);
  check("  and registers the pick", picks.length === 1 && picks[0].id === ADA);
}

// Re-picking the same contact must reuse their token. A second, longer token for the same
// person would leave the first one painted but unattached.
{
  const first = addMentionPick([], ADA, ["Ada Lovelace"]);
  const second = addMentionPick(first.picks, ADA, ["Ada Lovelace", "Ada"]);
  check("re-picking reuses the token", second.token === first.token, second.token);
  check("  and does not duplicate the pick", second.picks.length === 1);
}

// THE NAMESAKE TRAP. Two people who would both render as "@Chris" cannot share a token:
// `activeMentions` could then only ever resolve it to one of them, and the other silently
// stops being attached.
{
  const a = addMentionPick([], CHRIS_A, ["Chris"]);
  const b = addMentionPick(a.picks, CHRIS_B, ["Chris"]);
  check("a namesake gets a different token", b.token !== a.token, `${a.token} vs ${b.token}`);
  check("  both picks are registered", b.picks.length === 2);
  check("  names are distinct", new Set(pickNames(b.picks)).size === 2, JSON.stringify(pickNames(b.picks)));
}

// A fuller name is preferred over a numbered suffix when one is available.
{
  const a = addMentionPick([], CHRIS_A, ["Chris"]);
  const b = addMentionPick(a.picks, CHRIS_B, ["Chris", "Chris Doyle"]);
  check("a longer candidate is used before numbering", b.token === "@Chris Doyle", b.token);
}

{
  const { picks } = addMentionPick([], ADA, [null, "  ", "Ada Lovelace"]);
  check("blank candidates are skipped", picks[0].name === "Ada Lovelace", picks[0].name);
}

// Returns a new array, so callers can hand it straight to setState without mutating.
{
  const original: MentionPick[] = [];
  const { picks } = addMentionPick(original, ADA, ["Ada"]);
  check("input array is not mutated", original.length === 0 && picks.length === 1);
}

console.log("\nthe text is the fact, the pick list is only a claim");

{
  const { picks } = addMentionPick([], ADA, ["Ada Lovelace"]);
  const active = activePicks("met @Ada Lovelace at the summit", picks);
  check("a present token is active", active.length === 1 && active[0].id === ADA);
}

// Deleting the token has to un-attach them, or a note saves a link the person removed.
{
  const { picks } = addMentionPick([], ADA, ["Ada Lovelace"]);
  check("a deleted token is not active", activePicks("met her at the summit", picks).length === 0);
}

{
  const a = addMentionPick([], ADA, ["Ada Lovelace"]);
  const b = addMentionPick(a.picks, CHRIS_A, ["Chris"]);
  const active = activePicks("@Ada Lovelace introduced me to someone", b.picks);
  check("only the mentioned one is active", active.length === 1 && active[0].id === ADA, JSON.stringify(active));
}

console.log("\nvalidating a payload that arrived from a browser");

{
  const ok = sanitizeMentionPicks([{ id: ADA, name: "Ada Lovelace" }]);
  check("a well-formed pick survives", ok.length === 1);
}
{
  const bad = sanitizeMentionPicks([
    { id: "not-a-uuid", name: "Mallory" },
    { id: 42, name: "Mallory" },
    { id: ADA, name: 42 },
    null,
    "nope",
    { name: "no id" },
  ]);
  check("malformed entries are dropped", bad.length === 0, JSON.stringify(bad));
}
{
  const dupes = sanitizeMentionPicks([
    { id: ADA, name: "Ada" },
    { id: ADA, name: "Ada Again" },
  ]);
  check("duplicate ids collapse", dupes.length === 1 && dupes[0].name === "Ada", JSON.stringify(dupes));
}
{
  const many = Array.from({ length: MAX_MENTION_PICKS + 10 }, (_, i) => ({
    id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
    name: `Person ${i}`,
  }));
  check(`capped at ${MAX_MENTION_PICKS}`, sanitizeMentionPicks(many).length === MAX_MENTION_PICKS);
}
{
  const long = sanitizeMentionPicks([{ id: ADA, name: "x".repeat(500) }]);
  check("names are capped", long[0].name.length === 120, String(long[0].name.length));
  const spaced = sanitizeMentionPicks([{ id: ADA, name: "  Ada   Lovelace  " }]);
  check("names are whitespace-collapsed", spaced[0].name === "Ada Lovelace", spaced[0].name);
}
{
  check("a non-array is empty", sanitizeMentionPicks("nope").length === 0);
  check("null is empty", sanitizeMentionPicks(null).length === 0);
  check("undefined is empty", sanitizeMentionPicks(undefined).length === 0);
}

console.log("\nAll mention-pick checks passed.");
