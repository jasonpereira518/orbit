/**
 * Drafts written into a chat answer are editable in place (`src/lib/chat-draft-block.ts`):
 * the block format, how it is read out of an answer, how an edit rewrites it, the LinkedIn
 * note limit, and that saving an edit is a plain text rewrite (no model call).
 *
 * The first half is pure; the second runs against a throwaway PGlite database.
 * Run: npx tsx scripts/smoke-chat-draft-block.ts
 */
import "./smoke/_env";

import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { chatMessages, chatThreads } from "../src/db/schema";
import {
  LINKEDIN_NOTE_MAX,
  cleanDraftEdit,
  draftBlocksIn,
  draftContactIdsIn,
  formatDraftBlock,
  mayUseNote,
  noteStatus,
  noteStatusText,
  normalizeDraftBlocks,
  replaceDraftBlock,
} from "../src/lib/chat-draft-block";
import { directivesAsText, expandLists, settledText, splitDirectives } from "../src/lib/chat-directives";
import { saveDraftBlockEdit } from "../src/lib/chat-draft-save";

const ME = "smoke-draft-block-me";
const OTHER = "smoke-draft-block-other";
const PRIYA = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const EMAIL = `I wrote you a short one.

\`\`\`draft email to=${PRIYA}
Subject: Quick intro
 
Hi Priya,

Thanks for the talk. Coffee next week?
\`\`\`

Want it warmer?`;
const NOTE = `\`\`\`draft linkedin to=${PRIYA}
Hi Priya, loved your talk on pricing. Would be great to connect.
\`\`\``;

async function main() {
  console.log("Reading a draft out of an answer");
  const [email] = draftBlocksIn(EMAIL);
  check("an email block has a channel, recipient, subject and body", email?.channel === "email" && email.contactId === PRIYA && email.subject === "Quick intro" && email.body.startsWith("Hi Priya,") && email.closed, JSON.stringify(email));
  const [note] = draftBlocksIn(NOTE);
  check("a LinkedIn block is one note with no subject", note?.channel === "linkedin" && note.subject === "" && note.body.startsWith("Hi Priya, loved"), JSON.stringify(note));
  check("a recipient that is not a uuid is ignored", draftBlocksIn("```draft email to=priya\nSubject: x\n\nbody\n```")[0]?.contactId === null);
  check("an email with no Subject line still reads (empty subject, whole body)", (() => { const b = draftBlocksIn("```draft email\nJust the body\n```")[0]; return b?.subject === "" && b.body === "Just the body"; })());
  check("an unfinished block reads as open", (() => { const b = draftBlocksIn("```draft email\nSubject: Hi\n\nHalf a bo")[0]; return b && !b.closed && b.subject === "Hi" && b.body === "Half a bo"; })());
  check("two blocks are numbered in order", draftBlocksIn(`${EMAIL}\n\n${NOTE}`).map((b) => `${b.index}:${b.channel}`).join() === "0:email,1:linkedin");
  check("a draft shown inside another code fence is just text", draftBlocksIn("```\n```draft email\nSubject: x\n\nbody\n```\n```").length === 0);
  check("an ordinary code fence is not a draft", draftBlocksIn("```js\nconst a = 1\n```").length === 0);
  check("the recipients named are listed", draftContactIdsIn(`${EMAIL}\n${NOTE}`).join() === PRIYA);

  console.log("\nIn the answer's segments");
  const segs = splitDirectives(EMAIL);
  check("prose, the draft, prose", segs.map((s) => s.kind).join() === "text,draft,text", segs.map((s) => s.kind).join());
  const draft = segs.find((s) => s.kind === "draft");
  check("the draft segment carries its parts and its place", draft?.kind === "draft" && draft.index === 0 && draft.subject === "Quick intro" && draft.channel === "email");
  check("storing the answer keeps the block", expandLists(EMAIL, {}).includes("```draft email to=") && expandLists(EMAIL, {}).includes("Coffee next week?"));
  check("copying the answer keeps the block", directivesAsText(EMAIL, () => undefined).includes("Subject: Quick intro"));
  check("a half-typed opening fence is held back while streaming", settledText("Here you go\n```dra") === "Here you go\n" && settledText("Here\n```") === "Here\n");
  check("a finished opening fence is not held back", settledText("Here\n```draft email").endsWith("```draft email"));
  check("streaming: an open block is a draft segment that is not closed", (() => { const d = splitDirectives("Hi\n```draft linkedin\nHello Pri", { streaming: true }).find((s) => s.kind === "draft"); return d?.kind === "draft" && !d.closed && d.body === "Hello Pri"; })());

  console.log("\nEditing rewrites the text");
  const edited = replaceDraftBlock(`${EMAIL}\n\n${NOTE}`, 1, { body: "Hi Priya, short and edited." })!;
  const after = draftBlocksIn(edited);
  check("only the targeted block changed", after[0]?.body === email!.body && after[1]?.body === "Hi Priya, short and edited.");
  check("recipient and channel are kept", after[1]?.contactId === PRIYA && after[1]?.channel === "linkedin");
  check("the prose around the blocks is untouched", edited.startsWith("I wrote you a short one.") && edited.includes("Want it warmer?"));
  const reSubject = replaceDraftBlock(EMAIL, 0, { subject: "  A new\n subject ", body: "New body" })!;
  check("an email edit changes subject and body, the subject on one line", draftBlocksIn(reSubject)[0]?.subject === "A new subject" && draftBlocksIn(reSubject)[0]?.body === "New body");
  check("there is no such block: nothing to rewrite", replaceDraftBlock(EMAIL, 3, { body: "x" }) === null && replaceDraftBlock("no draft here", 0, { body: "x" }) === null);
  check("an empty draft is not stored", replaceDraftBlock(EMAIL, 0, { body: "  \n " }) === null && cleanDraftEdit("email", { body: "" }) === null);
  check("fence lines typed into a draft cannot close it early", (() => { const t = replaceDraftBlock(EMAIL, 0, { body: "before\n```\nafter" })!; return draftBlocksIn(t).length === 1 && draftBlocksIn(t)[0]!.body.includes("after"); })());
  check("an unreadable edit shape is refused, not thrown", replaceDraftBlock(EMAIL, 0, { body: 42 as unknown as string }) === null);
  check("a subject is cut to 200", Array.from(draftBlocksIn(replaceDraftBlock(EMAIL, 0, { subject: "s".repeat(500), body: "b" })!)[0]!.subject).length === 200);
  check("formatting then reading round-trips", (() => { const f = formatDraftBlock({ channel: "email", contactId: PRIYA, subject: "S", body: "line one\n\nline two" }); const b = draftBlocksIn(f)[0]!; return b.subject === "S" && b.body === "line one\n\nline two" && b.contactId === PRIYA; })());

  console.log("\nWhat the server keeps of a recipient");
  const known = new Set([PRIYA]);
  const kept = normalizeDraftBlocks(EMAIL, known);
  check("an offered recipient stays", draftBlocksIn(kept)[0]?.contactId === PRIYA);
  const forged = normalizeDraftBlocks(`\`\`\`draft email to=${STRANGER}\nSubject: x\n\nbody\n\`\`\``, known);
  check("a recipient the server never offered is dropped, the draft stays", draftBlocksIn(forged)[0]?.contactId === null && draftBlocksIn(forged)[0]?.body === "body");
  check("a block that never closed is closed", draftBlocksIn(normalizeDraftBlocks("```draft linkedin\nHello", known))[0]?.closed === true);
  check("text without drafts passes through untouched", normalizeDraftBlocks("just prose", known) === "just prose");

  console.log("\nThe LinkedIn limit");
  const exactly = "a".repeat(LINKEDIN_NOTE_MAX);
  check("the limit is LinkedIn's free-account 200", LINKEDIN_NOTE_MAX === 200);
  check("exactly 200 is within the limit", !noteStatus(exactly).over && noteStatus(exactly).remaining === 0);
  check("201 is over by one", noteStatus(exactly + "a").over && noteStatus(exactly + "a").remaining === -1);
  check("surrounding whitespace is not counted", noteStatus(`  ${exactly}\n`).over === false);
  check("an emoji is one character, not two", noteStatus("👋".repeat(200)).over === false && noteStatus("👋".repeat(201)).over === true);
  check("a screen reader hears how far over, or how many are left", noteStatusText(noteStatus(exactly + "aaaaa")) === "5 over LinkedIn’s 200-character limit" && noteStatusText(noteStatus("hello")) === "195 of 200 characters left");
  check("an over-limit note may not be used without the go-ahead", (() => { const g = mayUseNote(exactly + "aaa", false); return !g.ok && g.over === 3; })());
  check("with the go-ahead it may", mayUseNote(exactly + "aaa", true).ok);
  check("a note within the limit never needs one", mayUseNote("short", false).ok);

  console.log("\nSaving an edit (database)");
  const db = await getDb();
  await db.delete(chatThreads).where(inArray(chatThreads.userId, [ME, OTHER]));
  const [thread] = await db.insert(chatThreads).values({ userId: ME, title: "Drafts" }).returning();
  const [msg] = await db
    .insert(chatMessages)
    .values({ threadId: thread.id, userId: ME, role: "assistant", content: `${EMAIL}\n\n${NOTE}` })
    .returning();
  const [question] = await db
    .insert(chatMessages)
    .values({ threadId: thread.id, userId: ME, role: "user", content: "```draft email\nSubject: q\n\nq\n```" })
    .returning();
  const content = async () => (await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, msg.id), columns: { content: true } }))!.content;

  const first = await saveDraftBlockEdit(ME, msg.id, 0, { subject: "Edited subject", body: "Edited body" });
  check("an edit is saved and reports what was stored", first.saved && first.subject === "Edited subject" && first.body === "Edited body", JSON.stringify(first));
  const stored = await content();
  check("the stored answer carries the edit, the other draft and the prose untouched", draftBlocksIn(stored)[0]?.body === "Edited body" && draftBlocksIn(stored)[1]?.body === note!.body && stored.startsWith("I wrote you a short one."));
  check("saving the same text again is a no-op that still succeeds", (await saveDraftBlockEdit(ME, msg.id, 0, { subject: "Edited subject", body: "Edited body" })).saved);
  check("the LinkedIn note saves, over the limit too (flagged in the editor, not refused)", (await saveDraftBlockEdit(ME, msg.id, 1, { body: "n".repeat(LINKEDIN_NOTE_MAX + 40) })).saved && noteStatus(draftBlocksIn(await content())[1]!.body).over);
  check("an empty draft is not saved", !(await saveDraftBlockEdit(ME, msg.id, 0, { subject: "s", body: "   " })).saved && draftBlocksIn(await content())[0]?.body === "Edited body");
  check("a block that is not there is not saved", !(await saveDraftBlockEdit(ME, msg.id, 5, { body: "x" })).saved);
  check("another account cannot write to my answer", !(await saveDraftBlockEdit(OTHER, msg.id, 0, { body: "hijack" })).saved && !(await content()).includes("hijack"));
  check("a question row is not an answer", !(await saveDraftBlockEdit(ME, question.id, 0, { body: "nope" })).saved);

  console.log("\nWiring (source shape)");
  const save = readFileSync("src/lib/chat-draft-save.ts", "utf8");
  check("saving an edit makes no model call", !/@\/lib\/ai\b|@\/lib\/ai-/.test(save) && !/refine|complete(Json)?\(/.test(save.slice(save.indexOf("saveDraftBlockEdit"))));
  const send = readFileSync("src/actions/chat-send.ts", "utf8");
  check("a draft block's addressee may be mailed, through the same checked path", send.includes("draftContactIdsIn(message.content"));
  const route = readFileSync("src/app/api/chat/route.ts", "utf8");
  check("the stored answer's recipients are checked against what the server offered", route.includes("normalizeDraftBlocks(unblocked"));
  const prompt = readFileSync("src/lib/ai.ts", "utf8");
  check("the model is told the block format, with the shared note limit", prompt.includes("draft email to=<id>") && prompt.includes("draft linkedin to=<id>") && prompt.includes("at most ${LINKEDIN_NOTE_MAX} characters"));
  check("the live stream scrubs draft blocks", route.includes("draftScrub.push(redactor.push(delta))"));

  await db.delete(chatThreads).where(inArray(chatThreads.userId, [ME, OTHER]));
}

main()
  .then(() => {
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nAll chat draft block checks passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
