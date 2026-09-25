/**
 * Two guards for the provider comparisons `tsc` cannot see, because `AiProvider` widening
 * to include `"openrouter"` (schema 104) is a runtime fact the type checker never enforces
 * against a plain string comparison.
 *
 * Check 1 — exhaustiveness. Walks every file under `src/lib` and `src/actions` with the
 * TypeScript compiler and finds every `BinaryExpression` whose operator is `===`/`!==` and
 * whose right side is the string literal `"gemini"`, `"openai"` or `"anthropic"`. A cascading
 * `if`/ternary built from exactly these three, with no `openrouter` arm, silently folds an
 * OpenRouter account into whichever branch happens to be the fallthrough default — that is
 * exactly the shape `admin-metrics.ts`, `admin-user-detail.ts`, `admin-roster.ts` and
 * `actions/settings.ts` all had (an OpenRouter user's key presence or "Key saved" state read
 * off `gemini`/`anthropic`) before this fix round. Every site found is required to be in
 * `ALLOWLIST` below, each entry carrying a one-line reason it needs no `openrouter` arm. A
 * site that genuinely needs one gets the arm instead of an allowlist entry — that is the
 * point of this check.
 *
 * Known blind spot: this check only sees TypeScript `BinaryExpression`s. `HAS_PROVIDER_KEY_SQL`
 * in `src/lib/admin-roster.ts` re-implements the same per-provider key-presence rule as a raw
 * SQL `CASE` string — `WHEN 'openai' THEN … WHEN 'anthropic' THEN …` — which this compiler-API
 * walk cannot parse and will never flag. It had exactly this bug (missing an `'openrouter'`
 * `WHEN`) until this fix round added it by hand; nothing here would catch a regression there,
 * which is why `scripts/smoke-admin-roster.ts` separately asserts that roster's SQL-derived
 * `hasProviderKey` agrees with `admin-metrics.ts`'s TS-derived one, row for row.
 *
 * Check 2 — the routing-helper bypass. Task 3 adds `withOpenRouterRouting` and a comment in
 * `src/lib/ai.ts` claiming this smoke "asserts no OpenRouter `.create(` bypasses this". This
 * check makes that comment true: it finds every branch in `ai.ts` whose condition ADMITS
 * OpenRouter and, inside it, every `.create(` call; each must pass its params through
 * `withOpenRouterRouting(...)`. "Admits OpenRouter" is deliberately not just a literal
 * equality check — Task 3's actual spec branches on a shape predicate
 * (`isOpenAiShaped(provider)`, `openAiShapedClient(...)`, `openrouterClient(...)`) with no
 * `"openrouter"` string anywhere in the condition, and an earlier version of this check that
 * only matched `=== "openrouter"` / `.includes("openrouter")` was proven to pass trivially
 * against that exact shape — see the fix-round report. So a condition also admits OpenRouter
 * when it calls anything whose name contains "openrouter" or "openaishaped" (case
 * insensitive), covering `isOpenAiShaped`, `openAiShapedClient`, `openrouterClient`, and
 * their kin, however Task 3 ends up naming them. Task 3 has not landed yet, so today there is
 * no branch of either shape in `ai.ts` — this check finds nothing and passes trivially. It
 * becomes load-bearing the moment Task 3 adds the first such branch, over `provider` OR
 * `backend` (embeddings), since the matcher is keyed on the condition's shape, not on which
 * variable name it tests.
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
  "no personal OpenRouter key can be SAVED yet for any real account — ai-key-check.ts's " +
  "probe fails closed — and Orbit holds no managed OpenRouter key either " +
  "(MANAGED_PROVIDER_ORDER excludes it, facts.managed.openrouter is hardcoded false), so " +
  "facts.personal.openrouter and facts.managed.openrouter are always false for every real " +
  "account today. chooseEmbeddingKey CAN return \"openrouter\" given fabricated facts " +
  "(smoke-ai-access.ts proves that on purpose), but never will for a real one — so this " +
  "fallback is unreachable in practice until a later task gives it a real branch, routed " +
  "through withOpenRouterRouting.";

const ALLOWLIST: Record<string, string> = {
  "src/lib/ai-access.ts:625": "the branch is keyed on the completion provider being " +
    "\"anthropic\" (the one provider with no embeddings API at all), to pick the copy that " +
    "names OpenAI/Gemini as the fix; every other provider — openrouter included — falls " +
    "through to the same generic embedding-refusal copy.",
  "src/lib/ai-access.ts:279": "isOpenAiShaped's own body: `provider === \"openai\" || " +
    "provider === \"openrouter\"` — the second half is the literal \"openrouter\" itself, " +
    "which this checker does not flag; together the two are exhaustive for what this " +
    "predicate means to answer.",
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
  // Task 3 widened every one of these OLD openai-literal arms to `isOpenAiShaped(...)`,
  // which already admits openrouter (see check 2's real per-call assertions on ai.ts:574,
  // 733, 905, 1610, 1660 and 2054) — so only the gemini arm of each cascade is still a bare
  // literal comparison left for check 1 to find, and each one's implicit fallback (openai
  // or openrouter now both routed away from it, leaving only anthropic reachable below) is
  // exhaustive without an explicit openrouter arm of its own.
  "src/lib/ai.ts:553": UNREACHABLE_OPENROUTER + " (completeJson's gemini arm; openai and " +
    "openrouter both now take the isOpenAiShaped branch above the implicit Anthropic " +
    "fallback, which is what's unreachable for openrouter.)",
  "src/lib/ai.ts:681": UNREACHABLE_OPENROUTER + " (completeMultimodalJsonInner's gemini arm; " +
    "see ai.ts:553.)",
  "src/lib/ai.ts:2033": UNREACHABLE_OPENROUTER + " (streamText's gemini arm; see ai.ts:553.)",
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
  "src/actions/settings.ts:109": "the \"gemini\" arm of the four-way `hasPersonalKey` " +
    "ternary that now also checks \"openai\" and \"anthropic\" explicitly, defaulting to " +
    "settings?.openrouterApiKeyEncrypted (this fix round's fix — it used to default to the " +
    "anthropic key for an openrouter row) — exhaustive over AiProvider.",
  "src/actions/settings.ts:111": "the \"openai\" arm of the same ternary — see line 109.",
  "src/actions/settings.ts:113": "the \"anthropic\" arm of the same ternary — see line 109; " +
    "this is the comparison that was added, moving openrouter off the anthropic default.",
  "src/actions/settings.ts:246": "one of four INDEPENDENT `provider === X && encrypted` " +
    "ternaries, one per key column of nextKeyState — each keys off its own literal with no " +
    "shared fallthrough default, so no cascade needs an openrouter arm; openrouterApiKeyEncrypted " +
    "has its own `provider === \"openrouter\"` line right below the three narrowed ones.",
  "src/actions/settings.ts:250": "same independent-ternary shape as line 246 — see that entry.",
  "src/actions/settings.ts:254": "same independent-ternary shape as line 246 — see that entry.",
  "src/actions/settings.ts:314": "clearApiKey's `patch` ternary — the final `else` arm is " +
    "the literal `{ openrouterApiKeyEncrypted: null }`, so the three narrowed comparisons " +
    "plus that default are exhaustive over AiProvider.",
  "src/actions/settings.ts:316": "same ternary as line 314 — see that entry.",
  "src/actions/settings.ts:318": "same ternary as line 314 — see that entry.",
};

function checkExhaustiveness() {
  console.log("every gemini/openai/anthropic comparison under src/lib and src/actions is reviewed");
  const files = [...walkDir("src/lib"), ...walkDir("src/actions")];
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

/** A call's callee name, however it was written (`foo(...)` or `ns.foo(...)`). */
function calleeName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return null;
}

/** Does a name look like it's testing for, or building a client for, OpenRouter? */
function looksOpenRouterShaped(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("openrouter") || lower.includes("openaishaped");
}

/**
 * Does this condition expression admit OpenRouter? Not just a literal `=== "openrouter"` or
 * `.includes("openrouter")` — Task 3's actual branch shape is a predicate call with no
 * `"openrouter"` string in the condition at all (`isOpenAiShaped(provider)`, say), so any
 * call whose name mentions "openrouter" or "openaishaped" counts too, whichever of those Task
 * 3 lands with.
 */
function admitsOpenRouter(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
      ts.isStringLiteral(n.right) &&
      n.right.text === "openrouter"
    ) {
      found = true;
      return;
    }
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name === "includes" && n.arguments.some((a) => ts.isStringLiteral(a) && a.text === "openrouter")) {
        found = true;
        return;
      }
      if (name && looksOpenRouterShaped(name)) {
        found = true;
        return;
      }
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

/**
 * A real assertion that the mechanism fires, run every time rather than only proven by hand
 * with a throwaway edit to `ai.ts` (see the Task-2 fix-round report for that manual proof
 * too). Parses two small in-memory stubs — never touches disk, never touches `ai.ts` — in
 * the exact shape Task 3 is specified to use: a predicate call (`isOpenAiShaped`) with no
 * `"openrouter"` string literal anywhere in the condition. One leaves its `.create(` params
 * unwrapped; the other wraps them in `withOpenRouterRouting`. If this ever regresses back to
 * literal-only matching, the first assertion here fails immediately.
 */
function selfTestMechanism() {
  const stub = (createArg: string) =>
    ts.createSourceFile(
      "self-test.ts",
      `function f(grant: { provider: string }) {
        if (isOpenAiShaped(grant.provider)) {
          const client = openAiShapedClient(grant);
          return client.chat.completions.create(${createArg});
        }
      }`,
      ts.ScriptTarget.Latest,
      true
    );
  const violates = (sf: ts.SourceFile) =>
    openRouterAdmittingBlocks(sf).some((b) =>
      createCallsIn(b, sf).some((c) => !passesThroughRouting(c.call))
    );
  const unwrapped = stub("{ model: params.model }");
  const wrapped = stub("withOpenRouterRouting({ model: params.model })");
  check(
    "the mechanism fires on an isOpenAiShaped(...)-shaped branch with no withOpenRouterRouting",
    violates(unwrapped)
  );
  check(
    "…and goes quiet once that same branch wraps its params in withOpenRouterRouting",
    !violates(wrapped)
  );
}

function checkRoutingBypass() {
  console.log('\nevery ".create(" call an openrouter-admitting branch reaches passes through withOpenRouterRouting');
  selfTestMechanism();
  const AI = "src/lib/ai.ts";
  const sf = parse(AI);
  const blocks = openRouterAdmittingBlocks(sf);
  if (blocks.length === 0) {
    check(
      "ai.ts has no openrouter-admitting branch yet (Task 3 has not landed) — nothing real to check here",
      true
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
