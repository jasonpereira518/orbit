/**
 * How far a Radar run is (`src/lib/radar/run-progress.ts`), for "Refresh now". Pure: no database.
 *
 * Run: npx tsx scripts/smoke-radar-run-progress.ts
 */
import { RUN_STAGES, detailFor, progressAt, stageLabel, type RunStageKey } from "../src/lib/radar/run-progress";
import { checker } from "./smoke/check";

const t = checker();

console.log("\nthe stages");
t.check("weights add up to 100", RUN_STAGES.reduce((sum, s) => sum + s.weight, 0) === 100);
t.check("keys are unique", new Set(RUN_STAGES.map((s) => s.key)).size === RUN_STAGES.length);

console.log("\nthe bar");
const marks = RUN_STAGES.map((s) => progressAt(s.key));
t.check("starts at 0 on the first stage", marks[0] === 0);
t.check("moves forward at every stage", marks.every((m, i) => i === 0 || m > marks[i - 1]!), marks.join(","));
t.check("stays under 100 until the run itself finishes", marks.every((m) => m <= 99));
t.check("the last stage is near the end", marks[marks.length - 1]! >= 95);

console.log("\ncounted stages");
const drafts: RunStageKey = "drafts";
const none = progressAt(drafts, 0, 5);
const half = progressAt(drafts, 2, 5);
const all = progressAt(drafts, 5, 5);
t.check("item counts move the bar inside their stage", none < half && half < all, `${none} → ${half} → ${all}`);
t.check("a finished stage lands at or before the next stage's start", all <= progressAt("wrap"), `${all} vs ${progressAt("wrap")}`);
t.check("over-counting is clamped", progressAt(drafts, 9, 5) === all);
t.check("a zero total is ignored, not divided by", progressAt(drafts, 3, 0) === none);

console.log("\nskipped stages");
t.check("a run that skips the editor and drafts jumps past them", progressAt("save") > progressAt("score") && progressAt("autopilot") > progressAt("save"));

console.log("\nwords");
t.check("labels come from the stage", stageLabel("drafts") === "Writing drafts");
t.check("detail reads '3 of 5'", detailFor(3, 5) === "3 of 5");
t.check("detail is clamped to the total", detailFor(9, 5) === "5 of 5");
t.check("no count, no detail", detailFor() === null && detailFor(2, 0) === null);

t.done("radar run progress");
