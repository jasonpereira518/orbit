/**
 * The multi-file drop's HOOK, rendered by real React — the lifecycle `smoke-capture-fanout.ts`
 * cannot see, because every property there is about the pure state machine.
 *
 * The bug this exists for: the pump effect changes `entries`, so React re-runs it, and a
 * per-run `cancelled` flag set in its cleanup threw away the outcome of every upload that run
 * started. Each note sat at "uploading" forever and `running` never went false. The pure
 * functions were all correct; only rendering the hook shows it.
 *
 * No jsdom: the harness component renders `null`, so React needs no more DOM than a fake root
 * container and a `window` stub. StrictMode is on, as it is in `next dev`. No `act()` either:
 * it holds every update until its scope ends, so the pump — which advances one render at a
 * time — would move one round per `act` instead of running the way it does in a browser.
 *
 * Run: npx tsx scripts/smoke-capture-fanout-hook.ts
 */

import { StrictMode, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { PlannedUpload } from "../src/lib/capture/bins";
import { useCaptureFanout, type FanoutUploader } from "../src/lib/capture/use-capture-fanout";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

// Just enough of a DOM for react-dom to create a root and commit a tree of `null`.
const g = globalThis as Record<string, unknown>;
g.window ??= { event: undefined, HTMLIFrameElement: class {}, document: { activeElement: null } };
const noop = () => {};
function fakeContainer(): Element {
  const doc: Record<string, unknown> = { nodeType: 9, addEventListener: noop, removeEventListener: noop };
  const el = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: doc,
    addEventListener: noop,
    removeEventListener: noop,
  };
  doc.documentElement = el;
  return el as unknown as Element;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stub uploader that records what it was asked to do and answers per label. */
function stubUploader(answer: (label: string, call: number) => Awaited<ReturnType<FanoutUploader>>) {
  const calls = new Map<string, number>();
  let active = 0;
  let peak = 0;
  const uploader: FanoutUploader = async ({ label }) => {
    const n = (calls.get(label) ?? 0) + 1;
    calls.set(label, n);
    active++;
    peak = Math.max(peak, active);
    try {
      await sleep(20);
      if (label.startsWith("throw")) throw new Error("offline");
      return answer(label, n);
    } finally {
      active--;
    }
  };
  return { uploader, calls, peak: () => peak };
}

async function mount(uploader: FanoutUploader) {
  let latest!: ReturnType<typeof useCaptureFanout>;
  const settled: string[][] = [];
  // Stubbed always: the real one is a server action, and a smoke has no session to call it in.
  const discarded: string[] = [];
  const discarder = async (jobId: string) => {
    discarded.push(jobId);
  };
  function Harness() {
    latest = useCaptureFanout({ uploader, discarder, onSettled: (ids) => settled.push(ids) });
    return null;
  }
  const root = createRoot(fakeContainer());
  root.render(createElement(StrictMode, null, createElement(Harness)));
  await sleep(10);
  const start = async (labels: string[]) => {
    const file = new File(["x"], "note.md");
    const plans: PlannedUpload[] = labels.map((label) => ({ label, fileIds: ["f"], bytes: 1, anchorIso: null }) as PlannedUpload);
    latest.start(plans, () => file);
    await sleep(0);
  };
  const unmount = async () => {
    root.unmount();
    await sleep(0);
  };
  return { hook: () => latest, settled, discarded, start, wait: sleep, unmount };
}

async function main() {
  console.log("\nevery upload's outcome lands, and the run finishes");
  {
    const stub = stubUploader((label, call) => {
      if (label === "bad") return { ok: false, error: "Too large", status: 413, retryAfterSec: null };
      if (label === "busy" && call === 1) return { ok: false, error: "Slow down", status: 429, retryAfterSec: 0.05 };
      return { ok: true, jobId: `job-${label}` };
    });
    const h = await mount(stub.uploader);
    await h.start(["a", "bad", "busy", "b", "throw-c", "d"]);
    await h.wait(1500);
    const byLabel = Object.fromEntries(h.hook().entries.map((e) => [e.label, e]));
    const stuck = h.hook().entries.filter((e) => e.status === "uploading" || e.status === "pending");
    check("no entry is left uploading or pending", stuck.length === 0, stuck.map((e) => `${e.label}=${e.status}`).join(" "));
    check("a success is queued with its job id", byLabel.a.status === "queued" && byLabel.a.jobId === "job-a");
    check("a refusal is failed with its error", byLabel.bad.status === "failed" && byLabel.bad.error === "Too large");
    check("a 429 waits, retries and lands", byLabel.busy.status === "queued" && byLabel.busy.attempts === 2);
    check("a thrown upload is failed, not lost", byLabel["throw-c"].status === "failed" && byLabel["throw-c"].error === "offline");
    check("running goes false", !h.hook().running);
    check("onSettled fires exactly once", h.settled.length === 1, String(h.settled.length));
    check(
      "  with every job that was created",
      JSON.stringify(h.settled[0]) === JSON.stringify(["job-a", "job-busy", "job-b", "job-d"]),
      JSON.stringify(h.settled[0])
    );
    const twice = [...stub.calls].filter(([label, n]) => n !== (label === "busy" ? 2 : 1));
    check("no note is uploaded twice (the 429 retry aside)", twice.length === 0, JSON.stringify(twice));
    check("concurrency is still bounded at 2", stub.peak() === 2, String(stub.peak()));
    await h.unmount();
  }

  // Stop used to let the two in-flight uploads land as `queued`. Under `autoQueue` that
  // meant both were then READ — a cancelled note turning up for review anyway — so now each
  // is discarded the moment its job id comes back, and shows as skipped like the rest.
  console.log("\nStop discards what was already in flight, once its id lands");
  {
    const stub = stubUploader((label) => ({ ok: true, jobId: `job-${label}` }));
    const h = await mount(stub.uploader);
    await h.start(["a", "b", "c", "d"]);
    // Stop only once both slots are really uploading: pressed before the pump has run, Stop
    // starts nothing at all, which is the next case, not this one.
    const inFlightBy = Date.now() + 1_000;
    while (stub.calls.size < 2 && Date.now() < inFlightBy) await h.wait(1);
    check("two uploads are in flight before Stop", stub.calls.size === 2, String(stub.calls.size));
    h.hook().cancelPending();
    check("nothing is discarded before the ids exist", h.discarded.length === 0, JSON.stringify(h.discarded));
    await h.wait(200);
    const statuses = h.hook().entries.map((e) => `${e.label}=${e.status}`).join(" ");
    check("every note reads as skipped", statuses === "a=skipped b=skipped c=skipped d=skipped", statuses);
    check(
      "the two in flight at Stop were discarded as their ids landed",
      JSON.stringify([...h.discarded].sort()) === JSON.stringify(["job-a", "job-b"]),
      JSON.stringify(h.discarded)
    );
    check("nothing new started after Stop", stub.calls.size === 2, String(stub.calls.size));
    check("running is false", !h.hook().running);
    check("onSettled did not fire for a cancelled run", h.settled.length === 0, String(h.settled.length));
    await h.unmount();
  }

  // The race this used to lose: Stop pressed after `start` has rendered but before the pump's
  // effect has run. That effect still saw `running` true and started two uploads, which then
  // landed as `queued` with their jobs kept. Whichever of Stop and the pump comes first here,
  // nothing may land and every job that was made must be discarded.
  console.log("\nStop right after start leaves nothing behind, whoever gets there first");
  {
    const stub = stubUploader((label) => ({ ok: true, jobId: `job-${label}` }));
    const h = await mount(stub.uploader);
    await h.start(["a", "b", "c", "d"]);
    h.hook().cancelPending();
    await h.wait(200);
    const statuses = h.hook().entries.map((e) => `${e.label}=${e.status}`).join(" ");
    check("every note reads as skipped", statuses === "a=skipped b=skipped c=skipped d=skipped", statuses);
    const made = [...stub.calls.keys()].map((label) => `job-${label}`).sort();
    check(
      "every job that was made is discarded",
      JSON.stringify([...h.discarded].sort()) === JSON.stringify(made),
      `made ${JSON.stringify(made)}, discarded ${JSON.stringify(h.discarded)}`
    );
    check("at most the first two ever started", stub.calls.size <= 2, String(stub.calls.size));
    check("running is false", !h.hook().running);
    check("onSettled did not fire", h.settled.length === 0, String(h.settled.length));
    await h.unmount();
  }

  console.log("\neach note's file hashes reach its upload");
  {
    const seen = new Map<string, string[] | undefined>();
    const uploader: FanoutUploader = async ({ label, fileHashes }) => {
      seen.set(label, fileHashes);
      return { ok: true, jobId: `job-${label}` };
    };
    const h = await mount(uploader);
    const file = new File(["x"], "note.md");
    h.hook().start(
      [
        { label: "one", fileIds: ["f"], bytes: 1, anchorIso: null, fileHashes: ["h1"] } as PlannedUpload,
        { label: "two", fileIds: ["f", "g"], bytes: 2, anchorIso: null, fileHashes: ["h2", "h3"] } as PlannedUpload,
      ],
      () => file
    );
    await h.wait(100);
    check("the first note carries its hash", JSON.stringify(seen.get("one")) === JSON.stringify(["h1"]), JSON.stringify(seen.get("one")));
    check("the second carries both of its own", JSON.stringify(seen.get("two")) === JSON.stringify(["h2", "h3"]), JSON.stringify(seen.get("two")));
    await h.unmount();
  }

  console.log("\nan upload finishing after unmount is harmless");
  {
    const stub = stubUploader((label) => ({ ok: true, jobId: `job-${label}` }));
    const h = await mount(stub.uploader);
    await h.start(["a"]);
    const problems: unknown[] = [];
    const onRejection = (reason: unknown) => problems.push(reason);
    const consoleError = console.error;
    console.error = (...args: unknown[]) => problems.push(args);
    process.on("unhandledRejection", onRejection);
    await h.unmount();
    await sleep(100);
    process.off("unhandledRejection", onRejection);
    console.error = consoleError;
    check("the upload still ran to completion", stub.calls.get("a") === 1);
    check("  and landing on a gone component raised nothing", problems.length === 0, String(problems[0]));
  }

  console.log("\nAll capture fan-out hook checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
