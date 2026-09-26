/**
 * A `router.refresh()` right after an awaited Server Action that revalidates is a second
 * render of the same page.
 *
 * When an action calls `revalidatePath`, `updateTag` or `refresh()`, Next re-renders the
 * CURRENT route and ships that payload in the action's own response ("The mutation, the
 * cache invalidation, and the page re-render all complete in a single roundtrip":
 * `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`). A client that then calls
 * `router.refresh()` asks the server to render the whole tree again, layouts included, and
 * resets whatever the refreshed page re-derives from props (a paged list back to page one).
 *
 * This parses the code (TypeScript compiler, not grep: a commented-out refresh must neither
 * trip nor satisfy it). First it finds every function under `src/actions/` and `src/lib/` that
 * revalidates, directly or through a helper it calls. Then, in every client module, it looks
 * at each `router.refresh()` and walks back through the statements before it in the same
 * block to the nearest `await`. If that await calls a revalidating Server Action, the refresh
 * is redundant and this fails.
 *
 * Kept deliberately narrow: only the adjacent-await shape is judged. A refresh after a
 * `fetch` to a route handler, after a non-revalidating action, or on a timer is left alone:
 * those are real refreshes.
 *
 * `--report` lists every refresh it judged, redundant or not.
 * Run: npx tsx scripts/smoke-redundant-refresh.ts [--report]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const REVALIDATORS = new Set(["revalidatePath", "revalidateTag", "updateTag", "refresh"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk("src");
const sources = new Map<string, ts.SourceFile>();
for (const f of files) {
  sources.set(f, ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
}

/** "@/lib/x" or "./x" → the file it names, when it is one of ours. */
function resolveModule(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join("src", spec.slice(2));
  else if (spec.startsWith(".")) base = relative(process.cwd(), resolve(join(from, ".."), spec));
  else return null;
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (sources.has(cand)) return cand;
  return null;
}

type Fn = { file: string; name: string; body: ts.Node };
/** file → local name → the function (declaration, or const arrow/function expression). */
const functions = new Map<string, Map<string, Fn>>();
/** file → local imported name → [module file, exported name]. */
const imports = new Map<string, Map<string, [string, string]>>();
/** file → local names that are the Next revalidation functions. */
const nextCacheNames = new Map<string, Set<string>>();

for (const [file, sf] of sources) {
  const fns = new Map<string, Fn>();
  const imps = new Map<string, [string, string]>();
  const nextNames = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const bindings = st.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (spec === "next/cache" && REVALIDATORS.has(imported)) nextNames.add(el.name.text);
          const target = resolveModule(file, spec);
          if (target) imps.set(el.name.text, [target, imported]);
        }
      }
    }
    if (ts.isFunctionDeclaration(st) && st.name && st.body) fns.set(st.name.text, { file, name: st.name.text, body: st.body });
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          fns.set(d.name.text, { file, name: d.name.text, body: d.initializer.body });
        }
      }
    }
  }
  functions.set(file, fns);
  imports.set(file, imps);
  nextCacheNames.set(file, nextNames);
}

/**
 * Whether calling `name` in `file` revalidates on its ordinary path, directly or through
 * a helper it calls. "Ordinary" means the call is not inside an `if`, a loop, a `catch` or
 * a callback: a statement of the body itself (a `try` block counts, a `finally` too), or an
 * `await`ed call in one. An action that revalidates only in some branch is NOT counted, so
 * a refresh after it is never judged redundant on the strength of a path that may not run.
 */
const memo = new Map<string, boolean>();
function revalidates(file: string, name: string, stack = new Set<string>()): boolean {
  const key = `${file}#${name}`;
  if (memo.has(key)) return memo.get(key)!;
  if (stack.has(key)) return false;
  stack.add(key);
  let result = false;
  const imp = imports.get(file)?.get(name);
  if (nextCacheNames.get(file)?.has(name)) result = true;
  else if (imp) result = revalidates(imp[0], imp[1], stack);
  else {
    const fn = functions.get(file)?.get(name);
    if (fn) result = unconditionallyCalls(fn.body, (callee) => revalidates(file, callee, stack));
  }
  memo.set(key, result);
  return result;
}

/** True when a statement on the body's ordinary path calls something `pred` accepts. */
function unconditionallyCalls(body: ts.Node, pred: (callee: string) => boolean): boolean {
  const statements: readonly ts.Statement[] = ts.isBlock(body) ? body.statements : [ts.factory.createExpressionStatement(body as ts.Expression)];
  for (const st of statements) {
    if (ts.isTryStatement(st)) {
      if (unconditionallyCalls(st.tryBlock, pred)) return true;
      if (st.finallyBlock && unconditionallyCalls(st.finallyBlock, pred)) return true;
      continue;
    }
    if (ts.isIfStatement(st) || ts.isIterationStatement(st, false) || ts.isSwitchStatement(st)) continue;
    let hit = false;
    const visit = (n: ts.Node): void => {
      if (hit || ts.isFunctionLike(n) || ts.isConditionalExpression(n)) return;
      if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
        visit(n.left);
        return;
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && pred(n.expression.text)) hit = true;
      else ts.forEachChild(n, visit);
    };
    visit(st);
    if (hit) return true;
    // A bare `return` before any revalidation ends the ordinary path.
    if (ts.isReturnStatement(st)) return false;
  }
  return false;
}

function isServerActionModule(file: string) {
  const sf = sources.get(file)!;
  const first = sf.statements[0];
  return Boolean(first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use server");
}

function isRouterRefresh(st: ts.Statement): boolean {
  if (!ts.isExpressionStatement(st)) return false;
  const e = st.expression;
  return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "refresh" && ts.isIdentifier(e.expression.expression) && /router/i.test(e.expression.expression.text);
}

/** The awaited call in a statement (`await f()`, `const x = await f()`), if any. */
function awaitedCall(st: ts.Statement): ts.CallExpression | null {
  let expr: ts.Expression | undefined;
  if (ts.isExpressionStatement(st)) expr = st.expression;
  else if (ts.isVariableStatement(st)) expr = st.declarationList.declarations[0]?.initializer;
  if (expr && ts.isAwaitExpression(expr) && ts.isCallExpression(expr.expression)) return expr.expression;
  return null;
}

function containsAwait(n: ts.Node): boolean {
  let found = false;
  const visit = (c: ts.Node) => {
    if (found || ts.isFunctionLike(c)) return;
    if (ts.isAwaitExpression(c)) found = true;
    else ts.forEachChild(c, visit);
  };
  visit(n);
  return found;
}

type Finding = { file: string; line: number; action: string | null; redundant: boolean };
const findings: Finding[] = [];

for (const [file, sf] of sources) {
  if (file.startsWith("src/actions/")) continue;
  const visit = (n: ts.Node) => {
    if (ts.isBlock(n) || ts.isSourceFile(n)) {
      const stmts = n.statements;
      stmts.forEach((st, i) => {
        if (!isRouterRefresh(st)) return;
        let action: string | null = null;
        let redundant = false;
        for (let j = i - 1; j >= 0; j--) {
          const call = awaitedCall(stmts[j]!);
          if (call) {
            if (ts.isIdentifier(call.expression)) {
              const imp = imports.get(file)?.get(call.expression.text);
              action = call.expression.text;
              redundant = Boolean(imp && isServerActionModule(imp[0]) && revalidates(imp[0], imp[1]));
            }
            break;
          }
          // Any other await in between means something else happened; stop judging.
          if (containsAwait(stmts[j]!)) break;
        }
        findings.push({ file, line: sf.getLineAndCharacterOfPosition(st.getStart()).line + 1, action, redundant });
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

const redundant = findings.filter((f) => f.redundant);
if (process.argv.includes("--report")) {
  for (const f of findings) console.log(`${f.redundant ? "REDUNDANT" : "ok       "} ${f.file}:${f.line}${f.action ? `  after await ${f.action}()` : ""}`);
  console.log(`\n${findings.length} refreshes judged, ${redundant.length} redundant`);
}

if (redundant.length) {
  console.error(`\n${redundant.length} router.refresh() call(s) right after a Server Action that already re-renders the page:`);
  for (const f of redundant) console.error(`  ${f.file}:${f.line}  after await ${f.action}()`);
  console.error("\nThe action's response already carries the re-rendered page. Drop the refresh.");
  process.exit(1);
}
console.log(`redundant-refresh: ${findings.length} router.refresh() calls checked; none follow a revalidating action.`);
process.exit(0);
