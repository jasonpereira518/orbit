/**
 * Reply targets: which conversations Compose can reply into, and how a key is re-resolved
 * server-side (owner-scoped). Run: npx tsx scripts/smoke-email-reply-targets.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { listReplyTargets, replySubject, resolveReplyTarget } from "../src/lib/email/reply-targets";
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
