/**
 * Invariants for the reminders page query (`src/lib/reminders-page-query.ts`).
 *
 * Runs the real `queryRemindersPage` / `queryReminderRailCounts` against a throwaway PGlite
 * database — they take `db` and need no auth, so nothing is reimplemented here except the
 * reference answer, which is computed in JS from the seeded rows with the same pure helpers
 * the client uses. That also holds the SQL day expression and `dueDayOf` in agreement.
 *
 * For each viewer timezone and each view/list/filter combination it walks every cursor to
 * exhaustion (at two page sizes) and checks: the union is exactly the reference set, nothing
 * repeats, the order is the reference order, and `total` and the rail counts match.
 *
 * Run: npx tsx scripts/smoke-reminders-page.ts
 */
import "./smoke/_env";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { DDL, applyScaleSchema } from "../src/db";
import * as schema from "../src/db/schema";
import {
  dueDaySql,
  queryReminderRailCounts,
  queryRemindersPage,
} from "../src/lib/reminders-page-query";
import { dueDayOf, ymdInZone } from "../src/lib/reminder-due-bucket";
import type {
  ReminderSource,
  RemindersPageFilters,
  ReminderView,
} from "../src/lib/reminders-page";
import type { ReminderActionKind } from "../src/db/schema";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const USER = "u1";
const OTHER_USER = "u2";
const N = 137; // deliberately not a multiple of either page size
// Pinned: 15:00 UTC is already the next day in Tokyo and still morning in Los Angeles.
const NOW = new Date("2026-09-18T15:00:00Z");
const ZONES = ["America/Los_Angeles", "UTC", "Asia/Tokyo"];

const KINDS: ReminderActionKind[] = ["call", "email", "meet", "task", "follow_up"];
const TYPES = ["manual", "capture", "post_meeting", "generated", "ai_suggested", "extracted_date"];
const STATUSES = ["pending", "pending", "pending", "done", "completed", "dismissed"];

type Seeded = {
  id: string;
  title: string;
  description: string | null;
  dueDate: Date | null;
  status: string;
  reminderType: string;
  actionKind: ReminderActionKind;
  listId: string | null;
  contactId: string | null;
  contactNames: string[];
  noteBatchId: string | null;
  createdAtText: string;
};

function dueFor(i: number): Date | null {
  if (i % 9 === 0) return null;
  const dayOffset = (i % 23) - 11; // -11 … +11 days around NOW
  const base = new Date(NOW);
  base.setUTCDate(base.getUTCDate() + dayOffset);
  const ymd = base.toISOString().slice(0, 10);
  switch (i % 5) {
    case 0: // date-only, UTC midnight (createReminder)
      return new Date(`${ymd}T00:00:00Z`);
    case 1: // date-only, noon (atLocalNoon on a UTC server)
      return new Date(`${ymd}T12:00:00Z`);
    case 2: // timed, the last minute of the LA day
      return new Date(`${ymd}T06:59:00Z`);
    case 3: // timed, the first minute of the Tokyo day
      return new Date(`${ymd}T15:00:00Z`);
    default: // timed, with seconds, so it is never mistaken for date-only
      return new Date(`${ymd}T09:30:17Z`);
  }
}

async function main() {
  const client = await PGlite.create({ extensions: { pg_trgm } });
  await client.exec(DDL);
  await client.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS stated_closeness integer`);
  await applyScaleSchema((s) => client.query(s));
  const db = drizzle(client, { schema });
  // `queryRemindersPage` is typed for the app's Db union; this PGlite drizzle is one arm.
  const appDb = db as unknown as Parameters<typeof queryRemindersPage>[0];

  const [inbox, work] = await db
    .insert(schema.reminderLists)
    .values([
      { userId: USER, name: "Inbox", nameNormalized: "inbox", position: 0, isInbox: 1 },
      { userId: USER, name: "Work", nameNormalized: "work", position: 1, isInbox: 0 },
    ])
    .returning();

  const people = await db
    .insert(schema.contacts)
    .values([
      { userId: USER, fullName: "Alexandra Okafor", preferredName: "Alex" },
      { userId: USER, fullName: "Priya Ng" },
      { userId: USER, fullName: "Zhang Wei" },
    ])
    .returning();

  const values = [];
  for (let i = 0; i < N; i++) {
    const contact = i % 4 === 0 ? null : people[i % people.length];
    values.push({
      userId: USER,
      title: i % 17 === 0 ? `Send 100% of the deck ${i}` : `Reminder ${i}`,
      description: i % 12 === 0 ? `Budget_review notes ${i}` : i % 12 === 6 ? `Budget review notes ${i}` : null,
      dueDate: dueFor(i),
      status: STATUSES[i % STATUSES.length],
      reminderType: TYPES[i % TYPES.length],
      actionKind: KINDS[i % KINDS.length],
      listId: i % 3 === 0 ? work.id : i % 3 === 1 ? inbox.id : null,
      contactId: contact?.id ?? null,
      noteBatchId: i % 11 === 0 ? "00000000-0000-4000-8000-000000000001" : null,
    });
  }
  const inserted = await db.insert(schema.reminders).values(values).returning();

  // Another account's rows must never leak in.
  await db.insert(schema.reminders).values(
    Array.from({ length: 12 }, (_, i) => ({
      userId: OTHER_USER,
      title: `Reminder other ${i}`,
      dueDate: dueFor(i),
      status: "pending",
    }))
  );

  // Force microsecond ties: many rows sharing one millisecond, differing below it.
  await client.query(
    `update reminders set created_at = timestamptz '2026-09-01 10:00:00.123000+00'
       + (random() * interval '0.000900 seconds') where user_id = $1 and title like '%1'`,
    [USER]
  );
  await client.query(`ANALYZE reminders`);

  const createdRows = await db
    .select({ id: schema.reminders.id, t: sql<string>`created_at::text` })
    .from(schema.reminders)
    .where(eq(schema.reminders.userId, USER));
  const createdText = new Map(createdRows.map((r) => [r.id, r.t]));

  const seeded: Seeded[] = inserted.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    dueDate: r.dueDate,
    status: r.status,
    reminderType: r.reminderType,
    actionKind: r.actionKind as ReminderActionKind,
    listId: r.listId,
    contactId: r.contactId,
    contactNames: (() => {
      const c = people.find((p) => p.id === r.contactId);
      return c ? [c.fullName, c.preferredName ?? ""].filter(Boolean) : [];
    })(),
    noteBatchId: r.noteBatchId,
    createdAtText: createdText.get(r.id) ?? "",
  }));

  // ── The SQL day expression agrees with dueDayOf, for every row, in every zone. ──
  console.log("\ndue day: SQL vs dueDayOf");
  for (const tz of ZONES) {
    const rows = await db
      .select({ id: schema.reminders.id, day: sql<string | null>`${dueDaySql(tz)}::text` })
      .from(schema.reminders)
      .where(eq(schema.reminders.userId, USER));
    const mismatches = rows.filter((r) => {
      const s = seeded.find((x) => x.id === r.id)!;
      return (r.day ?? null) !== dueDayOf(s.dueDate, tz);
    });
    check(`${tz}: all ${rows.length} rows agree`, mismatches.length === 0,
      mismatches.slice(0, 3).map((m) => `${m.id} sql=${m.day}`).join(", "));
  }

  // ── Reference answers. ──
  const isPending = (s: Seeded) => s.status === "pending";
  const isDone = (s: Seeded) => s.status === "done" || s.status === "completed";

  function sourceMatch(s: Seeded, src: ReminderSource) {
    switch (src) {
      case "manual": return s.reminderType === "manual" && !s.noteBatchId;
      case "notes": return Boolean(s.noteBatchId) || ["capture", "post_meeting", "extracted_date"].includes(s.reminderType);
      case "ai": return s.reminderType === "ai_suggested" && !s.noteBatchId;
      case "auto": return s.reminderType === "generated";
    }
  }

  function expected(f: RemindersPageFilters): string[] {
    const today = ymdInZone(NOW, f.tz);
    const done = !f.listId && f.view === "done";
    const matches = seeded.filter((s) => {
      const day = dueDayOf(s.dueDate, f.tz);
      if (f.listId) {
        if (!isPending(s)) return false;
        if (f.listId === inbox.id ? !(s.listId === inbox.id || s.listId === null) : s.listId !== f.listId) return false;
      } else {
        const view = f.view ?? "today";
        if (view === "done") { if (!isDone(s)) return false; }
        else if (!isPending(s)) return false;
        if (view === "today" && !(day !== null && day <= today)) return false;
        if (view === "upcoming" && !(day !== null && day > today)) return false;
        if (view === "anytime" && s.dueDate !== null) return false;
      }
      const q = f.q?.trim().toLowerCase();
      if (q) {
        const hay = [s.title, s.description ?? "", ...s.contactNames].map((x) => x.toLowerCase());
        if (!hay.some((h) => h.includes(q))) return false;
      }
      if (f.kinds?.length && !f.kinds.includes(s.actionKind)) return false;
      if (f.sources?.length && !f.sources.some((src) => sourceMatch(s, src))) return false;
      if (f.contactId && s.contactId !== f.contactId) return false;
      return true;
    });
    matches.sort((a, b) => {
      if (done) {
        // Postgres text timestamps of one offset compare correctly as strings.
        if (a.createdAtText !== b.createdAtText) return a.createdAtText < b.createdAtText ? 1 : -1;
        return a.id < b.id ? 1 : -1;
      }
      const ad = dueDayOf(a.dueDate, f.tz) ?? "9999-99-99";
      const bd = dueDayOf(b.dueDate, f.tz) ?? "9999-99-99";
      if (ad !== bd) return ad < bd ? -1 : 1;
      const at = a.dueDate?.getTime() ?? Infinity;
      const bt = b.dueDate?.getTime() ?? Infinity;
      if (at !== bt) return at < bt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    return matches.map((s) => s.id);
  }

  async function walk(f: RemindersPageFilters, pageSize: number) {
    const seen: string[] = [];
    let cursor: string | undefined;
    let total: number | null = null;
    for (let pages = 0; ; pages++) {
      if (pages > 200) throw new Error("cursor never terminated");
      const page = await queryRemindersPage(appDb, USER, { ...f, cursor, limit: pageSize }, {
        inboxId: inbox.id,
        now: NOW,
      });
      if (pages === 0) total = page.total;
      else if (page.total !== null) throw new Error("total computed on a continuation page");
      seen.push(...page.items.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return { seen, total };
  }

  const views: Array<{ label: string; f: Omit<RemindersPageFilters, "tz"> }> = [
    ...(["today", "upcoming", "anytime", "done"] as ReminderView[]).map((view) => ({
      label: `view=${view}`,
      f: { view, listId: null },
    })),
    { label: "list=Inbox (includes unfiled rows)", f: { view: null, listId: inbox.id } },
    { label: "list=Work", f: { view: null, listId: work.id } },
    { label: "q=alex (contact preferred name)", f: { view: "upcoming", listId: null, q: "alex" } },
    { label: "q=100% (LIKE metachar is literal)", f: { view: "today", listId: null, q: "100%" } },
    // An unescaped `_` would also match the "Budget review" rows.
    { label: "q=budget_review (underscore is literal)", f: { view: null, listId: work.id, q: "budget_review" } },
    { label: "kinds=call,email", f: { view: "today", listId: null, kinds: ["call", "email"] } },
    { label: "sources=notes", f: { view: "upcoming", listId: null, sources: ["notes"] } },
    { label: "sources=manual,auto", f: { view: null, listId: work.id, sources: ["manual", "auto"] } },
    { label: "contact=Priya", f: { view: "today", listId: null, contactId: people[1].id } },
  ];

  for (const tz of ZONES) {
    console.log(`\ntz: ${tz} (today = ${ymdInZone(NOW, tz)})`);
    for (const { label, f } of views) {
      const filters = { ...f, tz };
      const want = expected(filters);
      for (const size of [7, 50]) {
        const { seen, total } = await walk(filters, size);
        const same = seen.length === want.length && seen.every((id, i) => id === want[i]);
        check(
          `${label} @${size}: ${seen.length} rows, reference order`,
          same,
          `got ${seen.length}, want ${want.length}; dupes ${seen.length - new Set(seen).size}`
        );
        check(`${label} @${size}: total = ${want.length}`, total === want.length, `total=${total}`);
      }
    }

    const { counts, pendingByList } = await queryReminderRailCounts(appDb, USER, {
      tz,
      inboxId: inbox.id,
      now: NOW,
    });
    const today = ymdInZone(NOW, tz);
    const pend = seeded.filter(isPending);
    const want = {
      today: pend.filter((s) => { const d = dueDayOf(s.dueDate, tz); return d !== null && d <= today; }).length,
      overdue: pend.filter((s) => { const d = dueDayOf(s.dueDate, tz); return d !== null && d < today; }).length,
      upcoming: pend.filter((s) => { const d = dueDayOf(s.dueDate, tz); return d !== null && d > today; }).length,
      anytime: pend.filter((s) => s.dueDate === null).length,
      done: seeded.filter(isDone).length,
      suggested: 0,
    };
    check(`rail counts`, JSON.stringify(counts) === JSON.stringify(want),
      `got ${JSON.stringify(counts)}\n       want ${JSON.stringify(want)}`);
    check(
      `list counts (unfiled rows count as Inbox)`,
      pendingByList.get(inbox.id) === pend.filter((s) => s.listId === inbox.id || s.listId === null).length &&
        pendingByList.get(work.id) === pend.filter((s) => s.listId === work.id).length
    );
    check(
      "view totals partition every pending reminder",
      want.today + want.upcoming + want.anytime === pend.length
    );
  }

  console.log("\ncursor hygiene");
  const first = await queryRemindersPage(appDb, USER, { view: "today", listId: null, tz: "UTC", limit: 5 }, { inboxId: inbox.id, now: NOW });
  const crossed = await queryRemindersPage(
    appDb, USER,
    { view: "done", listId: null, tz: "UTC", limit: 5, cursor: first.nextCursor ?? undefined },
    { inboxId: inbox.id, now: NOW }
  );
  check("an active-view cursor handed to Done starts over", crossed.total !== null);
  const garbage = await queryRemindersPage(appDb, USER, { view: "today", listId: null, tz: "UTC", cursor: "%%%not-base64" }, { inboxId: inbox.id, now: NOW });
  check("a malformed cursor starts over rather than throwing", garbage.total !== null);

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall reminders-page checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
