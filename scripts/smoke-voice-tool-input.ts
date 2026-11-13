/**
 * Cosmo's lookups and dates, pure: tool arguments however the model writes them
 * (src/lib/voice/tool-input.ts — every shape but a JSON-object string used to throw in the
 * browser, so lookups never reached the server), and dates as people say them
 * (spokenWhen / withSpokenDates in src/lib/user-clock.ts).
 */
import { checker } from "./smoke/check";
import { normalizeToolCall, normalizeToolInput } from "../src/lib/voice/tool-input";
import { spokenWhen, withSpokenDates } from "../src/lib/user-clock";

const t = checker();
const ok = (raw: unknown, expect: Record<string, unknown>) => {
  const r = normalizeToolInput(raw);
  return "args" in r && JSON.stringify(r.args) === JSON.stringify(expect);
};
t.check("a JSON-object string", ok('{"query":"Ada"}', { query: "Ada" }));
t.check("an object, as models often send", ok({ query: "Ada" }, { query: "Ada" }));
t.check("nothing at all", ok(undefined, {}) && ok(null, {}) && ok("", {}) && ok("  ", {}));
t.check("double-encoded", ok(JSON.stringify('{"query":"Ada"}'), { query: "Ada" }));
t.check("JSON null", ok("null", {}));
t.check("broken JSON says why", "error" in normalizeToolInput("{query: Ada"));
t.check("a list is refused with a reason", "error" in normalizeToolInput("[1,2]") && "error" in normalizeToolInput([1]));
t.check("a number is refused", "error" in normalizeToolInput(5));
const call = normalizeToolCall(JSON.stringify({ tool: "search_contacts", input: { query: "Ada" } }));
t.check("a Deepgram call with an object input", "tool" in call && call.tool === "search_contacts" && ok(call.input, { query: "Ada" }));
t.check("a call without a tool name says what's missing", "error" in normalizeToolCall('{"input":"{}"}'));

// Thursday, November 13 2026, 3:00 PM in New York.
const now = new Date("2026-11-13T20:00:00Z");
const tz = "America/New_York";
const say = (v: string) => spokenWhen(v, tz, now);
t.check("today with a time", say("2026-11-13T20:00:00Z") === "today at 3 PM", String(say("2026-11-13T20:00:00Z")));
t.check("tomorrow", say("2026-11-14") === "tomorrow");
t.check("yesterday", say("2026-11-12") === "yesterday");
t.check("later this week by name", say("2026-11-15") === "Sunday", String(say("2026-11-15")));
t.check("next week is 'next'", say("2026-11-17T15:30:00Z") === "next Tuesday at 10:30 AM", String(say("2026-11-17T15:30:00Z")));
t.check("earlier this week", say("2026-11-10") === "on Tuesday", String(say("2026-11-10")));
t.check("last week", say("2026-11-06") === "last Friday", String(say("2026-11-06")));
t.check("further out: the date", say("2026-12-04") === "on December 4");
t.check("another year names it", say("2027-01-20") === "on January 20, 2027");
t.check("the user's day, not UTC's (10 PM New York is still today)", say("2026-11-14T03:00:00Z") === "today at 10 PM", String(say("2026-11-14T03:00:00Z")));
t.check("not a date: nothing", say("Ada Lovelace") === null && say("2026") === null);
const annotated = withSpokenDates({ meetings: [{ title: "Coffee", startIso: "2026-11-14T15:00:00Z" }] }, tz, now) as {
  meetings: Array<Record<string, string>>;
};
t.check("results gain a spoken twin per date", annotated.meetings[0].startIso_spoken === "tomorrow at 10 AM" && annotated.meetings[0].title === "Coffee");

t.done("voice tool input and spoken dates smoke tests");
