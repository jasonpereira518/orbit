/**
 * Cosmo's test set (scripts/eval-fixtures/voice-eval.json): spoken requests and the tool Cosmo
 * should reach for first.
 *
 *   npx tsx scripts/eval-voice.ts
 *
 * Today this validates the set against the real thing, with no model calls: it builds the real
 * Cosmo prompt for a seeded user in a disposable PGlite and checks that every case names only
 * tools Cosmo actually has (a case naming a missing tool tests nothing), and that the prompt fits
 * Deepgram's budget.
 *
 * Scoring a model on the set is a follow-up: it must go through the AI gate like
 * scripts/eval-ai.ts (src/lib/ai-access.ts is the only path to a provider; smoke-ai-access
 * enforces it), which needs a registered operation for it. That run is what will pick
 * Deepgram's default think model (DEEPGRAM_THINK_MODELS) and decide whether Orbit needs its own
 * voice brain (Cosmo PR 14).
 */
import "./smoke/_env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { bootstrapAuthenticatedUser } from "../src/lib/auth";
import { VOICE_PROMPT_BUDGET, voiceInstructions, voiceToolsFor, voiceSink } from "../src/lib/voice/tools";
import { pointingCatalog } from "../src/lib/cosmo/pointing";
import { describeScreen } from "../src/lib/cosmo/screen";
import { ASK_CHAT_TOOL, LOOK_AT_SCREEN_TOOL, OPEN_PAGE_TOOL, POINT_AT_TOOL, SET_CAPTIONS_TOOL, SET_THEME_TOOL, START_RECORDING_TOOL } from "../src/lib/voice/policy";

type Case = {
  say: string;
  screen?: { page: string | null; id?: string; targets: string[] };
  expect: { tools?: string[]; notTools?: string[]; noTool?: boolean; inputIncludes?: string };
};
const USER = "eval-voice-user";
const ADA = "5b0c8d62-7a49-4a8e-9f7f-1f0e3a0c2d11";
const BROWSER_TOOLS = [OPEN_PAGE_TOOL, ASK_CHAT_TOOL, START_RECORDING_TOOL, SET_THEME_TOOL, SET_CAPTIONS_TOOL, LOOK_AT_SCREEN_TOOL, POINT_AT_TOOL];

async function main() {
  const { cases } = JSON.parse(readFileSync(join("scripts/eval-fixtures/voice-eval.json"), "utf8")) as { cases: Case[] };
  await bootstrapAuthenticatedUser(USER);
  const db = await getDb();
  await db.insert(contacts).values([
    { id: ADA, userId: USER, fullName: "Ada Lovelace", company: "Analytical Engines", title: "Founder" },
    { userId: USER, fullName: "Grace Hopper", company: "Stripe", title: "Engineering Manager" },
  ]).onConflictDoNothing();
  const prompt = await voiceInstructions(USER, "America/New_York", pointingCatalog());

  const known = new Set([...(await voiceToolsFor(USER, voiceSink({}, "UTC"))).map((t) => t.name), ...BROWSER_TOOLS]);
  const bad = cases.flatMap((c) => [...(c.expect.tools ?? []), ...(c.expect.notTools ?? [])].filter((t) => !known.has(t)).map((t) => `${c.say} → ${t}`));
  if (bad.length) throw new Error(`Cases name tools Cosmo doesn't have:\n${bad.join("\n")}`);
  const unscreenable = cases.filter((c) => c.screen && !describeScreen(c.screen)).map((c) => c.say);
  if (unscreenable.length) throw new Error(`Cases with a screen Cosmo would never be told:\n${unscreenable.join("\n")}`);
  // The longest screen line any case adds, on top of the prompt, must still fit.
  const longest = Math.max(0, ...cases.map((c) => (describeScreen(c.screen) ?? "").length + 40));
  if (prompt.length + longest > VOICE_PROMPT_BUDGET) throw new Error(`Cosmo's prompt (${prompt.length}) plus a screen line is over budget`);
  console.log(`ok ${cases.length} cases name only real tools and screens; prompt ${prompt.length} of ${VOICE_PROMPT_BUDGET} chars`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
