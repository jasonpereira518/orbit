/**
 * The multi-file capture queue: many jobs from one drop coexisting, and the discard rule
 * that used to make that impossible.
 *
 * THE BUG THIS PINS. `queueCaptureJob` marks every other reviewable job `discarded` on each
 * new Extract — "only one capture is in review at a time" — because a lone Extract has no
 * way back to the cards it displaced. Uploading twelve meeting notes is precisely the shape
 * that rule was written to prevent, so it is now suspended for, and only for, a batch: a
 * batch HAS a way back, which is the queue panel. Get this wrong in either direction and
 * either eleven of twelve meetings vanish, or a single capture starts orphaning cards again.
 *
 * Run: npx tsx scripts/smoke-capture-queue.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-capture-queue";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-capture-queue";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../src/db";
import { captureJobs } from "../src/db/schema";
import {
  createCaptureJob,
  discardCaptureBatchRows,
  findActiveCaptureJob,
  findActiveCaptureJobs,
  markCaptureJobTranscribed,
  toCaptureJobView,
} from "../src/lib/capture-jobs";
import { sanitizeMentionPicks } from "../src/lib/mentions/mention-picks";

const USER = "smoke-capture-queue-user";
const OTHER = "smoke-capture-queue-other";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(captureJobs).where(eq(captureJobs.userId, USER));
  await db.delete(captureJobs).where(eq(captureJobs.userId, OTHER));
}

async function statusOf(id: string) {
  const db = await getDb();
  const row = await db.query.captureJobs.findFirst({ where: eq(captureJobs.id, id) });
  return row?.status ?? null;
}

/**
 * Mirrors what `queueCaptureJob` in `src/actions/capture-jobs.ts` does around the row write:
 * the blanket discard, gated on the batch id — including the target row's OWN batchGroupId,
 * not just the incoming call's. Reproduced here rather than imported because that module is
 * `"use server"` and calls `requireUserId()`, which has no session in a smoke script — the
 * RULE is what matters, and it must stay byte-for-byte the same rule, not a paraphrase that
 * quietly drifts (see "a grouped 'ready' row survives an ungrouped queue" below, which is
 * exactly the case that drifted: this used to discard EVERY row in these statuses regardless
 * of the row's own batchGroupId, silently wiping out a job the public API had enqueued and
 * left with its own group).
 */
async function queueLikeAction(userId: string, batchGroupId: string | null) {
  const db = await getDb();
  if (!batchGroupId) {
    await db
      .update(captureJobs)
      .set({ status: "discarded", updatedAt: new Date() })
      .where(
        and(
          eq(captureJobs.userId, userId),
          inArray(captureJobs.status, ["ready", "reviewing", "failed", "transcribed"]),
          isNull(captureJobs.batchGroupId)
        )
      );
  }
  return createCaptureJob(userId, {
    sourceKind: "messy",
    status: "queued",
    inputText: "notes",
    batchGroupId,
  });
}

async function main() {
  await reset();
  const db = await getDb();

  console.log("\ntwelve meeting notes coexist");

  const batch = randomUUID();
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const row = await createCaptureJob(USER, {
      sourceKind: "messy",
      status: "ingesting",
      inputText: `notes for meeting ${i}`,
      batchGroupId: batch,
      sourceLabel: `2026-03-0${(i % 9) + 1}-standup.md`,
      mentionPicks: [{ id: randomUUID(), name: `Person ${i}` }],
    });
    await markCaptureJobTranscribed(row.id);
    ids.push(row.id);
  }
  check("twelve jobs created", ids.length === 12);

  const active = await findActiveCaptureJobs(USER);
  check("findActiveCaptureJobs returns them all", active.length === 12, String(active.length));
  check("  all share one batch id", active.every((r) => r.batchGroupId === batch));
  check("  each keeps its own filename", new Set(active.map((r) => r.sourceLabel)).size > 1);

  // The singular resume still answers with one row, unchanged — the queue is additive.
  const single = await findActiveCaptureJob(USER);
  check("findActiveCaptureJob still returns exactly one", single !== null && ids.includes(single.id));

  console.log("\nthe discard rule, in both directions");

  // A BATCH queue must leave its siblings alone.
  {
    await db.update(captureJobs).set({ status: "ready" }).where(eq(captureJobs.userId, USER));
    const fresh = await queueLikeAction(USER, batch);
    const survivors = await db.query.captureJobs.findMany({
      where: and(eq(captureJobs.userId, USER), eq(captureJobs.status, "ready")),
    });
    check("a batch queue discards no siblings", survivors.length === 12, String(survivors.length));
    check("  and adds its own row", (await statusOf(fresh.id)) === "queued");
    await db.delete(captureJobs).where(eq(captureJobs.id, fresh.id));
  }

  // A SINGLE queue must still discard a true ungrouped sibling — the original rule has to
  // survive intact. Uses FRESH ungrouped rows rather than the batch's 12, on purpose: the
  // batch's rows are covered by the next case below, and conflating the two used to hide
  // exactly the bug that case pins (see its comment).
  {
    await reset();
    const loneReady = await createCaptureJob(USER, {
      sourceKind: "messy",
      status: "queued",
      inputText: "a lone draft",
    });
    await db.update(captureJobs).set({ status: "ready" }).where(eq(captureJobs.id, loneReady.id));

    const fresh = await queueLikeAction(USER, null);
    const survivors = await db.query.captureJobs.findMany({
      where: and(eq(captureJobs.userId, USER), eq(captureJobs.status, "ready")),
    });
    check("a single queue still discards an ungrouped sibling", survivors.length === 0, String(survivors.length));
    check("  and adds its own row", (await statusOf(fresh.id)) === "queued");
  }

  // A row that carries its OWN batchGroupId is exempt even from an UNGROUPED queue call —
  // not just from a grouped one. This is what protects a note the public API enqueued
  // (src/app/api/v1/notes/route.ts gives every job it creates a single-item batchGroupId
  // for exactly this) from being wiped out by the very next ordinary in-app Extract. Before
  // this fix, `queueLikeAction`'s discard (mirroring the real action) ignored the target
  // row's OWN batchGroupId entirely and would have wiped this row out too.
  {
    await reset();
    const apiJob = await createCaptureJob(USER, {
      sourceKind: "messy",
      status: "queued",
      inputText: "an overnight note from the API",
      batchGroupId: randomUUID(),
    });
    await db.update(captureJobs).set({ status: "ready" }).where(eq(captureJobs.id, apiJob.id));

    const fresh = await queueLikeAction(USER, null);
    check(
      "a grouped 'ready' row survives an ungrouped queue",
      (await statusOf(apiJob.id)) === "ready"
    );
    check("  and the ungrouped call still adds its own row", (await statusOf(fresh.id)) === "queued");
  }

  console.log("\ndiscarding a batch is scoped to that batch");

  await reset();
  const batchA = randomUUID();
  const batchB = randomUUID();
  const aIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const row = await createCaptureJob(USER, { sourceKind: "messy", status: "queued", inputText: "a", batchGroupId: batchA });
    aIds.push(row.id);
  }
  const bRow = await createCaptureJob(USER, { sourceKind: "messy", status: "queued", inputText: "b", batchGroupId: batchB });
  const loneRow = await createCaptureJob(USER, { sourceKind: "messy", status: "queued", inputText: "lone", batchGroupId: null });

  const discarded = await discardCaptureBatchRows(USER, batchA);
  check("discards exactly its own batch", discarded === 3, String(discarded));
  check("  batch A is gone", (await statusOf(aIds[0])) === "discarded");
  check("  batch B untouched", (await statusOf(bRow.id)) === "queued");
  // The failure this guards: a "start over" that took out the single capture somebody left
  // open in another tab.
  check("  the lone capture untouched", (await statusOf(loneRow.id)) === "queued");

  console.log("\nuser scoping");

  const otherRow = await createCaptureJob(OTHER, { sourceKind: "messy", status: "queued", inputText: "theirs", batchGroupId: batchB });
  const crossed = await discardCaptureBatchRows(USER, batchB);
  check("another user's row in the same batch id is untouched", (await statusOf(otherRow.id)) === "queued");
  check("  only this user's row was discarded", crossed === 1, String(crossed));
  check("other users are absent from findActiveCaptureJobs", (await findActiveCaptureJobs(USER)).every((r) => r.userId === USER));

  console.log("\nthe new columns round-trip through the view");

  await reset();
  const picks = [{ id: randomUUID(), name: "Ada Lovelace" }];
  const row = await createCaptureJob(USER, {
    sourceKind: "messy",
    status: "transcribed",
    inputText: "notes",
    batchGroupId: batch,
    sourceLabel: "2026-03-01 standup.md",
    mentionPicks: picks,
  });
  const view = toCaptureJobView((await db.query.captureJobs.findFirst({ where: eq(captureJobs.id, row.id) }))!);
  check("batchGroupId round-trips", view.batchGroupId === batch);
  check("sourceLabel round-trips", view.sourceLabel === "2026-03-01 standup.md", String(view.sourceLabel));
  check("mentionPicks round-trip", view.mentionPicks.length === 1 && view.mentionPicks[0].name === "Ada Lovelace", JSON.stringify(view.mentionPicks));

  // A forged pick must not reach the column: this payload comes from a browser.
  {
    const forged = await createCaptureJob(USER, {
      sourceKind: "messy",
      status: "transcribed",
      inputText: "notes",
      mentionPicks: sanitizeMentionPicks([{ id: "not-a-uuid", name: "Mallory" }, { id: picks[0].id, name: "Ada" }]),
    });
    const stored = await db.query.captureJobs.findFirst({ where: eq(captureJobs.id, forged.id) });
    check("a malformed pick is stripped before storage", (stored?.mentionPicks ?? []).length === 1, JSON.stringify(stored?.mentionPicks));
  }

  // An ordinary capture carries none of this, and must read back as empty rather than null.
  {
    const plain = await createCaptureJob(USER, { sourceKind: "messy", status: "transcribed", inputText: "notes" });
    const plainView = toCaptureJobView((await db.query.captureJobs.findFirst({ where: eq(captureJobs.id, plain.id) }))!);
    check("a single capture has no batch", plainView.batchGroupId === null);
    check("  no source label", plainView.sourceLabel === null);
    check("  and empty picks, not null", Array.isArray(plainView.mentionPicks) && plainView.mentionPicks.length === 0);
  }

  await reset();
  console.log("\nAll capture queue checks passed.");
}

// `process.exit(0)` is mandatory, not tidiness: PGlite keeps the event loop alive, so a
// script that merely resolves never exits and `run-smoke.ts` waits on it forever. Every
// other pglite-tier script in this suite ends the same way.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
