/**
 * The Granola page's activity read (`granolaActivity` in `src/lib/connectors/granola.ts`)
 * against a throwaway PGlite: totals count notes and people, recent notes group their people
 * and take their title from the saved note text, and nothing else leaks in.
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, noteBatches } from "../src/db/schema";
import { granolaActivity } from "../src/lib/connectors/granola";
import { checker } from "./smoke/check";

const t = checker();
const USER = `smoke-granola-${randomUUID()}`;
const OTHER = `smoke-granola-other-${randomUUID()}`;

async function main() {
  const db = await getDb();
  const person = (userId: string, fullName: string) =>
    db.insert(contacts).values({ userId, fullName }).returning().then((r) => r[0]!.id);
  const batch = (userId: string, title: string) =>
    db
      .insert(noteBatches)
      .values({
        userId,
        sourceHash: randomUUID(),
        sourceText: `Meeting: ${title}\n\nWhen: …`,
        anchorDate: new Date(),
        result: {} as never,
      })
      .returning()
      .then((r) => r[0]!.id);
  const log = (userId: string, contactId: string, externalId: string, at: string, source = "granola", noteBatchId?: string) =>
    db.insert(interactions).values({ userId, contactId, externalId, source, interactionDate: new Date(at), noteBatchId });

  const ana = await person(USER, "Ana Fox");
  const pat = await person(USER, "Pat Kim");
  const sam = await person(USER, "Sam Lee");
  const older = await batch(USER, "Older chat");
  const newer = await batch(USER, "Pat & Ana sync");
  await log(USER, ana, `granola:n1:${ana}`, "2026-10-29T15:00:00Z", "granola", older);
  await log(USER, ana, `granola:n2:${ana}`, "2026-10-30T20:00:00Z", "granola", newer);
  await log(USER, pat, `granola:n2:${pat}`, "2026-10-30T20:00:00Z", "granola", newer);
  // Not Granola's: a capture, and another account's Granola note.
  await log(USER, sam, `notes:abc:${sam}`, "2026-10-31T10:00:00Z", "capture");
  const stranger = await person(OTHER, "Stranger");
  await log(OTHER, stranger, `granola:n9:${stranger}`, "2026-10-31T10:00:00Z");

  const a = await granolaActivity(USER);
  t.check("two notes synced", a.notes === 2, String(a.notes));
  t.check("two people updated (Ana counted once)", a.people === 2, String(a.people));
  t.check("newest note first", a.recent[0]?.noteId === "n2", JSON.stringify(a.recent.map((n) => n.noteId)));
  t.check("title from the saved note text", a.recent[0]?.title === "Pat & Ana sync", a.recent[0]?.title);
  t.check(
    "a note lists each person it updated once",
    a.recent[0]?.people.map((p) => p.name).sort().join(",") === "Ana Fox,Pat Kim",
    JSON.stringify(a.recent[0]?.people),
  );
  t.check("captures and other accounts are left out", !a.recent.some((n) => n.noteId === "abc" || n.noteId === "n9"));
  t.check("an account with nothing synced reads empty", (await granolaActivity(`nobody-${randomUUID()}`)).notes === 0);

  for (const u of [USER, OTHER]) {
    await db.delete(interactions).where(eq(interactions.userId, u));
    await db.delete(noteBatches).where(eq(noteBatches.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }
  t.done("granola activity smoke tests");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
