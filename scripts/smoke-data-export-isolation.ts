/**
 * "Download my data": what a row may carry out, and whose rows it may carry.
 *
 * `redactExportRow` is the last filter between the database and a file the user can forward
 * to anyone. It works by COLUMN NAME (`*_encrypted`, `*token`, `*secret`, `*_hash`, plus
 * vectors, inline bytes, blob URLs and the calendar feed's secret `ics_url`). Pinned here:
 *
 *  - every rule (the suffix rules case-insensitively), and that ordinary columns pass
 *    untouched;
 *  - that it is a column filter and nothing more: a jsonb VALUE is passed through whole, keys
 *    inside it included. No exported table was found to keep credentials nested inside a
 *    jsonb column (credentials live in their own `*_encrypted` columns, which are dropped), so
 *    this is pinned as the contract rather than filed as a bug — but a future jsonb that nests
 *    a token must not rely on this function to strip it.
 *
 * Then the property that matters more than any single column: `collectUserExport(A)` holds
 * none of B's rows. B is seeded with distinctive markers across contacts, interactions,
 * reminders, opportunities, suggestions, chat and settings; the whole export of A is
 * searched for every one of them and for B's user id.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-data-export-isolation.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import {
  aiSuggestions,
  chatMessages,
  chatThreads,
  contactOpportunities,
  userSettings,
} from "../src/db/schema";
import { collectUserExport, redactExportRow } from "../src/lib/data-export";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, insertInteraction, insertReminder, purgeUsers } from "./smoke/factories";

const t = checker();
const A = fakeUserId("export-a");
const B = fakeUserId("export-b");

console.log("\nredactExportRow");
{
  const row = {
    id: "r1",
    full_name: "Ada Lovelace",
    gemini_api_key_encrypted: "enc:not-real",
    calendar_feed_token: "test-token-not-real",
    webhook_secret: "test-secret-not-real",
    source_hash: "abc123",
    embedding: [0.1, 0.2],
    embedding_vector: "[0.1,0.2]",
    blob_url: "https://abc.public.blob.vercel-storage.com/x.jpg",
    inline_data: "AAAA",
    ics_url: "https://calendar.example.com/private-test.ics",
    Refresh_TOKEN: "test-token-not-real",
    notes: "Met at the symposium",
    metadata: { access_token: "test-token-not-real", nested: { client_secret: "test-secret-not-real" } },
    tokens_used: 42,
    hashtag: "#launch",
  };
  const out = redactExportRow(row);
  const dropped = ["gemini_api_key_encrypted", "calendar_feed_token", "webhook_secret", "source_hash", "embedding", "embedding_vector", "blob_url", "inline_data", "ics_url", "Refresh_TOKEN"];
  for (const key of dropped) t.check(`drops ${key}`, !(key in out));
  t.check("keeps ordinary columns", out.id === "r1" && out.full_name === "Ada Lovelace" && out.notes === "Met at the symposium");
  t.check("suffix rules are suffixes: tokens_used and hashtag stay", out.tokens_used === 42 && out.hashtag === "#launch");
  t.check(
    "a jsonb value passes through whole — nested keys are NOT filtered (column-level contract)",
    JSON.stringify(out.metadata) === JSON.stringify(row.metadata)
  );
  t.check("does not mutate its input", "gemini_api_key_encrypted" in row);
  t.check("an empty row stays empty", Object.keys(redactExportRow({})).length === 0);
}

run(async () => {
  const db = await getDb();
  await purgeUsers(db, [A, B]);

  try {
    const MARK = "ZXQ-OTHER-ACCOUNT";
    // A: an ordinary account with a little of everything.
    const a = await insertContact(db, A, 0);
    await insertInteraction(db, A, a.id, { rawNotes: "Coffee with Ada about the analytical engine." });
    await insertReminder(db, A, a.id, { title: "Send Ada the paper" });
    await db.insert(userSettings).values({ userId: A, email: "owner-a@orbit.test" });

    // B: the same shapes, every string marked.
    const b = await insertContact(db, B, 3, { fullName: `${MARK} Katherine`, notes: `${MARK} notes`, email: "zxq-other@example.com" });
    await insertInteraction(db, B, b.id, { rawNotes: `${MARK} interaction` });
    await insertReminder(db, B, b.id, { title: `${MARK} reminder` });
    await db.insert(contactOpportunities).values({ userId: B, contactId: b.id, kind: "referral", label: `${MARK} opportunity` });
    await db.insert(aiSuggestions).values({ userId: B, suggestionType: "reconnect", title: `${MARK} suggestion`, relatedContactIds: [b.id] });
    const [thread] = await db.insert(chatThreads).values({ userId: B, title: `${MARK} thread` }).returning();
    await db.insert(chatMessages).values({ threadId: thread.id, userId: B, role: "user", content: `${MARK} chat message` });
    await db.insert(userSettings).values({ userId: B, email: "zxq-owner-b@orbit.test" });

    const exportA = await collectUserExport(A);
    const text = JSON.stringify(exportA);
    t.check("A's export is the v2 format", exportA.format === "orbit-export/2");
    t.check("A's own contact is in it", text.includes(a.id) && text.includes("Ada Lovelace"));
    t.check("A's own interaction is in it", text.includes("Coffee with Ada about the analytical engine."));
    t.check("none of B's marked strings appear in A's export", !text.includes(MARK), text.includes(MARK) ? text.slice(Math.max(0, text.indexOf(MARK) - 200), text.indexOf(MARK) + 100) : "");
    t.check("B's user id appears nowhere in A's export", !text.includes(B));
    t.check("B's contact id appears nowhere in A's export", !text.includes(b.id));
    t.check("B's email addresses appear nowhere in A's export", !text.includes("zxq-other@example.com") && !text.includes("zxq-owner-b@orbit.test"));

    // Every row that carries a user_id says A.
    const foreign: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${path}[${i}]`));
      else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "user_id" && v !== A) foreign.push(`${path}.user_id=${String(v)}`);
          walk(v, `${path}.${k}`);
        }
      }
    };
    walk(exportA, "export");
    t.check("every user_id in A's export is A", foreign.length === 0, foreign.slice(0, 5).join(", "));

    const exportB = await collectUserExport(B);
    const textB = JSON.stringify(exportB);
    t.check("and the other way: B's export has B's rows and none of A's", textB.includes(MARK) && !textB.includes(a.id) && !textB.includes(A));
  } finally {
    await purgeUsers(db, [A, B]);
  }

  t.done("data export isolation");
});
