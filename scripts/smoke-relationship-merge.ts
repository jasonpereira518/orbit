/**
 * A merge must leave the winner re-readable: the loser's digest goes with the loser (cascade),
 * the winner's watermark is cleared so the merged history is analyzed again.
 *
 * Run: npx tsx scripts/smoke-relationship-merge.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-rel-merge";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-rel-merge";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactMerges, contacts, interactions, relationshipDigests, userSettings } from "../src/db/schema";
import { mergeContacts } from "../src/lib/contact-merge";
import { pendingRelationshipContactCount } from "../src/lib/relationship-engine/pending";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-rel-merge-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  for (const t of [relationshipDigests, contactMerges, interactions, contacts, userSettings]) await db.delete(t).where(eq(t.userId, USER));
  await ensureUserSettings(USER);
}

async function main() {
  await reset();
  const db = await getDb();
  const [a, b] = await db.insert(contacts).values([
    { userId: USER, fullName: "Maya Chen", source: "linkedin_messages" },
    { userId: USER, fullName: "Maya Chen", source: "manual" },
  ]).returning();
  const [m] = await db.insert(interactions).values({
    userId: USER, contactId: a.id, interactionType: "linkedin_message", interactionDate: new Date(), source: "linkedin_messages", externalId: "li-msg:merge", rawNotes: "let's talk next week about the role", topics: [],
  }).returning();
  for (const c of [a, b]) {
    await db.insert(relationshipDigests).values({ contactId: c.id, userId: USER, summary: "x", watermarkAt: m.interactionDate, watermarkInteractionId: m.id });
  }
  check("nothing pending before merge", (await pendingRelationshipContactCount(USER)) === 0);

  await mergeContacts(USER, b.id, a.id);

  const left = await db.query.relationshipDigests.findMany({ where: eq(relationshipDigests.userId, USER) });
  check("loser digest gone", !left.some((d) => d.contactId === a.id));
  check("winner watermark cleared", left.find((d) => d.contactId === b.id)?.watermarkAt == null);
  check("winner pending again", (await pendingRelationshipContactCount(USER)) === 1);

  // A removed relationship kind ("Not right?") follows the merge: it is never set again.
  const kindCase = async (winner: { kind: "friend"; removed?: true } | null, loser: { kind: "recruiter"; removed?: true } | null) => {
    await reset();
    const [l, w] = await db.insert(contacts).values([
      { userId: USER, fullName: "Kai Loser", source: "linkedin_messages" },
      { userId: USER, fullName: "Kai Winner", source: "manual" },
    ]).returning();
    if (loser) await db.insert(relationshipDigests).values({ contactId: l.id, userId: USER, relationship: { ...loser, excerpt: "x", interactionId: l.id } });
    if (winner) await db.insert(relationshipDigests).values({ contactId: w.id, userId: USER, relationship: { ...winner, excerpt: "x", interactionId: w.id } });
    await mergeContacts(USER, w.id, l.id);
    return (await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, w.id) }))?.relationship ?? null;
  };
  check("a loser's removed kind reaches a winner with no digest", (await kindCase(null, { kind: "recruiter", removed: true }))?.removed === true);
  const over = await kindCase({ kind: "friend" }, { kind: "recruiter", removed: true });
  check("a loser's removed kind replaces a winner's that is not removed", over?.removed === true && over?.kind === "recruiter");
  check("neither removed: the winner keeps its kind", (await kindCase({ kind: "friend" }, { kind: "recruiter" }))?.kind === "friend");
  const both = await kindCase({ kind: "friend", removed: true }, { kind: "recruiter", removed: true });
  check("winner already removed: its own stands", both?.kind === "friend" && both?.removed === true);

  await reset();
  console.log("\nsmoke-relationship-merge: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
