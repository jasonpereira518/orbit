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
  usageRow,
  withUsage,
  type UsageRecord,
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

/** The row `recordUsage` would insert, built from a `UsageRecord` with sensible defaults. */
function rowFor(overrides: Partial<UsageRecord> & { model: string }) {
  return usageRow({
    userId: USER,
    operation: "smoke.row",
    provider: "openai",
    kind: "completion",
    keyOwner: "user",
    success: true,
    ...overrides,
  });
}

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

    // Gemini 3.x thinks by default; thoughts bill at the output rate but are reported apart
    // from candidates, and audio prompt tokens bill at their own rate.
    const thinking = tokensFromGemini({
      usageMetadata: {
        promptTokenCount: 500,
        candidatesTokenCount: 40,
        thoughtsTokenCount: 360,
        promptTokensDetails: [
          { modality: "TEXT", tokenCount: 20 },
          { modality: "AUDIO", tokenCount: 480 },
        ],
      },
    });
    check("gemini thoughts are billed as output", thinking.outputTokens === 400, String(thinking.outputTokens));
    check("gemini audio prompt tokens are split out", thinking.audioInputTokens === 480);
    check(
      "gemini with no candidates or thoughts reports no output",
      tokensFromGemini({ usageMetadata: { promptTokenCount: 5 } }).outputTokens === null
    );

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
    // Anthropic's input_tokens EXCLUDES cache reads and writes; the extractor sums them so
    // inputTokens is the whole prompt, as it is for the other two providers.
    check("anthropic input is the whole prompt", anthropic.inputTokens === 1028, String(anthropic.inputTokens));
    check("anthropic output_tokens", anthropic.outputTokens === 210);
    check("anthropic cache_read_input_tokens", anthropic.cachedInputTokens === 128);

    const written = tokensFromAnthropic({
      usage: {
        input_tokens: 50,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 4000,
      },
    });
    check("anthropic cache writes count toward input", written.inputTokens === 4050);
    check("anthropic cache writes are split out", written.cacheWriteTokens === 4000);

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
    // 1M input @ $1.50 + 1M output @ $9.00 = $10.50 = 10_500_000 micros
    check(
      "cost math is exact",
      estimateCostMicros({
        model: "gemini-3.5-flash",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }) === 10_500_000
    );
    check(
      "cached tokens bill at the discounted rate",
      estimateCostMicros({
        model: "gemini-3.5-flash",
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 0,
      }) === 150_000
    );
    // Sonnet 4.5: 1M cache-written tokens at 1.25 × $3 = $3.75.
    check(
      "anthropic cache writes bill at 1.25x input",
      estimateCostMicros({
        model: "claude-sonnet-4-5",
        inputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }) === 3_750_000
    );
    // 2.5 Flash: audio $1.00 vs text $0.30.
    check(
      "gemini audio bills at the audio rate",
      estimateCostMicros({
        model: "gemini-2.5-flash",
        inputTokens: 1_000_000,
        audioInputTokens: 1_000_000,
      }) === 1_000_000
    );
    check(
      "batch calls bill at half price",
      estimateCostMicros({
        model: "gpt-4o-mini",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        batch: true,
      }) === 375_000
    );
    // Announced price changes apply from their date, not before.
    check(
      "gemini 3.8 flash before Jan 1 2027",
      priceFor("gemini-3.8-flash", new Date("2026-12-31T23:59:59Z"))?.input === 0.75
    );
    check(
      "gemini 3.8 flash from Jan 1 2027",
      priceFor("gemini-3.8-flash", new Date("2027-01-01T00:00:00Z"))?.input === 1.5
    );
    check(
      "an unlisted gpt-5.x id is never priced as a cheaper sibling",
      priceFor("gpt-5.6-sol") === null
    );
    check(
      "claude-opus-4-6 is not priced as retired Opus 4",
      priceFor("claude-opus-4-6")?.input === 5
    );
  }

  console.log("\nReported cost (OpenRouter's usage.cost) vs. the estimate");
  {
    check(
      "a reported cost wins over the estimate",
      rowFor({ model: "google/gemini-3.8-flash", inputTokens: 1000, outputTokens: 100, reportedCostMicros: 4242 })
        .estimatedCostMicros === 4242
    );
    check(
      "a reported cost is stamped as reported",
      rowFor({ model: "google/gemini-3.8-flash", reportedCostMicros: 4242 }).costSource === "reported"
    );
    check(
      "no reported cost still estimates, and says so",
      rowFor({ model: "gemini-3.8-flash", inputTokens: 1000, outputTokens: 100 }).costSource === "estimated"
    );
    check(
      "a reported cost of zero is honoured, not treated as missing",
      rowFor({ model: "google/gemini-3.8-flash", reportedCostMicros: 0 }).estimatedCostMicros === 0
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
    check("cost computed at write time", rows[0].estimatedCostMicros === 10_500_000);
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

  console.log("\nClient disconnect");
  {
    const controller = new AbortController();
    controller.abort();
    const aborted = new Error("Request was aborted.");
    let caught: unknown = null;
    try {
      await withUsage(
        { ...META, operation: "smoke.cancelled" },
        async () => {
          throw aborted;
        },
        { cancelSignal: controller.signal }
      );
    } catch (err) {
      caught = err;
    }
    check("the abort is still rethrown unchanged", caught === aborted);
    await settle();
    const rows = await rowsFor(USER);
    const row = rows.find((r) => r.operation === "smoke.cancelled");
    check("a cancelled call writes a row", Boolean(row));
    check("…filed as cancelled, not other", row?.errorKind === "cancelled", String(row?.errorKind));

    const live = new AbortController();
    try {
      await withUsage(
        { ...META, operation: "smoke.not-cancelled" },
        async () => {
          throw new Error("429 rate limit exceeded");
        },
        { cancelSignal: live.signal }
      );
    } catch {
      // expected
    }
    await settle();
    const other = (await rowsFor(USER)).find((r) => r.operation === "smoke.not-cancelled");
    check("an unaborted signal keeps the real classification", other?.errorKind === "rate_limit", String(other?.errorKind));
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
