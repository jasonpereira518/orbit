/**
 * The settings page's structure: five groups, every section in one of them, and the
 * Integrations group fully covered by the dialog's tabs.
 *
 * What it guards against is a section silently vanishing. A section added to
 * `SETTINGS_SECTIONS` with `group: "integrations"` but no dialog tab would be hideable in the
 * admin console and appear nowhere; one in any other group that `page.tsx` never renders
 * would do the same. Neither fails a type check.
 *
 * The last two sections read the dialog's own source with the TypeScript compiler: a page with
 * no `Panel` case opens on an empty panel, and an import kind `tabForImportJob` doesn't name
 * runs with nothing anywhere saying so.
 *
 * Run: npx tsx scripts/smoke-settings-layout.ts
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  INTEGRATION_TAB_GROUPS,
  INTEGRATION_TABS,
  OVERVIEW,
  OVERVIEW_TABS,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  integrationHref,
  legacyHashTab,
  resolveIntegrationParam,
} from "../src/components/settings/sections";
import { getSurface } from "../src/lib/surfaces";

let failures = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
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

/**
 * The string labels of the `case` clauses inside the named function that carry their own
 * body — a `CaseClause` with a non-empty `statements` list.
 *
 * Read off the syntax tree, the way `smoke-connect-gates.ts`'s `callsIn` reads calls, and
 * deliberately not with a regex over the source: a guard in this repo that regex-sliced source
 * kept passing over a branch someone had commented out. A parser sees the comment for what it
 * is.
 *
 * A label with no statements of its own (`case "a": case "b": return x;`) falls through into
 * its neighbour's body and does not count — that shape is exactly what let `webhooks` answer
 * with the API panel while looking "covered". The cost is that two ids sharing one intentional
 * answer (`tabForImportJob`'s several kinds returning the same tab) must each spell out their
 * own `return`; a case folded into someone else's body — intentionally or by accident — then
 * comes up missing here instead of silently passing. That is the whole point: the rule cannot
 * tell an intentional group from a wrong-panel fall-through by shape alone, so it asks every id
 * to write its own answer and leaves grouping to be true two functions have in common (calling
 * the same value), not one shared `case` body.
 */
function switchCasesIn(file: string, fn: string): string[] {
  const source = parse(file);
  let body: ts.Node | undefined;
  const findFn = (node: ts.Node) => {
    if (body) return;
    const isFn =
      (ts.isFunctionDeclaration(node) && node.name?.text === fn) ||
      (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === fn);
    if (isFn) body = node;
    else ts.forEachChild(node, findFn);
  };
  ts.forEachChild(source, findFn);
  if (!body) throw new Error(`${fn} not found in ${file}`);

  const cases: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.statements.length > 0) {
      cases.push(node.expression.text);
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(body, walk);
  return cases;
}

/** The string members of a `type X = "a" | "b"` alias, read the same way. */
function unionMembers(file: string, typeName: string): string[] {
  const source = parse(file);
  let members: string[] | undefined;
  const walk = (node: ts.Node) => {
    if (members) return;
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      const parts = ts.isUnionTypeNode(node.type) ? node.type.types : [node.type];
      members = parts.flatMap((part) =>
        ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal) ? [part.literal.text] : []
      );
      return;
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(source, walk);
  if (!members) throw new Error(`${typeName} not found in ${file}`);
  return members;
}

console.log("\ngroups");
check("five groups", SETTINGS_GROUPS.length === 5);
check(
  "named Account, Preferences, Integrations, Resources, Data, in that order",
  SETTINGS_GROUPS.map((g) => g.label).join(",") ===
    "Account,Preferences,Integrations,Resources,Data"
);
const groupKeys = new Set<string>(SETTINGS_GROUPS.map((g) => g.key));
for (const section of SETTINGS_SECTIONS) {
  check(`${section.id} belongs to a real group`, groupKeys.has(section.group), section.group);
}
for (const group of SETTINGS_GROUPS) {
  check(
    `${group.label} has at least one section`,
    SETTINGS_SECTIONS.some((s) => s.group === group.key)
  );
}
const sectionIds = new Set<string>(SETTINGS_SECTIONS.map((s) => s.id));
check(
  "group anchors never collide with section anchors",
  SETTINGS_GROUPS.every((g) => !sectionIds.has(g.id))
);

console.log("\nintegrations dialog");
const tabIds: string[] = INTEGRATION_TABS.map((t) => t.id);
check("page ids are unique", new Set(tabIds).size === tabIds.length);
check("overview is the home view, not a page", !tabIds.includes(OVERVIEW));
const tabGroupKeys = new Set<string>(INTEGRATION_TAB_GROUPS.map((g) => g.key));
for (const tab of INTEGRATION_TABS) {
  check(`page "${tab.id}" is in a real group`, tabGroupKeys.has(tab.group), tab.group);
}
for (const section of SETTINGS_SECTIONS.filter((s) => s.group === "integrations")) {
  const tabs = INTEGRATION_TABS.filter((t) => "section" in t && t.section === section.id);
  check(`${section.id} has a dialog page`, tabs.length >= 1, `found ${tabs.length}`);
  const legacy = legacyHashTab(`#${section.id}`);
  check(
    `#${section.id} still opens one of its pages`,
    legacy !== null && tabs.some((t) => t.id === legacy),
    String(legacy)
  );
}
for (const tab of INTEGRATION_TABS) {
  if ("section" in tab) {
    const section = SETTINGS_SECTIONS.find((s) => s.id === tab.section);
    check(
      `page "${tab.id}" points at an Integrations section`,
      section?.group === "integrations",
      tab.section
    );
  } else {
    check(`page "${tab.id}" follows a real surface`, getSurface(tab.surface) !== undefined, tab.surface);
  }
  const resolved = resolveIntegrationParam(
    new URL(integrationHref(tab.id), "http://x").searchParams.get("integration")
  );
  check(`integrationHref("${tab.id}") round-trips`, resolved?.view === tab.id && resolved.focus === null);
}
check(
  "integrationHref(overview) round-trips",
  resolveIntegrationParam(new URL(integrationHref(OVERVIEW), "http://x").searchParams.get("integration"))
    ?.view === OVERVIEW
);
check(
  "Overview cards skip Advanced",
  OVERVIEW_TABS.length > 0 &&
    OVERVIEW_TABS.every((id) => INTEGRATION_TABS.find((t) => t.id === id)?.group !== "advanced")
);

console.log("\nold dialog ids");
// Links, bookmarks and consent screens already in flight still use these.
const OLD_IDS: Array<[string, string, string | null]> = [
  ["gmail", "google", "inbox"],
  ["outlook", "microsoft", null],
  ["calendar", "reminders", null],
  ["google", "google", null],
  ["linkedin", "linkedin", null],
  ["ai", "ai", null],
  ["api", "api", null],
  ["webhooks", "webhooks", null],
  ["outreach", "outreach", null],
];
for (const [old, view, focus] of OLD_IDS) {
  const r = resolveIntegrationParam(old);
  check(`?integration=${old} opens ${view}${focus ? ` at ${focus}` : ""}`, r?.view === view && r.focus === focus);
}
check("an unknown id opens nothing", resolveIntegrationParam("nope") === null);
check("empty opens nothing", resolveIntegrationParam("") === null && resolveIntegrationParam(null) === null);
check(
  "prototype keys are not ids",
  resolveIntegrationParam("constructor") === null && legacyHashTab("#toString") === null
);
check("the gmail link keeps its alias", integrationHref("gmail") === "/settings?integration=gmail");

console.log("\nsurface keys");
// Operator hide-lists are stored by these; renaming one silently un-hides its surface.
const FROZEN_SECTION_IDS = [
  "settings-profile",
  "settings-plan",
  "settings-appearance",
  "settings-notifications",
  "settings-goals",
  "settings-targets",
  "settings-ai",
  "settings-outreach",
  "settings-calendar",
  "settings-api",
  "settings-webhooks",
  "settings-knowledge",
  "settings-help",
  "settings-data",
];
check(
  "section ids are unchanged",
  SETTINGS_SECTIONS.map((s) => s.id).join(",") === FROZEN_SECTION_IDS.join(",")
);

console.log("\npage");
// Sections outside Integrations are rendered by the page itself, by id — as a card's anchor
// or as a `shows(...)` check around a row in a shared card. An id the page never mentions
// is a section nobody can reach.
const page = readFileSync("src/app/(clerk)/(app)/settings/page.tsx", "utf8");
for (const section of SETTINGS_SECTIONS.filter((s) => s.group !== "integrations")) {
  check(`page.tsx renders ${section.id}`, page.includes(`"${section.id}"`));
}

console.log("\nthe dialog renders every page");
// A page listed in `INTEGRATION_TABS` gets a nav row and a panel whichever way `Panel` is
// written; what it does not get, without a `case` of its own, is anything inside that panel.
// The switch has no `default`, so the page would open on nothing at all.
const DIALOG = "src/components/settings/integrations-dialog.tsx";
const panelCases = switchCasesIn(DIALOG, "Panel");
for (const tab of INTEGRATION_TABS) {
  check(`Panel renders "${tab.id}"`, panelCases.includes(tab.id));
}
check(
  "Panel renders nothing that isn’t a page",
  panelCases.every((id) => tabIds.includes(id)),
  panelCases.filter((id) => !tabIds.includes(id)).join(",")
);

console.log("\nevery import job belongs to a page");
// `tabForImportJob` is how a running import finds the nav row and the Overview card that say
// so. A kind it doesn't name gets no marker anywhere: the import runs, and the dialog is
// silent about it.
const jobKinds = unionMembers("src/lib/import-job-runner.ts", "ImportJobKind");
const jobCases = switchCasesIn(DIALOG, "tabForImportJob");
check("ImportJobKind still has kinds to check", jobKinds.length > 0, String(jobKinds.length));
for (const kind of jobKinds) {
  check(`tabForImportJob answers for "${kind}"`, jobCases.includes(kind));
}
check(
  "and answers for nothing that isn’t a kind",
  jobCases.every((kind) => jobKinds.includes(kind)),
  jobCases.filter((kind) => !jobKinds.includes(kind)).join(",")
);

if (failures > 0) {
  console.error(`\nsmoke-settings-layout: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-settings-layout: all ok");
process.exit(0);
