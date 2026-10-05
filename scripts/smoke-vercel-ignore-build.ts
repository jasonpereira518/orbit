/**
 * Vercel Ignored Build Step smoke tests.
 *
 * `scripts/vercel-ignore-build.sh` skips a preview build only for a `claude/*` branch with no
 * pull request. The failure that matters is skipping something that should have built —
 * production above all — so this runs the real script under each scenario and pins the exit
 * code (0 = skip, 1 = build), with the default for anything unrecognised being "build".
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCRIPT = "scripts/vercel-ignore-build.sh";
const SKIP = 0;
const BUILD = 1;

let failed = 0;
function run(name: string, env: Record<string, string>, expected: number) {
  // Only PATH is inherited, so a variable set on the developer's machine cannot leak in.
  const result = spawnSync("bash", [SCRIPT], {
    env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  const ok = result.status === expected;
  if (!ok) failed++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${name}: ${expected === SKIP ? "skips" : "builds"}` +
      (ok ? "" : ` (exit ${result.status}: ${result.stdout.trim()}${result.stderr.trim()})`)
  );
}

const claude = { VERCEL_GIT_COMMIT_REF: "claude/fix-something-abc123" };

console.log("skips");
run("claude/* branch, no pull request", claude, SKIP);
run("claude/* branch, empty pull request id (Vercel's value before a PR exists)", { ...claude, VERCEL_GIT_PULL_REQUEST_ID: "" }, SKIP);
run("claude/* branch, an unrelated commit message", { ...claude, VERCEL_GIT_COMMIT_MESSAGE: "Fix the thing\n\nDeploy notes: none" }, SKIP);
run("claude/* preview environment", { ...claude, VERCEL_ENV: "preview" }, SKIP);

console.log("builds");
run("claude/* branch with a pull request", { ...claude, VERCEL_GIT_PULL_REQUEST_ID: "236" }, BUILD);
run("claude/* branch, [deploy] in the commit message", { ...claude, VERCEL_GIT_COMMIT_MESSAGE: "wip: try it [deploy]" }, BUILD);
run("claude/* branch, [deploy] on a later line", { ...claude, VERCEL_GIT_COMMIT_MESSAGE: "wip\n\nneed a preview [deploy]" }, BUILD);
run("production, even on a claude/* ref", { ...claude, VERCEL_ENV: "production" }, BUILD);
run("main", { VERCEL_GIT_COMMIT_REF: "main", VERCEL_ENV: "production" }, BUILD);
run("main as a preview", { VERCEL_GIT_COMMIT_REF: "main", VERCEL_ENV: "preview" }, BUILD);
run("a non-claude branch with no pull request", { VERCEL_GIT_COMMIT_REF: "feature/thing" }, BUILD);
run("a cursor/* branch", { VERCEL_GIT_COMMIT_REF: "cursor/thing-1234" }, BUILD);
run("a branch that only contains 'claude/'", { VERCEL_GIT_COMMIT_REF: "fix/claude/thing" }, BUILD);
run("no git ref at all (a CLI deploy)", {}, BUILD);

console.log("wiring");
const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { ignoreCommand?: string };
const wired = vercel.ignoreCommand === `bash ${SCRIPT}`;
if (!wired) failed++;
console.log(`  ${wired ? "ok  " : "FAIL"} vercel.json runs the script as its ignoreCommand`);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll ignored-build-step checks passed.");
process.exit(0);
