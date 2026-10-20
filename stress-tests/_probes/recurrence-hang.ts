// Spawned by recurrence-edge.ts under a hard timeout: on the current code this never returns.
import { expandEvent, parseRRule } from "../../src/lib/recurrence";
const s = new Date("2026-01-15T10:00:00Z");
const ev = { uid: "u", summary: "s", description: "", location: "", start: s, end: s, attendees: [], organizer: null, timezone: "UTC" };
const interval = process.argv[2] ?? "1000000000";
const out = expandEvent(ev as never, parseRRule(`RRULE:FREQ=MONTHLY;INTERVAL=${interval}`), { from: new Date("2026-01-01"), to: new Date("2027-01-01") });
console.log(out.length);
