/**
 * The gate for the extension's work-history capture: the real model over real
 * LinkedIn page text, scored for the one failure that matters most — naming an
 * employer or school the page never mentions.
 *
 *   npx tsx scripts/eval-extension-profile.ts --dry-run   # check fixtures, no cost
 *   ORBIT_EVAL_GEMINI_KEY=… npx tsx scripts/eval-extension-profile.ts
 *   ORBIT_EVAL_ANTHROPIC_KEY=… npx tsx scripts/eval-extension-profile.ts --provider anthropic
 *
 * Fixtures live in scripts/eval-fixtures/extension-profile/ (see its README) and
 * are gitignored except the synthetic example: they are other people's data.
 *
 * Scored on the model's RAW entries, before `groundEntries` drops anything the
 * page doesn't name. The filter makes production safe either way; this measures
 * whether the prompt needs it, which is what tells us the model is reading the
 * page rather than recalling the person.
 *
 * Passes when ≥5 real (non-synthetic) fixtures ran, zero raw inventions, and
 * ≥90% recall of every `expect` list given. Exits 1 otherwise.
 *
 * Keys: only `ORBIT_EVAL_{GEMINI,OPENAI,ANTHROPIC}_KEY`, stored as a synthetic
 * user's own key — the same bring-your-own-key path as eval-ai.ts. PGlite only.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { completeJson } from "../src/lib/ai";
import { DEFAULT_MODELS, resolveAiProvider } from "../src/lib/ai-providers";
import { untrustedPageBlock } from "../src/lib/conversation-starters";
import { encrypt } from "../src/lib/crypto";
import type { PageContext, ProfileSection } from "../src/lib/extension/contract";
import { profileCaptureRequestSchema } from "../src/lib/extension/contract.schema";
import { groundEntries, readWorkHistory, shortenedOnPage } from "../src/lib/extension/profile-capture";

if (process.env.DATABASE_URL) {
  throw new Error("eval-extension-profile runs on a throwaway local PGlite only — unset DATABASE_URL.");
}
process.env.ORBIT_DEMO_MANAGED_AI = "off";
process.env.ORBIT_AI_RESULT_CACHE = "off";

const USER = "eval-extension-profile-user";
const DIR = join("scripts", "eval-fixtures", "extension-profile");
const MIN_REAL_FIXTURES = 5;
const MIN_RECALL = 0.9;

type Fixture = {
  file: string;
  synthetic: boolean;
  url: string;
  name: string | null;
  section?: ProfileSection;
  text: string;
  expect?: { employers?: string[]; schools?: string[] };
};

function sectionOf(hint: string): ProfileSection | undefined {
  if (/details[/-]experience/i.test(hint)) return "experience";
  if (/details[/-]education/i.test(hint)) return "education";
  return undefined;
}

function loadFixtures(): Fixture[] {
  let files: string[] = [];
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith(".json") || f.endsWith(".txt")).sort();
  } catch {
    return [];
  }
  return files.map((file) => {
    const raw = readFileSync(join(DIR, file), "utf8");
    const synthetic = file.endsWith(".synthetic.json");
    if (file.endsWith(".txt")) {
      return { file, synthetic, url: "https://www.linkedin.com/in/eval-fixture/", name: null, section: sectionOf(file), text: raw };
    }
    const json = JSON.parse(raw) as Omit<Fixture, "file" | "synthetic" | "section">;
    return { file, synthetic, ...json, name: json.name ?? null, section: sectionOf(json.url) };
  });
}

/** Through the real request schema, so truncation is exactly production's. */
function pageFor(fixture: Fixture): PageContext {
  const page: PageContext = {
    schemaVersion: 1,
    site: "linkedin",
    adapterVersion: "eval",
    kind: "person",
    url: fixture.url,
    sourceUrl: fixture.url,
    capturedAt: new Date().toISOString(),
    identity: {
      name: fixture.name ? { value: fixture.name, source: "eval", confidence: "high" } : null,
      headline: null, title: null, company: null, location: null,
      school: null, email: null, handle: null, profileUrl: null, photoUrl: null,
    },
    ...(fixture.section ? { section: fixture.section } : {}),
    text: { blob: fixture.text, truncated: false, charCount: fixture.text.length, fromSelection: false },
    warnings: [],
  };
  return profileCaptureRequestSchema.parse({ contactId: "00000000-0000-4000-8000-000000000000", page }).page;
}

function evalKey(provider: string): string | null {
  return process.env[`ORBIT_EVAL_${provider.toUpperCase()}_KEY`]?.trim() || null;
}

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

run(async () => {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const provider = resolveAiProvider(flag("--provider") ?? "gemini");
  const model = flag("--model") ?? DEFAULT_MODELS[provider];

  const fixtures = loadFixtures();
  if (!fixtures.length) throw new Error(`No fixtures in ${DIR} — see its README.`);

  // --dry-run: are the fixtures the shape this expects? No key, no model, no
  // cost — and it prints nothing from inside a page, so the output is safe to
  // paste anywhere.
  if (argv.includes("--dry-run")) {
    const real = fixtures.filter((f) => !f.synthetic);
    for (const fixture of fixtures) {
      const page = pageFor(fixture);
      const wanted = [...(fixture.expect?.employers ?? []), ...(fixture.expect?.schools ?? [])];
      console.log(
        `  ${fixture.file}${fixture.synthetic ? " (synthetic — doesn't count)" : ""}\n` +
          `    ${page.text.blob.length.toLocaleString()} chars${page.text.truncated ? " (cut at the cap)" : ""}` +
          ` · section: ${page.section ?? "profile"}` +
          ` · name: ${fixture.name ? "given" : "missing"}` +
          ` · ground truth: ${wanted.length ? `${wanted.length} names` : "none"}` +
          `${/show all \d+ experiences?/i.test(page.text.blob) ? " · lists only some roles" : ""}`
      );
    }
    const sections = new Set(fixtures.filter((f) => !f.synthetic).map((f) => sectionOf(f.url) ?? "profile"));
    console.log(
      `\n  ${real.length} real fixture(s) of ${MIN_REAL_FIXTURES} needed` +
        `\n  sections covered: ${[...sections].join(", ") || "none"}` +
        `\n  with ground truth: ${real.filter((f) => (f.expect?.employers?.length ?? 0) + (f.expect?.schools?.length ?? 0) > 0).length}` +
        `\n\n  ${real.length >= MIN_REAL_FIXTURES ? "Ready. Run it for real with ORBIT_EVAL_<PROVIDER>_KEY set." : "Add more fixtures with scripts/save-profile-fixture.ts."}`
    );
    process.exit(0);
  }

  const key = evalKey(provider);
  if (!key) throw new Error(`Set ORBIT_EVAL_${provider.toUpperCase()}_KEY to run the work-history eval.`);

  const db = await getDb();
  const settings = {
    aiProvider: provider,
    aiModel: model,
    [`${provider}ApiKeyEncrypted`]: encrypt(key),
  } as Partial<typeof userSettings.$inferInsert>;
  await db
    .insert(userSettings)
    .values({ userId: USER, ...settings })
    .onConflictDoUpdate({ target: userSettings.userId, set: settings });

  const complete = (request: { system: string; user: string }) =>
    completeJson(USER, { ...request, operation: "extension.profile", temperature: 0.1, maxOutputTokens: 8192 });

  console.log(`eval-extension-profile: ${provider} / ${model}, ${fixtures.length} fixture(s)\n`);
  let inventions = 0;
  let expected = 0;
  let found = 0;
  let realRan = 0;
  let errors = 0;

  for (const fixture of fixtures) {
    const page = pageFor(fixture);
    const started = Date.now();
    const read = await readWorkHistory(complete, {
      name: fixture.name,
      pageBlock: untrustedPageBlock(page),
      pageText: page.text.blob,
    });
    const ms = Date.now() - started;
    const tag = `${fixture.file}${fixture.synthetic ? " (synthetic)" : ""}${page.section ? ` [${page.section}]` : ""}`;
    if (!read.ok) {
      errors++;
      console.log(`  FAIL ${tag} — model error`);
      continue;
    }
    if (!fixture.synthetic) realRan++;

    // Raw inventions: what the grounding filter would have had to catch.
    const { dropped } = groundEntries(read.raw, page.text.blob);
    inventions += dropped;
    const invented = read.raw.filter((e) => groundEntries([e], page.text.blob).dropped > 0).map((e) => e.organization);

    const orgs = new Set(read.answer.experiences.map((e) => norm(e.organization ?? "")));
    const wanted = [...(fixture.expect?.employers ?? []), ...(fixture.expect?.schools ?? [])];
    const missed = wanted.filter((w) => ![...orgs].some((o) => o.includes(norm(w)) || norm(w).includes(o)));
    expected += wanted.length;
    found += wanted.length - missed.length;

    const roles = read.answer.experiences.filter((e) => e.kind === "role").length;
    const schools = read.answer.experiences.length - roles;
    const shortOnPage = shortenedOnPage(page.text.blob);
    console.log(
      `  ${dropped === 0 && missed.length === 0 ? "ok  " : "FAIL"} ${tag} — ${roles} role(s), ${schools} school(s), ${ms}ms` +
        `${page.text.truncated ? ", text cut at the cap" : ""}` +
        `${shortOnPage.experience || read.answer.shortened.experience ? ", shortened list" : ""}`
    );
    if (invented.length) console.log(`         invented: ${invented.join(", ")}`);
    if (missed.length) console.log(`         missed: ${missed.join(", ")}`);
    if (!fixture.expect) {
      for (const e of read.answer.experiences) {
        console.log(`         · ${e.kind === "role" ? e.title ?? "(no title)" : e.fieldOfStudy ?? "(school)"} — ${e.organization}`);
      }
    }
  }

  const recall = expected ? found / expected : 1;
  console.log(
    `\n  real fixtures: ${realRan} (need ${MIN_REAL_FIXTURES})` +
      `\n  raw inventions: ${inventions} (need 0)` +
      `\n  recall: ${expected ? `${(recall * 100).toFixed(0)}% of ${expected}` : "no expectations given"} (need ${MIN_RECALL * 100}%)` +
      `\n  model errors: ${errors}`
  );
  const pass = realRan >= MIN_REAL_FIXTURES && inventions === 0 && recall >= MIN_RECALL && errors === 0;
  console.log(`\neval-extension-profile: ${pass ? "PASS" : "NOT PASSING"}`);
  process.exit(pass ? 0 : 1);
});
