/**
 * Action-item sync: the diff rules, and hash parity between TypeScript and the SQL backfill
 * in src/db/index.ts (ADMIN_V2_STATEMENTS). If those two formulas ever disagree, a
 * re-sync duplicates every legacy item.
 * Writes to local PGlite. Stop the worktree dev server first.
 * Run: npx tsx scripts/smoke-action-items.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-action-items";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-action-items";
delete process.env.DATABASE_URL;

import { eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { actionItems, contacts, interactions, userSettings } from "../src/db/schema";
import { actionItemHash, diffActionItems, listOpenActionItems, setActionItemStatusForUser, syncActionItems } from "../src/lib/action-items";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-action-items-user";
function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

// --- pure ---
{
  const iid = "00000000-0000-0000-0000-000000000001";
  const existing = [
    { id: "a", itemHash: actionItemHash(iid, "Send the deck"), status: "open" as const, reminderId: null },
    { id: "b", itemHash: actionItemHash(iid, "Intro to Raj"), status: "done" as const, reminderId: null },
    { id: "c", itemHash: actionItemHash(iid, "Book follow-up"), status: "open" as const, reminderId: "r1" },
    { id: "d", itemHash: actionItemHash(iid, "Old item"), status: "open" as const, reminderId: null },
  ];
  const hash = (t: string) => actionItemHash(iid, t);
  const d = diffActionItems(existing, ["send the deck", "  Send the deck ", "New thing", ""], hash);
  check("hash is case/whitespace-insensitive", d.insert.length === 1 && d.insert[0].text === "New thing");
  check("unchanged open item kept", !d.deleteIds.includes("a"));
  check("done item never deleted", !d.deleteIds.includes("b"));
  check("item with reminder never deleted", !d.deleteIds.includes("c"));
  check("removed open item deleted", d.deleteIds.includes("d"));
  const capped = diffActionItems([], Array.from({ length: 15 }, (_, i) => `item ${i}`), hash);
  check("capped at 10", capped.insert.length === 10);
  check("positions are 0..n-1", capped.insert.every((x, i) => x.position === i));
}

// --- DB ---
async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Sarah Chen" }).returning();
  const [i] = await db.insert(interactions).values({ userId: USER, contactId: c.id, rawNotes: "x", actionItems: ["Send the deck", "  Intro to Raj "] }).returning();

  // Hash parity with the SQL formula used by the backfill.
  const sqlHash = rowsOf<{ h: string }>(await db.execute(sql`select encode(sha256(convert_to(${i.id}::text || '|' || lower(btrim(${"  Intro to Raj "})), 'UTF8')), 'hex') as h`))[0].h;
  check("SQL hash equals TS hash", sqlHash === actionItemHash(i.id, "  Intro to Raj "), `${sqlHash} vs ${actionItemHash(i.id, "  Intro to Raj ")}`);

  // The backfill statement (re-run here) picks up the legacy string[].
  await db.execute(sql`INSERT INTO action_items (user_id, contact_id, interaction_id, text, position, item_hash)
    SELECT i.user_id, i.contact_id, i.id, a.value, a.ordinality - 1,
           encode(sha256(convert_to(i.id::text || '|' || lower(btrim(a.value)), 'UTF8')), 'hex')
    FROM interactions i, jsonb_array_elements_text(COALESCE(i.action_items, '[]'::jsonb)) WITH ORDINALITY a
    WHERE i.id = ${i.id} AND btrim(a.value) <> ''
    ON CONFLICT (user_id, item_hash) DO NOTHING`);
  let rows = await db.query.actionItems.findMany({ where: eq(actionItems.interactionId, i.id) });
  check("backfill created two rows", rows.length === 2, String(rows.length));

  // syncActionItems is idempotent against the backfilled rows and applies the diff.
  const s1 = await syncActionItems(USER, i.id, c.id, ["Send the deck", "Intro to Raj"]);
  check("sync after backfill inserts nothing", s1.inserted.length === 0 && s1.deletedIds.length === 0);
  await setActionItemStatusForUser(USER, rows[0].id, "done");
  const s2 = await syncActionItems(USER, i.id, c.id, ["Intro to Raj", "Ping legal"]);
  rows = await db.query.actionItems.findMany({ where: eq(actionItems.interactionId, i.id) });
  check("sync: new item inserted", s2.inserted.length === 1 && s2.inserted[0].text === "Ping legal");
  check("sync: done row survives even though it left the list", rows.some((r) => r.status === "done"));
  const open = await listOpenActionItems(USER, c.id);
  check("open list excludes done", open.length === 2 && open.every((o) => o.text !== rows.find((r) => r.status === "done")!.text));
  check("status change is user-scoped", (await setActionItemStatusForUser("someone-else", rows[0].id, "open")) === null);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log("\nsmoke-action-items: all checks passed");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
