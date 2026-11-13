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
 * SCORING. `--score` replays each case on real models: the same prompt and the one function a
 * live call has (`orbit_tool`, Deepgram's think stage), the case's screen added the way a call's
 * start adds it, and the person's words as the user turn. Only the FIRST tool call is scored —
 * it is what a live call would act on (after a look_at_screen, which is answered with the case's
 * screen, the call that follows is scored instead). Through the AI gate (`voice.eval`, the synthetic user's
 * own OpenAI key, like scripts/eval-ai.ts), so nothing calls a provider directly.
 *
 *   ORBIT_EVAL_OPENAI_KEY=… npx tsx scripts/eval-voice.ts --score
 *   npx tsx scripts/eval-voice.ts --score --keys-from ../../.env.local --models gpt-4o-mini,gpt-4.1 --runs 2
 *
 * `--only <text>` runs just the cases whose words include it; `--verbose` prints each answer.
 * `--models` defaults to every DEEPGRAM_THINK_MODELS entry. The result picks Deepgram's default
 * think model and says whether Orbit needs its own voice brain (Cosmo PR 14). Text-level only:
 * no audio, no latency, no multi-turn.
 */
import "./smoke/_env";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseEnv } from "node:util";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { getDb } from "../src/db";
import { contacts, userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";
import { createToolDriver } from "../src/lib/ai-tools";
import { CRM_VOICE_TOOL, DEEPGRAM_THINK_MODELS } from "../src/lib/voice/config";
import { bootstrapAuthenticatedUser } from "../src/lib/auth";
import { VOICE_PROMPT_BUDGET, voiceInstructions, voiceToolsFor, voiceSink } from "../src/lib/voice/tools";
import { pointingCatalog } from "../src/lib/cosmo/pointing";
import { actionsCatalog } from "../src/lib/cosmo/actions";
import { describeScreen } from "../src/lib/cosmo/screen";
import { ASK_CHAT_TOOL, CLICK_TOOL, LOOK_AT_SCREEN_TOOL, OPEN_PAGE_TOOL, POINT_AT_TOOL, SET_CAPTIONS_TOOL, SET_THEME_TOOL, START_RECORDING_TOOL, TYPE_INTO_TOOL } from "../src/lib/voice/policy";

type Case = {
  say: string;
  screen?: { page: string | null; id?: string; targets: string[] };
  expect: { tools?: string[]; notTools?: string[]; noTool?: boolean; inputIncludes?: string };
};
const USER = "eval-voice-user";
const ADA = "5b0c8d62-7a49-4a8e-9f7f-1f0e3a0c2d11";
const BROWSER_TOOLS = [OPEN_PAGE_TOOL, ASK_CHAT_TOOL, START_RECORDING_TOOL, SET_THEME_TOOL, SET_CAPTIONS_TOOL, LOOK_AT_SCREEN_TOOL, POINT_AT_TOOL, CLICK_TOOL, TYPE_INTO_TOOL];

async function main() {
  const { cases: all } = JSON.parse(readFileSync(join("scripts/eval-fixtures/voice-eval.json"), "utf8")) as { cases: Case[] };
  // --only <text>: just the cases whose words include it (a quick look at one behaviour).
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1]?.toLowerCase() : undefined;
  const cases = only ? all.filter((c) => c.say.toLowerCase().includes(only)) : all;
  await bootstrapAuthenticatedUser(USER);
  const db = await getDb();
  await db.insert(contacts).values([
    { id: ADA, userId: USER, fullName: "Ada Lovelace", company: "Analytical Engines", title: "Founder" },
    { userId: USER, fullName: "Grace Hopper", company: "Stripe", title: "Engineering Manager" },
  ]).onConflictDoNothing();
  const prompt = await voiceInstructions(USER, "America/New_York", pointingCatalog(), actionsCatalog());

  const known = new Set([...(await voiceToolsFor(USER, voiceSink({}, "UTC"))).map((t) => t.name), ...BROWSER_TOOLS]);
  const bad = cases.flatMap((c) => [...(c.expect.tools ?? []), ...(c.expect.notTools ?? [])].filter((t) => !known.has(t)).map((t) => `${c.say} → ${t}`));
  if (bad.length) throw new Error(`Cases name tools Cosmo doesn't have:\n${bad.join("\n")}`);
  const unscreenable = cases.filter((c) => c.screen && !describeScreen(c.screen)).map((c) => c.say);
  if (unscreenable.length) throw new Error(`Cases with a screen Cosmo would never be told:\n${unscreenable.join("\n")}`);
  // The longest screen line any case adds, on top of the prompt, must still fit.
  const longest = Math.max(0, ...cases.map((c) => (describeScreen(c.screen) ?? "").length + 40));
  if (prompt.length + longest > VOICE_PROMPT_BUDGET) throw new Error(`Cosmo's prompt (${prompt.length}) plus a screen line is over budget`);
  console.log(`ok ${cases.length} cases name only real tools and screens; prompt ${prompt.length} of ${VOICE_PROMPT_BUDGET} chars`);
  if (process.argv.includes("--score")) await score(cases, prompt);
}

const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** What a live call would do with this case: the first orbit_tool call, or none. */
type Outcome = { tool: string | null; input: string; text?: string; error?: string };

/** Pass/fail for one case, and why. */
export function judge(c: Case, o: Outcome): { pass: boolean; why: string } {
  if (o.error) return { pass: false, why: `error: ${o.error}` };
  const e = c.expect;
  if (e.noTool) return o.tool ? { pass: false, why: `called ${o.tool}` } : { pass: true, why: "no tool" };
  // A case that only forbids tools ("delete everything") is passed by declining.
  if (!o.tool) return e.tools || e.inputIncludes ? { pass: false, why: "no tool" } : { pass: true, why: "declined" };
  if (e.notTools?.includes(o.tool)) return { pass: false, why: `called forbidden ${o.tool}` };
  if (e.tools && !e.tools.includes(o.tool)) return { pass: false, why: `called ${o.tool}, wanted ${e.tools.join("|")}` };
  if (e.inputIncludes && !o.input.toLowerCase().includes(e.inputIncludes.toLowerCase()))
    return { pass: false, why: `${o.tool} input lacks "${e.inputIncludes}"` };
  return { pass: true, why: o.tool };
}

async function score(cases: Case[], prompt: string) {
  const keysFrom = flag("--keys-from");
  const file: Record<string, string> = keysFrom ? (parseEnv(readFileSync(keysFrom, "utf8")) as Record<string, string>) : {};
  const key = process.env.ORBIT_EVAL_OPENAI_KEY?.trim() || file.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("--score needs ORBIT_EVAL_OPENAI_KEY, or --keys-from <env file> with OPENAI_API_KEY");
  const models = (flag("--models")?.split(",") ?? [...DEEPGRAM_THINK_MODELS]).map((m) => m.trim()).filter(Boolean);
  const runs = Math.max(1, Number(flag("--runs") ?? 1));
  const db = await getDb();
  const tool = {
    name: CRM_VOICE_TOOL.name,
    description: CRM_VOICE_TOOL.description,
    inputSchema: {
      tool: z.string().describe(CRM_VOICE_TOOL.parameters.properties.tool.description),
      input: z.string().describe(CRM_VOICE_TOOL.parameters.properties.input.description),
    },
  };
  const report: Record<string, { passed: number; total: number; ms: number; failures: string[] }> = {};
  for (const model of models) {
    await db
      .insert(userSettings)
      .values({ userId: USER, aiProvider: "openai", aiModel: model, openaiApiKeyEncrypted: encrypt(key) })
      .onConflictDoUpdate({ target: userSettings.userId, set: { aiProvider: "openai", aiModel: model, openaiApiKeyEncrypted: encrypt(key) } });
    const r = (report[model] = { passed: 0, total: 0, ms: 0, failures: [] as string[] });
    for (let run = 0; run < runs; run++) {
      // A few at a time: fast enough, and well under any rate limit.
      for (let i = 0; i < cases.length; i += 4) {
        await Promise.all(
          cases.slice(i, i + 4).map(async (c) => {
            const screen = describeScreen(c.screen);
            const started = Date.now();
            let outcome: Outcome;
            try {
              const driver = await createToolDriver({
                userId: USER,
                operation: "voice.eval",
                system: screen ? `${prompt}\nScreen when the call started: ${screen}` : prompt,
                user: c.say,
                tools: [tool],
                maxOutputTokens: 600,
              });
              let step = await driver.step(AbortSignal.timeout(60_000));
              // look_at_screen is a fine first move: answer it as a live call would (the case's own
              // screen) and score what the model does next.
              const first = step.calls[0];
              if (first && (first.args as { tool?: unknown })?.tool === LOOK_AT_SCREEN_TOOL && !c.expect.tools?.includes(LOOK_AT_SCREEN_TOOL)) {
                driver.addResults([{ call: first, content: JSON.stringify({ screen: screen ?? "The user is on a page Orbit can't describe." }) }]);
                step = await driver.step(AbortSignal.timeout(60_000));
              }
              const call = step.calls[0];
              const args = (call?.args ?? {}) as { tool?: unknown; input?: unknown };
              outcome = { tool: call ? String(args.tool ?? "") || null : null, input: typeof args.input === "string" ? args.input : JSON.stringify(args.input ?? ""), text: step.text };
            } catch (err) {
              outcome = { tool: null, input: "", error: err instanceof Error ? err.message.slice(0, 120) : String(err) };
            }
            r.ms += Date.now() - started;
            r.total++;
            const verdict = judge(c, outcome);
            if (process.argv.includes("--verbose"))
              console.log(`  ${verdict.pass ? "✓" : "✗"} ${c.say} → ${outcome.tool ?? "-"} ${outcome.input.slice(0, 120)} ${(outcome.text ?? "").slice(0, 200).replace(/\s+/g, " ")}`);
            if (verdict.pass) r.passed++;
            else r.failures.push(`${c.say} → ${verdict.why}`);
          }),
        );
      }
    }
    console.log(`${model.padEnd(14)} ${r.passed}/${r.total} (${Math.round((100 * r.passed) / r.total)}%)  avg ${Math.round(r.ms / r.total)} ms`);
    for (const f of [...new Set(r.failures)]) console.log(`    ✗ ${f}`);
  }
  mkdirSync("docs/ai-evals", { recursive: true });
  const out = `docs/ai-evals/${new Date().toISOString().slice(0, 10)}-voice.json`;
  writeFileSync(out, JSON.stringify({ runs, cases: cases.length, report }, null, 2));
  console.log(`report: ${out}`);
  await db.update(userSettings).set({ openaiApiKeyEncrypted: null }).where(eq(userSettings.userId, USER));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
