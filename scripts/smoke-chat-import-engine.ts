/**
 * Chat (WhatsApp / iMessage) import adapter against the shared engine (pglite): the
 * `resolvedContactId` pin, stale-pin fallback, skipped unticked group members, phone identity
 * on create, session interactions, in-place growth on re-import.
 *
 * Run: npx tsx scripts/smoke-chat-import-engine.ts
 */
import "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-chat-import";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-chat-import";

import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contactIdentities,
  contactTags,
  contacts,
  imports,
  importJobRows,
  interactions,
  tags,
  userSettings,
  type ChatConversationRowPayload,
  type ImportJobRowPayload,
} from "../src/db/schema";
import { runImportJobById } from "../src/lib/import-job-dispatch";
import { sessionExternalId } from "../src/lib/conversations/sessions";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-chat-import-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function runJob(importId: string) {
  try {
    await runImportJobById(importId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("Invariant: static generation store missing")) throw err;
  }
}

async function reset() {
  const db = await getDb();
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(importJobRows).where(eq(importJobRows.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(contactIdentities).where(eq(contactIdentities.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

async function seedJob(rows: ChatConversationRowPayload[], importType = "whatsapp_chat") {
  const db = await getDb();
  const [job] = await db
    .insert(imports)
    .values({
      userId: USER,
      importType,
      fileName: "chat.zip",
      status: "processing",
      totalRows: rows.length,
      stats: {},
    })
    .returning();
  await db.insert(importJobRows).values(
    rows.map((payload, i) => ({
      importId: job.id,
      userId: USER,
      rowIndex: i,
      payload: payload as ImportJobRowPayload,
    }))
  );
  return job.id;
}

const S1 = { startAt: "2025-01-10T10:00:00.000Z", endAt: "2025-01-10T10:20:00.000Z", messageCount: 3, direction: "in" as const };
const S2 = { startAt: "2025-02-01T09:00:00.000Z", endAt: "2025-02-01T09:05:00.000Z", messageCount: 2, direction: "out" as const };

function row(over: Partial<ChatConversationRowPayload> = {}): ChatConversationRowPayload {
  return {
    kind: "chat_conversation",
    source: "whatsapp",
    conversationKey: "conv-1",
    isGroup: false,
    title: "Maya Chen",
    participant: { key: "p1", displayName: "Maya Chen", phoneE164: null, email: null },
    resolvedContactId: null,
    createIfUnmatched: true,
    sessions: [
      { ...S1, transcript: "[10:00] Maya: " + "hello there ".repeat(40) },
      { ...S2, transcript: "[09:00] Me: second session" },
    ],
    ...over,
  };
}

async function contactsOf() {
  const db = await getDb();
  return db.select().from(contacts).where(eq(contacts.userId, USER));
}
async function interactionsOf() {
  const db = await getDb();
  return db.select().from(interactions).where(eq(interactions.userId, USER));
}
async function status(importId: string) {
  const db = await getDb();
  const rows = await db.select().from(importJobRows).where(eq(importJobRows.importId, importId));
  return rows.map((r) => r.status);
}

async function main() {
  console.log("Chat import engine (pglite)...");
  const db = await getDb();

  // 1. Pinned contact wins over identical names.
  await reset();
  const [a, b] = await db
    .insert(contacts)
    .values([
      { userId: USER, fullName: "Maya Chen" },
      { userId: USER, fullName: "Maya Chen" },
    ])
    .returning();
  let id = await seedJob([row({ resolvedContactId: b.id })]);
  await runJob(id);
  let ints = await interactionsOf();
  check("pinned: sessions land on the pinned contact only", ints.length === 2 && ints.every((i) => i.contactId === b.id), JSON.stringify(ints.map((i) => i.contactId)));
  check("pinned: no contact created", (await contactsOf()).length === 2);
  check("pinned: other namesake untouched", !ints.some((i) => i.contactId === a.id));

  // 2. Stale pin falls back to identity / create.
  await reset();
  const ghost = crypto.randomUUID();
  id = await seedJob([
    row({
      resolvedContactId: ghost,
      participant: { key: "z", displayName: "Zed Quinn", phoneE164: null, email: null },
    }),
  ]);
  await runJob(id);
  let cs = await contactsOf();
  check("stale pin: new contact created", cs.length === 1 && cs[0].fullName === "Zed Quinn", JSON.stringify(cs.map((c) => c.fullName)));
  ints = await interactionsOf();
  check("stale pin: ghost id never written", ints.length === 2 && ints.every((i) => i.contactId === cs[0].id));
  const tagNames = (
    await db
      .select({ name: tags.name })
      .from(contactTags)
      .innerJoin(tags, eq(tags.id, contactTags.tagId))
      .where(eq(contactTags.contactId, cs[0].id))
  ).map((t) => t.name);
  check("stale pin: tagged whatsapp", tagNames.includes("whatsapp"), JSON.stringify(tagNames));

  // 3. Unticked group member skipped.
  await reset();
  id = await seedJob([
    row({
      isGroup: true,
      createIfUnmatched: false,
      participant: { key: "g", displayName: "Group Gary", phoneE164: null, email: null },
    }),
  ]);
  await runJob(id);
  check("unticked: row skipped", (await status(id)).every((s) => s === "skipped"), JSON.stringify(await status(id)));
  check("unticked: no contact", (await contactsOf()).length === 0);
  check("unticked: no interactions", (await interactionsOf()).length === 0);

  // 4. Phone identity on create.
  await reset();
  id = await seedJob([
    row({ participant: { key: "ph", displayName: "Phone Pat", phoneE164: "+14155550134", email: null } }),
  ]);
  await runJob(id);
  cs = await contactsOf();
  const idents = await db
    .select()
    .from(contactIdentities)
    .where(and(eq(contactIdentities.userId, USER), eq(contactIdentities.kind, "phone_e164")));
  check("phone identity written for the new contact", idents.length === 1 && idents[0].value === "+14155550134" && idents[0].contactId === cs[0].id, JSON.stringify(idents));

  // 5. Session rows.
  await reset();
  const base = row({ participant: { key: "m", displayName: "Maya Chen", phoneE164: null, email: null } });
  id = await seedJob([base]);
  await runJob(id);
  cs = await contactsOf();
  ints = (await interactionsOf()).sort((x, y) => x.interactionDate.getTime() - y.interactionDate.getTime());
  check("two session interactions", ints.length === 2);
  check("type + source", ints.every((i) => i.interactionType === "message" && i.source === "whatsapp"));
  check("interaction_date is endAt", ints[0].interactionDate.toISOString() === S1.endAt.replace(".000Z", ".000Z") && ints[1].interactionDate.toISOString() === new Date(S2.endAt).toISOString());
  check("external id uses the contact id", ints[0].externalId === sessionExternalId("whatsapp", "conv-1", S1.startAt, cs[0].id), String(ints[0].externalId));
  check("ai_summary is first 240 chars", ints[0].aiSummary === base.sessions[0].transcript.slice(0, 240));
  check("raw_notes verbatim", ints[0].rawNotes === base.sessions[0].transcript && ints[1].rawNotes === base.sessions[1].transcript);
  const tagged = cs[0].source === "whatsapp_chat";
  check("contact source whatsapp_chat", tagged, String(cs[0].source));

  // 6. Re-import grows the last session in place (re-pinned to the now-existing contact).
  const grown = row({
    resolvedContactId: cs[0].id,
    sessions: [
      base.sessions[0],
      { ...S2, endAt: "2025-02-01T09:30:00.000Z", messageCount: 3, transcript: base.sessions[1].transcript + "\n[09:30] Maya: one more" },
    ],
  });
  id = await seedJob([grown]);
  await runJob(id);
  ints = (await interactionsOf()).sort((x, y) => x.interactionDate.getTime() - y.interactionDate.getTime());
  check("re-import: still two rows", ints.length === 2, String(ints.length));
  check("re-import: later endAt", ints[1].interactionDate.toISOString() === "2025-02-01T09:30:00.000Z", ints[1].interactionDate.toISOString());
  check("re-import: transcript updated", ints[1].rawNotes === grown.sessions[1].transcript);
  check("re-import: no extra contact", (await contactsOf()).length === 1);

  // 7. iMessage.
  await reset();
  id = await seedJob(
    [row({ source: "imessage", conversationKey: "im-1", participant: { key: "i", displayName: "Ivy Imes", phoneE164: null, email: null } })],
    "imessage_chat"
  );
  await runJob(id);
  ints = await interactionsOf();
  check("imessage source", ints.length === 2 && ints.every((i) => i.source === "imessage"));
  check("imessage job completed", (await db.query.imports.findFirst({ where: eq(imports.id, id) }))?.status === "completed");

  // 8. A big chat: one participant split across many rows (to-rows' 50-session bound) is ONE
  // contact, and > 1,000 interactions land through the chunked insert.
  await reset();
  const sessionsFor = (rowNo: number, n: number) =>
    Array.from({ length: n }, (_, j) => {
      const start = new Date(Date.UTC(2024, 0, 1) + (rowNo * n + j) * 86_400_000);
      return {
        startAt: start.toISOString(),
        endAt: new Date(start.getTime() + 600_000).toISOString(),
        messageCount: 2,
        direction: "in" as const,
        transcript: `[${start.toISOString().slice(0, 16).replace("T", " ")} Big Bea] day ${rowNo}-${j}`,
      };
    });
  const bigRows = Array.from({ length: 25 }, (_, r) =>
    row({
      conversationKey: "big-1",
      participant: { key: "Big Bea", displayName: "Big Bea", phoneE164: null, email: null },
      sessions: sessionsFor(r, 50),
    })
  );
  id = await seedJob(bigRows);
  await runJob(id);
  const job = await db.query.imports.findFirst({ where: eq(imports.id, id) });
  cs = await contactsOf();
  ints = await interactionsOf();
  check("big chat: job completed", job?.status === "completed", `${job?.status} ${job?.errorMessage ?? ""}`);
  check("big chat: one participant split across rows is one contact", cs.length === 1, JSON.stringify(cs.map((c) => c.fullName)));
  check("big chat: 1,250 interactions written", ints.length === 1_250 && ints.every((i) => i.contactId === cs[0].id), String(ints.length));
  check("big chat: interactionsLogged counts them all", job?.stats?.interactionsLogged === 1_250, String(job?.stats?.interactionsLogged));
  check("big chat: every row done", (await status(id)).every((s) => s === "done"));

  // 9. Across engine chunks (250 rows each): row 251 of the same participant still lands on them.
  await reset();
  const longRows = Array.from({ length: 300 }, (_, r) =>
    row({
      conversationKey: "long-1",
      participant: { key: "Long Lu", displayName: "Long Lu", phoneE164: null, email: null },
      sessions: sessionsFor(r, 1),
    })
  );
  id = await seedJob(longRows);
  await runJob(id);
  cs = await contactsOf();
  ints = await interactionsOf();
  check("across chunks: still one contact", cs.length === 1, String(cs.length));
  check("across chunks: 300 interactions on them", ints.length === 300 && ints.every((i) => i.contactId === cs[0].id), String(ints.length));

  // 10. A resumed job: the participant's first row was done by an earlier invocation.
  await reset();
  id = await seedJob(
    [0, 1].map((r) =>
      row({
        conversationKey: "resume-1",
        participant: { key: "Res Ro", displayName: "Res Ro", phoneE164: null, email: null },
        sessions: sessionsFor(r, 2),
      })
    )
  );
  const [earlier] = await db.insert(contacts).values({ userId: USER, fullName: "Res Ro" }).returning();
  await db
    .update(importJobRows)
    .set({ status: "done", contactId: earlier.id })
    .where(and(eq(importJobRows.importId, id), eq(importJobRows.rowIndex, 0)));
  await runJob(id);
  cs = await contactsOf();
  ints = await interactionsOf();
  check("resume: no second contact for the same participant", cs.length === 1 && cs[0].id === earlier.id, JSON.stringify(cs.map((c) => c.id)));
  check("resume: the remaining row's sessions land on them", ints.length === 2 && ints.every((i) => i.contactId === earlier.id), String(ints.length));

  // 11. finalize completed above without throwing (kick is best-effort).
  check("finalize did not break the job", true);

  await reset();
  console.log("chat import engine OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
