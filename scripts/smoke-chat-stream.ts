/**
 * Pins the chat streaming protocol in `src/lib/chat-stream-protocol.ts`.
 *
 * A streamed answer cannot be JSON — the model's prose has to reach the browser as it is
 * produced. So the model writes prose, then a marker line, then the recommendations as
 * JSON. The splitter forwards prose deltas as they arrive, holds back only what might be
 * the start of the marker, and parses whatever follows the marker once the stream ends.
 * The SSE helpers frame events for the route and re-assemble them in the browser across
 * arbitrary chunk boundaries.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-chat-stream.ts
 */
import {
  RECOMMENDATIONS_MARKER,
  createAnswerSplitter,
  formatSse,
  parseSseChunk,
  type ChatStreamEvent,
} from "../src/lib/chat-stream-protocol";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** Feed chunks through a splitter; return emitted deltas and the final result. */
function run(chunks: string[]) {
  const s = createAnswerSplitter();
  const emitted: string[] = [];
  for (const c of chunks) {
    const d = s.push(c);
    if (d) emitted.push(d);
  }
  return { emitted, result: s.finish() };
}

const RECS = JSON.stringify([
  { contact_id: "c1", recruiter_id: null, name: "Ada", reason: "she ships", suggested_action: "email", draft_message: null },
]);

function main() {
  console.log("Answer splitter...");
  let r = run([`Ada is your best bet.\n${RECOMMENDATIONS_MARKER}\n${RECS}`]);
  check("prose before the marker is emitted", r.emitted.join("") === "Ada is your best bet.\n", JSON.stringify(r.emitted));
  check("recommendations after the marker are parsed", r.result.recommendations.length === 1 && r.result.recommendations[0].contact_id === "c1");
  check("the finished answer is trimmed prose only", r.result.answer === "Ada is your best bet.");

  r = run(["Ada is your best bet.\n--", "-RECOMMEN", "DATIONS---\n", RECS.slice(0, 20), RECS.slice(20)]);
  check("a marker split across chunks never leaks into the prose", r.emitted.join("") === "Ada is your best bet.\n", JSON.stringify(r.emitted));
  check("JSON split across chunks still parses", r.result.recommendations.length === 1);

  r = run(["Nobody in your ", "orbit matches that."]);
  check("no marker: everything is prose", r.emitted.join("") === "Nobody in your orbit matches that." && r.result.answer === "Nobody in your orbit matches that.");
  check("no marker: no recommendations, no error", r.result.recommendations.length === 0 && !r.result.parseError);

  r = run(["Try Ada. A plain dash - or two -- in prose is fine.", ` ${RECOMMENDATIONS_MARKER}\n[]`]);
  check("dashes in prose are not held back forever", r.emitted.join("") === "Try Ada. A plain dash - or two -- in prose is fine. ");
  check("an empty array parses", r.result.recommendations.length === 0 && !r.result.parseError);

  r = run([`Ada.\n${RECOMMENDATIONS_MARKER}\n{not json`]);
  check("bad JSON after the marker keeps the prose and reports a parse error", r.result.answer === "Ada." && r.result.recommendations.length === 0 && Boolean(r.result.parseError));

  r = run([`Ada.\n${RECOMMENDATIONS_MARKER}\n\`\`\`json\n${RECS}\n\`\`\``]);
  check("a fenced JSON block is tolerated", r.result.recommendations.length === 1);

  r = run([`Ada.\n${RECOMMENDATIONS_MARKER}\n{"recommendations": ${RECS}}`]);
  check("an object wrapping the array is tolerated", r.result.recommendations.length === 1);

  console.log("\nSSE framing...");
  const events: ChatStreamEvent[] = [
    { type: "answer", delta: "Hello\n\nworld" },
    { type: "recommendations", items: [] },
    { type: "done", messageId: "m1", threadId: "t1", title: "Hi", retrieved: [] },
  ];
  const wire = events.map(formatSse).join("");
  check("each event is one data: line ending in a blank line", wire.split("\n\n").filter(Boolean).length === 3, JSON.stringify(wire));
  const all: ChatStreamEvent[] = [];
  let carry = "";
  for (const piece of [wire.slice(0, 7), wire.slice(7, 40), wire.slice(40)]) {
    const parsed = parseSseChunk(piece, carry);
    carry = parsed.carry;
    all.push(...parsed.events);
  }
  check("events re-assemble across arbitrary chunk boundaries", all.length === 3 && all[0].type === "answer" && all[2].type === "done", JSON.stringify(all));
  check("a delta containing a blank line survives framing", all[0].type === "answer" && all[0].delta === "Hello\n\nworld");
  check("nothing is left over after the last event", carry === "");

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll chat-stream checks passed.");
}

main();
