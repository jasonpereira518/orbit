/**
 * A Server Action's TypeScript parameter types are a promise the browser is trusted to keep.
 * An action that takes an object (or a list of them) and never runs it through a schema acts on
 * whatever was posted. P5.2 of the code-health plan migrates them to `parseInput(schema, …)`
 * from `@/lib/action`; this is the ratchet that keeps the count from growing back.
 *
 * Walks every `"use server"` module under `src/actions/` with the TypeScript parser. An exported
 * function is UNVALIDATED when
 *   - at least one parameter is object-like: an inline object type, or a named type that is not
 *     a primitive, a string/number union, `Date`/`FormData`/`File`/`Blob`, or an array of those; and
 *   - its body never calls `parseInput`.
 *
 * Named types are resolved across `src/` (a unique `type X = "a" | "b"` is a union, not an
 * object). A name that cannot be resolved counts as object-like, so a miss errs toward a
 * schema, not away from one.
 *
 * Fails when the count rises above BASELINE. When it falls, lower BASELINE in the same commit
 * (the script says so), so the improvement cannot quietly be given back.
 *
 * `--report` lists every unvalidated action.
 * Run: npx tsx scripts/smoke-action-input-validation.ts [--report]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** Unvalidated object-parameter actions today. Lower it as files are migrated; never raise it. */
const BASELINE = 141;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
const parse = (file: string) =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);

// Every type alias in src/, by name; a name declared twice is ambiguous and dropped.
const aliases = new Map<string, ts.TypeNode | null>();
for (const file of walk("src")) {
  const sf = parse(file);
  for (const stmt of sf.statements) {
    if (ts.isTypeAliasDeclaration(stmt)) {
      aliases.set(stmt.name.text, aliases.has(stmt.name.text) ? null : stmt.type);
    } else if (ts.isInterfaceDeclaration(stmt)) {
      aliases.set(stmt.name.text, null); // an interface is always an object
    }
  }
}

const PLAIN_NAMES = new Set(["Date", "FormData", "File", "Blob", "Uint8Array", "ArrayBuffer"]);

function isPlain(node: ts.TypeNode, seen = new Set<string>()): boolean {
  if (ts.isParenthesizedTypeNode(node)) return isPlain(node.type, seen);
  if (ts.isUnionTypeNode(node)) return node.types.every((t) => isPlain(t, seen));
  if (ts.isArrayTypeNode(node)) return isPlain(node.elementType, seen);
  if (ts.isLiteralTypeNode(node)) return true;
  if (ts.isTypeOperatorNode(node)) return isPlain(node.type, seen); // readonly string[]
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    if (PLAIN_NAMES.has(name)) return true;
    if ((name === "Array" || name === "ReadonlyArray") && node.typeArguments?.length === 1) {
      return isPlain(node.typeArguments[0], seen);
    }
    const target = aliases.get(name);
    if (target && !seen.has(name)) return isPlain(target, new Set(seen).add(name));
    return false;
  }
  // string | number | boolean | null | undefined | bigint | unknown-keyword types
  return (
    node.kind === ts.SyntaxKind.StringKeyword ||
    node.kind === ts.SyntaxKind.NumberKeyword ||
    node.kind === ts.SyntaxKind.BooleanKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.UndefinedKeyword ||
    node.kind === ts.SyntaxKind.BigIntKeyword ||
    node.kind === ts.SyntaxKind.VoidKeyword
  );
}

const isUseServer = (sf: ts.SourceFile) => {
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) break;
    if (stmt.expression.text === "use server") return true;
  }
  return false;
};
const exported = (n: ts.Node) =>
  ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

function callsParseInput(body: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "parseInput") found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

const unvalidated: string[] = [];
let total = 0;
for (const file of walk("src/actions")) {
  const sf = parse(file);
  if (!isUseServer(sf)) continue;
  for (const stmt of sf.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !exported(stmt) || !stmt.name || !stmt.body) continue;
    const objectLike = stmt.parameters.some((p) => (p.type ? !isPlain(p.type) : false));
    if (!objectLike) continue;
    total++;
    if (!callsParseInput(stmt.body)) unvalidated.push(`${file.replace(/^src\/actions\//, "")}#${stmt.name.text}`);
  }
}

if (process.argv.includes("--report")) {
  for (const u of unvalidated.sort()) console.log(u);
  console.log(`${unvalidated.length} unvalidated of ${total} object-parameter actions`);
  process.exit(0);
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
check(`found object-parameter actions (${total})`, total > 20);
check(
  `unvalidated object-parameter actions: ${unvalidated.length} (baseline ${BASELINE})`,
  unvalidated.length <= BASELINE,
  unvalidated.length > BASELINE ? "a new or changed action takes an object without parseInput(schema, …)" : ""
);
if (unvalidated.length < BASELINE) {
  check("BASELINE is current", false, `lower BASELINE to ${unvalidated.length} in scripts/smoke-action-input-validation.ts`);
}
if (failures) {
  console.log(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("All action input-validation checks passed.");
