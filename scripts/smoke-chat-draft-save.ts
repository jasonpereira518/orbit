/**
 * A draft worked on in chat is kept on its answer (`src/lib/chat-draft-save.ts`).
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-chat-draft-save.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { chatMessages, chatThreads, contacts, type ChatRecommendation } from "../src/db/schema";
import { saveDraftEdit } from "../src/lib/chat-draft-save";
import { DRAFT_MAX_CHARS } from "../src/lib/chat-draft";

const ME = "smoke-draft-save-me";
const OTHER = "smoke-draft-save-other";

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
  await db.delete(chatThreads).where(inArray(chatThreads.userId, [ME, OTHER]));
  await db.delete(contacts).where(inArray(contacts.userId, [ME, OTHER]));

  const [ada] = await db.insert(contacts).values({ userId: ME, fullName: "Ada Lovelace" }).returning();
  const [grace] = await db.insert(contacts).values({ userId: ME, fullName: "Grace Hopper" }).returning();
  const [theirs] = await db.insert(contacts).values({ userId: OTHER, fullName: "Not Mine" }).returning();
  const [thread] = await db.insert(chatThreads).values({ userId: ME, title: "Intros" }).returning();
  const rec: ChatRecommendation = {
    contact_id: ada.id,
    recruiter_id: null,
    name: "Ada Lovelace",
    reason: "Knows the team",
    suggested_action: "Ask for an intro",
    draft_message: "Original draft",
  };
  const [msg] = await db
    .insert(chatMessages)
    .values({ threadId: thread.id, userId: ME, role: "assistant", content: "Here.", recommendations: [rec] })
    .returning();
  const [question] = await db
    .insert(chatMessages)
    .values({ threadId: thread.id, userId: ME, role: "user", content: "Who can intro me?" })
    .returning();
  const recs = async () =>
    (await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, msg.id), columns: { recommendations: true } }))
      ?.recommendations ?? [];

  check("an edit is saved on that person's entry", await saveDraftEdit(ME, msg.id, ada.id, "My edited draft"));
  let now = await recs();
  check("the edit is stored beside the original, which is untouched", now[0]?.edited_draft === "My edited draft" && now[0]?.draft_message === "Original draft", JSON.stringify(now));
  check("the rest of the entry is unchanged", now[0]?.reason === "Knows the team" && now.length === 1);

  check("a draft for a person the answer only placed inline adds an entry", await saveDraftEdit(ME, msg.id, grace.id, "Hi Grace"));
  now = await recs();
  check("named from the contact, not from the caller", now.length === 2 && now[1]?.name === "Grace Hopper" && now[1]?.edited_draft === "Hi Grace", JSON.stringify(now[1]));
  check("saving again updates that entry instead of adding another", (await saveDraftEdit(ME, msg.id, grace.id, "Hi Grace, again")) && (await recs()).length === 2);

  check("clearing the text clears the saved edit", (await saveDraftEdit(ME, msg.id, ada.id, "   ")) && (await recs())[0]?.edited_draft === null);
  await saveDraftEdit(ME, msg.id, ada.id, "x".repeat(DRAFT_MAX_CHARS + 500));
  check("a long draft is cut to the limit", (await recs())[0]?.edited_draft?.length === DRAFT_MAX_CHARS);

  check("another person's contact cannot be added to my answer", !(await saveDraftEdit(ME, msg.id, theirs.id, "nope")) && (await recs()).length === 2);
  check("another account cannot write to my answer", !(await saveDraftEdit(OTHER, msg.id, ada.id, "hijack")) && (await recs())[0]?.edited_draft !== "hijack");
  check("a question row is not an answer", !(await saveDraftEdit(ME, question.id, ada.id, "nope")));

  await db.delete(chatThreads).where(inArray(chatThreads.userId, [ME, OTHER]));
  await db.delete(contacts).where(inArray(contacts.userId, [ME, OTHER]));
}

main()
  .then(() => {
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nAll chat draft-save checks passed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
