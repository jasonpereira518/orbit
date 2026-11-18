/**
 * The layout decides the Ask bar from `radarIsOnFromSettings` (src/lib/radar/digest.ts)
 * because `radarIsOn` (radar/run.ts) is too heavy for its server graph. They must agree.
 */
import { checker } from "./smoke/check";
import { radarIsOn } from "../src/lib/radar/run";
import { radarIsOnFromSettings } from "../src/lib/radar/digest";

const t = checker();
const enabled = [null, undefined, new Date(), "2026-11-16T00:00:00Z"] as const;
const paused = [0, 1, null, undefined] as const;
for (const e of enabled) {
  for (const p of paused) {
    t.check(
      `enabledAt=${e instanceof Date ? "Date" : String(e)} paused=${String(p)} agrees`,
      radarIsOnFromSettings(e, p) === radarIsOn(e, p),
    );
  }
}
t.done("radar-is-on parity smoke tests");
process.exit(0);
