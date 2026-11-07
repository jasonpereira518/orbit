/**
 * stripMarkdown and listSummary: summaries shown as plain text carry no markdown markers, and
 * list rows (/meetings, /capture) drop headings and metadata lines. Pure tier.
 */
import { checker } from "./smoke/check";
import { listSummary, stripMarkdown } from "../src/lib/plain-text";

const t = checker();
const cases: Array<[string, string]> = [
  ["### Key points\n- **NVIDIA** is hiring\n- Follow up _Friday_", "Key points NVIDIA is hiring Follow up Friday"],
  ["1. First\n2) Second", "First Second"],
  ["See [the deck](https://x.com) and `code`", "See the deck and code"],
  ["> quoted line\n\n---\nafter", "quoted line after"],
  ["snake_case_name and 2*3*4 stay", "snake_case_name and 2*3*4 stay"],
  ["", ""],
];
for (const [input, want] of cases) {
  const got = stripMarkdown(input);
  t.check(JSON.stringify(input).slice(0, 40), got === want, `got ${JSON.stringify(got)}`);
}
const summaryCases: Array<[string | null, string | null]> = [
  ["### Overview\n- **NVIDIA** is hiring\n- Follow up _Friday_", "NVIDIA is hiring. Follow up Friday."],
  ["Attendees: Dana, Eli\nWhen: Monday\n\n**Key points**\nScope agreed; Dana owns the rollout.", "Scope agreed; Dana owns the rollout."],
  ["Next steps:\n1. Send the deck\n2) Book a call", "Next steps: Send the deck. Book a call."],
  ["We agreed pricing is per seat.", "We agreed pricing is per seat."],
  ["## Only a heading", null],
  ["", null],
  [null, null],
];
for (const [input, want] of summaryCases) {
  const got = listSummary(input);
  t.check(JSON.stringify(input).slice(0, 44), got === want, `got ${JSON.stringify(got)}`);
}
const longSummary = listSummary("word ".repeat(200), 50) ?? "";
t.check("a long summary is cut at a word, with an ellipsis", longSummary.length <= 51 && longSummary.endsWith("word…"), longSummary);

t.done("plain-text smoke");
