/**
 * Guards the inspector now that the reveal gate is gone.
 *
 * Removing a redaction layer is the kind of change that is easy to overshoot: the obvious
 * next step after "select the contact's notes" is "select everything", and nothing about
 * the diff would look wrong. So this file asserts both halves.
 *
 * The positive half — contact names and notes come back with no grant argument in
 * existence — is the feature. The negative half is the guard rail: whatever the inspector
 * renders, it must never carry an encrypted API key, the calendar feed token, an OAuth
 * token, or a line of chat transcript. Those were never behind the grant; they are in
 * `NEVER_REVEALABLE`, and this proves it still holds when nothing else is withheld.
 *
 * Run: npx tsx scripts/smoke-admin-unmasked.ts
 */
import "./smoke/_env";

import { eq, inArray, like } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  adminAuditLog,
  chatMessages,
  chatThreads,
  contacts,
  gmailConnections,
  interactions,
  userSettings,
} from "../src/db/schema";
import { assertNoForbiddenValues } from "../src/lib/admin-redaction";
import { recordAccountView } from "../src/lib/admin-operations";
import {
  getAdminContactDetail,
  getAdminUserDetail,
  listAdminContacts,
} from "../src/lib/admin-user-detail";
import { loadAdminTimeline } from "../src/lib/admin-timeline";
import { ensureUserSettings } from "../src/lib/user-settings";

const PREFIX = "smoke-unmasked-";
const USER = `${PREFIX}account`;
const ADMIN = `${PREFIX}operator`;

/**
 * Sentinel values planted in exactly the columns that must never surface. Distinctive
 * enough that a substring match over the serialised payload cannot false-positive.
 */
const SECRETS = {
  geminiKey: "SENTINEL-gemini-key-Vhaldramir",
  calendarToken: "SENTINEL-calendar-token-Quorvexis",
  gmailAccess: "SENTINEL-gmail-access-Threnodyne",
  gmailRefresh: "SENTINEL-gmail-refresh-Ombrishaw",
  chat: "SENTINEL chat transcript — who should I introduce to Wrenfield?",
};

/** Real content that SHOULD now come back. */
const VISIBLE = {
  name: "Perrin Ashgrove",
  email: "perrin@ashgrove.test",
  notes: "Met at the Lisbon meetup; wants an intro to a seed fund.",
  rawNotes: "Called about the fundraise. Sounded ready to move.",
};

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(chatMessages).where(eq(chatMessages.userId, USER));
  await db.delete(chatThreads).where(eq(chatThreads.userId, USER));
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, USER));
  await db
    .delete(adminAuditLog)
    .where(like(adminAuditLog.targetUserId, `${PREFIX}%`));
  await db.delete(userSettings).where(inArray(userSettings.userId, [USER, ADMIN]));
}

async function seed() {
  const db = await getDb();
  await ensureUserSettings(USER);
  await ensureUserSettings(ADMIN);

  await db
    .update(userSettings)
    .set({
      email: `${PREFIX}account@example.test`,
      firstName: "Marisol",
      lastName: "Vandermeer",
      profileImageUrl: "https://img.clerk.test/marisol.png",
      geminiApiKeyEncrypted: SECRETS.geminiKey,
      calendarFeedToken: SECRETS.calendarToken,
    })
    .where(eq(userSettings.userId, USER));

  await db.insert(gmailConnections).values({
    userId: USER,
    emailAddress: "mailbox@example.test",
    accessTokenEncrypted: SECRETS.gmailAccess,
    refreshTokenEncrypted: SECRETS.gmailRefresh,
  });

  const [contact] = await db
    .insert(contacts)
    .values({
      userId: USER,
      fullName: VISIBLE.name,
      email: VISIBLE.email,
      phone: "+1-555-0100",
      notes: VISIBLE.notes,
      company: "Ashgrove Labs",
      title: "Founder",
    })
    .returning();

  await db.insert(interactions).values({
    userId: USER,
    contactId: contact.id,
    interactionType: "call",
    rawNotes: VISIBLE.rawNotes,
    interactionDate: new Date(),
  });

  const [thread] = await db
    .insert(chatThreads)
    .values({ userId: USER, title: "Fundraise intros" })
    .returning();

  await db.insert(chatMessages).values({
    userId: USER,
    threadId: thread.id,
    role: "user",
    content: SECRETS.chat,
  });

  return contact.id;
}

async function viewRows() {
  const db = await getDb();
  return db.query.adminAuditLog.findMany({
    where: eq(adminAuditLog.targetUserId, USER),
  });
}

async function main() {
  await cleanup();
  const contactId = await seed();

  const forbidden = Object.values(SECRETS);

  /* --------------------------------------------------------- the account-level inspector */

  const detail = await getAdminUserDetail(USER);
  if (!detail) throw new Error("getAdminUserDetail returned null");

  check(
    "the identity mirror reaches the inspector",
    detail.identity.firstName === "Marisol" &&
      detail.identity.lastName === "Vandermeer" &&
      detail.identity.imageUrl === "https://img.clerk.test/marisol.png"
  );

  check(
    "the contact summary carries a real name, not a mask",
    detail.contacts[0]?.name === VISIBLE.name,
    detail.contacts[0]?.name
  );
  check(
    "the contact summary carries the email",
    detail.contacts[0]?.email === VISIBLE.email
  );
  assertNoForbiddenValues(detail, forbidden);
  console.log("  ok  the account inspector carries no credential or transcript");

  /* ---------------------------------------------------------------- the contact list read */

  // No grant argument exists to pass. That is the point: there is no opt-in left to forget.
  const page = await listAdminContacts(USER);
  check("the contact list is unmasked", page.rows[0]?.name === VISIBLE.name);
  check("it carries the full record", page.rows[0]?.detail?.notes === VISIBLE.notes);
  check("it carries the phone number", page.rows[0]?.detail?.phone === "+1-555-0100");
  assertNoForbiddenValues(page, forbidden);
  console.log("  ok  the contact list carries no credential or transcript");

  /* ------------------------------------------------------------------ one contact record */

  const record = await getAdminContactDetail(USER, contactId);
  if (!record) throw new Error("getAdminContactDetail returned null");

  check("the record renders notes", record.contact.detail?.notes === VISIBLE.notes);
  check(
    "interaction notes are readable",
    record.interactions[0]?.detail.rawNotes === VISIBLE.rawNotes
  );
  check(
    "presence counts survived the ungating",
    record.interactions[0]?.hasRawNotes === true
  );
  assertNoForbiddenValues(record, forbidden);
  console.log("  ok  the contact record carries no credential or transcript");

  /* ------------------------------------------------------------------------- the timeline */

  const timeline = await loadAdminTimeline(USER);
  check(
    "timeline labels name the contact",
    timeline.entries.some((e) => e.label.includes(VISIBLE.name)),
    timeline.entries.map((e) => e.label).join(" | ")
  );
  check(
    "the chat arm reads thread titles, never message bodies",
    timeline.entries.some((e) => e.label.includes("Fundraise intros"))
  );
  assertNoForbiddenValues(timeline, forbidden);
  console.log("  ok  the timeline carries no credential or transcript");

  /* ------------------------------------------------------------------- the view audit row */

  await recordAccountView(ADMIN, USER);
  check("opening an account is recorded", (await viewRows()).length === 1);

  await recordAccountView(ADMIN, USER);
  check(
    "a second view inside the hour does not write a second row",
    (await viewRows()).length === 1
  );

  await recordAccountView(ADMIN, USER, new Date(Date.now() + 2 * 60 * 60 * 1000));
  check("a view in a later session does", (await viewRows()).length === 2);

  await cleanup();
  console.log("\nAll unmasked-inspector checks passed.");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    process.exit(1);
  });
