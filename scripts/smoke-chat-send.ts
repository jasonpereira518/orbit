/**
 * Sending a chat draft from Gmail (`src/lib/chat-send.ts`, `src/actions/chat-send.ts`).
 *
 * Outbound and irreversible, so the properties that matter are the ones that stop a wrong or
 * repeated send: the recipient comes only from the contact record (and only for a contact the
 * message recommended), a single address is enforced, a double click sends once, a definite
 * Gmail refusal frees the claim while an ambiguous outcome keeps it, and a reloaded thread shows
 * what was sent. Gmail is a stub; no real mail is ever sent.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-chat-send.ts
 */
import "./smoke/_env";
// These actions go through `requireUserId()`. With no Clerk keys AND NODE_ENV=development,
// that resolves to demo mode's `demo-user` — the identity seeded below.
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";
import { and, eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { chatMessages, chatThreads, contacts, gmailConnections, interactions, rateLimitBuckets } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import {
  CHAT_SEND_DAILY_CAP,
  DEFAULT_SEND_SUBJECT,
  chatSendExternalId,
  checkContent,
  checkRecipient,
  classifySendError,
  contactIdFromSendKey,
  isUuid,
} from "../src/lib/chat-send";
import { safeReturnPath } from "../src/lib/safe-return-path";
import { getChatThread } from "../src/actions/chat";
import { getChatSendContext, sendChatDraftViaGmail } from "../src/actions/chat-send";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const USER = "demo-user";

// ---- Gmail stub ----------------------------------------------------------------------------
type Mode = "ok" | "http500" | "network" | "noid";
let mode: Mode = "ok";
const sends: Array<{ raw: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("gmail.googleapis.com/gmail/v1/users/me/messages/send")) return realFetch(input, init);
  sends.push(JSON.parse(String(init?.body)) as { raw: string });
  if (mode === "network") throw new TypeError("fetch failed");
  if (mode === "http500") return new Response("boom", { status: 500 });
  if (mode === "noid") return Response.json({});
  return Response.json({ id: `gm-${sends.length}`, threadId: "t-1" });
}) as typeof fetch;

const decodeRaw = (raw: string) => Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

async function main() {
  console.log("recipient rules");
  check("an ordinary address passes", checkRecipient(" ben@acme-corp.io ").ok);
  for (const [label, value] of [
    ["a comma-separated pair", "a@b.com, c@d.com"],
    ["a semicolon pair", "a@b.com;c@d.com"],
    ["a display-name form", "Ben <ben@acme-corp.io>"],
    ["two at-signs", "a@b@c.com"],
    ["an internal space", "ben @acme-corp.io"],
    ["a newline (header injection)", "ben@acme-corp.io\nBcc: x@y.com"],
    ["no domain dot", "ben@localhost"],
    ["a leading-dash label", "ben@-acme.com"],
    ["a quote", 'be"n@acme-corp.io'],
    ["a paren", "ben(x)@acme-corp.io"],
    ["empty local part", "@acme-corp.io"],
  ] as const) {
    check(`${label} is refused`, !checkRecipient(value).ok);
  }
  check("no address is no_email", (() => { const r = checkRecipient(null); return !r.ok && r.reason === "no_email"; })());
  check("a placeholder domain is refused as such", (() => { const r = checkRecipient("ben@example.com"); return !r.ok && r.reason === "placeholder"; })());
  check("a .test domain too", (() => { const r = checkRecipient("ben@acme.test"); return !r.ok && r.reason === "placeholder"; })());

  console.log("content rules");
  check("a blank body is refused", !checkContent({ body: "  \n " }).ok);
  check("a blank subject becomes the default", (() => { const r = checkContent({ subject: "  ", body: "Hi" }); return r.ok && r.subject === DEFAULT_SEND_SUBJECT; })());
  check("a subject is one line", (() => { const r = checkContent({ subject: "a\r\nBcc: x@y.com", body: "Hi" }); return r.ok && !/[\r\n]/.test(r.subject); })());
  check("an over-long subject is refused", !checkContent({ subject: "x".repeat(201), body: "Hi" }).ok);
  check("an over-long body is refused or capped, never sent whole", (() => { const r = checkContent({ body: "x".repeat(6000) }); return !r.ok || r.body.length <= 5000; })());
  check("the body is cleaned of invisible characters", (() => { const r = checkContent({ body: `Hi${String.fromCharCode(0x200b, 0)}there` }); return r.ok && r.body === "Hithere"; })());

  console.log("keys and classification");
  const M = "11111111-1111-4111-8111-111111111111";
  const C = "22222222-2222-4222-8222-222222222222";
  check("a claim key round-trips", contactIdFromSendKey(chatSendExternalId(M, C), M) === C);
  check("another message's key does not match", contactIdFromSendKey(chatSendExternalId(M, C), "33333333-3333-4333-8333-333333333333") === null);
  check("a non-uuid tail is refused", contactIdFromSendKey(`chat-send:${M}:not-an-id`, M) === null);
  check("isUuid", isUuid(M) && !isUuid("abc") && !isUuid(undefined));
  check("a Gmail 500 is a definite failure", classifySendError(new Error("Gmail send failed: boom")) === "definite");
  check("the 403 refusal means reconnect", classifySendError(new Error("Gmail refused the send. Reconnect Gmail to grant permission to send mail.")) === "needs_reconnect");
  check("a dead grant means reconnect", classifySendError(Object.assign(new Error("x"), { name: "ReauthRequiredError" })) === "needs_reconnect");
  check("a timeout is ambiguous", classifySendError(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })) === "ambiguous");
  check("a dropped connection is ambiguous", classifySendError(new TypeError("fetch failed")) === "ambiguous");
  check("a success with no id is ambiguous", classifySendError(new Error("Gmail send returned no message id")) === "ambiguous");

  console.log("return paths");
  check("a same-origin path passes", safeReturnPath("/chat?thread=abc") === "/chat?thread=abc");
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "chat", "", null, "/a\nb"]) {
    check(`${JSON.stringify(bad)} is refused`, safeReturnPath(bad as string | null) === null);
  }

  console.log("the action");
  const db = await getDb();
  const [contact] = await db.insert(contacts).values({ userId: USER, fullName: "Ben Carter", email: "ben@acme-corp.io" }).returning();
  const [other] = await db.insert(contacts).values({ userId: USER, fullName: "Not Recommended", email: "nr@acme-corp.io" }).returning();
  const [foreign] = await db.insert(contacts).values({ userId: "someone-else", fullName: "Foreign", email: "f@acme-corp.io" }).returning();
  const [thread] = await db.insert(chatThreads).values({ userId: USER }).returning();
  const rec = (contactId: string) => ({ contact_id: contactId, recruiter_id: null, name: "Ben Carter", reason: "r", suggested_action: "a", draft_message: "Hi Ben" });
  const [msg] = await db.insert(chatMessages).values({ threadId: thread!.id, userId: USER, role: "assistant", content: "Ben.", recommendations: [rec(contact!.id)] }).returning();
  const [foreignMsg] = await db.insert(chatMessages).values({ threadId: thread!.id, userId: "someone-else", role: "assistant", content: "x", recommendations: [rec(contact!.id)] }).returning();
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, USER));
  await db.insert(gmailConnections).values({
    userId: USER,
    emailAddress: "me@gmail-mail.io",
    accessTokenEncrypted: encrypt("access-token"),
    refreshTokenEncrypted: encrypt("refresh-token"),
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    scopes: `${GOOGLE_SCOPES.gmailRead} ${GOOGLE_SCOPES.gmailSend}`,
  });

  const reset = async () => {
    sends.length = 0;
    mode = "ok";
    await db.delete(interactions).where(and(eq(interactions.userId, USER), eq(interactions.source, "chat_send")));
    await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "chatSend:%"));
  };
  const send = (over: Partial<Parameters<typeof sendChatDraftViaGmail>[0]> = {}) =>
    sendChatDraftViaGmail({ messageId: msg!.id, contactId: contact!.id, subject: "Hello", body: "Hi Ben, a quick call Thursday?", shownTo: "ben@acme-corp.io", ...over });
  const claims = () => db.select().from(interactions).where(and(eq(interactions.userId, USER), eq(interactions.source, "chat_send")));

  await reset();
  const ctxBefore = await getChatSendContext(msg!.id, contact!.id);
  check("the confirm dialog gets the contact's address, not one it was given", ctxBefore?.to === "ben@acme-corp.io" && ctxBefore.recipientProblem === null);
  check("and knows the plan and the connected account", ctxBefore?.planAllows === true && ctxBefore.identity.sendingAs === "me@gmail-mail.io" && ctxBefore.identity.canSend === true, JSON.stringify(ctxBefore));
  check("a contact the message did not recommend gets no dialog", (await getChatSendContext(msg!.id, other!.id)) === null);
  check("a foreign message gets no dialog", (await getChatSendContext(foreignMsg!.id, contact!.id)) === null);

  console.log("a send");
  const ok = await send();
  check("it sends", ok.ok === true, JSON.stringify(ok));
  check("exactly one message went out", sends.length === 1);
  const mime = decodeRaw(sends[0]!.raw);
  check("to the contact's address, from the connected account", /^To: ben@acme-corp\.io$/m.test(mime) && /From: .*me@gmail-mail\.io/.test(mime), mime);
  check("with the subject and body as confirmed", /^Subject: Hello$/m.test(mime) && mime.endsWith("Hi Ben, a quick call Thursday?"));
  const rows = await claims();
  check("one interaction records it, keyed to this message and person", rows.length === 1 && rows[0]!.externalId === chatSendExternalId(msg!.id, contact!.id) && rows[0]!.direction === "out" && rows[0]!.interactionType === "email");
  check("holding the exact text sent", rows[0]?.rawNotes === "Hi Ben, a quick call Thursday?");
  const again = await send();
  check("sending again is refused", !again.ok && again.reason === "already_sent");
  check("and no second mail went out", sends.length === 1);
  const touched = await db.query.contacts.findFirst({ where: eq(contacts.id, contact!.id), columns: { lastInteractionAt: true } });
  check("the contact's last touch moved", Boolean(touched?.lastInteractionAt));
  const ctxAfter = await getChatSendContext(msg!.id, contact!.id);
  check("the dialog now says it was sent", Boolean(ctxAfter?.alreadySent));
  const loaded = await getChatThread(thread!.id);
  check("a reloaded thread shows it as sent", Boolean(loaded.sent[msg!.id]?.[contact!.id]), JSON.stringify(loaded.sent));

  console.log("a double click");
  await reset();
  const [a, b] = await Promise.all([send(), send()]);
  check("exactly one of two simultaneous sends goes out", sends.length === 1, `${sends.length} sends`);
  check("the other is told it was already sent", [a, b].filter((r) => r.ok).length === 1 && [a, b].some((r) => !r.ok && r.reason === "already_sent"), JSON.stringify([a, b]));

  console.log("who it can go to");
  await reset();
  check("a contact the message did not recommend is refused", (await send({ contactId: other!.id, shownTo: "nr@acme-corp.io" })).ok === false);
  check("a foreign contact is refused", (await send({ contactId: foreign!.id, shownTo: "f@acme-corp.io" })).ok === false);
  check("a foreign message is refused", (await send({ messageId: foreignMsg!.id })).ok === false);
  check("a non-uuid id is refused", (await send({ messageId: "x" })).ok === false);
  const wrongShown = await send({ shownTo: "someone@else.io" });
  check("an address that is not what was shown is refused", !wrongShown.ok && wrongShown.reason === "changed_recipient");
  check("nothing went out for any of those", sends.length === 0 && (await claims()).length === 0);

  await db.update(contacts).set({ email: "a@b.com, c@d.com" }).where(eq(contacts.id, contact!.id));
  const two = await send({ shownTo: "a@b.com, c@d.com" });
  check("a stored pair of addresses is refused, not mailed to both", !two.ok && two.reason === "invalid_recipient" && sends.length === 0);
  await db.update(contacts).set({ email: "ben@example.com" }).where(eq(contacts.id, contact!.id));
  const ph = await send({ shownTo: "ben@example.com" });
  check("a placeholder address is refused", !ph.ok && ph.reason === "placeholder" && sends.length === 0);
  await db.update(contacts).set({ email: null }).where(eq(contacts.id, contact!.id));
  const none = await send({ shownTo: "" });
  check("no address is refused", !none.ok && none.reason === "no_email");
  await db.update(contacts).set({ email: "ben@acme-corp.io" }).where(eq(contacts.id, contact!.id));

  console.log("Gmail says no");
  await reset();
  mode = "http500";
  const failed = await send();
  check("a Gmail error is reported as nothing sent", !failed.ok && failed.reason === "failed");
  check("and the claim is released", (await claims()).length === 0);
  mode = "ok";
  const retry = await send();
  check("so a retry goes through", retry.ok === true && sends.length === 2);

  console.log("Gmail may have said yes");
  await reset();
  mode = "network";
  const maybe = await send();
  check("a dropped connection is reported as possibly sent", !maybe.ok && maybe.reason === "ambiguous");
  check("and the claim is KEPT", (await claims()).length === 1);
  mode = "ok";
  const blocked = await send();
  check("so a retry cannot mail them twice", !blocked.ok && blocked.reason === "already_sent" && sends.length === 1);
  await reset();
  mode = "noid";
  const noid = await send();
  check("a success with no message id is ambiguous too", !noid.ok && noid.reason === "ambiguous" && (await claims()).length === 1);

  console.log("consent and limits");
  await reset();
  await db.update(gmailConnections).set({ scopes: GOOGLE_SCOPES.gmailRead }).where(eq(gmailConnections.userId, USER));
  const noScope = await send();
  check("without the send permission, nothing is claimed or sent", !noScope.ok && noScope.reason === "missing_scope" && sends.length === 0 && (await claims()).length === 0);
  await db.update(gmailConnections).set({ scopes: `${GOOGLE_SCOPES.gmailRead} ${GOOGLE_SCOPES.gmailSend}`, status: "needs_reauth" }).where(eq(gmailConnections.userId, USER));
  const stale = await send();
  check("a connection that needs reconnecting is reported as such", !stale.ok && stale.reason === "needs_reconnect" && sends.length === 0);
  await db.update(gmailConnections).set({ status: "active" }).where(eq(gmailConnections.userId, USER));
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, USER));
  const notConn = await send();
  check("no Gmail at all is reported as not connected", !notConn.ok && notConn.reason === "not_connected" && sends.length === 0);
  await db.insert(gmailConnections).values({
    userId: USER,
    emailAddress: "me@gmail-mail.io",
    accessTokenEncrypted: encrypt("access-token"),
    refreshTokenEncrypted: encrypt("refresh-token"),
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    scopes: `${GOOGLE_SCOPES.gmailRead} ${GOOGLE_SCOPES.gmailSend}`,
  });

  await reset();
  const [m2, m3, m4, m5, m6, m7, m8, m9, m10, m11] = await Promise.all(
    Array.from({ length: 10 }, () =>
      db.insert(chatMessages).values({ threadId: thread!.id, userId: USER, role: "assistant", content: "x", recommendations: [rec(contact!.id)] }).returning().then((r) => r[0]!)
    )
  );
  const results: boolean[] = [];
  for (const m of [m2, m3, m4, m5, m6, m7, m8, m9, m10, m11]) {
    results.push((await send({ messageId: m!.id })).ok);
  }
  check("ten sends in the window all go", results.every(Boolean), JSON.stringify(results));
  const eleventh = await send({ messageId: msg!.id });
  check("the eleventh is rate limited, and nothing goes", !eleventh.ok && eleventh.reason === "rate_limited" && sends.length === 10);

  await reset();
  for (let i = 0; i < CHAT_SEND_DAILY_CAP; i++) {
    await db.insert(interactions).values({ userId: USER, contactId: other!.id, interactionType: "email", direction: "out", source: "chat_send", externalId: `chat-send:${crypto.randomUUID()}:${other!.id}`, interactionDate: new Date(), sameDayOrder: 0, rawNotes: "x" });
  }
  const capped = await send();
  check("the daily cap stops a send", !capped.ok && capped.reason === "daily_limit" && sends.length === 0);

  console.log("the source");
  const src = await import("node:fs").then((fs) => fs.readFileSync("src/actions/chat-send.ts", "utf8"));
  check("the action takes no recipient argument", !/\bto\??:\s*string/.test(src.slice(src.indexOf("export async function sendChatDraftViaGmail"), src.indexOf("}): Promise<ChatSendResult>"))));
  check("the claim comes before the send", src.indexOf(".onConflictDoNothing()") > -1 && src.indexOf(".onConflictDoNothing()") < src.indexOf("await sendGmailMessage("));

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll chat send checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
