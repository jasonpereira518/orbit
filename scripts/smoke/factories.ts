/**
 * Fixtures for smoke scripts: realistic, deterministic, and obviously fake.
 *
 *   import { fakeUserId, makeContact, insertContact, purgeUsers } from "./smoke/factories";
 *
 * Everything here is invented. Names come from a fixed list, every email is on a reserved
 * `.test` / `example.com` domain (RFC 2606), every phone number is in the 555-01xx block,
 * and no value is ever read from the environment — so a fixture can never be a real person
 * or a real credential, and a script's output is the same on every run.
 *
 * The `make*` builders are pure (plain objects, for unit tests and mocked responses). The
 * `insert*` helpers write through `getDb()`, so they belong only in `pglite`-tier scripts,
 * which start with `import "./smoke/_env"`. This module never imports `../src/db` itself —
 * the caller passes its `db` in — so a pure script can import the builders without being
 * moved to the pglite tier by run-smoke's structural guard.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { getDb } from "../../src/db";
import { contacts, interactions, reminders } from "../../src/db/schema";

const FIRST = ["Ada", "Grace", "Alan", "Katherine", "Linus", "Margaret", "Dennis", "Barbara", "Ken", "Radia"];
const LAST = ["Lovelace", "Hopper", "Turing", "Johnson", "Torvalds", "Hamilton", "Ritchie", "Liskov", "Thompson", "Perlman"];
const COMPANIES = ["Acme Analytics", "Globex Labs", "Initech", "Umbrella Health", "Hooli", "Stark Robotics"];
const TITLES = ["Staff Engineer", "Head of Product", "Founder", "Investor", "Design Lead", "Recruiter"];

/** A tiny seeded PRNG (mulberry32), so a script that asks for "random" data gets the same data every run. */
export function seeded(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A user id unique to this run, prefixed so a leftover row is recognisable as test data.
 * Clerk ids look like `user_…`; these never collide with one because of the `smoke_` prefix.
 */
export function fakeUserId(label: string): string {
  return `smoke_${label}_${randomUUID().slice(0, 8)}`;
}

export type FakeContact = {
  fullName: string;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  location: string;
};

/** The n-th fake person. Deterministic: `makeContact(3)` is the same person on every run. */
export function makeContact(n = 0, overrides: Partial<FakeContact> = {}): FakeContact {
  const firstName = FIRST[n % FIRST.length];
  const lastName = LAST[Math.floor(n / FIRST.length + n) % LAST.length];
  const slug = `${firstName}.${lastName}`.toLowerCase();
  return {
    fullName: `${firstName} ${lastName}`,
    firstName,
    lastName,
    company: COMPANIES[n % COMPANIES.length],
    title: TITLES[n % TITLES.length],
    email: `${slug}${n > 9 ? n : ""}@example.com`,
    phone: `+1 202-555-01${String(n % 100).padStart(2, "0")}`,
    linkedinUrl: `https://www.linkedin.com/in/${slug.replace(".", "-")}-${n}`,
    location: "Springfield",
    ...overrides,
  };
}

/** A fake email message in the shape most mail mappers start from. */
export function makeEmail(n = 0, overrides: Partial<{ from: string; to: string[]; subject: string; body: string; date: Date }> = {}) {
  const sender = makeContact(n);
  return {
    from: `${sender.fullName} <${sender.email}>`,
    to: ["owner@orbit.test"],
    subject: `Coffee next week? (${n})`,
    body: `Hi! Great meeting you at the meetup. Want to grab coffee next Tuesday?\n\n${sender.firstName}`,
    date: new Date(Date.UTC(2026, 0, 1 + (n % 28), 15, 0, 0)),
    ...overrides,
  };
}

/** A fake calendar event with fake attendees. */
export function makeCalendarEvent(n = 0, attendees = 2) {
  const start = new Date(Date.UTC(2026, 1, 1 + (n % 28), 17, 0, 0));
  return {
    id: `evt_${n}`,
    title: `Intro call ${n}`,
    start,
    end: new Date(start.getTime() + 30 * 60_000),
    attendees: Array.from({ length: attendees }, (_, i) => makeContact(n + i + 1)).map((c) => ({
      name: c.fullName,
      email: c.email,
    })),
  };
}

// ---------------------------------------------------------------------------------------
// Database helpers (pglite tier only). `db` is whatever `await getDb()` returned.

type Db = Awaited<ReturnType<typeof getDb>>;

/** Inserts a contact for `userId` and returns the row. */
export async function insertContact(db: Db, userId: string, n = 0, overrides: Partial<typeof contacts.$inferInsert> = {}) {
  const c = makeContact(n);
  const [row] = await db
    .insert(contacts)
    .values({
      userId,
      fullName: c.fullName,
      firstName: c.firstName,
      lastName: c.lastName,
      company: c.company,
      title: c.title,
      email: c.email,
      phone: c.phone,
      linkedinUrl: c.linkedinUrl,
      ...overrides,
    })
    .returning();
  return row;
}

/** Inserts a note interaction on a contact and returns the row. */
export async function insertInteraction(
  db: Db,
  userId: string,
  contactId: string,
  overrides: Partial<typeof interactions.$inferInsert> = {}
) {
  const [row] = await db
    .insert(interactions)
    .values({ userId, contactId, interactionType: "note", rawNotes: "Talked about their new role and a possible intro.", ...overrides })
    .returning();
  return row;
}

/** Inserts a pending reminder (optionally on a contact) and returns the row. */
export async function insertReminder(
  db: Db,
  userId: string,
  contactId: string | null,
  overrides: Partial<typeof reminders.$inferInsert> = {}
) {
  const [row] = await db
    .insert(reminders)
    .values({ userId, contactId, title: "Follow up", dueDate: new Date(Date.UTC(2026, 2, 1)), ...overrides })
    .returning();
  return row;
}

/** Every table in the schema with a `user_id` column, read from the live database. */
export async function userOwnedTables(db: Db): Promise<string[]> {
  const res = await db.execute(
    sql`SELECT table_name FROM information_schema.columns WHERE column_name = 'user_id' AND table_schema = current_schema() ORDER BY table_name`
  );
  return rowsOf<{ table_name: string }>(res).map((r) => r.table_name);
}

/** Counts rows per user-owned table for `userId`; only tables with at least one row are returned. */
export async function rowCountsFor(db: Db, userId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of await userOwnedTables(db)) {
    const res = await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE user_id = ${userId}`);
    const n = Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0);
    if (n > 0) out[table] = n;
  }
  return out;
}

/**
 * Deletes every row the given users own, in every table with a `user_id` column. Child rows
 * go first by retrying: a foreign-key failure on one pass is cleared by a later pass once
 * its parent's children are gone.
 */
export async function purgeUsers(db: Db, userIds: string[]): Promise<void> {
  const ids = sql.join(
    userIds.map((u) => sql`${u}`),
    sql`, `
  );
  let pending = await userOwnedTables(db);
  for (let pass = 0; pass < 5 && pending.length > 0; pass++) {
    const failed: string[] = [];
    for (const table of pending) {
      try {
        await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE user_id IN (${ids})`);
      } catch {
        failed.push(table);
      }
    }
    pending = failed;
  }
}

/** `rowsOf` from src/db, duplicated so this module never imports the database client. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}
