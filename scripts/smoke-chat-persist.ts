/**
 * Pins who wins when a conversation is named (`persistAssistantTurn` in
 * `src/lib/chat-persist.ts`): the name it already has, then a written summary, then the old
 * cut of the first message.
 *
 * The rule that matters most is the first: a later turn must never rename a conversation out
 * from under the person, whatever a fresh summary would have said.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-chat-persist.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { chatMessages, chatThreads } from "../src/db/schema";
import { persistAssistantTurn, titleFromQuestion } from "../src/lib/chat-persist";

const USER = "smoke-chat-persist-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function newThread(title: string | null = null): Promise<string> {
  const db = await getDb();
  const [row] = await db.insert(chatThreads).values({ userId: USER, title }).returning();
  return row.id;
}

async function storedTitle(id: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.query.chatThreads.findFirst({ where: eq(chatThreads.id, id), columns: { title: true } });
  return row?.title ?? null;
}

const QUESTION = "What should I ask Olivia Brooks next time we speak about the Codex partnership rollout?";
const turn = { answer: "Here you go.", recommendations: [] };

async function main() {
  const db = await getDb();
  await db.delete(chatThreads).where(eq(chatThreads.userId, USER));

  console.log("A new conversation is named from its summary");
  {
    const id = await newThread();
    const saved = await persistAssistantTurn(USER, id, null, QUESTION, { ...turn, title: "Codex partnership prep" });
    check("the summary becomes the title", saved.title === "Codex partnership prep", String(saved.title));
    check("and is what is stored", (await storedTitle(id)) === "Codex partnership prep");
    check("not the truncated first message", saved.title !== titleFromQuestion(QUESTION));
  }

  console.log("\nA conversation that already has a name keeps it");
  {
    const id = await newThread("The name I chose");
    const saved = await persistAssistantTurn(USER, id, "The name I chose", "A completely different follow-up", {
      ...turn,
      title: "A summary that must not win",
    });
    check("the existing title is returned", saved.title === "The name I chose", String(saved.title));
    check("the existing title is what is stored", (await storedTitle(id)) === "The name I chose");
  }

  console.log("\nNo summary falls back to the first message, cut short");
  {
    const id = await newThread();
    const saved = await persistAssistantTurn(USER, id, null, QUESTION, turn);
    check("no title given -> the truncation", saved.title === titleFromQuestion(QUESTION), String(saved.title));
    check("it is stored", (await storedTitle(id)) === titleFromQuestion(QUESTION));

    const id2 = await newThread();
    const s2 = await persistAssistantTurn(USER, id2, null, QUESTION, { ...turn, title: null });
    check("an explicit null falls back too", s2.title === titleFromQuestion(QUESTION));

    const id3 = await newThread();
    const s3 = await persistAssistantTurn(USER, id3, null, QUESTION, { ...turn, title: "   " });
    check("a blank summary falls back rather than naming the chat nothing", s3.title === titleFromQuestion(QUESTION), JSON.stringify(s3.title));
  }

  console.log("\nA question with no thread saves nothing");
  {
    const saved = await persistAssistantTurn(USER, null, null, QUESTION, { ...turn, title: "Ignored" });
    check("no message id", saved.messageId === null);
    check("the existing title (none) is returned untouched", saved.title === null);
  }

  console.log("\nThe answer is stored alongside");
  {
    const id = await newThread();
    const saved = await persistAssistantTurn(USER, id, null, QUESTION, {
      answer: "Start with Ada.",
      recommendations: [],
      title: "Who to start with",
      activity: [{ id: "rank", kind: "rank", label: "Kept 1", status: "done", ms: 12 }],
    });
    const msg = await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, saved.messageId ?? "") });
    check("the assistant message is saved", msg?.content === "Start with Ada." && msg.role === "assistant");
    check("its activity is saved", Array.isArray(msg?.activity) && msg?.activity?.length === 1);
    check("the message id is returned", typeof saved.messageId === "string" && saved.messageId.length > 0);
  }

  await db.delete(chatThreads).where(eq(chatThreads.userId, USER));
}

main()
  .then(() => {
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nAll chat persistence checks passed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
