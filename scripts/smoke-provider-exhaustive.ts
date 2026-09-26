/**
 * Two guards for the provider comparisons `tsc` cannot see, because `AiProvider` widening
 * to include `"openrouter"` (schema 104) is a runtime fact the type checker never enforces
 * against a plain string comparison.
 *
 * Check 1 — exhaustiveness. Walks every file under `src/lib`, `src/actions`, `src/app` and
 * `src/components` with the
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
 * Known blind spot: this check only sees TypeScript `BinaryExpression`s. TWO files
 * re-implement the same per-provider key-presence rule as a raw SQL `CASE` string —
 * `WHEN 'openai' THEN … WHEN 'anthropic' THEN …` — which this compiler-API walk cannot parse
 * and will never flag:
 *   - `HAS_PROVIDER_KEY_SQL` in `src/lib/admin-roster.ts`. It had exactly this bug (missing
 *     an `'openrouter'` `WHEN`) until fix round 1 added it by hand; nothing here would catch
 *     a regression, which is why `scripts/smoke-admin-roster.ts` separately asserts that
 *     roster's SQL-derived `hasProviderKey` agrees with `admin-metrics.ts`'s TS-derived one,
 *     row for row.
 *   - `accountsMissingProviderKey` in `src/lib/admin-health.ts` (feeding `/admin/health`).
 *     Same shape, same bug, found in the whole-branch review and fixed in the final round:
 *     every OpenRouter account fell to the `ELSE gemini_api_key_encrypted IS NOT NULL` arm,
 *     so a healthy OpenRouter account was reported as missing its key and a broken one
 *     holding a stale Gemini key was reported as fine. `scripts/smoke-admin-health.ts`
 *     carries the mirror assertion for it, the same way smoke-admin-roster.ts does.
 * A third file re-implementing this rule in SQL needs its own paired assertion; this walk
 * will not tell you about it.
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
/**
 * NOT an "openrouter never happens" argument any more. It used to open with "no personal
 * OpenRouter key can be SAVED yet — ai-key-check.ts's probe fails closed", which Task 5
 * falsified the moment it replaced that stub with a real probe and wired the OAuth callback
 * to `applyAiKeyChange`. The conclusion survives on the other half of each entry's own
 * parenthetical, which is what this now says: openrouter is admitted by an
 * `isOpenAiShaped(...)` branch ABOVE this arm, so control never reaches here carrying it.
 */
const OPENROUTER_ROUTED_AWAY =
  "openrouter never reaches this arm: an isOpenAiShaped(...) branch above it admits both " +
  "openai and openrouter and returns, so the only providers left to fall through here are " +
  "the ones named in this cascade. The per-call assertions in check 2 below are what keep " +
  "that earlier branch honest (every .create( it reaches goes through withOpenRouterRouting).";

const ALLOWLIST: Record<string, string> = {
  "src/lib/ai-access.ts:666": "the branch is keyed on the completion provider being " +
    "\"anthropic\" (the one provider with no embeddings API at all), to pick the copy that " +
    "names OpenAI/Gemini as the fix; every other provider — openrouter included — falls " +
    "through to the same generic embedding-refusal copy.",
  "src/lib/ai-access.ts:295": "isOpenAiShaped's own body: `provider === \"openai\" || " +
    "provider === \"openrouter\"` — the second half is the literal \"openrouter\" itself, " +
    "which this checker does not flag; together the two are exhaustive for what this " +
    "predicate means to answer.",
  "src/lib/ai-providers.ts:212": "one statement, `value === \"openai\" || value === " +
    "\"anthropic\" || value === \"gemini\" || value === \"openrouter\"` — the fourth arm is " +
    "the literal \"openrouter\" itself, which this checker does not flag because it isn't " +
    "one of the three narrowed literals; together the four are exhaustive over AiProvider.",
  "src/lib/ai-providers.ts:221": "modelBelongsToProvider has a fourth `if (provider === " +
    "\"openrouter\") return model.includes(\"/\")` right after this one; the four checks " +
    "together are exhaustive over AiProvider.",
  "src/lib/ai-providers.ts:222": "same function as line 221 — see that entry.",
  "src/lib/ai-providers.ts:225": "same function as line 221 — see that entry.",
  // Fix round 1: the old openai-literal arm here fell through to the Gemini branch for an
  // openrouter grant, throwing `No gemini grant` — fails closed, but breaks every chat
  // tool call for an OpenRouter user. Widened to isOpenAiShaped, same shape as ai.ts, so
  // only the anthropic arm's own literal is left for check 1 to find.
  "src/lib/ai-tools.ts:124": OPENROUTER_ROUTED_AWAY + " (createToolDriver's anthropic arm; " +
    "openai and openrouter both now take the isOpenAiShaped branch below, leaving only " +
    "Gemini as this arm's fallthrough.)",
  "src/lib/admin-metrics.ts:328": "the \"openai\" arm of the four-way ternary that now also " +
    "checks \"anthropic\" and \"openrouter\" explicitly (this commit added the openrouter " +
    "arm and its query column), defaulting to gemini — exhaustive over AiProvider.",
  "src/lib/admin-metrics.ts:330": "the \"anthropic\" arm of the same ternary — see line 328.",
  // Task 3 widened the completion arms of these cascades — completeJson,
  // completeMultimodalJsonInner and streamText, but NOT transcribeAudioWithAI, reverted in
  // fix round 1 (see its own entry below) — to `isOpenAiShaped(...)`, which already admits
  // openrouter (see check 2's real per-call assertions on ai.ts:584, 743, 1696, 1746 and
  // 2140) — so only the gemini arm of each of these three cascades is still a bare literal
  // comparison left for check 1 to find, and each one's implicit fallback (openai or
  // openrouter now both routed away from it, leaving only anthropic reachable below) is
  // exhaustive without an explicit openrouter arm of its own.
  "src/lib/ai.ts:563": OPENROUTER_ROUTED_AWAY + " (completeJson's gemini arm; openai and " +
    "openrouter both now take the isOpenAiShaped branch above the implicit Anthropic " +
    "fallback, which is what's unreachable for openrouter.)",
  "src/lib/ai.ts:691": OPENROUTER_ROUTED_AWAY + " (completeMultimodalJsonInner's gemini arm; " +
    "see ai.ts:563.)",
  // Fix round 1 reverted transcribeAudioWithAI's isOpenAiShaped widening: the SDK encodes
  // this call's params as multipart form data, where withOpenRouterRouting's nested
  // `provider: {...}` would serialise as "[object Object]" rather than a real field, and
  // "whisper-1" is not a valid OpenRouter model slug regardless — so this is back to a
  // bare openai literal, and openrouter is never granted here (access.transcription()
  // only ever returns openai/gemini), same reasoning as the original Task 2 allowlisting.
  "src/lib/ai.ts:965": "transcription() (ai-access.ts) only ever grants \"openai\" or " +
    "\"gemini\" — Anthropic has no speech-to-text and OpenRouter transcription is " +
    "deliberately not wired up (multipart body, no valid model slug); the two are " +
    "exhaustive for every grant transcribeAudioWithAI can receive today.",
  "src/lib/ai.ts:2126": OPENROUTER_ROUTED_AWAY + " (streamText's gemini arm; see ai.ts:563.)",
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
  "src/lib/ai-settings-write.ts:97": "one of four INDEPENDENT `provider === X && encrypted` " +
    "ternaries, one per key column of nextKeyState — each keys off its own literal with no " +
    "shared fallthrough default, so no cascade needs an openrouter arm; openrouterApiKeyEncrypted " +
    "has its own `provider === \"openrouter\"` line right below the three narrowed ones. " +
    "(applyAiKeyChange, moved here from src/actions/settings.ts by Task 5's fix round 1 — " +
    "that file is \"use server\", which made the function a directly-POST-able Server " +
    "Action despite taking a caller-supplied userId.)",
  "src/lib/ai-settings-write.ts:101": "same independent-ternary shape as line 97 — see that entry.",
  "src/lib/ai-settings-write.ts:105": "same independent-ternary shape as line 97 — see that entry.",
  "src/actions/settings.ts:223": "clearApiKey's `patch` ternary — the final `else` arm is " +
    "the literal `{ openrouterApiKeyEncrypted: null }`, so the three narrowed comparisons " +
    "plus that default are exhaustive over AiProvider. (Line shifted again by Task 5's fix " +
    "round 1, which moved applyAiKeyChange and its helpers out of this file entirely — " +
    "was line 339, originally line 314.)",
  "src/actions/settings.ts:225": "same ternary as line 223 — see that entry.",
  "src/actions/settings.ts:227": "same ternary as line 223 — see that entry.",
  // Surfaced by this fix round widening the walk to src/app and src/components — which is
  // where finding 1's shipped-OpenRouter-picker bug was hiding.
  "src/components/settings/ai-settings.tsx:225": "the standalone \"Anthropic has no " +
    "embeddings API\" notice, keyed on the one provider that genuinely has none. It is not a " +
    "cascade and has no fallthrough default: every other provider, openrouter included, " +
    "simply renders no notice — correctly, since EMBEDDING_MODELS.openrouter is a real " +
    "embedding route (openai/text-embedding-3-small).",
};

function checkExhaustiveness() {
  console.log(
    "every gemini/openai/anthropic comparison under src/lib, src/actions, src/app and src/components is reviewed"
  );
  // src/app and src/components are NOT decoration: the OAuth callback lives in src/app, and
  // the provider cascade in src/components/settings/ai-settings.tsx sat outside both walks
  // while it shipped a selectable OpenRouter option to Settings and to onboarding.
  const files = [
    ...walkDir("src/lib"),
    ...walkDir("src/actions"),
    ...walkDir("src/app"),
    ...walkDir("src/components"),
  ];
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

/** `!<expr>` at the top level of a condition — the early-return guard's shape. */
function negatedOperand(expr: ts.Expression): ts.Expression | null {
  const e = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    return e.operand;
  }
  return null;
}

/** Does this branch always leave — so everything after the `if` is the other path? */
function alwaysExits(stmt: ts.Statement): boolean {
  const last = ts.isBlock(stmt) ? stmt.statements[stmt.statements.length - 1] : stmt;
  return (
    !!last &&
    (ts.isReturnStatement(last) ||
      ts.isThrowStatement(last) ||
      ts.isBreakStatement(last) ||
      ts.isContinueStatement(last))
  );
}

/** The statement list a statement belongs to, if it sits directly in one. */
function siblingStatements(node: ts.Statement): ts.NodeArray<ts.Statement> | null {
  const parent = node.parent;
  if (!parent) return null;
  if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
    return parent.statements;
  }
  return null;
}

/**
 * Every statement-bearing block reachable only when the guarding condition is true.
 *
 * Two shapes, plus a `case "openrouter":` clause:
 *   1. `if (isOpenAiShaped(p)) { … }` — the then-branch is the admitting one.
 *   2. `if (!isOpenAiShaped(p)) return;` followed by unguarded code — the NEGATED early
 *      return, where the admitting block is everything AFTER the `if`. This was a deferred
 *      gap: pushing only `node.thenStatement` made an unwrapped `.create(` below such a
 *      guard completely invisible to check 2. The then-branch of a negated guard is the
 *      path that EXCLUDES openrouter, so it is deliberately not pushed.
 * The bare-ternary shape (`isOpenAiShaped(p) ? client.create(…) : …`) stays deferred: it
 * carries no statement block, and nothing in this codebase writes a `.create(` that way.
 */
function openRouterAdmittingBlocks(sf: ts.SourceFile): ts.Node[] {
  const blocks: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node)) {
      const negated = negatedOperand(node.expression);
      if (negated && admitsOpenRouter(negated)) {
        // Shape 2. Only when the guard actually leaves — otherwise control rejoins and the
        // statements below are not exclusive to the admitting path.
        if (!node.elseStatement && alwaysExits(node.thenStatement)) {
          const siblings = siblingStatements(node);
          if (siblings) {
            const idx = siblings.indexOf(node);
            if (idx >= 0) for (const stmt of siblings.slice(idx + 1)) blocks.push(stmt);
          }
        }
      } else if (admitsOpenRouter(node.expression)) {
        blocks.push(node.thenStatement);
      }
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
      `async function f(grant: { provider: string }) {
        if (isOpenAiShaped(grant.provider)) {
          const client = await openAiShapedClient(grant);
          return await client.chat.completions.create(${createArg});
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

  // The negated early-return shape, previously invisible: same call, same absence of
  // routing, written as a guard clause instead of a positive branch.
  const guardStub = (createArg: string) =>
    ts.createSourceFile(
      "self-test-guard.ts",
      `async function f(grant: { provider: string }) {
        if (!isOpenAiShaped(grant.provider)) return null;
        const client = await openAiShapedClient(grant);
        return await client.chat.completions.create(${createArg});
      }`,
      ts.ScriptTarget.Latest,
      true
    );
  check(
    "the mechanism fires on a NEGATED early-return guard with no withOpenRouterRouting",
    violates(guardStub("{ model: params.model }"))
  );
  check(
    "…and goes quiet once that guarded call wraps its params in withOpenRouterRouting",
    !violates(guardStub("withOpenRouterRouting({ model: params.model })"))
  );
  // The then-branch of a negated guard is the path openrouter is excluded FROM; flagging a
  // `.create(` there would be a false positive that invites a bogus allowlist entry.
  const excludedBranch = ts.createSourceFile(
    "self-test-excluded.ts",
    `async function f(grant: { provider: string }) {
      if (!isOpenAiShaped(grant.provider)) {
        const client = await anthropicClient(grant);
        return await client.messages.create({ model: params.model });
      }
      return null;
    }`,
    ts.ScriptTarget.Latest,
    true
  );
  check(
    "…and does NOT fire on the excluded branch of that same guard",
    !violates(excludedBranch)
  );
}

/**
 * Every file under `src/lib`, `src/actions`, `src/app` and `src/components` that can build an
 * OpenRouter client — anything referencing `openAiShapedClient` or `openrouterClient` (the
 * only two ways to get one; see `ai-access.ts`). Discovered rather than a fixed list, so a
 * new file that starts building one is covered automatically instead of depending on someone
 * remembering to add it here.
 * Fix round 2: `checkRoutingBypass` used to hardcode `src/lib/ai.ts` only, so the exact
 * same bug in `ai-tools.ts` (fix round 1) landed with no per-call check at all — the guard
 * wasn't failing, it was never looking.
 * Final round: the comment above claimed a new file "is covered automatically" while the
 * walk read `src/lib` alone — so a route handler or server action building one was exactly
 * the file it would miss. Now it walks the same four roots check 1 does.
 */
function filesBuildingOpenRouterClients(): string[] {
  return [
    ...walkDir("src/lib"),
    ...walkDir("src/actions"),
    ...walkDir("src/app"),
    ...walkDir("src/components"),
  ].filter((file) => /\bopenAiShapedClient\b|\bopenrouterClient\b/.test(readFileSync(file, "utf8")));
}

function checkRoutingBypass() {
  console.log('\nevery ".create(" call an openrouter-admitting branch reaches passes through withOpenRouterRouting');
  selfTestMechanism();
  const files = filesBuildingOpenRouterClients();
  check(
    "found at least one file that can build an OpenRouter client (the check itself is not vacuous)",
    files.length > 0,
    files.join(", ")
  );
  let anyBlocks = false;
  for (const file of files) {
    const sf = parse(file);
    const blocks = openRouterAdmittingBlocks(sf);
    if (blocks.length === 0) continue;
    anyBlocks = true;
    for (const block of blocks) {
      for (const { line, fn, call } of createCallsIn(block, sf)) {
        check(
          `${file}:${line} (${fn}) routes its OpenRouter .create( through withOpenRouterRouting`,
          passesThroughRouting(call)
        );
      }
    }
  }
  if (!anyBlocks) {
    check(
      "no openrouter-admitting branch yet in any client-building file (Task 3 has not landed) — nothing real to check here",
      true
    );
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
