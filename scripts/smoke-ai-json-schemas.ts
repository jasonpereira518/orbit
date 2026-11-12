/**
 * `parseAiJson<T>(raw)` asserts a shape it never checks: a model that answers `null`, a string
 * or `{ "text": 5 }` is read as `T` and fails later at `.trim()` or `.map()`. P5.4 moved every
 * such site to `parseAiJson(schema, raw)`. This keeps the type-argument form from coming back:
 * it fails on any call to `parseAiJson` that passes a type argument.
 *
 * Parsed, not grepped, so a comment or string mentioning the old form cannot trip it.
 * `--report` lists the offenders. Run: npx tsx scripts/smoke-ai-json-schemas.ts [--report]
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

const offenders: string[] = [];
for (const file of walk("src")) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "parseAiJson" &&
      node.typeArguments?.length
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      offenders.push(`${file}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (process.argv.includes("--report")) {
  console.log(offenders.join("\n") || "none");
  process.exit(0);
}
const ok = offenders.length === 0;
console.log(`  ${ok ? "ok  " : "FAIL"}  no parseAiJson<T>(…) type-argument calls${ok ? "" : ` — ${offenders.join(", ")}`}`);
if (!ok) process.exit(1);
console.log("All AI-JSON schema checks passed.");
