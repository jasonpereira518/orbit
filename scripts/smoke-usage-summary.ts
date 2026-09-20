/**
 * The 30-day AI usage card: this user's calls, grouped by feature, with the cost estimated
 * when each call was recorded. Other users' rows and rows older than the window never count.
 * Run: npx tsx scripts/smoke-usage-summary.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { usageEvents } from "../src/db/schema";
import { loadUsageSummary } from "../src/lib/usage-summary";

const USER = "smoke-usage-summary-user";
const OTHER = "smoke-usage-summary-other";
const NOW = new Date("2026-09-15T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const base = { provider: "gemini" as const, model: "gemini-3.5-flash", kind: "completion" as const, keyOwner: "user" as const };

run(async () => {
  const db = await getDb();
  await db.delete(usageEvents).where(inArray(usageEvents.userId, [USER, OTHER]));
  await db.insert(usageEvents).values([
    { ...base, userId: USER, operation: "capture.parse", inputTokens: 1000, outputTokens: 200, estimatedCostMicros: 800, createdAt: daysAgo(1) },
    { ...base, userId: USER, operation: "capture.parse", inputTokens: 1000, outputTokens: 200, estimatedCostMicros: 800, createdAt: daysAgo(3) },
    { ...base, userId: USER, operation: "chat.answer", inputTokens: 4000, outputTokens: 500, estimatedCostMicros: 5000, createdAt: daysAgo(2) },
    { ...base, userId: USER, operation: "chat.answer", success: 0, errorKind: "auth", createdAt: daysAgo(2) },
    { ...base, userId: USER, operation: "search.embed", kind: "embedding", createdAt: daysAgo(4) },
    { ...base, userId: USER, operation: "capture.parse", inputTokens: 9, outputTokens: 9, estimatedCostMicros: 999_999, createdAt: daysAgo(40) },
    { ...base, userId: OTHER, operation: "chat.answer", estimatedCostMicros: 123_456, createdAt: daysAgo(1) },
    // A Lifetime call on Orbit's managed key: metered against the allowance, never "your key".
    { ...base, userId: USER, operation: "chat.answer", keyOwner: "orbit", estimatedCostMicros: 77_777, createdAt: daysAgo(1) },
  ]);

  const summary = await loadUsageSummary(USER, { now: NOW });
  const byOp = new Map(summary.rows.map((r) => [r.operation, r]));
  check("rows are ordered by estimated cost", summary.rows.map((r) => r.operation).join() === "chat.answer,capture.parse,search.embed", summary.rows.map((r) => r.operation).join());
  check("calls and failures are counted per feature", byOp.get("chat.answer")?.calls === 2 && byOp.get("chat.answer")?.failures === 1);
  check("tokens and cost are summed", byOp.get("capture.parse")?.inputTokens === 2000 && byOp.get("capture.parse")?.costMicros === 1600);
  check("a successful call with no estimate is counted as unpriced", byOp.get("search.embed")?.unpricedCalls === 1);
  check("a failed call is not called unpriced", byOp.get("chat.answer")?.unpricedCalls === 0);
  check("the window excludes a 40-day-old row", summary.totalCalls === 5, `${summary.totalCalls}`);
  check("another user's rows never count", summary.totalCostMicros === 6600, `${summary.totalCostMicros}`);
  check("calls on Orbit's managed key never count as the person's own", byOp.get("chat.answer")?.costMicros === 5000, `${byOp.get("chat.answer")?.costMicros}`);
  check("totals carry the unpriced count", summary.unpricedCalls === 1);
  check("known operations get a readable label", byOp.get("capture.parse")?.label === "Capture: reading notes");

  const empty = await loadUsageSummary("smoke-usage-summary-nobody", { now: NOW });
  check("an account with no calls gets an empty summary", empty.rows.length === 0 && empty.totalCalls === 0);

  await db.delete(usageEvents).where(inArray(usageEvents.userId, [USER, OTHER]));
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll usage-summary checks passed.");
});
