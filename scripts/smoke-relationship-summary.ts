/**
 * Run summary read model + one-click promotion (pglite).
 * Run: npx tsx scripts/smoke-relationship-summary.ts
 */
import "./smoke/_env";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, noteBatches, relationshipDigests, relationshipRuns, reminders } from "../src/db/schema";
import { latestRunNotice, loadImportRunSummary, loadLatestRunSummary, loadRunSummary, runSummaryCopy, type RunSummary } from "../src/lib/relationship-engine/summary";
import { loadDigestView } from "../src/lib/relationship-engine/digest-view";
import { dismissOpenThread, dismissRunFlag, promoteOpenThread, promoteRunFlag } from "../src/lib/relationship-engine/promote";
import { ensureRunNoteBatch, undoRelationshipRun } from "../src/lib/relationship-engine/apply";

const USER = "smoke-relationship-summary";
const NOW = new Date("2026-10-03T12:00:00Z");

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(relationshipDigests).where(eq(relationshipDigests.userId, USER));
  await db.delete(relationshipRuns).where(eq(relationshipRuns.userId, USER));
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
}

async function main() {
  const db = await getDb();
  await reset();
  const [maya] = await db.insert(contacts).values({ userId: USER, fullName: "Maya Chen" }).returning();
  const [msg] = await db.insert(interactions).values({
    userId: USER, contactId: maya.id, interactionType: "linkedin_message",
    interactionDate: new Date("2026-09-24T10:00:00Z"), rawNotes: "I'll send the deck Friday",
  }).returning();
  const importId = crypto.randomUUID();
  const [run] = await db.insert(relationshipRuns).values({
    userId: USER, importId, status: "done", processed: 184, skipped: 12, failed: 1,
    remindersCreated: 9, openThreadsAdded: 31, factsAdded: 40, finishedAt: NOW,
    flags: [{ key: "k1", contactId: maya.id, title: "Check Maya sent the deck", dueDateIso: "2026-09-26", sourceExcerpt: "I'll send the deck Friday", interactionId: msg.id }],
  }).returning();
  await ensureRunNoteBatch(USER, run.id);
  await db.insert(relationshipDigests).values({
    contactId: maya.id, userId: USER, runId: run.id, historyTruncatedBefore: new Date("2023-01-01"),
    openThreads: [{ key: "t1", text: "Intro to Priya", owedBy: "me", sinceIso: "2026-05-01", interactionId: msg.id, excerpt: "can you intro me to Priya?" }],
  });
  const view = await loadDigestView(USER, maya.id);
  check("digest view: threads carry canRemind", view?.openThreads[0]?.canRemind === true, JSON.stringify(view?.openThreads));
  check("digest view: other user sees nothing", (await loadDigestView("someone-else", maya.id)) === null);

  // Read model
  const s = (await loadRunSummary(USER, run.id, NOW))!;
  check("summary: counters", s.processed === 184 && s.remindersCreated === 9 && s.openThreadsAdded === 31 && s.skipped === 12);
  check("summary: flag carries the name", s.flags.length === 1 && s.flags[0].contactName === "Maya Chen");
  check("summary: truncated people", s.truncatedPeople === 1, String(s.truncatedPeople));
  check("summary: undoable when done", s.undoable === true);
  check("summary: by import", (await loadImportRunSummary(USER, importId, NOW))?.id === run.id);
  check("summary: latest", (await loadLatestRunSummary(USER, NOW))?.id === run.id);
  check("summary: another user sees nothing", (await loadRunSummary("someone-else", run.id, NOW)) === null);

  // Copy (pure)
  const copy = runSummaryCopy(s);
  check("copy: headline", copy.headline === "Analyzed 184 people · 9 reminders · 31 open threads · 12 skipped (too short)", copy.headline);
  check("copy: older history note", copy.notes.includes("Older history not read for 1 person"), JSON.stringify(copy.notes));
  check("copy: failed note", copy.notes.includes("Couldn’t analyze 1 person"), JSON.stringify(copy.notes));
  const running: RunSummary = { ...s, status: "running", processed: 25, remaining: 159, finishedAt: null };
  check("copy: progress while running", runSummaryCopy(running).progress === "Analyzing 25 of 184 — the rest within a few hours", String(runSummaryCopy(running).progress));
  check("copy: key wait", runSummaryCopy({ ...running, status: "waiting_key" }).progress === "Add an AI key to analyze 159 more people");
  check("copy: no progress when done", copy.progress === null);

  // Flag → reminder, in the run's batch, idempotent; the flag leaves the run.
  const promoted = await promoteRunFlag(USER, run.id, "k1", NOW);
  check("flag: reminder made", !!promoted);
  const rem = await db.query.reminders.findFirst({ where: eq(reminders.id, promoted!.reminderId) });
  const batchId = (await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, run.id) }))!.noteBatchId;
  check("flag: reminder in the run batch", rem?.noteBatchId === batchId && rem?.contactId === maya.id && rem?.title === "Check Maya sent the deck", JSON.stringify(rem));
  check("flag: due tomorrow", rem?.dueDate?.toISOString().slice(0, 10) === "2026-10-04");
  check("flag: removed from the run", (await loadRunSummary(USER, run.id, NOW))!.flags.length === 0);
  check("flag: second promote is a no-op", (await promoteRunFlag(USER, run.id, "k1", NOW)) === null);
  check("flag: listed among the run's reminders", (await loadRunSummary(USER, run.id, NOW))!.reminders.some((r) => r.id === promoted!.reminderId));

  // Thread → reminder; dismiss removes without a reminder.
  const t = await promoteOpenThread(USER, maya.id, "t1", NOW);
  check("thread: reminder made", !!t);
  const tRem = await db.query.reminders.findFirst({ where: eq(reminders.id, t!.reminderId) });
  check("thread: implied, in the run batch", tRem?.origin === "implied" && tRem?.noteBatchId === batchId, JSON.stringify(tRem));
  const d = await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, maya.id) });
  check("thread: removed from the digest", d?.openThreads.length === 0);
  await db.update(relationshipDigests)
    .set({ openThreads: [{ key: "t2", text: "Coffee in October", owedBy: null, sinceIso: "2026-04-01", interactionId: msg.id, excerpt: "coffee sometime?" }] })
    .where(eq(relationshipDigests.contactId, maya.id));
  check("thread: dismiss", (await dismissOpenThread(USER, maya.id, "t2")) === true);
  check("thread: dismiss unknown key is false", (await dismissOpenThread(USER, maya.id, "nope")) === false);
  check("thread: another user cannot dismiss", (await dismissOpenThread("someone-else", maya.id, "t2")) === false);
  check("flag: dismiss unknown key is false", (await dismissRunFlag(USER, run.id, "nope")) === false);

  const notice = await latestRunNotice(USER, NOW);
  check("notice: finished run shows", notice?.runId === run.id && notice.headline.startsWith("Analyzed 184 people"), JSON.stringify(notice));
  check("notice: gone after 3 days", (await latestRunNotice(USER, new Date(NOW.getTime() + 4 * 86_400_000))) === undefined);

  // Undo all reaches the promoted reminders.
  await undoRelationshipRun(USER, run.id);
  const pending = await db.query.reminders.findMany({ where: and(eq(reminders.userId, USER), eq(reminders.status, "pending")) });
  check("undo: promoted reminders dismissed", pending.length === 0, String(pending.length));
  check("summary: not undoable once undone", (await loadRunSummary(USER, run.id, NOW))!.undoable === false);
  check("notice: undone run hidden", (await latestRunNotice(USER, NOW)) === undefined);

  await reset();
  console.log("relationship summary OK");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
