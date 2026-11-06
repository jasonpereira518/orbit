/**
 * Chat import preview + chunked staging (pglite). Exercises the lib behind
 * `src/actions/chat-imports.ts` directly — the actions only add `requireUserId` and the
 * refusal wrapper. Covers: the feature gate, identifier auto-link, ambiguous names, the
 * owner (saved self names, iMessage "Me"), the null estimate with no AI key, staging (begin,
 * contiguous appends, row validation, ownership, start, append-after-start), self-name
 * persistence, the abandoned-staging sweep, and `conversationToRows`.
 *
 * Run: npx tsx scripts/smoke-chat-import-actions.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-chat-actions";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-chat-actions";

import { isDeepStrictEqual } from "node:util";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contactIdentities,
  contacts,
  imports,
  importJobRows,
  interactions,
  userSettings,
  type ChatConversationRowPayload,
} from "../src/db/schema";
import { runImportJobById } from "../src/lib/import-job-dispatch";
import { conversationKey, sessionExternalId } from "../src/lib/conversations/sessions";
import { claimIdentities } from "../src/lib/contact-identity";
import { identityKeysFor } from "../src/lib/duplicates";
import { ensureUserSettings } from "../src/lib/user-settings";
import { resumeStalledImports } from "../src/lib/import-stall";
import {
  appendStagedRows,
  beginStaging,
  buildChatPreview,
  startStaged,
  sweepAbandonedStaging,
  type ChatPreviewConversation,
} from "../src/lib/chat-import-preview";
import { conversationToRows } from "../src/lib/conversations/to-rows";
import type { Conversation } from "../src/lib/conversations/types";

const USER = "smoke-chat-actions-user";
const OTHER = "smoke-chat-actions-other";
const LIVE = { surfaceLive: true };

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function rejects(label: string, fn: () => Promise<unknown>) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  check(label, threw, "expected a refusal");
}

async function reset() {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(interactions).where(eq(interactions.userId, u));
    await db.delete(importJobRows).where(eq(importJobRows.userId, u));
    await db.delete(imports).where(eq(imports.userId, u));
    await db.delete(contactIdentities).where(eq(contactIdentities.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
    await db.delete(userSettings).where(eq(userSettings.userId, u));
    await ensureUserSettings(u);
  }
}

async function addContact(fullName: string, phone?: string) {
  const db = await getDb();
  const [c] = await db.insert(contacts).values({ userId: USER, fullName }).returning();
  if (phone) await claimIdentities(USER, c.id, identityKeysFor({ phone }));
  return c.id;
}

function previewConv(
  key: string,
  source: "whatsapp" | "imessage",
  participants: Array<{ key: string; phoneE164?: string | null }>,
  isGroup = false,
): ChatPreviewConversation {
  return {
    key,
    source,
    title: key,
    isGroup,
    participants: participants.map((p) => ({
      key: p.key,
      displayName: p.key,
      phoneE164: p.phoneE164 ?? null,
      email: null,
    })),
    messageCount: 10,
    chars: 4_000,
    firstAt: "2025-01-01T10:00:00.000Z",
    lastAt: "2025-01-02T10:00:00.000Z",
  };
}

function row(over: Partial<ChatConversationRowPayload> = {}): ChatConversationRowPayload {
  return {
    kind: "chat_conversation",
    source: "whatsapp",
    conversationKey: "abc123",
    isGroup: false,
    title: "Sam Rivera",
    participant: { key: "Sam Rivera", displayName: "Sam Rivera", phoneE164: null, email: null },
    resolvedContactId: null,
    createIfUnmatched: true,
    sessions: [
      {
        startAt: "2025-01-10T10:00:00.000Z",
        endAt: "2025-01-10T10:20:00.000Z",
        messageCount: 2,
        direction: "in",
        transcript: "[2025-01-10 10:00 Sam Rivera] hi\n[2025-01-10 10:20 Me] hey",
      },
    ],
    ...over,
  };
}

function conversation(isGroup: boolean): Conversation {
  const others = isGroup ? ["Sam Rivera", "Ana Ruiz"] : ["Sam Rivera"];
  const participants = [
    { key: "You", displayName: "You", phoneE164: null, email: null, isSelf: true },
    ...others.map((k) => ({ key: k, displayName: k, phoneE164: null, email: null, isSelf: false })),
  ];
  const messages = [
    { senderKey: others[0], at: "2025-03-01T10:00:00.000Z", text: "hello" },
    { senderKey: "You", at: "2025-03-01T10:05:00.000Z", text: "hi back" },
    // > 6h later: a second session.
    { senderKey: others[others.length - 1], at: "2025-03-02T10:00:00.000Z", text: "next day" },
  ];
  return {
    source: "whatsapp",
    fileName: "WhatsApp Chat with Sam Rivera.txt",
    title: isGroup ? "Climbing crew" : "Sam Rivera",
    isGroup,
    participants,
    messages,
    dateOrderGuessed: false,
    skippedLines: 0,
  };
}

async function runJob(importId: string) {
  try {
    await runImportJobById(importId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("Invariant: static generation store missing")) throw err;
  }
}

/** The browser's whole path for one conversation: rows → staging → the engine. */
async function importConversation(c: Conversation, selfKey: string | null, decisions: Parameters<typeof conversationToRows>[2]) {
  const rows = conversationToRows(c, selfKey, decisions);
  const { importId } = await beginStaging(USER, { source: c.source, fileName: c.fileName, selfNames: [] }, LIVE);
  await appendStagedRows(USER, importId, 0, rows, LIVE);
  await startStaged(USER, importId, LIVE);
  await runJob(importId);
  return rows;
}

/** What the browser sends the preview for a parsed conversation. */
function toPreview(c: Conversation): ChatPreviewConversation {
  return {
    key: conversationKey(c, null),
    source: c.source,
    title: c.title,
    titleFromFile: c.titleFromFile ?? false,
    isGroup: c.isGroup,
    participants: c.participants.map((p) => ({ key: p.key, displayName: p.displayName, phoneE164: p.phoneE164, email: p.email })),
    messageCount: c.messages.length,
    chars: 100,
    firstAt: c.messages[0].at,
    lastAt: c.messages[c.messages.length - 1].at,
  };
}

function chat(
  title: string,
  labels: string[],
  opts: { isGroup?: boolean; titleFromFile?: boolean; source?: "whatsapp" | "imessage"; extra?: number } = {},
): Conversation {
  const messages = labels.map((k, i) => ({ senderKey: k, at: new Date(Date.UTC(2025, 3, 1, 10, i)).toISOString(), text: `hello ${i}` }));
  for (let i = 0; i < (opts.extra ?? 0); i++) {
    messages.push({ senderKey: labels[0], at: new Date(Date.UTC(2025, 4, 1, 10, i)).toISOString(), text: `later ${i}` });
  }
  return {
    source: opts.source ?? "whatsapp",
    fileName: `${title}.txt`,
    title,
    titleFromFile: opts.titleFromFile ?? false,
    isGroup: opts.isGroup ?? labels.length > 2,
    participants: labels.map((k) => ({
      key: k,
      displayName: k,
      phoneE164: /^\+\d+$/.test(k) ? k : null,
      email: null,
      isSelf: k === "You" || k === "Me",
    })),
    messages,
    dateOrderGuessed: false,
    skippedLines: 0,
  };
}

async function main() {
  console.log("Chat import actions (pglite)...");
  await reset();
  const db = await getDb();

  // ── Gate ───────────────────────────────────────────────────────────────────────────
  await rejects("gate: preview refuses when the surface is not live", () =>
    buildChatPreview(USER, [], { surfaceLive: false }),
  );

  // ── Matching ───────────────────────────────────────────────────────────────────────
  const priya = await addContact("Priya Nair", "+14155550134");
  await addContact("Maya Chen");
  await addContact("Maya Chen");
  await db.update(userSettings).set({ chatSelfNames: ["Jay P"] }).where(eq(userSettings.userId, USER));

  const preview = await buildChatPreview(
    USER,
    [
      previewConv("c-phone", "whatsapp", [{ key: "Jay P" }, { key: "+1 415 555 0134", phoneE164: "+14155550134" }]),
      previewConv("c-maya", "whatsapp", [{ key: "You" }, { key: "Maya Chen" }]),
      previewConv("c-imsg", "imessage", [{ key: "Me" }, { key: "Lee Park" }]),
    ],
    LIVE,
  );
  const byKey = new Map(preview.conversations.map((c) => [c.key, c]));
  const phoneConv = byKey.get("c-phone")!;
  const phoneP = phoneConv.participants.find((p) => p.key === "+1 415 555 0134")!;
  check("auto-link by phone", phoneP.autoContactId === priya, JSON.stringify(phoneP));
  check("auto-link names the contact", phoneP.autoContactName === "Priya Nair", JSON.stringify(phoneP));
  const maya = byKey.get("c-maya")!.participants.find((p) => p.key === "Maya Chen")!;
  check("ambiguous name: no auto-link", maya.autoContactId === null && maya.autoContactName === null, JSON.stringify(maya));
  check("ambiguous name: 2 candidates", maya.candidates.length === 2, JSON.stringify(maya));
  check("self: saved self name is the suggested owner", phoneConv.suggestedSelfKey === "Jay P");
  const jay = phoneConv.participants.find((p) => p.key === "Jay P")!;
  check("self: owner gets no candidates", jay.candidates.length === 0 && jay.autoContactId === null);
  check("self: WhatsApp You is the owner", byKey.get("c-maya")!.suggestedSelfKey === "You");
  check("self: iMessage suggests Me", byKey.get("c-imsg")!.suggestedSelfKey === "Me");
  check("estimate: null with no AI key", preview.estimate === null);

  // ── Staging ────────────────────────────────────────────────────────────────────────
  await rejects("gate: beginStaging refuses when not live", () =>
    beginStaging(USER, { source: "whatsapp", fileName: "x.zip", selfNames: [] }, { surfaceLive: false }),
  );
  const { importId } = await beginStaging(USER, { source: "whatsapp", fileName: "chats.zip", selfNames: ["Jay P"] }, LIVE);
  const begun = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  check("begin: status staging", begun?.status === "staging" && begun.totalRows === 0, begun?.status);
  const processing = await db
    .select({ id: imports.id })
    .from(imports)
    .where(and(eq(imports.userId, USER), eq(imports.status, "processing")));
  check("begin: the stall selector does not see it", !processing.some((r) => r.id === importId));
  const kicked: string[] = [];
  await resumeStalledImports({
    now: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    thresholdMs: 0,
    runner: async (id) => kicked.push(id),
  });
  check("begin: the stall sweep never resumes it", !kicked.includes(importId));

  const first = await appendStagedRows(USER, importId, 0, [row(), row({ title: "Two" })], LIVE);
  const second = await appendStagedRows(USER, importId, 2, [row({ title: "Three" })], LIVE);
  check("append: counts", first.appended === 2 && second.appended === 1);
  const staged = await db
    .select({ rowIndex: importJobRows.rowIndex })
    .from(importJobRows)
    .where(eq(importJobRows.importId, importId))
    .orderBy(asc(importJobRows.rowIndex));
  check(
    "append: contiguous row_index 0..n-1",
    staged.map((r) => r.rowIndex).join(",") === "0,1,2",
    staged.map((r) => r.rowIndex).join(","),
  );
  const afterAppend = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  check("append: totalRows incremented", afterAppend?.totalRows === 3, String(afterAppend?.totalRows));

  const long = row();
  long.sessions = [{ ...long.sessions[0], transcript: "x".repeat(13_000) }];
  await rejects("append: a 13,000-char transcript is refused", () => appendStagedRows(USER, importId, 3, [long], LIVE));
  await rejects("append: a wrong-source row is refused", () =>
    appendStagedRows(USER, importId, 3, [row({ source: "imessage" })], LIVE),
  );
  await rejects("append: a bad date is refused", () =>
    appendStagedRows(USER, importId, 3, [row({ sessions: [{ ...row().sessions[0], endAt: "not a date" }] })], LIVE),
  );
  await rejects("append: an out-of-step start index is refused", () =>
    appendStagedRows(USER, importId, 7, [row()], LIVE),
  );
  await rejects("append: another user's import is refused", () => appendStagedRows(OTHER, importId, 3, [row()], LIVE));
  await rejects("append: gate refuses when not live", () =>
    appendStagedRows(USER, importId, 3, [row()], { surfaceLive: false }),
  );
  const unchanged = await db.select().from(importJobRows).where(eq(importJobRows.importId, importId));
  check("append: refused appends staged nothing", unchanged.length === 3, String(unchanged.length));

  await rejects("start: another user's import is refused", () => startStaged(OTHER, importId, LIVE));
  const started = await startStaged(USER, importId, LIVE);
  const startedRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  check("start: processing", startedRow?.status === "processing");
  check("start: totalRows matches", started.totalRows === 3 && startedRow?.totalRows === 3);
  await rejects("append: after start is refused", () => appendStagedRows(USER, importId, 3, [row()], LIVE));
  await rejects("start: twice is refused", () => startStaged(USER, importId, LIVE));

  // ── Self names ─────────────────────────────────────────────────────────────────────
  await beginStaging(USER, { source: "whatsapp", fileName: "a.zip", selfNames: ["jay p", "Jason"] }, LIVE);
  await beginStaging(USER, { source: "imessage", fileName: "b.zip", selfNames: ["J1", "J2", "J3", "J4"] }, LIVE);
  const settings = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  const names = settings?.chatSelfNames ?? [];
  check("self names: capped at 5", names.length === 5, JSON.stringify(names));
  check(
    "self names: deduped case-insensitively",
    new Set(names.map((n) => n.toLowerCase())).size === names.length,
    JSON.stringify(names),
  );
  check("self names: newest kept", ["J1", "J2", "J3", "J4"].every((n) => names.includes(n)), JSON.stringify(names));

  // ── Sweep ──────────────────────────────────────────────────────────────────────────
  const [old] = await db
    .insert(imports)
    .values({
      userId: USER,
      importType: "whatsapp_chat",
      fileName: "old.zip",
      status: "staging",
      totalRows: 0,
      stats: {},
      createdAt: new Date(Date.now() - 25 * 3600 * 1000),
    })
    .returning();
  await db.insert(importJobRows).values({ importId: old.id, userId: USER, rowIndex: 0, payload: row() });
  const fresh = await beginStaging(USER, { source: "whatsapp", fileName: "fresh.zip", selfNames: [] }, LIVE);
  const swept = await sweepAbandonedStaging();
  check("sweep: deleted at least the old one", swept >= 1, String(swept));
  check("sweep: old staging import gone", !(await db.query.imports.findFirst({ where: eq(imports.id, old.id) })));
  const orphanRows = await db.select().from(importJobRows).where(eq(importJobRows.importId, old.id));
  check("sweep: its job rows cascade", orphanRows.length === 0);
  check("sweep: fresh staging import stays", Boolean(await db.query.imports.findFirst({ where: eq(imports.id, fresh.importId) })));
  check(
    "sweep: a started import stays",
    (await db.query.imports.findFirst({ where: eq(imports.id, importId) }))?.status === "processing",
  );

  // ── Owner detection (I-4) ──────────────────────────────────────────────────────────
  await reset();
  await db.update(userSettings).set({ firstName: "Jason", lastName: "Pereira" }).where(eq(userSettings.userId, USER));
  const owners = await buildChatPreview(
    USER,
    [
      toPreview(chat("Maya Chen", ["Jason", "Maya Chen"])),
      toPreview(chat("Maya Chen 2", ["jason   Pereira", "Maya Chen"])),
      toPreview(chat("Maya Chen", ["Maya Chen", "J P"], { titleFromFile: true })),
      toPreview(chat("Maya", ["J P"], { titleFromFile: true })),
      toPreview(chat("Book club", ["Me", "Jason Pereira", "Lee Park"], { source: "imessage" })),
      toPreview(chat("Lee", ["You", "Lee Park"], { source: "imessage" })),
    ].map((c, i) => ({ ...c, key: `own-${i}` })),
    LIVE,
  );
  const own = (i: number) => owners.conversations.find((c) => c.key === `own-${i}`)!;
  check("owner: a bare first name is not the owner", own(0).ownerKeys.length === 0 && own(0).suggestedSelfKey === null, JSON.stringify(own(0)));
  check("owner: a bare first name is still offered as a person", own(0).participants.some((p) => p.key === "Jason"));
  check("owner: the exact full name is (case and spacing aside)", own(1).ownerKeys.join() === "jason   Pereira" && own(1).suggestedSelfKey === "jason   Pereira", JSON.stringify(own(1).ownerKeys));
  check("owner: WhatsApp file-titled 1:1 — the label that is not the title", own(2).ownerKeys.join() === "J P", JSON.stringify(own(2).ownerKeys));
  check("owner: a lone sender who is not the title is not assumed", own(3).ownerKeys.length === 0 && own(3).suggestedSelfKey === null, JSON.stringify(own(3)));
  check("owner: every owner label is returned", own(4).ownerKeys.sort().join() === "Jason Pereira,Me" && own(4).suggestedSelfKey === "Me", JSON.stringify(own(4).ownerKeys));
  check("owner: owners get no candidates", own(4).participants.filter((p) => p.key !== "Lee Park").every((p) => !p.autoContactId && p.candidates.length === 0));
  check("owner: \"You\" is WhatsApp's owner label, not iMessage's", own(5).ownerKeys.length === 0, JSON.stringify(own(5).ownerKeys));

  // ── Re-exports link to the contact the first import made (I-3) ───────────────────────
  await reset();
  const firstDm = chat("Sam Rivera", ["You", "Sam Rivera"]);
  await importConversation(firstDm, "You", {});
  const [samMade] = await db.select().from(contacts).where(eq(contacts.userId, USER));
  check("re-export: the first import created Sam", samMade?.fullName === "Sam Rivera");
  await addContact("Sam Rivera"); // a namesake: a name match alone could not choose
  const firstGroup = chat("Climbing crew", ["You", "Ana Ruiz", "Ben Ode"], { isGroup: true });
  await importConversation(firstGroup, "You", { "Ana Ruiz": { contactId: null, create: true } });
  const anaMade = (await db.select().from(contacts).where(eq(contacts.userId, USER))).find((c) => c.fullName === "Ana Ruiz")!;
  await addContact("Ana Ruiz");

  // The same chats, exported again later: a file-name title this time, more messages, a new sender.
  const againDm = chat("Sam Rivera", ["You", "Sam Rivera"], { titleFromFile: true, extra: 3 });
  const againGroup = chat("Climbing crew", ["You", "Ana Ruiz", "Ben Ode", "Cleo Fay"], { isGroup: true, extra: 2 });
  check(
    "re-export: staged keys unchanged",
    conversationToRows(againDm, "You", {})[0].conversationKey === conversationToRows(firstDm, "You", {})[0].conversationKey &&
      conversationToRows(againGroup, "You", { "Ana Ruiz": { contactId: null, create: true } })[0].conversationKey ===
        conversationToRows(firstGroup, "You", { "Ana Ruiz": { contactId: null, create: true } })[0].conversationKey,
  );
  const again = await buildChatPreview(USER, [toPreview(againDm), toPreview(againGroup)], LIVE);
  const samAgain = again.conversations[0].participants.find((p) => p.key === "Sam Rivera")!;
  check("re-export: the 1:1 links to the contact the first import created", samAgain.autoContactId === samMade.id, JSON.stringify(samAgain));
  const groupAgain = again.conversations[1].participants;
  check(
    "re-export: the group member links to the contact holding the group",
    groupAgain.find((p) => p.key === "Ana Ruiz")?.autoContactId === anaMade.id,
    JSON.stringify(groupAgain),
  );
  check("re-export: a member nobody holds stays unlinked", groupAgain.find((p) => p.key === "Ben Ode")?.autoContactId === null);
  check("re-export: the new sender stays unlinked", groupAgain.find((p) => p.key === "Cleo Fay")?.autoContactId === null);

  // Owner unknown in a two-person chat: the one imported before as the other side is the contact.
  const unknownOwner = chat("Sam Rivera", ["Sam Rivera", "J Pee"]);
  const inferred = (await buildChatPreview(USER, [toPreview(unknownOwner)], LIVE)).conversations[0];
  check("re-export: the other side inferred, the remaining label is the owner", inferred.ownerKeys.join() === "J Pee", JSON.stringify(inferred.ownerKeys));
  check("re-export: and the other side links", inferred.participants.find((p) => p.key === "Sam Rivera")?.autoContactId === samMade.id);

  // A held conversation and an identifier owner that disagree: offered both, linked to neither.
  const holder = await addContact("Old Holder");
  const phoneOwner = await addContact("Phone Owner", "+14155550177");
  const disputed = chat("+14155550177", ["You", "+14155550177"]);
  const disputedKey = conversationKey(disputed, "You");
  await db.insert(interactions).values({
    userId: USER,
    contactId: holder,
    interactionType: "message",
    interactionDate: new Date("2025-01-01T00:00:00Z"),
    source: "whatsapp",
    externalId: sessionExternalId("whatsapp", disputedKey, "2025-01-01T00:00:00.000Z", holder),
  });
  const conflict = (await buildChatPreview(USER, [toPreview(disputed)], LIVE)).conversations[0].participants.find((p) => p.key === "+14155550177")!;
  check("disagree: no auto-link", conflict.autoContactId === null, JSON.stringify(conflict));
  check(
    "disagree: both offered",
    conflict.candidates.some((x) => x.contactId === holder) && conflict.candidates.some((x) => x.contactId === phoneOwner),
    JSON.stringify(conflict.candidates),
  );

  // ── conversationToRows ─────────────────────────────────────────────────────────────
  const one = conversationToRows(conversation(false), "You", {});
  check("toRows: 1:1 default → 1 row", one.length === 1, String(one.length));
  check("toRows: 1:1 default creates", one[0].createIfUnmatched === true && one[0].resolvedContactId === null);
  check("toRows: owner never gets a row", one.every((r) => r.participant.key !== "You"));
  check("toRows: two sessions", one[0].sessions.length === 2, String(one[0].sessions.length));
  const groupDefault = conversationToRows(conversation(true), "You", {});
  check("toRows: group default → 0 rows", groupDefault.length === 0, String(groupDefault.length));
  const ticked = conversationToRows(conversation(true), "You", { "Ana Ruiz": { contactId: null, create: true } });
  check("toRows: ticked group member → 1 row", ticked.length === 1 && ticked[0].participant.key === "Ana Ruiz");
  check(
    "toRows: group transcripts start with the header",
    ticked[0].sessions.every((s) => s.transcript.startsWith("# Group chat")),
  );
  const pinned = conversationToRows(conversation(true), "You", {
    "Sam Rivera": { contactId: priya, create: false },
    You: { contactId: priya, create: true },
  });
  check(
    "toRows: pinned member carries the pin; owner still skipped",
    pinned.length === 1 && pinned[0].resolvedContactId === priya && pinned[0].createIfUnmatched === false,
  );
  const bigGroup = conversation(true);
  bigGroup.messages = [{ senderKey: "Ana Ruiz", at: "2025-03-01T10:00:00.000Z", text: "y".repeat(11_950) }];
  const capped = conversationToRows(bigGroup, "You", { "Ana Ruiz": { contactId: null, create: true } });
  check(
    "toRows: header + transcript stays within 12,000",
    capped[0].sessions.every((s) => s.transcript.length <= 12_000 && s.transcript.startsWith("# Group chat")),
  );
  // A full row built by the browser passes the server's own validation.
  const { importId: roundTrip } = await beginStaging(USER, { source: "whatsapp", fileName: "rt.zip", selfNames: [] }, LIVE);
  const rt = await appendStagedRows(USER, roundTrip, 0, [...one, ...capped], LIVE);
  check("toRows: rows pass append validation", rt.appended === 2);

  // Emoji at every cut: the rows round-trip through jsonb byte for byte (a lone surrogate
  // would be refused by Postgres, or come back altered).
  // Both header parities, so a cut lands mid-emoji in one of them under any header-blind rule.
  const emojiRows = [0, 1].flatMap((pad) => {
    const g = conversation(true);
    g.title = "Party \u{1F389}" + "!".repeat(pad);
    g.messages = Array.from({ length: 40 }, (_, i) => ({
      senderKey: i % 2 ? "Ana Ruiz" : "Sam Rivera",
      at: new Date(Date.UTC(2025, 2, 1, 10, i)).toISOString(),
      text: "\u{1F600}".repeat(180),
    }));
    g.messages.push({ senderKey: "Ana Ruiz", at: "2025-03-01T12:00:00.000Z", text: "\u{1F600}".repeat(7_000) });
    return conversationToRows(g, "You", {
      "Ana Ruiz": { contactId: null, create: true },
      "Sam Rivera": { contactId: null, create: true },
    });
  });
  const { importId: emojiImport } = await beginStaging(USER, { source: "whatsapp", fileName: "emoji.zip", selfNames: [] }, LIVE);
  await appendStagedRows(USER, emojiImport, 0, emojiRows, LIVE);
  const back = await db
    .select({ payload: importJobRows.payload })
    .from(importJobRows)
    .where(eq(importJobRows.importId, emojiImport))
    .orderBy(asc(importJobRows.rowIndex));
  check(
    "jsonb: emoji-cut rows round-trip unchanged",
    back.length === emojiRows.length && back.every((r, i) => isDeepStrictEqual(r.payload, emojiRows[i])),
    `${back.length} of ${emojiRows.length}`,
  );

  console.log("Chat import actions: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
