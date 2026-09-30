/**
 * Ranking the people in a network for an email event: where candidates come from, what is
 * left out, that accounts never mix, and that the answer is stable. PGlite, no network.
 * Run: npx tsx scripts/smoke-email-intel-rank.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { companies, contacts, emailThreads, targetCompanies, userGoals } from "../src/db/schema";
import { syncIdentitiesForContact } from "../src/lib/contact-identity";
import { loadRankContext, rankEventContacts, type RankableEvent } from "../src/lib/email-intel/rank";
import { upsertThreadResult } from "../src/lib/email-intel/store";

const U = "smoke-eik-u";
const V = "smoke-eik-v";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function addContact(
  userId: string,
  fullName: string,
  company: string | null,
  title: string | null,
  email: string | null,
  closenessTier: "inner" | "mid" | "outer" | null
) {
  const db = await getDb();
  const [row] = await db.insert(contacts).values({ userId, fullName, company, title, email, closenessTier }).returning();
  if (email) await syncIdentitiesForContact(userId, row!.id, { email }, "smoke");
  return row!.id;
}

async function main() {
  const db = await getDb();
  await db.delete(emailThreads).where(inArray(emailThreads.userId, [U, V]));
  await db.delete(targetCompanies).where(inArray(targetCompanies.userId, [U, V]));
  await db.delete(userGoals).where(inArray(userGoals.userId, [U, V]));
  await db.delete(contacts).where(inArray(contacts.userId, [U, V]));
  await db.delete(companies).where(inArray(companies.userId, [U, V]));

  const dana = await addContact(U, "Dana Kim", "Northwind, Inc.", "Technical Recruiter", "dana@northwind.example", "inner");
  const eli = await addContact(U, "Eli Park", "Northwind", "Payments Engineer", "eli@northwind.example", "mid");
  const fay = await addContact(U, "Fay Ortiz", "Northwind", "VP of Sales", null, "outer");
  const gus = await addContact(U, "Gus Lund", "Other Co", "Payments Engineer", null, "inner");
  const hal = await addContact(U, "Hal Moss", "Diner", "Head Chef", "hal@diner.example", null);
  const zed = await addContact(V, "Zed Vance", "Northwind", "Payments Engineer", "dana@northwind.example", "inner");

  const [northwind] = await db.insert(companies).values({ userId: U, name: "Northwind", nameNormalized: "northwind" }).returning();
  await db.insert(targetCompanies).values({ userId: U, companyId: northwind!.id, priority: 2 });
  await db.insert(userGoals).values({ userId: U, text: "land a payments engineering role" });

  const job: RankableEvent = {
    kind: "job_posting",
    company: "Northwind",
    role: "Staff Engineer, Payments",
    people: [
      { name: "Dana Kim", email: "DANA@northwind.example", title: "Technical Recruiter" },
      { name: "Unknown Person", email: "unknown@northwind.example", title: null },
    ],
    threadRowId: null,
  };

  console.log("\nA job at a company you know");
  const context = await loadRankContext(U);
  check("the context carries the user's goals and targets", context.goals.length === 1 && context.targetKeys.get("northwind") === 2);
  const wide = await rankEventContacts(U, job, { limit: 10, context });
  const ids = wide.map((r) => r.contactId);
  check("the recruiter on the thread comes first", ids[0] === dana, ids.join());
  check("the thread recruiter says why", wide[0]!.reasons.some((r) => r.code === "on_thread") && wide[0]!.reasons.some((r) => r.code === "seniority_recruiter"));
  check("she was also found through her company", wide[0]!.via.includes("thread") && wide[0]!.via.includes("company"));
  check("a matching engineer at the company outranks a VP with no link to the role", ids.indexOf(eli) < ids.indexOf(fay), ids.join());
  check("the VP at the company is still there", ids.includes(fay));
  check("an engineer elsewhere is found by their profile alone", ids.includes(gus) && wide.find((r) => r.contactId === gus)!.via.join() === "search");
  check("someone unrelated is left out", !ids.includes(hal));
  check("another account's contact never appears", !ids.includes(zed));
  check("the unresolved address does not become a candidate", ids.length === 4, ids.join());
  check("scores never increase down the list", wide.every((r, i) => i === 0 || wide[i - 1]!.score >= r.score));
  check("every row explains itself", wide.every((r) => r.reasons.length > 0 && r.bucket !== "skip"));
  check("the suffix in 'Northwind, Inc.' did not hide her company", wide[0]!.reasons.some((r) => r.code === "same_company"));

  console.log("\nLimits and stability");
  const top = await rankEventContacts(U, job, { context });
  check("the default is three", top.length === 3);
  check("and they are the top of the longer list", top.map((r) => r.contactId).join() === ids.slice(0, 3).join());
  check("the same call gives the same answer", JSON.stringify(await rankEventContacts(U, job, { limit: 10, context })) === JSON.stringify(wide));
  check("without a preloaded context it loads its own", (await rankEventContacts(U, job, { limit: 10 })).map((r) => r.contactId).join() === ids.join());

  console.log("\nThe company alone");
  const noPeople = await rankEventContacts(U, { ...job, people: [] }, { limit: 10, context });
  check("contacts at the company are found with nobody on the thread", noPeople.find((r) => r.contactId === dana)?.via.join() === "company");
  check("nobody is marked as on the thread", noPeople.every((r) => !r.reasons.some((x) => x.code === "on_thread")));

  console.log("\nCompany news");
  const news = await rankEventContacts(U, { kind: "news", company: "Northwind", role: null, people: [], threadRowId: null }, { limit: 10, context });
  check("a recruiter's seniority is not counted for news", news.find((r) => r.contactId === dana)!.reasons.every((r) => r.code !== "seniority_recruiter"));
  check("a leader's is", news.find((r) => r.contactId === fay)!.reasons.some((r) => r.code === "seniority_leader"));
  check("no role means no profile search", news.every((r) => !r.via.includes("search")));

  console.log("\nPeople on the thread the model did not name");
  const saved = await upsertThreadResult(U, {
    threadId: "rank-thread",
    lastMessageId: "rank-m1",
    subject: "Lunch",
    participants: ["hal@diner.example", "stranger@nowhere.example"],
    lastDirection: "in",
    decision: "classify",
    triageScore: 3,
    event: null,
  });
  check("the thread was stored", saved.changed);
  const [threadRow] = await db.select().from(emailThreads).where(eq(emailThreads.userId, U));
  const viaHeaders = await rankEventContacts(U, { kind: "event", company: null, role: null, people: [], threadRowId: threadRow!.id }, { context });
  check("an address on the headers makes that contact a candidate", viaHeaders.length === 1 && viaHeaders[0]!.contactId === hal && viaHeaders[0]!.via.join() === "thread", JSON.stringify(viaHeaders.map((r) => r.contactId)));
  const otherAccount = await rankEventContacts(V, { kind: "event", company: null, role: null, people: [], threadRowId: threadRow!.id }, { context: await loadRankContext(V) });
  check("another account cannot read this thread's participants", otherAccount.length === 0);

  console.log("\nNothing to go on");
  check("no company, role, people or thread is an empty answer", (await rankEventContacts(U, { kind: "news", company: null, role: null, people: [], threadRowId: null }, { context })).length === 0);
  check("an empty network is an empty answer", (await rankEventContacts("smoke-eik-nobody", job)).length === 0);

  await db.delete(emailThreads).where(inArray(emailThreads.userId, [U, V]));
  await db.delete(targetCompanies).where(inArray(targetCompanies.userId, [U, V]));
  await db.delete(userGoals).where(inArray(userGoals.userId, [U, V]));
  await db.delete(contacts).where(inArray(contacts.userId, [U, V]));
  await db.delete(companies).where(inArray(companies.userId, [U, V]));
  console.log("\nAll email-intel rank checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
