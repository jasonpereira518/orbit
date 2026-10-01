/**
 * The flagless pending predicate: a contact is pending when it has a non-blank message row
 * newer than its watermark (or no digest), attempts < 3, and no batch in flight. Claim order
 * is newest conversation first.
 *
 * Run: npx tsx scripts/smoke-relationship-pending.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-rel-pending";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-rel-pending";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, relationshipDigests, userSettings } from "../src/db/schema";
import {
  claimPendingContacts,
  pendingRelationshipContactCount,
  usersWithPendingRelationshipWork,
} from "../src/lib/relationship-engine/pending";
import { loadMessageWindows } from "../src/lib/relationship-engine/gather";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-rel-pending-user";
const OFF_USER = "smoke-rel-pending-off-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset(userId: string) {
  const db = await getDb();
  await db.delete(relationshipDigests).where(eq(relationshipDigests.userId, userId));
  await db.delete(interactions).where(eq(interactions.userId, userId));
  await db.delete(contacts).where(eq(contacts.userId, userId));
  await db.delete(userSettings).where(eq(userSettings.userId, userId));
  await ensureUserSettings(userId);
}

async function seed(userId: string, name: string, bodies: Array<[string, string]>) {
  const db = await getDb();
  const [c] = await db.insert(contacts).values({ userId, fullName: name, source: "linkedin_messages" }).returning();
  const rows = await db
    .insert(interactions)
    .values(
      bodies.map(([iso, body], i) => ({
        userId,
        contactId: c.id,
        interactionType: "linkedin_message",
        interactionDate: new Date(iso),
        source: "linkedin_messages",
        externalId: `li-msg:${name}:${iso}:${i}`,
        rawNotes: body,
        aiSummary: body.slice(0, 240),
        topics: [],
        direction: i % 2 === 0 ? ("in" as const) : ("out" as const),
      }))
    )
    .returning();
  return { contactId: c.id, rows };
}

async function main() {
  await reset(USER);
  await reset(OFF_USER);
  const db = await getDb();

  const old = await seed(USER, "Old Thread", [["2024-01-02T10:00:00Z", "hello there, long time"]]);
  const fresh = await seed(USER, "Fresh Thread", [["2026-09-20T10:00:00Z", "are you around next week?"]]);
  const blank = await seed(USER, "Blank Thread", [["2026-09-21T10:00:00Z", "   "]]);
  await db.insert(contacts).values({ userId: USER, fullName: "No Messages", source: "manual" });

  check("count: two non-blank threads pending", (await pendingRelationshipContactCount(USER)) === 2);
  const order = await claimPendingContacts(USER, 10, new Set());
  check("claim: newest conversation first", order[0] === fresh.contactId && order[1] === old.contactId, JSON.stringify(order));
  check("claim: blank thread never claimed", !order.includes(blank.contactId));
  // Drift guard: gather must produce a window for every contact the claim returns.
  const windows = await loadMessageWindows(USER, [...order, blank.contactId]);
  check("gather: window for every claimed contact", order.every((id) => windows.has(id)), JSON.stringify(order));
  check("gather: blank thread has no window", !windows.has(blank.contactId));
  check("claim: exclude set honoured", !(await claimPendingContacts(USER, 10, new Set([fresh.contactId]))).includes(fresh.contactId));

  // Watermark at the only message → not pending.
  await db.insert(relationshipDigests).values({
    contactId: old.contactId,
    userId: USER,
    watermarkAt: old.rows[0].interactionDate,
    watermarkInteractionId: old.rows[0].id,
  });
  check("watermark at last message → not pending", (await pendingRelationshipContactCount(USER)) === 1);

  // A newer message → pending again.
  await db.insert(interactions).values({
    userId: USER,
    contactId: old.contactId,
    interactionType: "linkedin_message",
    interactionDate: new Date("2026-09-25T10:00:00Z"),
    source: "linkedin_messages",
    externalId: "li-msg:old:new",
    rawNotes: "following up on the deck",
    topics: [],
  });
  check("newer message → pending again", (await pendingRelationshipContactCount(USER)) === 2);

  // Batch in flight → not pending; stale batch → pending.
  await db
    .update(relationshipDigests)
    .set({ batchPendingUntil: new Date(Date.now() + 3_600_000) })
    .where(eq(relationshipDigests.contactId, old.contactId));
  check("batch in flight → not pending", (await pendingRelationshipContactCount(USER)) === 1);
  await db
    .update(relationshipDigests)
    .set({ batchPendingUntil: new Date(Date.now() - 1000) })
    .where(eq(relationshipDigests.contactId, old.contactId));
  check("stale batch → pending", (await pendingRelationshipContactCount(USER)) === 2);

  // Three failed attempts → parked.
  // (A failure writes updated_at; the messages above all predate it.)
  await db.update(relationshipDigests).set({ attempts: 3, updatedAt: new Date() }).where(eq(relationshipDigests.contactId, old.contactId));
  check("attempts >= 3 → not pending", (await pendingRelationshipContactCount(USER)) === 1);

  // A message that arrives after the last failure re-arms a parked contact (claim agrees).
  await db.insert(interactions).values({
    userId: USER,
    contactId: old.contactId,
    interactionType: "linkedin_message",
    interactionDate: new Date("2026-09-26T10:00:00Z"),
    source: "linkedin_messages",
    externalId: "li-msg:old:after-park",
    rawNotes: "any update on the deck?",
    topics: [],
    createdAt: new Date(Date.now() + 60_000),
  });
  check("parked + newer message → pending again", (await pendingRelationshipContactCount(USER)) === 2);
  check("  and claimable", (await claimPendingContacts(USER, 10, new Set())).includes(old.contactId));
  await db.update(relationshipDigests).set({ attempts: 4, updatedAt: new Date(Date.now() + 120_000) }).where(eq(relationshipDigests.contactId, old.contactId));
  check("  and parked again after another failure", (await pendingRelationshipContactCount(USER)) === 1);

  // User sweep honours the settings switch.
  await seed(OFF_USER, "Off Thread", [["2026-09-20T10:00:00Z", "hi"]]);
  await db.update(userSettings).set({ relationshipEngineEnabled: 0 }).where(eq(userSettings.userId, OFF_USER));
  const users = await usersWithPendingRelationshipWork(100);
  check("sweep includes enabled user", users.includes(USER));
  check("sweep excludes disabled user", !users.includes(OFF_USER));

  await reset(USER);
  await reset(OFF_USER);
  console.log("\nsmoke-relationship-pending: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
