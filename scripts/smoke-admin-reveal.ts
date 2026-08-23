/**
 * The security smoke for the audited unmask.
 *
 * This is the script that has to fail loudly if the reveal system ever regresses, because
 * the thing it protects is other people's data — third parties who never signed up for
 * Orbit and cannot object. The assertions are deliberately about *absence*: not that a
 * masked payload nulls the sensitive fields, but that it does not carry the keys at all,
 * which is only true if the query never selected them.
 *
 * Run: npx tsx scripts/smoke-admin-reveal.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { readFileSync } from "node:fs";
import { inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  adminAuditLog,
  adminRevealGrants,
  chatMessages,
  chatThreads,
  contactEmbeddings,
  contactTags,
  contacts,
  interactions,
  reminders,
  userSettings,
} from "../src/db/schema";
import {
  assertNoForbiddenValues,
  assertRevealable,
  NEVER_REVEALABLE,
} from "../src/lib/admin-redaction";
import {
  createRevealGrant,
  grantCovers,
  revokeRevealGrants,
  verifyRevealGrant,
  activeRevealGrant,
} from "../src/lib/admin-reveal";
import {
  getAdminContactDetail,
  listAdminContacts,
} from "../src/lib/admin-user-detail";
import { ensureUserSettings } from "../src/lib/user-settings";

const PREFIX = "smoke-reveal-";
const ADMIN = `${PREFIX}admin`;
const A = `${PREFIX}account-a`;
const B = `${PREFIX}account-b`;
const IDS = [A, B];

/** Sentinel values seeded into the database; none may ever appear in a masked payload. */
const SECRET = {
  nameA: "Zebediah Quartzfeather",
  emailA: "zebediah.quartzfeather@example-secret.test",
  phoneA: "+1-555-0100-SECRET",
  notesA: "SECRET-NOTE-ALPHA he is nervous about the reorg",
  keyFactA: "SECRET-FACT-ALPHA plays the theremin",
  interactionNotesA: "SECRET-RAWNOTES-ALPHA said the round is oversubscribed",
  chatContent: "SECRET-CHAT-TRANSCRIPT who do I know at OpenAI",
  nameB: "Persimmon Halloway",
  emailB: "persimmon.halloway@example-secret.test",
};

const MASKED_FORBIDDEN = [
  SECRET.nameA,
  SECRET.emailA,
  SECRET.phoneA,
  SECRET.notesA,
  SECRET.keyFactA,
  SECRET.interactionNotesA,
  SECRET.chatContent,
];

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  const userContacts = await db.query.contacts.findMany({
    where: inArray(contacts.userId, IDS),
    columns: { id: true },
  });
  for (const c of userContacts) {
    await db.delete(contactTags).where(inArray(contactTags.contactId, [c.id]));
  }
  await db.delete(contactEmbeddings).where(inArray(contactEmbeddings.userId, IDS));
  await db.delete(interactions).where(inArray(interactions.userId, IDS));
  await db.delete(reminders).where(inArray(reminders.userId, IDS));
  await db.delete(chatMessages).where(inArray(chatMessages.userId, IDS));
  await db.delete(chatThreads).where(inArray(chatThreads.userId, IDS));
  await db.delete(contacts).where(inArray(contacts.userId, IDS));
  await db.delete(adminRevealGrants).where(like(adminRevealGrants.targetUserId, `${PREFIX}%`));
  await db.delete(adminAuditLog).where(like(adminAuditLog.targetUserId, `${PREFIX}%`));
  await db.delete(userSettings).where(inArray(userSettings.userId, [...IDS, ADMIN]));
}

async function seed() {
  const db = await getDb();
  await ensureUserSettings(A);
  await ensureUserSettings(B);

  const [contactA] = await db
    .insert(contacts)
    .values({
      userId: A,
      fullName: SECRET.nameA,
      email: SECRET.emailA,
      phone: SECRET.phoneA,
      company: "Quartz Industries",
      title: "VP Engineering",
      notes: SECRET.notesA,
      keyFacts: [SECRET.keyFactA],
      opportunities: ["SECRET-OPP-ALPHA"],
      aiSummary: "SECRET-SUMMARY-ALPHA",
      metContext: "SECRET-MET-ALPHA",
      howMet: "SECRET-HOWMET-ALPHA",
    })
    .returning();

  await db.insert(interactions).values({
    userId: A,
    contactId: contactA.id,
    interactionType: "coffee",
    interactionDate: new Date(),
    rawNotes: SECRET.interactionNotesA,
    aiSummary: "SECRET-ISUMMARY-ALPHA",
    topics: ["SECRET-TOPIC-ALPHA"],
    actionItems: ["SECRET-ACTION-ALPHA"],
    sentiment: "positive",
  });

  const [thread] = await db
    .insert(chatThreads)
    .values({ userId: A, title: "SECRET-THREAD-TITLE" })
    .returning();
  await db.insert(chatMessages).values({
    threadId: thread.id,
    userId: A,
    role: "user",
    content: SECRET.chatContent,
  });

  const [contactB] = await db
    .insert(contacts)
    .values({
      userId: B,
      fullName: SECRET.nameB,
      email: SECRET.emailB,
      company: "Halloway Partners",
    })
    .returning();

  return { contactA, contactB };
}

async function main() {
  console.log("Admin reveal");
  process.env.ADMIN_USER_IDS = ADMIN;
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_fake";

  await cleanup();
  const { contactA, contactB } = await seed();
  const db = await getDb();

  /* -------------------------------------------------------------------- masked default */

  const maskedPage = await listAdminContacts(A);
  check("masked page returns the contact", maskedPage.rows.length === 1);
  check(
    "masked name is a length hint, not a name",
    maskedPage.rows[0].maskedName.includes("▨") &&
      !maskedPage.rows[0].maskedName.includes(SECRET.nameA)
  );
  check("masked row carries no revealed payload", maskedPage.rows[0].revealed === null);

  // Absence of the KEY, not merely a null value: only true if the column was never selected.
  const maskedKeys = Object.keys(maskedPage.rows[0]);
  check(
    "masked row has no email/notes/phone keys at all",
    !maskedKeys.includes("email") &&
      !maskedKeys.includes("notes") &&
      !maskedKeys.includes("phone"),
    maskedKeys.join(",")
  );
  assertNoForbiddenValues(maskedPage, MASKED_FORBIDDEN);
  console.log("  ok  masked page contains no seeded secret value");

  const maskedDetail = await getAdminContactDetail(A, contactA.id);
  check("masked detail resolves", maskedDetail !== null);
  check("masked detail carries no revealed payload", maskedDetail!.contact.revealed === null);
  check(
    "masked detail still reports note presence",
    maskedDetail!.interactions[0]?.hasRawNotes === true &&
      maskedDetail!.interactions[0]?.topicCount === 1
  );
  check(
    "masked interaction carries no revealed payload",
    maskedDetail!.interactions[0]?.revealed === null
  );
  assertNoForbiddenValues(maskedDetail, MASKED_FORBIDDEN);
  console.log("  ok  masked detail contains no seeded secret value");

  /* --------------------------------------------------------------------- a live grant */

  const grantSummary = await createRevealGrant({
    adminUserId: ADMIN,
    targetUserId: A,
    reason: "investigating a mangled LinkedIn import",
  });
  const grant = await verifyRevealGrant(grantSummary.id, {
    adminUserId: ADMIN,
    targetUserId: A,
  });
  check("grant verifies", grant !== null);

  const revealedPage = await listAdminContacts(A, { grant });
  check(
    "revealed page shows the real name",
    revealedPage.rows[0].maskedName === SECRET.nameA
  );
  check(
    "revealed page carries email, phone and notes",
    revealedPage.rows[0].revealed?.email === SECRET.emailA &&
      revealedPage.rows[0].revealed?.phone === SECRET.phoneA &&
      revealedPage.rows[0].revealed?.notes === SECRET.notesA
  );
  check(
    "revealed page carries key facts",
    revealedPage.rows[0].revealed?.keyFacts?.[0] === SECRET.keyFactA
  );

  const revealedDetail = await getAdminContactDetail(A, contactA.id, { grant });
  check(
    "revealed detail carries interaction raw notes",
    revealedDetail!.interactions[0].revealed?.rawNotes === SECRET.interactionNotesA
  );

  /* ------------------------------------------- chat transcripts are never reachable */

  const revealedBlob = JSON.stringify({ revealedPage, revealedDetail });
  check(
    "chat transcript absent even under a live grant",
    !revealedBlob.includes(SECRET.chatContent)
  );

  let threw = false;
  try {
    assertRevealable(["chat_messages.content"]);
  } catch {
    threw = true;
  }
  check("assertRevealable rejects chat_messages.content", threw);

  for (const column of NEVER_REVEALABLE) {
    let rejected = false;
    try {
      assertRevealable([column]);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`assertRevealable accepted ${column}`);
  }
  console.log(`  ok  assertRevealable rejects all ${NEVER_REVEALABLE.length} denied columns`);

  // A source-level assertion: no admin module may name the chat content column.
  for (const file of [
    "src/lib/admin-user-detail.ts",
    "src/lib/admin-metrics.ts",
    "src/lib/admin-reveal.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    const selectsContent = /chatMessages\.content|content:\s*true/.test(source);
    if (selectsContent) throw new Error(`${file} references chat message content`);
  }
  console.log("  ok  no admin module selects chat_messages.content");

  /* ------------------------------------------------------------ scope: one account only */

  const crossPage = await listAdminContacts(B, { grant });
  check(
    "a grant for account A does not unmask account B",
    crossPage.rows[0].revealed === null &&
      !crossPage.rows[0].maskedName.includes(SECRET.nameB)
  );
  check(
    "grantCovers rejects a mismatched target",
    grantCovers(grant, B) === false && grantCovers(grant, A) === true
  );

  const crossDetail = await getAdminContactDetail(B, contactB.id, { grant });
  check("cross-account detail stays masked", crossDetail!.contact.revealed === null);

  /* ---------------------------------------------------------------------- wrong admin */

  const wrongAdmin = await verifyRevealGrant(grantSummary.id, {
    adminUserId: `${PREFIX}someone-else`,
    targetUserId: A,
  });
  check("a grant does not verify for a different admin", wrongAdmin === null);

  process.env.ADMIN_USER_IDS = `${PREFIX}nobody`;
  const deallowlisted = await verifyRevealGrant(grantSummary.id, {
    adminUserId: ADMIN,
    targetUserId: A,
  });
  check(
    "removing an id from ADMIN_USER_IDS invalidates its live grants",
    deallowlisted === null
  );
  process.env.ADMIN_USER_IDS = ADMIN;

  /* -------------------------------------------------------------------------- expiry */

  await db
    .update(adminRevealGrants)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(inArray(adminRevealGrants.id, [grantSummary.id]));

  const expired = await verifyRevealGrant(grantSummary.id, {
    adminUserId: ADMIN,
    targetUserId: A,
  });
  check("an expired grant does not verify", expired === null);
  check(
    "an expired grant is not the active grant",
    (await activeRevealGrant(ADMIN, A)) === null
  );

  // A grant object is a per-request capability, so the meaningful assertion is that the
  // *next* request re-masks: the page resolves its grant through `activeRevealGrant`,
  // which now returns null, and a null grant is a masked read.
  const nextRequestGrant = await activeRevealGrant(ADMIN, A);
  const afterExpiryPage = await listAdminContacts(A, { grant: nextRequestGrant });
  check(
    "the next request after expiry is masked again",
    afterExpiryPage.rows[0].revealed === null &&
      afterExpiryPage.rows[0].maskedName.includes("▨")
  );

  // And the synchronous re-check still refuses a grant whose snapshot has aged out.
  check(
    "grantCovers refuses a grant past its own expiry",
    grantCovers(grant, A, new Date(grant!.expiresAt.getTime() + 1)) === false
  );

  /* ------------------------------------------------------------------------ revocation */

  const second = await createRevealGrant({
    adminUserId: ADMIN,
    targetUserId: A,
    reason: "second look at the same import",
  });
  check(
    "a fresh grant becomes the active grant",
    (await activeRevealGrant(ADMIN, A)) !== null
  );
  const revoked = await revokeRevealGrants(ADMIN, A);
  check("revoking closes the live grant", revoked === 1);
  check(
    "nothing is active after revocation",
    (await activeRevealGrant(ADMIN, A)) === null
  );
  check(
    "a revoked grant does not verify",
    (await verifyRevealGrant(second.id, { adminUserId: ADMIN, targetUserId: A })) === null
  );

  /* --------------------------------------------------------------- reason enforcement */

  let shortReasonRejected = false;
  try {
    await createRevealGrant({ adminUserId: ADMIN, targetUserId: A, reason: "why" });
  } catch {
    shortReasonRejected = true;
  }
  check("a too-short reason is rejected", shortReasonRejected);

  console.log("Done.");
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
