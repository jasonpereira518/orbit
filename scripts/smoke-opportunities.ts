/**
 * Typed opportunities against PGlite: the write path, the derived mirror, idempotency, and
 * undo.
 *
 * THE BUG THIS EXISTS FOR. `contacts.opportunities` used to be written directly by the
 * capture save, and `updateContactForUser` overwrites that column outright — so a second
 * note about the same person silently deleted the first note's opportunities. It is now a
 * mirror DERIVED from `contact_opportunities` with exactly one writer, which makes that
 * class of bug unreachable. The "two notes" case below is the regression test.
 *
 * Run: npx tsx scripts/smoke-opportunities.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-opportunities";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-opportunities";

import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contactOpportunities, contacts, noteBatches, reminders } from "../src/db/schema";
import {
  buildOpportunityItemHash,
  insertOpportunities,
  legacyOpportunityDrafts,
  listOpportunitiesForContact,
  syncContactOpportunityMirror,
} from "../src/lib/contact-opportunities";
import { createContactForUser } from "../src/lib/contact-writes";
import { saveNoteBatch, undoNoteBatchForUser } from "../src/lib/note-batch-save";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import type { ParsedNote } from "../src/lib/ai";

const USER = "smoke-opportunities-user";
const OTHER = "smoke-opportunities-other";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const WRITE_OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true } as const;

function parsed(name: string, over: Partial<ParsedNote> = {}): ParsedNote {
  return {
    name,
    company: "Acme",
    role: "Engineer",
    presence: "participant",
    location: null,
    email: null,
    linkedin_url: null,
    met_at: null,
    topics: [],
    action_items: [],
    implied_next_steps: [],
    follow_up_recommendation: null,
    follow_up_days: null,
    relationship_score_suggestion: 3,
    relevance: null,
    tags: [],
    summary: `Met ${name}`,
    key_facts: [],
    opportunities: [],
    shared_interests: [],
    suggested_next_message: null,
    confidence: 0.9,
    interaction_date: "2026-09-01",
    low_confidence_fields: [],
    ...over,
  };
}

async function reset() {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(contactOpportunities).where(eq(contactOpportunities.userId, u));
    await db.delete(reminders).where(eq(reminders.userId, u));
    await db.delete(noteBatches).where(eq(noteBatches.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }
}

async function mirrorOf(userId: string, contactId: string) {
  const db = await getDb();
  const row = await db.query.contacts.findFirst({ where: eq(contacts.id, contactId) });
  return row?.opportunities ?? [];
}

async function main() {
  await reset();
  const db = await getDb();

  console.log("\nthe mirror is derived, with one writer");

  const ada = await createContactForUser(USER, { fullName: "Ada Lovelace", company: "Acme" }, WRITE_OPTS);
  await insertOpportunities(USER, [
    { contactId: ada.id, kind: "referral", label: "could forward my resume", createdBy: "ai", itemHash: "h1" },
    { contactId: ada.id, kind: "internship", label: "summer infra internship", createdBy: "ai", itemHash: "h2" },
  ]);
  await syncContactOpportunityMirror(USER, ada.id);

  const mirror = await mirrorOf(USER, ada.id);
  check("the mirror carries both", mirror.length === 2, JSON.stringify(mirror));
  check("  and prefixes the kind", mirror[0] === "Referral — could forward my resume", mirror[0]);

  // The embedding reads this column, so a stale one would keep answering searches with
  // opportunities that are closed.
  const stamped = await db.query.contacts.findFirst({ where: eq(contacts.id, ada.id) });
  check("  and stamps the embedding stale", stamped?.embeddingStaleAt !== null);

  console.log("\nclosing one re-derives rather than appends");

  await db
    .update(contactOpportunities)
    .set({ status: "landed" })
    .where(and(eq(contactOpportunities.userId, USER), eq(contactOpportunities.itemHash, "h1")));
  await syncContactOpportunityMirror(USER, ada.id);
  const after = await mirrorOf(USER, ada.id);
  check("a landed opportunity leaves the mirror", after.length === 1, JSON.stringify(after));
  check("  the open one stays", after[0]?.startsWith("Internship — "), after[0]);
  check("  and the row itself survives", (await listOpportunitiesForContact(USER, ada.id)).length === 2);

  console.log("\nlisting is open-first");

  const listed = await listOpportunitiesForContact(USER, ada.id);
  check("open work sorts before closed", listed[0]?.status === "open", listed[0]?.status);

  console.log("\nuser scoping");

  const theirs = await createContactForUser(OTHER, { fullName: "Grace Hopper" }, WRITE_OPTS);
  await insertOpportunities(OTHER, [{ contactId: theirs.id, kind: "job", label: "backend role", itemHash: "h1" }]);
  check("the same itemHash is fine across users", (await listOpportunitiesForContact(OTHER, theirs.id)).length === 1);
  check("  and does not leak", (await listOpportunitiesForContact(USER, theirs.id)).length === 0);

  console.log("\nidempotency: the same hash never writes twice");

  const again = await insertOpportunities(USER, [
    { contactId: ada.id, kind: "referral", label: "could forward my resume", itemHash: "h1" },
  ]);
  check("a duplicate hash inserts nothing", again.length === 0);
  check("  and the hash is stable", buildOpportunityItemHash("s", "c", "referral", " Could Forward ") === buildOpportunityItemHash("s", "c", "referral", "could forward"));

  console.log("\nTHE REGRESSION: two notes about the same person");

  await reset();
  const maya = await createContactForUser(USER, { fullName: "Maya Chen", company: "Stripe" }, WRITE_OPTS);

  const noteOne = "Coffee with Maya. She offered to forward my resume to the infra team.";
  const batchOne = await saveNoteBatch(USER, {
    sourceText: noteOne,
    sourceHash: hashSourceNote(noteOne),
    anchorIso: "2026-09-01",
    anchorBasis: "note",
    entryPoint: "capture",
    participants: [
      {
        notes: noteOne,
        parsed: parsed("Maya Chen"),
        mergeContactId: maya.id,
        createReminder: false,
        relationshipScore: 3,
        tagNames: [],
        opportunities: [
          {
            kind: "referral",
            label: "forward my resume to infra",
            direction: "they_offer",
            sourceExcerpt: "She offered to forward my resume to the infra team.",
            rawDatePhrase: null,
            confidenceScore: 90,
            dueDateIso: null,
          },
        ],
      },
    ],
    commitments: [],
    skipped: { relative: 0, unverifiable: 0, past: 0 },
  });
  check("the first note opens one opportunity", (batchOne.result.opportunities ?? []).length === 1, JSON.stringify(batchOne.result.opportunities));
  check("  and mirrors it", (await mirrorOf(USER, maya.id)).length === 1);

  const noteTwo = "Second chat with Maya. She mentioned a summer internship opening in October.";
  const batchTwo = await saveNoteBatch(USER, {
    sourceText: noteTwo,
    sourceHash: hashSourceNote(noteTwo),
    anchorIso: "2026-09-08",
    anchorBasis: "note",
    entryPoint: "capture",
    participants: [
      {
        notes: noteTwo,
        parsed: parsed("Maya Chen"),
        mergeContactId: maya.id,
        createReminder: false,
        relationshipScore: 3,
        tagNames: [],
        opportunities: [
          {
            kind: "internship",
            label: "summer internship opening",
            direction: "they_offer",
            sourceExcerpt: "She mentioned a summer internship opening in October.",
            rawDatePhrase: null,
            confidenceScore: 85,
            dueDateIso: null,
          },
        ],
      },
    ],
    commitments: [],
    skipped: { relative: 0, unverifiable: 0, past: 0 },
  });

  // This is the assertion the old code failed: the second note used to overwrite the column
  // and the referral disappeared without a trace.
  const bothRows = await listOpportunitiesForContact(USER, maya.id);
  check("the second note does NOT delete the first", bothRows.length === 2, JSON.stringify(bothRows.map((r) => r.label)));
  const bothMirror = await mirrorOf(USER, maya.id);
  check("  and the mirror carries both", bothMirror.length === 2, JSON.stringify(bothMirror));

  console.log("\nre-pasting the same note creates nothing");

  const replay = await saveNoteBatch(USER, {
    sourceText: noteTwo,
    sourceHash: hashSourceNote(noteTwo),
    anchorIso: "2026-09-08",
    anchorBasis: "note",
    entryPoint: "capture",
    participants: [
      {
        notes: noteTwo,
        parsed: parsed("Maya Chen"),
        mergeContactId: maya.id,
        createReminder: false,
        relationshipScore: 3,
        tagNames: [],
        opportunities: [
          {
            kind: "internship",
            label: "summer internship opening",
            direction: "they_offer",
            sourceExcerpt: "She mentioned a summer internship opening in October.",
            rawDatePhrase: null,
            confidenceScore: 85,
            dueDateIso: null,
          },
        ],
      },
    ],
    commitments: [],
    skipped: { relative: 0, unverifiable: 0, past: 0 },
  });
  check("a re-paste opens nothing new", (replay.result.opportunities ?? []).length === 0);
  check("  and the total is unchanged", (await listOpportunitiesForContact(USER, maya.id)).length === 2);

  console.log("\nundo dismisses, never deletes");

  const undone = await undoNoteBatchForUser(USER, batchTwo.batchId);
  check("undo closes what that batch opened", undone.opportunitiesDismissed === 1, String(undone.opportunitiesDismissed));

  const afterUndo = await listOpportunitiesForContact(USER, maya.id);
  // Deleting would let a re-paste recreate it, which is the whole reason reminders are
  // dismissed rather than removed.
  check("  the row survives, dismissed", afterUndo.length === 2 && afterUndo.some((r) => r.status === "dismissed"));
  check("  the first note's opportunity is untouched", afterUndo.some((r) => r.status === "open" && r.label.includes("resume")));
  check("  and the mirror drops the dismissed one", (await mirrorOf(USER, maya.id)).length === 1);

  const replayAfterUndo = await saveNoteBatch(USER, {
    sourceText: noteTwo,
    sourceHash: hashSourceNote(noteTwo),
    anchorIso: "2026-09-08",
    anchorBasis: "note",
    entryPoint: "capture",
    participants: [
      {
        notes: noteTwo,
        parsed: parsed("Maya Chen"),
        mergeContactId: maya.id,
        createReminder: false,
        relationshipScore: 3,
        tagNames: [],
        opportunities: [
          {
            kind: "internship",
            label: "summer internship opening",
            direction: "they_offer",
            sourceExcerpt: "She mentioned a summer internship opening in October.",
            rawDatePhrase: null,
            confidenceScore: 85,
            dueDateIso: null,
          },
        ],
      },
    ],
    commitments: [],
    skipped: { relative: 0, unverifiable: 0, past: 0 },
  });
  check("re-pasting after undo stays blocked", (replayAfterUndo.result.opportunities ?? []).length === 0);

  console.log("\nlegacy free-text opportunities survive the move to typed rows");

  // THE DATA-LOSS WINDOW THIS CLOSES. Contacts written before this feature carry prose in
  // `contacts.opportunities` and no typed rows. The moment anything re-derives that column,
  // prose with no row behind it is gone. `scripts/backfill-opportunities.ts` converts first.
  {
    await reset();
    const legacyContact = await createContactForUser(USER, { fullName: "Dev Patel" }, WRITE_OPTS);
    const legacy = [
      "can refer me to the infra team",
      "Introduction — intro to Raj",
      "hiring for infra",
    ];
    await db
      .update(contacts)
      .set({ opportunities: legacy })
      .where(eq(contacts.id, legacyContact.id));

    const drafts = legacyOpportunityDrafts(legacyContact.id, legacy);
    check("every legacy string becomes a draft", drafts.length === 3, String(drafts.length));
    // Referral language wins over everything else, here as in the extractor.
    check("  referral language is recognised", drafts[0].kind === "referral", drafts[0].kind);
    // The "Kind — label" shape some old revisions wrote is read back.
    check("  a leading kind is read back", drafts[1].kind === "introduction", drafts[1].kind);
    // Unrecognisable prose keeps its text under `other` rather than being dropped.
    check("  unrecognisable prose becomes other", drafts[2].kind === "other", drafts[2].kind);
    check("  and keeps its text", drafts[2].label === "hiring for infra", drafts[2].label);

    const written = await insertOpportunities(USER, drafts);
    check("the drafts insert", written.length === 3, String(written.length));
    await syncContactOpportunityMirror(USER, legacyContact.id);
    const remirrored = await mirrorOf(USER, legacyContact.id);
    check("  and the mirror still carries all three", remirrored.length === 3, JSON.stringify(remirrored));
    check(
      "  including the text that would otherwise have been lost",
      remirrored.some((l) => l.includes("hiring for infra")),
      JSON.stringify(remirrored)
    );

    // Running the backfill twice must not double anybody's pipeline.
    const second = await insertOpportunities(USER, legacyOpportunityDrafts(legacyContact.id, legacy));
    check("a second backfill run writes nothing", second.length === 0, String(second.length));
    check("  and the total is unchanged", (await listOpportunitiesForContact(USER, legacyContact.id)).length === 3);
  }

  console.log("\na referral is findable by keyword search");

  // THE POINT OF THE MIRROR. `contacts.search_tsv` is a generated column, so this is also the
  // proof that `opportunities::text` is an expression Postgres will actually accept there —
  // if it were not, the migration would have failed before this line ran.
  {
    await reset();
    const pat = await createContactForUser(USER, { fullName: "Pat Okafor", company: "Northwind" }, WRITE_OPTS);
    await insertOpportunities(USER, [
      {
        contactId: pat.id,
        kind: "referral",
        label: "will find the hiring manager for the infra team",
        createdBy: "ai",
        itemHash: "ref-1",
      },
    ]);
    await syncContactOpportunityMirror(USER, pat.id);

    const hits = async (q: string) => {
      const rows = await db.execute(
        sql`select id from contacts
            where user_id = ${USER}
              and search_tsv @@ websearch_to_tsquery('simple', ${q})`
      );
      return rowsOf<{ id: string }>(rows).map((r) => r.id);
    };

    check("searching 'referral' finds them", (await hits("referral")).includes(pat.id));
    check("  so does 'hiring manager'", (await hits("hiring manager")).includes(pat.id));
    check("  and a word from the label", (await hits("infra")).includes(pat.id));
    check("  but an unrelated word does not", !(await hits("kangaroo")).includes(pat.id));

    // Closing it takes the row out of the mirror, so it stops answering the search — which
    // is the behaviour somebody triaging "who can refer me?" actually wants.
    await db
      .update(contactOpportunities)
      .set({ status: "landed" })
      .where(and(eq(contactOpportunities.userId, USER), eq(contactOpportunities.itemHash, "ref-1")));
    await syncContactOpportunityMirror(USER, pat.id);
    check("a landed referral stops matching", !(await hits("referral")).includes(pat.id));
  }

  console.log("\ncascade on contact delete");

  await db.delete(contacts).where(eq(contacts.id, maya.id));
  const orphans = await db
    .select()
    .from(contactOpportunities)
    .where(and(eq(contactOpportunities.userId, USER), eq(contactOpportunities.contactId, maya.id)));
  check("deleting the contact takes the opportunities", orphans.length === 0, String(orphans.length));

  await reset();
  console.log("\nAll opportunity checks passed.");
}

// `process.exit(0)` is mandatory, not tidiness: PGlite keeps the event loop alive, so a
// script that merely resolves never exits and `run-smoke.ts` waits on it forever. Every
// other pglite-tier script in this suite ends the same way.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
