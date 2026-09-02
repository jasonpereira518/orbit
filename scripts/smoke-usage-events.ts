/**
 * Verifies the AI usage instrumentation without needing a provider API key.
 *
 * What matters here is the wrapper's contract, not the network call:
 *   - a success writes a row with the provider's real token field names decoded
 *   - a failure ALSO writes a row, and still rethrows the original error unchanged
 *     (telemetry must never swallow or reshape what the user sees)
 *   - it works with no request scope, because `ai.ts` is reached from the import-job
 *     processor and the process-stalled cron, where `after()` throws
 *   - Whisper and Gemini embeddings record null tokens, never a fabricated zero
 *
 * Run: npx tsx scripts/smoke-usage-events.ts
 */
import "./smoke/_env";

import { desc, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { usageEvents } from "../src/db/schema";
import {
  tokensFromAnthropic,
  tokensFromGemini,
  tokensFromOpenAi,
  withUsage,
} from "../src/lib/usage-events";
import { estimateCostMicros, priceFor } from "../src/lib/ai-pricing";

const USER = "smoke-usage-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** Give the fire-and-forget insert a moment to land. */
const settle = () => new Promise((r) => setTimeout(r, 150));

async function rowsFor(userId: string) {
  const db = await getDb();
  return db.query.usageEvents.findMany({
    where: eq(usageEvents.userId, userId),
    orderBy: [desc(usageEvents.createdAt)],
  });
}

async function cleanup() {
  const db = await getDb();
  await db.delete(usageEvents).where(eq(usageEvents.userId, USER));
}

const META = {
  userId: USER,
  operation: "smoke.test",
  provider: "gemini" as const,
  model: "gemini-3.5-flash",
  kind: "completion" as const,
  keyOwner: "user" as const,
};

async function main() {
  await cleanup();

  console.log("Token extraction (real SDK response shapes)");
  {
    // @google/genai v2
    const gemini = tokensFromGemini({
      usageMetadata: {
        promptTokenCount: 120,
        candidatesTokenCount: 45,
        cachedContentTokenCount: 20,
      },
    });
    check("gemini promptTokenCount → inputTokens", gemini.inputTokens === 120);
    check("gemini candidatesTokenCount → outputTokens", gemini.outputTokens === 45);
    check("gemini cachedContentTokenCount", gemini.cachedInputTokens === 20);

    // openai v6 chat.completions
    const openai = tokensFromOpenAi({
      usage: {
        prompt_tokens: 300,
        completion_tokens: 80,
        prompt_tokens_details: { cached_tokens: 64 },
      },
    });
    check("openai prompt_tokens → inputTokens", openai.inputTokens === 300);
    check("openai completion_tokens → outputTokens", openai.outputTokens === 80);
    check("openai cached_tokens", openai.cachedInputTokens === 64);

    // openai embeddings report prompt_tokens only.
    const embed = tokensFromOpenAi({ usage: { prompt_tokens: 55 } });
    check("openai embedding inputTokens", embed.inputTokens === 55);
    check("openai embedding has no output tokens", embed.outputTokens === null);

    // @anthropic-ai/sdk
    const anthropic = tokensFromAnthropic({
      usage: {
        input_tokens: 900,
        output_tokens: 210,
        cache_read_input_tokens: 128,
      },
    });
    check("anthropic input_tokens", anthropic.inputTokens === 900);
    check("anthropic output_tokens", anthropic.outputTokens === 210);
    check("anthropic cache_read_input_tokens", anthropic.cachedInputTokens === 128);

    // Providers that report nothing must yield an empty object, never zeros.
    check("missing usage yields no counts", Object.keys(tokensFromGemini({})).length === 0);
    check(
      "null response yields no counts",
      Object.keys(tokensFromOpenAi(null)).length === 0
    );
  }

  console.log("\nCost estimation");
  {
    check("known model is priced", priceFor("gemini-3.5-flash") !== null);
    check(
      "dated snapshot falls back to prefix",
      priceFor("gemini-3.5-flash-002") !== null
    );
    check("unknown model returns null, never a guess", priceFor("totally-made-up") === null);
    check(
      "unpriced model yields null cost",
      estimateCostMicros({ model: "totally-made-up", inputTokens: 1000 }) === null
    );
    check(
      "no token counts yields null cost, not $0",
      estimateCostMicros({ model: "gemini-3.5-flash" }) === null
    );
    // 1M input @ $0.30 + 1M output @ $2.50 = $2.80 = 2_800_000 micros
    check(
      "cost math is exact",
      estimateCostMicros({
        model: "gemini-3.5-flash",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }) === 2_800_000
    );
    check(
      "cached tokens bill at the discounted rate",
      estimateCostMicros({
        model: "gemini-3.5-flash",
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 0,
      }) === 75_000
    );
  }

  console.log("\nSuccess path (no request scope — the cron/import-job case)");
  {
    const result = await withUsage(META, async (report) => {
      report({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
      return "done";
    });
    check("returns the wrapped value", result === "done");

    await settle();
    const rows = await rowsFor(USER);
    check(`one row written (${rows.length})`, rows.length === 1);
    check("marked successful", rows[0].success === 1);
    check("operation recorded", rows[0].operation === "smoke.test");
    check("keyOwner recorded", rows[0].keyOwner === "user");
    check("input tokens recorded", rows[0].inputTokens === 1_000_000);
    check("cost computed at write time", rows[0].estimatedCostMicros === 2_800_000);
    check("duration recorded", typeof rows[0].durationMs === "number");
  }

  console.log("\nFailure path");
  {
    const original = new Error("429 rate limit exceeded");
    let caught: unknown = null;
    try {
      await withUsage(META, async () => {
        throw original;
      });
    } catch (err) {
      caught = err;
    }

    // The single most important property: telemetry must not swallow or reshape errors.
    check("the original error is rethrown unchanged", caught === original);

    await settle();
    const rows = await rowsFor(USER);
    const failure = rows.find((r) => r.success === 0);
    check("a failure row is written", Boolean(failure));
    check("errorKind is classified", failure?.errorKind === "rate_limit");
    check("failed row has null tokens", failure?.inputTokens === null);
  }

  console.log("\nNull-token providers (Whisper, Gemini embeddings)");
  {
    await withUsage(
      { ...META, operation: "smoke.transcribe", kind: "transcription", model: "whisper-1" },
      async () => "transcript"
    );
    await settle();
    const rows = await rowsFor(USER);
    const t = rows.find((r) => r.operation === "smoke.transcribe");
    check("transcription row written", Boolean(t));
    check("tokens are null, not zero", t?.inputTokens === null);
    check("cost is null, not $0", t?.estimatedCostMicros === null);
  }

  console.log("\nResilience");
  {
    // A telemetry failure must never become a user-visible failure.
    const value = await withUsage(
      { ...META, model: "" },
      async (report) => {
        report({ inputTokens: 5 });
        return 42;
      }
    );
    check("succeeds even with degenerate metadata", value === 42);
  }

  await cleanup();
  console.log("\nAll usage instrumentation checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("\n" + e.message);
    await cleanup().catch(() => {});
    process.exit(1);
  });
