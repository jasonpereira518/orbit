/**
 * A merge rewrites `radar_opportunities.related_contact_ids` from the loser to the winner, and
 * unmerge reverses it.
 *
 * The array names the people an opportunity connects to (who is going, who can introduce, who
 * works there). It is a uuid[] with no foreign key, so nothing in the database moves it:
 * without `mergeContacts` step 4c-2b an opportunity would keep pointing at a merged-away id.
 * Same two cases as memory_chunks.contact_ids: replaced (named only the loser) and collapsed
 * (named both).
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-merge-radar-opportunities.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { radarOpportunities } from "../src/db/schema";
import { mergeContacts, unmergeContacts } from "../src/lib/contact-merge";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, purgeUsers } from "./smoke/factories";

const t = checker();
const USER = fakeUserId("merge-radar-opps");

run(async () => {
  const db = await getDb();
  await purgeUsers(db, [USER]);

  try {
    const winner = await insertContact(db, USER, 1);
    const loser = await insertContact(db, USER, 1, { email: "grace.hopper+alt@example.com", linkedinUrl: null, phone: null });
    const other = await insertContact(db, USER, 2);

    const [onlyLoser] = await db
      .insert(radarOpportunities)
      .values({ userId: USER, kind: "event", title: "Agents meetup", dedupeKey: "smoke-merge-opp-1", relatedContactIds: [other.id, loser.id] })
      .returning();
    const [both] = await db
      .insert(radarOpportunities)
      .values({ userId: USER, kind: "opening", title: "Design role", dedupeKey: "smoke-merge-opp-2", relatedContactIds: [loser.id, winner.id] })
      .returning();

    const { mergeId } = await mergeContacts(USER, winner.id, loser.id, { deferInvalidation: true });

    const [a] = await db.select().from(radarOpportunities).where(eq(radarOpportunities.id, onlyLoser!.id));
    t.check(
      "merge swaps the loser for the winner, keeping the order",
      JSON.stringify(a?.relatedContactIds) === JSON.stringify([other.id, winner.id]),
      JSON.stringify(a?.relatedContactIds)
    );
    const [b] = await db.select().from(radarOpportunities).where(eq(radarOpportunities.id, both!.id));
    t.check("an opportunity naming both collapses to the winner once", JSON.stringify(b?.relatedContactIds) === JSON.stringify([winner.id]), JSON.stringify(b?.relatedContactIds));

    await unmergeContacts(USER, mergeId);
    const [aBack] = await db.select().from(radarOpportunities).where(eq(radarOpportunities.id, onlyLoser!.id));
    t.check("unmerge points it back at the restored loser", JSON.stringify(aBack?.relatedContactIds) === JSON.stringify([other.id, loser.id]), JSON.stringify(aBack?.relatedContactIds));
    const [bBack] = await db.select().from(radarOpportunities).where(eq(radarOpportunities.id, both!.id));
    t.check(
      "unmerge gives the loser back to the one that named both",
      Boolean(bBack) && bBack!.relatedContactIds.length === 2 && bBack!.relatedContactIds.includes(loser.id) && bBack!.relatedContactIds.includes(winner.id),
      JSON.stringify(bBack?.relatedContactIds)
    );
  } finally {
    await db.delete(radarOpportunities).where(eq(radarOpportunities.userId, USER));
    await purgeUsers(db, [USER]);
  }

  t.done("merge rewrites radar_opportunities");
});
