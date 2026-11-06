/**
 * Accepting an email-backed Radar card: the reminder it creates, what it says, when it is due,
 * that it cannot be made twice or by the wrong account, and that a card without an email
 * behind it still does what it always did. PGlite, no network.
 * Run: npx tsx scripts/smoke-radar-email-accept.ts
 */
import "./smoke/_env";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, emailEvents, emailThreads, radarRuns, recommendationFeedback, recommendations, reminders, userSettings } from "../src/db/schema";
import { syncIdentitiesForContact } from "../src/lib/contact-identity";
import { reminderTextFor, scheduleEmailEventReminder } from "../src/lib/email-intel/reminders";
import { upsertThreadResult } from "../src/lib/email-intel/store";
import { scheduleRecommendationForUser } from "../src/lib/radar/actions-core";
import { claimRadarLease, runRadarForUser } from "../src/lib/radar/run";
import { ensureUserSettings } from "../src/lib/user-settings";

const U = "smoke-rea-u";
const V = "smoke-rea-v";
const DAY = 86_400_000;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

console.log("\nWhat the reminder says");
const base = { name: "Dana Kim", company: "Northwind", role: "Staff Engineer, Payments", ask: null as string | null };
check("the email's own ask, for the person it asked", reminderTextFor({ ...base, kind: "job_posting", onThread: true, ask: "Reply with your availability" }) === "Reply with your availability");
check("a colleague is never given the ask", !reminderTextFor({ ...base, kind: "job_posting", onThread: false, ask: "Reply with your availability" }).includes("Reply with"));
check("a job, for someone on the email", reminderTextFor({ ...base, kind: "job_posting", onThread: true }) === "Reply to Dana Kim about Staff Engineer, Payments at Northwind");
check("a job, for a colleague", reminderTextFor({ ...base, kind: "job_posting", onThread: false }) === "Ask Dana Kim about Staff Engineer, Payments at Northwind");
check("a hiring process, for someone on the email", reminderTextFor({ ...base, kind: "process_update", onThread: true }) === "Follow up with Dana Kim about Northwind");
check("a hiring process, for a colleague", reminderTextFor({ ...base, kind: "process_update", onThread: false }) === "Ask Dana Kim for a hand with Northwind");
check("news", reminderTextFor({ ...base, kind: "news", onThread: false }) === "Reach out to Dana Kim about Northwind news");
check("an event", reminderTextFor({ ...base, kind: "event", onThread: false }) === "Follow up with Dana Kim about the event");
check("missing pieces degrade, they do not print 'null'", !/null|undefined/.test(reminderTextFor({ kind: "job_posting", onThread: false, name: "Dana Kim", company: null, role: null, ask: null })));
check("a title is one capped line", reminderTextFor({ ...base, kind: "job_posting", onThread: true, ask: "x".repeat(400) }).length <= 140);

async function addContact(userId: string, fullName: string, title: string, email: string | null) {
  const db = await getDb();
  const [row] = await db.insert(contacts).values({ userId, fullName, company: "Northwind", title, email, closenessTier: "inner" }).returning();
  if (email) await syncIdentitiesForContact(userId, row!.id, { email }, "smoke");
  return row!.id;
}

async function main() {
  const db = await getDb();
  await db.delete(radarRuns).where(inArray(radarRuns.userId, [U, V]));
  await db.delete(emailThreads).where(inArray(emailThreads.userId, [U, V]));
  await db.delete(contacts).where(inArray(contacts.userId, [U, V]));
  for (const u of [U, V]) await ensureUserSettings(u);
  await db.update(userSettings).set({ emailIntelEnabled: 1 }).where(eq(userSettings.userId, U));

  const dana = await addContact(U, "Dana Kim", "Technical Recruiter", "dana@northwind.example");
  const eli = await addContact(U, "Eli Park", "Payments Engineer", null);
  const ned = await addContact(U, "Ned Ross", "Payments Engineer", null);
  await upsertThreadResult(U, { threadId: "rea-1", lastMessageId: "m1", subject: "Staff Engineer", participants: ["dana@northwind.example"], lastDirection: "in", decision: "classify", triageScore: 3, event: null });
  const [thread] = await db.select().from(emailThreads).where(eq(emailThreads.userId, U));
  const deadline = new Date(Date.now() + 3 * DAY);
  const [event] = await db
    .insert(emailEvents)
    .values({
      userId: U,
      threadRowId: thread!.id,
      source: "ai",
      kind: "job_posting",
      company: "Northwind",
      role: "Staff Engineer, Payments",
      occurredAt: new Date(Date.now() - DAY),
      dueAt: deadline,
      summary: "Northwind is hiring a Staff Engineer for Payments.",
      evidenceQuote: "We're hiring a Staff Engineer for our Payments team",
      confidence: 0.9,
      people: [{ name: "Dana Kim", email: "dana@northwind.example", title: "Technical Recruiter" }],
      asks: ["Reply with your availability"],
    })
    .returning();

  const now = new Date();
  await claimRadarLease(U, now);
  const stats = await runRadarForUser(U, { trigger: "manual", now, ai: false });
  check("Radar ran", stats.ok);
  const cards = await db.select().from(recommendations).where(and(eq(recommendations.userId, U), eq(recommendations.status, "pending")));
  const card = (id: string) => cards.find((c) => c.contactId === id);
  check("the recruiter, a colleague and another colleague each have a card", Boolean(card(dana)) && Boolean(card(eli)) && Boolean(card(ned)));

  console.log("\nAccepting the reply you owe");
  const accepted = await scheduleRecommendationForUser(U, card(dana)!.id, 7);
  check("accepting works", accepted.ok);
  const danaReminders = await db.select().from(reminders).where(and(eq(reminders.userId, U), eq(reminders.contactId, dana)));
  check("exactly one reminder", danaReminders.length === 1);
  const r = danaReminders[0]!;
  check("it is the email's own ask", r.title === "Reply with your availability");
  check("described by the summary", r.description === "Northwind is hiring a Staff Engineer for Payments.");
  check("carrying the quote it came from", r.sourceExcerpt === "We're hiring a Staff Engineer for our Payments team");
  check("marked as AI-originated", r.createdBy === "ai" && r.reminderType === "ai_suggested" && r.origin === "implied");
  check("with the confidence it was extracted at", r.confidenceScore === 90);
  check("and a hash that makes it idempotent", typeof r.itemHash === "string" && r.itemHash.length > 0);
  check("due at the email's deadline, because it is sooner than the preset", r.dueDate?.getTime() === deadline.getTime(), String(r.dueDate));
  check("the answer reports that date", accepted.ok && accepted.dueDate === deadline.toISOString());
  const [danaRow] = await db.select().from(contacts).where(eq(contacts.id, dana));
  check("the contact's next follow-up matches", danaRow!.nextFollowUpAt?.getTime() === deadline.getTime() && danaRow!.followUpStatus === "pending");
  const [danaCard] = await db.select().from(recommendations).where(eq(recommendations.id, card(dana)!.id));
  check("the card is retired", danaCard!.status === "accepted");
  const feedback = await db.select().from(recommendationFeedback).where(and(eq(recommendationFeedback.userId, U), eq(recommendationFeedback.recommendationId, card(dana)!.id)));
  check("and the acceptance is remembered, as it always was", feedback.length === 1 && feedback[0]!.action === "accepted");

  console.log("\nAccepting an opening at their company");
  const before = Date.now();
  const colleague = await scheduleRecommendationForUser(U, card(eli)!.id, 14);
  check("accepting works", colleague.ok);
  const [eliReminder] = await db.select().from(reminders).where(and(eq(reminders.userId, U), eq(reminders.contactId, eli)));
  check("the reminder asks about the role, not the reply", eliReminder!.title === "Ask Eli Park about Staff Engineer, Payments at Northwind");
  const dueDays = (eliReminder!.dueDate!.getTime() - before) / DAY;
  check("the deadline is not theirs, so the preset rules", dueDays > 13.9 && dueDays < 14.1, String(dueDays));

  console.log("\nNever twice, never someone else's");
  const again = await scheduleEmailEventReminder(U, { contactId: dana, eventId: event!.id, onThread: true, days: 7 });
  check("asking again finds the same reminder", again !== null && again.created === false && again.reminderId === r.id);
  check("and does not make a second", (await db.select().from(reminders).where(and(eq(reminders.userId, U), eq(reminders.contactId, dana)))).length === 1);
  check("another account cannot use this event", (await scheduleEmailEventReminder(V, { contactId: dana, eventId: event!.id, onThread: true, days: 7 })) === null);
  check("nor this contact", (await scheduleEmailEventReminder(V, { contactId: dana, eventId: "00000000-0000-0000-0000-000000000000", onThread: true, days: 7 })) === null);
  check("another account cannot accept this card", (await scheduleRecommendationForUser(V, card(ned)!.id, 7)).ok === false);

  console.log("\nWhen the email is gone");
  await db.update(emailEvents).set({ dismissedAt: new Date() }).where(eq(emailEvents.id, event!.id));
  check("a dismissed event makes no reminder", (await scheduleEmailEventReminder(U, { contactId: ned, eventId: event!.id, onThread: false, days: 7 })) === null);
  const fallback = await scheduleRecommendationForUser(U, card(ned)!.id, 7);
  check("the card still works", fallback.ok);
  const [nedReminder] = await db.select().from(reminders).where(and(eq(reminders.userId, U), eq(reminders.contactId, ned)));
  check("as the generic follow-up it always was", nedReminder!.title === "Follow up with Ned Ross" && nedReminder!.createdBy === "user");

  await db.delete(radarRuns).where(inArray(radarRuns.userId, [U, V]));
  await db.delete(emailThreads).where(inArray(emailThreads.userId, [U, V]));
  await db.delete(contacts).where(inArray(contacts.userId, [U, V]));
  console.log("\nAll Radar email-accept checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
