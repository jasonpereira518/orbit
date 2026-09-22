/**
 * Pins how streamed text is revealed (`src/lib/stream-drain.ts`, `src/lib/stream-smoother.ts`).
 *
 * The rules that matter are the ones a screenshot cannot show: the reveal never trails the
 * stream by more than a bounded amount, never stalls while text is waiting, never cuts a
 * citation marker or a character in half, and always ends with exactly the text that was
 * sent. The frame loop is driven by a fake scheduler so it is deterministic.
 *
 * Pure: no DOM. Run: npx tsx scripts/smoke-stream-drain.ts
 */
import {
  DRAIN_TAU_MS,
  MAX_BACKLOG_CHARS,
  drainCount,
  safeCut,
} from "../src/lib/stream-drain";
import { createStreamSmoother, type FrameScheduler } from "../src/lib/stream-smoother";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** A frame scheduler you advance by hand. */
function fakeScheduler() {
  let next = 1;
  const queue = new Map<number, (now: number) => void>();
  const scheduler: FrameScheduler = {
    request: (cb) => {
      const id = next++;
      queue.set(id, cb);
      return id;
    },
    cancel: (id) => {
      queue.delete(id);
    },
  };
  let now = 0;
  return {
    scheduler,
    pending: () => queue.size,
    /** Run one frame `dt` ms after the last; returns false when nothing was scheduled. */
    frame(dt = 16) {
      const entries = [...queue.entries()];
      if (entries.length === 0) return false;
      queue.clear();
      now += dt;
      for (const [, cb] of entries) cb(now);
      return true;
    },
    drain(maxFrames = 2000) {
      let n = 0;
      while (this.frame() && n++ < maxFrames);
      return n;
    },
  };
}

console.log("drainCount: how much to reveal this frame");
{
  check("nothing waiting, nothing revealed", drainCount(0, 16) === 0);
  check("a negative backlog is nothing", drainCount(-5, 16) === 0);
  check("one waiting character is revealed (never stalls)", drainCount(1, 16) === 1);
  check("a small backlog trickles: never the whole thing at once", drainCount(20, 16) < 20);
  check("but never zero while anything waits", [1, 2, 3, 5, 8, 13, 50, 200].every((b) => drainCount(b, 16) >= 1));
  check("never more than is waiting", [1, 5, 50, 500, 5000].every((b) => drainCount(b, 16) <= b));

  let monotonic = true;
  for (let b = 1; b < 600; b++) if (drainCount(b + 1, 16) < drainCount(b, 16)) monotonic = false;
  check("a bigger backlog never reveals less", monotonic);

  check("a longer frame reveals at least as much", drainCount(100, 100) >= drainCount(100, 16));
  check("a bad frame time falls back to one frame, not NaN", Number.isInteger(drainCount(50, NaN)) && drainCount(50, NaN) >= 1);
  check("a zero frame time is treated as a frame", drainCount(50, 0) >= 1);

  // The hard cap: whatever the easing says, the reveal never trails by more than the cap.
  for (const b of [MAX_BACKLOG_CHARS + 1, 500, 2000, 50_000]) {
    const left = b - drainCount(b, 16);
    check(`a ${b}-character backlog leaves at most ${MAX_BACKLOG_CHARS} waiting`, left <= MAX_BACKLOG_CHARS, `left ${left}`);
  }

  // Time to work off a large backlog at a steady 60fps, with no new text arriving.
  let backlog = 200;
  let frames = 0;
  while (backlog > 0 && frames < 500) {
    backlog -= drainCount(backlog, 16);
    frames++;
  }
  check(`a 200-character backlog is fully drained within a second (${frames} frames)`, frames * 16 <= 1000);
  check("the constant is the one the docs describe", DRAIN_TAU_MS === 120);
}

console.log("\nsafeCut: never cut a token in half");
{
  const t = "Ask Ada about Ramp [e12] and then Ben [e3].";
  check("the end of the text is the end of the text", safeCut(t, 0, 9999) === t.length);
  check("a cut that lands after a whole marker is left alone", safeCut(t, 0, t.indexOf("]") + 1) === t.indexOf("]") + 1);

  const at = t.indexOf("[e12]");
  const stop = at + "[e12]".length;
  // The marker is complete in the text, so a cut inside it reveals it whole (moves forward).
  check("a cut just after '[' reveals the whole marker", safeCut(t, 0, at + 1) === stop);
  check("a cut after '[e' reveals the whole marker", safeCut(t, 0, at + 2) === stop);
  check("a cut after '[e1' reveals the whole marker", safeCut(t, 0, at + 3) === stop);
  check("a cut after '[e12' reveals the whole marker", safeCut(t, 0, at + 4) === stop);
  check("a cut just after the closing bracket is fine", safeCut(t, 0, stop) === stop);
  check("a cut just before the marker is fine", safeCut(t, 0, at) === at);

  check("an ordinary bracket is not held", safeCut("see [note] here", 0, 6) === 6);
  check("'[error' is not a marker and is not held", safeCut("it said [error here", 0, 12) === 12);
  check("a bracket with no e is not held", safeCut("list [1] item", 0, 6) === 6);
  check("'[e]' with no digits is not a marker", safeCut("the [e] key", 0, 6) === 6);

  const emoji = "hi \u{1F600}!";
  check("a cut between the halves of an emoji reveals the whole emoji", safeCut(emoji, 0, 4) === 5, String(safeCut(emoji, 0, 4)));
  check("a cut after the whole emoji is fine", safeCut(emoji, 0, 5) === 5);
  check("a high surrogate at the very end of the text (partner not here yet) is held", safeCut("hi \u{1F600}".slice(0, 4), 0, 4) === 3);

  // Unfinished at the END of the text: wait for the rest.
  check("an unfinished marker at the end is held back", safeCut("Ask Ada [e1", 0, 99) === 8);
  check("a lone '[' at the end is held (it may become a marker)", safeCut("Ask Ada [", 0, 99) === 8);
  check("holding an unfinished tail can mean revealing nothing this frame", safeCut("xx [e", 3, 2) === 3);
  check("text before an unfinished tail is still revealed", safeCut("Ask Ada [e1", 0, 4) === 4);

  check("it never returns less than where it started", safeCut("abc [e1", 4, 1) >= 4);
  check("a zero-length want returns where it started", safeCut("hello", 2, 0) === 2);

  // The reveal must ALWAYS advance while text is waiting, or the smoother would stall.
  let advances = true;
  let detail0 = "";
  const done = "Dana [e1][e2] and \u{1F600}\u{1F600} then [e10][e11][e12] end [x] [e] [";
  const settled = done.slice(0, done.length - 1); // ends in a complete word, not an unfinished tail
  for (let from = 0; from < settled.length; from++) {
    for (const want of [1, 2, 3, 5]) {
      if (safeCut(settled, from, want) <= from) {
        advances = false;
        detail0 = `from ${from} want ${want}`;
      }
    }
  }
  check("with a finished text the reveal advances from every position, at every rate", advances, detail0);

  // Property: however the cuts fall, joining every reveal gives back the text, and no boundary
  // lands strictly inside a marker or a surrogate pair.
  let seed = 12345;
  const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const corpus =
    "You know three people at Ramp [e1]. Dana Whitfield [e2][e3] is your strongest path \u{1F680} \u2014 she joined in March [e10]. " +
    "Ben \u{1F600} [e4] and Cara [e11][e12] are worth a note. See [notes] and [error] and [e] too.";
  const markers = [...corpus.matchAll(/\[e\d+\]/g)].map((m) => [m.index!, m.index! + m[0].length] as const);
  let ok = true;
  let detail = "";
  for (let trial = 0; trial < 300 && ok; trial++) {
    let from = 0;
    let out = "";
    let guard = 0;
    while (from < corpus.length && guard++ < 5000) {
      const want = 1 + Math.floor(rand() * 14);
      const end = safeCut(corpus, from, want);
      if (end <= from) {
        ok = false;
        detail = `stalled at ${from}`;
        break;
      }
      out += corpus.slice(from, end);
      from = end;
      const inside = markers.some(([a, b]) => from > a && from < b);
      const code = corpus.charCodeAt(from - 1);
      const splitPair = from < corpus.length && code >= 0xd800 && code <= 0xdbff;
      if (inside || splitPair) {
        ok = false;
        detail = `boundary ${from} inside a token`;
        break;
      }
    }
    if (ok && out !== corpus) {
      ok = false;
      detail = "reassembly differs";
    }
  }
  check("300 random reveals reassemble exactly, never stall and never cut a token", ok, detail);
}

console.log("\nThe smoother, driven by a fake frame clock");
{
  const text = "The quick brown fox jumps over the lazy dog. ".repeat(6);

  {
    const f = fakeScheduler();
    const chunks: string[] = [];
    const s = createStreamSmoother((c) => chunks.push(c), { scheduler: f.scheduler });
    s.push(text);
    check("pushing schedules a frame but reveals nothing synchronously", f.pending() === 1 && chunks.length === 0);
    f.drain();
    check("it ends with exactly the text that was sent", chunks.join("") === text);
    check("the reveal is spread over many frames, not one lump", chunks.length > 5, String(chunks.length));
    check("no frame reveals more than the backlog rules allow", chunks.every((c) => c.length <= text.length));
    check("nothing is left scheduled once drained", f.pending() === 0);
  }

  {
    const f = fakeScheduler();
    const chunks: string[] = [];
    const s = createStreamSmoother((c) => chunks.push(c), { scheduler: f.scheduler });
    s.push("Hello ");
    f.frame();
    s.push("there, how are you today?");
    s.flush();
    check("flush reveals everything still waiting, at once", chunks.join("") === "Hello there, how are you today?");
    check("and cancels the pending frame", f.pending() === 0);
    s.flush();
    check("flushing twice does not repeat text", chunks.join("") === "Hello there, how are you today?");
    s.push("ignored");
    check("text pushed after the end is ignored", chunks.join("").endsWith("today?") && f.pending() === 0);
  }

  {
    const f = fakeScheduler();
    const chunks: string[] = [];
    const s = createStreamSmoother((c) => chunks.push(c), { scheduler: f.scheduler, reduced: true });
    s.push(text);
    f.frame();
    check("reduced motion reveals the whole backlog in one frame — no trickle, no delay", chunks.join("") === text && chunks.length === 1);
  }

  {
    const f = fakeScheduler();
    const chunks: string[] = [];
    const s = createStreamSmoother((c) => chunks.push(c), { scheduler: f.scheduler });
    s.push("abc");
    s.cancel();
    f.drain();
    check("cancel reveals nothing and leaves nothing scheduled", chunks.length === 0 && f.pending() === 0);
  }

  {
    const f = fakeScheduler();
    const chunks: string[] = [];
    const s = createStreamSmoother((c) => chunks.push(c), { scheduler: f.scheduler });
    s.push("Ask Ada [e1");
    f.drain();
    const shown = chunks.join("");
    check("a marker that has opened but not closed is not shown", !shown.includes("[e"), JSON.stringify(shown));
    check("the text before it is shown", shown === "Ask Ada ", JSON.stringify(shown));
    check("the loop goes idle instead of spinning while it waits", f.pending() === 0);
    s.push("2] now");
    f.drain();
    check("once the marker closes, it arrives whole", chunks.join("") === "Ask Ada [e12] now", JSON.stringify(chunks.join("")));
    const partial = fakeScheduler();
    const out2: string[] = [];
    const s2 = createStreamSmoother((c) => out2.push(c), { scheduler: partial.scheduler });
    s2.push("dangling [e");
    partial.drain();
    s2.flush();
    check("a marker that never closes is released when the stream ends, not lost", out2.join("") === "dangling [e");
  }

  {
    const f = fakeScheduler();
    const chunks: string[] = [];
    const s = createStreamSmoother((c) => chunks.push(c), { scheduler: f.scheduler });
    s.push("x".repeat(6000));
    f.drain();
    check("a long answer (past the trim threshold) still reassembles exactly", chunks.join("") === "x".repeat(6000));
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll stream drain checks passed");
process.exit(0);
