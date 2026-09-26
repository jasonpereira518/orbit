/**
 * A chat thread opens on its newest page, and earlier pages load on request.
 *
 * `getChatThread` used to load every active message of a thread, with every answer's
 * evidence and activity, on each open. Now it loads the newest page (`getEarlierChatMessages`
 * walks back from there). The properties that matter: walking back yields every message
 * exactly once and in order, even across rows that share a timestamp; a page never begins
 * with an answer whose question is on the page before; and a page's sent markers belong to
 * its own messages.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-chat-thread-paging.ts
 */
import "./smoke/_env";
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { chatMessages, chatThreads, contacts, interactions } from "../src/db/schema";
import { getChatThread, getEarlierChatMessages, listChatThreads } from "../src/actions/chat";
import { chatSendExternalId } from "../src/lib/chat-send";

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
  const [thread] = await db.insert(chatThreads).values({ userId: USER }).returning();
  const [contact] = await db.insert(contacts).values({ userId: USER, fullName: "Paged Person" }).returning();
  const base = Date.UTC(2026, 0, 1);
  // 75 question/answer pairs, one a minute; pair 40 shares ONE timestamp for both rows, so
  // the (created_at, id) tiebreak is exercised.
  const rows: Array<typeof chatMessages.$inferInsert> = [];
  for (let i = 0; i < 75; i++) {
    const q = new Date(base + i * 60_000);
    const a = i === 40 ? q : new Date(base + i * 60_000 + 1_000);
    rows.push({ threadId: thread!.id, userId: USER, role: "user", content: `q${i}`, createdAt: q });
    rows.push({ threadId: thread!.id, userId: USER, role: "assistant", content: `a${i}`, createdAt: a });
  }
  // One deactivated message (an old version), which must never appear.
  rows.push({ threadId: thread!.id, userId: USER, role: "assistant", content: "old version", isActive: false, createdAt: new Date(base + 5 * 60_000 + 2_000) });
  const inserted = await db.insert(chatMessages).values(rows).returning();
  const a10 = inserted.find((m) => m.content === "a10")!;
  await db.insert(interactions).values({
    userId: USER, contactId: contact!.id, interactionType: "email", source: "chat_send", direction: "out",
    externalId: chatSendExternalId(a10.id, contact!.id), interactionDate: new Date(),
  });

  const first = await getChatThread(thread!.id);
  check("a thread opens on a page, not the whole thread", first.messages.length <= 60 && first.messages.length >= 59, String(first.messages.length));
  check("that page starts on a question", first.messages[0]?.role === "user", first.messages[0]?.content);
  check("and ends on the newest message", first.messages.at(-1)?.content === "a74");
  check("the rest is counted, not sent", first.earlierCount + first.messages.length === 150, `${first.earlierCount} + ${first.messages.length}`);

  const all = [...first.messages];
  let earlier = first.earlierCount;
  let sentSeen: Record<string, unknown> = { ...first.sent };
  let pages = 1;
  while (earlier > 0 && pages < 10) {
    const page = await getEarlierChatMessages(thread!.id, all[0]!.id);
    check(`page ${pages + 1} starts on a question`, page.messages[0]?.role === "user", page.messages[0]?.content);
    all.unshift(...page.messages);
    sentSeen = { ...sentSeen, ...page.sent };
    earlier = page.earlierCount;
    pages++;
  }
  const contents = all.map((m) => m.content);
  const expected = Array.from({ length: 75 }, (_, i) => [`q${i}`, `a${i}`]).flat();
  // Rows sharing a timestamp have no natural order (the old whole-thread read was just as
  // arbitrary there); what paging must guarantee is that neither is lost nor repeated.
  const tieFree = (xs: string[]) => xs.filter((x) => x !== "q40" && x !== "a40");
  check("walking back yields every active message once", contents.length === 150 && new Set(contents).size === 150, `${contents.length} / ${new Set(contents).size}`);
  check("in order", JSON.stringify(tieFree(contents)) === JSON.stringify(tieFree(expected)), contents.slice(75, 90).join(","));
  check("including both rows that share a timestamp, side by side", Math.abs(contents.indexOf("q40") - contents.indexOf("a40")) === 1);
  check("never an inactive version", !contents.includes("old version"));
  check("the sent marker arrives with its own page", Boolean((sentSeen as Record<string, Record<string, string>>)[a10.id]?.[contact!.id]));
  check("an anchor from another thread returns nothing", (await getEarlierChatMessages(crypto.randomUUID(), all[5]!.id)).messages.length === 0);

  const threads = await listChatThreads();
  check("the thread rail is bounded", threads.length <= 200);

  await db.delete(chatThreads).where(eq(chatThreads.id, thread!.id));
  await db.delete(contacts).where(eq(contacts.id, contact!.id));
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll chat thread paging checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
