/**
 * Origin side effects the dispatcher runs after a send settles: each surface's interaction
 * source/key and its own bookkeeping, only on a real send.
 * Run: npx tsx scripts/smoke-email-origins.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { readFileSync } from "node:fs";

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import "../src/lib/email/origin-registrations";
import { cancelEmailSend, dispatchEmailSend, enqueueEmail, type EnqueueInput } from "../src/lib/email/outbox";
import { setProviderOverride } from "../src/lib/email/providers";
import { MailProviderError, type MailProvider } from "../src/lib/email/providers/types";
import { createReminderForUser } from "../src/lib/reminder-writes";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-origins-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

let fail: "permanent" | "ambiguous" | null = null;
const fake: MailProvider = {
  id: "gmail",
  async identity() {
    return { email: "me@x.org" };
  },
  async send() {
    if (fail) throw new MailProviderError(fail, `Gmail 400: raw provider text`);
    return { providerMessageId: "pm", providerThreadId: "pt" };
  },
  async findSent() {
    return "unknown";
  },
};

async function resetBucket() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM rate_limit_buckets WHERE bucket = ${`emailSend:${USER}`}`);
}

async function sendNow(input: Omit<EnqueueInput, "delayMs">) {
  await resetBucket();
  const q = await enqueueEmail(USER, { ...input, delayMs: 0 });
  if (!q.ok) throw new Error(`enqueue refused: ${q.reason}`);
  return { id: q.id, outcome: await dispatchEmailSend(q.id) };
}

async function followUpSection() {
  console.log("follow-up");
  const db = await getDb();
  const [c] = await db
    .insert(schema.contacts)
    .values({ userId: USER, fullName: "Maya", email: "maya@work.org", followUpStatus: "due", nextFollowUpAt: new Date() })
    .returning();
  await createReminderForUser(USER, { contactId: c!.id, title: "Follow up with Maya", dueDate: new Date().toISOString() });
  const input = { to: ["maya@work.org"], subject: "Hi", bodyText: "Hey", origin: "follow_up" as const, originRef: c!.id, contactIds: [c!.id] };
  const status = async () => (await db.query.contacts.findFirst({ where: eq(schema.contacts.id, c!.id) }))?.followUpStatus;
  // A Radar card and a congratulations nudge about Maya: a real send answers both.
  const [card] = await db
    .insert(schema.recommendations)
    .values({ userId: USER, contactId: c!.id, kind: "heads_up", score: 40, bucket: "today", expiresAt: new Date(Date.now() + 86_400_000), inputsHash: "h" })
    .returning();
  const [nudge] = await db
    .insert(schema.aiSuggestions)
    .values({ userId: USER, suggestionType: "job_change_congrats", title: "Maya joined Ramp", relatedContactIds: [c!.id], status: "pending" })
    .returning();
  const cardNow = async () => (await db.query.recommendations.findFirst({ where: eq(schema.recommendations.id, card!.id) }))!;
  const nudgeNow = async () => (await db.query.aiSuggestions.findFirst({ where: eq(schema.aiSuggestions.id, nudge!.id) }))!.status;

  await resetBucket();
  const undone = await enqueueEmail(USER, { ...input, delayMs: 10_000 });
  if (undone.ok) await cancelEmailSend(USER, undone.id);
  check("undone follow-up leaves the follow-up due", (await status()) === "due");
  check("…and the Radar card and congrats nudge pending", (await cardNow()).status === "pending" && (await nudgeNow()) === "pending");

  fail = "permanent";
  await sendNow(input);
  check("failed follow-up leaves the follow-up due", (await status()) === "due");
  check("…and the Radar card pending", (await cardNow()).status === "pending");

  fail = null;
  const { outcome } = await sendNow(input);
  const after = await db.query.contacts.findFirst({ where: eq(schema.contacts.id, c!.id) });
  check("sent follow-up clears the follow-up", outcome === "sent" && after?.followUpStatus === "none" && after?.nextFollowUpAt === null);
  const open = await db
    .select()
    .from(schema.reminders)
    .where(and(eq(schema.reminders.contactId, c!.id), eq(schema.reminders.status, "pending")));
  check("pending reminders completed", open.length === 0);
  const logged = await db.select().from(schema.interactions).where(eq(schema.interactions.contactId, c!.id));
  check("one interaction, source follow_up", logged.length === 1 && logged[0]!.source === "follow_up", JSON.stringify(logged.map((l) => l.source)));
  const answered = await cardNow();
  check("sent follow-up accepts their Radar card", answered.status === "accepted" && answered.actedAt !== null, JSON.stringify(answered.status));
  check("…acted at the send, so the send counts as its outcome",
    answered.actedAt!.getTime() <= logged[0]!.interactionDate.getTime(), `${answered.actedAt?.toISOString()} vs ${logged[0]!.interactionDate.toISOString()}`);
  check("…and retires the congrats nudge", (await nudgeNow()) === "dismissed");
}

async function chatSection() {
  console.log("chat");
  const db = await getDb();
  const [c] = await db
    .insert(schema.contacts)
    .values({ userId: USER, fullName: "Ben", email: "ben@acme-corp.io", followUpStatus: "due", nextFollowUpAt: new Date() })
    .returning();
  const key = `chat-send:11111111-1111-4111-8111-111111111111:${c!.id}`;
  const { outcome } = await sendNow({
    to: ["ben@acme-corp.io"],
    subject: "Hi",
    bodyText: "Hey Ben",
    origin: "chat",
    originRef: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: key,
    contactIds: [c!.id],
  });
  const logged = await db.select().from(schema.interactions).where(eq(schema.interactions.contactId, c!.id));
  check("chat send is logged under its chat-send key", outcome === "sent" && logged.length === 1 && logged[0]!.externalId === key && logged[0]!.source === "chat_send");
  const after = await db.query.contacts.findFirst({ where: eq(schema.contacts.id, c!.id) });
  check("emailing from Chat answers the follow-up", after?.followUpStatus === "none");
}

async function recruiterSection() {
  console.log("recruiter");
  const db = await getDb();
  const [rec] = await db
    .insert(schema.recruiters)
    .values({ fullName: "Riley Recruiter", nameNormalized: "riley recruiter" })
    .returning();
  try {
    const draft = async () =>
      (
        await db
          .insert(schema.recruiterMessages)
          .values({ userId: USER, recruiterId: rec!.id, intent: "set_up_chat", subject: "Chat?", body: "Hi Riley" })
          .returning()
      )[0]!;
    const load = async (id: string) =>
      (await db.select().from(schema.recruiterMessages).where(eq(schema.recruiterMessages.id, id)))[0]!;

    fail = null;
    const ok = await draft();
    const { outcome } = await sendNow({
      to: ["riley@talent-co.io"],
      subject: ok.subject,
      bodyText: ok.body,
      origin: "recruiter",
      originRef: ok.id,
      idempotencyKey: `recruiter:${ok.id}`,
    });
    const sentRow = await load(ok.id);
    const outboxRow = await db.query.emailSends.findFirst({ where: eq(schema.emailSends.originRef, ok.id) });
    check("recruiter replies go out from Gmail", outboxRow?.provider === "gmail");
    check("a sent recruiter email marks its draft sent", outcome === "sent" && sentRow.status === "sent" && sentRow.gmailMessageId === "pm");

    fail = "permanent";
    const bad = await draft();
    await sendNow({ to: ["riley@talent-co.io"], subject: bad.subject, bodyText: bad.body, origin: "recruiter", originRef: bad.id, idempotencyKey: `recruiter:${bad.id}` });
    const failedRow = await load(bad.id);
    check(
      "a refused one marks it failed, in Orbit's words",
      failedRow.status === "failed" && !/Gmail 4|raw provider/.test(failedRow.errorMessage ?? ""),
      failedRow.errorMessage ?? ""
    );
    fail = null;
    check(
      "the recruiter send action pins Gmail",
      readFileSync("src/actions/recruiter-messages.ts", "utf8").includes('provider: "gmail"')
    );
  } finally {
    await db.delete(schema.recruiters).where(eq(schema.recruiters.id, rec!.id));
  }
}

async function main() {
  const db = await getDb();
  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  setProviderOverride("gmail", fake);
  try {
    await db.insert(schema.gmailConnections).values({
      userId: USER,
      emailAddress: "me@x.org",
      accessTokenEncrypted: encrypt("t"),
      refreshTokenEncrypted: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: GOOGLE_SCOPES.gmailSend,
      status: "active",
    });
    await followUpSection();
    await chatSection();
    await recruiterSection();
  } finally {
    setProviderOverride("gmail", null);
    await resetBucket();
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll email-origin checks passed.");
}

run(main);
