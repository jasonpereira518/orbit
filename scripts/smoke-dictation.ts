/**
 * The pure half of voice dictation: transcript tidying, the anchored-span splice, and the
 * recogniser state machine. No DOM, no network, no DB — which is the whole reason the
 * logic was split out of the hook.
 * Run: npx tsx scripts/smoke-dictation.ts
 */
import {
  ANCHOR_INTERFERENCE,
  RESTART_STORM_LIMIT,
  UNSUPPORTED_LATCH_MS,
  dictationReducer,
  initialMachine,
  punctuateSegment,
  shiftAnchor,
  spliceSpan,
  tidyTranscript,
  type DictationEffect,
  type DictationEvent,
  type Machine,
} from "../src/lib/dictation";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

// ── tidyTranscript ────────────────────────────────────────────────────────────────────
console.log("\ntidyTranscript");

check("collapses whitespace runs", tidyTranscript("who  do   I know") === "Who do I know");
check("trims the edges", tidyTranscript("  hello there  ") === "Hello there");
check("capitalises the first letter", tidyTranscript("who works at stripe") === "Who works at stripe");
check(
  "capitalises after sentence punctuation",
  tidyTranscript("i met sara. she runs ops") === "I met sara. She runs ops",
);
check("capitalises after ? and !", tidyTranscript("who? no way! ok") === "Who? No way! Ok");
check("strips the space before punctuation", tidyTranscript("hello , world .") === "Hello, world.");
check("leaves engine punctuation alone", tidyTranscript("Hi, Sara. How are you?") === "Hi, Sara. How are you?");
check("empty stays empty", tidyTranscript("") === "");
check("whitespace-only collapses to empty", tidyTranscript("   ") === "");

// The important one: this runs on every interim event over a growing string.
for (const sample of [
  "who  do I know at ,  stripe .",
  "i said . next thing",
  "  MIXED case . already Fine  ",
  "",
  "a",
]) {
  const once = tidyTranscript(sample);
  check(`idempotent: ${JSON.stringify(sample)}`, tidyTranscript(once) === once, once);
}

// Guard rail: Chrome's en-US recogniser emits real "," and "." characters, so translating
// spoken punctuation words could only ever corrupt real speech. Do not "helpfully" add it.
check('does not rewrite the word "period"', tidyTranscript("period tracking app") === "Period tracking app");
check('does not rewrite the word "comma"', tidyTranscript("the comma splice") === "The comma splice");

// ── punctuateSegment ──────────────────────────────────────────────────────────────────
console.log("\npunctuateSegment");

check("terminates a statement", punctuateSegment("i met sara at yc") === "I met sara at yc.");
check(
  "uses a question mark for an interrogative opener",
  punctuateSegment("who do I know at stripe") === "Who do I know at stripe?",
);
check('"how" opens a question', punctuateSegment("how many recruiters") === "How many recruiters?");
check('"can" opens a question', punctuateSegment("can anyone intro me") === "Can anyone intro me?");
check(
  "a non-interrogative gets a period",
  punctuateSegment("remind me about marcus") === "Remind me about marcus.",
);
check("leaves an existing period alone", punctuateSegment("Done already.") === "Done already.");
check("leaves an existing question mark alone", punctuateSegment("Who is it?") === "Who is it?");
check("leaves an ellipsis alone", punctuateSegment("wait\u2026") === "Wait\u2026");
check("empty stays empty", punctuateSegment("") === "");
check("whitespace-only stays empty", punctuateSegment("   ") === "");
check(
  "a dangling comma becomes a terminator",
  punctuateSegment("stripe, figma, notion,") === "Stripe, figma, notion.",
);
check(
  "an interrogative later in the sentence does not trigger a question mark",
  punctuateSegment("tell me who works there") === "Tell me who works there.",
);
check(
  "still applies the tidy pass",
  punctuateSegment("  who  is at   stripe ") === "Who is at stripe?",
);
for (const sample of ["who do I know at stripe", "i met sara", "Done already.", ""]) {
  const once = punctuateSegment(sample);
  check(`idempotent: ${JSON.stringify(sample)}`, punctuateSegment(once) === once, once);
}
// Filler stripping is deliberately NOT done: Chrome rarely emits "um"/"uh", and a stripper
// aggressive enough to catch them also eats real speech. This pins that decision.
check(
  "does not strip filler-looking words",
  punctuateSegment("um and uh are words") === "Um and uh are words.",
);

// ── spliceSpan ────────────────────────────────────────────────────────────────────────
console.log("\nspliceSpan");

{
  const r = spliceSpan("Who at Acme?", 7, "Acme", "Anthropic");
  check("replaces at the anchor", r?.value === "Who at Anthropic?", r?.value);
  check("reports the span end", r?.spanEnd === 16, String(r?.spanEnd));
}
{
  const r = spliceSpan("Hello ", 6, "", "world");
  check("handles an empty previous span", r?.value === "Hello world", r?.value);
}
{
  const r = spliceSpan("abc", 0, "abc", "xyz");
  check("handles anchor at 0", r?.value === "xyz", r?.value);
}
{
  const r = spliceSpan("abc", 3, "", "!");
  check("handles anchor at the end", r?.value === "abc!", r?.value);
}
{
  const r = spliceSpan("one two three", 4, "two", "TWO");
  check("preserves the trailing text", r?.value === "one TWO three", r?.value);
}
check("null when the span no longer matches", spliceSpan("one two", 4, "XXX", "yyy") === null);
check("null when the anchor is past the end", spliceSpan("abc", 9, "", "x") === null);
check("null when the anchor is negative", spliceSpan("abc", -1, "", "x") === null);
check("null when the span runs past the end", spliceSpan("abc", 2, "bcd", "x") === null);

// ── shiftAnchor ───────────────────────────────────────────────────────────────────────
console.log("\nshiftAnchor");

check(
  "an upstream insertion moves the anchor",
  shiftAnchor("hi there", "oh hi there", 3, 5) === 6,
  String(shiftAnchor("hi there", "oh hi there", 3, 5)),
);
check(
  "an insertion just before the span moves it",
  shiftAnchor("hello world", "hello brave world", 6, 5) === 12,
  String(shiftAnchor("hello world", "hello brave world", 6, 5)),
);
check(
  "an upstream deletion pulls the anchor back",
  shiftAnchor("oh hi there", "hi there", 6, 5) === 3,
  String(shiftAnchor("oh hi there", "hi there", 6, 5)),
);
check(
  "a downstream edit leaves it alone",
  shiftAnchor("say there now", "say there", 4, 5) === 4,
  String(shiftAnchor("say there now", "say there", 4, 5)),
);
check("no change is a no-op", shiftAnchor("same", "same", 2, 1) === 2);
check(
  "an edit inside the span is interference",
  shiftAnchor("a there b", "a thXre b", 2, 5) === ANCHOR_INTERFERENCE,
);
check(
  "deleting part of the span is interference",
  shiftAnchor("a there b", "a tere b", 2, 5) === ANCHOR_INTERFERENCE,
);

// ── dictationReducer ──────────────────────────────────────────────────────────────────
console.log("\ndictationReducer");

/** Drive a machine through a script of events, collecting every effect on the way. */
function run(m: Machine, events: DictationEvent[]) {
  const effects: DictationEffect[] = [];
  let machine = m;
  for (const e of events) {
    const r = dictationReducer(machine, e);
    machine = r.machine;
    effects.push(...r.effects);
  }
  return { machine, effects };
}

check("an unsupported machine starts unsupported", initialMachine(false).state === "unsupported");
check("a supported machine starts idle", initialMachine(true).state === "idle");
{
  const r = run(initialMachine(false), [{ t: "start", now: 0 }]);
  check("unsupported ignores start", r.machine.state === "unsupported" && r.effects.length === 0);
}

{
  const r = run(initialMachine(true), [{ t: "start", now: 0 }]);
  check("start → requesting", r.machine.state === "requesting", r.machine.state);
  check("start asks the engine to begin", r.effects.join() === "start-recognition", r.effects.join());
  check("start bumps the session id", r.machine.sessionId === 1);
}
{
  const r = run(initialMachine(true), [{ t: "start", now: 0 }, { t: "audiostart" }]);
  check("audiostart → listening", r.machine.state === "listening", r.machine.state);
}
{
  // Safari is unreliable about audiostart, so a result has to be enough on its own.
  const r = run(initialMachine(true), [{ t: "start", now: 0 }, { t: "result" }]);
  check("a result alone reaches listening", r.machine.state === "listening", r.machine.state);
}
{
  const r = run(initialMachine(true), [
    { t: "start", now: 0 },
    { t: "audiostart" },
    { t: "start", now: 10 },
  ]);
  check("start while listening is a no-op", r.machine.sessionId === 1 && r.effects.length === 1);
}

{
  const r = run(initialMachine(true), [
    { t: "start", now: 0 },
    { t: "audiostart" },
    { t: "stop" },
  ]);
  check("stop marks the stop intentional", r.machine.intentionalStop === true);
  check("stop asks the engine to flush", r.effects.includes("stop-recognition"));
  const after = dictationReducer(r.machine, { t: "end", now: 100 });
  check("the end after an intentional stop lands in idle", after.machine.state === "idle");
  check("...and does not restart", after.effects.length === 0, after.effects.join());
}

{
  // The engine timing out server-side mid-sentence must not end the user's session.
  const r = run(initialMachine(true), [
    { t: "start", now: 0 },
    { t: "audiostart" },
    { t: "end", now: 100 },
  ]);
  check("an unintentional end restarts", r.effects.includes("restart-recognition"));
  check("...and stays listening", r.machine.state === "listening", r.machine.state);
}

{
  // Chrome spin-loops end→start→end when the mic device disappears.
  const events: DictationEvent[] = [{ t: "start", now: 0 }, { t: "audiostart" }];
  for (let i = 0; i < RESTART_STORM_LIMIT; i++) events.push({ t: "end", now: 10 + i });
  const r = run(initialMachine(true), events);
  check("a restart storm halts", r.machine.state === "error", r.machine.state);
  check("...as audio-capture", r.machine.error === "audio-capture", String(r.machine.error));
  check("...and toasts once", r.effects.filter((x) => x === "toast-no-microphone").length === 1);
}
{
  // Spread far enough apart, the same number of restarts is just a long dictation.
  const events: DictationEvent[] = [{ t: "start", now: 0 }, { t: "audiostart" }];
  for (let i = 0; i < RESTART_STORM_LIMIT + 2; i++) events.push({ t: "end", now: 5000 * (i + 1) });
  const r = run(initialMachine(true), events);
  check("slow restarts do not trip the brake", r.machine.state === "listening", r.machine.state);
}

{
  const r = run(initialMachine(true), [
    { t: "start", now: 0 },
    { t: "audiostart" },
    { t: "error", code: "not-allowed", now: 5000 },
  ]);
  check("a denial errors", r.machine.state === "error" && r.machine.error === "not-allowed");
  check("...toasts", r.effects.includes("toast-denied"));
  check("...and latches denied", r.machine.denied === true);
  const again = dictationReducer(r.machine, { t: "start", now: 9000 });
  check("a later start re-toasts without starting", again.effects.join() === "toast-denied", again.effects.join());
}
{
  // The constructor existed but the engine never did — withdraw the feature silently.
  const r = run(initialMachine(true), [
    { t: "start", now: 0 },
    { t: "error", code: "not-allowed", now: UNSUPPORTED_LATCH_MS - 1 },
  ]);
  check("an instant pre-audio denial means unsupported", r.machine.state === "unsupported", r.machine.state);
  check("...silently", r.effects.length === 1 && r.effects[0] === "start-recognition", r.effects.join());
}
{
  const r = run(initialMachine(true), [
    { t: "start", now: 0 },
    { t: "error", code: "not-allowed", now: UNSUPPORTED_LATCH_MS + 50 },
  ]);
  check("a slower pre-audio denial is a real denial", r.machine.state === "error", r.machine.state);
}

{
  // Chrome raises no-speech after ~7-8s of quiet. It used to end the session, which was
  // the "mic dies while I stop to think" bug. It must now be survivable.
  const r = run(initialMachine(true), [
    { t: "start", now: 0 },
    { t: "audiostart" },
    { t: "error", code: "no-speech", now: 3000 },
  ]);
  check("no-speech never surfaces", r.effects.filter((x) => x.startsWith("toast")).length === 0);
  check("no-speech does NOT mark an intentional stop", r.machine.intentionalStop === false);
  const after = dictationReducer(r.machine, { t: "end", now: 3010 });
  check("...so the following end restarts", after.effects.includes("restart-recognition"));
  check("...and the session stays live", after.machine.state === "listening", after.machine.state);
}
{
  const r = run(initialMachine(true), [
    { t: "start", now: 0 },
    { t: "audiostart" },
    { t: "error", code: "aborted", now: 100 },
  ]);
  check("aborted is entirely silent", r.effects.filter((x) => x.startsWith("toast")).length === 0);
  check("...and changes no state", r.machine.state === "listening", r.machine.state);
}
{
  const first = run(initialMachine(true), [
    { t: "start", now: 0 },
    { t: "audiostart" },
    { t: "error", code: "network", now: 100 },
  ]);
  check("the first network blip is silent", first.effects.filter((x) => x.startsWith("toast")).length === 0);
  const second = dictationReducer(first.machine, { t: "error", code: "network", now: 200 });
  check("a second one toasts", second.effects.includes("toast-network"));
  check("...and errors", second.machine.state === "error" && second.machine.error === "network");
}
{
  const r = run(initialMachine(true), [
    { t: "start", now: 0 },
    { t: "error", code: "something-new", now: 100 },
  ]);
  check("an unknown code errors without a toast", r.machine.state === "error" && r.machine.error === "unknown");
  check("...silently", r.effects.filter((x) => x.startsWith("toast")).length === 0);
}

{
  // The send race: cancel must invalidate anything the abort flushes on its way out.
  const r = run(initialMachine(true), [
    { t: "start", now: 0 },
    { t: "audiostart" },
    { t: "cancel" },
  ]);
  check("cancel goes straight to idle", r.machine.state === "idle", r.machine.state);
  check("cancel aborts the engine", r.effects.includes("abort-recognition"));
  check("cancel invalidates the session", r.machine.sessionId === 2, String(r.machine.sessionId));
}
{
  const r = run(initialMachine(true), [
    { t: "start", now: 0 },
    { t: "error", code: "audio-capture", now: 100 },
  ]);
  check("audio-capture errors and toasts", r.machine.state === "error" && r.effects.includes("toast-no-microphone"));
  const reset = dictationReducer(r.machine, { t: "reset" });
  check("reset clears the error to idle", reset.machine.state === "idle" && reset.machine.error === null);
  check("...with no side effects", reset.effects.length === 0);
  const restarted = dictationReducer(reset.machine, { t: "start", now: 200 });
  check("...and the mic works again", restarted.machine.state === "requesting");
}
{
  const idle = initialMachine(true);
  check("reset on a healthy machine is a no-op", dictationReducer(idle, { t: "reset" }).machine.state === "idle");
}

{
  // A pause seals a sentence and keeps listening. It must never stop the engine.
  const r = run(initialMachine(true), [
    { t: "start", now: 0 },
    { t: "audiostart" },
    { t: "segment" },
  ]);
  check("a pause seals", r.effects.includes("seal-segment"));
  check("...without stopping", !r.effects.includes("stop-recognition"));
  check("...and stays listening", r.machine.state === "listening", r.machine.state);
  check("...leaving the stop unintentional", r.machine.intentionalStop === false);
}
{
  const r = run(initialMachine(true), [{ t: "start", now: 0 }, { t: "segment" }]);
  check("a pause before audio does nothing", r.effects.join() === "start-recognition", r.effects.join());
}
{
  const idle = initialMachine(true);
  check("a pause while idle does nothing", dictationReducer(idle, { t: "segment" }).effects.length === 0);
}
{
  // Sealing repeatedly across a long dictation must never accumulate a stop.
  const events: DictationEvent[] = [{ t: "start", now: 0 }, { t: "audiostart" }];
  for (let i = 0; i < 5; i++) events.push({ t: "result" }, { t: "segment" });
  const r = run(initialMachine(true), events);
  check("five seals, still listening", r.machine.state === "listening", r.machine.state);
  check("...five seal effects", r.effects.filter((x) => x === "seal-segment").length === 5);
  check("...and no stop", !r.effects.includes("stop-recognition"));
}

console.log("\nsmoke-dictation: all checks passed");
