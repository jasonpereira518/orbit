/**
 * The constellation's code chunks recover from a failed download instead of staying failed.
 *
 * Pins `src/components/graph/constellation-modules.ts`: a chunk that fails to download is
 * re-requested before the load gives up; a failure that outlasts the retries is held for the
 * error boundary, and `resetConstellationModules()` (what the /graph error screen's "Try again"
 * calls) clears it so the next load asks for the chunk again; a module that throws while
 * evaluating is not retried (a second download cannot fix it).
 *
 * Why: the failure was sticky for the document, so "Try again" re-rendered into the same
 * stored error and only a full page reload recovered. On a flaky connection, or a tab that
 * outlived a deploy, that read as a constellation that never loads.
 *
 * Run: npx tsx scripts/smoke-constellation-modules.ts
 */
import {
  __testing,
  isChunkLoadError,
  resetConstellationModules,
} from "../src/components/graph/constellation-modules";
import { checker } from "./smoke/check";

const t = checker();
const { slots, load } = __testing;

function chunkError() {
  const err = new Error("Loading chunk 123 failed.");
  err.name = "ChunkLoadError";
  return err;
}

function resetSlots() {
  for (const slot of Object.values(slots)) {
    slot.module = null;
    slot.promise = null;
    slot.error = null;
  }
}

async function main() {
  console.log("Recognising a download failure");
  t.check("ChunkLoadError by name", isChunkLoadError(chunkError()));
  t.check(
    "dynamic import failure by message",
    isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /_next/x.js"))
  );
  t.check("an ordinary error is not one", !isChunkLoadError(new Error("x is not a function")));
  t.check("a non-error is not one", !isChunkLoadError(null) && !isChunkLoadError("boom"));

  console.log("A chunk that fails once, then downloads");
  {
    resetSlots();
    let calls = 0;
    const fake = { ok: true };
    slots.layout.load = async () => {
      calls++;
      if (calls === 1) throw chunkError();
      return fake as never;
    };
    const mod = await load("layout");
    t.check("resolves with the module", mod === (fake as never));
    t.check("asked for the chunk twice", calls === 2, `calls=${calls}`);
    t.check("holds no error", slots.layout.error === null);
  }

  console.log("A chunk that keeps failing, then the retry button");
  {
    resetSlots();
    let calls = 0;
    let healthy = false;
    const fake = { ok: true };
    slots.layout.load = async () => {
      calls++;
      if (!healthy) throw chunkError();
      return fake as never;
    };
    // `window` is absent here, so the stale-tab reload path is skipped and the error is held.
    const failed = await load("layout").then(
      () => null,
      (e: unknown) => e
    );
    t.check("rejects once the retries are spent", failed !== null);
    t.check("gave it 1 try + 2 retries", calls === 3, `calls=${calls}`);
    t.check("holds the error for the boundary", slots.layout.error === failed);

    const before = calls;
    await load("layout").catch(() => {});
    t.check("without a reset, a second load does not re-request", calls === before);

    healthy = true;
    resetConstellationModules();
    t.check("reset clears the held error", slots.layout.error === null);
    t.check("reset clears the memoised failure", slots.layout.promise === null);
    const mod = await load("layout");
    t.check("after reset the chunk is requested again", mod === (fake as never));
  }

  console.log("A module that throws while evaluating");
  {
    resetSlots();
    let calls = 0;
    slots.shell.load = async () => {
      calls++;
      throw new Error("x is not a function");
    };
    const failed = await load("shell").then(
      () => null,
      (e: unknown) => e
    );
    t.check("rejects", failed !== null);
    t.check("is not retried", calls === 1, `calls=${calls}`);
  }

  console.log("Reset leaves loaded modules alone");
  {
    resetSlots();
    const loaded = { ok: true };
    slots.flow.module = loaded as never;
    resetConstellationModules();
    t.check("the loaded module survives", slots.flow.module === (loaded as never));
  }

  t.done("constellation modules smoke tests");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
