/**
 * The persisted half of citations: `persistAssistantTurn` stores exactly the cited evidence,
 * `getChatThread` returns it, and `getEvidenceSnippet` re-reads the LIVE source — scoped to
 * the user, and reporting "removed" for a source that no longer exists — rather than a copy
 * frozen at answer time. See `@/lib/chat-evidence`.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-chat-citations.ts
 */
import "./smoke/_env";
// These actions go through `requireUserId()`. With no Clerk keys AND NODE_ENV=development,
// that resolves to demo mode's `demo-user` — the identity seeded below.
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { chatMessages, chatThreads, contacts, interactions } from "../src/db/schema";
import { persistAssistantTurn } from "../src/lib/chat-persist";
import { getChatThread, getEvidenceSnippet } from "../src/actions/chat";

/** Object-key order is not part of the contract — jsonb round-trips reorder them. */
function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)).map(([k, vv]) => [k, norm(vv)]))
      : Array.isArray(v)
        ? v.map(norm)
        : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

const USER = "demo-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  const db = await getDb();
  await db.delete(chatThreads).where(eq(chatThreads.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const [contact] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Ada Lovelace", aiSummary: "Founder, ex-NASA." })
    .returning();
  const [foreignContact] = await db
    .insert(contacts)
    .values({ userId: "someone-else", fullName: "Not Yours" })
    .returning();
  const [interaction] = await db
    .insert(interactions)
    .values({
      userId: USER,
      contactId: contact!.id,
      interactionType: "coffee",
      interactionDate: new Date("2026-08-15T12:00:00Z"),
      rawNotes: "Talked about the Series A.",
    })
    .returning();
  const [thread] = await db.insert(chatThreads).values({ userId: USER }).returning();

  console.log("persisting");
  const evidence = {
    e1: { kind: "interaction" as const, sourceId: interaction!.id, contactId: contact!.id, date: "2026-08-15" },
    e2: { kind: "contact" as const, contactId: contact!.id },
  };
  const saved = await persistAssistantTurn(USER, thread!.id, null, "who do I know at Ramp?", {
    answer: "Ada joined in March [e1] and is a strong contact overall [e2].",
    recommendations: [],
    evidence,
  });
  check("a real message id came back", typeof saved.messageId === "string");

  const stored = await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, saved.messageId!) });
  check("evidence is stored exactly as given", sameJson(stored?.evidence, evidence), JSON.stringify(stored?.evidence));

  console.log("reading through getChatThread");
  const loaded = await getChatThread(thread!.id);
  const row = loaded.messages.find((m) => m.id === saved.messageId);
  check("the thread returns the evidence column", sameJson(row?.evidence, evidence), JSON.stringify(row?.evidence));

  console.log("getEvidenceSnippet: interaction");
  const snip = await getEvidenceSnippet(saved.messageId!, "e1");
  check("finds it", snip.found === true);
  if (snip.found && snip.kind === "interaction") {
    check("carries the interaction id, for the profile deep-link", snip.interactionId === interaction!.id);
    check("names the contact", snip.contactName === "Ada Lovelace");
    check("carries the date", snip.date === "2026-08-15");
    check("re-reads the LIVE note text, not a stored copy", snip.snippet === "Talked about the Series A.");
  }

  console.log("getEvidenceSnippet: contact-level");
  const contactSnip = await getEvidenceSnippet(saved.messageId!, "e2");
  check("finds it", contactSnip.found === true);
  if (contactSnip.found && contactSnip.kind === "contact") {
    check("names the contact", contactSnip.contactName === "Ada Lovelace");
    check("reads the live summary", contactSnip.snippet === "Founder, ex-NASA.");
  }

  console.log("what must fail");
  const missingId = await getEvidenceSnippet(saved.messageId!, "e99");
  check("an id never minted for this message is not found", missingId.found === false);

  const foreignMsg = await db
    .insert(chatMessages)
    .values({
      threadId: thread!.id,
      userId: "someone-else",
      role: "assistant",
      content: "x",
      evidence: { e1: { kind: "contact", contactId: foreignContact!.id } },
    })
    .returning();
  const forbidden = await getEvidenceSnippet(foreignMsg[0]!.id, "e1");
  check("a message that isn't this user's is refused, not just its contact", forbidden.found === false);

  console.log("a deleted source reads as removed, not as a stale echo");
  await db.delete(interactions).where(and(eq(interactions.id, interaction!.id), eq(interactions.userId, USER)));
  const afterDelete = await getEvidenceSnippet(saved.messageId!, "e1");
  check("the interaction citation is now not-found", afterDelete.found === false);
  const stillContact = await getEvidenceSnippet(saved.messageId!, "e2");
  check("the contact-level citation is unaffected — it never depended on the deleted row", stillContact.found === true);

  console.log("empty evidence (no citations survived) is the default, not a crash");
  const bare = await persistAssistantTurn(USER, thread!.id, "Thread", "a plain question", {
    answer: "A plain answer with no citations.",
    recommendations: [],
  });
  const bareRow = await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, bare.messageId!) });
  check("evidence defaults to an empty object, not null", JSON.stringify(bareRow?.evidence) === "{}");

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll chat citation checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
