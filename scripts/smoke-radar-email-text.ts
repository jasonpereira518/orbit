/**
 * Where a card built from someone's mail may and may not speak: the draft prompt's intent and
 * the Monday email. The second is exercised through the real digest query. PGlite, no model.
 * Run: npx tsx scripts/smoke-radar-email-text.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, emailEvents, emailThreads, radarRuns, recommendations, userSettings } from "../src/db/schema";
import { syncIdentitiesForContact } from "../src/lib/contact-identity";
import { upsertThreadResult } from "../src/lib/email-intel/store";
import { draftIntent } from "../src/lib/radar/drafts";
import { loadDigestContent } from "../src/lib/radar/digest";
import { EMAIL_DIGEST_LINE, EMAIL_DRAFT_INTENTS, EMAIL_REASON_CODES, digestLineFor, isEmailDerived } from "../src/lib/radar/email-text";
import { claimRadarLease, runRadarForUser } from "../src/lib/radar/run";
import type { RadarReason } from "../src/lib/radar/types";
import { ensureUserSettings } from "../src/lib/user-settings";

const U = "smoke-ret-u";
const DAY = 86_400_000;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const reason = (code: string, label: string, points = 20): RadarReason => ({ code, label, points });
const SUMMARY = "Northwind is hiring a Staff Engineer for Payments.";

console.log("\nWhat is derived from mail");
check("a card with an email reason is", isEmailDerived([reason("email_job", SUMMARY), reason("tier", "One of your closest", 8)]));
check("so is one that only carries it as an 'also' line", isEmailDerived([reason("dormant", "60 days since you last spoke"), reason("also:email_job", SUMMARY, 0)]));
check("an ordinary card is not", !isEmailDerived([reason("job_change", "Joined Stripe"), reason("also:dormant", "60 days", 0)]));

console.log("\nThe draft prompt's intent");
const target = (reasons: RadarReason[]) => ({ kind: "follow_up" as const, reasons });
check("an email card uses fixed words, not the summary", (() => {
  const intent = draftIntent(target([reason("email_followup", SUMMARY), reason("tier", "One of your closest", 8)]));
  return intent.includes(EMAIL_DRAFT_INTENTS.email_followup!) && !intent.includes("Northwind");
})());
check("every email code has a fixed intent", [...EMAIL_REASON_CODES].every((code) => Boolean(EMAIL_DRAFT_INTENTS[code])));
check("no fixed intent contains a company, a name or an address", Object.values(EMAIL_DRAFT_INTENTS).every((v) => !/[@A-Z]{2,}/.test(v.replace(/^[A-Z]/, ""))));
check("an ordinary card still uses its own reason", draftIntent({ kind: "reach_out", reasons: [reason("inbound_unanswered", "They messaged you 9 days ago")] }) === "Reach out: They messaged you 9 days ago");
check("and a card with no reason still has a kind", draftIntent({ kind: "reconnect", reasons: [] }) === "Reconnect");

console.log("\nThe Monday email's line");
check("an email card gets the fixed line", digestLineFor("Dana wrote about the Northwind role.", [reason("email_job", SUMMARY)]) === EMAIL_DIGEST_LINE);
check("and the AI's sentence is withheld even when it exists", !digestLineFor("Dana wrote about the Northwind role.", [reason("dormant", "60 days"), reason("also:email_job", SUMMARY, 0)]).includes("Dana"));
check("an ordinary card keeps the AI's sentence", digestLineFor("  They are expecting your reply.  ", [reason("inbound_unanswered", "x")]) === "They are expecting your reply.");
check("or its lead reason", digestLineFor(null, [reason("job_change", "Joined Stripe")]) === "Joined Stripe");
check("or the default", digestLineFor(null, []) === "Worth a message this week");

console.log("\nThrough the real digest query");
async function main() {
  const db = await getDb();
  await db.delete(radarRuns).where(eq(radarRuns.userId, U));
  await db.delete(emailThreads).where(eq(emailThreads.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));
  await ensureUserSettings(U);
  await db.update(userSettings).set({ emailIntelEnabled: 1 }).where(eq(userSettings.userId, U));

  const [dana] = await db.insert(contacts).values({ userId: U, fullName: "Dana Kim", company: "Northwind", title: "Technical Recruiter", email: "dana@northwind.example", closenessTier: "inner" }).returning();
  await syncIdentitiesForContact(U, dana!.id, { email: "dana@northwind.example" }, "smoke");
  await upsertThreadResult(U, { threadId: "ret-1", lastMessageId: "m1", subject: "Staff Engineer", participants: ["dana@northwind.example"], lastDirection: "in", decision: "classify", triageScore: 3, event: null });
  const [thread] = await db.select().from(emailThreads).where(eq(emailThreads.userId, U));
  await db.insert(emailEvents).values({
    userId: U,
    threadRowId: thread!.id,
    source: "ai",
    kind: "job_posting",
    company: "Northwind",
    role: "Staff Engineer, Payments",
    occurredAt: new Date(Date.now() - DAY),
    summary: SUMMARY,
    evidenceQuote: "We're hiring a Staff Engineer for our Payments team",
    confidence: 0.9,
    people: [{ name: "Dana Kim", email: "dana@northwind.example", title: null }],
    asks: ["Reply with your availability"],
  });

  const now = new Date();
  await claimRadarLease(U, now);
  check("Radar ran", (await runRadarForUser(U, { trigger: "manual", now, ai: false })).ok);
  const [card] = await db.select().from(recommendations).where(and(eq(recommendations.userId, U), eq(recommendations.contactId, dana!.id), eq(recommendations.status, "pending")));
  check("the card exists and came from mail", Boolean(card) && isEmailDerived(card!.reasons));
  // Give it an AI sentence that repeats the mail, as the why-line would.
  await db.update(recommendations).set({ aiNote: { why: "Dana wrote to you about the Northwind role.", opener: "Hi Dana", inputsHash: card!.inputsHash, generatedAt: now.toISOString() } }).where(eq(recommendations.id, card!.id));

  const digest = await loadDigestContent(U);
  check("the digest includes her", Boolean(digest) && digest!.people.some((p) => p.name === "Dana Kim"), JSON.stringify(digest?.people.map((p) => p.name)));
  const line = digest!.people.find((p) => p.name === "Dana Kim")!.line;
  check("under the fixed line", line === EMAIL_DIGEST_LINE, line);
  check("and nothing from the mail or the AI's sentence about it", !JSON.stringify(digest).includes("Northwind is hiring") && !JSON.stringify(digest).includes("wrote to you"));

  await db.delete(radarRuns).where(eq(radarRuns.userId, U));
  await db.delete(emailThreads).where(eq(emailThreads.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));
  console.log("\nAll Radar email-text checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
