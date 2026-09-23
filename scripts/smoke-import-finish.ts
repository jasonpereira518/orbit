/**
 * What the done card says. The arithmetic has to agree with the history chips and the People
 * list — they disagreed once already (the engine counts a merged person under two counters),
 * and a third place to get it wrong is exactly how that comes back.
 *
 * Run: npx tsx scripts/smoke-import-finish.ts
 */
import { finishCopy, type FinishSummary } from "../src/lib/imports/import-finish";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const base: FinishSummary = {
  importId: "i1",
  added: 19,
  existing: 6,
  meetingsLogged: 0,
  sources: ["Connections.csv"],
};

const normal = finishCopy(base);
check("counts the new people", normal.headline.includes("19"));
check("names the ones already here", (normal.detail ?? "").includes("6"));
check("the button goes to this import's people", "href" in normal.action && normal.action.href === "/contacts?importId=i1");
check("the button names the number", normal.action.label.includes("19"));

const one = finishCopy({ ...base, added: 1, existing: 0 });
check("one person reads as a person", one.headline.includes("1 person") && !one.headline.includes("1 people"));
check("nobody already here means no second line", one.detail === null);

const nobodyNew = finishCopy({ ...base, added: 0, existing: 25 });
check("nobody new is not a lie", !nobodyNew.headline.includes("0 people"));
check("…and the button changes", "kind" in nobodyNew.action && nobodyNew.action.kind === "detail");

const calendar = finishCopy({ ...base, added: 0, existing: 0, meetingsLogged: 38, sources: ["work.ics"] });
check("a calendar import reports meetings", calendar.headline.includes("38"));
check("…and does not claim people", !calendar.headline.includes("0"));

const several = finishCopy({ ...base, sources: ["Connections.csv", "messages.csv"] });
check("several files are named", (several.detail ?? "").includes("Connections.csv") && (several.detail ?? "").includes("messages.csv"));

const partial = finishCopy({ ...base, unfinished: "LinkedIn messages didn’t finish" });
check("an unfinished step leads", partial.headline.includes("didn’t finish"));
check("…and still offers the people that landed", "href" in partial.action);

for (const copy of [normal, one, nobodyNew, calendar, several, partial]) {
  const lines = [copy.headline, copy.detail ?? "", copy.action.label];
  for (const line of lines) {
    check(`house voice: ${line.slice(0, 40)}`, !/\bfailed\b/i.test(line) && !line.endsWith(".") && !line.includes("'") && (line.match(/ — /g) ?? []).length <= 1, line);
  }
}

if (failures) {
  console.error(`smoke-import-finish: ${failures} failed`);
  process.exit(1);
}
console.log("smoke-import-finish: all checks passed");
process.exit(0);