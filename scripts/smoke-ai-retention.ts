/**
 * Static guards for what AI providers may keep of a person's data.
 *
 * Orbit's privacy policy says content is not used to train models. Two code paths quietly
 * weakened that (found in the privacy audit, PRIVACY_AUDIT.md F-07):
 *   - OpenAI's Responses API stores every response for 30 days unless `store: false` is set
 *     (Chat Completions defaults to not storing). The web-search lookup — a person's name and
 *     employer — went through it without the flag.
 *   - A batch that failed or went stale was settled without `cleanup`, so its prompts (recruiter
 *     email bodies, LinkedIn timelines) stayed in the provider's batch storage.
 *
 * Pure: reads source files only.
 *
 * Run: npx tsx scripts/smoke-ai-retention.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** The text of a call's argument list, from its opening parenthesis to the matching close. */
function callArguments(text: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(openParen, i + 1);
  }
  return text.slice(openParen);
}

console.log("OpenAI Responses calls opt out of storage");
let responsesCalls = 0;
for (const file of sourceFiles("src")) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\.responses\.create\(/g)) {
    responsesCalls++;
    const args = callArguments(text, match.index! + match[0].length - 1);
    const line = text.slice(0, match.index).split("\n").length;
    check(`${file}:${line} sets store: false`, /\bstore:\s*false\b/.test(args));
  }
}
check("there is at least one Responses call to guard (the scan is looking in the right place)", responsesCalls > 0);

console.log("\nAI batches clean up at the provider when they fail");
{
  const text = readFileSync("src/lib/ai-batch.ts", "utf8");
  const poll = text.slice(text.indexOf("export async function pollAiBatch"), text.indexOf("async function failBatchJob"));
  const bareFailures = [...poll.matchAll(/settleBatchJob\(job, "failed"/g)].length;
  // The two that remain have no usable key to clean up with: the key is gone, or it belongs to
  // a different provider than the one holding the batch.
  check("only the two key-less failures settle without cleanup", bareFailures === 2, String(bareFailures));
  check("every other failure goes through failBatchJob", [...poll.matchAll(/failBatchJob\(job, grant/g)].length === 3);
  const fail = text.slice(text.indexOf("async function failBatchJob"));
  check("failBatchJob calls the provider's cleanup", /ADAPTERS\[job\.provider\]\.cleanup\(grant, job\)/.test(fail.slice(0, 600)));
}

console.log("\nOpenRouter requests deny data collection");
{
  const text = readFileSync("src/lib/ai-access.ts", "utf8");
  check("withOpenRouterRouting sets data_collection: deny", /data_collection:\s*"deny"/.test(text));
}

if (failures > 0) {
  console.error(`\n${failures} AI-retention check(s) failed`);
  process.exit(1);
}
console.log("\nAll AI-retention checks passed.");
