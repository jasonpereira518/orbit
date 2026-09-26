/**
 * The grouped read/write paths that replaced per-row round trips in the memory sweep, the
 * LinkedIn timeline backfill and the recruiter-scan discovery, pinned against the
 * one-at-a-time behaviour they stand in for.
 *
 *   1. The memory sweep writes passages a group at a time (`syncMemoryChunksMany`). Carried
 *      embeddings must be keyed per SOURCE: two interactions with byte-identical passages must
 *      not lend each other vectors, and an edited note keeps its untouched chunks' vectors.
 *   2. `loadLinkedInThreads` ranks each contact's thread exactly as the per-contact
 *      `ORDER BY interaction_date … LIMIT n` did, in both directions.
 *   3. `writeTimelineEventsMany` / `applyTimelineOutcomes` write what the per-contact calls
 *      wrote, with the same `DO NOTHING` idempotence.
 *   4. Gmail and Outlook discovery hold a page's `import_job_rows` writes until the page is
 *      walked: a sender seen twice on one page is one row, `row_index` is assigned in order,
 *      and a sender already stored (a continuation) is updated, not duplicated.
 *
 * Run: npx tsx scripts/smoke-grouped-sweep-writes.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-grouped-sweep";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-grouped-sweep";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, importJobRows, imports, interactions, memoryChunks, userSettings } from "../src/db/schema";
import { backfillMemoryChunks } from "../src/lib/memory-backfill";
import { buildMemoryChunks, syncMemoryChunks, syncMemoryChunksMany } from "../src/lib/memory-chunks";
import {
  applyTimelineOutcome,
  applyTimelineOutcomes,
  loadLinkedInThreads,
  writeTimelineEvents,
  writeTimelineEventsMany,
} from "../src/lib/linkedin-timeline-backfill";
import { runGmailRecruiterScanJob, type ScanDeps } from "../src/lib/gmail-scan-processor";
import type { GmailHeaderSummary } from "../src/lib/gmail";
import {
  OUTLOOK_SCAN_IMPORT_TYPE,
  runOutlookRecruiterScanJob,
  type OutlookScanDeps,
} from "../src/lib/outlook-scan-processor";
import type { OutlookHeaderSummary } from "../src/lib/outlook";
import { ensureUserSettings } from "../src/lib/user-settings";

const MEM = "smoke-grouped-sweep-memory";
const MEM_REF = "smoke-grouped-sweep-memory-ref";
const LI = "smoke-grouped-sweep-li";
const LI_REF = "smoke-grouped-sweep-li-ref";
const SCAN = "smoke-grouped-sweep-scan";
const USERS = [MEM, MEM_REF, LI, LI_REF, SCAN];

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const FILLER = "We went over the quarterly numbers and the hiring plan for the platform team. ";
const long = (tail: string) => `${FILLER.repeat(30)}${tail}`;

async function cleanup() {
  const db = await getDb();
  await db.delete(memoryChunks).where(inArray(memoryChunks.userId, USERS));
  await db.delete(importJobRows).where(inArray(importJobRows.userId, USERS));
  await db.delete(imports).where(inArray(imports.userId, USERS));
  await db.delete(contacts).where(inArray(contacts.userId, USERS));
  await db.delete(userSettings).where(inArray(userSettings.userId, USERS));
}

async function memory() {
  const db = await getDb();
  console.log("memory: grouped writes carry embeddings per source, exactly as one at a time");

  // Direct: the many-sources writer against the one-source writer, on identical inputs.
  const drafts = (text: string) =>
    buildMemoryChunks({
      text,
      occurredAt: new Date("2026-03-01T10:00:00Z"),
      kindLabel: "Note",
      contactId: null,
      contactName: null,
      contactIds: [],
    });
  const ids = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002"];
  const v1 = long("First version ends here.");
  const v2 = `${v1}\n\nA new paragraph at the end. ${FILLER.repeat(12)}`;
  for (const user of [MEM, MEM_REF]) {
    for (const id of ids) await syncMemoryChunks(user, { sourceKind: "interaction", sourceId: id, drafts: drafts(v1) });
    // Only the FIRST source was embedded. Its passages are byte-identical to the second's.
    await db.execute(sql`update memory_chunks set embedded_hash = content_hash, embedding = '[0.5,0.25]'::jsonb
       where user_id = ${user} and source_id = ${ids[0]}::uuid`);
  }
  const many = await syncMemoryChunksMany(MEM, "interaction", [
    { sourceId: ids[0], drafts: drafts(v2), sourceHash: "h0" },
    { sourceId: ids[1], drafts: drafts(v2), sourceHash: "h1" },
  ]);
  const single = [
    await syncMemoryChunks(MEM_REF, { sourceKind: "interaction", sourceId: ids[0], drafts: drafts(v2), sourceHash: "h0" }),
    await syncMemoryChunks(MEM_REF, { sourceKind: "interaction", sourceId: ids[1], drafts: drafts(v2), sourceHash: "h1" }),
  ];
  check("per-source counts match the one-source writer", JSON.stringify(many) === JSON.stringify(single), `${JSON.stringify(many)} vs ${JSON.stringify(single)}`);
  check("the embedded source reused some vectors", many[0].reused > 0 && many[0].reused < many[0].written, JSON.stringify(many[0]));
  check("the identical-text source borrowed none", many[1].reused === 0, JSON.stringify(many[1]));
  const shape = async (user: string) =>
    (
      await db
        .select({
          sourceId: memoryChunks.sourceId,
          chunkIndex: memoryChunks.chunkIndex,
          contentHash: memoryChunks.contentHash,
          sourceHash: memoryChunks.sourceHash,
          embeddedHash: memoryChunks.embeddedHash,
          embedding: memoryChunks.embedding,
        })
        .from(memoryChunks)
        .where(eq(memoryChunks.userId, user))
        .orderBy(asc(memoryChunks.sourceId), asc(memoryChunks.chunkIndex))
    ).map((r) => JSON.stringify(r));
  const [a, b] = [await shape(MEM), await shape(MEM_REF)];
  check("and the stored rows are identical, row for row", a.join() === b.join(), `${a.length} vs ${b.length} rows`);

  // Through the sweep: more interactions than one write group, some already indexed and
  // embedded, then edited.
  await db.delete(memoryChunks).where(eq(memoryChunks.userId, MEM));
  const [contact] = await db.insert(contacts).values({ userId: MEM, fullName: "Grace Hopper" }).returning();
  const when = new Date("2026-02-02T09:00:00Z");
  const rows = await db
    .insert(interactions)
    .values(
      Array.from({ length: 130 }, (_, i) => ({
        userId: MEM,
        contactId: contact.id,
        interactionType: "note",
        interactionDate: new Date(when.getTime() + i * 60_000),
        rawNotes: i % 10 === 0 ? long(`Long note number ${i}.`) : `Short note number ${i}.`,
      }))
    )
    .returning();
  // Two notes with identical text on the same minute: identical passages, separate sources.
  const [twinA, twinB] = await db
    .insert(interactions)
    .values(
      [0, 1].map(() => ({
        userId: MEM,
        contactId: contact.id,
        interactionType: "note",
        interactionDate: new Date("2026-01-01T00:00:00Z"),
        rawNotes: long("Twin note."),
      }))
    )
    .returning();

  const first = await backfillMemoryChunks(MEM, { limit: 500 });
  check("the sweep indexed every interaction", first.indexed === 132 && first.remaining === 0, JSON.stringify(first));
  const perSource = await db
    .select({ n: sql<number>`count(distinct ${memoryChunks.sourceId})::int` })
    .from(memoryChunks)
    .where(eq(memoryChunks.userId, MEM));
  check("one chunk set per interaction", Number(perSource[0]?.n) === 132, String(perSource[0]?.n));

  // Embed twin A and one long note; then edit the long note's tail and touch both twins.
  const edited = rows[0].id;
  await db.execute(sql`update memory_chunks set embedded_hash = content_hash, embedding = '[1,2,3]'::jsonb
     where user_id = ${MEM} and source_id in (${twinA.id}::uuid, ${edited}::uuid)`);
  await db
    .update(interactions)
    .set({ rawNotes: `${long("Long note number 0.")}\n\nEdited tail. ${FILLER.repeat(12)}` })
    .where(eq(interactions.id, edited));
  await db
    .update(interactions)
    .set({ rawNotes: `${long("Twin note.")} ` }) // trailing space: new source hash, same passages
    .where(inArray(interactions.id, [twinA.id, twinB.id]));

  const second = await backfillMemoryChunks(MEM, { limit: 500 });
  check("the second sweep re-indexed exactly the three edited notes", second.indexed === 3 && second.remaining === 0, JSON.stringify(second));
  const carried = async (sourceId: string) =>
    db
      .select({ chunkIndex: memoryChunks.chunkIndex, embedding: memoryChunks.embedding })
      .from(memoryChunks)
      .where(and(eq(memoryChunks.userId, MEM), eq(memoryChunks.sourceId, sourceId)))
      .orderBy(asc(memoryChunks.chunkIndex));
  const editedChunks = await carried(edited);
  check(
    "the edited note kept its first chunk's vector and re-queued the changed tail",
    editedChunks[0]?.embedding !== null && editedChunks.some((c) => c.embedding === null),
    JSON.stringify(editedChunks.map((c) => Boolean(c.embedding)))
  );
  check("twin A kept its vectors", (await carried(twinA.id)).every((c) => c.embedding !== null));
  check("twin B did not borrow twin A's", (await carried(twinB.id)).every((c) => c.embedding === null));
  const third = await backfillMemoryChunks(MEM, { limit: 500 });
  check("a third sweep finds nothing to do", third.indexed === 0 && third.scanned === 0, JSON.stringify(third));
}

async function timeline() {
  const db = await getDb();
  console.log("timeline: threads read together rank exactly as one contact at a time");

  const seed = async (userId: string) => {
    const made: string[] = [];
    for (const [name, count] of [["Ada", 7], ["Brook", 3], ["Cy", 0]] as const) {
      const [c] = await db.insert(contacts).values({ userId, fullName: name, source: "linkedin_messages" }).returning();
      made.push(c.id);
      if (!count) continue;
      await db.insert(interactions).values(
        Array.from({ length: count }, (_, i) => ({
          userId,
          contactId: c.id,
          interactionType: "linkedin_message",
          // Out of order on purpose, so the ranking is doing the work.
          interactionDate: new Date(Date.UTC(2025, 0, 1 + ((i * 5) % count))),
          source: "linkedin_messages",
          rawNotes: i === 0 ? "Hi — great to connect! Coffee next Tuesday?" : `Message ${i} from ${name}`,
          direction: i % 2 ? ("in" as const) : ("out" as const),
        }))
      );
      // A non-message row for the same contact must never be read as part of the thread.
      await db.insert(interactions).values({ userId, contactId: c.id, interactionType: "note", rawNotes: "not a message" });
    }
    return made;
  };
  const [ada, brook, cy] = await seed(LI);
  const [adaRef, brookRef, cyRef] = await seed(LI_REF);

  for (const order of ["asc", "desc"] as const) {
    const many = await loadLinkedInThreads(LI, [ada, brook, cy], { order, limit: 5 });
    for (const id of [ada, brook]) {
      const one = await db.query.interactions.findMany({
        where: and(eq(interactions.userId, LI), eq(interactions.contactId, id), eq(interactions.interactionType, "linkedin_message")),
        columns: { rawNotes: true, aiSummary: true, direction: true, interactionDate: true },
        orderBy: [order === "asc" ? asc(interactions.interactionDate) : desc(interactions.interactionDate)],
        limit: 5,
      });
      const got = many.get(id) ?? [];
      check(
        `${order}: ${id === ada ? "a long thread is cut to the limit" : "a short thread is whole"}, same rows in the same order`,
        JSON.stringify(got) === JSON.stringify(one) && got.length === Math.min(5, id === ada ? 7 : 3),
        `${got.length} vs ${one.length}`
      );
      check(`${order}: dates come back as Dates`, got.every((m) => m.interactionDate instanceof Date));
    }
    check(`${order}: a contact with no messages is absent`, !many.has(cy));
  }
  check("another account's contacts read as empty", (await loadLinkedInThreads(LI_REF, [ada], { order: "asc", limit: 5 })).size === 0);

  console.log("timeline: grouped event writes match the per-contact writes");
  const outcomesFor = (a: string, b: string, c: string) => [
    { contactId: a, content: JSON.stringify({ events: [{ type: "meeting", summary: "Coffee", dateHint: "next Tuesday", sourceMessageIndex: 0 }] }) },
    { contactId: b, content: "this is not JSON" },
    { contactId: c, content: null },
  ];
  const errors: string[] = [];
  const grouped = await applyTimelineOutcomes(LI, outcomesFor(ada, brook, cy), (id) => errors.push(id));
  let oneByOne = 0;
  for (const o of outcomesFor(adaRef, brookRef, cyRef)) oneByOne += await applyTimelineOutcome(LI_REF, o.contactId, o.content);
  check("same number of events written", grouped === oneByOne && grouped > 0, `${grouped} vs ${oneByOne}`);
  check("no contact reported as failed", errors.length === 0, errors.join());
  const events = async (userId: string, map: Record<string, string>) =>
    (
      await db
        .select({ externalId: interactions.externalId, type: interactions.interactionType, date: interactions.interactionDate })
        .from(interactions)
        .where(and(eq(interactions.userId, userId), sql`${interactions.externalId} like 'li-event:%'`))
    )
      .map((e) => `${Object.entries(map).reduce((s, [from, to]) => s.replaceAll(from, to), e.externalId ?? "")}|${e.type}|${e.date.toISOString()}`)
      .sort();
  const [g, r] = [
    await events(LI, { [ada]: "A", [brook]: "B", [cy]: "C" }),
    await events(LI_REF, { [adaRef]: "A", [brookRef]: "B", [cyRef]: "C" }),
  ];
  check("and the same events, contact for contact", g.join() === r.join(), `${g.length} vs ${r.length}`);
  check("applying the batch again writes nothing new", (await applyTimelineOutcomes(LI, outcomesFor(ada, brook, cy), () => {})) === 0);

  const probe = { interactionType: "reach_out" as const, interactionDate: new Date("2025-02-01T00:00:00Z"), summary: "s", rawNotes: "r" };
  const wrote = await writeTimelineEventsMany(LI, [
    { contactId: ada, events: [{ ...probe, externalId: `li-event:${ada}:probe:1` }, { ...probe, externalId: `li-event:${ada}:probe:1` }] },
    { contactId: brook, events: [{ ...probe, externalId: `li-event:${brook}:probe:1` }] },
    { contactId: cy, events: [] },
  ]);
  check("a repeated externalId in one write lands once", wrote === 2, String(wrote));
  check("and the single-contact writer agrees it is already there", (await writeTimelineEvents(LI, ada, [{ ...probe, externalId: `li-event:${ada}:probe:1` }])) === 0);
}

async function scans() {
  const db = await getDb();
  console.log("scan discovery: a page's rows are written once, after the page");
  await ensureUserSettings(SCAN);

  // Page 1: A, B, A. Page 2: C, A, B. A recruiter-ish subject so the keyword prefilter admits all.
  const pages = [
    [["a1", "Alex Agent <alex@agency.test>"], ["b1", "Blair Broker <blair@agency.test>"], ["a2", "Alex Agent <alex@agency.test>"]],
    [["c1", "Casey Hunter <casey@agency.test>"], ["a3", "Alex Agent <alex@agency.test>"], ["b2", "Blair Broker <blair@agency.test>"]],
  ];
  const expected = [
    { email: "alex@agency.test", rowIndex: 0, messageIds: ["a1", "a2", "a3"] },
    { email: "blair@agency.test", rowIndex: 1, messageIds: ["b1", "b2"] },
    { email: "casey@agency.test", rowIndex: 2, messageIds: ["c1"] },
  ];
  const continuation = [[["a1", "Alex Agent <alex@agency.test>"], ["d1", "Dee Scout <dee@agency.test>"], ["d2", "Dee Scout <dee@agency.test>"]]];
  const continued = [
    { email: "alex@agency.test", rowIndex: 0, messageIds: ["a0", "a1"] },
    { email: "dee@agency.test", rowIndex: 1, messageIds: ["d1", "d2"] },
  ];
  const notRecruiter = {
    isRecruiter: false, confidence: 0.1, fullName: null, firm: null,
    companiesMentioned: [], rolesDiscussed: [], summary: null,
  };
  const common = { subject: "Role at Acme", snippet: "Recruiter here, open role for you", internalDate: Date.now() - 60_000, listUnsubscribe: "", listId: "", precedence: "" };

  const stored = async (importId: string) =>
    (
      await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, importId), orderBy: [asc(importJobRows.rowIndex)] })
    ).map((r) => ({ email: (r.payload as { email: string }).email, rowIndex: r.rowIndex, messageIds: (r.payload as { messageIds: string[] }).messageIds }));

  const newJob = async (importType: string) => {
    const [job] = await db
      .insert(imports)
      .values({ userId: SCAN, importType, status: "processing", totalRows: null, stats: { discoveryComplete: false, messagesScanned: 0 } })
      .returning();
    return job.id;
  };
  const seedStored = async (importId: string, kind: "gmail_sender" | "outlook_sender") => {
    await db.insert(importJobRows).values({
      importId, userId: SCAN, rowIndex: 0, status: "pending",
      payload: { kind, email: "alex@agency.test", name: "Alex Agent", firm: "Agency", messageIds: ["a0"] },
    });
  };

  // Gmail.
  {
    const gmailHeaders = (page: string[][]): GmailHeaderSummary[] =>
      page.map(([id, from]) => ({ id, threadId: `t-${id}`, from, to: "me@example.test", ...common }));
    const deps = (p: string[][][]): ScanDeps => ({
      getAccessToken: async () => "stub-token",
      listPage: async (_t, o) => {
        const i = o.pageToken ? Number(o.pageToken) : 0;
        return { messages: p[i].map(([id]) => ({ id, threadId: `t-${id}` })), nextPageToken: i + 1 < p.length ? String(i + 1) : null };
      },
      fetchHeaders: async (_t, refs) => gmailHeaders(p.flat().filter(([id]) => refs.some((r) => r.id === id))),
      fetchMessages: async () => [],
      classify: async () => notRecruiter,
      submit: async () => null,
      continueLater: async () => {},
    });
    const id = await newJob("gmail_recruiter_scan");
    await runGmailRecruiterScanJob(id, deps(pages));
    const rows = await stored(id);
    check("gmail: a sender seen twice on a page is one row, with every id", JSON.stringify(rows) === JSON.stringify(expected), JSON.stringify(rows));

    // A continuation: Alex is already stored, so a page naming Alex again updates that row,
    // while a new sender seen twice on the page is inserted once.
    const cont = await newJob("gmail_recruiter_scan");
    await seedStored(cont, "gmail_sender");
    await runGmailRecruiterScanJob(cont, deps(continuation));
    const after = await stored(cont);
    check("gmail: a stored sender is updated in place, a new one appended", JSON.stringify(after) === JSON.stringify(continued), JSON.stringify(after));
    const job = await db.query.imports.findFirst({ where: eq(imports.id, cont) });
    check("gmail: the job counts both rows", job?.totalRows === 2, String(job?.totalRows));
  }

  // Outlook.
  {
    const outlookHeaders = (page: string[][]): OutlookHeaderSummary[] =>
      page.map(([id, from]) => ({ id, from, folderId: "inbox", ...common }));
    const deps = (p: string[][][]): OutlookScanDeps => ({
      getAccessToken: async () => "stub-token",
      listPage: async (_t, o) => {
        const i = o.skipToken ? Number(o.skipToken) : 0;
        return { messages: p[i].map(([id]) => ({ id })), nextLink: i + 1 < p.length ? String(i + 1) : null };
      },
      excludedFolders: async () => new Set<string>(),
      fetchHeaders: async (_t, refs) => outlookHeaders(p.flat().filter(([id]) => refs.some((r) => r.id === id))),
      fetchMessages: async () => [],
      classify: async () => notRecruiter,
      continueLater: async () => {},
    });
    const id = await newJob(OUTLOOK_SCAN_IMPORT_TYPE);
    await runOutlookRecruiterScanJob(id, deps(pages));
    const rows = await stored(id);
    check("outlook: a sender seen twice on a page is one row, with every id", JSON.stringify(rows) === JSON.stringify(expected), JSON.stringify(rows));

    const cont = await newJob(OUTLOOK_SCAN_IMPORT_TYPE);
    await seedStored(cont, "outlook_sender");
    await runOutlookRecruiterScanJob(cont, deps(continuation));
    const after = await stored(cont);
    check("outlook: a stored sender is updated in place, a new one appended", JSON.stringify(after) === JSON.stringify(continued), JSON.stringify(after));
  }
}

run(async () => {
  await cleanup();
  try {
    await memory();
    await timeline();
    await scans();
  } finally {
    await cleanup();
  }
  if (failures) {
    console.error(`\nsmoke-grouped-sweep-writes: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nsmoke-grouped-sweep-writes: all checks passed");
});
