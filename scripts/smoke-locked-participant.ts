/**
 * `pickLockedParticipant` decides which parsed item (if any) the bulk notes panel force-merges
 * into a known contact when opened from that contact's profile (`lockedParticipantId`). Pure,
 * no DB, no AI — exercises the four branches: duplicate-id match, case-insensitive name match,
 * the lone-item fallback, and the no-match case.
 * Run: npx tsx scripts/smoke-locked-participant.ts
 */
import { pickLockedParticipant } from "../src/lib/note-batches";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const LOCKED = { id: "contact-1", name: "Sarah Chen" };

// 1. Duplicate-id match wins even when the name looks unrelated (e.g. she goes by a
// nickname in this note but the AI's dedupe search still turned up the same contact).
{
  const items = [
    { key: "a", name: "Sadie", duplicateIds: ["contact-1"] },
    { key: "b", name: "Dev Patel", duplicateIds: [] },
  ];
  check(
    "duplicate-id match",
    pickLockedParticipant(items, LOCKED) === "a"
  );
}

// 2. No duplicate-id match, but a case-insensitive name match.
{
  const items = [
    { key: "a", name: "sarah CHEN", duplicateIds: [] },
    { key: "b", name: "Dev Patel", duplicateIds: [] },
  ];
  check(
    "case-insensitive name match",
    pickLockedParticipant(items, LOCKED) === "a"
  );
}

// 3. Neither a duplicate-id nor a name match, but exactly one item was parsed at all —
// a first-person note about the locked contact where the AI didn't catch their name.
{
  const items = [{ key: "only", name: null, duplicateIds: [] }];
  check(
    "lone-item fallback",
    pickLockedParticipant(items, LOCKED) === "only"
  );
}

// 4. No match, and more than one item — too ambiguous to guess, so nothing locks.
{
  const items = [
    { key: "a", name: "Dev Patel", duplicateIds: [] },
    { key: "b", name: "Raj Patel", duplicateIds: [] },
  ];
  check(
    "no match, multiple items -> null",
    pickLockedParticipant(items, LOCKED) === null
  );
}

// Duplicate-id match takes priority over a coincidental name match on another item.
{
  const items = [
    { key: "a", name: "Sarah Chen", duplicateIds: [] },
    { key: "b", name: "Someone Else", duplicateIds: ["contact-1"] },
  ];
  check(
    "duplicate-id match beats a different item's name match",
    pickLockedParticipant(items, LOCKED) === "b"
  );
}

// Empty item list -> null, not a lone-item false positive.
check("empty items -> null", pickLockedParticipant([], LOCKED) === null);

console.log("\nsmoke-locked-participant: all checks passed");
