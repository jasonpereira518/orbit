/**
 * The source patterns behind the accessibility audit's systemic findings
 * (A11Y_RESPONSIVE_AUDIT.md), held out of the codebase. Each one was fixed once, in a shared
 * place; this keeps a new call site from bringing it back. The browser-level checks (axe,
 * overflow, titles, dialogs, zoom) live in e2e/07-a11y.spec.ts.
 *
 *   1. `text-muted-foreground/70|80|90` on text: 3.0-4.4:1. Use `text-muted-foreground-subtle`.
 *   2. `vh` / `*-screen` heights: the large viewport on iOS, so a footer or Save button hides
 *      behind Safari's toolbar. Use `dvh` (or `svh`).
 *   3. `role="link"` on a non-link: a real <a>/<Link> gets middle-click, new tab and the
 *      right semantics; a row-sized link stretches over its row instead.
 *   4. A control hidden with `opacity-0` and revealed on `group-hover`: hover never happens
 *      on touch, so it is invisible and still tappable. Use `pointer-fine:opacity-0`.
 *   5. A button whose only text is `hidden sm:inline` (or md/lg): below that width it has no
 *      accessible name. Use `max-sm:sr-only`, or give the button an aria-label.
 *   6. `aria-hidden` on a Motion element with `whileTap` and no `tabIndex`: Motion makes it
 *      focusable, an invisible tab stop.
 *   7. `text-[9px|10px|11px]`: px ignores the reader's font-size setting. Use `text-3xs`
 *      (0.625rem) or `text-2xs` (0.6875rem).
 *
 * Pure: parses the TSX with the TypeScript compiler, touches no database.
 * Run: npx tsx scripts/smoke-a11y-patterns.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOTS = ["src/app", "src/components"];
// Email HTML (unsubscribe pages) is not the app and has its own constraints.
const SKIP = [/^src\/app\/api\//];

const BUTTONISH = new Set(["button", "Button", "a", "Link", "IntentLink", "WarpLink"]);
const MUTED_ALPHA = /\btext-muted-foreground\/(70|80|90)\b/;
const VIEWPORT_HEIGHT = /(?:^|[\s"'`:])(?:min-h|max-h|h)-screen\b|-\[[^\]\s]*\b\d+vh\b/;
const PX_TEXT = /(?:^|[\s"'`:])text-\[(?:9|10|11)px\]/;
const HIDDEN_BELOW = /(?:^|\s)hidden\s+(?:[^"'`]*\s)?(sm|md|lg|xl):(inline|inline-flex|inline-block|block|flex)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx$/.test(name)) out.push(path);
  }
  return out;
}

type Problem = { file: string; line: number; rule: number; detail: string };
const problems: Problem[] = [];

function tagName(el: ts.JsxOpeningLikeElement) {
  return el.tagName.getText();
}

function attr(el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return el.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name
  );
}

/** Every string literal inside an attribute's initializer (covers cn(...) and ternaries). */
function strings(node: ts.Node | undefined): string[] {
  if (!node) return [];
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text);
      for (const span of n.templateSpans) out.push(span.literal.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function classTokens(el: ts.JsxOpeningLikeElement): Set<string> {
  const tokens = new Set<string>();
  for (const s of strings(attr(el, "className")?.initializer)) for (const t of s.split(/\s+/)) if (t) tokens.add(t);
  return tokens;
}

for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (SKIP.some((re) => re.test(file))) continue;
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const report = (node: ts.Node, rule: number, detail: string) =>
      problems.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, rule, detail });

    const visit = (node: ts.Node) => {
      // 1 and 2 anywhere a class string can be written (JSX, cn(), cva, constants).
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (MUTED_ALPHA.test(node.text)) report(node, 1, node.text.match(MUTED_ALPHA)![0]);
        if (VIEWPORT_HEIGHT.test(node.text)) report(node, 2, node.text.match(VIEWPORT_HEIGHT)![0].trim());
        if (PX_TEXT.test(node.text)) report(node, 7, node.text.match(PX_TEXT)![0].trim());
      }

      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const name = tagName(node);
        const role = attr(node, "role")?.initializer;
        if (role && ts.isStringLiteral(role) && role.text === "link" && name !== "a") {
          report(node, 3, `<${name} role="link">`);
        }

        const tokens = classTokens(node);
        if (BUTTONISH.has(name) && tokens.has("opacity-0") && [...tokens].some((t) => /group-hover(\/[\w-]+)?:opacity-100/.test(t))) {
          report(node, 4, `<${name}> opacity-0 … group-hover:opacity-100`);
        }

        if (
          name.startsWith("motion.") &&
          attr(node, "whileTap") &&
          attr(node, "aria-hidden") &&
          !attr(node, "tabIndex")
        ) {
          report(node, 6, `<${name} aria-hidden whileTap>`);
        }
      }

      // 5: the only text of a button-like element is hidden below a breakpoint.
      if (ts.isJsxElement(node) && (BUTTONISH.has(tagName(node.openingElement)) || /Trigger$/.test(tagName(node.openingElement)))) {
        const open = node.openingElement;
        const named = attr(open, "aria-label") || attr(open, "aria-labelledby") || attr(open, "title");
        if (!named) {
          let visibleText = false;
          let hiddenLabel: ts.Node | null = null;
          for (const child of node.children) {
            if (ts.isJsxText(child) && child.text.trim()) visibleText = true;
            else if (ts.isJsxExpression(child) && child.expression) visibleText = true;
            else if (ts.isJsxElement(child)) {
              const cls = strings(attr(child.openingElement, "className")?.initializer).join(" ");
              if (HIDDEN_BELOW.test(cls)) hiddenLabel = child;
              else if (child.children.some((c) => (ts.isJsxText(c) && c.text.trim()) || ts.isJsxExpression(c))) visibleText = true;
            }
          }
          if (hiddenLabel && !visibleText) report(hiddenLabel, 5, `<${tagName(open)}> labelled only by "hidden …:inline" text`);
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

const RULES: Record<number, string> = {
  1: "muted text below 4.5:1 — use text-muted-foreground-subtle",
  2: "vh / *-screen height — use dvh",
  3: 'role="link" on a non-link — use <a>/<Link>',
  4: "hover-only reveal — use pointer-fine:opacity-0",
  5: "button loses its name below a breakpoint — use max-sm:sr-only (or aria-label)",
  6: "aria-hidden Motion element with whileTap is focusable — add tabIndex={-1}",
  7: "px text size — use text-3xs / text-2xs (rem)",
};

for (const rule of Object.keys(RULES).map(Number)) {
  const hits = problems.filter((p) => p.rule === rule);
  if (!hits.length) console.log(`  ok   ${rule}. ${RULES[rule]}`);
  else {
    console.error(`  FAIL ${rule}. ${RULES[rule]}`);
    for (const p of hits) console.error(`       ${p.file}:${p.line}  ${p.detail}`);
  }
}

if (problems.length) {
  console.error(`\nsmoke-a11y-patterns: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log("\nsmoke-a11y-patterns: all ok");
