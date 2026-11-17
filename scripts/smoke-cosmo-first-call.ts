/**
 * First-call memory (src/lib/cosmo/first-call.ts): the first Cosmo call on a browser asks first;
 * after one has started it never asks again. Private mode (storage throws) asks every time.
 */
import { checker } from "./smoke/check";
import { FIRST_CALL_KEY, hasStartedCall, markCallStarted } from "../src/lib/cosmo/first-call";

const t = checker();
const data = new Map<string, string>();
const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };

t.check("empty storage: not started", hasStartedCall(storage) === false);
markCallStarted(storage);
t.check("after marking: started", hasStartedCall(storage) === true);
t.check("stored under the documented key", data.has(FIRST_CALL_KEY) && FIRST_CALL_KEY === "orbit:cosmo-first-call");
t.check(
  "storage that throws counts as not started",
  hasStartedCall({ getItem: () => { throw new Error("denied"); } }) === false,
);
let threw = false;
try { markCallStarted({ setItem: () => { throw new Error("denied"); } }); } catch { threw = true; }
t.check("marking in private mode does not throw", !threw);
// Blocked storage: the bare `localStorage` global throws (no window here, same effect).
t.check("default storage unavailable: not started, no throw", hasStartedCall() === false);
let defaultThrew = false;
try { markCallStarted(); } catch { defaultThrew = true; }
t.check("default storage unavailable: marking does not throw", !defaultThrew);

t.done("cosmo first-call smoke tests");
