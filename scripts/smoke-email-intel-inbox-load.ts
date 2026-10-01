/**
 * "From your inbox": who an account is offered, from its own stored events, and what it costs.
 * PGlite, no network. Run: npx tsx scripts/smoke-email-intel-inbox-load.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, emailEvents, emailThreads, gmailConnections, ignoredPeople, userSettings } from "../src/db/schema";
import { syncIdentitiesForContact } from "../src/lib/contact-identity";
import { INBOX_CANDIDATES, INBOX_SHOWN, findInboxPerson, loadInboxPeople } from "../src/lib/email-intel/inbox-people";
import { personNameKey } from "../src/lib/email-intel/inbox-pick";
import { upsertThreadResult } from "../src/lib/email-intel/store";
import type { EmailEventKind, EmailEventPerson } from "../src/lib/email-intel/types";
import { normalizePersonKey } from "../src/lib/ignored-people";
import { capturedQueries, startQueryCount, stopQueryCount } from "../src/lib/query-counter";
import { ensureUserSettings } from "../src/lib/user-settings";

const U = "smoke-eil-u";
const V = "smoke-eil-v";
const W = "smoke-eil-w";
const NOW = new Date("2026-09-30T12:00:00Z");
const DAY = 86_400_000;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

let seq = 0;
async function addEvent(
  userId: string,
  kind: EmailEventKind,
  daysAgo: number,
  people: EmailEventPerson[],
  over: { dismissed?: boolean; summary?: string } = {}
) {
  const db = await getDb();
  const threadId = `eil-${userId}-${++seq}`;
  await upsertThreadResult(userId, {
    threadId,
    lastMessageId: "m1",
    subject: "x",
    participants: [],
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
      kind,
      occurredAt: new Date(NOW.getTime() - daysAgo * DAY),
      summary: over.summary ?? `Summary ${seq}`,
      evidenceQuote: "a quote that must never leave",
      confidence: 0.9,
      people,
      dismissedAt: over.dismissed ? NOW : null,
    })
    .returning();
  return event!.id;
}

async function addContact(userId: string, fullName: string, email: string | null) {
  const db = await getDb();
  const [row] = await db.insert(contacts).values({ userId, fullName, email }).returning();
  if (email) await syncIdentitiesForContact(userId, row!.id, { email }, "smoke");
  return row!.id;
}

const person = (name: string, email: string | null, title: string | null = null): EmailEventPerson => ({ name, email, title });

async function main() {
  const db = await getDb();
  for (const u of [U, V, W]) {
    await db.delete(emailThreads).where(eq(emailThreads.userId, u));
    await db.delete(gmailConnections).where(eq(gmailConnections.userId, u));
    await db.delete(ignoredPeople).where(eq(ignoredPeople.userId, u));
  }
  await db.delete(contacts).where(inArray(contacts.userId, [U, V, W]));
  for (const u of [U, V, W]) await ensureUserSettings(u);
  await db.update(userSettings).set({ emailIntelEnabled: 1 }).where(inArray(userSettings.userId, [U, V]));
  await db.update(userSettings).set({ emailIntelEnabled: 0 }).where(eq(userSettings.userId, W));
  await db.insert(gmailConnections).values({ userId: U, emailAddress: "Me@Example.com", accessTokenEncrypted: "x", status: "active" });

  console.log("\nThe rule for names is the one ignored_people uses");
  for (const sample of ["Dana Kim", "  dana   KIM ", "Sinéad  O'Connor"]) {
    check(`'${sample}'`, personNameKey(sample) === normalizePersonKey(sample));
  }

  // Already in the network, by address.
  await addContact(U, "Eli Park", "eli@northwind.example");
  // Already in the network under another address: offering them again would make a duplicate.
  await addContact(U, "Priya Raman", "priya@home.example");
  // Dismissed earlier.
  await db.insert(ignoredPeople).values({ userId: U, nameKey: "nate cole", displayName: "Nate Cole", reason: "rejected", context: "Named in an email" });

  await addEvent(U, "process_update", 1, [
    person("Dana Kim", "dana@northwind.example", "Technical Recruiter"),
    person("Eli Park", "eli@northwind.example"),
    person("Priya Raman", "priya@northwind.example"),
    person("Nate Cole", "nate@northwind.example"),
    person("Me Myself", "me@example.com"),
    person("Northwind Recruiting Team", "recruiting@northwind.example"),
    person("Nameless", null),
  ], { summary: "Northwind wants to schedule a phone screen" });
  await addEvent(U, "job_posting", 3, [person("Dana Kim", "dana@northwind.example", "Recruiter"), person("Lee Moss", "lee@acme.example", "Engineering Manager")], { summary: "Acme is hiring a staff engineer" });
  await addEvent(U, "news", 40, [person("Old Person", "old@acme.example")]);
  await addEvent(U, "job_posting", 2, [person("Gone Person", "gone@acme.example")], { dismissed: true });
  await addEvent(U, "other", 2, [person("Other Person", "other@acme.example")]);
  await addEvent(V, "job_posting", 1, [person("Vera Only", "vera@acme.example")]);
  await addEvent(W, "job_posting", 1, [person("Wren Only", "wren@acme.example")]);

  console.log("\nWho is offered");
  startQueryCount();
  const offered = await loadInboxPeople(U, NOW);
  const statements = stopQueryCount();
  check("the strangers the emails name, hiring update first", offered.map((p) => p.name).join(",") === "Dana Kim,Lee Moss", offered.map((p) => p.name).join(","));
  check("the newest event describes a person named twice", offered[0]!.summary === "Northwind wants to schedule a phone screen" && offered[0]!.title === "Technical Recruiter");
  check("each is keyed by a normalized address", offered[0]!.key === "dana@northwind.example" && offered[1]!.key === "lee@acme.example");
  check("someone already a contact by address is not offered", !offered.some((p) => p.name === "Eli Park"));
  check("someone already a contact by name is not offered", !offered.some((p) => p.name === "Priya Raman"));
  check("someone dismissed is not offered", !offered.some((p) => p.name === "Nate Cole"));
  check("the user's own address is not offered", !offered.some((p) => p.name === "Me Myself"));
  check("a mailbox is not offered", !offered.some((p) => p.name.includes("Team")));
  check("a person with no address is not offered", !offered.some((p) => p.name === "Nameless"));
  check("an event outside the window is not read", !offered.some((p) => p.name === "Old Person"));
  check("a dismissed event is not read", !offered.some((p) => p.name === "Gone Person"));
  check("an event of kind 'other' is not read", !offered.some((p) => p.name === "Other Person"));
  check("another account's people are never offered", !offered.some((p) => p.name === "Vera Only" || p.name === "Wren Only"));
  check("opted in, it costs at most four statements", statements <= 4, `${statements}: ${capturedQueries().map((q) => q.slice(0, 40)).join(" | ")}`);

  console.log("\nWhat leaves");
  const flat = JSON.stringify(offered);
  check("no quote", !flat.includes("quote"));
  check("no address inside any text field", !offered.some((p) => [p.name, p.title ?? "", p.summary].some((t) => t.includes("@"))));
  check("exactly the fields the strip draws", offered.every((p) => Object.keys(p).sort().join() === "at,key,kind,name,summary,title"));

  console.log("\nAn account that has not opted in");
  startQueryCount();
  const off = await loadInboxPeople(W, NOW);
  const offStatements = stopQueryCount();
  check("is offered nobody, even with events on file", off.length === 0);
  check("and it cost exactly one statement", offStatements === 1, String(offStatements));
  startQueryCount();
  await loadInboxPeople("smoke-eil-nobody", NOW);
  check("an account with nothing on file costs one statement", stopQueryCount() === 1);

  console.log("\nAnother account");
  const theirs = await loadInboxPeople(V, NOW);
  check("sees only its own", theirs.length === 1 && theirs[0]!.name === "Vera Only");

  console.log("\nA contact appearing removes the offer");
  await addContact(U, "Dana Kim", "dana@northwind.example");
  check("an address that now belongs to a contact", (await loadInboxPeople(U, NOW)).map((p) => p.name).join(",") === "Lee Moss");

  console.log("\nFinding one by key");
  check("a shown person is found", (await findInboxPerson(U, "lee@acme.example", NOW))?.name === "Lee Moss");
  check("an address nobody was offered is not", (await findInboxPerson(U, "stranger@acme.example", NOW)) === null);
  check("a resolved address is not", (await findInboxPerson(U, "eli@northwind.example", NOW)) === null);
  check("another account's key is not", (await findInboxPerson(U, "vera@acme.example", NOW)) === null);
  check("an empty key is not", (await findInboxPerson(U, "", NOW)) === null);
  check("an oversized key is not", (await findInboxPerson(U, "x".repeat(300), NOW)) === null);
  check("a non-string key is not", (await findInboxPerson(U, 42 as unknown as string, NOW)) === null);

  console.log("\nThe cap");
  const many = Array.from({ length: INBOX_SHOWN + 3 }, (_, i) => person(`Many${String.fromCharCode(65 + i)} Person`, `many${i}@big.example`));
  await addEvent(V, "process_update", 0, many);
  const shown = await loadInboxPeople(V, NOW);
  check(`${INBOX_SHOWN} are shown`, shown.length === INBOX_SHOWN, String(shown.length));
  const sixth = `many${INBOX_SHOWN}@big.example`;
  check("a person past the cap can still be found by key", (await findInboxPerson(V, sixth, NOW))?.key === sixth);
  check("and the search is bounded", INBOX_CANDIDATES >= INBOX_SHOWN + 3);

  // The pglite tier shares one database, and the sweep smoke counts the accounts that are armed.
  for (const u of [U, V, W]) {
    await db.delete(emailThreads).where(eq(emailThreads.userId, u));
    await db.delete(gmailConnections).where(eq(gmailConnections.userId, u));
    await db.delete(ignoredPeople).where(eq(ignoredPeople.userId, u));
  }
  await db.delete(contacts).where(inArray(contacts.userId, [U, V, W]));
  await db.update(userSettings).set({ emailIntelEnabled: 0 }).where(inArray(userSettings.userId, [U, V, W]));

  console.log("\nall inbox-load checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
