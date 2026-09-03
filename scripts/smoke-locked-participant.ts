/**
 * `pickLockedParticipant` decides which parsed item (if any) the bulk notes panel force-merges
 * into a known contact when opened from that contact's profile (`lockedParticipantId`). Pure,
 * no DB, no AI — exercises the four branches: duplicate-id match, case-insensitive name match,
 * the lone-item fallback, and the no-match case.
 *
 * `withLockedSeedPerson` folds that same locked contact into `captureHints.seedPeople`
 * without dropping attendees `.ics`/`.eml` ingestion already put there.
 * Run: npx tsx scripts/smoke-locked-participant.ts
 */
import { pickLockedParticipant, withLockedSeedPerson } from "../src/lib/note-batches";

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

// withLockedSeedPerson: appends to whatever seedPeople ingestion already produced,
// rather than replacing it (a naive overwrite would drop real .ics/.eml attendees).
{
  const hints = { seedPeople: [{ name: "Dev Patel" }] };
  const result = withLockedSeedPerson(hints, "Sarah Chen");
  check(
    "withLockedSeedPerson appends to existing seed people",
    result.seedPeople?.length === 2 &&
      result.seedPeople.some((p) => p.name === "Dev Patel") &&
      result.seedPeople.some((p) => p.name === "Sarah Chen")
  );
}

// Re-locking the same person (e.g. hints recomputed on a second extract) must not pile
// up a duplicate entry — case and surrounding whitespace shouldn't matter either.
{
  const hints = { seedPeople: [{ name: "  sarah CHEN  " }] };
  const result = withLockedSeedPerson(hints, "Sarah Chen");
  check(
    "withLockedSeedPerson does not duplicate a same-name entry",
    result.seedPeople?.length === 1
  );
}

// No prior hints at all (first extract, nothing ingested) still produces a valid
// CaptureParseHints seeded with just the locked contact.
{
  const result = withLockedSeedPerson(null, "Sarah Chen");
  check(
    "withLockedSeedPerson works when hints are null",
    result.seedPeople?.length === 1 && result.seedPeople[0]?.name === "Sarah Chen"
  );
}

console.log("\nsmoke-locked-participant: all checks passed");
