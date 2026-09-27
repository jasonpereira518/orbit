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
import { JEV_MODEL, modelForOperation } from "../src/lib/ai-models";
import { AI_PROVIDERS, DEFAULT_MODELS, PROVIDER_MODELS } from "../src/lib/ai-providers";
import { MANAGED_AI_ENABLED, MANAGED_DEFAULT_MODELS, MANAGED_MODELS } from "../src/lib/managed-ai-policy";
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
    /\.(?:completion|embedding|transcription)\(\s*"([a-z][\w.-]*)"/g,
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

console.log("\nThe registry's tier is what picks the model");
{
  // `modelForOperation` is the only thing that answers "which model runs this", so these
  // are the routing rules themselves, not a copy of them.
  const own = { provider: "gemini" as const, model: "gemini-2.5-pro", keyOwner: "user" as const };
  check("a `user` operation runs the person's own model", modelForOperation("chat.answer", own) === "gemini-2.5-pro");
  check("a `fast` operation runs the fast tier", modelForOperation("chat.rerank", own) === FAST_MODELS.gemini);
  check("a `vision` operation runs the vision tier", modelForOperation("capture.transcribe.page", own) === VISION_MODELS.gemini);

  // Nobody is moved onto a DEARER model by a tier that exists to save money.
  const thrifty = { provider: "gemini" as const, model: "gemini-3.1-flash-lite", keyOwner: "user" as const };
  check(
    "someone already on a cheaper model than the tier keeps theirs",
    modelForOperation("capture.transcribe.page", thrifty) === "gemini-3.1-flash-lite"
  );

  // On Orbit's key a tier must not reach past the managed allowlist — vision used to, and
  // gpt-4o is 16x gpt-4o-mini. The account below is ON the vision tier's own model, so the
  // "keep the cheaper model" rule above cannot be what decides; only the allowlist can.
  //
  // With MANAGED_AI_ENABLED off (where it stands today) the only key behind this path is
  // the developer's own on `next dev`, so there is no allowlist to enforce and the tier's
  // own model runs.
  const onOrbit = { provider: "openai" as const, model: "gpt-4o", keyOwner: "orbit" as const };
  const visionOnOrbit = modelForOperation("capture.transcribe.page", onOrbit);
  check(
    MANAGED_AI_ENABLED
      ? `vision on Orbit's key stays on the allowlist (${visionOnOrbit})`
      : `managed AI off: vision runs the tier's own model (${visionOnOrbit})`,
    MANAGED_AI_ENABLED ? MANAGED_MODELS.openai.includes(visionOnOrbit) : visionOnOrbit === VISION_MODELS.openai,
    visionOnOrbit
  );
  for (const id of AI_OPERATION_IDS) {
    const tier = AI_OPERATIONS[id].tier;
    if (tier !== "fast" && tier !== "vision") continue;
    const chosen = modelForOperation(id, { provider: "gemini", model: "gemini-2.5-pro", keyOwner: "orbit" });
    check(
      `${id} on Orbit's key resolves to a priced model`,
      priceFor(chosen) !== null && (!MANAGED_AI_ENABLED || MANAGED_MODELS.gemini.includes(chosen)),
      chosen
    );
  }
}

console.log("\nEvery reachable model is priced");
{
  const reachable = new Set<string>();
  for (const p of AI_PROVIDERS) {
    // OpenRouter reports its own real cost (a later task adds `reportedCostMicros`); it is
    // deliberately absent from the static `ai-pricing.ts` table — same reasoning as
    // `smoke-fast-model.ts`'s equivalent skip.
    if (p.id === "openrouter") continue;
    reachable.add(DEFAULT_MODELS[p.id]);
    reachable.add(FAST_MODELS[p.id]);
    reachable.add(VISION_MODELS[p.id]);
    reachable.add(MANAGED_DEFAULT_MODELS[p.id]);
    for (const m of PROVIDER_MODELS[p.id]) reachable.add(m.value);
    for (const m of MANAGED_MODELS[p.id]) reachable.add(m);
  }
  for (const [backend, m] of Object.entries(EMBEDDING_MODELS)) {
    if (backend === "openrouter") continue;
    reachable.add(m);
  }
  // The decision tier's one model: unpriced, every Jev call would record no cost.
  reachable.add(JEV_MODEL);
  for (const model of reachable) check(`${model} has a price row`, priceFor(model) !== null);
}

console.log("\nDerived lists");
{
  check(
    "background set is the bulk operations (the scan's two decision steps included)",
    [...BACKGROUND_AI_OPERATIONS].sort().join(",") ===
      [
        "calendar.kind",
        "duplicates.same_person",
        "duplicates.same_person.llm",
        "import.enrich",
        "import.enrich.gate",
        "import.linkedin.timeline",
        "import.linkedin.timeline.decide",
        "recruiter.gate",
        "recruiter.prefilter",
        "recruiter.scan",
        "search.embed.batch",
      ].join(","),
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
