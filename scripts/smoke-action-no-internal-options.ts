/**
 * A Server Action is a public endpoint, so its parameters are whatever a caller posts.
 * Options types marked `@internal` (`ContactWriteOptions` and friends) switch off checks —
 * the embedding rebuild, closeness scoring, the allowance count — and exist for trusted
 * server paths. If one appears in an exported action's signature, the browser can set it.
 *
 * Walks every `"use server"` module under `src/actions/` with the TypeScript parser and
 * fails when an exported function's parameter type mentions a type whose declaration carries
 * an `@internal` JSDoc tag, or is `ContactWriteOptions` / `ResolveOptions` by name.
 * Trusted paths take the options on a `*ForUser` function under `src/lib/`.
 *
 * Run: npx tsx scripts/smoke-action-no-internal-options.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });

const parse = (file: string) =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// 1. Every type declared @internal anywhere under src/.
const internalTypes = new Set<string>(["ContactWriteOptions", "ResolveOptions"]);
for (const file of walk("src")) {
  const sf = parse(file);
  for (const stmt of sf.statements) {
    if (!ts.isTypeAliasDeclaration(stmt) && !ts.isInterfaceDeclaration(stmt)) continue;
    const tagged = ts.getJSDocTags(stmt).some((t) => t.tagName.text === "internal");
    if (tagged) internalTypes.add(stmt.name.text);
  }
}
check("found the @internal option types", internalTypes.has("ContactWriteOptions"), [...internalTypes].join(", "));

// 2. No exported action parameter mentions one.
const isUseServer = (sf: ts.SourceFile) => {
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) break;
    if (stmt.expression.text === "use server") return true;
  }
  return false;
};
const exported = (n: ts.Node) =>
  ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const offenders: string[] = [];
let actions = 0;
for (const file of walk("src/actions")) {
  const sf = parse(file);
  if (!isUseServer(sf)) continue;
  for (const stmt of sf.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !exported(stmt) || !stmt.name) continue;
    actions++;
    for (const param of stmt.parameters) {
      const visit = (node: ts.Node) => {
        if (ts.isTypeReferenceNode(node) && internalTypes.has(node.typeName.getText(sf))) {
          offenders.push(`${file}#${stmt.name!.text}(${param.name.getText(sf)}: ${node.typeName.getText(sf)})`);
        }
        ts.forEachChild(node, visit);
      };
      if (param.type) visit(param.type);
    }
  }
}
check(`scanned ${actions} exported actions`, actions > 100);
check("no exported action takes an @internal options type", offenders.length === 0, offenders.join("; "));

if (failures) {
  console.log(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("All action-options checks passed.");
