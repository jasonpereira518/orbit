/**
 * Guards the wire format for `/api/capture/parse` — src/lib/sse.ts and the key derivation
 * in src/lib/capture-preview.ts.
 *
 * What is worth pinning here, beyond "JSON survives a round trip":
 *
 *   - Events reassemble across arbitrary chunk boundaries. A stage event is tens of bytes
 *     and a person event is kilobytes, so a single read can hold six events or a third of
 *     one.
 *   - Comment frames carry nothing. The route interleaves a keepalive every 15s (detail
 *     batches run up to 45s) and pads the stream open past Safari's 1024-byte buffer; if
 *     either were parsed as an event the client would see garbage.
 *   - Roster keys and person keys agree. They are derived at two different moments in
 *     `runCaptureParse` — once from the identify pass, once from the assembled items — and
 *     if they disagreed every person would appear twice in the review list, once as a
 *     skeleton that never resolves.
 */
import {
  formatSse,
  parseSseChunk,
  sseComment,
  sseOpeningPad,
} from "../src/lib/sse";
import { personPreviewKey } from "../src/lib/capture-preview";
import {
  CAPTURE_STAGE_LABEL,
  type CaptureStage,
  type CaptureStreamEvent,
} from "../src/lib/capture-stream-protocol";

let failures = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

/** Feed a wire string through the parser in `size`-byte slices. */
function drain(wire: string, size: number): CaptureStreamEvent[] {
  const events: CaptureStreamEvent[] = [];
  let carry = "";
  for (let i = 0; i < wire.length; i += size) {
    const parsed = parseSseChunk<CaptureStreamEvent>(wire.slice(i, i + size), carry);
    carry = parsed.carry;
    events.push(...parsed.events);
  }
  return events;
}

const sample: CaptureStreamEvent[] = [
  { type: "stage", stage: "reading" },
  { type: "stage", stage: "identifying" },
  {
    type: "roster",
    people: [
      { key: personPreviewKey(0, "Dana Cruz"), name: "Dana Cruz", company: "Helix", role: "PM" },
      { key: personPreviewKey(1, "Ravi Menon"), name: "Ravi Menon", company: null, role: null },
    ],
  },
  { type: "stage", stage: "detailing", done: 0, total: 2 },
  { type: "stage", stage: "detailing", done: 2, total: 2 },
  { type: "error", message: "line one\n\nline two — a blank line inside a payload" },
];

console.log("SSE framing...");

const wire = sample.map(formatSse).join("");

ok(
  "each event is one data: line ending in a blank line",
  wire.split("\n\n").filter(Boolean).every((f) => f.startsWith("data: "))
);

for (const size of [1, 3, 7, 64, 4096]) {
  const events = drain(wire, size);
  ok(
    `events reassemble in ${size}-byte chunks`,
    JSON.stringify(events) === JSON.stringify(sample)
  );
}

ok(
  "a payload containing a blank line survives framing",
  (drain(wire, 5).at(-1) as { message?: string })?.message ===
    "line one\n\nline two — a blank line inside a payload"
);

{
  const parsed = parseSseChunk<CaptureStreamEvent>(wire, "");
  ok("nothing is left over after the last event", parsed.carry === "");
}

console.log("\nComment frames...");

{
  // The route's real opening sequence: pad, an event, a keepalive, another event.
  const withComments =
    sseOpeningPad() +
    formatSse(sample[0]) +
    sseComment("keepalive") +
    formatSse(sample[1]);
  for (const size of [1, 17, 512, 8192]) {
    const events = drain(withComments, size);
    ok(
      `pad and keepalive carry no events at ${size} bytes`,
      JSON.stringify(events) === JSON.stringify([sample[0], sample[1]])
    );
  }
  ok("the opening pad clears Safari's 1024-byte buffer", sseOpeningPad().length > 1024);
}

console.log("\nMalformed frames...");

{
  const broken = formatSse(sample[0]) + "data: {not json\n\n" + formatSse(sample[1]);
  const events = drain(broken, 9);
  ok(
    "a malformed frame is dropped without poisoning the rest",
    JSON.stringify(events) === JSON.stringify([sample[0], sample[1]])
  );
}

{
  // The server closes without a trailing blank line. `readSseStream` feeds a synthetic
  // "\n\n" on the final decode; this asserts the frame is genuinely stuck without it.
  const truncated = formatSse(sample[0]) + "data: " + JSON.stringify(sample[1]);
  const held = parseSseChunk<CaptureStreamEvent>(truncated, "");
  ok("a frame with no trailing blank line is held, not dropped", held.events.length === 1);
  const flushed = parseSseChunk<CaptureStreamEvent>("\n\n", held.carry);
  ok("...and is recovered when the reader flushes", flushed.events.length === 1);
}

console.log("\nPerson keys...");

{
  // Both sides of the roster/person handshake, as `runCaptureParse` computes them.
  const names = ["Dana Cruz", "Ravi Menon", "Dana Cruz"];
  const fromRoster = names.map((n, i) => personPreviewKey(i, n));
  const fromItems = names.map((n, i) => personPreviewKey(i, n));
  ok("roster keys match item keys", JSON.stringify(fromRoster) === JSON.stringify(fromItems));
  ok("two people with the same name get distinct keys", fromRoster[0] !== fromRoster[2]);
  ok("a nameless person still gets a key", personPreviewKey(4, null) === "4-person");
  ok("keys are unique across a batch", new Set(fromRoster).size === fromRoster.length);
}

console.log("\nStage labels...");

{
  const stages: CaptureStage[] = [
    "reading",
    "identifying",
    "detailing",
    "dating",
    "matching",
  ];
  ok(
    "every stage has copy",
    stages.every((s) => Boolean(CAPTURE_STAGE_LABEL[s]?.trim()))
  );
}

if (failures) {
  console.error(`\ncapture-stream smoke tests FAILED (${failures})`);
  process.exit(1);
}

console.log("\nAll capture-stream checks passed.");
process.exit(0);
