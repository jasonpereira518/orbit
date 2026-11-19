/**
 * Discarding from the stale-draft notice only moves ready/reviewing rows: a save running in
 * another tab must survive.
 *
 * Run: npx tsx scripts/run-smoke.ts --only smoke-capture-discard-stale
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { captureJobs } from "../src/db/schema";
import { discardCaptureJobRow } from "../src/lib/capture-jobs";
import type { CaptureJobStatus } from "../src/lib/capture/types";
import { checker } from "./smoke/check";

const USER = "smoke-capture-discard-stale-user";
const only = ["ready", "reviewing"] as const;
const t = checker();

async function statusOf(id: string) {
  const db = await getDb();
  return (await db.query.captureJobs.findFirst({ where: eq(captureJobs.id, id) }))?.status;
}

async function seed(status: CaptureJobStatus) {
  const db = await getDb();
  const [row] = await db.insert(captureJobs).values({ userId: USER, sourceKind: "meeting", status, updatedAt: new Date(Date.now() - 10 * 60_000) }).returning();
  return row!;
}

async function main() {
  const db = await getDb();
  try {
    const saving = await seed("saving");
    t.check("saving job is not discarded", !(await discardCaptureJobRow(USER, saving.id, { onlyStatuses: [...only] })));
    t.check("saving job stays saving", (await statusOf(saving.id)) === "saving");

    const ready = await seed("ready");
    t.check("ready job is discarded", await discardCaptureJobRow(USER, ready.id, { onlyStatuses: [...only] }));
    t.check("ready job is now discarded", (await statusOf(ready.id)) === "discarded");

    const reviewing = await seed("reviewing");
    t.check("reviewing job is discarded", await discardCaptureJobRow(USER, reviewing.id, { onlyStatuses: [...only] }));
  } finally {
    // The CI shard shares this database with the capture stall sweep.
    await db.delete(captureJobs).where(eq(captureJobs.userId, USER));
  }
  t.done("capture-discard-stale");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
