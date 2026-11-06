/**
 * A merge rewrites `email_sends.contact_ids` from the loser to the winner, and unmerge
 * reverses it.
 *
 * Pins the fix for a bug where the array (jsonb, no foreign key) kept naming the merged-away
 * id: every reader is keyed by the contact — `listContactPendingSends`
 * (src/lib/email/compose.ts), `latestOrbitSend` (src/lib/email/reply-targets.ts) and the
 * outbox's per-contact "Emailed: …" log (src/lib/email/outbox.ts) — so a queued or failed
 * send vanished from the surviving contact's page and its timeline entry was never written.
 * `mergeContacts` (src/lib/contact-merge.ts, step 4c-3) now replaces the id (or drops it when
 * the send already named the winner too) and records which, so `unmergeContacts` can put it
 * back, as it does for memory_chunks.contact_ids.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-merge-email-sends.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { emailSends } from "../src/db/schema";
import { mergeContacts, unmergeContacts } from "../src/lib/contact-merge";
import { listContactPendingSends } from "../src/lib/email/compose";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, purgeUsers } from "./smoke/factories";

const t = checker();
const USER = fakeUserId("merge-email");

run(async () => {
  const db = await getDb();
  await purgeUsers(db, [USER]);

  try {
    const winner = await insertContact(db, USER, 1);
    const loser = await insertContact(db, USER, 1, { email: "grace.hopper+alt@example.com", linkedinUrl: null, phone: null });

    const [send] = await db
      .insert(emailSends)
      .values({
        userId: USER,
        provider: "demo",
        fromEmail: "owner@orbit.test",
        to: ["grace.hopper+alt@example.com"],
        subject: "Great meeting you",
        bodyText: "Hi Grace — great meeting you at the meetup.",
        contactIds: [loser.id],
        origin: "compose",
        status: "failed",
        failureKind: "auth",
        sendAt: new Date(),
        rfcMessageId: "<smoke-merge-email@orbit.test>",
      })
      .returning();

    const before = await listContactPendingSends(USER, loser.id);
    t.check("setup: the failed send shows on the loser's page before the merge", before.some((s) => s.id === send.id));

    // A second send addressed to both records: the pair collapses to the winner alone.
    const [both] = await db
      .insert(emailSends)
      .values({
        userId: USER,
        provider: "demo",
        fromEmail: "owner@orbit.test",
        to: ["grace.hopper@example.com", "grace.hopper+alt@example.com"],
        subject: "Both addresses",
        bodyText: "Hi Grace.",
        contactIds: [loser.id, winner.id],
        origin: "compose",
        status: "queued",
        sendAt: new Date(Date.now() + 60_000),
        rfcMessageId: "<smoke-merge-email-both@orbit.test>",
      })
      .returning();

    const { mergeId } = await mergeContacts(USER, winner.id, loser.id, { deferInvalidation: true });

    const [row] = await db.select().from(emailSends).where(eq(emailSends.id, send.id));
    t.check("the send row itself survives the merge (no foreign key, nothing cascades)", Boolean(row));
    t.check(
      "merge rewrites email_sends.contact_ids from the merged-away contact to the winner",
      Boolean(row) && row.contactIds.includes(winner.id) && !row.contactIds.includes(loser.id),
      `contact_ids=${JSON.stringify(row?.contactIds)}, winner=${winner.id}`
    );

    const after = await listContactPendingSends(USER, winner.id);
    t.check(
      "the failed send appears on the surviving contact's page (listContactPendingSends)",
      after.some((s) => s.id === send.id),
      `pending sends on winner: ${after.length}`
    );
    const [bothAfter] = await db.select().from(emailSends).where(eq(emailSends.id, both.id));
    t.check("a send naming both contacts collapses to the winner once", JSON.stringify(bothAfter?.contactIds) === JSON.stringify([winner.id]), JSON.stringify(bothAfter?.contactIds));

    await unmergeContacts(USER, mergeId);
    const [rowBack] = await db.select().from(emailSends).where(eq(emailSends.id, send.id));
    t.check("unmerge points the send back at the restored loser", JSON.stringify(rowBack?.contactIds) === JSON.stringify([loser.id]), JSON.stringify(rowBack?.contactIds));
    const [bothBack] = await db.select().from(emailSends).where(eq(emailSends.id, both.id));
    t.check(
      "unmerge gives the loser back to the send that named both",
      Boolean(bothBack) && bothBack.contactIds.length === 2 && bothBack.contactIds.includes(loser.id) && bothBack.contactIds.includes(winner.id),
      JSON.stringify(bothBack?.contactIds)
    );
    const loserPending = await listContactPendingSends(USER, loser.id);
    t.check("the failed send is back on the loser's page", loserPending.some((s) => s.id === send.id));
  } finally {
    await purgeUsers(db, [USER]);
  }

  t.done("merge rewrites email_sends");
});
