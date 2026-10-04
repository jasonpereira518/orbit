/**
 * Compose: context, recipient search, sending (signature, CC/BCC, contact matching, the
 * follow-up it answers) — through the real outbox with a fake Gmail provider.
 * Run: npx tsx scripts/smoke-email-compose.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import "../src/lib/email/origin-registrations";
import {
  dismissFailedSend,
  getComposeContext,
  listContactPendingSends,
  retryFailedSend,
  searchRecipients,
  sendComposed,
} from "../src/lib/email/compose";
import { attachmentPrefixFor } from "../src/lib/email/attachment-paths";
import { setAttachmentBlobClientForTests } from "../src/lib/email/attachments";
import { dispatchEmailSend } from "../src/lib/email/outbox";
import { setProviderOverride } from "../src/lib/email/providers";
import type { MailProvider, OutboundMessage } from "../src/lib/email/providers/types";
import { saveEmailSignature } from "../src/lib/email/settings";
import { setOutlookSendOverride } from "../src/lib/email/sender";
import { MICROSOFT_SCOPES } from "../src/lib/microsoft-scopes";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-compose-user";
const OTHER = "smoke-email-compose-other";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sent: OutboundMessage[] = [];
const fake: MailProvider = {
  id: "gmail",
  async identity() {
    return { email: "me@acme-corp.io" };
  },
  async send(_u, msg) {
    sent.push(msg);
    return { providerMessageId: `pm-${sent.length}`, providerThreadId: "pt" };
  },
  async findSent() {
    return null;
  },
};
async function resetBucket() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM rate_limit_buckets WHERE bucket = ${`emailSend:${USER}`}`);
}
async function flush() {
  const db = await getDb();
  await db.execute(sql`UPDATE email_sends SET send_at = now() - interval '1 second' WHERE user_id = ${USER} AND status = 'queued'`);
  const rows = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM email_sends WHERE user_id = ${USER} AND status = 'queued'`));
  for (const r of rows) await dispatchEmailSend(r.id);
}

async function main() {
  const db = await getDb();
  for (const u of [USER, OTHER]) await purgeUserData(u, { keepSettings: false }).catch(() => {});
  await resetBucket();
  setProviderOverride("gmail", fake);
  try {
    const [maya] = await db
      .insert(schema.contacts)
      .values({ userId: USER, fullName: "Maya Lin", firstName: "Maya", email: "Maya@Work.io", followUpStatus: "due", nextFollowUpAt: new Date() })
      .returning();
    await db.insert(schema.contactIdentities).values({ userId: USER, contactId: maya!.id, kind: "email", value: "maya@home.io" });
    const [sam] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Sam Ortiz", email: "sam@work.io" }).returning();
    const [foreign] = await db.insert(schema.contacts).values({ userId: OTHER, fullName: "Maya Other", email: "maya@else.io" }).returning();

    console.log("context");
    const noConn = await getComposeContext(USER, maya!.id);
    check("not connected is reported, not thrown", noConn?.capability.ok === false);
    check(
      "the contact's addresses, primary first",
      JSON.stringify(noConn?.contact?.emails) === JSON.stringify(["maya@work.io", "maya@home.io"]),
      JSON.stringify(noConn?.contact?.emails)
    );
    check("someone else's contact gives no context", (await getComposeContext(USER, foreign!.id)) === null);
    check("compose without a contact works", (await getComposeContext(USER, null))?.contact === null);

    await db.insert(schema.gmailConnections).values({
      userId: USER,
      emailAddress: "me@acme-corp.io",
      accessTokenEncrypted: encrypt("t"),
      refreshTokenEncrypted: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: GOOGLE_SCOPES.gmailSend,
      status: "active",
    });
    await saveEmailSignature(USER, "Jason\nOrbit");
    const ctx = await getComposeContext(USER, maya!.id);
    check("connected capability and signature", ctx?.capability.ok === true && ctx.signature === "Jason\nOrbit");

    console.log("recipient search");
    const byName = await searchRecipients(USER, "maya");
    check("a name finds every address of that person", byName.map((r) => r.email).sort().join() === "maya@home.io,maya@work.io", JSON.stringify(byName));
    check("never another user's contacts", !byName.some((r) => r.email === "maya@else.io"));
    const byEmail = await searchRecipients(USER, "sam@");
    check("an address fragment finds it", byEmail.length === 1 && byEmail[0]!.contactId === sam!.id, JSON.stringify(byEmail));
    check("a blank query finds nothing", (await searchRecipients(USER, "  ")).length === 0);

    console.log("send");
    const bad = await sendComposed(USER, { to: ["not an address"], cc: [], bcc: [], subject: "Hi", body: "Hello", contactId: maya!.id, fromName: "Jason" });
    check("a bad address is refused with copy", !bad.ok && bad.reason === "invalid_recipient" && !bad.message.endsWith("."), JSON.stringify(bad));
    const empty = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "Hi", body: "  ", contactId: maya!.id, fromName: "Jason" });
    check("an empty body is refused", !empty.ok && empty.reason === "empty_body");
    const long = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "x".repeat(201), body: "Hi", contactId: null, fromName: null });
    check("an over-long subject is refused", !long.ok && long.reason === "too_long");

    await resetBucket();
    const ok = await sendComposed(USER, {
      to: ["maya@work.io"],
      cc: ["sam@work.io"],
      bcc: ["boss@acme-corp.io"],
      subject: "Coffee next week?",
      body: "Hi Maya,\n\nCoffee next week?",
      contactId: maya!.id,
      fromName: "Jason",
    });
    check("queued", ok.ok, JSON.stringify(ok));
    check("nothing goes out during the undo window", sent.length === 0);
    await flush();
    const msg = sent[0];
    check("sent once", sent.length === 1);
    check("signature appended with the delimiter", msg?.bodyText === "Hi Maya,\n\nCoffee next week?\n\n-- \nJason\nOrbit", JSON.stringify(msg?.bodyText));
    check("cc and bcc carried", msg?.cc.join() === "sam@work.io" && msg.bcc.join() === "boss@acme-corp.io");
    check("from name carried", msg?.from.name === "Jason");
    const mayaLog = await db.select().from(schema.interactions).where(eq(schema.interactions.contactId, maya!.id));
    const samLog = await db.select().from(schema.interactions).where(eq(schema.interactions.contactId, sam!.id));
    check("logged on the To contact and the CC contact", mayaLog.length === 1 && samLog.length === 1 && mayaLog[0]!.source === "email_send");
    const after = await db.query.contacts.findFirst({ where: eq(schema.contacts.id, maya!.id) });
    check("emailing someone answers their due follow-up", after?.followUpStatus === "none");

    console.log("choosing the mailbox");
    setOutlookSendOverride(true);
    setProviderOverride("outlook", { ...fake, id: "outlook" });
    await db.insert(schema.outlookConnections).values({
      userId: USER,
      emailAddress: "me@contoso.io",
      accessTokenEncrypted: encrypt("t"),
      refreshTokenEncrypted: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: MICROSOFT_SCOPES.contacts,
      status: "active",
    });
    await resetBucket();
    const noSend = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "Via Outlook", body: "Hi", contactId: maya!.id, fromName: null, provider: "outlook" });
    check("choosing Outlook without Mail.Send is refused, not sent from Gmail", !noSend.ok && noSend.reason === "not_connected", JSON.stringify(noSend));
    await db.update(schema.outlookConnections).set({ scopes: MICROSOFT_SCOPES.mailSend }).where(eq(schema.outlookConnections.userId, USER));
    const viaOutlook = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "Via Outlook", body: "Hi", contactId: maya!.id, fromName: null, provider: "outlook" });
    const outlookRow = viaOutlook.ok ? await db.query.emailSends.findFirst({ where: eq(schema.emailSends.id, viaOutlook.sendId) }) : null;
    check("choosing Outlook queues from Outlook", outlookRow?.provider === "outlook" && outlookRow.fromEmail === "me@contoso.io", JSON.stringify(viaOutlook));
    if (viaOutlook.ok) await db.update(schema.emailSends).set({ status: "canceled" }).where(eq(schema.emailSends.id, viaOutlook.sendId));
    setOutlookSendOverride(null);
    setProviderOverride("outlook", null);

    console.log("pending on the contact page");
    await resetBucket();
    const q = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "Queued one", body: "Later", contactId: maya!.id, fromName: null });
    if (!q.ok) throw new Error("stop");
    const pending = await listContactPendingSends(USER, maya!.id);
    check("a queued send shows on the contact", pending.some((p) => p.id === q.sendId && p.status === "queued"));
    check("not on another contact", !(await listContactPendingSends(USER, sam!.id)).some((p) => p.id === q.sendId));
    check("not for another user", (await listContactPendingSends(OTHER, maya!.id)).length === 0);
    check("sent emails are not pending", !pending.some((p) => p.subject === "Coffee next week?"));

    await db.execute(sql`UPDATE email_sends SET status = 'failed', failure_kind = 'permanent' WHERE id = ${q.sendId}::uuid`);
    const failed = await listContactPendingSends(USER, maya!.id);
    check("a failed send shows as failed", failed.some((p) => p.id === q.sendId && p.status === "failed"));
    const retried = await retryFailedSend(USER, q.sendId, "Jason");
    check("retry queues a fresh copy", retried.ok && retried.sendId !== q.sendId, JSON.stringify(retried));
    if (!retried.ok) throw new Error("stop");
    const afterRetry = await listContactPendingSends(USER, maya!.id);
    check("and the failed one leaves the list", !afterRetry.some((p) => p.id === q.sendId));
    check("retrying it twice is refused", !(await retryFailedSend(USER, q.sendId, null)).ok);

    await db.execute(sql`UPDATE email_sends SET status = 'failed', failure_kind = 'ambiguous' WHERE id = ${retried.sendId}::uuid`);
    const amb = await retryFailedSend(USER, retried.sendId, "Jason");
    check("a possibly-sent email cannot be retried", !amb.ok && amb.reason === "not_retryable");
    check("another user cannot dismiss it", !(await dismissFailedSend(OTHER, retried.sendId)));
    check("but its owner can", await dismissFailedSend(USER, retried.sendId));
    check("dismissed rows leave the list", !(await listContactPendingSends(USER, maya!.id)).some((p) => p.id === retried.sendId));

    console.log("attachments and scheduling");
    setAttachmentBlobClientForTests({
      async head(p) { return { pathname: p, url: p, size: 4, contentType: "application/pdf" }; },
      async get() { return { bytes: new Uint8Array([37, 80, 68, 70]) }; },
      async del() {},
      async list() { return { blobs: [], hasMore: false }; },
    });
    await resetBucket();
    const file = { pathname: `${attachmentPrefixFor(USER)}a-x1.pdf`, filename: "a.pdf" };
    const withFile = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "Deck", body: "Attached", contactId: maya!.id, fromName: null, attachments: [file] });
    check("a send with a file queues", withFile.ok && !withFile.scheduled, JSON.stringify(withFile));
    if (!withFile.ok) throw new Error("stop");
    const [fileRow] = await db.select().from(schema.emailSends).where(eq(schema.emailSends.id, withFile.sendId));
    check("the row keeps the file", fileRow?.attachments?.[0]?.filename === "a.pdf", JSON.stringify(fileRow?.attachments));
    const theirs = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "Deck", body: "Attached", contactId: null, fromName: null, attachments: [{ pathname: `${attachmentPrefixFor(OTHER)}b.pdf`, filename: "b.pdf" }] });
    check("someone else's upload is refused", !theirs.ok, JSON.stringify(theirs));

    await resetBucket();
    const later = new Date(Date.now() + 2 * 3_600_000);
    const scheduled = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "Later", body: "Hi", contactId: maya!.id, fromName: null, scheduledFor: later.toISOString() });
    check("scheduledFor two hours out is scheduled", scheduled.ok && scheduled.scheduled && Math.abs(new Date(scheduled.sendAt).getTime() - later.getTime()) < 1000, JSON.stringify(scheduled));
    const tooSoon = await sendComposed(USER, { to: ["maya@work.io"], cc: [], bcc: [], subject: "Later", body: "Hi", contactId: null, fromName: null, scheduledFor: new Date(Date.now() - 60_000).toISOString() });
    check("a time in the past is refused", !tooSoon.ok, JSON.stringify(tooSoon));
    const listed = await listContactPendingSends(USER, maya!.id);
    check("the pending list shows the schedule", listed.some((p) => scheduled.ok && p.id === scheduled.sendId && p.scheduledFor !== null));
    check("and the file", listed.some((p) => p.id === withFile.sendId && p.attachments[0]?.filename === "a.pdf"));

    await db.execute(sql`UPDATE email_sends SET status = 'failed', failure_kind = 'permanent' WHERE id = ${withFile.sendId}::uuid`);
    await resetBucket();
    const again = await retryFailedSend(USER, withFile.sendId, null);
    if (!again.ok) throw new Error(`retry refused: ${JSON.stringify(again)}`);
    const [copy] = await db.select().from(schema.emailSends).where(eq(schema.emailSends.id, again.sendId));
    check("retry copies the files", copy?.attachments?.[0]?.blobKey === file.pathname);
  } finally {
    setAttachmentBlobClientForTests(null);
    setProviderOverride("gmail", null);
    setProviderOverride("outlook", null);
    setOutlookSendOverride(null);
    await resetBucket();
    for (const u of [USER, OTHER]) await purgeUserData(u, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll compose checks passed.");
}

run(main);
