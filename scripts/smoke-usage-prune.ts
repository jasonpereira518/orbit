/**
 * The usage_events retention sweep must not delete the spend a still-open provider pool is
 * counting (`MANAGED_AI_POOLS`): the prepaid OpenAI pool never resets, so its Orbit-paid rows
 * stay the pool's ledger long past the 180-day retention. The spare is PER PROVIDER, inside
 * that provider's own window: BYOK rows, Orbit rows from before the window, Orbit rows of a
 * provider with no pool, and another provider's rows that merely fall in OpenAI's window
 * period are still pruned. Run: npx tsx scripts/smoke-usage-prune.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { usageEvents } from "../src/db/schema";
import { pruneOlderThan, pruneUsageEvents } from "../src/lib/event-prune";
import { MANAGED_AI_POOLS, poolWindowStart } from "../src/lib/managed-ai-policy";

const USER = "smoke-usage-prune-user";
const DAY = 86_400_000;
const RETENTION_DAYS = 180;

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

type Provider = "openai" | "anthropic" | "gemini";
const row = (label: string, provider: Provider, keyOwner: "user" | "orbit", createdAt: Date) => ({
  userId: USER, operation: `smoke.${label}`, provider, model: "m", kind: "completion" as const,
  keyOwner, estimatedCostMicros: 1_000, success: 1, createdAt,
});

run(async () => {
  const db = await getDb();
  const cleanup = () => db.delete(usageEvents).where(eq(usageEvents.userId, USER));
  const surviving = async () =>
    new Set((await db.select({ op: usageEvents.operation }).from(usageEvents).where(eq(usageEvents.userId, USER))).map((r) => r.op.replace("smoke.", "")));
  await cleanup();
  try {
    const openai = MANAGED_AI_POOLS.openai;
    const anthropic = MANAGED_AI_POOLS.anthropic;
    if (!openai || !anthropic || openai.monthlyResetDay || !anthropic.monthlyResetDay) {
      throw new Error("expected a prepaid openai pool and a monthly anthropic pool: update this smoke with MANAGED_AI_POOLS");
    }

    console.log("A prepaid pool's window outlives the retention");
    // Far enough out that OpenAI's window (no reset) is older than the retention while still
    // open, and Anthropic's monthly window has long since moved past it.
    const now = new Date(Date.now() + 400 * DAY);
    const openaiStart = poolWindowStart(openai, now);
    const anthropicStart = poolWindowStart(anthropic, now);
    const inOpenaiPeriod = new Date(openaiStart.getTime() + 10 * DAY);
    const beforeOpenai = new Date(openaiStart.getTime() - 10 * DAY);
    check("the rows below are all past retention, so only the guard can keep one",
      inOpenaiPeriod.getTime() < now.getTime() - RETENTION_DAYS * DAY && inOpenaiPeriod.getTime() < anthropicStart.getTime(), openaiStart.toISOString());
    await db.insert(usageEvents).values([
      row("orbit-openai-in-window", "openai", "orbit", inOpenaiPeriod),
      row("byok-openai-in-window", "openai", "user", inOpenaiPeriod),
      row("orbit-openai-before-window", "openai", "orbit", beforeOpenai),
      row("byok-openai-before-window", "openai", "user", beforeOpenai),
      row("orbit-anthropic-outside-its-window", "anthropic", "orbit", inOpenaiPeriod),
      row("orbit-gemini-no-pool", "gemini", "orbit", inOpenaiPeriod),
      row("orbit-openai-fresh", "openai", "orbit", new Date(now.getTime() - DAY)),
      row("byok-openai-fresh", "openai", "user", new Date(now.getTime() - DAY)),
    ]);
    const pruned = await pruneUsageEvents(RETENTION_DAYS, now);
    let left = await surviving();
    check("an old Orbit OpenAI row inside OpenAI's window survives", left.has("orbit-openai-in-window"), [...left].join(", "));
    check("an old BYOK row inside the window is deleted", !left.has("byok-openai-in-window"));
    check("an Orbit OpenAI row older than its window is deleted", !left.has("orbit-openai-before-window"));
    check("an old BYOK row older than the window is deleted", !left.has("byok-openai-before-window"));
    check("an old Orbit Anthropic row outside Anthropic's window (inside OpenAI's period) is deleted", !left.has("orbit-anthropic-outside-its-window"));
    check("an old Orbit row of a provider with no pool is deleted", !left.has("orbit-gemini-no-pool"));
    check("rows inside the retention are kept", left.has("orbit-openai-fresh") && left.has("byok-openai-fresh"));
    check("the sweep reports what it deleted", pruned === 5, String(pruned));

    console.log("\nA monthly pool keeps its own current window");
    await cleanup();
    // The 28th: Anthropic's window opened on the 15th, 13 days before; retention of one day.
    const late = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 28));
    const start = poolWindowStart(anthropic, late);
    await db.insert(usageEvents).values([
      row("orbit-anthropic-in-window", "anthropic", "orbit", new Date(start.getTime() + DAY)),
      row("orbit-anthropic-before-window", "anthropic", "orbit", new Date(start.getTime() - DAY)),
      row("byok-anthropic-in-window", "anthropic", "user", new Date(start.getTime() + DAY)),
    ]);
    await pruneUsageEvents(1, late);
    left = await surviving();
    check("an Orbit Anthropic row inside the current monthly window survives", left.has("orbit-anthropic-in-window"), [...left].join(", "));
    check("the previous month's, and a BYOK row, are deleted", !left.has("orbit-anthropic-before-window") && !left.has("byok-anthropic-in-window"));

    console.log("\nOther tables");
    await cleanup();
    await db.insert(usageEvents).values(row("unguarded", "openai", "orbit", inOpenaiPeriod));
    await pruneOlderThan(usageEvents, RETENTION_DAYS, undefined, now);
    check("without a keep clause the helper deletes every old row, as before", !(await surviving()).has("unguarded"));
  } finally {
    await cleanup();
  }
});
