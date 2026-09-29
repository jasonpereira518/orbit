/**
 * The waitlist's product preview ("Take it for a spin", `src/components/interest/app-demo/`) is
 * a copy of the real app, and copies drift. This fails when it does.
 *
 *   1. LOOK — the window carries the app's real `dark` theme class and takes every colour from
 *      the app's tokens: no `--d-*` variables, and no hex literal in the chrome that the app's
 *      own source does not also contain. (The portraits and the sky chart are illustration, and
 *      the three traffic-light dots are mock window chrome; those are exempt.)
 *   2. NAV — the sidebar is drawn from `components/layout/app-nav.ts`, and its "Soon" tags are
 *      exactly the items the app itself marks coming soon (`isHrefComingSoon`).
 *   3. WORDS — every heading, label and sentence the preview shows on the tour path also
 *      appears in the real app's screens. A string the app renamed, and the preview did not,
 *      fails here.
 *   4. IMPORTS — everything the preview pulls from the app is on an allowlist of client-safe
 *      modules, so it can never drag the database, Clerk or a server action into the waitlist's
 *      lazy chunk (a client component that reaches `@/db` fails the build with a `node:fs`
 *      chunk error).
 *
 * Parsed with the TypeScript compiler, not grepped: comments and dead code can neither satisfy
 * nor trip a check, which a regex guard elsewhere in this repo once failed to guarantee.
 *
 * Pure: reads source, opens nothing. Run: npx tsx scripts/smoke-waitlist-demo-fidelity.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const DEMO = path.join(SRC, "components/interest/app-demo");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

function parse(file: string) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

const norm = (s: string) =>
  s
    .replace(/&apos;|[’‘]/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Every string the file can put on screen or in a class list: JSX text and string literals. */
function texts(file: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(norm(n.text));
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(norm(n.text));
    ts.forEachChild(n, visit);
  };
  visit(parse(file));
  return out.filter(Boolean);
}

const demoFiles = walk(DEMO);
const rel = (f: string) => path.relative(SRC, f);

function main() {
  // ── 1. LOOK ────────────────────────────────────────────────────────────────────────────
  console.log("look…");
  const windowSrc = readFileSync(path.join(DEMO, "demo-window.tsx"), "utf8");
  check("the window carries the app's `dark` theme class", /className="dark relative/.test(windowSrc));
  const stale = demoFiles.filter((f) => /var\(--d-|DEMO_TOKENS|--d-bg/.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  check("no copied `--d-*` token survives", stale.length === 0, stale.map(rel).join(", "));

  // Hexes the app's own UI uses: its stylesheet and the screens the preview imitates — not the
  // waitlist's emails or marketing files, which still carry the old navy.
  const UI_SOURCES = [
    "app/globals.css",
    "lib/graph",
    "components/ui",
    "components/layout",
    "components/dashboard",
    "components/contacts",
    "components/chat",
    "components/graph",
  ];
  const realCss = new Set<string>();
  for (const src of UI_SOURCES) {
    const p = path.join(SRC, src);
    for (const f of statSync(p).isDirectory() ? walk(p) : [p]) {
      for (const m of readFileSync(f, "utf8").matchAll(/#[0-9a-fA-F]{6}\b/g)) realCss.add(m[0].toLowerCase());
    }
  }
  const ILLUSTRATION = new Set(["demo-cast.ts", "sky-chart.tsx", "demo-ui.tsx"]);
  const MOCK_CHROME = new Set(["#ff5f57", "#febc2e", "#28c840"]);
  const invented: string[] = [];
  for (const f of demoFiles) {
    if (ILLUSTRATION.has(path.basename(f))) continue;
    for (const t of texts(f)) {
      for (const m of t.matchAll(/#[0-9a-f]{6}\b/g)) {
        if (!realCss.has(m[0]) && !MOCK_CHROME.has(m[0])) invented.push(`${path.basename(f)}: ${m[0]}`);
      }
    }
  }
  check("every colour in the chrome is one the app itself uses", invented.length === 0, invented.join("; "));

  // ── 2. NAV ─────────────────────────────────────────────────────────────────────────────
  console.log("\nnav…");
  const sidebar = readFileSync(path.join(DEMO, "demo-sidebar.tsx"), "utf8");
  check(
    "the sidebar is drawn from the app's nav definition",
    /from "@\/components\/layout\/app-nav"/.test(sidebar) && /APP_NAV_CORE/.test(sidebar) && /APP_NAV_EXTRAS/.test(sidebar)
  );
}

async function mainAsync() {
  main();

  // ── 2 (cont.) the "Soon" tags are the app's ────────────────────────────────────────────
  const nav = await import("../src/components/layout/app-nav");
  const surfaces = await import("../src/lib/surfaces");
  const hidden = new Set([...readFileSync(path.join(DEMO, "demo-sidebar.tsx"), "utf8").matchAll(/HIDDEN = new Set\(\[([^\]]*)\]/g)].flatMap((m) => [...m[1]!.matchAll(/"(\/[a-z]+)"/g)].map((x) => x[1]!)));
  const appSoon = [...nav.APP_NAV_CORE, ...nav.APP_NAV_EXTRAS, nav.APP_NAV_SETTINGS]
    .filter((i) => !hidden.has(i.href))
    .filter((i) => surfaces.isHrefComingSoon(i.href))
    .map((i) => i.href)
    .sort();
  const sidebarTexts = texts(path.join(DEMO, "demo-sidebar.tsx"));
  const demoSoon = [...readFileSync(path.join(DEMO, "demo-sidebar.tsx"), "utf8").matchAll(/"(\/[a-z]+)": \{ label:/g)].map((m) => m[1]!).sort();
  check("the preview's Soon items are exactly the app's coming-soon pages", JSON.stringify(demoSoon) === JSON.stringify(appSoon), `preview ${demoSoon} vs app ${appSoon}`);
  const liveHrefs = [...readFileSync(path.join(DEMO, "demo-sidebar.tsx"), "utf8").matchAll(/"(\/[a-z]+)": "[a-z]+"/g)].map((m) => m[1]!);
  const appHrefs = new Set([...nav.APP_NAV_CORE, ...nav.APP_NAV_EXTRAS, nav.APP_NAV_SETTINGS].map((i) => i.href));
  check("every screen the preview makes live is a real nav destination", liveHrefs.length >= 4 && liveHrefs.every((h) => appHrefs.has(h)), liveHrefs.join(", "));
  check("the preview keeps the divider's words", sidebarTexts.includes("coming soon"));

  // ── 3. WORDS ───────────────────────────────────────────────────────────────────────────
  console.log("\nwords…");
  const REAL_DIRS = [
    "components/dashboard",
    "components/contacts",
    "components/chat",
    "components/graph",
    "components/layout",
    "app/(clerk)/(app)/(main)/dashboard",
    "app/(clerk)/(app)/(main)/contacts",
    "app/(clerk)/(app)/(main)/chat",
    "app/(clerk)/(app)/(main)/graph",
  ];
  const real = REAL_DIRS.flatMap((d) => (statSync(path.join(SRC, d), { throwIfNoEntry: false }) ? walk(path.join(SRC, d)) : [])).flatMap(texts);
  const demo = demoFiles.filter((f) => !/demo-cast|demo-chat|demo-state|demo-tour|sky-chart/.test(f)).flatMap(texts);
  const inReal = (s: string) => real.some((t) => t.includes(norm(s)));
  const inDemo = (s: string) => demo.some((t) => t.includes(norm(s)));

  const WORDS: Record<string, string[]> = {
    shell: ["Network tracker", "Log interaction", "Account"],
    dashboard: [
      "Your network",
      "Stay in orbit",
      "Follow-ups, dormant connections, and people worth reaching out to — in one place.",
      "to jump anywhere, or",
      "to ask your network.",
      "Due follow-ups",
      "Strong ties",
      "Needs attention",
      "Close + warm",
      "Network depth",
      "How close your network feels and how people connect to each other",
      "Relationship strength",
      "Peer connections",
      "Constellation preview",
      "Your network at a glance — each constellation is a company or school",
      "Open full constellation",
      "Suggested outreach",
      "Reminders",
    ],
    contacts: ["Contacts", "Search contacts…", "AI capture", "Add contact", "Recruiters"],
    profile: [
      "Where things stand",
      "Recent discussions",
      "Open next steps",
      "Who they are",
      "Follow up",
      "Schedule a reminder, or pick a channel to draft a message from your history.",
      "Timeline",
      "Refresh",
    ],
    chat: [
      "Chat with your network",
      "Ask who can help, who to follow up with, or who knows what.",
      "Ask your network",
      "Who can help, who to follow up with, or who knows what — try a suggestion below.",
      "Ask about your network…",
      "New chat",
      "Context",
      "Questions about people in your network",
      "Send email…",
    ],
    constellation: ["Star chart", "You are the sun. Companies and schools form constellations around you — each figure traced by its own people."],
  };
  for (const [screen, list] of Object.entries(WORDS)) {
    const notInReal = list.filter((s) => !inReal(s));
    const notInDemo = list.filter((s) => !inDemo(s));
    check(`${screen}: the preview's words are the app's`, notInReal.length === 0 && notInDemo.length === 0, `not in the app: ${JSON.stringify(notInReal)}; not in the preview: ${JSON.stringify(notInDemo)}`);
  }

  // ── 4. IMPORTS ─────────────────────────────────────────────────────────────────────────
  console.log("\nimports…");
  const ALLOWED_APP = new Set([
    "@/lib/utils",
    "@/lib/motion",
    "@/components/ui/button",
    "@/components/dashboard/closeness-tier-badge",
    "@/components/layout/app-nav",
    "@/lib/interaction-types",
  ]);
  const bad: string[] = [];
  for (const f of demoFiles) {
    const sf = parse(f);
    sf.forEachChild((n) => {
      if (!ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier)) return;
      const from = n.moduleSpecifier.text;
      if (from.startsWith("@/") && !ALLOWED_APP.has(from)) bad.push(`${rel(f)}: ${from}`);
      if (/^(next\/|@clerk|@sentry)/.test(from)) bad.push(`${rel(f)}: ${from}`);
    });
  }
  check("the preview imports only allowlisted client-safe app modules", bad.length === 0, bad.join("; "));

  if (failures > 0) {
    console.error(`\nsmoke-waitlist-demo-fidelity: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nsmoke-waitlist-demo-fidelity: all checks passed");
  process.exit(0);
}

mainAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
