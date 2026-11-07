/** stripMarkdown: summaries shown as plain text carry no markdown markers. Pure tier. */
import { checker } from "./smoke/check";
import { stripMarkdown } from "../src/lib/plain-text";

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
t.done("plain-text smoke");
