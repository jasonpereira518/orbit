/**
 * Undo removes the people an import created — and nobody else.
 *
 * The rule cannot lean on `contacts.updated_at`: system writes (the avatar backfill, the brief
 * writer) bump it minutes after every import. So a person is removable only when they carry no
 * user-authored trace AND still hash to what the import wrote.
 *
 * Run: npx tsx scripts/smoke-import-undo.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contactTags,
  contacts,
  importJobRows,
  imports,
  interactions,
  reminders,
  tags,
} from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { fingerprintContact } from "../src/lib/imports/import-provenance";
import { performUndo, previewUndo, UNDO_WINDOW_DAYS } from "../src/lib/imports/import-undo";

const USER = "smoke-import-undo-user";
const OTHER = "smoke-import-undo-other";
const NOW = new Date("2026-09-22T12:00:00Z");

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(reminders).where(inArray(reminders.userId, [USER, OTHER]));
  await db.delete(interactions).where(inArray(interactions.userId, [USER, OTHER]));
  await db.delete(contacts).where(inArray(contacts.userId, [USER, OTHER]));
  await db.delete(imports).where(inArray(imports.userId, [USER, OTHER]));
  await db.delete(tags).where(inArray(tags.userId, [USER, OTHER]));
}

/** One import with one staged row per person, stamped the way the engine stamps them. */
async function seedImport(
  userId: string,
  people: { name: string; created: boolean; company?: string | null }[],
  createdAt = NOW,
) {
  const db = await getDb();
  const [imp] = await db
    .insert(imports)
    .values({ userId, importType: "linkedin_connections", status: "completed", createdAt, totalRows: people.length })
    .returning();
  const ids: string[] = [];
  for (const [i, p] of people.entries()) {
    const [c] = await db
      .insert(contacts)
      .values({ userId, fullName: p.name, company: p.company ?? null, createdAt })
      .returning();
    ids.push(c.id);
    await db.insert(importJobRows).values({
      importId: imp.id,
      userId,
      rowIndex: i,
      status: "done",
      contactId: c.id,
      payload: {
        kind: "linkedin_connection",
        importedBy: p.created
          ? { created: true, fp: fingerprintContact({ fullName: p.name, company: p.company ?? null }) }
          : { created: false },
      } as never,
    });
  }
  return { importId: imp.id, ids };
}

async function main() {
  await reset();
  await ensureUserSettings(USER);
  const db = await getDb();

  const { importId, ids } = await seedImport(USER, [
    { name: "Untouched One", created: true },
    { name: "Untouched Two", created: true },
    { name: "Tagged Person", created: true },
    { name: "Noted Person", created: true },
    { name: "Reminded Person", created: true },
    { name: "Talked To", created: true },
    { name: "Edited Person", created: true, company: "Stripe" },
    { name: "Merged Person", created: false },
  ]);
  const [untouchedA, untouchedB, tagged, noted, reminded, talked, edited, merged] = ids;

  const [tag] = await db.insert(tags).values({ userId: USER, name: "friends" }).returning();
  await db.insert(contactTags).values({ contactId: tagged, tagId: tag.id });
  await db.update(contacts).set({ notes: "Met at a conference" }).where(eq(contacts.id, noted));
  await db.insert(reminders).values({ userId: USER, contactId: reminded, title: "Say hi" });
  // `interactionDate`, not `occurredAt` — see the table in src/db/schema.ts. No `externalId`,
  // which is exactly what makes this one user-authored rather than an import's own row.
  await db
    .insert(interactions)
    .values({ userId: USER, contactId: talked, interactionType: "call", interactionDate: NOW });
  await db.update(contacts).set({ company: "Shopify" }).where(eq(contacts.id, edited));

  const preview = await previewUndo(USER, importId, NOW);
  check("preview exists", Boolean(preview));
  check("in the window", preview!.withinWindow);
  check("exact, because rows carry fingerprints", preview!.exact);
  check("two are removable", preview!.removable === 2, String(preview!.removable));
  check("five are kept", preview!.keeping === 5, String(preview!.keeping));
  const reasonFor = (id: string) => preview!.candidates.find((c) => c.contactId === id)?.reason;
  check("tagged is kept for its tag", reasonFor(tagged) === "tagged");
  check("noted is kept for its note", reasonFor(noted) === "noted");
  check("reminded is kept for its reminder", reasonFor(reminded) === "reminded");
  check("talked-to is kept for its interaction", reasonFor(talked) === "interacted");
  check("edited is kept for its changed fields", reasonFor(edited) === "edited");
  check("merged is not a candidate at all", !preview!.candidates.some((c) => c.contactId === merged));

  const done = await performUndo(USER, importId, NOW);
  check("removed both untouched people", done.removed === 2, JSON.stringify(done));
  const left = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
  const leftIds = new Set(left.map((c) => c.id));
  check("the untouched are gone", !leftIds.has(untouchedA) && !leftIds.has(untouchedB));
  for (const [label, id] of [["tagged", tagged], ["noted", noted], ["reminded", reminded], ["talked to", talked], ["edited", edited], ["merged", merged]] as const) {
    check(`${label} survived`, leftIds.has(id));
  }

  const again = await performUndo(USER, importId, NOW);
  check("a second undo removes nothing", again.removed === 0);
  const after = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  check("the import records the undo", Boolean(after?.stats?.undoneAt));
  check("…and how many went", after?.stats?.undoneRemoved === 2, JSON.stringify(after?.stats));

  // Another user's import is invisible.
  const foreign = await seedImport(OTHER, [{ name: "Not Yours", created: true }]);
  check("another user gets no preview", (await previewUndo(USER, foreign.importId, NOW)) === null);
  check("…and no removal", (await performUndo(USER, foreign.importId, NOW)).removed === 0);
  const theirs = await db.query.contacts.findMany({ where: eq(contacts.userId, OTHER) });
  check("…their person is untouched", theirs.length === 1);

  // Outside the window.
  const old = await seedImport(USER, [{ name: "Old Import Person", created: true }], new Date("2026-09-01T12:00:00Z"));
  const oldPreview = await previewUndo(USER, old.importId, NOW);
  check(`older than ${UNDO_WINDOW_DAYS} days is out of the window`, oldPreview!.withinWindow === false);
  check("…and performing it removes nothing", (await performUndo(USER, old.importId, NOW)).removed === 0);

  // A pre-fingerprint import: rows with no provenance fall back to created-after-the-import.
  const legacy = await seedImport(USER, [{ name: "Legacy Person", created: true }]);
  await db
    .update(importJobRows)
    .set({ payload: { kind: "linkedin_connection" } as never })
    .where(eq(importJobRows.importId, legacy.importId));
  const legacyPreview = await previewUndo(USER, legacy.importId, NOW);
  check("legacy rows still produce a candidate", legacyPreview!.candidates.length === 1);
  check("…but the preview is not exact", legacyPreview!.exact === false);

  await reset();
  console.log("smoke-import-undo: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  process.exit(1);
});
