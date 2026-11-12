/**
 * The radar-editor eval's plumbing, with no AI key.
 *
 * The eval itself needs a paid key (it scores real answers), so the only place it would
 * otherwise run is someone's machine with credentials, where a broken harness is discovered
 * after the money is spent. This runs the task with no key and checks what does not need one:
 * every fixture case builds a prompt and runs, a keyless call fails as a scored miss rather
 * than a crash that loses the run, and the task is registered with thresholds the gate reads.
 *
 * Run: npx tsx scripts/smoke-eval-radar-editor-task.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { readFileSync } from "node:fs";
import { ensureUserSettings } from "../src/lib/user-settings";
import { TASK_NAMES, TASKS, runRadarConnectTask, runRadarEditorTask } from "./lib/eval-ai-tasks";
import fixture from "./eval-fixtures/ai-radar-editor-eval.json";
import { checker } from "./smoke/check";

const t = checker();
const USER = "smoke-eval-radar-editor-user";

run(async () => {
  await ensureUserSettings(USER);
  const lines: string[] = [];
  const result = await runRadarEditorTask({ userId: USER, log: (l) => lines.push(l) });

  t.check("every fixture case ran", result.cases === fixture.cases.length, String(result.cases));
  t.check("keyless, every case is a scored miss, not a crash", result.misses.length === result.cases && lines.every((l) => !l.includes("TypeError")), lines.join("\n"));
  t.check("and nothing was counted as an invented fact without an answer", result.metrics.inventedFacts === 0);
  t.check("no reply was usable without a key", result.metrics.replyUsable === 0);

  t.check("the task is registered", TASK_NAMES.includes("radar-editor") && TASKS["radar-editor"] === runRadarEditorTask);
  const rules = JSON.parse(readFileSync("scripts/eval-fixtures/ai-eval-thresholds.json", "utf8")) as Record<string, Record<string, unknown>>;
  t.check(
    "and gated: invented facts and obeyed injections may never rise",
    Boolean(rules["radar-editor"]?.inventedFacts) && Boolean(rules["radar-editor"]?.injectionHeld),
    JSON.stringify(rules["radar-editor"])
  );
  t.check("every case says what it must not invent", fixture.cases.every((c) => c.expect.forbidden.length > 0));

  const connect = await runRadarConnectTask({ userId: USER, log: () => undefined });
  t.check("the Connect eval runs keyless too, every case a scored miss", connect.cases === 3 && connect.misses.length === 3 && connect.metrics.inventedFacts === 0);
  t.check("and is registered and gated", TASK_NAMES.includes("radar-connect") && TASKS["radar-connect"] === runRadarConnectTask && Boolean(rules["radar-connect"]?.quotesGrounded));

  t.done("radar-editor eval plumbing");
});
