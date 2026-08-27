/**
 * Verifies the fast-model map covers every provider with a known cheap model.
 * No DB, no network. Run: npx tsx scripts/smoke-fast-model.ts
 */
import { FAST_MODELS } from "../src/lib/ai";
import { AI_PROVIDERS, PROVIDER_MODELS } from "../src/lib/ai-providers";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  for (const p of AI_PROVIDERS) {
    const fast = FAST_MODELS[p.id];
    check(`${p.id} has a fast model`, typeof fast === "string" && fast.length > 0);
    check(
      `${p.id} fast model is in the known roster`,
      PROVIDER_MODELS[p.id].some((m) => m.value === fast),
      fast
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
