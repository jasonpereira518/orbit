/**
 * Radar's run with email events in the mix, end to end on PGlite: the right people get the
 * right card, it is repeatable, an account that opts out loses them, and an account that
 * never opted in is untouched. No model, no network.
 * Run: npx tsx scripts/smoke-radar-email-run.ts
 */
import "./smoke/_env";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, emailEvents, emailThreads, radarRuns, recommendations, userSettings } from "../src/db/schema";
import { syncIdentitiesForContact } from "../src/lib/contact-identity";
import { upsertThreadResult } from "../src/lib/email-intel/store";
import { isEmailReasonCode } from "../src/lib/radar/email-text";
import { claimRadarLease, runRadarForUser } from "../src/lib/radar/run";
import { ensureUserSettings } from "../src/lib/user-settings";

const U = "smoke-rer-u";
const NOW = new Date("2026-10-01T12:00:00Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function addContact(fullName: string, title: string | null, email: string | null, tier: "inner" | "mid" | "outer") {
  const db = await getDb();
  const [row] = await db.insert(contacts).values({ userId: U, fullName, company: "Northwind", title, email, closenessTier: tier }).returning();
  if (email) await syncIdentitiesForContact(U, row!.id, { email }, "smoke");
  return row!.id;
}

async function runOnce() {
  await claimRadarLease(U, NOW);
  return runRadarForUser(U, { trigger: "manual", now: NOW, ai: false });
}

async function live() {
  const db = await getDb();
  return db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.userId, U), inArray(recommendations.status, ["pending", "snoozed", "auto_applied"])));
}

async function main() {
  const db = await getDb();
  await db.delete(radarRuns).where(eq(radarRuns.userId, U));
  await db.delete(emailThreads).where(eq(emailThreads.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));
  await ensureUserSettings(U);
  await db.update(userSettings).set({ emailIntelEnabled: 1 }).where(eq(userSettings.userId, U));

  const dana = await addContact("Dana Kim", "Technical Recruiter", "dana@northwind.example", "inner");
  const eli = await addContact("Eli Park", "Payments Engineer", null, "inner");
  const hal = await addContact("Hal Moss", "Head Chef", null, "outer");
  await upsertThreadResult(U, { threadId: "rer-1", lastMessageId: "m1", subject: "Staff Engineer", participants: ["dana@northwind.example"], lastDirection: "in", decision: "classify", triageScore: 3, event: null });
  const [thread] = await db.select().from(emailThreads).where(eq(emailThreads.userId, U));
  const [event] = await db
    .insert(emailEvents)
    .values({
      userId: U,
      threadRowId: thread!.id,
      source: "ai",
      kind: "job_posting",
      company: "Northwind",
      role: "Staff Engineer, Payments",
      occurredAt: ago(1),
      dueAt: new Date(NOW.getTime() + 3 * DAY),
      summary: "Northwind is hiring a Staff Engineer for Payments.",
      evidenceQuote: "We're hiring a Staff Engineer for our Payments team",
      confidence: 0.9,
      people: [{ name: "Dana Kim", email: "dana@northwind.example", title: "Technical Recruiter" }],
      asks: ["Reply with your availability"],
    })
    .returning();

  console.log("\nThe cards");
  const stats = await runOnce();
  check("the run succeeds", stats.ok, JSON.stringify(stats));
  check("the run counts the signals it read from mail", stats.emailSignals >= 2, String(stats.emailSignals));
  const cards = await live();
  const of = (id: string) => cards.find((c) => c.contactId === id);
  check("the recruiter who wrote to you has a card", Boolean(of(dana)));
  check("it is a reply you owe", of(dana)!.kind === "follow_up");
  check("for an email reason", of(dana)!.reasons.some((r) => r.code === "email_followup"));
  check("whose evidence points back at the email", of(dana)!.evidence[0]!.label === "From your email" && of(dana)!.evidence[0]!.ref?.emailEventId === event!.id && of(dana)!.evidence[0]!.ref?.onThread === true);
  check("a colleague who is not on it has a card about the opening", Boolean(of(eli)) && of(eli)!.kind === "opportunity");
  check("which is not attributed to the thread", of(eli)!.evidence[0]!.ref?.onThread === false);
  check("someone unrelated has none", !of(hal));
  check("every card about this event says where it came from", cards.filter((c) => c.reasons.some((r) => isEmailReasonCode(r.code))).every((c) => c.evidence.some((e) => e.ref?.emailEventId === event!.id)));
  check("no card carries the quote or an address", cards.every((c) => !JSON.stringify([c.reasons, c.evidence]).includes("We're hiring") && !JSON.stringify([c.reasons, c.evidence]).includes("@")));

  console.log("\nRepeatable");
  const before = cards.map((c) => `${c.contactId}:${c.kind}:${c.id}`).sort().join("|");
  await runOnce();
  const after = (await live()).map((c) => `${c.contactId}:${c.kind}:${c.id}`).sort().join("|");
  check("a second run changes nothing", before === after);

  console.log("\nOpting out");
  await db.update(userSettings).set({ emailIntelEnabled: 0 }).where(eq(userSettings.userId, U));
  const off = await runOnce();
  check("an account that opted out reads no mail", off.ok && off.emailSignals === 0);
  check("and its email cards are gone from the list", (await live()).every((c) => !c.reasons.some((r) => isEmailReasonCode(r.code))));

  await db.delete(radarRuns).where(eq(radarRuns.userId, U));
  await db.delete(emailThreads).where(eq(emailThreads.userId, U));
  await db.delete(contacts).where(eq(contacts.userId, U));
  console.log("\nAll Radar email-run checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
