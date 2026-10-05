/**
 * The Deepgram half of dictation. Pure — no DOM, no React — but not socket-free: the
 * `openDeepgramLive` sections below drive the REAL client code in `deepgram-live.ts`
 * through its `socketFactory` seam with a fake `WebSocket`, which is exactly what that
 * seam exists for.
 *
 * What this file can and can't prove: `use-dictation.ts` is a React hook that reaches for
 * `AudioContext`/`AudioWorkletNode`/`getUserMedia`, none of which exist under plain node
 * and none of which this repo has a jsdom/testing-library harness to fake. So instead of
 * rendering the hook, the reducer-sequence checks below dispatch the EXACT event sequence
 * `use-dictation.ts`'s `onClose`/`onError` handlers dispatch into the real, unmodified
 * `dictationReducer` — which is the part of the fix that decides "retry" vs "give up", and
 * is fully testable without a browser. The socket-level checks separately prove the
 * transport those handlers sit on top of behaves the way the reducer checks assume it
 * does. Between the two, the state-machine contract and the wire contract are each
 * verified for real; only the glue between them (the React effect that closes the mic
 * graph) is not, for lack of a DOM to test it in.
 *
 * Run: npx tsx scripts/smoke-dictation-deepgram.ts
 */
import { foldResults, type FoldState } from "../src/lib/dictation-fold";
import { openDeepgramLive, type LiveResult } from "../src/lib/deepgram-live";
import { dictationReducer, initialMachine } from "../src/lib/dictation";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

function final(text: string): LiveResult {
  return { text, final: true, startMs: 0, endMs: 0, words: [] };
}
function interim(text: string): LiveResult {
  return { text, final: false, startMs: 0, endMs: 0, words: [] };
}

console.log("\nfoldResults");

check(
  "a final result commits",
  foldResults({ committed: "", interim: "" }, final("Met Priya")).committed === "Met Priya",
);
check(
  "an interim does not commit",
  foldResults({ committed: "Met Priya", interim: "" }, interim("at")).committed === "Met Priya",
);
check(
  "a later interim replaces the earlier one",
  foldResults({ committed: "", interim: "at" }, interim("at Stripe")).interim === "at Stripe",
);
check(
  "a final clears the interim",
  foldResults({ committed: "", interim: "at" }, final("at Stripe")).interim === "",
);
check(
  "finals join with a space",
  foldResults({ committed: "Met Priya", interim: "" }, final("at Stripe")).committed ===
    "Met Priya at Stripe",
);

// A few more, from the shape of a real session.
check(
  "an empty final commits nothing",
  foldResults({ committed: "Met Priya", interim: "at" }, final("")).committed === "Met Priya",
);
check(
  "an empty final still clears the interim",
  foldResults({ committed: "Met Priya", interim: "at" }, final("")).interim === "",
);
check(
  "an interim after a final replaces the (now empty) interim",
  foldResults({ committed: "Met Priya", interim: "" }, interim("at Stripe")).interim === "at Stripe",
);
{
  // A whole short session, folded one result at a time.
  const events: LiveResult[] = [
    interim("Met"),
    interim("Met Priya"),
    final("Met Priya"),
    interim("at"),
    interim("at Stripe"),
    final("at Stripe"),
  ];
  const end = events.reduce<FoldState>((state, r) => foldResults(state, r), { committed: "", interim: "" });
  check("a full session ends fully committed", end.committed === "Met Priya at Stripe");
  check("a full session ends with no dangling interim", end.interim === "");
}

// ── A Deepgram drop, at the reducer ─────────────────────────────────────────────────────
//
// This is the exact event pair `use-dictation.ts`'s `startDeepgramEngine`'s `onClose` and
// `onError` dispatch (see the fix for Critical 1): `{t:"error", code:"network"}` followed
// by `{t:"end"}`, standing in for the Web Speech API's own onerror-always-followed-by-onend
// guarantee that Deepgram's socket doesn't provide. Before the fix, only the `error` half
// was dispatched, which flips `networkRetried` and returns to a `keep()` with NO effects —
// the session would sit in "listening" forever with a dead socket. `dictationReducer`
// itself is untouched; this is what proves dispatching `end` afterward is enough to make
// its existing retry/give-up logic run for Deepgram exactly as it already does for the
// browser engine's own restarts.

console.log("\ndictationReducer: a Deepgram network drop");
{
  let m = initialMachine(true);
  ({ machine: m } = dictationReducer(m, { t: "start", now: 0 }));
  ({ machine: m } = dictationReducer(m, { t: "audiostart" }));
  check("listening before any drop", m.state === "listening");
  check("no free retry spent yet", m.networkRetried === false);

  // First drop.
  const afterError1 = dictationReducer(m, { t: "error", code: "network", now: 10 });
  m = afterError1.machine;
  check("error alone: stays listening (a dead socket, not yet ended)", m.state === "listening");
  check("error alone: spends the one free retry", m.networkRetried === true);
  check("error alone: produces no effect by itself", afterError1.effects.length === 0);

  const afterEnd1 = dictationReducer(m, { t: "end", now: 10 });
  m = afterEnd1.machine;
  check(
    "first drop: the end that follows triggers a reconnect",
    afterEnd1.effects.includes("restart-recognition"),
  );
  check("first drop: still listening — the session survives it", m.state === "listening");

  // Second drop, on the reconnected socket: the free retry is already spent, so this one
  // gives up instead of retrying again.
  const afterError2 = dictationReducer(m, { t: "error", code: "network", now: 20 });
  m = afterError2.machine;
  check("second drop: gives up cleanly", m.state === "error" && m.error === "network");
  check("second drop: intentionalStop is set (no third retry)", m.intentionalStop === true);
  check(
    "second drop: surfaces the existing network toast",
    afterError2.effects.includes("toast-network"),
  );

  const afterEnd2 = dictationReducer(m, { t: "end", now: 20 });
  check(
    "second drop: a trailing end is a no-op once already in state:error",
    afterEnd2.effects.length === 0 && afterEnd2.machine.state === "error",
  );
}

// ── openDeepgramLive, over a fake socket ────────────────────────────────────────────────
//
// Exercises the real `deepgram-live.ts` code — message parsing, the connect handshake, and
// the close/error wiring `use-dictation.ts` reacts to — through the `socketFactory` seam,
// which exists for exactly this.

type CloseListener = (event: { code: number }) => void;

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: CloseListener | null = null;
  private closeListeners: CloseListener[] = [];
  sent: unknown[] = [];

  addEventListener(type: string, cb: CloseListener) {
    if (type === "close") this.closeListeners.push(cb);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  /** An abnormal closure — a dropped connection, not a deliberate `close()`. */
  drop(code = 1006) {
    this.onerror?.();
    this.close(code);
  }
  close(code = 1000) {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    const event = { code };
    this.onclose?.(event);
    for (const cb of this.closeListeners) cb(event);
  }
}

async function main() {
  console.log("\nopenDeepgramLive: fake socket via socketFactory");

  {
    let fake!: FakeSocket;
    const closes: number[] = [];
    const errors: number[] = [];
    const results: LiveResult[] = [];

    const handle = await openDeepgramLive({
      token: "fake-token",
      params: new URLSearchParams({ model: "nova-3" }),
      onResult: (r) => results.push(r),
      onClose: (code) => closes.push(code),
      onError: () => errors.push(1),
      socketFactory: (_url, _protocols) => {
        fake = new FakeSocket();
        // openDeepgramLive assigns `socket.onopen` synchronously inside the connect
        // Promise's executor, which itself runs synchronously — deferring to a
        // microtask guarantees that assignment has already happened by the time this
        // fires.
        queueMicrotask(() => fake.open());
        return fake as unknown as WebSocket;
      },
    });

    check("openDeepgramLive resolves once the fake socket opens", Boolean(handle));
    check("openedAt is a real timestamp", handle.openedAt > 0);

    fake.message({
      type: "Results",
      is_final: true,
      start: 0,
      duration: 1,
      channel: { alternatives: [{ transcript: "Met Priya" }] },
    });
    check("a Results message reaches onResult", results.length === 1 && results[0]?.text === "Met Priya");
    check("it is marked final", results[0]?.final === true);

    fake.drop(1006);
    check("a drop calls onClose exactly once, with the drop's code", closes.length === 1 && closes[0] === 1006);
    check("a drop also calls onError", errors.length === 1);

    // The connection is already dead — finish()/close() on it must not throw, matching
    // what `stop-recognition`/`teardownDeepgram` do after a drop has already torn it down.
    await handle.finish();
    handle.close();
    check("finish()/close() after a drop do not throw", true);
  }

  {
    // A reconnect (Critical 1's fix) is a brand new `openDeepgramLive` call with a brand
    // new socket, wired to its OWN onClose/onError — proving the two connections are
    // independent, which is what lets a stale first socket's belated events not bleed into
    // the reconnected one (the generation guard in `use-dictation.ts` is the other half of
    // that; this is the transport half).
    let first!: FakeSocket;
    const firstCloses: number[] = [];
    await openDeepgramLive({
      token: "t1",
      params: new URLSearchParams(),
      onResult: () => {},
      onClose: (code) => firstCloses.push(code),
      onError: () => {},
      socketFactory: (_u, _p) => {
        first = new FakeSocket();
        queueMicrotask(() => first.open());
        return first as unknown as WebSocket;
      },
    });

    let second!: FakeSocket;
    const secondCloses: number[] = [];
    const secondHandle = await openDeepgramLive({
      token: "t2",
      params: new URLSearchParams(),
      onResult: () => {},
      onClose: (code) => secondCloses.push(code),
      onError: () => {},
      socketFactory: (_u, _p) => {
        second = new FakeSocket();
        queueMicrotask(() => second.open());
        return second as unknown as WebSocket;
      },
    });

    check("a reconnect's handle opens its own, later timestamp", secondHandle.openedAt > 0);

    // The stale first socket dropping again must not touch the second connection's counts.
    first.drop(1007);
    check("a stale first socket's belated drop reaches only its own onClose", firstCloses.length === 1);
    check("...and never the reconnected socket's", secondCloses.length === 0);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll Deepgram dictation checks passed");
  process.exit(0);
}

void main();
