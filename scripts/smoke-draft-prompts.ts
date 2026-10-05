/**
 * Pins the prompts behind the four draft-writing operations (`outreach.draft`, `followup.draft`,
 * `recruiter.draft`, `extension.starters`) against a committed fixture.
 *
 * None of them has an eval, so this is the only thing that notices when a change to their
 * prompts — or to anything threaded into them, like the writing preferences — alters what the
 * model is asked. The fixture is regenerated on purpose, never to make a failure go away:
 *
 *   npx tsx scripts/smoke-draft-prompts.ts           # compare
 *   npx tsx scripts/smoke-draft-prompts.ts --update  # rewrite the fixture, then read the diff
 *
 * Local PGlite, stubbed Gemini. The follow-up and starters calls go through the result cache;
 * it is switched off so every case reaches the (stubbed) wire.
 */
import "./smoke/_env";
process.env.ORBIT_AI_RESULT_CACHE = "off";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installPromptCapture, runDraftCases, seedCaseUser, type CaseResults } from "./lib/draft-prompt-cases";

const FIXTURE = join(process.cwd(), "scripts/fixtures/draft-prompt-goldens.json");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  installPromptCapture();
  const { contactId } = await seedCaseUser();
  const got = await runDraftCases(contactId);

  if (process.argv.includes("--update")) {
    writeFileSync(FIXTURE, `${JSON.stringify(got, null, 2)}\n`);
    console.log(`wrote ${Object.keys(got).length} goldens to ${FIXTURE}`);
    process.exit(0);
  }

  const want = JSON.parse(readFileSync(FIXTURE, "utf8")) as CaseResults;
  check("same cases as the fixture", JSON.stringify(Object.keys(got)) === JSON.stringify(Object.keys(want)));
  for (const name of Object.keys(want)) {
    const g = got[name];
    check(`${name}: system prompt`, g?.system === want[name]!.system, g ? firstDiff(want[name]!.system, g.system) : "missing");
    check(`${name}: user message`, g?.user === want[name]!.user, g ? firstDiff(want[name]!.user, g.user) : "missing");
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll draft prompt checks passed");
  process.exit(0);
}

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `differs at ${i}: want ${JSON.stringify(a.slice(i, i + 60))} got ${JSON.stringify(b.slice(i, i + 60))}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
