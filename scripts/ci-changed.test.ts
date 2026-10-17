import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

function classify(files: string[]): string {
  const run = spawnSync("bash", ["scripts/ci-changed.sh"], { input: files.join("\n"), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

describe("scripts/ci-changed.sh", () => {
  it("skips the heavy jobs for docs-only changes", () => {
    assert.equal(classify(["README.md", "docs/ARCHITECTURE.md", "docs/adr/0001-x.md", "CONTRIBUTING.md"]), "code=false");
  });

  it("skips for the extension, agent skills and unrelated workflows", () => {
    assert.equal(
      classify(["extension/src/panel.tsx", ".agents/skills/x/SKILL.md", ".claude/settings.json", ".github/workflows/ops.yml", "LICENSE"]),
      "code=false"
    );
  });

  it("runs for app code, tests, config and the CI workflow itself", () => {
    for (const f of ["src/lib/a.ts", "scripts/smoke-x.ts", "package.json", ".github/workflows/ci.yml", "e2e/01.spec.ts", "vercel.json"]) {
      assert.equal(classify(["docs/x.md", f]), "code=true", f);
    }
  });

  it("treats docs/RUNBOOK.md as code (a smoke parses it)", () => {
    assert.equal(classify(["docs/RUNBOOK.md"]), "code=true");
  });

  it("fails open on empty input", () => {
    assert.equal(classify([]), "code=true");
  });
});
