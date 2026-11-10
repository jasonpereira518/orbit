/**
 * Vercel Ignored Build Step smoke tests.
 *
 * `scripts/vercel-ignore-build.sh` skips a preview build for a non-main branch with no pull
 * request, a dependabot branch, or a PR push that only touched docs. The failure that matters
 * is skipping something that should have built — production above all — so this runs the real
 * script under each scenario and pins the exit code (0 = skip, 1 = build), with the default
 * for anything unrecognised being "build".
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT_REL = "scripts/vercel-ignore-build.sh";
const SCRIPT = resolve(SCRIPT_REL);
const SKIP = 0;
const BUILD = 1;

let failed = 0;
function run(name: string, env: Record<string, string>, expected: number, cwd?: string) {
  // Only PATH is inherited, so a variable set on the developer's machine cannot leak in.
  const result = spawnSync("bash", [SCRIPT], {
    env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    cwd,
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
run("a non-claude branch with a pull request", { VERCEL_GIT_COMMIT_REF: "feature/thing", VERCEL_GIT_PULL_REQUEST_ID: "7" }, BUILD);
run("no git ref at all (a CLI deploy)", {}, BUILD);
run("PR push, previous SHA unknown to git", { ...claude, VERCEL_GIT_PULL_REQUEST_ID: "9", VERCEL_GIT_PREVIOUS_SHA: "0".repeat(40) }, BUILD);

console.log("skips (any branch)");
run("a non-claude branch with no pull request", { VERCEL_GIT_COMMIT_REF: "feature/thing" }, SKIP);
run("a cursor/* branch with no pull request", { VERCEL_GIT_COMMIT_REF: "cursor/thing-1234" }, SKIP);
run("dependabot/* even with a pull request", { VERCEL_GIT_COMMIT_REF: "dependabot/npm_and_yarn/x", VERCEL_GIT_PULL_REQUEST_ID: "3" }, SKIP);
run("dependabot/* with [deploy] builds", { VERCEL_GIT_COMMIT_REF: "dependabot/npm_and_yarn/x", VERCEL_GIT_PULL_REQUEST_ID: "3", VERCEL_GIT_COMMIT_MESSAGE: "[deploy]" }, BUILD);

console.log("docs-only pushes (throwaway git repo)");
const repo = mkdtempSync(join(tmpdir(), "ignore-build-"));
const git = (...args: string[]) => {
  const r = spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (files: Record<string, string>) => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  git("add", "-A");
  git("commit", "-m", "c");
  return git("rev-parse", "HEAD");
};
git("init", "-q");
const base = commit({ "src/a.ts": "1", "README.md": "1" });
const pr = { ...claude, VERCEL_GIT_PULL_REQUEST_ID: "12" };
commit({ "docs/x.md": "2", "CHANGELOG.md": "2", ".github/workflows/ci.yml": "2" });
run("PR push touching only docs/*.md/.github", { ...pr, VERCEL_GIT_PREVIOUS_SHA: base }, SKIP, repo);
commit({ "src/a.ts": "2" });
run("PR push after skipped docs pushes, code changed since last build", { ...pr, VERCEL_GIT_PREVIOUS_SHA: base }, BUILD, repo);
run("docs-only PR push with [deploy]", { ...pr, VERCEL_GIT_PREVIOUS_SHA: base, VERCEL_GIT_COMMIT_MESSAGE: "[deploy]" }, BUILD, repo);
run("docs-only on production still builds", { ...pr, VERCEL_ENV: "production", VERCEL_GIT_PREVIOUS_SHA: base }, BUILD, repo);

console.log("wiring");
const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { ignoreCommand?: string };
const wired = vercel.ignoreCommand === `bash ${SCRIPT_REL}`;
if (!wired) failed++;
console.log(`  ${wired ? "ok  " : "FAIL"} vercel.json runs the script as its ignoreCommand`);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll ignored-build-step checks passed.");
process.exit(0);
