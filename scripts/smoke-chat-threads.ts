/**
 * Renaming, pinning and searching saved conversations (`src/lib/chat-threads.ts`), and the
 * rule that a rename survives later answers.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-chat-threads.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { chatMessages, chatThreads } from "../src/db/schema";
import { PINNED_THREADS_MAX, pinThread, renameThread, searchThreads, snippetAround } from "../src/lib/chat-threads";
import { persistAssistantTurn } from "../src/lib/chat-persist";
import { threadsAfterAnswer } from "../src/lib/chat-answer-landed";

const ME = "smoke-chat-threads-me";
const OTHER = "smoke-chat-threads-other";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function thread(userId: string, title: string | null, messages: string[] = []): Promise<string> {
  const db = await getDb();
  const [row] = await db.insert(chatThreads).values({ userId, title }).returning();
  for (const content of messages) {
    await db.insert(chatMessages).values({ threadId: row.id, userId, role: "user", content });
  }
  return row.id;
}
async function stored(id: string) {
  const db = await getDb();
  return db.query.chatThreads.findFirst({ where: eq(chatThreads.id, id) });
}

async function main() {
  const db = await getDb();
  await db.delete(chatThreads).where(inArray(chatThreads.userId, [ME, OTHER]));

  console.log("Rename");
  {
    const id = await thread(ME, "Codex partnership prep");
    const before = (await stored(id))!.updatedAt.getTime();
    check("stores the trimmed, single-spaced title", (await renameThread(ME, id, "  Olivia   intro  ")) === "Olivia intro");
    check("and it is what is saved", (await stored(id))?.title === "Olivia intro");
    check("a rename is not activity: updated_at is untouched", (await stored(id))!.updatedAt.getTime() === before);
    check("a blank title is refused", (await renameThread(ME, id, "   ")) === null && (await stored(id))?.title === "Olivia intro");
    check("a long title is cut to the limit", (await renameThread(ME, id, "x".repeat(300)))?.length === 120);
    await renameThread(ME, id, "My name for it");
    const saved = await persistAssistantTurn(ME, id, "My name for it", "A follow-up", {
      answer: "Here you go.",
      recommendations: [],
      title: "A summary the model wrote",
    });
    check("a later answer does not rename it back", saved.title === "My name for it" && (await stored(id))?.title === "My name for it", String(saved.title));

    const theirs = await thread(OTHER, "Theirs");
    check("another person's thread is not renamed", (await renameThread(ME, theirs, "Mine now")) === null && (await stored(theirs))?.title === "Theirs");
  }

  console.log("\nPin");
  {
    const id = await thread(ME, "Pin me");
    const pinned = await pinThread(ME, id, true);
    check("pinning stamps pinned_at", pinned.ok && (await stored(id))?.pinnedAt instanceof Date);
    const unpinned = await pinThread(ME, id, false);
    check("unpinning clears it", unpinned.ok && (await stored(id))?.pinnedAt === null);
    const theirs = await thread(OTHER, "Theirs to pin");
    const refused = await pinThread(ME, theirs, true);
    check("another person's thread is not pinned", !refused.ok && (await stored(theirs))?.pinnedAt === null);

    for (let i = 0; i < PINNED_THREADS_MAX; i++) await pinThread(ME, await thread(ME, `Pinned ${i}`), true);
    const over = await pinThread(ME, id, true);
    check("the pin limit is enforced", !over.ok && over.reason === "limit");
    check("unpinning still works at the limit", (await pinThread(ME, id, false)).ok);

    const moved = threadsAfterAnswer(
      [{ id: "a", title: "A", createdAt: new Date(0), updatedAt: new Date(0), pinnedAt: new Date(1) }],
      "a",
      "A",
      new Date()
    ) as Array<{ pinnedAt?: Date }>;
    check("an answer landing keeps the thread pinned in the list", moved[0].pinnedAt instanceof Date);
  }

  console.log("\nSearch");
  {
    await thread(ME, "Fundraising plan", ["Who can introduce me to Sequoia?"]);
    await thread(ME, "Hiring", ["Who do I know that has hired a founding engineer in Boston recently, ideally at a seed stage company?"]);
    await thread(ME, null, ["an untitled chat about Sequoia"]);
    await thread(OTHER, "Sequoia notes", ["Sequoia Sequoia"]);
    const byTitle = await searchThreads(ME, "fundraising");
    check("matches a title, any case", byTitle.length === 1 && byTitle[0].title === "Fundraising plan", JSON.stringify(byTitle));
    const byMessage = await searchThreads(ME, "sequoia");
    check("matches message text, and only this person's titled chats", byMessage.length === 1 && byMessage[0].title === "Fundraising plan", JSON.stringify(byMessage));
    check("a message match carries a snippet", Boolean(byMessage[0]?.snippet?.includes("Sequoia")), String(byMessage[0]?.snippet));
    check("a title-only match has no snippet", byTitle[0]?.snippet === null);
    const long = await searchThreads(ME, "founding engineer");
    check("a long message is cut around the match", Boolean(long[0]?.snippet?.endsWith("…") && long[0].snippet.includes("founding engineer") && long[0].snippet.length < 100), String(long[0]?.snippet));
    check("a one-letter query returns nothing", (await searchThreads(ME, "s")).length === 0);
    check("% and _ are literal, not wildcards", (await searchThreads(ME, "%%")).length === 0 && (await searchThreads(ME, "__")).length === 0);
    check("snippetAround flattens line breaks", snippetAround("one\n\ntwo three", "two") === "one two three");
  }

  await db.delete(chatThreads).where(inArray(chatThreads.userId, [ME, OTHER]));
}

main()
  .then(() => {
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nAll chat thread checks passed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
