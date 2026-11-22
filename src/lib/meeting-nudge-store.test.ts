import "../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import * as mod from "@/lib/meeting-nudge-store";
import type { MeetingCandidate } from "@/lib/meeting-calendar";
import { captureStore, installBrowser } from "@/lib/test-support/external-store-harness";

const env = installBrowser();
const g = globalThis as Record<string, unknown>;
const realFetch = g.fetch;

// Fake global timers (the store uses bare setTimeout/setInterval), installed only inside
// each test so the node:test runner keeps its real ones.
type Fn = () => void;
const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};
let nextTimer = 1;
const timeouts = new Map<number, { fn: Fn; ms: number }>();
const intervals = new Map<number, { fn: Fn; ms: number }>();
beforeEach(() => {
  g.setTimeout = ((fn: Fn, ms: number) => {
    const id = nextTimer++;
    timeouts.set(id, { fn, ms });
    return id;
  });
  g.clearTimeout = ((id: number) => void timeouts.delete(id));
  g.setInterval = ((fn: Fn, ms: number) => {
    const id = nextTimer++;
    intervals.set(id, { fn, ms });
    return id;
  });
  g.clearInterval = ((id: number) => void intervals.delete(id));
});
afterEach(() => {
  Object.assign(g, real);
});
after(() => {
  env.restore();
  g.fetch = realFetch;
});

let reply: unknown = { ok: true, status: "ok", events: [] };
let fetches = 0;
g.fetch = async () => {
  fetches++;
  return new Response(JSON.stringify(reply), { status: 200 });
};
const flush = () => new Promise<void>((r) => real.setTimeout(r, 5));

const soon = (id: string, over: Partial<MeetingCandidate> = {}): MeetingCandidate => ({
  id,
  title: `Meeting ${id}`,
  startIso: new Date(Date.now() + 2 * 60_000).toISOString(),
  endIso: new Date(Date.now() + 32 * 60_000).toISOString(),
  attendees: [],
  call: null,
  webinar: false,
  seriesId: null,
  eventKey: null,
  ...over,
});

describe("meeting-nudge-store: this device's on/off", () => {
  const on = captureStore<boolean>(mod.useMeetingNudgeOn);
  const setting = captureStore<boolean | null>(mod.useMeetingNudgeSetting);

  it("defaults to on; server snapshots are false / null so hydration agrees", () => {
    assert.equal(mod.isMeetingNudgeOn(), true);
    assert.equal(on.getSnapshot(), true);
    assert.equal(setting.getSnapshot(), true);
    assert.equal(on.getServerSnapshot(), false);
    assert.equal(setting.getServerSnapshot(), null);
  });

  it("setMeetingNudgeOn writes the pref, notifies each subscriber once; storage events for the key notify too", () => {
    let a = 0;
    let b = 0;
    const offA = on.subscribe(() => a++);
    const offB = setting.subscribe(() => b++);
    assert.equal(env.window.count("storage"), 2, "one storage listener per pref subscriber");
    mod.setMeetingNudgeOn(false);
    assert.equal(env.data.get("orbit:meeting-nudge:v1"), "0");
    assert.equal(mod.isMeetingNudgeOn(), false);
    assert.equal(on.getSnapshot(), false);
    assert.deepEqual([a, b], [1, 1]);
    env.window.dispatch("storage", { key: "other" });
    assert.deepEqual([a, b], [1, 1]);
    env.window.dispatch("storage", { key: "orbit:meeting-nudge:v1" });
    assert.deepEqual([a, b], [2, 2]);
    offA();
    assert.equal(env.window.count("storage"), 1);
    mod.setMeetingNudgeOn(true);
    assert.equal(env.data.has("orbit:meeting-nudge:v1"), false);
    assert.deepEqual([a, b], [2, 3]);
    offB();
    assert.equal(env.window.count("storage"), 0);
  });
});

describe("meeting-nudge-store: the shared poll", () => {
  const store = captureStore<mod.NudgeSnapshot>(() => mod.useMeetingNudgeSnapshot(true));
  const disabled = captureStore<mod.NudgeSnapshot>(() => mod.useMeetingNudgeSnapshot(false));
  let fired = 0;
  let off: () => void = () => {};

  it("server and initial snapshots are one stable EMPTY object; a disabled reader never subscribes", () => {
    const s = store.getSnapshot();
    assert.deepEqual(s, { nudge: null, timing: "" });
    assert.equal(store.getSnapshot(), s);
    assert.equal(store.getServerSnapshot(), s);
    assert.equal(disabled.getSnapshot(), s);
    const offDisabled = disabled.subscribe(() => {});
    assert.equal(timeouts.size + intervals.size, 0);
    assert.equal(env.document.count("visibilitychange"), 0);
    offDisabled();
  });

  it("first subscriber starts the first-read timeout, two intervals and a visibility listener; the last stops them", () => {
    const off1 = store.subscribe(() => {});
    assert.deepEqual([...timeouts.values()].map((t) => t.ms), [3_000]);
    assert.deepEqual([...intervals.values()].map((t) => t.ms).sort((x, y) => x - y), [15_000, 600_000]);
    assert.equal(env.document.count("visibilitychange"), 1);
    const off2 = store.subscribe(() => {});
    assert.equal(timeouts.size, 1);
    assert.equal(intervals.size, 2);
    assert.equal(env.document.count("visibilitychange"), 1);
    off1();
    assert.equal(intervals.size, 2);
    off2();
    assert.equal(timeouts.size, 0);
    assert.equal(intervals.size, 0);
    assert.equal(env.document.count("visibilitychange"), 0);
  });

  it("a refresh that finds an imminent meeting emits once; unchanged recomputes keep the reference", async () => {
    off = store.subscribe(() => fired++);
    const e1 = soon("e1", { seriesId: "s1" });
    reply = { ok: true, status: "ok", events: [e1] };
    const empty = store.getSnapshot();
    [...timeouts.values()][0].fn();
    await flush();
    assert.equal(fetches, 1);
    assert.equal(fired, 1);
    const s = store.getSnapshot();
    assert.notEqual(s, empty);
    assert.equal(s.nudge?.id, "e1");
    assert.match(s.timing, /^starts in \d+ min$/);
    assert.equal(store.getSnapshot(), s);
    // The 15 s tick recomputes: same offer, same wording -> nothing emitted, same reference.
    const tick = [...intervals.values()].find((i) => i.ms === 15_000)!;
    tick.fn();
    tick.fn();
    assert.equal(fired, 1);
    assert.equal(store.getSnapshot(), s);
    // A visibility change recomputes too (and refreshes only after 5 min).
    env.document.dispatch("visibilitychange");
    assert.equal(fired, 1);
    assert.equal(fetches, 1);
  });

  it("skipping a series hides its occurrences: back to EMPTY, one emit, persisted", () => {
    mod.skipMeetingSeries("s1");
    assert.equal(fired, 2);
    assert.equal(store.getSnapshot(), store.getServerSnapshot());
    assert.deepEqual(JSON.parse(env.data.get("orbit:meeting-nudge-skipped-series:v1")!), ["s1"]);
  });

  it("a new offer then a dismissal: emits per change, dismissals persist (last 50) and apply", async () => {
    const e2 = soon("e2");
    reply = { ok: true, status: "ok", events: [soon("e1", { seriesId: "s1" }), e2] };
    [...intervals.values()].find((i) => i.ms === 600_000)!.fn();
    await flush();
    assert.equal(fired, 3);
    assert.equal(store.getSnapshot().nudge?.id, "e2");
    mod.dismissMeetingNudge(`${e2.id}@${e2.startIso}`);
    assert.equal(fired, 4);
    assert.equal(store.getSnapshot(), store.getServerSnapshot());
    assert.deepEqual(JSON.parse(env.data.get("orbit:meeting-nudge-dismissed:v1")!), [`${e2.id}@${e2.startIso}`]);
    for (let i = 0; i < 60; i++) mod.dismissMeetingNudge(`k${i}`);
    assert.equal(JSON.parse(env.data.get("orbit:meeting-nudge-dismissed:v1")!).length, 50);
  });

  it("corrupt or non-array dismissal storage reads as empty rather than throwing", async () => {
    env.data.set("orbit:meeting-nudge-dismissed:v1", "{not json");
    env.data.set("orbit:meeting-nudge-skipped-series:v1", JSON.stringify({ a: 1 }));
    reply = { ok: true, status: "ok", events: [soon("e3")] };
    [...intervals.values()].find((i) => i.ms === 600_000)!.fn();
    await flush();
    assert.equal(store.getSnapshot().nudge?.id, "e3");
  });

  it("turning the pref off clears the offer; unsubscribe stops notifications", () => {
    const before = fired;
    mod.setMeetingNudgeOn(false);
    assert.equal(fired, before + 1);
    assert.equal(store.getSnapshot(), store.getServerSnapshot());
    mod.setMeetingNudgeOn(true); // the cached event is offerable again
    assert.equal(fired, before + 2);
    assert.equal(store.getSnapshot().nudge?.id, "e3");
    off();
    assert.equal(intervals.size, 0);
    mod.setMeetingNudgeOn(false);
    mod.setMeetingNudgeOn(true);
    assert.equal(fired, before + 2);
  });

  it("a non-ok answer stops asking for the rest of the session and clears events", async () => {
    const off2 = store.subscribe(() => {});
    reply = { ok: true, status: "not-connected", events: [] };
    const before = fetches;
    [...intervals.values()].find((i) => i.ms === 600_000)!.fn();
    await flush();
    assert.equal(fetches, before + 1);
    assert.equal(store.getSnapshot(), store.getServerSnapshot());
    [...intervals.values()].find((i) => i.ms === 600_000)!.fn();
    await flush();
    assert.equal(fetches, before + 1, "stopped");
    off2();
  });
});
