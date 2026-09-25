/**
 * Pins `accountsMissingProviderKey` in `src/lib/admin-health.ts`, which is what
 * `/admin/health` calls "accounts that cannot use AI at all".
 *
 * Why this file exists: that function decides key presence with a raw SQL `CASE` over
 * `ai_provider`, and `scripts/smoke-provider-exhaustive.ts` walks the TypeScript AST, so a
 * missing `WHEN` arm there is invisible to every other guard in this repo. It had exactly
 * that bug — no `'openrouter'` arm, so every OpenRouter account fell to the
 * `ELSE gemini_api_key_encrypted IS NOT NULL` default, reporting a healthy OpenRouter
 * account as broken and clearing a broken one that happened to hold a stale Gemini key.
 *
 * The guard is the same shape `scripts/smoke-admin-roster.ts` uses for the other SQL
 * re-implementation: seed one account per provider in both states, then assert the SQL
 * answer agrees, account for account, with the obvious per-provider rule written in TS.
 *
 * Runs against the local PGlite database. Run: npx tsx scripts/smoke-admin-health.ts
 */
import "./smoke/_env";

import { inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { accountsMissingProviderKey } from "../src/lib/admin-health";
import { AI_PROVIDERS, type AiProvider } from "../src/lib/ai-providers";
import { ensureUserSettings } from "../src/lib/user-settings";

const PREFIX = "smoke-adminhealth-";

/** The key column each provider's own key lives in — the rule the SQL `CASE` encodes. */
const KEY_COLUMN: Record<AiProvider, keyof typeof userSettings.$inferInsert> = {
  gemini: "geminiApiKeyEncrypted",
  openai: "openaiApiKeyEncrypted",
  anthropic: "anthropicApiKeyEncrypted",
  openrouter: "openrouterApiKeyEncrypted",
};

/** Every provider, twice: once holding its own key, once holding only a Gemini key. */
type Case = { id: string; provider: AiProvider; ownKey: boolean; expectMissing: boolean };
const CASES: Case[] = AI_PROVIDERS.flatMap((p) => [
  { id: `${PREFIX}${p.id}-haskey`, provider: p.id, ownKey: true, expectMissing: false },
  // The decoy that made the old ELSE arm look healthy: a stale Gemini key and nothing for
  // the provider actually selected. Only a real per-provider arm gets this right.
  { id: `${PREFIX}${p.id}-stalegemini`, provider: p.id, ownKey: false, expectMissing: p.id !== "gemini" },
]);
const IDS = CASES.map((c) => c.id);

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function cleanup() {
  const db = await getDb();
  await db.delete(userSettings).where(inArray(userSettings.userId, IDS));
}

async function seed() {
  const db = await getDb();
  for (const c of CASES) {
    await ensureUserSettings(c.id);
    await db
      .update(userSettings)
      .set({
        email: `${c.id}@a.test`,
        aiProvider: c.provider,
        // Always present, so a provider arm that falls through to the Gemini default reads
        // as healthy and this smoke catches it.
        geminiApiKeyEncrypted: "stale-gemini-ciphertext",
        ...(c.ownKey ? { [KEY_COLUMN[c.provider]]: "ciphertext" } : {}),
      })
      .where(inArray(userSettings.userId, [c.id]));
  }
}

async function main() {
  await cleanup();
  await seed();

  console.log("accountsMissingProviderKey agrees with the per-provider rule");
  const missing = await accountsMissingProviderKey();
  const missingIds = new Set(missing.filter((r) => IDS.includes(r.userId)).map((r) => r.userId));

  check("the check is not vacuous — some seeded account is reported missing", missingIds.size > 0);
  for (const c of CASES) {
    check(
      `${c.provider} ${c.ownKey ? "with its own key" : "with only a stale gemini key"} → ${c.expectMissing ? "missing" : "healthy"}`,
      missingIds.has(c.id) === c.expectMissing
    );
  }

  const reported = new Map(missing.map((r) => [r.userId, r.provider]));
  for (const c of CASES) {
    if (!missingIds.has(c.id)) continue;
    check(`${c.id} is reported under its own provider`, reported.get(c.id) === c.provider);
  }

  await cleanup();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll admin-health checks passed.");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
