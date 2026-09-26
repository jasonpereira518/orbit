/**
 * The multi-file drop's state machine, with no browser and no network.
 *
 * The property this exists for: A 429 NEVER LOSES A FILE. `RATE_LIMITS.capture` is 30 a
 * minute and a folder of meeting notes can reach it, so a refused upload has to come back —
 * silently dropping one is, to the person who dropped the folder, indistinguishable from a
 * meeting that never happened.
 *
 * Run: npx tsx scripts/smoke-capture-fanout.ts
 */

import {
  DEFAULT_FANOUT_CONCURRENCY,
  FALLBACK_RETRY_MS,
  MAX_FANOUT_ATTEMPTS,
  applyOutcome,
  markUploading,
  rateLimitTokensFor,
  readyEntries,
  replaceEntry,
  startableEntries,
  summarize,
  type FanoutEntry,
  type UploadOutcome,
} from "../src/lib/capture/fanout";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function entry(id: string, over: Partial<FanoutEntry> = {}): FanoutEntry {
  return {
    id,
    label: `${id}.md`,
    bytes: 100,
    fileCount: 1,
    status: "pending",
    jobId: null,
    anchorIso: null,
    error: null,
    notice: null,
    retryAt: null,
    attempts: 0,
    ...over,
  };
}

const NOW = 1_000_000;

console.log("\nconcurrency is bounded");

{
  const entries = [entry("a"), entry("b"), entry("c"), entry("d")];
  const ready = readyEntries(entries, NOW);
  check(`only ${DEFAULT_FANOUT_CONCURRENCY} start at once`, ready.length === DEFAULT_FANOUT_CONCURRENCY, String(ready.length));
  check("  and they are the first in order", ready[0].id === "a" && ready[1].id === "b");
}
{
  const entries = [entry("a", { status: "uploading" }), entry("b"), entry("c")];
  check("an in-flight upload holds a slot", readyEntries(entries, NOW).length === 1);
}
{
  const entries = [entry("a", { status: "uploading" }), entry("b", { status: "uploading" }), entry("c")];
  check("a full pipe starts nothing", readyEntries(entries, NOW).length === 0);
}
{
  const entries = [entry("a", { status: "queued" }), entry("b", { status: "failed" }), entry("c")];
  const ready = readyEntries(entries, NOW);
  check("settled entries never restart", ready.length === 1 && ready[0].id === "c");
}

console.log("\nan upload already started is never started again");

{
  // The pump runs from an effect, and can run against a list that does not yet show what it
  // just started as uploading. The started set is what it trusts.
  const entries = [entry("a"), entry("b"), entry("c")];
  const ready = startableEntries(entries, new Set(["a"]), NOW);
  check("a started id is not returned", !ready.some((e) => e.id === "a"));
  check("  and it still holds a slot", ready.length === 1 && ready[0].id === "b", ready.map((e) => e.id).join());
  check(
    "a full started set starts nothing",
    startableEntries(entries, new Set(["a", "b"]), NOW).length === 0
  );
  check(
    "an uploading entry is not counted twice",
    startableEntries([entry("a", { status: "uploading" }), entry("b")], new Set(["a"]), NOW).length === 1
  );
  check(
    "with nothing started it is readyEntries",
    JSON.stringify(startableEntries(entries, new Set(), NOW)) === JSON.stringify(readyEntries(entries, NOW))
  );
  check("the input is not mutated", entries.every((e) => e.status === "pending"));
}

console.log("\na 429 waits and comes back — it never drops the file");

{
  const refused: UploadOutcome = { ok: false, error: "Too many", status: 429, retryAfterSec: 5 };
  const waited = applyOutcome(entry("a"), refused, NOW);
  check("a 429 goes to waiting, not failed", waited.status === "waiting", waited.status);
  check("  and honours Retry-After", waited.retryAt === NOW + 5000, String(waited.retryAt));
  check("  the error is kept for the row", waited.error === "Too many");

  check("it is not ready before its time", readyEntries([waited], NOW + 4000).length === 0);
  check("  and is ready after", readyEntries([waited], NOW + 5001).length === 1);
}
{
  const noHeader: UploadOutcome = { ok: false, error: "Too many", status: 429, retryAfterSec: null };
  const waited = applyOutcome(entry("a"), noHeader, NOW);
  check("a 429 with no header still waits", waited.retryAt === NOW + FALLBACK_RETRY_MS, String(waited.retryAt));
}

// Retried forever is its own failure — at some point the person needs to be told.
{
  let e = entry("a");
  const refused: UploadOutcome = { ok: false, error: "Too many", status: 429, retryAfterSec: 1 };
  for (let i = 0; i < MAX_FANOUT_ATTEMPTS; i++) e = applyOutcome(e, refused, NOW);
  check(`after ${MAX_FANOUT_ATTEMPTS} attempts it fails`, e.status === "failed", e.status);
  check("  and stops being retried", readyEntries([e], NOW + 1_000_000).length === 0);
}

console.log("\nother failures are reported, not retried");

{
  // A 413 will say the same thing next time; retrying only delays telling the person.
  const tooBig: UploadOutcome = { ok: false, error: "That upload is too large", status: 413, retryAfterSec: null };
  const failed = applyOutcome(entry("a"), tooBig, NOW);
  check("a 413 fails immediately", failed.status === "failed");
  check("  with the server's words", failed.error === "That upload is too large");
  const bad: UploadOutcome = { ok: false, error: "Add a file first", status: 400, retryAfterSec: null };
  check("a 400 fails immediately", applyOutcome(entry("a"), bad, NOW).status === "failed");
}

console.log("\na success carries the job id");

{
  const done = applyOutcome(entry("a"), { ok: true, jobId: "job-1" }, NOW);
  check("queued with its job", done.status === "queued" && done.jobId === "job-1");
  check("  and no error left over", done.error === null && done.retryAt === null);
}

console.log("\nnothing is mutated in place");

{
  const original = entry("a");
  const next = applyOutcome(original, { ok: true, jobId: "j" }, NOW);
  check("applyOutcome returns a new entry", original.status === "pending" && next.status === "queued");
  const list = [original];
  const replaced = replaceEntry(list, next);
  check("replaceEntry does not touch the input", list[0].status === "pending" && replaced[0].status === "queued");
  check("markUploading is pure too", markUploading(original).status === "uploading" && original.status === "pending");
}

console.log("\nthe run finishes exactly once nothing is outstanding");

{
  check("a fresh drop is not done", !summarize([entry("a")]).done);
  check("an in-flight drop is not done", !summarize([entry("a", { status: "uploading" })]).done);
  // A waiting entry is still outstanding — this is the assertion that stops the UI calling
  // a batch finished while a 429 is still pending its retry.
  check("a waiting drop is NOT done", !summarize([entry("a", { status: "waiting" })]).done);
  const settled = [entry("a", { status: "queued" }), entry("b", { status: "failed" })];
  const s = summarize(settled);
  check("queued + failed is done", s.done && s.queued === 1 && s.failed === 1);
  check("an empty drop is done", summarize([]).done);
}

console.log("\nthe rate-limit arithmetic that made autoQueue necessary");

{
  // RATE_LIMITS.capture is 30/60s.
  check("twelve bins cost 12 tokens with autoQueue", rateLimitTokensFor(12) === 12);
  check("  and 24 without it — most of the budget", rateLimitTokensFor(12, false) === 24);
  check("thirty bins fit with autoQueue", rateLimitTokensFor(30) <= 30);
  // Two tokens a file put the ceiling at exactly fifteen; the sixteenth was refused
  // mid-drop, which is the failure autoQueue removes.
  check("  fifteen was exactly the old ceiling", rateLimitTokensFor(15, false) === 30);
  check("  and sixteen did not fit", rateLimitTokensFor(16, false) > 30);
  // Forty photos sorted into four meetings is four requests, not forty — which is the whole
  // point of letting somebody group them before anything is uploaded.
  check("grouping is what buys the headroom", rateLimitTokensFor(4) === 4);
}

console.log("\nAll capture fan-out checks passed.");
