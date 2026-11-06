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
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { generateContactFollowUpDraft } from "../src/lib/follow-up-drafts";
import { CASE_USER, installPromptCapture, only, runDraftCases, seedCaseUser, type CaseResults } from "./lib/draft-prompt-cases";

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

  // Purpose: Orbit picks it, an edited one is a verbatim override, intent stays a hint.
  const db = await getDb();
  await db
    .update(userSettings)
    .set({ careerProfile: { aim: { kind: "internship", timeline: "this_year", field: null, setAt: "2026-11-06T00:00:00.000Z" } } })
    .where(eq(userSettings.userId, CASE_USER));
  const picked = await only(() => generateContactFollowUpDraft(CASE_USER, contactId, [], { intent: "Say hi" }));
  const pickedRes = await generateContactFollowUpDraft(CASE_USER, contactId, [], { intent: "Say hi" });
  check("system prompt asks for { purpose, body }", picked.system.includes('{ "purpose": string, "body": string }'));
  check("system prompt has the pick-one-purpose rule", picked.system.includes("Pick ONE purpose"));
  check("goals block carries the aim line", picked.user.includes("Going for: internship, this year"), picked.user);
  check("intent is a hint, no verbatim override", !picked.system.includes("Use it as given") && /hint/.test(picked.system));
  check("purpose comes from the model when only intent is set", pickedRes.purpose === "Ask about the seed round", pickedRes.purpose);
  const given = "Ask about the APM program";
  const forced = await only(() => generateContactFollowUpDraft(CASE_USER, contactId, [], { purpose: given }));
  const forcedRes = await generateContactFollowUpDraft(CASE_USER, contactId, [], { purpose: given });
  check("a given purpose is used verbatim in the prompt", forced.system.includes(`The purpose of this message is: ${given}. Use it as given.`));
  check("a given purpose is returned exactly", forcedRes.purpose === given, forcedRes.purpose);

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
