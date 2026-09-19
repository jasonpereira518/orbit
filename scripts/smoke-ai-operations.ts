/**
 * The AI operation registry (`src/lib/ai-operations.ts`) is the one list of AI call sites.
 * This holds the source to it: every operation id a call site emits is registered, the
 * tiers it records match what the call sites really do, and every model any tier can land
 * on has a price row — an unpriced model records no cost and slips under the managed cap.
 *
 * No DB, no network. Run: npx tsx scripts/smoke-ai-operations.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AI_OPERATIONS,
  AI_OPERATION_IDS,
  BACKGROUND_AI_OPERATIONS,
  aiOperationLabel,
  isAiOperationId,
} from "../src/lib/ai-operations";
import { EMBEDDING_MODELS, FAST_MODELS, VISION_MODELS } from "../src/lib/ai";
import { AI_PROVIDERS, DEFAULT_MODELS, PROVIDER_MODELS } from "../src/lib/ai-providers";
import { MANAGED_DEFAULT_MODELS, MANAGED_MODELS } from "../src/lib/managed-ai-policy";
import { priceFor } from "../src/lib/ai-pricing";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

const files = sourceFiles("src").map((path) => ({ path, text: readFileSync(path, "utf8") }));

console.log("Every emitted operation id is registered");
{
  // The shapes an id takes on its way to `usage_events`: an `operation:` property, the
  // gate's `.completion("…")`-style grant calls, and `getAiConfig(userId, "…")`.
  const patterns = [
    /operation:\s*"([a-z][\w.-]*)"/g,
    /operation\s*\?\?\s*"([a-z][\w.-]*)"/g,
    /\.(?:completion|embedding|transcription|wispr)\(\s*"([a-z][\w.-]*)"/g,
    /getAiConfig\(\s*\w+,\s*"([a-z][\w.-]*)"/g,
  ];
  const emitted = new Map<string, string>();
  for (const { path, text } of files) {
    if (path.endsWith("ai-operations.ts")) continue;
    for (const re of patterns) {
      for (const m of text.matchAll(re)) emitted.set(m[1], path);
    }
  }
  check(`found the call sites (${emitted.size} ids)`, emitted.size >= 20);
  for (const [id, path] of emitted) {
    check(`${id} is registered`, isAiOperationId(id), path);
  }
}

console.log("\nRecorded tiers match the call sites");
{
  // Until routing moves into the registry, `speed: "fast"` / `speed: "vision"` at the call
  // site is what actually picks the model. An operation id within a few lines of one of
  // those must be registered on that tier, and each fast/vision operation must have one.
  const nearSpeed = new Map<string, Set<string>>();
  for (const { text } of files) {
    for (const m of text.matchAll(/speed:\s*"(fast|vision)"/g)) {
      const window = text.slice(Math.max(0, m.index! - 600), m.index! + 600);
      for (const op of window.matchAll(/operation:\s*"([a-z][\w.-]*)"/g)) {
        if (!nearSpeed.has(op[1])) nearSpeed.set(op[1], new Set());
        nearSpeed.get(op[1])!.add(m[1]);
      }
    }
  }
  for (const id of AI_OPERATION_IDS) {
    const tier = AI_OPERATIONS[id].tier;
    if (tier !== "fast" && tier !== "vision") continue;
    check(`${id} (${tier}) is routed ${tier} at its call site`, nearSpeed.get(id)?.has(tier) === true);
  }
  for (const [id, speeds] of nearSpeed) {
    if (!isAiOperationId(id)) continue;
    for (const speed of speeds) {
      check(`${id} next to speed "${speed}" is registered ${speed}`, AI_OPERATIONS[id].tier === speed);
    }
  }
}

console.log("\nEvery reachable model is priced");
{
  const reachable = new Set<string>();
  for (const p of AI_PROVIDERS) {
    reachable.add(DEFAULT_MODELS[p.id]);
    reachable.add(FAST_MODELS[p.id]);
    reachable.add(VISION_MODELS[p.id]);
    reachable.add(MANAGED_DEFAULT_MODELS[p.id]);
    for (const m of PROVIDER_MODELS[p.id]) reachable.add(m.value);
    for (const m of MANAGED_MODELS[p.id]) reachable.add(m);
  }
  for (const m of Object.values(EMBEDDING_MODELS)) reachable.add(m);
  for (const model of reachable) check(`${model} has a price row`, priceFor(model) !== null);
}

console.log("\nDerived lists");
{
  check(
    "background set is the four bulk operations",
    [...BACKGROUND_AI_OPERATIONS].sort().join(",") ===
      ["import.enrich", "import.linkedin.timeline", "recruiter.scan", "search.embed.batch"].join(","),
    [...BACKGROUND_AI_OPERATIONS].join(",")
  );
  for (const id of AI_OPERATION_IDS) {
    check(`${id} reads as words`, aiOperationLabel(id) !== id);
  }
  check("a retired id still reads as words", aiOperationLabel("capture.transcribe.images") !== "capture.transcribe.images");
  check("an unknown id falls back to itself", aiOperationLabel("mystery.op") === "mystery.op");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AI operation checks passed.");
process.exit(0);
