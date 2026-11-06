/**
 * Key facts, shared interests and opportunities: who is allowed to delete one.
 *
 * These columns are written from two kinds of place, and they need opposite semantics.
 * A person editing the contact is stating the whole list, so removing an entry must remove
 * it. An extraction — a pasted note, a capture, the browser extension — has read exactly one
 * conversation; it cannot know that a fact from six months ago stopped being true, and it
 * routinely returns an empty list because that note was about something else.
 *
 * `updateContactForUser` replaced these columns for every caller, so the second case wrote
 * the empty list straight through: pasting a note that mentioned an existing contact in
 * passing replaced their accumulated key facts, shared interests and opportunities with [].
 * The extension had already hit this and worked around it locally (see the header of
 * `src/lib/extension/writes.ts`, which names the hazard exactly); the note path never got
 * the same treatment. The rule now lives in one place, behind `mergeFactLists`.
 *
 * Run: npx tsx scripts/smoke-fact-lists.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import {
  FACT_LIST_CAP,
  mergeFactList,
  normalizeFactList,
} from "../src/lib/fact-lists";
import { createContactForUser, updateContactForUser } from "../src/lib/contact-writes";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

const USER = "smoke-fact-lists-user";
const OPTS = {
  skipRevalidate: true,
  skipEmbedding: true,
  skipSummary: true,
  skipCloseness: true,
} as const;

function pureChecks() {
  section("The union keeps what was already known");

  check(
    "existing entries come first, additions after",
    mergeFactList(["Was infra PM at Stripe"], ["Leads the Codex team"]).join("|") ===
      "Was infra PM at Stripe|Leads the Codex team"
  );
  check(
    "an empty extraction removes nothing",
    mergeFactList(["Was infra PM at Stripe"], []).join("|") === "Was infra PM at Stripe",
    "this is the whole bug: the model returning [] must not mean 'forget everything'"
  );
  check("no existing, just the new ones", mergeFactList(null, ["A"]).join("|") === "A");
  check("neither side", mergeFactList(null, undefined).length === 0);
  check(
    "junk in either side is ignored, not stringified",
    mergeFactList([1, null, "  ", "Real"], [{}, "Also real"]).join("|") === "Real|Also real"
  );

  section("The same fact twice is one fact");

  check(
    "case does not make it new",
    mergeFactList(["Leads the Codex team"], ["leads the codex team"]).length === 1
  );
  check(
    "nor does whitespace",
    mergeFactList(["Leads  the Codex team"], ["Leads the Codex team"]).length === 1
  );
  check(
    "the first spelling survives",
    mergeFactList(["Leads the Codex team"], ["LEADS THE CODEX TEAM"])[0] === "Leads the Codex team",
    "a later extraction must not restyle what the user wrote"
  );
  check("entries are trimmed", mergeFactList(["  spaced  "], [])[0] === "spaced");

  section("Growth has a ceiling");

  const many = mergeFactList(
    Array.from({ length: FACT_LIST_CAP }, (_, i) => `existing ${i}`),
    ["one more"]
  );
  check("capped", many.length === FACT_LIST_CAP);
  check(
    "and the older entries are the ones kept",
    !many.includes("one more") && many.includes("existing 0"),
    "union-only growth without a cap gives a contact mentioned in fifty notes an unreadable list"
  );

  section("A person stating the list can empty it");

  check("an empty list stays empty", normalizeFactList([]).length === 0);
  check("still deduped and trimmed", normalizeFactList([" A ", "a", "B"]).join("|") === "A|B");
}

async function dbChecks() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));

  async function seed() {
    return createContactForUser(
      USER,
      {
        fullName: "Fact Holder",
        keyFacts: ["Leads the Codex team", "Was infra PM at Stripe"],
        sharedInterests: ["AI infrastructure"],
        opportunities: ["Could intro me to the platform team"],
      },
      OPTS
    );
  }
  const read = async (id: string) =>
    db.query.contacts.findFirst({ where: eq(contacts.id, id) });

  section("An extraction may add but never remove");

  const a = await seed();
  // Exactly what note-batch-save passes on a merge when the model found nothing about
  // this person in that note.
  await updateContactForUser(
    USER,
    a!.id,
    { keyFacts: [], sharedInterests: [], opportunities: [] },
    { ...OPTS, mergeFactLists: true }
  );
  const afterEmpty = await read(a!.id);
  check(
    "an empty extraction leaves key facts alone",
    (afterEmpty?.keyFacts ?? []).length === 2,
    `got ${JSON.stringify(afterEmpty?.keyFacts)} — this is the reported data loss`
  );
  check("shared interests too", (afterEmpty?.sharedInterests ?? []).length === 1);
  check("opportunities too", (afterEmpty?.opportunities ?? []).length === 1);

  await updateContactForUser(
    USER,
    a!.id,
    { keyFacts: ["Was infra PM at Stripe", "Runs the design review"] },
    { ...OPTS, mergeFactLists: true }
  );
  const afterAdd = await read(a!.id);
  check(
    "a new fact is appended, the duplicate is not",
    (afterAdd?.keyFacts ?? []).join("|") ===
      "Leads the Codex team|Was infra PM at Stripe|Runs the design review",
    `got ${JSON.stringify(afterAdd?.keyFacts)}`
  );
  check(
    "a column the patch does not mention is untouched",
    (afterAdd?.sharedInterests ?? []).join("|") === "AI infrastructure"
  );

  section("A person stating the list still replaces it");

  const b = await seed();
  await updateContactForUser(USER, b!.id, { keyFacts: ["Only this one"] }, OPTS);
  const replaced = await read(b!.id);
  check(
    "editing down to one fact keeps one fact",
    (replaced?.keyFacts ?? []).join("|") === "Only this one",
    `got ${JSON.stringify(replaced?.keyFacts)} — without replace semantics nothing could ever be deleted`
  );
  await updateContactForUser(USER, b!.id, { keyFacts: [] }, OPTS);
  check("and can clear it entirely", ((await read(b!.id))?.keyFacts ?? []).length === 0);

  await db.delete(contacts).where(eq(contacts.userId, USER));
}

async function main() {
  pureChecks();
  await dbChecks();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll fact-list checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
