/**
 * KNOWN BUG — documented, not fixed.
 *
 * Symptom: after a merge, an email queued to (or failed for) the losing record no longer
 * shows on the surviving contact's page, and when it does go out its "Emailed: …" timeline
 * entry is never logged — the send still names a contact id that no longer exists.
 *
 * Why: `email_sends.contact_ids` is a jsonb array with no foreign key (schema.ts ~6168).
 * `mergeContacts` (src/lib/contact-merge.ts:144) rewrites the two other id arrays the schema
 * carries — `memory_chunks.contact_ids` (step 4c-2) and `ai_suggestions.related_contact_ids`
 * (step 4d) — but not this one. Every reader of it is keyed by the contact:
 * `listContactPendingSends` (src/lib/email/compose.ts:271) and `latestOrbitSend`
 * (src/lib/email/reply-targets.ts:63) filter `contact_ids @> [contactId]`, and the outbox
 * (src/lib/email/outbox.ts:335) logs one interaction per id in the array, which for the
 * merged-away id fails and is swallowed as a warning.
 *
 * Trigger path: compose an email to someone (queued with the undo delay, or failed and
 * waiting for a retry), then merge that contact into its duplicate — by hand on the
 * Duplicates page or via the automatic sweep (`src/lib/duplicate-sweep.ts`). The winner's
 * page shows no pending or failed send to retry or dismiss.
 *
 * Severity: medium — a failed send the user should retry becomes invisible; the sent mail's
 * timeline entry silently goes missing. Bounded to sends in flight at merge time.
 *
 * Fix: rewrite `email_sends.contact_ids` in the merge (loser -> winner, deduped, recorded so
 * unmerge can reverse it, as memory_chunks does). This script then exits 0 and should be
 * promoted to the pglite tier.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-bug-merge-email-sends.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { emailSends } from "../src/db/schema";
import { mergeContacts } from "../src/lib/contact-merge";
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

    await mergeContacts(USER, winner.id, loser.id, { deferInvalidation: true });

    const [row] = await db.select().from(emailSends).where(eq(emailSends.id, send.id));
    t.check("the send row itself survives the merge (no foreign key, nothing cascades)", Boolean(row));
    t.knownBug(
      "BUG: merge leaves email_sends.contact_ids naming the merged-away contact",
      Boolean(row) && row.contactIds.includes(winner.id) && !row.contactIds.includes(loser.id),
      `contact_ids=${JSON.stringify(row?.contactIds)}, winner=${winner.id}`
    );

    const after = await listContactPendingSends(USER, winner.id);
    t.knownBug(
      "BUG: the failed send no longer appears on the surviving contact's page (listContactPendingSends)",
      after.some((s) => s.id === send.id),
      `pending sends on winner: ${after.length}`
    );
  } finally {
    await purgeUsers(db, [USER]);
  }

  t.done("merge leaves email_sends stale (known bug)");
});
