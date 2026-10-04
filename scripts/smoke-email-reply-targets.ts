/**
 * Reply targets: which conversations Compose can reply into, and how a key is re-resolved
 * server-side (owner-scoped). Run: npx tsx scripts/smoke-email-reply-targets.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { GOOGLE_SCOPES } from "../src/lib/google-scopes";
import { MICROSOFT_SCOPES } from "../src/lib/microsoft-scopes";
import { listReplyTargets, replySubject, resolveReplyTarget, setReplyInboxOverride } from "../src/lib/email/reply-targets";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-reply-user";
const OTHER = "smoke-reply-other";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

async function main() {
  const db = await getDb();
  for (const u of [USER, OTHER]) await purgeUserData(u, { keepSettings: false }).catch(() => {});
  try {
    const [maya] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Maya Chen", email: "maya@work.org" }).returning();
    const [sam] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Sam Lee", email: "sam@work.org" }).returning();

    console.log("subjects");
    check("adds Re:", replySubject("Coffee?") === "Re: Coffee?");
    check("never doubles it", replySubject("RE: Coffee?") === "RE: Coffee?" && replySubject("re:x") === "re:x");
    check("empty stays readable", replySubject("") === "Re: (no subject)");

    console.log("nothing yet");
    check("no targets for a fresh contact", (await listReplyTargets(USER, maya!.id)).length === 0);

    console.log("threads Orbit sent");
    let n = 0;
    const insertSend = async (
      status: "sent" | "canceled" | "failed" | "queued",
      subject: string,
      sentDaysAgo: number,
      contactId: string,
      extra: Partial<typeof schema.emailSends.$inferInsert> = {}
    ) => {
      const [row] = await db
        .insert(schema.emailSends)
        .values({
          userId: USER,
          provider: "gmail",
          fromEmail: "me@acme-corp.io",
          to: ["maya@work.org"],
          subject,
          bodyText: "B",
          origin: "compose",
          status,
          sendAt: ago(sentDaysAgo),
          sentAt: status === "sent" ? ago(sentDaysAgo) : null,
          rfcMessageId: `<reply-${++n}@orbit.mail>`,
          contactIds: [contactId],
          providerThreadId: "t-1",
          ...extra,
        })
        .returning();
      return row!;
    };
    const older = await insertSend("sent", "Older", 9, maya!.id);
    const newest = await insertSend("sent", "Coffee next week?", 2, maya!.id);
    await insertSend("canceled", "Never went", 1, maya!.id);
    await insertSend("sent", "For Sam", 1, sam!.id);
    const list = await listReplyTargets(USER, maya!.id);
    const orbit = list.filter((t) => t.source === "orbit");
    check("the newest sent thread is offered", orbit.length === 1 && orbit[0]!.key === `orbit:${newest.id}` && orbit[0]!.subject === "Coffee next week?", JSON.stringify(list));
    check("canceled sends are not", !list.some((t) => t.subject === "Never went"));
    check("other contacts' threads are not", !list.some((t) => t.subject === "For Sam"));
    const r = await resolveReplyTarget(USER, `orbit:${newest.id}`);
    check(
      "resolves to its Message-ID and thread",
      r?.rfcMessageId === newest.rfcMessageId && r?.inReplyToSendId === newest.id && r?.thread?.threadId === "t-1" && r.thread.email === "me@acme-corp.io"
    );
    check("an older thread still resolves by key", (await resolveReplyTarget(USER, `orbit:${older.id}`))?.subject === "Older");
    check("someone else's send does not", (await resolveReplyTarget(OTHER, `orbit:${newest.id}`)) === null);
    const lunch = await insertSend("sent", "Re: Lunch", 3, maya!.id);
    check("a Re: subject resolves without its prefix", (await resolveReplyTarget(USER, `orbit:${lunch.id}`))?.subject === "Lunch");

    console.log("BCC-logged mail");
    const [logged] = await db
      .insert(schema.interactions)
      .values({
        userId: USER,
        contactId: maya!.id,
        interactionType: "email",
        interactionDate: ago(1),
        source: "inbound_mail",
        externalId: `mail:CAB+x.y@mail.gmail.com:${maya!.id}`,
        aiSummary: "Intro: Maya <> Dev",
      })
      .returning();
    const withLogged = await listReplyTargets(USER, maya!.id);
    check("the latest logged email is offered, newest first", withLogged[0]?.key === `logged:${logged!.id}` && withLogged[0]?.source === "logged", JSON.stringify(withLogged));
    const lr = await resolveReplyTarget(USER, `logged:${logged!.id}`);
    check(
      "its Message-ID comes from the external id, bracketed",
      lr?.rfcMessageId === "<CAB+x.y@mail.gmail.com>" && lr.thread === null && lr.subject === "Intro: Maya <> Dev",
      JSON.stringify(lr)
    );
    check("another user cannot resolve it", (await resolveReplyTarget(OTHER, `logged:${logged!.id}`)) === null);

    console.log("copy");
    const failed = await insertSend("failed", "Re: Retry me", 0, maya!.id, { inReplyToRfcId: "<parent@x>", inReplyToSendId: newest.id });
    const cr = await resolveReplyTarget(USER, `copy:${failed.id}`);
    check("copy reuses a row's reply fields", cr?.rfcMessageId === "<parent@x>" && cr.inReplyToSendId === newest.id && cr.subject === "Retry me", JSON.stringify(cr));
    check("copy of a row that was not a reply is null", (await resolveReplyTarget(USER, `copy:${newest.id}`)) === null);
    check("copy of someone else's row is null", (await resolveReplyTarget(OTHER, `copy:${failed.id}`)) === null);

    console.log("mailbox lookups (dark)");
    const tokens = { accessTokenEncrypted: encrypt("t"), refreshTokenEncrypted: encrypt("r"), tokenExpiresAt: new Date(Date.now() + 3_600_000) };
    await db.insert(schema.gmailConnections).values({
      userId: USER, emailAddress: "me@acme-corp.io", ...tokens,
      scopes: `${GOOGLE_SCOPES.gmailSend} ${GOOGLE_SCOPES.gmailRead}`, status: "active",
    });
    await db.insert(schema.outlookConnections).values({
      userId: USER, emailAddress: "Me@Contoso.io", ...tokens,
      scopes: `${MICROSOFT_SCOPES.mailSend} ${MICROSOFT_SCOPES.mail}`, status: "active",
    });
    const seen: string[] = [];
    let outlookNewer = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(decodeURIComponent(url));
      if (url.includes("gmail.googleapis.com") && url.includes("/messages?q=")) return Response.json({ messages: [{ id: "g-1", threadId: "gt-1" }] });
      if (url.includes("gmail.googleapis.com") && url.includes("/messages/g-1")) {
        return Response.json({
          id: "g-1", threadId: "gt-1", internalDate: String(Date.now() - 3_600_000),
          payload: { headers: [{ name: "Message-ID", value: "<inbox-1@mail.gmail.com>" }, { name: "Subject", value: "Re: Plans" }] },
        });
      }
      const graph = { id: "o-1", subject: "Dinner", internetMessageId: "<o1@outlook.com>", receivedDateTime: new Date(Date.now() - (outlookNewer ? 60_000 : 7_200_000)).toISOString() };
      if (url.includes("graph.microsoft.com") && url.includes("$search=")) return Response.json({ value: [graph] });
      if (url.includes("graph.microsoft.com") && url.includes("/messages/o-1")) return Response.json(graph);
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    try {
      const dark = await listReplyTargets(USER, maya!.id);
      check("dark: no mailbox call and no inbox target", !dark.some((t) => t.source === "inbox") && seen.length === 0);
      check("dark: an inbox key does not resolve", (await resolveReplyTarget(USER, "inbox:gmail:g-1")) === null && seen.length === 0);

      setReplyInboxOverride(true);
      const lit = await listReplyTargets(USER, maya!.id);
      const inbox = lit.filter((t) => t.source === "inbox");
      check("released: the newer mailbox hit is offered, once", inbox.length === 1 && inbox[0]!.key === "inbox:gmail:g-1" && inbox[0]!.subject === "Plans", JSON.stringify(lit));
      check("Gmail is searched by the contact's address", seen.some((u) => u.includes("from:maya@work.org OR to:maya@work.org")));
      check("Graph is searched by participants", seen.some((u) => u.includes('$search="participants:maya@work.org"')));
      const ir = await resolveReplyTarget(USER, "inbox:gmail:g-1");
      check("a Gmail key re-reads the message, with its thread", ir?.rfcMessageId === "<inbox-1@mail.gmail.com>" && ir.thread?.threadId === "gt-1" && ir.thread.email === "me@acme-corp.io", JSON.stringify(ir));
      outlookNewer = true;
      check("the Outlook hit wins when newer", (await listReplyTargets(USER, maya!.id)).some((t) => t.key === "inbox:outlook:o-1"));
      const or = await resolveReplyTarget(USER, "inbox:outlook:o-1");
      check("an Outlook key resolves by headers alone", or?.rfcMessageId === "<o1@outlook.com>" && or.thread === null && or.subject === "Dinner", JSON.stringify(or));
      check("an unknown provider does not resolve", (await resolveReplyTarget(USER, "inbox:yahoo:1")) === null);
      check("a missing message does not resolve", (await resolveReplyTarget(USER, "inbox:gmail:nope")) === null);

      await db.update(schema.gmailConnections).set({ scopes: GOOGLE_SCOPES.gmailSend }).where(eq(schema.gmailConnections.userId, USER));
      await db.update(schema.outlookConnections).set({ scopes: MICROSOFT_SCOPES.mailSend }).where(eq(schema.outlookConnections.userId, USER));
      seen.length = 0;
      check("without read scopes: nothing, and no call", !(await listReplyTargets(USER, maya!.id)).some((t) => t.source === "inbox") && seen.length === 0);
    } finally {
      globalThis.fetch = realFetch;
      setReplyInboxOverride(null);
    }

    console.log("junk keys");
    for (const k of ["", "orbit:not-a-uuid", "nope:1", "logged:", "inbox:gmail:x"]) {
      check(`"${k}" resolves to null`, (await resolveReplyTarget(USER, k)) === null);
    }
  } finally {
    for (const u of [USER, OTHER]) await purgeUserData(u, { keepSettings: false }).catch(() => {});
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll reply-target checks passed.");
}

run(main);
