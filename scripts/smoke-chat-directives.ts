/**
 * The answer's block directives (src/lib/chat-directives.ts): `::people[ids]` and `::list[rN]`
 * split out of the streamed prose, held back while half-written, stripped to what the server
 * offered, and a list expanded to the table a reload shows.
 *
 * Pure. Run: npx tsx scripts/smoke-chat-directives.ts
 */
import {
  directivesAsText,
  expandLists,
  listToMarkdown,
  MAX_PEOPLE_PER_BLOCK,
  peopleIdsIn,
  settledText,
  splitDirectives,
  stripInvalidDirectives,
  type ChatBlockList,
} from "../src/lib/chat-directives";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const answer = "Two people can help.\n\n::people[a1,b2]\n\nEveryone from Duke:\n::list[r1]\nThat's all.";

console.log("split");
const segs = splitDirectives(answer);
check(
  "prose, people, prose, list, prose — in order",
  segs.map((s) => s.kind).join() === "text,people,text,list,text",
  segs
);
check("people ids parsed", segs[1]?.kind === "people" && segs[1].ids.join() === "a1,b2");
check("list key parsed", segs[3]?.kind === "list" && segs[3].key === "r1");
check("a directive inside a code fence stays text", splitDirectives("```\n::people[a1]\n```").every((s) => s.kind === "text"));
check("a directive mid-sentence stays text", splitDirectives("see ::people[a1] here").every((s) => s.kind === "text"));
check("duplicate ids collapse", (splitDirectives("::people[a1, a1 ,b2]")[0] as { ids: string[] }).ids.join() === "a1,b2");

console.log("\nstreaming hold-back");
check("a half-written directive line is held back", settledText("Hello\n::peo") === "Hello\n");
check("a lone colon line is held back too", settledText("Hello\n:") === "Hello\n");
check("a citation cut mid-marker is held back", settledText("as she said [e1") === "as she said ");
check("an opening bracket alone is held back", settledText("as she said [") === "as she said ");
check("a finished citation is not", settledText("as she said [e1]") === "as she said [e1]");
check("ordinary text passes through", settledText("Ada: an engineer") === "Ada: an engineer");
check(
  "streaming split never shows the partial directive",
  splitDirectives("Hi\n::people[a1", { streaming: true }).map((s) => (s.kind === "text" ? s.text : s.kind)).join() === "Hi\n"
);

console.log("\nstrip to what the server offered");
const known = { people: new Set(["a1", "b2"]), lists: new Set(["r1"]) };
const stripped = stripInvalidDirectives("x\n::people[a1,zz]\n::people[zz]\n::list[r9]\n::list[r1]", known);
check("unknown ids dropped, empty directives removed", stripped.text === "x\n::people[a1]\n::list[r1]", stripped.text);
check("and counted", stripped.removed === 3, stripped.removed);
const many = Array.from({ length: 10 }, (_, i) => `p${i}`);
const capped = stripInvalidDirectives(`::people[${many.join(",")}]`, { people: new Set(many), lists: new Set() });
check(`a people block is capped at ${MAX_PEOPLE_PER_BLOCK}`, peopleIdsIn(capped.text).length === MAX_PEOPLE_PER_BLOCK);
check("peopleIdsIn reads every block in order", peopleIdsIn("::people[b2]\ntext\n::people[a1,b2]").join() === "b2,a1");

console.log("\nlists as tables");
const list: ChatBlockList = {
  label: "Contacts matching schools: Duke",
  total: 3,
  truncated: true,
  people: [
    { id: "a1", name: "Ada [Lovelace]", title: "Engineer | Stripe" },
    { id: "b2", name: "Leo Chen", title: null },
  ],
};
const md = listToMarkdown(list);
check("a count line first", md.startsWith("**3 people** · Contacts matching schools: Duke"), md);
check("rows link to the contact page", md.includes("](/contacts/a1)"), md);
check("brackets in a name cannot break the link", md.includes("[Ada \\[Lovelace\\]](/contacts/a1)"), md);
check("a pipe in a cell cannot break the table", md.includes("Engineer \\| Stripe"), md);
check("a truncated list says so", md.includes("_Showing 2 of 3._"), md);
const stored = expandLists(answer, { r1: list });
check("the stored answer has the table in place of the list", stored.includes("| [Leo Chen](/contacts/b2) |") && !stored.includes("::list"), stored);
check("and keeps people blocks as directives", stored.includes("::people[a1,b2]"));
check("an unknown list is dropped when stored", !expandLists("::list[r7]", {}).includes("::list"));

console.log("\ncopy text");
const copy = directivesAsText(answer, (id) => ({ a1: "Ada", b2: "Leo" })[id], { r1: list });
check("people blocks copy as names, never the directive", copy.includes("- Ada\n- Leo") && !copy.includes("::people"), copy);
check("segments join with one blank line", !copy.includes("\n\n\n"), copy);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll chat directive checks passed.");
process.exit(0);
