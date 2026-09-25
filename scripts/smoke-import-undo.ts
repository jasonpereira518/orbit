/**
 * Undo removes the people an import created — and nobody else.
 *
 * The rule cannot lean on `contacts.updated_at`: system writes (the avatar backfill, the brief
 * writer) bump it minutes after every import. So a person is removable only when they carry no
 * user-authored trace AND still hash to what the import wrote.
 *
 * The other half of that, and the easier half to get wrong: an import's OWN writes are not a
 * user trace. Every contact-creating adapter tags the people it creates, and the address-book
 * adapter writes notes from the source file, so the cases below seed both and assert those
 * people are still removable — a rule that counts them removes nobody, for any real import.
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
import { CONTACTS_FILE_IMPORT_TYPE } from "../src/lib/import-adapters/contacts-file";
import { LINKEDIN_IMPORT_TYPE } from "../src/lib/import-adapters/linkedin-connections";
import { fingerprintContact } from "../src/lib/imports/import-provenance";
import {
  MAX_UNDO_CANDIDATES,
  performUndo,
  previewUndo,
  UNDO_WINDOW_DAYS,
} from "../src/lib/imports/import-undo";
import { listContactsPage } from "../src/lib/contacts-page-query";

const USER = "smoke-import-undo-user";
const OTHER = "smoke-import-undo-other";
const NOW = new Date("2026-09-22T12:00:00Z");
/** The moment the engine froze as this import's last write. */
const RUN_END = new Date("2026-09-22T12:05:00Z");
const DURING_RUN = new Date("2026-09-22T12:02:00Z");
const AFTER_RUN = new Date("2026-09-22T13:00:00Z");
/** An admin retry bumping `imports.updated_at` long after the run finished. */
const RETRIED_AT = new Date("2026-09-23T12:00:00Z");

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

type Person = {
  name: string;
  created: boolean;
  company?: string | null;
  /** Notes the import's own payload carries — address-book imports write these on create. */
  notes?: string;
  /** The contact row's `created_at`. Defaults to the import's, like a real created row. */
  createdAt?: Date;
  /** Further columns the import wrote, for the fingerprint's round trip. */
  fields?: Partial<
    Pick<
      typeof contacts.$inferInsert,
      "title" | "email" | "linkedinUrl" | "location" | "school" | "phone" | "website" | "xHandle"
    >
  >;
};

/** A payload the real adapter for this import type can actually read. */
function payloadFor(importType: string, p: Person, index: number) {
  const [firstName, ...rest] = p.name.split(" ");
  const lastName = rest.join(" ");
  if (importType === CONTACTS_FILE_IMPORT_TYPE) {
    return {
      kind: "contacts_file_contact",
      fullName: p.name,
      firstName,
      lastName,
      company: p.company ?? "",
      title: "",
      email: "",
      phone: "",
      linkedinUrl: "",
      notes: p.notes ?? "",
    };
  }
  return {
    kind: "linkedin_connection",
    index,
    firstName,
    lastName,
    company: p.company ?? "",
    position: "",
    url: "",
    email: "",
    connectedOn: "",
  };
}

/** One import with one staged row per person, stamped the way the engine stamps them. */
async function seedImport(
  userId: string,
  people: Person[],
  opts: { createdAt?: Date; importType?: string; runEndedAt?: Date; updatedAt?: Date } = {},
) {
  const db = await getDb();
  const createdAt = opts.createdAt ?? NOW;
  const importType = opts.importType ?? LINKEDIN_IMPORT_TYPE;
  const [imp] = await db
    .insert(imports)
    .values({
      userId,
      importType,
      status: "completed",
      createdAt,
      updatedAt: opts.updatedAt ?? createdAt,
      totalRows: people.length,
      stats: opts.runEndedAt ? { runEndedAt: opts.runEndedAt.toISOString() } : {},
    })
    .returning();
  const ids: string[] = [];
  for (const [i, p] of people.entries()) {
    const [c] = await db
      .insert(contacts)
      .values({
        userId,
        fullName: p.name,
        company: p.company ?? null,
        notes: p.notes ?? null,
        ...p.fields,
        createdAt: p.createdAt ?? createdAt,
      })
      .returning();
    ids.push(c.id);
    await db.insert(importJobRows).values({
      importId: imp.id,
      userId,
      rowIndex: i,
      status: "done",
      contactId: c.id,
      payload: {
        ...payloadFor(importType, p, i),
        // The PERSISTED contact, exactly as `import-engine.ts` now hashes it.
        importedBy: p.created ? { created: true, fp: fingerprintContact(c) } : { created: false },
      } as never,
    });
  }
  return { importId: imp.id, ids };
}

async function main() {
  await reset();
  await ensureUserSettings(USER);
  const db = await getDb();

  const { importId, ids } = await seedImport(
    USER,
    [
      { name: "Untouched One", created: true },
      { name: "Untouched Two", created: true },
      { name: "Tagged Person", created: true },
      { name: "Noted Person", created: true },
      { name: "Reminded Person", created: true },
      { name: "Talked To", created: true },
      { name: "Edited Person", created: true, company: "Stripe" },
      { name: "Merged Person", created: false },
      { name: "Import Tagged", created: true },
      { name: "Synced Before", created: true },
      { name: "Synced After", created: true },
    ],
    // `updatedAt` deliberately long after the run — an admin retry bumps it that way
    // (`admin-operations.ts`). The frozen `runEndedAt` has to win, or every interaction
    // logged between the two reads as the import's own and its person gets deleted.
    { runEndedAt: RUN_END, updatedAt: RETRIED_AT },
  );
  const [untouchedA, untouchedB, tagged, noted, reminded, talked, edited, merged, importTagged, syncedBefore, syncedAfter] =
    ids;

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

  // The import's own tag. Every contact-creating adapter applies one ("linkedin" here), so a
  // rule that reads this as a user trace makes every real import un-undoable.
  const [ownTag] = await db.insert(tags).values({ userId: USER, name: "linkedin" }).returning();
  await db.insert(contactTags).values({ contactId: importTagged, tagId: ownTag.id });

  // Both arms of the `runEndedAt` boundary. Both carry an external id, so neither is caught by
  // the "no external id" arm — only the date tells them apart.
  await db.insert(interactions).values({
    userId: USER,
    contactId: syncedBefore,
    interactionType: "meeting",
    interactionDate: NOW,
    externalId: "cal:during-the-run",
    createdAt: DURING_RUN,
  });
  await db.insert(interactions).values({
    userId: USER,
    contactId: syncedAfter,
    interactionType: "meeting",
    interactionDate: NOW,
    externalId: "cal:after-the-run",
    createdAt: AFTER_RUN,
  });

  const preview = await previewUndo(USER, importId, NOW);
  check("preview exists", Boolean(preview));
  check("in the window", preview!.withinWindow);
  check("not yet undone", preview!.alreadyUndone === false);
  check("exact, because rows carry fingerprints", preview!.exact);
  check("four are removable", preview!.removable === 4, String(preview!.removable));
  check("six are kept", preview!.keeping === 6, String(preview!.keeping));
  const reasonFor = (id: string) => preview!.candidates.find((c) => c.contactId === id)?.reason;
  const removableOf = (id: string) => preview!.candidates.find((c) => c.contactId === id)?.removable;
  check("tagged is kept for its tag", reasonFor(tagged) === "tagged");
  check("noted is kept for its note", reasonFor(noted) === "noted");
  check("reminded is kept for its reminder", reasonFor(reminded) === "reminded");
  check("talked-to is kept for its interaction", reasonFor(talked) === "interacted");
  check("edited is kept for its changed fields", reasonFor(edited) === "edited");
  check("merged is not a candidate at all", !preview!.candidates.some((c) => c.contactId === merged));
  check("the import's own tag is not a user trace", removableOf(importTagged) === true, String(reasonFor(importTagged)));
  check("an interaction from inside the run is the import's own", removableOf(syncedBefore) === true, String(reasonFor(syncedBefore)));
  check("an interaction after the run counts", reasonFor(syncedAfter) === "interacted");
  check("…even though updated_at was bumped past it", reasonFor(syncedAfter) === "interacted");

  const done = await performUndo(USER, importId, NOW);
  check("removed the four untouched people", done.removed === 4, JSON.stringify(done));
  check("…and finished", done.done && done.remaining === 0, JSON.stringify(done));
  const left = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
  const leftIds = new Set(left.map((c) => c.id));
  check(
    "the untouched are gone",
    ![untouchedA, untouchedB, importTagged, syncedBefore].some((id) => leftIds.has(id)),
  );
  for (const [label, id] of [["tagged", tagged], ["noted", noted], ["reminded", reminded], ["talked to", talked], ["edited", edited], ["merged", merged], ["synced after", syncedAfter]] as const) {
    check(`${label} survived`, leftIds.has(id));
  }

  const again = await performUndo(USER, importId, NOW);
  check("a second undo removes nothing", again.removed === 0);
  const after = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  check("the import records the undo", Boolean(after?.stats?.undoneAt));
  check("…and how many went", after?.stats?.undoneRemoved === 4, JSON.stringify(after?.stats));
  check("…without losing the frozen run end", after?.stats?.runEndedAt === RUN_END.toISOString());
  const undonePreview = await previewUndo(USER, importId, NOW);
  check("an undone import says so", undonePreview!.alreadyUndone === true);
  check("…and offers no second undo", undonePreview!.withinWindow === false);

  // Every field the fingerprint covers, filled in, and each one edited on its own. A person
  // whose only change was a new city or phone number used to hash as untouched — the
  // fingerprint covered five fields — and undo deleted them with the edit. And the untouched
  // one guards the other direction: if `decide()` forgot to read back a field the engine
  // hashed, every person carrying one would read "edited" and undo would remove nobody.
  const WIDE = {
    title: "Engineer",
    email: "wide@example.com",
    linkedinUrl: "https://www.linkedin.com/in/wide",
    location: "Toronto, Canada",
    school: "University of Waterloo",
    phone: "+1 416 555 0100",
    website: "https://wide.example",
    xHandle: "wide",
  };
  const EDITS = {
    location: "Montreal, Canada",
    school: "McGill University",
    phone: "+1 514 555 0199",
    website: "https://moved.example",
    xHandle: "moved",
  } as const;
  const wide = await seedImport(
    USER,
    [
      { name: "Wide Untouched", created: true, fields: WIDE },
      ...Object.keys(EDITS).map((field) => ({
        name: `Wide ${field}`,
        created: true,
        fields: { ...WIDE, email: `${field}@example.com` },
      })),
    ],
    { runEndedAt: RUN_END },
  );
  const [wideUntouched, ...wideEdited] = wide.ids;
  for (const [i, [field, value]] of Object.entries(EDITS).entries()) {
    await db.update(contacts).set({ [field]: value }).where(eq(contacts.id, wideEdited[i]));
  }
  const widePreview = await previewUndo(USER, wide.importId, NOW);
  const wideCandidate = (id: string) => widePreview!.candidates.find((c) => c.contactId === id);
  check(
    "a person carrying every fingerprinted field, untouched, is removable",
    wideCandidate(wideUntouched)?.removable === true,
    String(wideCandidate(wideUntouched)?.reason),
  );
  for (const [i, field] of Object.keys(EDITS).entries()) {
    check(
      `a person whose only edit was their ${field} is kept as edited`,
      wideCandidate(wideEdited[i])?.removable === false &&
        wideCandidate(wideEdited[i])?.reason === "edited",
      JSON.stringify(wideCandidate(wideEdited[i])),
    );
  }
  const wideDone = await performUndo(USER, wide.importId, NOW);
  check("undo removes only the untouched one", wideDone.removed === 1, JSON.stringify(wideDone));
  const wideLeft = new Set(
    (await db.query.contacts.findMany({ where: inArray(contacts.id, wide.ids) })).map((c) => c.id),
  );
  check("…and every edited person is still here", wideEdited.every((id) => wideLeft.has(id)));
  check("…and the untouched one is not", !wideLeft.has(wideUntouched));

  // An address-book import writes `notes` from the source file on create. Those are the
  // import's words, not the user's.
  const book = await seedImport(
    USER,
    [
      { name: "Address Book Person", created: true, notes: "From the address book" },
      { name: "Rewritten Note", created: true, notes: "From the address book" },
    ],
    { importType: CONTACTS_FILE_IMPORT_TYPE, runEndedAt: RUN_END },
  );
  const [bookUntouched, bookRewritten] = book.ids;
  await db.update(contacts).set({ notes: "My own words" }).where(eq(contacts.id, bookRewritten));
  const bookPreview = await previewUndo(USER, book.importId, NOW);
  const bookCandidate = (id: string) => bookPreview!.candidates.find((c) => c.contactId === id);
  check(
    "notes the import itself wrote are not a user trace",
    bookCandidate(bookUntouched)?.removable === true,
    String(bookCandidate(bookUntouched)?.reason),
  );
  check("…but notes the user rewrote are", bookCandidate(bookRewritten)?.reason === "noted");

  // Another user's import is invisible.
  const foreign = await seedImport(OTHER, [{ name: "Not Yours", created: true }]);
  check("another user gets no preview", (await previewUndo(USER, foreign.importId, NOW)) === null);
  check("…and no removal", (await performUndo(USER, foreign.importId, NOW)).removed === 0);
  const theirs = await db.query.contacts.findMany({ where: eq(contacts.userId, OTHER) });
  check("…their person is untouched", theirs.length === 1);

  // Outside the window.
  const old = await seedImport(USER, [{ name: "Old Import Person", created: true }], {
    createdAt: new Date("2026-09-01T12:00:00Z"),
  });
  const oldPreview = await previewUndo(USER, old.importId, NOW);
  check(`older than ${UNDO_WINDOW_DAYS} days is out of the window`, oldPreview!.withinWindow === false);
  check("…which is not the same as undone", oldPreview!.alreadyUndone === false);
  check("…and performing it removes nothing", (await performUndo(USER, old.importId, NOW)).removed === 0);

  // A Drive import saves through Capture's note path, not the engine, so its rows are not a
  // record of who it created. Undo refuses it outright rather than guessing from them.
  const drive = await seedImport(USER, [{ name: "Named In A Doc", created: true }], {
    importType: "drive_docs",
    runEndedAt: RUN_END,
  });
  check("a Drive import gets no undo preview", (await previewUndo(USER, drive.importId, NOW)) === null);
  check("…and undoing it removes nobody", (await performUndo(USER, drive.importId, NOW)).removed === 0);
  check(
    "…so the person it brought in is still here",
    Boolean(await db.query.contacts.findFirst({ where: eq(contacts.id, drive.ids[0]) })),
  );

  // A pre-fingerprint import: rows with no provenance fall back to created-after-the-import,
  // so a person who already existed before it ran is not one of its candidates.
  const legacy = await seedImport(USER, [
    { name: "Legacy Person", created: true },
    { name: "Predates The Import", created: true, createdAt: new Date("2026-09-20T12:00:00Z") },
  ]);
  await db
    .update(importJobRows)
    .set({ payload: { kind: "linkedin_connection" } as never })
    .where(eq(importJobRows.importId, legacy.importId));
  const legacyPreview = await previewUndo(USER, legacy.importId, NOW);
  check("legacy rows still produce a candidate", legacyPreview!.candidates.length === 1, String(legacyPreview!.candidates.length));
  check("…the one created with the import", legacyPreview!.candidates[0]?.contactId === legacy.ids[0]);
  check("…and not one that predates it", !legacyPreview!.candidates.some((c) => c.contactId === legacy.ids[1]));
  check("…but the preview is not exact", legacyPreview!.exact === false);

  // A budget-exhausted run stops cleanly, records nothing final, and resumes.
  const big = await seedImport(USER, [
    { name: "Resume One", created: true },
    { name: "Resume Two", created: true },
  ]);
  const stopped = await performUndo(USER, big.importId, NOW, { budgetMs: 0 });
  check("an exhausted budget removes nobody", stopped.removed === 0, JSON.stringify(stopped));
  check("…reports itself unfinished", stopped.done === false && stopped.remaining === 2, JSON.stringify(stopped));
  const midway = await db.query.imports.findFirst({ where: eq(imports.id, big.importId) });
  check("…and does not close the undo", !midway?.stats?.undoneAt);
  const resumed = await performUndo(USER, big.importId, NOW);
  check("a resumed undo finishes the job", resumed.removed === 2 && resumed.done, JSON.stringify(resumed));
  const bigAfter = await db.query.imports.findFirst({ where: eq(imports.id, big.importId) });
  check("…and the count carries across both runs", bigAfter?.stats?.undoneRemoved === 2, JSON.stringify(bigAfter?.stats));

  // `undoImport` (src/actions/imports.ts) loops on `performUndo` while `done` is false,
  // accumulating `removed` across calls — it can't be exercised here itself, since it opens
  // with `requireUserId()`, so this proves the same loop shape directly against `performUndo`:
  // a first call that exhausts its budget instantly (`budgetMs: 0`, so `done` is false and
  // nothing is removed) followed by calls that keep going until `done` — mirrors a real
  // import too large for one internal budget, but resolved in more than one round trip.
  const loopy = await seedImport(USER, [
    { name: "Loop One", created: true },
    { name: "Loop Two", created: true },
    { name: "Loop Three", created: true },
  ]);
  let loopRemoved = 0;
  let loopResult = await performUndo(USER, loopy.importId, NOW, { budgetMs: 0 });
  let loopIterations = 1;
  check("the first call makes no progress", loopResult.removed === 0 && !loopResult.done, JSON.stringify(loopResult));
  while (!loopResult.done) {
    loopRemoved += loopResult.removed;
    loopResult = await performUndo(USER, loopy.importId, NOW);
    loopIterations += 1;
  }
  loopRemoved += loopResult.removed;
  check("looping on `done` removes everyone", loopRemoved === 3, String(loopRemoved));
  check("…finishes with nobody left", loopResult.done && loopResult.remaining === 0, JSON.stringify(loopResult));
  check("…having actually looped, not just called once", loopIterations > 1, String(loopIterations));

  // The candidate list is capped; the counts are not.
  const many: Person[] = Array.from({ length: MAX_UNDO_CANDIDATES + 5 }, (_, i) => ({
    name: `Crowd ${i}`,
    created: true,
  }));
  const crowd = await seedImport(USER, many);
  await db.insert(contactTags).values([
    { contactId: crowd.ids[0], tagId: tag.id },
    { contactId: crowd.ids[1], tagId: tag.id },
  ]);
  const crowdPreview = await previewUndo(USER, crowd.importId, NOW);
  check(
    `the list is capped at ${MAX_UNDO_CANDIDATES}`,
    crowdPreview!.candidates.length === MAX_UNDO_CANDIDATES,
    String(crowdPreview!.candidates.length),
  );
  check("…while the counts stay exact", crowdPreview!.removable === MAX_UNDO_CANDIDATES + 3 && crowdPreview!.keeping === 2, JSON.stringify({ removable: crowdPreview!.removable, keeping: crowdPreview!.keeping }));
  check("…and the kept survive the cap", crowdPreview!.candidates.slice(0, 2).every((c) => !c.removable));

  // The contacts list can be narrowed to one import's people — the people it ADDED, because
  // that is the number the done card's button says ("Meet your 2 new people"). A filter that
  // also returned the people the import merged into turned "Meet your 100 new people" into a
  // list of 3,000 on a LinkedIn re-import.
  const { importId: filterImport, ids: filterIds } = await seedImport(USER, [
    { name: "Filter One", created: true },
    { name: "Filter Two", created: true },
    // Matched to someone already here: the import touched them, but did not add them.
    { name: "Filter Matched", created: false, createdAt: new Date("2026-09-10T12:00:00Z") },
    // Stamped as merged although the contact row is no older than the import — someone
    // created elsewhere mid-run and then matched by it. The engine's own stamp wins over
    // the timestamp guess.
    { name: "Filter Matched Midrun", created: false },
  ]);
  const filterAdded = filterIds.slice(0, 2);
  const filterMerged = filterIds.slice(2);
  await db.insert(contacts).values({ userId: USER, fullName: "Not From An Import" });
  // "Meet your N new people" opens everyone, with the N marked — not a list of only them.
  // Every page, by cursor: the list is paged, and the marks must ride along on each page the
  // infinite scroll loads — not just the first.
  type Listed = { items: Awaited<ReturnType<typeof listContactsPage>>["items"]; total: number | null };
  const everyPage = async (
    userId: string,
    filters: Parameters<typeof listContactsPage>[1] = {},
  ): Promise<Listed> => {
    const first = await listContactsPage(userId, { ...filters, limit: 50 });
    const items = [...first.items];
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await listContactsPage(userId, { ...filters, limit: 50, cursor });
      items.push(...next.items);
      cursor = next.nextCursor;
    }
    return { items, total: first.total };
  };
  const marked = (page: Listed) => page.items.filter((c) => c.fromImport).map((c) => c.id);
  const listed = await everyPage(USER, { importId: filterImport });
  const unfiltered = await everyPage(USER);
  check(
    "the import's link lists everyone, not only its people",
    listed.items.length === unfiltered.items.length && listed.total === unfiltered.total,
    `${listed.items.length} of ${unfiltered.items.length}`,
  );
  check("it marks exactly the people that import added", marked(listed).length === 2, String(marked(listed).length));
  check("…and they are the right two", marked(listed).every((id) => filterAdded.includes(id)));
  check(
    "…never someone it merged into",
    !listed.items.some((c) => c.fromImport && filterMerged.includes(c.id)),
    listed.items.filter((c) => c.fromImport).map((c) => c.fullName).join(", "),
  );
  check("without an import nobody is marked", marked(unfiltered).length === 0);

  // Rows from before the provenance stamp fall back to the same rule the People list and the
  // undo use: created at or after the import.
  const legacyFilter = await seedImport(USER, [
    { name: "Legacy Added", created: true },
    { name: "Legacy Already Here", created: true, createdAt: new Date("2026-09-10T12:00:00Z") },
  ]);
  await db
    .update(importJobRows)
    .set({ payload: { kind: "linkedin_connection" } as never })
    .where(eq(importJobRows.importId, legacyFilter.importId));
  const legacyListed = await everyPage(USER, { importId: legacyFilter.importId });
  check(
    "an unstamped import marks the people created with it",
    marked(legacyListed).length === 1 && marked(legacyListed)[0] === legacyFilter.ids[0],
    marked(legacyListed).join(", "),
  );

  // …and a whole run's, because one drop is one done card and its button promises everyone
  // the run added, across every file in it.
  const { importId: secondImport, ids: secondIds } = await seedImport(USER, [
    { name: "Second File One", created: true },
  ]);
  const bothListed = await everyPage(USER, { importId: `${filterImport},${secondImport}` });
  check("two imports' people are marked together", marked(bothListed).length === 3, String(marked(bothListed).length));
  check(
    "…and they are exactly those three",
    marked(bothListed).every((id) => [...filterAdded, ...secondIds].includes(id)),
  );
  // A hand-typed id would fail the uuid cast and take the whole page down with it.
  const junk = await everyPage(USER, { importId: "not-an-id" });
  check(
    "a forged id marks nobody rather than erroring",
    marked(junk).length === 0 && junk.items.length === (await everyPage(USER)).items.length,
  );
  const mixed = await everyPage(USER, { importId: `not-an-id,${secondImport}` });
  check("…and a good id beside it still works", marked(mixed).length === 1);
  const theirView = await everyPage(OTHER, { importId: filterImport });
  check("another account's import marks nobody for this one", marked(theirView).length === 0);

  await reset();
  console.log("smoke-import-undo: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  process.exit(1);
});
