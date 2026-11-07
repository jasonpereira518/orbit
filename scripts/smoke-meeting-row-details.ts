/**
 * Past-meetings row details, pure: the logo route's domain guard (only a public hostname
 * ever reaches Google's favicon service), the summary cleanup (no markdown, no headings or
 * metadata lines), and which companies a row shows a logo for.
 * Run: npx tsx scripts/smoke-meeting-row-details.ts
 */
import { checker } from "./smoke/check";
import { isLogoDomain } from "../src/lib/org-brand-learn";
import { listSummary, meetingCompanies } from "../src/lib/meetings-list";

const t = checker();

console.log("Logo domain guard");
for (const ok of ["nvidia.com", "harbor-health.co.uk", "a.io"]) t.check(`accepts ${ok}`, isLogoDomain(ok));
for (const bad of [
  "localhost",
  "127.0.0.1",
  "[::1]",
  "a.b:8080",
  "nvidia.com:8080",
  "nvidia",
  "nvidia.com/x",
  "nvidia.com?x=1",
  "user@nvidia.com",
  "NVIDIA.com",
  "printer.local",
  "db.internal",
  "app.localhost",
  `${"a".repeat(250)}.com`,
  "",
]) {
  t.check(`rejects ${JSON.stringify(bad).slice(0, 30)}`, !isLogoDomain(bad));
}

console.log("Summary cleanup");
const cases: Array<[string | null, string | null]> = [
  ["### Overview\n- **NVIDIA** is hiring\n- Follow up _Friday_", "NVIDIA is hiring. Follow up Friday."],
  ["Attendees: Dana, Eli\nWhen: Monday\n\n**Key points**\nScope agreed; Dana owns the rollout.", "Scope agreed; Dana owns the rollout."],
  ["Next steps:\n1. Send the deck\n2) Book a call", "Next steps: Send the deck. Book a call."],
  ["We agreed pricing is per seat.", "We agreed pricing is per seat."],
  ["## Only a heading", null],
  ["", null],
  [null, null],
];
for (const [input, want] of cases) {
  const got = listSummary(input);
  t.check(JSON.stringify(input).slice(0, 44), got === want, `got ${JSON.stringify(got)}`);
}
const long = listSummary("word ".repeat(200), 50) ?? "";
t.check("a long summary is cut at a word, with an ellipsis", long.length <= 51 && long.endsWith("word…"), long);

console.log("Companies");
const nvidia = { name: "NVIDIA", domain: "nvidia.com" };
const acme = { name: "Acme Corp", domain: "acme.com" };
const hp = { name: "HP", domain: "hp.com" };
const orgs = [acme, nvidia, hp];
t.check("an org named as a whole word matches, case-insensitive", JSON.stringify(meetingCompanies([], "Call with nvidia about GPUs", orgs)) === JSON.stringify([nvidia]));
t.check("not inside another word", meetingCompanies([], "Nvidiaish plans", orgs).length === 0);
t.check("names under three characters never match", meetingCompanies([], "HP printers", orgs).length === 0);
t.check("in the order they are mentioned", meetingCompanies([], "NVIDIA then acme corp", orgs).map((c) => c.domain).join() === "nvidia.com,acme.com");
t.check("people's companies come first, at most two", meetingCompanies([acme], "NVIDIA and Acme Corp and more", [...orgs, { name: "Third Co", domain: "third.co" }]).map((c) => c.domain).join() === "acme.com,nvidia.com");
t.check("one logo per domain", meetingCompanies([nvidia, nvidia], "NVIDIA", orgs).length === 1);

t.done("meeting row details smoke");
