/**
 * When a saved capture job auto-opens on /capture and /meetings.
 *
 * Run: npx tsx scripts/run-smoke.ts --only smoke-capture-job-staleness
 */
import { shouldAutoOpenJob } from "../src/lib/capture/job-staleness";
import type { CaptureJobStatus } from "../src/lib/capture/types";
import { checker } from "./smoke/check";

const t = checker();
const now = new Date("2026-11-16T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const job = (status: CaptureJobStatus, age: number, itemCount = 0) => ({
  status,
  updatedAt: ago(age),
  itemCount,
});
const open = (j: ReturnType<typeof job>, explicitJobParam = false) =>
  shouldAutoOpenJob(j, { explicitJobParam, now });

t.check("explicit ?job= opens a 30-day-old job", open(job("ready", 30 * DAY), true));
for (const s of ["ingesting", "transcribed", "queued", "extracting", "saving"] as const) {
  t.check(`in-flight ${s} opens at 5 days old`, open(job(s, 5 * DAY)));
}
t.check("ready 10 min ago opens", open(job("ready", 10 * MIN)));
t.check("reviewing 10 min ago opens", open(job("reviewing", 10 * MIN, 3)));
t.check("ready, 0 items, 4 days old does not open", !open(job("ready", 4 * DAY)));
t.check("reviewing, 3 items, 4 days old does not open", !open(job("reviewing", 4 * DAY, 3)));

for (const s of ["failed", "saved", "discarded"] as const) {
  t.check(`terminal ${s} at 5 days old opens (not a draft)`, open(job(s, 5 * DAY)));
}

t.done("capture-job-staleness");
