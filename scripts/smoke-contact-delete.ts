/**
 * Deleting a contact takes the structured rows tied to them (audit B10). Run: npx tsx scripts/smoke-contact-delete.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import * as schema from "../src/db/schema";
import { setAvatarBlobClientForTests } from "../src/lib/avatar-blob";
import { deleteContactForUser } from "../src/lib/contact-delete";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-contact-delete-user";
const BLOB = (n: string) => `https://abc.public.blob.vercel-storage.com/avatars/${n}.jpg`;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const db = await getDb();
  const deleted: string[] = [];
  setAvatarBlobClientForTests({ put: async () => ({ url: "" }), del: async (urls) => void deleted.push(...urls) });
  try {
    const [c] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Ada Lovelace", profileImageUrl: BLOB("ada") }).returning();
    const [d] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Bob Other" }).returning();
    await db.insert(schema.interactions).values({ userId: USER, contactId: c.id, interactionType: "note", rawNotes: "coffee" });
    const [event] = await db.insert(schema.events).values({ userId: USER, title: "Summit" }).returning();
    await db.insert(schema.eventAttendees).values([
      { eventId: event.id, userId: USER, fullName: "Ada Lovelace", email: "ada@x.test", identityKey: "email:ada@x.test", contactId: c.id },
      { eventId: event.id, userId: USER, fullName: "Bob Other", identityKey: "name:bob other", contactId: d.id },
    ]);
    const [campaign] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "C" }).returning();
    const [pc] = await db.insert(schema.outreachProspects).values({ campaignId: campaign.id, externalId: "p-ada", fullName: "Ada Lovelace", email: "ada@x.test", contactId: c.id }).returning();
    await db.insert(schema.outreachProspects).values({ campaignId: campaign.id, externalId: "p-bob", fullName: "Bob Other", contactId: d.id });
    await db.insert(schema.outreachMessages).values({ prospectId: pc.id, channel: "email", body: "hi" });
    await db.insert(schema.suggestedReminders).values({
      userId: USER, contactId: c.id, captureBatchId: randomUUID(), title: "Follow up with Ada", rawDatePhrase: "Friday",
      dueDate: new Date(), sourceExcerpt: "follow up with Ada Friday", sourceHash: "h", itemHash: `i-${randomUUID()}`,
    });
    await db.insert(schema.contactMerges).values({ userId: USER, winnerContactId: c.id, loserContactId: randomUUID(), loserSnapshot: { full_name: "A. Lovelace", profile_image_url: BLOB("ada-old") } });
    await db.execute(sql`INSERT INTO note_batches (user_id, source_hash, source_text, anchor_date, result, seed_contact_id) VALUES (${USER}, 'h', 'met Ada at the summit', now(), '{}'::jsonb, ${c.id}::uuid)`);
    const [thread] = await db.insert(schema.chatThreads).values({ userId: USER, title: "t" }).returning();
    await db.insert(schema.chatMessages).values({ threadId: thread.id, userId: USER, role: "user", content: "who is Ada?", attachedContacts: [{ id: c.id, name: "Ada" }, { id: d.id, name: "Bob" }] });

    check("someone else cannot delete it", (await deleteContactForUser("someone-else", c.id)).deleted === false);
    check("the owner can", (await deleteContactForUser(USER, c.id)).deleted === true);

    const n = async (q: ReturnType<typeof sql>) => rowsOf<{ n: number }>(await db.execute(q))[0]?.n ?? 0;
    check("the contact is gone", (await n(sql`SELECT count(*)::int AS n FROM contacts WHERE id = ${c.id}::uuid`)) === 0);
    check("their interactions went with it", (await n(sql`SELECT count(*)::int AS n FROM interactions WHERE contact_id = ${c.id}::uuid`)) === 0);
    check("their roster row is deleted, the other stays", (await n(sql`SELECT count(*)::int AS n FROM event_attendees WHERE user_id = ${USER}`)) === 1);
    // Only this prospect's messages: the table is shared with every other smoke on the database.
    check("their prospect and its messages are deleted, the other stays", (await n(sql`SELECT count(*)::int AS n FROM outreach_prospects WHERE campaign_id = ${campaign.id}::uuid`)) === 1 && (await n(sql`SELECT count(*)::int AS n FROM outreach_messages WHERE prospect_id = ${pc.id}::uuid`)) === 0);
    check("pending suggestions about them are deleted", (await n(sql`SELECT count(*)::int AS n FROM suggested_reminders WHERE user_id = ${USER}`)) === 0);
    check("merge snapshots of them are deleted", (await n(sql`SELECT count(*)::int AS n FROM contact_merges WHERE user_id = ${USER}`)) === 0);
    check("the note batch survives, unlinked", (await n(sql`SELECT count(*)::int AS n FROM note_batches WHERE user_id = ${USER} AND seed_contact_id IS NULL`)) === 1);
    const [msg] = await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.threadId, thread.id));
    check("the chat attachment is removed, the other kept", JSON.stringify(msg.attachedContacts) === JSON.stringify([{ id: d.id, name: "Bob" }]), JSON.stringify(msg.attachedContacts));
    check("their photos are deleted from Blob", deleted.includes(BLOB("ada")) && deleted.includes(BLOB("ada-old")), JSON.stringify(deleted));
  } finally {
    setAvatarBlobClientForTests(null);
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  console.log("\nAll contact-delete checks passed.");
}

run(main);
