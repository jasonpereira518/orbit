/**
 * Every page inside the app shell is drawn the same way: one `PageHeader`, one of two widths,
 * one display-font spelling, and the shared `EmptyState` instead of a hand-made dashed box.
 *
 * What it guards against is drift, one page at a time. A new page that hand-writes its own
 * `<h1>` or picks a fifth max-width passes every type check and looks fine on its own; it is
 * only wrong next to the others. That is how the app got four title sizes and five widths.
 *
 * Checks, over the syntax tree (never a regex: a commented-out class must not count):
 *   1. No JSX `h1` in a page, loading file or shared header — the title is `PageHeader`'s.
 *   2. No `font-heading` / `font-display` class token — the display font has one spelling.
 *   3. No `border-dashed` token — empty states are `EmptyState`.
 *   4. No page-sized max-width except `max-w-3xl` (page and loading files) — the reading
 *      width. Full-width pages set none: the shell is the cap. Text-measure caps (`md`, `xl`)
 *      are fine.
 *   5. Every `page.tsx` imports `@/components/layout/page-header`, unless its header lives in
 *      a component (listed below).
 *
 * The contact and event heroes and `PeopleListShell` are deliberately outside the file set.
 *
 * Run: npx tsx scripts/smoke-page-shell.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const MAIN = "src/app/(clerk)/(app)/(main)";

/** Pages whose header is drawn by a component rather than by `PageHeader` in the page. */
const HEADER_ELSEWHERE = new Set([
  `${MAIN}/dashboard/page.tsx`, // DashboardHeader
  `${MAIN}/radar/page.tsx`, // RadarHeader
  `${MAIN}/events/page.tsx`, // EventsHeader
  `${MAIN}/reminders/page.tsx`, // RemindersStage
  `${MAIN}/contacts/page.tsx`, // PeopleListShell
  `${MAIN}/recruiters/page.tsx`, // PeopleListShell
  `${MAIN}/contacts/[id]/page.tsx`, // ContactProfileHero
  `${MAIN}/events/[id]/page.tsx`, // EventHero
]);

/** Shared header components held to rules 1–3 alongside the pages. */
const COMPONENTS = [
  "src/components/dashboard/dashboard-header.tsx",
  "src/components/radar/radar-header.tsx",
  "src/components/events/events-header.tsx",
  "src/components/reminders/reminders-stage.tsx",
];

const PAGE_SIZED = /^max-w-(2xl|4xl|5xl|6xl|7xl|screen-.+)$/;

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Tag names of every JSX element, and every whitespace-separated token of every string. */
function scan(sf: ts.SourceFile) {
  const tags: string[] = [];
  const tokens: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      tags.push(node.tagName.getText(sf));
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      tokens.push(...node.text.split(/\s+/).filter(Boolean));
    }
    if (ts.isTemplateExpression(node)) {
      for (const part of [node.head, ...node.templateSpans.map((s) => s.literal)]) {
        tokens.push(...part.text.split(/\s+/).filter(Boolean));
      }
    }
    if (ts.isJsxText(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { tags, tokens };
}

function importsPageHeader(sf: ts.SourceFile): boolean {
  return sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === "@/components/layout/page-header"
  );
}

const routeFiles = [
  ...walk(MAIN).filter((f) => /\/(page|loading)\.tsx$/.test(f)),
  "src/app/(clerk)/(app)/settings/page.tsx",
  "src/app/(clerk)/(app)/settings/loading.tsx",
].sort();

console.log(`page shell — ${routeFiles.length} route files, ${COMPONENTS.length} header components`);

for (const file of [...routeFiles, ...COMPONENTS]) {
  const sf = parse(file);
  const { tags, tokens } = scan(sf);
  const isRoute = routeFiles.includes(file);

  check(`${file}: no hand-written <h1>`, !tags.includes("h1"));
  const font = tokens.filter((t) => t === "font-heading" || t === "font-display");
  check(`${file}: display font spelled one way`, font.length === 0, font.join(", "));
  check(`${file}: no hand-made dashed box`, !tokens.includes("border-dashed"));
  if (isRoute) {
    const wide = tokens.filter((t) => PAGE_SIZED.test(t));
    check(`${file}: full or reading width`, wide.length === 0, wide.join(", "));
  }
  if (file.endsWith("/page.tsx") && !HEADER_ELSEWHERE.has(file)) {
    check(`${file}: uses PageHeader`, importsPageHeader(sf));
  }
}

// The guard guards itself: a fixture that breaks every rule must trip every rule.
{
  const bad = ts.createSourceFile(
    "fixture.tsx",
    `export default () => <div className="mx-auto max-w-5xl"><h1 className="font-heading">x</h1><div className="border-dashed" /></div>;`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const { tags, tokens } = scan(bad);
  check("fixture: h1 detected", tags.includes("h1"));
  check("fixture: font-heading detected", tokens.includes("font-heading"));
  check("fixture: border-dashed detected", tokens.includes("border-dashed"));
  check("fixture: page-sized width detected", tokens.some((t) => PAGE_SIZED.test(t)));
  check("fixture: missing PageHeader import detected", !importsPageHeader(bad));
}

if (failures > 0) {
  console.error(`\n${failures} page-shell check(s) failed`);
  process.exit(1);
}
console.log("\nall page-shell checks passed");
process.exit(0);
