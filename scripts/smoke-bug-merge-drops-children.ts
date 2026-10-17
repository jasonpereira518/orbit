/**
 * KNOWN BUG — documented, not fixed.
 *
 * Symptom: merging two contacts silently deletes the loser's opportunities
 * (`contact_opportunities`) and job-feed matches (`job_posting_matches`), and unlinks its
 * pending assistant send drafts (`agent_send_requests.contact_id` goes NULL). Unmerge cannot
 * bring any of them back, because none of them was moved or archived.
 *
 * Why: `mergeContacts` (src/lib/contact-merge.ts:144) moves child rows by walking
 * `REPOINTED_TABLES` (src/lib/contact-merge.ts:69-93) plus a handful of hand-written
 * statements, then deletes the loser row LAST so the ON DELETE rules only see what is left.
 * Three tables with a foreign key to `contacts(id)` are in neither place:
 *
 *   - contact_opportunities.contact_id  ON DELETE CASCADE  (schema.ts ~1484)
 *   - job_posting_matches.contact_id    ON DELETE CASCADE  (schema.ts ~4328)
 *   - agent_send_requests.contact_id    ON DELETE SET NULL (schema.ts ~3869)
 *
 * so the final `DELETE FROM contacts` takes the first two with it and orphans the third. The
 * module's own header promises the opposite ("every child row that moved is recorded by id,
 * and every row that had to be deleted instead of moved is archived in full").
 *
 * Trigger path: any merge — the Duplicates page (`src/actions/duplicates.ts:55`), the
 * automatic duplicate sweep (`src/lib/duplicate-sweep.ts:252`, which runs with no human in
 * the loop) or capture-time resolution (`src/lib/contact-resolve.ts:296`). An opportunity the
 * user added by hand on the losing record ("intro to Globex's recruiting lead") is gone, and
 * the Undo button does not restore it.
 *
 * Severity: high — silent, irreversible loss of user-entered data, reachable from an
 * automatic path.
 *
 * Fix: repoint `contact_opportunities` and `job_posting_matches` (the latter is unique on
 * (user_id, posting_id, contact_id), so move-what-does-not-collide plus archive-and-drop like
 * `contact_tags`) and `agent_send_requests`, and teach `unmergeContacts` to move them back.
 * This script then exits 0 and should be promoted to the pglite tier.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-bug-merge-drops-children.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  agentSendRequests,
  contactOpportunities,
  interactions,
  jobFeedSources,
  jobPostingMatches,
  jobPostings,
} from "../src/db/schema";
import { mergeContacts, unmergeContacts } from "../src/lib/contact-merge";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, insertInteraction, purgeUsers } from "./smoke/factories";

const t = checker();
const USER = fakeUserId("merge-children");
const SOURCE_ID = `smoke-merge-children-${randomUUID().slice(0, 8)}`;

run(async () => {
  const db = await getDb();
  await purgeUsers(db, [USER]);

  try {
    // The same person, twice: the winner keeps the email, the loser was captured from a note.
    const winner = await insertContact(db, USER, 0);
    const loser = await insertContact(db, USER, 0, { email: null, linkedinUrl: null, phone: null });

    await insertInteraction(db, USER, loser.id, { rawNotes: "Coffee — she offered an intro to Globex recruiting." });
    const [opportunity] = await db
      .insert(contactOpportunities)
      .values({ userId: USER, contactId: loser.id, kind: "referral", label: "Intro to Globex recruiting lead", createdBy: "user" })
      .returning();

    await db.insert(jobFeedSources).values({
      id: SOURCE_ID,
      label: "Smoke feed",
      url: "https://feeds.example.com/internships.json",
      season: "summer-2027",
    });
    const [posting] = await db
      .insert(jobPostings)
      .values({
        sourceId: SOURCE_ID,
        externalId: "posting-1",
        companyName: "Globex Labs",
        companyKey: "globex",
        title: "Software Engineering Intern",
        url: "https://jobs.example.com/globex/1",
        datePosted: new Date("2026-09-01T00:00:00Z"),
        dateUpdated: new Date("2026-09-01T00:00:00Z"),
      })
      .returning();
    const [match] = await db
      .insert(jobPostingMatches)
      .values({ userId: USER, postingId: posting.id, contactId: loser.id, opportunityId: opportunity.id, companyKey: "globex", matchKind: "referral" })
      .returning();

    const [draft] = await db
      .insert(agentSendRequests)
      .values({
        userId: USER,
        contactId: loser.id,
        toEmail: "ada.lovelace@example.com",
        subject: "Following up",
        body: "Hi Ada, following up on the Globex intro.",
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      })
      .returning();

    console.log("\nMerge the loser into the winner...");
    const { mergeId } = await mergeContacts(USER, winner.id, loser.id, { deferInvalidation: true });

    const movedNotes = await db.select().from(interactions).where(and(eq(interactions.userId, USER), eq(interactions.contactId, winner.id)));
    t.check("setup: the merge ran and moved the loser's interaction to the winner", movedNotes.length === 1);

    const opps = await db.select().from(contactOpportunities).where(eq(contactOpportunities.id, opportunity.id));
    t.knownBug(
      "BUG: merge cascade-deletes the loser's contact_opportunities instead of moving them to the winner",
      opps.length === 1 && opps[0].contactId === winner.id,
      opps.length === 0 ? "row deleted with the loser" : `contact_id=${opps[0].contactId}`
    );

    const matches = await db.select().from(jobPostingMatches).where(eq(jobPostingMatches.id, match.id));
    t.knownBug(
      "BUG: merge cascade-deletes the loser's job_posting_matches instead of moving them to the winner",
      matches.length === 1 && matches[0].contactId === winner.id,
      matches.length === 0 ? "row deleted with the loser" : `contact_id=${matches[0].contactId}`
    );

    const drafts = await db.select().from(agentSendRequests).where(eq(agentSendRequests.id, draft.id));
    t.check("the pending assistant draft row itself survives (SET NULL, not cascade)", drafts.length === 1);
    t.knownBug(
      "BUG: merge unlinks the loser's pending agent_send_requests (contact_id becomes NULL, not the winner)",
      drafts[0]?.contactId === winner.id,
      `contact_id=${drafts[0]?.contactId ?? "null"}`
    );

    console.log("\nUndo the merge...");
    await unmergeContacts(USER, mergeId);
    const notesBack = await db.select().from(interactions).where(and(eq(interactions.userId, USER), eq(interactions.contactId, loser.id)));
    t.check("setup: unmerge restored the loser and gave its interaction back", notesBack.length === 1);

    const oppsBack = await db.select().from(contactOpportunities).where(eq(contactOpportunities.id, opportunity.id));
    t.knownBug(
      "BUG: unmerge cannot restore the loser's opportunity (it was never archived)",
      oppsBack.length === 1 && oppsBack[0].contactId === loser.id,
      oppsBack.length === 0 ? "still gone after unmerge" : `contact_id=${oppsBack[0].contactId}`
    );
    const matchesBack = await db.select().from(jobPostingMatches).where(eq(jobPostingMatches.id, match.id));
    t.knownBug(
      "BUG: unmerge cannot restore the loser's job_posting_matches (never archived)",
      matchesBack.length === 1 && matchesBack[0].contactId === loser.id,
      matchesBack.length === 0 ? "still gone after unmerge" : `contact_id=${matchesBack[0].contactId}`
    );
  } finally {
    await purgeUsers(db, [USER]);
    const postings = await db.select({ id: jobPostings.id }).from(jobPostings).where(eq(jobPostings.sourceId, SOURCE_ID));
    if (postings.length) await db.delete(jobPostings).where(inArray(jobPostings.id, postings.map((p) => p.id)));
    await db.delete(jobFeedSources).where(eq(jobFeedSources.id, SOURCE_ID));
  }

  t.done("merge drops children (known bug)");
});
