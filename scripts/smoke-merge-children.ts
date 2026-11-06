/**
 * A merge moves the loser's opportunities, job-feed matches and assistant send drafts to the
 * winner, and unmerge moves them back.
 *
 * Pins the fix for a data-loss bug: `mergeContacts` (src/lib/contact-merge.ts) deletes the
 * loser's `contacts` row last, and three child tables were in neither `REPOINTED_TABLES` nor
 * a hand-written statement — `contact_opportunities` and `job_posting_matches` (ON DELETE
 * CASCADE) went with the loser, and `agent_send_requests` (ON DELETE SET NULL) was unlinked.
 * Unmerge had nothing to give back. The first two and the drafts now repoint; job matches
 * are unique on (user_id, posting_id, contact_id), so a posting matched to BOTH contacts is
 * archived-and-dropped like `contact_tags` and restored by unmerge from the archive.
 *
 * Reached by any merge, including the automatic duplicate sweep, which has no human in the
 * loop — so a regression here is silent, irreversible loss of user-entered data.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-merge-children.ts
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
    t.check(
      "merge moves the loser's contact_opportunities to the winner",
      opps.length === 1 && opps[0].contactId === winner.id,
      opps.length === 0 ? "row deleted with the loser" : `contact_id=${opps[0].contactId}`
    );

    const matches = await db.select().from(jobPostingMatches).where(eq(jobPostingMatches.id, match.id));
    t.check(
      "merge moves the loser's job_posting_matches to the winner",
      matches.length === 1 && matches[0].contactId === winner.id,
      matches.length === 0 ? "row deleted with the loser" : `contact_id=${matches[0].contactId}`
    );

    const drafts = await db.select().from(agentSendRequests).where(eq(agentSendRequests.id, draft.id));
    t.check("the pending assistant draft row itself survives (SET NULL, not cascade)", drafts.length === 1);
    t.check(
      "merge moves the loser's pending agent_send_requests to the winner (not unlinked)",
      drafts[0]?.contactId === winner.id,
      `contact_id=${drafts[0]?.contactId ?? "null"}`
    );

    console.log("\nUndo the merge...");
    await unmergeContacts(USER, mergeId);
    const notesBack = await db.select().from(interactions).where(and(eq(interactions.userId, USER), eq(interactions.contactId, loser.id)));
    t.check("setup: unmerge restored the loser and gave its interaction back", notesBack.length === 1);

    const oppsBack = await db.select().from(contactOpportunities).where(eq(contactOpportunities.id, opportunity.id));
    t.check(
      "unmerge gives the opportunity back to the loser",
      oppsBack.length === 1 && oppsBack[0].contactId === loser.id,
      oppsBack.length === 0 ? "still gone after unmerge" : `contact_id=${oppsBack[0].contactId}`
    );
    const matchesBack = await db.select().from(jobPostingMatches).where(eq(jobPostingMatches.id, match.id));
    t.check(
      "unmerge gives the job_posting_matches back to the loser",
      matchesBack.length === 1 && matchesBack[0].contactId === loser.id,
      matchesBack.length === 0 ? "still gone after unmerge" : `contact_id=${matchesBack[0].contactId}`
    );
    const [draftBack] = await db.select().from(agentSendRequests).where(eq(agentSendRequests.id, draft.id));
    t.check("unmerge gives the pending draft back to the loser", draftBack?.contactId === loser.id, `contact_id=${draftBack?.contactId ?? "null"}`);

    console.log("\nThe same posting matched to both contacts (unique on user, posting, contact)...");
    const [winnerMatch] = await db
      .insert(jobPostingMatches)
      .values({ userId: USER, postingId: posting.id, contactId: winner.id, companyKey: "globex", matchKind: "referral" })
      .returning();
    const second = await mergeContacts(USER, winner.id, loser.id, { deferInvalidation: true });
    const onPosting = await db
      .select()
      .from(jobPostingMatches)
      .where(and(eq(jobPostingMatches.userId, USER), eq(jobPostingMatches.postingId, posting.id)));
    t.check(
      "the merge does not fail on the collision and the winner keeps exactly its own match",
      onPosting.length === 1 && onPosting[0].id === winnerMatch.id && onPosting[0].contactId === winner.id,
      JSON.stringify(onPosting.map((m) => [m.id === winnerMatch.id ? "winner's" : "loser's", m.contactId]))
    );
    await unmergeContacts(USER, second.mergeId);
    const [loserMatchBack] = await db.select().from(jobPostingMatches).where(eq(jobPostingMatches.id, match.id));
    t.check("unmerge restores the archived duplicate match to the loser", loserMatchBack?.contactId === loser.id, `contact_id=${loserMatchBack?.contactId ?? "gone"}`);
  } finally {
    await purgeUsers(db, [USER]);
    const postings = await db.select({ id: jobPostings.id }).from(jobPostings).where(eq(jobPostings.sourceId, SOURCE_ID));
    if (postings.length) await db.delete(jobPostings).where(inArray(jobPostings.id, postings.map((p) => p.id)));
    await db.delete(jobFeedSources).where(eq(jobFeedSources.id, SOURCE_ID));
  }

  t.done("merge moves children");
});
