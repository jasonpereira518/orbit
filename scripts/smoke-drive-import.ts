/**
 * The Drive import processor, end to end against PGlite with Drive and the model stubbed.
 *
 * Pins: staging caps and filters types; a doc becomes contacts + an interaction through
 * capture's own save; reminders obey the strict rules and a flag lands on the import; an
 * unchanged doc re-imported is skipped, not double-logged; a vanished file is skipped with
 * a plain reason and the job still completes; a missing AI key stops the job; a time budget
 * hand-off resumes where it stopped, and no row starts without room to finish; a save that
 * throws part-way is re-saved on the next import rather than trusted; a commitments-only doc
 * is recognised once finished; a row another runner already finished is never overwritten or
 * double-counted.
 *
 * Run: npx tsx scripts/smoke-drive-import.ts
 */
import "./smoke/_env";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, importJobRows, imports, interactions, noteBatches, reminders } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import {
  DRIVE_ROW_COPY,
  MAX_DRIVE_FILES_PER_IMPORT,
  runDriveImportJob,
  stageDriveImport,
  type DriveImportDeps,
} from "../src/lib/drive-import-processor";
import { DriveFileUnavailableError } from "../src/lib/drive";
import { DRIVE_MIME } from "../src/lib/imports/drive-triage";
import { saveNoteBatch } from "../src/lib/note-batch-save";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import type { CaptureParseResult, SuggestedReminderPreview } from "../src/lib/capture/types";
import { countImportPeople } from "../src/lib/imports/import-people";
import { removeDriveFlag } from "../src/lib/drive-flags";

const USER = "smoke-drive-import-user";
const NOW = new Date("2026-09-21T12:00:00Z");

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
}

function reminder(key: string, over: Partial<SuggestedReminderPreview>): SuggestedReminderPreview {
  return {
    key, title: `Follow through ${key}`, description: null, rawDatePhrase: "on a date",
    dueDateIso: "2026-10-03", yearInferred: false, personName: "Priya Raman", actionKind: "task",
    confidenceScore: 90, sourceExcerpt: "…", dateBasis: "absolute", anchorIso: "2026-09-01",
    origin: "explicit", rationale: null, ...over,
  };
}

/**
 * A minimal parse result naming one or two people. Shape copied from `CaptureParseResult`.
 * `follow_up_days: 14` puts each generic follow-up at Sep 15 — already overdue on Sep 21 —
 * so the "no overdue follow-up" check really exercises `followUpStillAhead`.
 */
function parsed(
  text: string,
  names: string[],
  suggested: SuggestedReminderPreview[],
  existing: Map<string, string> = new Map(),
): CaptureParseResult {
  return {
    items: names.map((name, i) => ({
      key: `p${i}`,
      notes: text,
      parsed: {
        name, company: null, role: null, presence: "participant", location: null, email: null,
        linkedin_url: null, met_at: null, topics: [], action_items: [],
        follow_up_recommendation: null, follow_up_days: 14, relationship_score_suggestion: 3,
        relevance: 3, tags: [], summary: `Met ${name}`, key_facts: [], opportunities: [],
        implied_next_steps: [], shared_interests: [], suggested_next_message: null,
        confidence: null, interaction_date: "2026-09-01", low_confidence_fields: [],
      },
      opportunities: [], impliedSteps: [], cadence: null,
      // What the real parse does for someone already in Orbit: offers them as the merge.
      duplicates: existing.has(name)
        ? [{ id: existing.get(name)!, fullName: name, company: null, title: null, reason: "Same name", confidence: 0.9 }]
        : [],
      suggestedMergeId: existing.get(name) ?? null,
      sharedNoteTexts: [],
      interactionDate: "2026-09-01", interactionType: "meeting",
    })) as unknown as CaptureParseResult["items"],
    sharedNotes: [], interactionDate: "2026-09-01", interactionType: "meeting",
    anchorIso: "2026-09-01", anchorBasis: "hint", hints: {}, sourceText: text,
    sourceHash: "", suggestedReminders: suggested,
    suggestionsSkipped: { relative: 0, unverifiable: 0, past: 0 },
    mentions: [], mentionedOnly: [],
  } as unknown as CaptureParseResult;
}

const DOCS: Record<string, { text: string; names: string[]; reminders: SuggestedReminderPreview[] } | "gone"> = {
  a: {
    text: "1:1 with Priya and Marco. Priya sends the deck on October 3.",
    names: ["Priya Raman", "Marco Bellini"],
    reminders: [
      reminder("future", {}),
      reminder("past-important", { dueDateIso: "2026-09-10", confidenceScore: 95 }),
      reminder("implied", { origin: "implied", rawDatePhrase: null }),
    ],
  },
  b: { text: "Coffee with Lena Okafor.", names: ["Lena Okafor"], reminders: [] },
  // Never imported before the no-key scenario, so the unchanged-doc dedupe can't skip it.
  c: { text: "Call with Sam Rivera.", names: ["Sam Rivera"], reminders: [] },
  d: { text: "Lunch with Omar Haddad.", names: ["Omar Haddad"], reminders: [] },
  e: { text: "Drinks with Nia Brooks.", names: ["Nia Brooks"], reminders: [] },
  f: {
    text: "Board review on October 15.",
    names: [],
    reminders: [reminder("board", { title: "Board review", personName: null, dueDateIso: "2026-10-15" })],
  },
  gone: "gone",
};

function deps(over: Partial<DriveImportDeps> = {}): DriveImportDeps & { continued: string[] } {
  const continued: string[] = [];
  return {
    continued,
    getAccessToken: async () => "tok",
    exportText: async (_t, fileId) => {
      const d = DOCS[fileId];
      if (!d || d === "gone") throw new DriveFileUnavailableError();
      return d.text;
    },
    parse: async (_u, text) => {
      const d = Object.values(DOCS).find((x) => x !== "gone" && x.text === text);
      if (!d || d === "gone") throw new Error("unexpected text");
      const db = await getDb();
      const known = d.names.length
        ? await db.query.contacts.findMany({ where: and(eq(contacts.userId, USER), inArray(contacts.fullName, d.names)) })
        : [];
      return parsed(text, d.names, d.reminders, new Map(known.map((c) => [c.fullName, c.id])));
    },
    save: saveNoteBatch,
    continueLater: async (id) => void continued.push(id),
    now: () => NOW,
    ...over,
  };
}

const file = (id: string, mimeType: string = DRIVE_MIME.doc) => ({
  id, name: `Doc ${id}`, mimeType, modifiedTime: "2026-09-01T10:00:00Z",
});

async function main() {
  await reset();
  await ensureUserSettings(USER);
  const db = await getDb();

  // Staging: types filtered, cap enforced.
  const tooMany = Array.from({ length: MAX_DRIVE_FILES_PER_IMPORT + 1 }, (_, i) => file(`n${i}`));
  let capped = false;
  try { await stageDriveImport(USER, tooMany); } catch { capped = true; }
  check("more than the cap is refused", capped);

  const staged = await stageDriveImport(USER, [
    file("a"), file("b"), file("gone"), file("sheet", "application/vnd.google-apps.spreadsheet"),
  ]);
  check("a sheet is not staged", staged.totalRows === 3, String(staged.totalRows));

  const d1 = deps();
  await runDriveImportJob(staged.importId, d1);

  const imp = await db.query.imports.findFirst({ where: eq(imports.id, staged.importId) });
  check("the job completes", imp?.status === "completed", `${imp?.status} ${imp?.errorMessage ?? ""}`);
  check("two docs read", imp?.stats?.docsRead === 2, JSON.stringify(imp?.stats));
  check("every row counted", imp?.rowsProcessed === 3, String(imp?.rowsProcessed));

  const rows = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, staged.importId) });
  const byFile = new Map(rows.map((r) => [(r.payload as { fileId: string }).fileId, r]));
  check("a vanished file is skipped", byFile.get("gone")?.status === "skipped");
  check("…with a plain reason", byFile.get("gone")?.errorMessage === DRIVE_ROW_COPY.unavailable);
  const aRow = byFile.get("a")!;
  const aIds = (aRow.payload as { contactIds?: string[] }).contactIds ?? [];
  check("doc a touched both people", aIds.length === 2 && aRow.contactId === aIds[0], JSON.stringify(aIds));

  const logged = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });
  check("each person got an interaction", logged.length === 3, String(logged.length));

  const people = await countImportPeople(USER, staged.importId, imp!.createdAt);
  check("people list sees all three", people.added === 3, JSON.stringify(people));

  const rs = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  const titles = rs.map((r) => r.title);
  check("the future stated date became a reminder", titles.includes("Follow through future"), JSON.stringify(titles));
  check("the implied one did not", !titles.includes("Follow through implied"));
  check("the past one did not", !titles.includes("Follow through past-important"));
  check("no generic follow-up for a doc whose follow-up is already overdue",
    !titles.some((t) => t.startsWith("Follow up with")), JSON.stringify(titles));
  check("no reminder is already overdue (the Sep 1 follow-up would be due Sep 15)",
    rs.every((r) => !r.dueDate || r.dueDate.getTime() >= new Date("2026-09-21T00:00:00Z").getTime()),
    JSON.stringify(rs.map((r) => [r.title, r.dueDate])));
  const flags = imp?.stats?.flaggedCommitments ?? [];
  check("the past important one is flagged", flags.length === 1 && flags[0].key === "past-important", JSON.stringify(flags));
  check("the flag knows its person", Boolean(flags[0]?.contactId));
  check("the flag knows its doc", flags[0]?.docName === "Doc a");

  const interactionsBefore = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });

  // Re-import the same, unchanged doc: skipped, nothing doubled.
  const again = await stageDriveImport(USER, [file("a")]);
  let parsedAgain = false;
  await runDriveImportJob(again.importId, deps({
    parse: async () => { parsedAgain = true; throw new Error("should not parse"); },
  }));
  const imp2 = await db.query.imports.findFirst({ where: eq(imports.id, again.importId) });
  check("an unchanged doc is recognised", imp2?.stats?.docsAlreadyImported === 1, JSON.stringify(imp2?.stats));
  check("…without a model call", !parsedAgain);
  const interactionsAfter = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });
  check("no interaction doubled", interactionsAfter.length === interactionsBefore.length);
  const people2 = await countImportPeople(USER, again.importId, imp2!.createdAt);
  check("the re-import still lists its people", people2.existing === 2, JSON.stringify(people2));

  // No AI key: the job stops at the first doc with one clear reason, rows left pending.
  const nokey = await stageDriveImport(USER, [file("c")]);
  const { AiAccessError } = await import("../src/lib/ai-access");
  await runDriveImportJob(nokey.importId, deps({
    parse: async () => { throw new AiAccessError("key_required"); },
  }));
  const nk = await db.query.imports.findFirst({ where: eq(imports.id, nokey.importId) });
  check("no AI key fails the job", nk?.status === "failed", nk?.status);
  const nkRows = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, nokey.importId) });
  check("…and leaves the row pending", nkRows.length === 1 && nkRows[0].status === "pending", nkRows[0]?.status);

  // Time budget: a clock past the budget hands off without touching rows.
  const later = await stageDriveImport(USER, [file("b")]);
  let t = NOW.getTime();
  const d3 = deps({ now: () => new Date((t += 10 * 60_000)) });
  await runDriveImportJob(later.importId, d3);
  check("out of time → scheduled a continuation", d3.continued.includes(later.importId));
  const still = await db.query.importJobRows.findMany({
    where: and(eq(importJobRows.importId, later.importId), inArray(importJobRows.status, ["pending"])),
  });
  check("…and left the row pending", still.length === 1);

  // Row reserve: 200 s in, a row would have started under the old 270 s budget and been
  // killed at the 300 s ceiling mid-parse. 215 s leaves under 90 s, so none starts.
  const tight = await stageDriveImport(USER, [file("b")]);
  let calls = 0;
  const d4 = deps({
    now: () => new Date(NOW.getTime() + (calls++ === 0 ? 0 : calls === 2 ? 200_000 : 215_000)),
  });
  await runDriveImportJob(tight.importId, d4);
  check("under the row reserve → handed off", d4.continued.includes(tight.importId));
  const tightRows = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, tight.importId) });
  check("…without starting the row", tightRows.length === 1 && tightRows[0].status === "pending", tightRows[0]?.status);

  // A save that throws part-way leaves the row unfinished, so it is never a marker: the next
  // import re-saves the doc and ends done with its people.
  const broken = await stageDriveImport(USER, [file("e")]);
  await runDriveImportJob(broken.importId, deps({
    save: async (u, input) => {
      await saveNoteBatch(u, input);
      throw new Error("save interrupted");
    },
  }));
  const [bRow] = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, broken.importId) });
  check("a save that throws leaves the row unfinished", bRow.status === "skipped" && bRow.errorMessage === DRIVE_ROW_COPY.unreadable, JSON.stringify(bRow));
  check("…and marks nothing imported", !(bRow.payload as { sourceHash?: string }).sourceHash);
  const retry = await stageDriveImport(USER, [file("e")]);
  await runDriveImportJob(retry.importId, deps());
  const retryImp = await db.query.imports.findFirst({ where: eq(imports.id, retry.importId) });
  check("re-importing it saves it again", retryImp?.stats?.docsRead === 1 && !retryImp?.stats?.docsAlreadyImported, JSON.stringify(retryImp?.stats));
  const [retryRow] = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, retry.importId) });
  const retryIds = (retryRow.payload as { contactIds?: string[] }).contactIds ?? [];
  check("…the row is done with its person", retryRow.status === "done" && retryIds.length === 1 && retryRow.contactId === retryIds[0], JSON.stringify(retryRow));
  const nia = await db.query.contacts.findMany({ where: and(eq(contacts.userId, USER), eq(contacts.fullName, "Nia Brooks")) });
  check("…and the person exists once", nia.length === 1, String(nia.length));

  // A commitments-only doc: no people, one stated future date. Finished once, recognised after.
  const f = DOCS.f as { text: string };
  const fHash = hashSourceNote(f.text);
  const firstF = await stageDriveImport(USER, [file("f")]);
  await runDriveImportJob(firstF.importId, deps());
  const f1 = await db.query.imports.findFirst({ where: eq(imports.id, firstF.importId) });
  check("a dates-only doc is read", f1?.stats?.docsRead === 1, JSON.stringify(f1?.stats));
  const boardReminders = async () =>
    (await db.query.reminders.findMany({ where: eq(reminders.userId, USER) })).filter((r) => r.title === "Board review");
  check("…its stated date became a reminder", (await boardReminders()).length === 1);
  const batchesFor = async () =>
    (await db.query.noteBatches.findMany({ where: and(eq(noteBatches.userId, USER), eq(noteBatches.sourceHash, fHash)) })).length;
  const interactionsF = (await db.query.interactions.findMany({ where: eq(interactions.userId, USER) })).length;
  const secondF = await stageDriveImport(USER, [file("f")]);
  await runDriveImportJob(secondF.importId, deps({
    parse: async () => { throw new Error("should not parse"); },
  }));
  const f2 = await db.query.imports.findFirst({ where: eq(imports.id, secondF.importId) });
  check("…and recognised when imported again", f2?.stats?.docsAlreadyImported === 1 && !f2?.stats?.docsRead, JSON.stringify(f2?.stats));
  check("…with no second batch", (await batchesFor()) === 1);
  check("…no new interaction", (await db.query.interactions.findMany({ where: eq(interactions.userId, USER) })).length === interactionsF);
  check("…and no second reminder", (await boardReminders()).length === 1);

  // A second runner (the stall cron) finished this row while this one was reading it.
  const raced = await stageDriveImport(USER, [file("d")]);
  const OTHER_RUNNER = "finished by the other runner";
  await runDriveImportJob(raced.importId, deps({
    exportText: async (_t, fileId) => {
      await db
        .update(importJobRows)
        .set({ status: "done", errorMessage: OTHER_RUNNER })
        .where(eq(importJobRows.importId, raced.importId));
      return (DOCS[fileId] as { text: string }).text;
    },
  }));
  const [rRow] = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, raced.importId) });
  check("a finished row is not overwritten", rRow.status === "done" && rRow.errorMessage === OTHER_RUNNER && !rRow.contactId, JSON.stringify(rRow));
  const rImp = await db.query.imports.findFirst({ where: eq(imports.id, raced.importId) });
  check("…nor counted twice", !rImp?.stats?.docsRead && (rImp?.rowsProcessed ?? 0) === 0, JSON.stringify([rImp?.rowsProcessed, rImp?.stats]));
  check("…and the job still completes", rImp?.status === "completed", rImp?.status);

  // Dismissing a flag removes exactly that one, and only for its owner.
  const flagged = await db.query.imports.findFirst({ where: eq(imports.id, staged.importId) });
  const flagId = flagged!.stats!.flaggedCommitments![0].id;
  check("another user can't dismiss it", !(await removeDriveFlag("someone-else", staged.importId, flagId)));
  check("the owner can", await removeDriveFlag(USER, staged.importId, flagId));
  const after = await db.query.imports.findFirst({ where: eq(imports.id, staged.importId) });
  check("…and it's gone", (after!.stats!.flaggedCommitments ?? []).length === 0);

  await reset();
  console.log("smoke-drive-import: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  process.exit(1);
});
