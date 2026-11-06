/**
 * Adding, or dismissing, a person from "From your inbox": the contact that results, that only
 * what the strip offered can be added, the plan cap, the purge, and that adding someone is
 * what lets Radar reach for them. PGlite, no network.
 * Run: npx tsx scripts/smoke-email-intel-inbox-add.ts
 */
import "./smoke/_env";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contactIdentities,
  contacts,
  emailEvents,
  emailThreads,
  ignoredPeople,
  radarRuns,
  recommendations,
  userSettings,
} from "../src/db/schema";
import { addInboxPersonForUser, dismissInboxPersonForUser, INBOX_GONE_MESSAGE } from "../src/lib/email-intel/inbox-actions";
import { loadInboxPeople } from "../src/lib/email-intel/inbox-people";
import { deleteEmailIntelData, upsertThreadResult } from "../src/lib/email-intel/store";
import { getEntitlements } from "../src/lib/entitlements";
import { claimRadarLease, refreshRadarForNewContact, runRadarForUser } from "../src/lib/radar/run";
import { produceEmailSignals } from "../src/lib/radar/signals/email";
import { purgeUserData } from "../src/lib/user-data";
import { ensureUserSettings } from "../src/lib/user-settings";
import type { EmailEventPerson } from "../src/lib/email-intel/types";

const U = "smoke-eia-u";
const V = "smoke-eia-v";
const CAPPED = "smoke-eia-cap";
const ALL = [U, V, CAPPED];
const DAY = 86_400_000;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

let seq = 0;
async function addEvent(userId: string, people: EmailEventPerson[], over: { kind?: "job_posting" | "process_update"; stage?: string; asks?: string[] } = {}) {
  const db = await getDb();
  const threadId = `eia-${userId}-${++seq}`;
  await upsertThreadResult(userId, {
    threadId,
    lastMessageId: "m1",
    subject: "x",
    participants: people.map((p) => p.email ?? "").filter(Boolean),
    lastDirection: "in",
    decision: "classify",
    triageScore: 3,
    event: null,
  });
  const [thread] = await db.select().from(emailThreads).where(eq(emailThreads.threadId, threadId));
  const [event] = await db
    .insert(emailEvents)
    .values({
      userId,
      threadRowId: thread!.id,
      source: "ai",
      kind: over.kind ?? "process_update",
      stage: over.stage ?? "screening",
      company: "Northwind",
      role: "Staff Engineer, Payments",
      occurredAt: new Date(Date.now() - DAY),
      summary: "Northwind wants to schedule a phone screen",
      evidenceQuote: "Can you do Thursday at 2pm for a phone screen?",
      confidence: 0.9,
      people,
      asks: over.asks ?? ["Reply with your availability"],
    })
    .returning();
  return event!.id;
}

const dana: EmailEventPerson = { name: "Dana Kim", email: "Dana.Kim@Northwind.example", title: "Technical Recruiter" };
const lee: EmailEventPerson = { name: "Lee Moss", email: "lee@acme.example", title: "Engineering Manager" };

async function main() {
  const db = await getDb();
  await db.delete(radarRuns).where(inArray(radarRuns.userId, ALL));
  await db.delete(emailThreads).where(inArray(emailThreads.userId, ALL));
  await db.delete(ignoredPeople).where(inArray(ignoredPeople.userId, ALL));
  await db.delete(contacts).where(inArray(contacts.userId, ALL));
  for (const u of ALL) await ensureUserSettings(u);
  await db.update(userSettings).set({ emailIntelEnabled: 1 }).where(inArray(userSettings.userId, ALL));

  // A first Radar run, so the account has a list and refreshing it later means something.
  await db.insert(contacts).values({ userId: U, fullName: "Eli Park", company: "Northwind", title: "Payments Engineer", closenessTier: "inner" });
  await claimRadarLease(U);
  await runRadarForUser(U, { trigger: "manual", ai: false });

  const eventId = await addEvent(U, [dana, lee]);
  await addEvent(V, [{ name: "Vera Only", email: "vera@acme.example", title: null }]);

  console.log("\nBefore anyone is added");
  const before = await produceEmailSignals(U, new Date());
  check("a stranger on the thread makes no signal: Radar only reaches people in the network", !before.some((s) => s.kind === "email_event" && s.onThread));
  const offered = await loadInboxPeople(U);
  check("both are offered", offered.map((p) => p.name).sort().join(",") === "Dana Kim,Lee Moss");

  console.log("\nAdding");
  const added = await addInboxPersonForUser(U, "dana.kim@northwind.example");
  check("it worked", added.ok && added.created && added.name === "Dana Kim");
  const [contact] = await db.select().from(contacts).where(and(eq(contacts.userId, U), eq(contacts.fullName, "Dana Kim")));
  check("a contact exists", Boolean(contact));
  check("with the address, normalized", contact!.email === "dana.kim@northwind.example");
  check("and the title the email gave", contact!.title === "Technical Recruiter");
  check("marked as coming from email insights", contact!.source === "email_intel");
  check("with no company, no notes and no summary: nothing of the email itself", contact!.company === null && contact!.notes === null && !contact!.aiSummary);
  const identities = await db.select().from(contactIdentities).where(and(eq(contactIdentities.userId, U), eq(contactIdentities.contactId, contact!.id)));
  check("the address is claimed, so duplicate prevention knows it", identities.some((i) => i.kind === "email" && i.value === "dana.kim@northwind.example"));
  check("she is no longer offered", (await loadInboxPeople(U)).map((p) => p.name).join(",") === "Lee Moss");

  console.log("\nAdding twice, or what was never offered");
  const again = await addInboxPersonForUser(U, "dana.kim@northwind.example");
  check("the second add is refused", !again.ok && again.reason === "gone" && again.message === INBOX_GONE_MESSAGE);
  check("and makes no second contact", (await db.select().from(contacts).where(and(eq(contacts.userId, U), eq(contacts.fullName, "Dana Kim")))).length === 1);
  const count = async (u: string) => (await db.select().from(contacts).where(eq(contacts.userId, u))).length;
  const n = await count(U);
  check("an address no email named is refused", !(await addInboxPersonForUser(U, "stranger@acme.example")).ok);
  check("another account's person is refused", !(await addInboxPersonForUser(U, "vera@acme.example")).ok);
  check("an empty key is refused", !(await addInboxPersonForUser(U, "")).ok);
  check("a mailbox the emails never named is refused", !(await addInboxPersonForUser(U, "careers@northwind.example")).ok);
  check("none of that made a contact", (await count(U)) === n);
  check("the other account can add its own", (await addInboxPersonForUser(V, "vera@acme.example")).ok);

  console.log("\nWhat adding lets Radar do");
  const after = await produceEmailSignals(U, new Date());
  const forDana = after.find((s) => s.contactId === contact!.id);
  check("the new contact is on the thread, so Radar now has a signal for them", forDana?.kind === "email_event" && forDana.onThread === true && forDana.eventId === eventId);
  check("refreshing Radar works", await refreshRadarForNewContact(U));
  const cards = await db.select().from(recommendations).where(and(eq(recommendations.userId, U), eq(recommendations.status, "pending")));
  const danaCard = cards.find((c) => c.contactId === contact!.id);
  check("and their card is there at once", Boolean(danaCard), cards.map((c) => c.kind).join(","));
  check("the card is the one you owe", danaCard?.kind === "follow_up", danaCard?.kind);

  console.log("\nRefreshing Radar after an add is polite");
  await db.update(userSettings).set({ radarPaused: 1 }).where(eq(userSettings.userId, U));
  check("a paused account is left alone", (await refreshRadarForNewContact(U)) === false);
  await db.update(userSettings).set({ radarPaused: 0 }).where(eq(userSettings.userId, U));
  check("an account with no list yet is left to its first visit", (await refreshRadarForNewContact(CAPPED)) === false);
  await db.update(userSettings).set({ radarLeaseUntil: new Date(Date.now() + 60_000) }).where(eq(userSettings.userId, U));
  check("one already updating is left alone", (await refreshRadarForNewContact(U)) === false);
  await db.update(userSettings).set({ radarLeaseUntil: null }).where(eq(userSettings.userId, U));

  console.log("\nDismissing");
  check("dismissing works", (await dismissInboxPersonForUser(U, "lee@acme.example")).ok);
  const [row] = await db.select().from(ignoredPeople).where(and(eq(ignoredPeople.userId, U), eq(ignoredPeople.nameKey, "lee moss")));
  check("the name goes on the set-aside list", row?.displayName === "Lee Moss" && row.reason === "rejected" && row.context === "Named in an email");
  check("nothing else is kept: no address, no company", row!.company === null && !JSON.stringify(row).includes("acme.example"));
  check("they are not offered again", (await loadInboxPeople(U)).length === 0);
  check("dismissing twice is fine", (await dismissInboxPersonForUser(U, "lee@acme.example")).ok);
  const ignoredBefore = (await db.select().from(ignoredPeople).where(eq(ignoredPeople.userId, U))).length;
  check("dismissing someone never offered is fine, and writes nothing", (await dismissInboxPersonForUser(U, "ghost@acme.example")).ok && (await db.select().from(ignoredPeople).where(eq(ignoredPeople.userId, U))).length === ignoredBefore);
  check("another account's person cannot be dismissed from here", (await dismissInboxPersonForUser(U, "vera@acme.example")).ok && (await db.select().from(ignoredPeople).where(eq(ignoredPeople.userId, V))).length === 0);

  console.log("\nThe plan cap");
  const { contactLimit } = await getEntitlements(CAPPED);
  if (contactLimit === null) {
    console.log("  (this plan has no contact cap; the cap path is covered by smoke-plan-limits)");
  } else {
    await db.insert(contacts).values(Array.from({ length: contactLimit }, (_, i) => ({ userId: CAPPED, fullName: `Filler ${i}` })));
    await addEvent(CAPPED, [{ name: "Cap Person", email: "cap@acme.example", title: null }]);
    const capped = await addInboxPersonForUser(CAPPED, "cap@acme.example");
    check("a full network is told so", !capped.ok && capped.reason === "limit" && capped.message.length > 0);
    check("and gets no new contact", (await count(CAPPED)) === contactLimit);
    check("the person is still offered", (await loadInboxPeople(CAPPED)).length === 1);
  }

  console.log("\nWhen the data goes, the dismissals go");
  await db.insert(ignoredPeople).values({ userId: U, nameKey: "capture person", displayName: "Capture Person", reason: "skipped", context: "Mentioned in a note" });
  await deleteEmailIntelData(U);
  const left = await db.select().from(ignoredPeople).where(eq(ignoredPeople.userId, U));
  check("Gmail disconnect removes what came from the mail", !left.some((r) => r.nameKey === "lee moss"));
  check("and leaves what capture put there", left.some((r) => r.nameKey === "capture person"));

  await db.insert(ignoredPeople).values({ userId: V, nameKey: "vee two", displayName: "Vee Two", reason: "rejected", context: "Named in an email" });
  await purgeUserData(V, { only: ["insights"] });
  check("an insights wipe removes them too", (await db.select().from(ignoredPeople).where(eq(ignoredPeople.userId, V))).length === 0);

  await db.delete(radarRuns).where(inArray(radarRuns.userId, ALL));
  await db.delete(emailThreads).where(inArray(emailThreads.userId, ALL));
  await db.delete(ignoredPeople).where(inArray(ignoredPeople.userId, ALL));
  await db.delete(contacts).where(inArray(contacts.userId, ALL));
  // The pglite tier shares one database, and the sweep smoke counts the accounts that are armed.
  await db.update(userSettings).set({ emailIntelEnabled: 0 }).where(inArray(userSettings.userId, ALL));
  console.log("\nall inbox-add checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
