/**
 * Campaign email from the user's own mailbox: claimed once, sent through the outbox, settled
 * by the outreach origin hook, and never sent twice or to the wrong person. LinkedIn notes are
 * copied, then confirmed by hand (Orbit never sends them), and a killed send's stranded
 * `queued` messages are released.
 * Run: npx tsx scripts/smoke-outreach-send.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import "../src/lib/email/origin-registrations";
import { dispatchEmailSend } from "../src/lib/email/outbox";
import { setProviderOverride } from "../src/lib/email/providers";
import { MailProviderError, type MailProvider } from "../src/lib/email/providers/types";
import { getSendCapability } from "../src/lib/email/sender";
import {
  confirmLinkedInSentForUser,
  copyLinkedInMessageForUser,
  draftCampaignMessagesForUser,
  editDraftForUser,
  releaseStrandedMessagesForUser,
  sendCampaignMessagesForUser,
  type Drafter,
} from "../src/lib/outreach-messages";
import { addProspectsForUser } from "../src/lib/outreach-people";
import { DEMO_PROSPECT_SEND_MESSAGE } from "../src/lib/outreach-quality";
import { BULK_SEND_LIMIT, LINKEDIN_NOTE_MAX } from "../src/lib/outreach-types";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-outreach-send-user";
const OTHER = "smoke-outreach-send-other";
const OPTS = { skipRevalidate: true, skipEmbedding: true, skipSummary: true, skipCloseness: true } as const;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function rejects(fn: () => Promise<unknown>, substring?: string) {
  try {
    await fn();
    return false;
  } catch (err) {
    return !substring || (err instanceof Error && err.message.includes(substring));
  }
}

let fail: "permanent" | "ambiguous" | null = null;
/** Every address the provider was actually asked to deliver to, in order. */
const delivered: string[] = [];
const fake: MailProvider = {
  id: "gmail",
  async identity() {
    return { email: "me@x.org" };
  },
  async send(_user, message) {
    delivered.push(...message.to);
    if (fail) throw new MailProviderError(fail, `Gmail 400: raw provider text`);
    return { providerMessageId: "pm", providerThreadId: "pt" };
  },
  async findSent() {
    return "unknown";
  },
};

const drafter: Drafter = async (_user, inputs) =>
  inputs.map((input) => ({ subject: "Hi", body: `Hello ${input.prospect.fullName}` }));

async function resetBucket() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM rate_limit_buckets WHERE bucket = ${`emailSend:${USER}`}`);
}

async function reset() {
  for (const id of [USER, OTHER]) await purgeUserData(id, { keepSettings: false }).catch(() => {});
}

async function msg(id: string) {
  const db = await getDb();
  return (await db.query.outreachMessages.findFirst({ where: eq(schema.outreachMessages.id, id) }))!;
}

async function contactsNamed(fullName: string) {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.userId, USER), eq(schema.contacts.fullName, fullName)));
  return rows.length;
}

async function interactionsForContactOf(messageId: string) {
  const db = await getDb();
  const m = await msg(messageId);
  const p = await db.query.outreachProspects.findFirst({ where: eq(schema.outreachProspects.id, m.prospectId) });
  if (!p?.contactId) return [];
  return db.select().from(schema.interactions).where(eq(schema.interactions.contactId, p.contactId));
}

async function sendsFor(messageId: string) {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.emailSends.id })
    .from(schema.emailSends)
    .where(and(eq(schema.emailSends.userId, USER), eq(schema.emailSends.originRef, messageId)));
  return rows.length;
}

async function setGmailStatus(status: "active" | "needs_reauth") {
  const db = await getDb();
  await db.update(schema.gmailConnections).set({ status }).where(eq(schema.gmailConnections.userId, USER));
}

/** Sent rows from another surface, so `remainingToday` is exactly `left` on this user's plan. */
async function fillDailyCapLeaving(left: number) {
  const db = await getDb();
  const cap = await getSendCapability(USER);
  const fill = cap.dailyCap - cap.usedToday - left;
  await db.execute(sql`INSERT INTO email_sends (user_id, provider, from_email, to_emails, subject, body_text, origin, status, send_at, rfc_message_id)
    SELECT ${USER}, 'gmail', 'me@x.org', '["z@x.org"]'::jsonb, 'cap-fill', 'b', 'compose', 'sent', now(), '<cap-' || g || '@orbit.mail>'
      FROM generate_series(1, ${fill}::int) g`);
  const now = await getSendCapability(USER);
  if (!now.ok || now.remainingToday !== left) throw new Error(`cap fill left ${now.ok ? now.remainingToday : now.reason}`);
}

async function clearDailyCap() {
  const db = await getDb();
  await db.execute(sql`DELETE FROM email_sends WHERE user_id = ${USER} AND subject = 'cap-fill'`);
}

/**
 * Make the read right after the claim throw: the only `select` of a message with its prospect.
 * `getDb()` builds a fresh wrapper per call outside production, so the patch goes on the
 * prototype that owns `select`. Returns the undo.
 */
async function failPostClaimRead() {
  let proto: object | null = Object.getPrototypeOf(await getDb());
  while (proto && !Object.prototype.hasOwnProperty.call(proto, "select")) proto = Object.getPrototypeOf(proto);
  if (!proto) throw new Error("no select to patch");
  const owner = proto as { select: (...args: unknown[]) => unknown };
  const real = owner.select;
  owner.select = function (this: unknown, ...args: unknown[]) {
    if ((args[0] as { message?: unknown } | undefined)?.message === schema.outreachMessages) throw new Error("post-claim read failed");
    return real.apply(this, args);
  };
  return () => {
    owner.select = real;
  };
}

async function main() {
  const db = await getDb();
  await reset();
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
    await db.insert(schema.contacts).values({ userId: USER, fullName: "Bo Li", company: "IQVIA", email: "bo@iqvia.com" });
    const [c] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Pharma consulting" }).returning();
    const [liC] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "LinkedIn", defaultChannel: "linkedin" }).returning();
    const [otherC] = await db.insert(schema.outreachCampaigns).values({ userId: OTHER, name: "Theirs" }).returning();
    const camp = c!.id;

    await addProspectsForUser(USER, camp, [
      { fullName: "Bo Li", company: "IQVIA", origin: "manual" },
      { fullName: "M2 Person", company: "Acme", email: "m2@acme-co.io", origin: "manual" },
      { fullName: "No Email", company: "Acme", origin: "manual" },
      { fullName: "M3 Person", company: "Acme", email: "m3@acme-co.io", origin: "manual" },
      { fullName: "M4 Person", company: "Acme", email: "m4@acme-co.io", origin: "manual" },
      { fullName: "M5 Person", company: "Acme", email: "m5@acme-co.io", origin: "manual" },
      { fullName: "M6 Person", company: "Acme", email: "m6@acme-co.io", origin: "manual" },
      { fullName: "Demo Person", company: "Acme", email: "demo@acme-co.io", origin: "manual" },
      { fullName: "Dup Two", company: "Acme", email: "dup@acme-co.io", origin: "manual" },
    ]);
    const prospects = await db.query.outreachProspects.findMany({ where: eq(schema.outreachProspects.campaignId, camp) });
    const pid = (name: string) => prospects.find((p) => p.fullName === name)!.id;
    await db.update(schema.outreachProspects).set({ enrichment: { demo: true } }).where(eq(schema.outreachProspects.id, pid("Demo Person")));
    const names = ["Bo Li", "M2 Person", "No Email", "M3 Person", "M4 Person", "M5 Person", "M6 Person", "Demo Person", "Dup Two"];
    await draftCampaignMessagesForUser(USER, camp, names.map(pid), { drafter });
    const drafts = await db.query.outreachMessages.findMany({ where: eq(schema.outreachMessages.stepIndex, 0) });
    const mid = (name: string) => drafts.find((m) => m.prospectId === pid(name))!.id;
    const [mBo, m2, mNoEmail, m3, m4, m5, m6, mDemo, mDup] = names.map(mid);

    const raw = (ids: string[], campaignId = camp, userId = USER) =>
      sendCampaignMessagesForUser(userId, campaignId, ids, { spacingMs: 0, contactWrite: OPTS });
    const send = async (ids: string[]) => {
      await resetBucket();
      return raw(ids);
    };

    console.log("send");
    const res = await send([mBo!]);
    const row = await msg(mBo!);
    check("sent through the outbox", res.sent === 1 && row.status === "sent" && row.deliveryId != null, JSON.stringify(res));
    const sent = await db.query.emailSends.findFirst({ where: eq(schema.emailSends.id, row.deliveryId!) });
    check("outreach origin, own mailbox", sent?.origin === "outreach" && sent.fromEmail === "me@x.org" && sent.idempotencyKey === `outreach:${mBo}`);
    check("to the person's own address", delivered.join() === "bo@iqvia.com", delivered.join());
    check("no duplicate contact on send", (await contactsNamed("Bo Li")) === 1);
    check("interaction on the timeline", (await interactionsForContactOf(mBo!)).some((i) => i.source === "outreach_send"));

    await resetBucket();
    const [a, b] = await Promise.all([raw([m2!]), raw([m2!])]);
    check("concurrent sends claim once", a.sent + b.sent === 1 && a.failed.length + b.failed.length === 0 && (await sendsFor(m2!)) === 1 && (await msg(m2!)).status === "sent", JSON.stringify([a, b]));
    const again = await send([mBo!]);
    check("resend of a sent message is a no-op", again.sent === 0 && again.failed.length === 0 && (await sendsFor(mBo!)) === 1 && (await msg(mBo!)).status === "sent", JSON.stringify(again));

    const none = await send([mNoEmail!]);
    check("no email stays a draft", Boolean(none.failed[0]?.error.includes("Add an email address for No Email")) && (await msg(mNoEmail!)).status === "draft", JSON.stringify(none));

    await setGmailStatus("needs_reauth");
    check(
      "disconnected mailbox refuses before claiming",
      (await rejects(() => send([m3!, m4!]))) && (await msg(m3!)).status === "draft" && (await contactsNamed("M3 Person")) === 0
    );
    await setGmailStatus("active");

    await fillDailyCapLeaving(1);
    const cut = await send([m3!, m4!]);
    check("stops the batch on cap or connection", cut.sent === 1 && cut.failed.length === 1 && (await msg(m3!)).status === "sent" && (await msg(m4!)).status === "draft", JSON.stringify(cut));
    await clearDailyCap();

    fail = "permanent";
    const refused = await send([m5!]);
    const m5Row = await msg(m5!);
    check("provider refusal marks failed in Orbit's words", m5Row.status === "failed" && !m5Row.errorMessage!.includes("Gmail 400"), m5Row.errorMessage ?? "");
    check("…and the result says who", refused.failed[0]?.error === "Couldn’t send to M5 Person — try again?", JSON.stringify(refused));
    fail = null;
    check("a failed message can be sent again", (await send([m5!])).sent === 1 && (await msg(m5!)).status === "sent");

    fail = "ambiguous";
    const before = delivered.length;
    const maybe = await send([m6!]);
    check("an ambiguous first attempt is pending, not sent", maybe.pending === 1 && maybe.sent === 0 && (await msg(m6!)).status === "queued", JSON.stringify(maybe));
    // The outbox retries later; make it due and dispatch, the way the drain would.
    const outboxRow = await db.query.emailSends.findFirst({ where: eq(schema.emailSends.originRef, m6!) });
    await db.execute(sql`UPDATE email_sends SET send_at = now() - interval '1 second' WHERE id = ${outboxRow!.id}::uuid`);
    await dispatchEmailSend(outboxRow!.id);
    check(
      "ambiguous send is unsure and never re-claimed",
      (await msg(m6!)).status === "unsure" && (await send([m6!])).sent === 0 && (await msg(m6!)).status === "unsure" && delivered.length === before + 1 && (await sendsFor(m6!)) === 1
    );
    fail = null;

    const demo = await send([mDemo!]);
    check("demo prospect never sends", demo.sent === 0 && (await sendsFor(mDemo!)) === 0 && demo.failed[0]?.error === DEMO_PROSPECT_SEND_MESSAGE && (await msg(mDemo!)).status === "draft");
    check("…and makes no contact", (await contactsNamed("Demo Person")) === 0);

    console.log("never stranded");
    await addProspectsForUser(USER, camp, [
      { fullName: "B1 Person", company: "Acme", email: "b1@acme-co.io", origin: "manual" },
      { fullName: "B2 Person", company: "Acme", email: "b2@acme-co.io", origin: "manual" },
    ]);
    const bIds = (await db.query.outreachProspects.findMany({ where: eq(schema.outreachProspects.campaignId, camp) }))
      .filter((p) => p.fullName.startsWith("B") && p.fullName.endsWith("Person"))
      .map((p) => p.id);
    await draftCampaignMessagesForUser(USER, camp, bIds, { drafter });
    const bMsgs = (await db.query.outreachMessages.findMany({ where: eq(schema.outreachMessages.stepIndex, 0) }))
      .filter((m) => bIds.includes(m.prospectId))
      .map((m) => m.id);
    const allDraftNoSend = async () =>
      (await Promise.all(bMsgs.map(async (id) => (await msg(id)).status === "draft" && (await sendsFor(id)) === 0))).every(Boolean);
    await resetBucket();
    const out = await sendCampaignMessagesForUser(USER, camp, bMsgs, { spacingMs: 0, budgetMs: 0, contactWrite: OPTS });
    check("a spent time budget hands nothing more to the outbox", bMsgs.length === 2 && out.sent === 0 && out.notSent === 2 && out.failed.length === 0, JSON.stringify(out));
    check("…and puts every claimed message back as a draft", await allDraftNoSend());
    await resetBucket();
    const undo = await failPostClaimRead();
    let readFailed: boolean;
    try {
      readFailed = await rejects(() => raw(bMsgs), "post-claim read failed");
    } finally {
      undo();
    }
    check("a failure right after the claim leaves nothing queued", readFailed && (await allDraftNoSend()));
    check("…and they can still be sent", (await send(bMsgs)).sent === 2);

    console.log("guards");
    const [dup2] = await db.insert(schema.outreachMessages).values({ prospectId: pid("Dup Two"), channel: "email", subject: "Hi", body: "Again", status: "draft", stepIndex: 0 }).returning();
    const both = await send([mDup!, dup2!.id]);
    check("two first messages for one person send one email", both.sent === 1 && (await sendsFor(mDup!)) + (await sendsFor(dup2!.id)) === 1, JSON.stringify(both));
    const other = (await msg(mDup!)).status === "sent" ? dup2!.id : mDup!;
    check("…and the other can't follow it out", (await send([other])).sent === 0 && (await msg(other)).status === "draft");

    check(`over ${BULK_SEND_LIMIT} at a time is refused`, await rejects(() => send(Array(BULK_SEND_LIMIT + 1).fill(m4!)), "Send up to 25 at a time"));
    check("a LinkedIn campaign doesn't email", await rejects(() => raw([m4!], liC!.id)));
    check("another user's campaign is refused", (await rejects(() => raw([m4!], otherC!.id))) && (await rejects(() => raw([m4!], camp, OTHER))));
    const [second] = await db.insert(schema.outreachCampaigns).values({ userId: USER, name: "Second" }).returning();
    await resetBucket();
    const wrongCamp = await raw([m4!], second!.id);
    check("a message from another campaign is ignored", wrongCamp.sent === 0 && wrongCamp.failed.length === 0 && (await msg(m4!)).status === "draft");
    check("junk ids are ignored", (await send(["nope", ""])).sent === 0);
    check("nobody else was ever emailed", delivered.every((to) => to !== "demo@acme-co.io" && to !== "m4@acme-co.io"), delivered.join());

    console.log("linkedin");
    const liUrl = (slug: string) => `https://www.linkedin.com/in/${slug}`;
    await addProspectsForUser(USER, liC!.id, [
      { fullName: "Li Linked", company: "Acme", linkedinUrl: liUrl("li-linked"), origin: "manual" },
      { fullName: "Li Twice", company: "Acme", linkedinUrl: liUrl("li-twice"), origin: "manual" },
      { fullName: "Li Long", company: "Acme", linkedinUrl: liUrl("li-long"), origin: "manual" },
      { fullName: "Li Bare", company: "Acme", origin: "manual" },
      { fullName: "Li Race", company: "Acme", linkedinUrl: liUrl("li-race"), origin: "manual" },
    ]);
    const liPeople = await db.query.outreachProspects.findMany({ where: eq(schema.outreachProspects.campaignId, liC!.id) });
    const liNames = ["Li Linked", "Li Twice", "Li Long", "Li Bare", "Li Race"];
    const liPid = (name: string) => liPeople.find((p) => p.fullName === name)!.id;
    await draftCampaignMessagesForUser(USER, liC!.id, liNames.map(liPid), { drafter });
    const liMid = async (name: string) =>
      (await db.query.outreachMessages.findFirst({ where: eq(schema.outreachMessages.prospectId, liPid(name)) }))!.id;
    const [mLinked, mTwice, mLong, mBare, mRace] = await Promise.all(liNames.map(liMid));
    const interactionsOf = async (messageId: string) =>
      (await interactionsForContactOf(messageId)).filter((i) => i.externalId === `outreach:${messageId}`);
    const LI_LINK_COPY = "Add their LinkedIn profile link first";

    check("copy needs a profile link", (await rejects(() => copyLinkedInMessageForUser(USER, mBare!), LI_LINK_COPY)) && (await msg(mBare!)).status === "draft");
    for (const bad of ["javascript:alert(1)//linkedin.com/in/x", "https://evil.example/linkedin.com/in/x", "https://notlinkedin.com/in/x", "https://linkedin.com@evil.example/in/x"]) {
      await db.update(schema.outreachProspects).set({ linkedinUrl: bad }).where(eq(schema.outreachProspects.id, liPid("Li Bare")));
      check(`an unsafe profile link counts as none: ${bad.slice(0, 24)}`, await rejects(() => copyLinkedInMessageForUser(USER, mBare!), LI_LINK_COPY));
    }
    await editDraftForUser(USER, mLong!, { subject: null, body: "x".repeat(LINKEDIN_NOTE_MAX + 1) });
    check(
      "301-char note refused",
      (await rejects(() => copyLinkedInMessageForUser(USER, mLong!), "LinkedIn notes are limited to 300 characters — shorten this one")) && (await msg(mLong!)).status === "draft"
    );
    await editDraftForUser(USER, mLong!, { subject: null, body: "x".repeat(LINKEDIN_NOTE_MAX) });
    check("a 300-char note is fine", (await copyLinkedInMessageForUser(USER, mLong!)).body.length === LINKEDIN_NOTE_MAX && (await msg(mLong!)).status === "copied");
    check("an email campaign's message isn't a LinkedIn note", await rejects(() => copyLinkedInMessageForUser(USER, mBo!), "isn’t set up for LinkedIn"));
    check(
      "another user's message is refused",
      (await rejects(() => copyLinkedInMessageForUser(OTHER, mLinked!), "Message not found")) &&
        (await rejects(() => confirmLinkedInSentForUser(OTHER, mLinked!, OPTS), "Message not found")) &&
        (await msg(mLinked!)).status === "draft"
    );

    check("confirm requires copy first", (await rejects(() => confirmLinkedInSentForUser(USER, mLinked!, OPTS), "Copy the note first")) && (await msg(mLinked!)).status === "draft");
    check("…and made no contact or interaction", (await contactsNamed("Li Linked")) === 0 && (await interactionsOf(mLinked!)).length === 0);

    const copy = await copyLinkedInMessageForUser(USER, mLinked!);
    check("copy hands back the note and the profile link", copy.body === "Hello Li Linked" && copy.linkedinUrl === liUrl("li-linked") && (await msg(mLinked!)).status === "copied", JSON.stringify(copy));
    const copyAgain = await copyLinkedInMessageForUser(USER, mLinked!);
    check("copying a copied note returns it as is", copyAgain.body === copy.body && (await msg(mLinked!)).status === "copied");
    check("copy makes no contact", (await contactsNamed("Li Linked")) === 0);

    await confirmLinkedInSentForUser(USER, mLinked!, OPTS);
    const confirmed = await msg(mLinked!);
    check("confirm marks it sent", confirmed.status === "sent" && confirmed.sentAt != null);
    check("confirm creates the contact once", (await contactsNamed("Li Linked")) === 1);
    const [logged] = await interactionsOf(mLinked!);
    check(
      "…and logs the note as an outgoing LinkedIn message",
      (await interactionsOf(mLinked!)).length === 1 &&
        logged?.interactionType === "linkedin_message" &&
        logged.direction === "out" &&
        logged.source === "outreach_send" &&
        logged.rawNotes === "Hello Li Linked"
    );
    await confirmLinkedInSentForUser(USER, mLinked!, OPTS);
    check("double confirm logs one interaction", (await interactionsOf(mLinked!)).length === 1 && (await contactsNamed("Li Linked")) === 1 && (await msg(mLinked!)).status === "sent");
    await copyLinkedInMessageForUser(USER, mTwice!);
    const raced = await Promise.allSettled([confirmLinkedInSentForUser(USER, mTwice!, OPTS), confirmLinkedInSentForUser(USER, mTwice!, OPTS)]);
    check(
      "two confirms at once log one interaction",
      raced.every((r) => r.status === "fulfilled") && (await interactionsOf(mTwice!)).length === 1 && (await contactsNamed("Li Twice")) === 1,
      JSON.stringify(raced.map((r) => r.status))
    );
    // A first confirm that died after its UPDATE: sent, but no contact and no interaction.
    await copyLinkedInMessageForUser(USER, mLong!);
    await db.execute(sql`UPDATE outreach_messages SET status = 'sent', sent_at = now() WHERE id = ${mLong!}::uuid`);
    check("a sent note with no interaction starts the recovery case", (await interactionsOf(mLong!)).length === 0 && (await contactsNamed("Li Long")) === 0);
    await confirmLinkedInSentForUser(USER, mLong!, OPTS);
    check("pressing I sent it again finishes a failed confirm", (await interactionsOf(mLong!)).length === 1 && (await contactsNamed("Li Long")) === 1 && (await msg(mLong!)).status === "sent");
    await confirmLinkedInSentForUser(USER, mLong!, OPTS);
    check("…and once more logs nothing new", (await interactionsOf(mLong!)).length === 1 && (await contactsNamed("Li Long")) === 1);
    await copyLinkedInMessageForUser(USER, mRace!);
    await db.execute(sql`UPDATE outreach_messages SET status = 'sent', sent_at = now() WHERE id = ${mRace!}::uuid`);
    const recovered = await Promise.allSettled([confirmLinkedInSentForUser(USER, mRace!, OPTS), confirmLinkedInSentForUser(USER, mRace!, OPTS)]);
    check(
      "two recoveries at once log one interaction",
      recovered.every((r) => r.status === "fulfilled") && (await interactionsOf(mRace!)).length === 1 && (await contactsNamed("Li Race")) === 1,
      JSON.stringify(recovered.map((r) => (r.status === "rejected" ? String(r.reason).slice(0, 80) : r.status)))
    );
    check("a sent note can still be copied, and stays sent", (await copyLinkedInMessageForUser(USER, mLinked!)).body === copy.body && (await msg(mLinked!)).status === "sent");

    console.log("stranded");
    const sNames = ["S1 Person", "S2 Person", "S3 Person", "S4 Person", "S5 Person"];
    await addProspectsForUser(USER, camp, sNames.map((fullName, i) => ({ fullName, company: "Acme", email: `s${i + 1}@acme-co.io`, origin: "manual" as const })));
    const sProspects = await db.query.outreachProspects.findMany({ where: eq(schema.outreachProspects.campaignId, camp) });
    await draftCampaignMessagesForUser(USER, camp, sNames.map((n) => sProspects.find((p) => p.fullName === n)!.id), { drafter });
    const sMid = async (name: string) =>
      (await db.query.outreachMessages.findFirst({ where: eq(schema.outreachMessages.prospectId, sProspects.find((p) => p.fullName === name)!.id) }))!.id;
    const [s1, s2, s3, s4, s5] = await Promise.all(sNames.map(sMid));
    const strand = (id: string, minutesOld: number) =>
      db.execute(sql`UPDATE outreach_messages SET status = 'queued', updated_at = now() - make_interval(mins => ${minutesOld}::int) WHERE id = ${id}::uuid`);
    for (const [id, age] of [[s1, 6], [s2, 6], [s3, 6], [s4, 1]] as const) await strand(id!, age);
    await db.execute(sql`INSERT INTO email_sends (user_id, provider, from_email, to_emails, subject, body_text, origin, origin_ref, status, send_at, rfc_message_id)
      VALUES (${USER}, 'gmail', 'me@x.org', '["s3@acme-co.io"]'::jsonb, 'stranded-fixture', 'b', 'outreach', ${s3!}, 'queued', now(), '<stranded-s3@orbit.mail>')`);

    check("another user releases nothing of mine", (await releaseStrandedMessagesForUser(OTHER, camp)) === 0 && (await msg(s1!)).status === "queued");
    check("a stale queued message with no outbox row is released", (await releaseStrandedMessagesForUser(USER, camp)) === 2 && (await msg(s1!)).status === "draft" && (await msg(s2!)).status === "draft");
    check("…but one with an outbox row stays queued", (await msg(s3!)).status === "queued");
    check("…and a fresh one stays queued", (await msg(s4!)).status === "queued");
    check("…and a second pass releases nothing", (await releaseStrandedMessagesForUser(USER, camp)) === 0);
    await strand(s5!, 6);
    check("sending releases a stranded message first, then sends it", (await send([s5!])).sent === 1 && (await msg(s5!)).status === "sent");
  } finally {
    setProviderOverride("gmail", null);
    await resetBucket();
    await reset();
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll outreach-send checks passed.");
}

run(main);
