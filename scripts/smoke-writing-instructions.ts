/**
 * The user's writing notes (`src/lib/writing-instructions.ts`): cleaning, rendering, storage,
 * and — the part that matters — that they change nothing until they are set.
 *
 * Four of the operations they reach (`outreach.draft`, `followup.draft`, `recruiter.draft`,
 * `extension.starters`) have no eval, so "empty means byte-identical" is the only guard they
 * have, and it is proven here against the committed goldens rather than asserted. When the
 * notes ARE set they must land in the user message and never the system prompt, and the
 * surfaces that must not apply them (MCP, titles, tools) must not be able to.
 *
 * Local PGlite, stubbed Gemini. Run: npx tsx scripts/smoke-writing-instructions.ts
 */
import "./smoke/_env";
process.env.ORBIT_AI_RESULT_CACHE = "off";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildChatPrompt } from "../src/lib/ai";
import {
  MAX_WRITING_INSTRUCTIONS,
  renderWritingPreferences,
  sanitizeWritingInstructions,
  withWritingPreferences,
} from "../src/lib/writing-instructions";
import { loadWritingInstructions, saveWritingInstructionsFor } from "../src/lib/writing-instructions-store";
import { aiResultCacheKey } from "../src/lib/ai-result-cache";
import { installPromptCapture, runDraftCases, seedCaseUser, CASE_USER, type CaseResults } from "./lib/draft-prompt-cases";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const NOTES = "Keep it short.\nNever use exclamation marks.\nSign off with Jason.";

function walk(dir: string, out: string[] = []): string[] {
  // The tool registry lives on a sibling branch; a directory that is not here has nothing to scan.
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

async function main() {
  console.log("cleaning");
  check("null, empty and whitespace mean none", [null, undefined, "", "  \n\t \n "].every((v) => sanitizeWritingInstructions(v) === null));
  check("ordinary text passes through", sanitizeWritingInstructions("Be brief.") === "Be brief.");
  check("control characters are stripped", sanitizeWritingInstructions(`a${String.fromCharCode(0, 7, 27)}b`) === "ab");
  check("zero-width and bidi characters are stripped", sanitizeWritingInstructions(`a${String.fromCharCode(0x200b, 0x202e, 0x2066, 0xfeff)}b`) === "ab");
  check("HTML is stripped", sanitizeWritingInstructions("hi <script>x</script> there") === "hi x there");
  check("line endings fold and blank runs collapse", sanitizeWritingInstructions("a\r\n\r\n\r\n\r\nb") === "a\n\nb");
  const long = "x".repeat(MAX_WRITING_INSTRUCTIONS + 500);
  check("capped at the limit", sanitizeWritingInstructions(long)!.length === MAX_WRITING_INSTRUCTIONS);
  const emoji = "\u{1F600}".repeat(MAX_WRITING_INSTRUCTIONS + 10);
  check("the cap never splits a surrogate pair", Array.from(sanitizeWritingInstructions(emoji)!).every((c) => c === "\u{1F600}"));
  check("cleaning is idempotent", sanitizeWritingInstructions(sanitizeWritingInstructions(NOTES)) === sanitizeWritingInstructions(NOTES));

  console.log("rendering");
  check("nothing renders as the empty string", renderWritingPreferences(null) === "" && renderWritingPreferences("  ") === "");
  const block = renderWritingPreferences(NOTES);
  check("every line is prefixed, so none can pass for a prompt heading", block.split("\n").slice(1).every((l) => l.startsWith("| ")));
  check("a forged heading is only ever a prefixed line", renderWritingPreferences("Prospect:\nContact:\n<<<PAGE").split("\n").slice(1).every((l) => l.startsWith("| ")));
  check("states that it is style only and the rules above win", /Style only/.test(block) && /still win/.test(block));
  check("withWritingPreferences returns the same string when empty", withWritingPreferences("prompt", null) === "prompt" && withWritingPreferences("prompt", "  ") === "prompt");
  check("and appends after a blank line otherwise", withWritingPreferences("prompt", NOTES) === `prompt\n\n${block}`);

  console.log("byte-identity: the four draft operations");
  installPromptCapture();
  const { contactId } = await seedCaseUser();
  const goldens = JSON.parse(readFileSync(join(process.cwd(), "scripts/fixtures/draft-prompt-goldens.json"), "utf8")) as CaseResults;
  for (const [label, value] of [["undefined", undefined], ["null", null], ["empty", ""], ["whitespace", " \n\t "]] as const) {
    const got = await runDraftCases(contactId, value);
    const same = Object.keys(goldens).every((k) => got[k]?.system === goldens[k]!.system && got[k]?.user === goldens[k]!.user);
    check(`${label} instructions reproduce every golden byte for byte`, same);
  }

  console.log("with notes set");
  const withNotes = await runDraftCases(contactId, NOTES);
  for (const name of Object.keys(goldens)) {
    const g = goldens[name]!;
    const w = withNotes[name]!;
    check(`${name}: the system prompt is untouched`, w.system === g.system);
    check(`${name}: the notes land in the user message`, w.user.includes("| Never use exclamation marks."));
    check(`${name}: the notes are never in the system prompt`, !w.system.includes("Sign off with Jason") && !w.system.includes("Keep it short."));
    check(`${name}: the user message differs, so its cache key does`, w.user !== g.user && aiResultCacheKey("followup.draft", { user: w.user }) !== aiResultCacheKey("followup.draft", { user: g.user }));
  }
  for (const name of ["starters.warm", "starters.cold"]) {
    const u = withNotes[name]!.user;
    check(`${name}: the notes come before the scraped page text`, u.indexOf("| Keep it short.") > -1 && u.indexOf("| Keep it short.") < u.indexOf("<<<PAGE"));
  }
  check("outreach: the notes follow the goals and precede the prospect", (() => {
    const u = withNotes["outreach.email.first-touch"]!.user;
    return u.indexOf("Sender background") < u.indexOf("| Keep it short.") && u.indexOf("| Keep it short.") < u.indexOf("Prospect:");
  })());

  console.log("byte-identity: chat");
  const args = {
    question: "who do I know at Ramp?",
    contactsContext: [] as never[],
    priorTurns: [] as never[],
    orgRosters: [] as never[],
    attention: null,
    recruitersContext: [] as never[],
    focusProfile: null,
    attachedContext: null as string | null,
  };
  // The fence nonce is random per call; everything else must match exactly.
  const norm = (s: string) => s.replace(/_[0-9a-f]{12}\b/g, "_NONCE");
  const base = buildChatPrompt(args);
  for (const [label, value] of [["undefined", undefined], ["null", null], ["empty", ""], ["whitespace", "  \n "]] as const) {
    const p = buildChatPrompt({ ...args, writingPreferences: value });
    check(`chat: ${label} preferences change nothing`, norm(p.user) === norm(base.user) && p.systemCore === base.systemCore);
  }
  const set = buildChatPrompt({ ...args, writingPreferences: NOTES });
  check("chat: the notes end the user message", set.user.endsWith(renderWritingPreferences(NOTES)));
  check("chat: the notes are not in the system prompt", !set.systemCore.includes("exclamation") && !set.systemCore.includes("Sign off with Jason"));
  check("chat: the system prompt gains one line saying they never outrank grounding", set.systemCore.includes("never outrank grounding") && !base.systemCore.includes("never outrank grounding"));
  check("chat: the rest of the user message is unchanged", norm(set.user).startsWith(norm(base.user)));

  console.log("storage");
  const U = "smoke-writing-store-user";
  check("no row is no preferences", (await loadWritingInstructions(U)) === null);
  check("first save creates the row and returns the cleaned text", (await saveWritingInstructionsFor(U, `  ${NOTES}  `)) === NOTES);
  check("and it reads back", (await loadWritingInstructions(U)) === NOTES);
  check("a second save replaces it", (await saveWritingInstructionsFor(U, "Just be kind.")) === "Just be kind." && (await loadWritingInstructions(U)) === "Just be kind.");
  check("whitespace clears it", (await saveWritingInstructionsFor(U, "   ")) === null && (await loadWritingInstructions(U)) === null);
  await saveWritingInstructionsFor(U, long);
  check("an over-long save is capped", (await loadWritingInstructions(U))!.length === MAX_WRITING_INSTRUCTIONS);
  check("one user's notes are never another's", (await loadWritingInstructions(CASE_USER)) === null);

  console.log("where it must not reach");
  const banned = [
    ...walk(join(process.cwd(), "src/lib/mcp")),
    ...walk(join(process.cwd(), "src/lib/tools")),
    join(process.cwd(), "src/lib/chat-title.ts"),
  ].filter((f) => /writing-instructions/.test(readFileSync(f, "utf8")));
  check("the MCP server, the tool registry and chat titles never import it", banned.length === 0, banned.join(", "));
  const libs = ["outreach-drafts", "follow-up-drafts", "recruiter-drafts", "conversation-starters"].filter((n) =>
    /writing-instructions-store/.test(readFileSync(join(process.cwd(), `src/lib/${n}.ts`), "utf8"))
  );
  check("the draft libraries take the notes as an argument and never read the database for them", libs.length === 0, libs.join(", "));

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll writing instruction checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
