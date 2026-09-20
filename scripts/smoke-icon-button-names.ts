/**
 * Icon-only buttons need a name a screen reader can say. Walks every .tsx under
 * src/components with the TypeScript parser and flags a button-like element (button,
 * Button, *Trigger, *Close) whose children render no text and that has no aria-label,
 * aria-labelledby, title or children prop.
 *
 * Counted as text: non-blank JSX text, any expression that is not an element or a literal
 * null/false/true/undefined, an element with an sr-only className, and any non-icon element
 * containing text. Icons are lucide-react imports, identifiers ending in Icon, and svg.
 * Allowlisted by pattern: a spread prop (the name may arrive in it), a render prop (the
 * rendered element is the button), a Button written as another element's render value, and
 * a self-closing custom component (it names itself where it is defined).
 * Run: npx tsx scripts/smoke-icon-button-names.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = "src/components";
const BUTTON_TAG = /^(button|Button|[A-Z][A-Za-z]*Trigger|[A-Z][A-Za-z]*Close)$/;
const NAME_ATTRS = new Set(["aria-label", "aria-labelledby", "title", "children", "render"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".tsx") ? [p] : [];
  });
}

function iconNames(sf: ts.SourceFile): Set<string> {
  const icons = new Set<string>(["svg"]);
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const fromLucide = stmt.moduleSpecifier.text === "lucide-react";
    for (const el of bindings.elements) if (fromLucide || /Icon$/.test(el.name.text)) icons.add(el.name.text);
  }
  ts.forEachChild(sf, function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && /Icon$/.test(node.name.text)) icons.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /Icon$/.test(node.name.text)) icons.add(node.name.text);
    ts.forEachChild(node, visit);
  });
  return icons;
}

const tagOf = (n: ts.JsxOpeningLikeElement) => n.tagName.getText();
const attrsOf = (n: ts.JsxOpeningLikeElement) => n.attributes.properties;
const hasSrOnly = (n: ts.JsxOpeningLikeElement) =>
  attrsOf(n).some((a) => ts.isJsxAttribute(a) && a.name.getText() === "className" && /sr-only/.test(a.getText()));

function exprGivesText(expr: ts.Expression | undefined, icons: Set<string>): boolean {
  if (!expr) return false;
  if (ts.isParenthesizedExpression(expr)) return exprGivesText(expr.expression, icons);
  if (ts.isConditionalExpression(expr)) return exprGivesText(expr.whenTrue, icons) || exprGivesText(expr.whenFalse, icons);
  if (ts.isBinaryExpression(expr)) {
    const k = expr.operatorToken.kind;
    if (k === ts.SyntaxKind.AmpersandAmpersandToken) return exprGivesText(expr.right, icons);
    if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) return exprGivesText(expr.left, icons) || exprGivesText(expr.right, icons);
  }
  if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr)) return nodeGivesText(expr, icons);
  if ([ts.SyntaxKind.NullKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.TrueKeyword].includes(expr.kind)) return false;
  if (ts.isIdentifier(expr) && expr.text === "undefined") return false;
  return true;
}

function nodeGivesText(node: ts.Node, icons: Set<string>): boolean {
  if (ts.isJsxText(node)) return node.text.trim().length > 0;
  if (ts.isJsxExpression(node)) return exprGivesText(node.expression, icons);
  if (ts.isJsxSelfClosingElement(node)) {
    if (icons.has(tagOf(node))) return false;
    if (hasSrOnly(node)) return true;
    return !/^[a-z]/.test(tagOf(node)) || attrsOf(node).some((a) => ts.isJsxAttribute(a) && a.name.getText() === "children");
  }
  if (ts.isJsxElement(node)) {
    if (icons.has(tagOf(node.openingElement))) return false;
    if (hasSrOnly(node.openingElement)) return true;
    return node.children.some((c) => nodeGivesText(c, icons));
  }
  if (ts.isJsxFragment(node)) return node.children.some((c) => nodeGivesText(c, icons));
  return false;
}

const hits: string[] = [];
for (const file of walk(ROOT)) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const icons = iconNames(sf);
  ts.forEachChild(sf, function visit(node) {
    const open = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (open && BUTTON_TAG.test(tagOf(open))) {
      const selfClosing = ts.isJsxSelfClosingElement(node);
      const asRenderValue = selfClosing && ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) && node.parent.parent.name.getText() === "render";
      const selfClosingComponent = selfClosing && !/^(button|Button)$/.test(tagOf(open));
      const named = attrsOf(open).some((p) => ts.isJsxSpreadAttribute(p) || (ts.isJsxAttribute(p) && NAME_ATTRS.has(p.name.getText())));
      const text = ts.isJsxElement(node) && node.children.some((c) => nodeGivesText(c, icons));
      if (!asRenderValue && !selfClosingComponent && !named && !text) {
        hits.push(`${file}:${sf.getLineAndCharacterOfPosition(open.getStart()).line + 1} <${tagOf(open)}>`);
      }
    }
    ts.forEachChild(node, visit);
  });
}

if (hits.length) {
  console.error(`  FAIL icon-only buttons without an accessible name:\n       ${hits.join("\n       ")}`);
  console.error(`\nsmoke-icon-button-names: ${hits.length} unnamed`);
  process.exit(1);
}
console.log("  ok   every icon-only button in src/components has a name");
console.log("\nsmoke-icon-button-names: ok");
process.exit(0);
