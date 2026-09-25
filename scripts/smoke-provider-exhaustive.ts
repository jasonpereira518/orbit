/**
 * Two guards for the provider comparisons `tsc` cannot see, because `AiProvider` widening
 * to include `"openrouter"` (schema 104) is a runtime fact the type checker never enforces
 * against a plain string comparison.
 *
 * Check 1 — exhaustiveness. Walks every file under `src/lib` with the TypeScript compiler
 * and finds every `BinaryExpression` whose operator is `===`/`!==` and whose right side is
 * the string literal `"gemini"`, `"openai"` or `"anthropic"`. A cascading `if`/ternary built
 * from exactly these three, with no `openrouter` arm, silently folds an OpenRouter account
 * into whichever branch happens to be the fallthrough default — that is exactly the shape
 * `admin-metrics.ts` had (an OpenRouter user's key presence read off `hasGemini`) before this
 * commit added the fourth arm. Every site found is required to be in `ALLOWLIST` below, each
 * entry carrying a one-line reason it needs no `openrouter` arm. A site that genuinely needs
 * one gets the arm instead of an allowlist entry — that is the point of this check.
 *
 * Check 2 — the routing-helper bypass. Task 3 adds `withOpenRouterRouting` and a comment in
 * `src/lib/ai.ts` claiming this smoke "asserts no OpenRouter `.create(` bypasses this". This
 * check makes that comment true: it finds every branch in `ai.ts` whose condition admits
 * `"openrouter"` (an equality check against that literal, or an `.includes("openrouter")`
 * membership test) and, inside it, every `.create(` call; each must pass its params through
 * `withOpenRouterRouting(...)`. Task 3 has not landed yet, so today there is no branch that
 * mentions `"openrouter"` in `ai.ts` at all — this check finds nothing and passes trivially.
 * It becomes load-bearing the moment Task 3 adds the first `if (provider === "openrouter")`.
 *
 * Deliberately the TypeScript compiler API, not a regex: this repo has a documented case of
 * a regex guard silently passing over commented-out code. `scripts/smoke-settings-layout.ts`
 * and `scripts/smoke-connect-gates.ts` are the worked examples of compiler-API parsing here;
 * this file follows their `parse` helper and `main`-guard so it stays import-safe.
 *
 * Run: npx tsx scripts/smoke-provider-exhaustive.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function walkDir(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walkDir(p);
    return p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}

/* --------------------------------------------------------- check 1: exhaustiveness --- */

const NARROWED_PROVIDERS = new Set(["gemini", "openai", "anthropic"]);

/**
 * The nearest named function/method containing `node`, for a readable report. Anonymous
 * callbacks (an inline `.map`/`.filter` argument, say) report as `<anonymous>`; nothing in
 * this codebase's provider-comparison sites is one, so that label is a signal something
 * unusual is going on, not a normal result.
 */
function enclosingFunctionName(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if ((ts.isGetAccessor(cur) || ts.isSetAccessor(cur)) && ts.isIdentifier(cur.name)) {
      return cur.name.text;
    }
    if (ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) {
      if (cur.name) return cur.name.text;
      const p = cur.parent;
      if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
      if (
        p &&
        ts.isPropertyAssignment(p) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
      ) {
        return p.name.getText().replace(/^["']|["']$/g, "");
      }
      return "<anonymous>";
    }
    cur = cur.parent;
  }
  return "<module>";
}

type ComparisonSite = { key: string; file: string; line: number; fn: string; value: string };

function findComparisons(file: string, sf: ts.SourceFile): ComparisonSite[] {
  const hits: ComparisonSite[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
      ts.isStringLiteral(node.right) &&
      NARROWED_PROVIDERS.has(node.right.text)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      hits.push({
        key: `${file}:${line + 1}`,
        file,
        line: line + 1,
        fn: enclosingFunctionName(node),
        value: node.right.text,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/**
 * Every site this check has already reviewed, with the reason it is exhaustive without an
 * `openrouter` arm. Re-seed by running this script, reading each `FAIL` line, and adding an
 * entry — or, if the site genuinely needs the fourth arm, adding the arm instead.
 */
const UNREACHABLE_OPENROUTER =
  "chooseCompletionKey/chooseEmbeddingKey (managed-ai-policy.ts) cannot yet return " +
  "\"openrouter\": no personal OpenRouter key can be saved (ai-key-check.ts's probe fails " +
  "closed) and Orbit holds no managed OpenRouter key (MANAGED_PROVIDER_ORDER excludes it, " +
  "facts.managed.openrouter is hardcoded false). This fallback is unreachable for openrouter " +
  "until a later task gives it a real branch — routed through withOpenRouterRouting.";

const ALLOWLIST: Record<string, string> = {
  "src/lib/ai-access.ts:587": "the branch is keyed on the completion provider being " +
    "\"anthropic\" (the one provider with no embeddings API at all), to pick the copy that " +
    "names OpenAI/Gemini as the fix; every other provider — openrouter included — falls " +
    "through to the same generic embedding-refusal copy.",
  "src/lib/ai-providers.ts:127": "one statement, `value === \"openai\" || value === " +
    "\"anthropic\" || value === \"gemini\" || value === \"openrouter\"` — the fourth arm is " +
    "the literal \"openrouter\" itself, which this checker does not flag because it isn't " +
    "one of the three narrowed literals; together the four are exhaustive over AiProvider.",
  "src/lib/ai-providers.ts:136": "modelBelongsToProvider has a fourth `if (provider === " +
    "\"openrouter\") return model.includes(\"/\")` right after this one; the four checks " +
    "together are exhaustive over AiProvider.",
  "src/lib/ai-providers.ts:137": "same function as line 136 — see that entry.",
  "src/lib/ai-providers.ts:140": "same function as line 136 — see that entry.",
  "src/lib/ai-tools.ts:120": UNREACHABLE_OPENROUTER + " (createToolDriver's anthropic arm.)",
  "src/lib/ai-tools.ts:169": UNREACHABLE_OPENROUTER + " (createToolDriver's openai arm; the " +
    "Gemini branch below both comparisons is the unreachable-for-openrouter fallback.)",
  "src/lib/admin-metrics.ts:328": "the \"openai\" arm of the four-way ternary that now also " +
    "checks \"anthropic\" and \"openrouter\" explicitly (this commit added the openrouter " +
    "arm and its query column), defaulting to gemini — exhaustive over AiProvider.",
  "src/lib/admin-metrics.ts:330": "the \"anthropic\" arm of the same ternary — see line 328.",
  "src/lib/ai.ts:552": UNREACHABLE_OPENROUTER + " (completeJson's gemini arm; the implicit " +
    "Anthropic fallback below the openai arm is what's unreachable for openrouter.)",
  "src/lib/ai.ts:571": UNREACHABLE_OPENROUTER + " (completeJson's openai arm.)",
  "src/lib/ai.ts:680": UNREACHABLE_OPENROUTER + " (completeMultimodalJsonInner's gemini arm.)",
  "src/lib/ai.ts:708": UNREACHABLE_OPENROUTER + " (completeMultimodalJsonInner's openai arm.)",
  "src/lib/ai.ts:878": "transcription() (ai-access.ts) only ever grants \"openai\" or " +
    "\"gemini\" — Anthropic has no speech-to-text and OpenRouter transcription isn't wired " +
    "up; the two are exhaustive for every grant transcribeAudioWithAI can receive today.",
  "src/lib/ai.ts:1592": UNREACHABLE_OPENROUTER + " (createEmbedding's model-selection line; " +
    "the implicit Gemini fallback is what's unreachable for openrouter.)",
  "src/lib/ai.ts:1605": UNREACHABLE_OPENROUTER + " (createEmbedding's openai branch.)",
  "src/lib/ai.ts:1645": UNREACHABLE_OPENROUTER + " (createEmbeddingsBatch's model-selection line.)",
  "src/lib/ai.ts:1658": UNREACHABLE_OPENROUTER + " (createEmbeddingsBatch's openai branch.)",
  "src/lib/ai.ts:2034": UNREACHABLE_OPENROUTER + " (streamText's gemini arm.)",
  "src/lib/ai.ts:2053": UNREACHABLE_OPENROUTER + " (streamText's openai arm; the implicit " +
    "Anthropic fallback further down is what's unreachable for openrouter.)",
  "src/lib/errors.ts:36": "aiProviderLabel has a fourth `provider === \"openrouter\" ? " +
    "\"OpenRouter\"` arm right after this one; the four checks together are exhaustive.",
  "src/lib/errors.ts:38": "same function as line 36 — see that entry.",
  "src/lib/managed-ai-policy.ts:309": "the \"anthropic\" half of `selected === \"anthropic\" " +
    "|| selected === \"openrouter\"` (this commit's fix) — the openrouter half is the " +
    "literal on the same line, which this checker does not flag; both fall to the plain " +
    "EMBEDDING_ORDER, per the comment above EMBEDDING_ORDER.",
  "src/lib/managed-ai-policy.ts:318": "managedOrder only ever chooses between \"openai\" and " +
    "\"gemini\": Orbit holds no managed OpenRouter key (facts.managed.openrouter is " +
    "hardcoded false and MANAGED_PROVIDER_ORDER excludes it), so no selected provider — " +
    "openrouter included — ever needs a third slot here.",
  "src/lib/admin-user-detail.ts:576": "the \"openai\" arm of the four-way ternary that now " +
    "also checks \"anthropic\" and \"openrouter\" explicitly (this commit added the " +
    "openrouter arm and its keys.openrouter column), defaulting to gemini.",
  "src/lib/admin-user-detail.ts:578": "the \"anthropic\" arm of the same ternary — see line 576.",
};

function checkExhaustiveness() {
  console.log("every gemini/openai/anthropic comparison under src/lib is reviewed");
  const files = walkDir("src/lib");
  const sites: ComparisonSite[] = [];
  for (const file of files) {
    sites.push(...findComparisons(file, parse(file)));
  }
  check("found comparisons to review (the check itself is not vacuous)", sites.length > 0, String(sites.length));
  for (const site of sites) {
    const reason = ALLOWLIST[site.key];
    check(
      `${site.key} (${site.fn}, === "${site.value}")`,
      Boolean(reason),
      reason ?? "not in ALLOWLIST — add the openrouter arm, or an allowlist reason"
    );
  }
  const stale = Object.keys(ALLOWLIST).filter((key) => !sites.some((s) => s.key === key));
  check("no allowlist entry outlives the site it excuses", stale.length === 0, stale.join(", "));
}

/* --------------------------------------------------------- check 2: routing bypass --- */

/** Does this condition expression admit `"openrouter"`? */
function admitsOpenRouter(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isStringLiteral(n.right) &&
      n.right.text === "openrouter"
    ) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "includes" &&
      n.arguments.some((a) => ts.isStringLiteral(a) && a.text === "openrouter")
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Every statement-bearing block reachable only when the guarding condition is true. */
function openRouterAdmittingBlocks(sf: ts.SourceFile): ts.Node[] {
  const blocks: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && admitsOpenRouter(node.expression)) {
      blocks.push(node.thenStatement);
    }
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === "openrouter") {
      for (const stmt of node.statements) blocks.push(stmt);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return blocks;
}

/** Does this `.create(` call's params argument already run through `withOpenRouterRouting`? */
function passesThroughRouting(call: ts.CallExpression): boolean {
  const arg = call.arguments[0];
  if (!arg) return false;
  let wrapped = false;
  const visit = (n: ts.Node) => {
    if (wrapped) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "withOpenRouterRouting") {
      wrapped = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(arg);
  return wrapped;
}

function createCallsIn(node: ts.Node, sf: ts.SourceFile): { line: number; fn: string; call: ts.CallExpression }[] {
  const hits: { line: number; fn: string; call: ts.CallExpression }[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "create"
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
      hits.push({ line: line + 1, fn: enclosingFunctionName(n), call: n });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hits;
}

function checkRoutingBypass() {
  console.log('\nevery ".create(" call an openrouter-admitting branch reaches passes through withOpenRouterRouting');
  const AI = "src/lib/ai.ts";
  const sf = parse(AI);
  const blocks = openRouterAdmittingBlocks(sf);
  check(
    "ai.ts has no openrouter-admitting branch yet (Task 3 has not landed) — this check has nothing to find",
    blocks.length === 0 || blocks.every((b) => createCallsIn(b, sf).every((c) => passesThroughRouting(c.call))),
    String(blocks.length)
  );
  if (blocks.length === 0) {
    check(
      "…and is written so a future branch is checked for real, not stubbed out",
      typeof openRouterAdmittingBlocks === "function" && typeof passesThroughRouting === "function"
    );
    return;
  }
  for (const block of blocks) {
    for (const { line, fn, call } of createCallsIn(block, sf)) {
      check(
        `${AI}:${line} (${fn}) routes its OpenRouter .create( through withOpenRouterRouting`,
        passesThroughRouting(call)
      );
    }
  }
}

function main() {
  checkExhaustiveness();
  checkRoutingBypass();
  if (failures > 0) {
    console.error(`\nsmoke-provider-exhaustive: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nsmoke-provider-exhaustive: all ok");
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
