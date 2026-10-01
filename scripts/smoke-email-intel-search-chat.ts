/**
 * What the user's mail looks like to chat: found by `search_notes`, cited as `[eN]`, shown in
 * the source chip, and gone when the feature is off. PGlite, no network.
 * Run: npx tsx scripts/smoke-email-intel-search-chat.ts
 */
import "./smoke/_env";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, emailEvents, emailThreads, interactions, memoryChunks, userSettings } from "../src/db/schema";
import { EvidenceSnippetBody } from "../src/components/chat/source-chip";
import { createEvidenceLedger, renderNotePassages, type EvidenceSource } from "../src/lib/chat-evidence";
import { loadEvidenceSnippet } from "../src/lib/chat-evidence-snippet";
import { extractNotePassages } from "../src/lib/chat-gather";
import { syncIdentitiesForContact } from "../src/lib/contact-identity";
import { backfillMemoryChunks } from "../src/lib/memory-backfill";
import { upsertThreadResult } from "../src/lib/email-intel/store";
import { ORBIT_TOOLS } from "../src/lib/tools/definitions";
import { runTool, toolsFor, type OrbitTool } from "../src/lib/tools/registry";
import { ensureUserSettings } from "../src/lib/user-settings";

const U = "smoke-eic-u";
const V = "smoke-eic-v";
const ALL = [U, V];
const DAY = 86_400_000;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  const db = await getDb();
  const clean = async () => {
    await db.delete(memoryChunks).where(inArray(memoryChunks.userId, ALL));
    await db.delete(emailThreads).where(inArray(emailThreads.userId, ALL));
    await db.delete(interactions).where(inArray(interactions.userId, ALL));
    await db.delete(contacts).where(inArray(contacts.userId, ALL));
  };
  await clean();
  for (const u of ALL) await ensureUserSettings(u);
  await db.update(userSettings).set({ emailIntelEnabled: 1 }).where(inArray(userSettings.userId, ALL));

  const [dana] = await db.insert(contacts).values({ userId: U, fullName: "Dana Kim", email: "dana@northwind.example" }).returning();
  await syncIdentitiesForContact(U, dana!.id, { email: "dana@northwind.example" }, "smoke");
  const [note] = await db
    .insert(interactions)
    .values({ userId: U, contactId: dana!.id, interactionType: "coffee", interactionDate: new Date(Date.now() - 20 * DAY), rawNotes: "Coffee with Dana, talked about payments infrastructure and her team." })
    .returning();

  await upsertThreadResult(U, { threadId: "eic-1", lastMessageId: "m1", subject: "x", participants: [], lastDirection: "in", decision: "classify", triageScore: 3, event: null });
  const [thread] = await db.select().from(emailThreads).where(eq(emailThreads.threadId, "eic-1"));
  const [event] = await db
    .insert(emailEvents)
    .values({
      userId: U,
      threadRowId: thread!.id,
      source: "ai",
      kind: "process_update",
      stage: "screening",
      company: "Northwind",
      role: "Staff Engineer",
      occurredAt: new Date(Date.now() - DAY),
      summary: "Northwind wants to schedule a phone screen for the Staff Engineer role",
      evidenceQuote: "Can you do Thursday at 2pm for a phone screen?",
      confidence: 0.9,
      people: [{ name: "Dana Kim", email: "dana@northwind.example", title: "Technical Recruiter" }],
      asks: ["Reply with your availability"],
    })
    .returning();

  console.log("\nIndexed by the same sweep as the notes");
  const sweep = await backfillMemoryChunks(U);
  check("the note and the email are both indexed", sweep.indexed === 1 && sweep.emailEvents === 1, JSON.stringify(sweep));
  check("nothing is left waiting", sweep.remaining === 0);
  check("a second sweep has nothing to do", (await backfillMemoryChunks(U)).emailEvents === 0);

  console.log("\nsearch_notes");
  const tool = ORBIT_TOOLS.find((t) => t.name === "search_notes") as OrbitTool;
  const search = async (query: string, userId = U) =>
    (await runTool(tool, userId, { query, limit: 6 }, { surface: "chat", scopes: ["read"] })) as Array<Record<string, unknown>>;
  const mail = await search("phone screen Northwind");
  const mailRow = mail.find((r) => r.sourceId === event!.id);
  check("finds what the email said", Boolean(mailRow) && mailRow!.kind === "email_event", JSON.stringify(mail));
  check("dated by the email", mailRow!.date === new Date(event!.occurredAt).toISOString().slice(0, 10));
  check("and names the person it concerns", Array.isArray(mailRow!.contactIds) && (mailRow!.contactIds as string[]).includes(dana!.id));
  check("with a readable snippet and no address", typeof mailRow!.snippet === "string" && !(mailRow!.snippet as string).includes("@"));
  const notes = await search("payments infrastructure coffee");
  check("still finds the person's own notes", notes.some((r) => r.sourceId === note!.id && r.kind === "interaction"));
  check("another account finds none of it", (await search("phone screen Northwind", V)).length === 0);
  check("the tool says it searches mail too", tool.description.includes("email_event") && tool.description.toLowerCase().includes("email"));
  check("and stays off the MCP surface, where note text is not allowed to fan out", !toolsFor(ORBIT_TOOLS, "mcp", ["read", "write"]).some((t) => t.name === "search_notes"));

  console.log("\nCited");
  const picked = extractNotePassages([{ call: { name: "search_notes", args: {} }, content: "", ok: true, repeated: false, result: [...mail, ...notes, { kind: "note_batch", sourceId: "x", snippet: "a batch", contactIds: [] }] }] as never);
  check("an email passage is citable, like a note", picked.some((p) => p.kind === "email_event" && p.sourceId === event!.id));
  check("a note still is", picked.some((p) => p.kind === "interaction" && p.sourceId === note!.id));
  check("a passage with no single dated source still is not", !picked.some((p) => p.sourceId === "x"));
  check("a failed lookup contributes nothing", extractNotePassages([{ call: { name: "search_notes", args: {} }, content: "", ok: false, repeated: false, result: mail }] as never).length === 0);

  const ledger = createEvidenceLedger();
  const lines = renderNotePassages(
    [
      { sourceId: note!.id, contactId: dana!.id, date: "2026-03-02", snippet: "Coffee with Dana" },
      { kind: "email_event", sourceId: event!.id, contactId: dana!.id, date: "2026-09-29", snippet: "Northwind wants a phone screen\nwith\tcontrol characters" },
      { kind: "email_event", sourceId: event!.id, contactId: dana!.id, date: "2026-09-29", snippet: "the same email again" },
    ],
    ledger
  );
  check("a note reads exactly as it always has", lines[0] === "- [e1] 2026-03-02: Coffee with Dana");
  check("an email says where it came from", lines[1]!.startsWith("- [e2] 2026-09-29, from your email: Northwind wants a phone screen"));
  check("the same email is the same citation", lines[2]!.startsWith("- [e2] "));
  check("each passage is one line", lines.every((l) => !l.includes("\n")));
  check("an email and a note with the same id are different sources", createEvidenceLedger().mint({ kind: "email_event", sourceId: "s", contactId: null, date: null }) === "e1" && (() => { const l = createEvidenceLedger(); const a = l.mint({ kind: "interaction", sourceId: "s", contactId: null, date: null }); const b = l.mint({ kind: "email_event", sourceId: "s", contactId: null, date: null }); return a !== b; })());

  console.log("\nThe chip");
  const emailSource: EvidenceSource = { kind: "email_event", sourceId: event!.id, contactId: dana!.id, date: "2026-09-29" };
  const snippet = await loadEvidenceSnippet(U, emailSource);
  check("opens on the email", snippet.found && snippet.kind === "email_event" && snippet.contactName === "Dana Kim" && snippet.contactId === dana!.id);
  check("with the summary, the day and the quote", snippet.found && snippet.kind === "email_event" && snippet.snippet.includes("phone screen") && snippet.date === new Date(event!.occurredAt).toISOString().slice(0, 10) && snippet.quote === "Can you do Thursday at 2pm for a phone screen?");
  const html = snippet.found ? renderToStaticMarkup(React.createElement(EvidenceSnippetBody, { snippet })) : "";
  check("drawn with a way to the profile, and no address", html.includes(`/contacts/${dana!.id}`) && html.includes("Email") && html.includes("In the email") && !html.includes("@"));
  check("without a contact it says it is from the email and links nowhere", (() => { const h = renderToStaticMarkup(React.createElement(EvidenceSnippetBody, { snippet: { found: true, kind: "email_event", contactId: null, contactName: null, date: "2026-09-29", snippet: "x y", quote: null } })); return h.includes("From your email") && !h.includes("/contacts/") && !h.includes("In the email"); })());
  const note1 = await loadEvidenceSnippet(U, { kind: "interaction", sourceId: note!.id, contactId: dana!.id, date: "2026-03-02" });
  check("a note's citation opens as it did", note1.found && note1.kind === "interaction" && note1.interactionType === "coffee" && note1.snippet.includes("payments infrastructure"));
  const contact1 = await loadEvidenceSnippet(U, { kind: "contact", contactId: dana!.id });
  check("so does a contact's", contact1.found && contact1.kind === "contact" && contact1.contactName === "Dana Kim");
  check("another account sees none of them", !(await loadEvidenceSnippet(V, emailSource)).found && !(await loadEvidenceSnippet(V, { kind: "interaction", sourceId: note!.id, contactId: null, date: null })).found);
  check("a stored id that is not a uuid reads as removed", !(await loadEvidenceSnippet(U, { kind: "email_event", sourceId: "not-a-uuid", contactId: null, date: null })).found);

  console.log("\nWhen the mail goes");
  await db.update(emailEvents).set({ dismissedAt: new Date() }).where(eq(emailEvents.id, event!.id));
  check("a dismissed email's citation reads as removed", !(await loadEvidenceSnippet(U, emailSource)).found);
  await db.update(emailEvents).set({ dismissedAt: null }).where(eq(emailEvents.id, event!.id));
  check("and returns with it", (await loadEvidenceSnippet(U, emailSource)).found);
  await db.update(userSettings).set({ emailIntelEnabled: 0 }).where(eq(userSettings.userId, U));
  check("switched off, an older answer's citation reads as removed", !(await loadEvidenceSnippet(U, emailSource)).found);
  await backfillMemoryChunks(U);
  check("and the sweep removes it from search", !(await search("phone screen Northwind")).some((r) => r.sourceId === event!.id));
  check("while the person's own notes remain", (await search("payments infrastructure coffee")).some((r) => r.sourceId === note!.id));

  await clean();
  await db.update(userSettings).set({ emailIntelEnabled: 0 }).where(inArray(userSettings.userId, ALL));
  console.log("\nall email-intel search-chat checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
