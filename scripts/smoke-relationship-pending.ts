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

import { eq, sql } from "drizzle-orm";
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

  // A microsecond interaction_date with the watermark written from a JS Date (milliseconds)
  // must not stay pending forever.
  const micro = await seed(USER, "Micro Thread", [["2026-09-27T10:00:00.123Z", "see you at the offsite"]]);
  await db.execute(sql`UPDATE interactions SET interaction_date = '2026-09-27T10:00:00.123456Z'::timestamptz WHERE id = ${micro.rows[0].id}::uuid`);
  const microBefore = await pendingRelationshipContactCount(USER);
  await db.insert(relationshipDigests).values({
    contactId: micro.contactId,
    userId: USER,
    watermarkAt: new Date("2026-09-27T10:00:00.123Z"),
    watermarkInteractionId: micro.rows[0].id,
  });
  check("microsecond message at the watermark → not pending", (await pendingRelationshipContactCount(USER)) === microBefore - 1);
  await db.delete(relationshipDigests).where(eq(relationshipDigests.contactId, micro.contactId));
  await db.delete(interactions).where(eq(interactions.contactId, micro.contactId));
  await db.delete(contacts).where(eq(contacts.id, micro.contactId));

  // Newest rows: a backlog past rowLimit keeps the NEWEST rows, oldest-first, and says older ones exist.
  const backlog = await seed(
    USER,
    "Backlog Thread",
    Array.from({ length: 8 }, (_, i): [string, string] => [`2026-08-${String(i + 1).padStart(2, "0")}T10:00:00Z`, `m${i + 1}`])
  );
  const cut = (await loadMessageWindows(USER, [backlog.contactId], { rowLimit: 5 })).get(backlog.contactId);
  check("rowLimit: window exists", !!cut);
  check("rowLimit: first message is the 4th row", cut?.messages[0].text === "m4", cut?.messages[0].text);
  check("rowLimit: keeps the newest row", cut?.messages[cut.messages.length - 1].text === "m8");
  check("rowLimit: oldest-first", cut?.messages.map((m) => m.text).join(",") === "m4,m5,m6,m7,m8");
  check("rowLimit: truncatedBefore set to first kept row", cut?.truncatedBefore?.toISOString() === "2026-08-04T10:00:00.000Z");
  const uncut = (await loadMessageWindows(USER, [backlog.contactId], { rowLimit: 8 })).get(backlog.contactId);
  check("rowLimit: exactly-fitting backlog is read from the start, not truncated", uncut?.messages[0].text === "m1" && uncut.truncatedBefore === null);

  // A chat session row speaks as "Chat", whatever its direction.
  const [chatContact] = await db.insert(contacts).values({ userId: USER, fullName: "Chat Person", source: "whatsapp" }).returning();
  await db.insert(interactions).values({
    userId: USER,
    contactId: chatContact.id,
    interactionType: "message",
    interactionDate: new Date("2026-09-28T10:00:00Z"),
    source: "whatsapp",
    externalId: "chat-session:1",
    rawNotes: "[10:00 Me] hi\n[10:01 Chat Person] hey",
    topics: [],
    direction: "out",
  });
  const chat = (await loadMessageWindows(USER, [chatContact.id])).get(chatContact.id);
  check("session speaker: Chat", chat?.messages[0].speaker === "Chat");
  check("session line renders [date Chat] [", !!chat?.text.startsWith("[2026-09-28 Chat] ["), chat?.text);

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
