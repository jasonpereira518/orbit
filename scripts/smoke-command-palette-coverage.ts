/**
 * ⌘K must still match the app. `smoke-command-palette.ts` pins the matching rules; this pins
 * the catalog: that every place a person can go has a way to it from the palette, that every
 * link in it still lands somewhere real, and that every link's parameters are ones the page
 * reads.
 *
 * It exists because the palette was a hand-kept list that fell behind the app twice over:
 * pages that shipped after it (Find people, the per-account Integrations pages), and links
 * into places that had since moved (`?mode=structured`, a form tab that was replaced). The
 * catalog is now built from the nav, the settings sections and the Integrations tabs, and
 * this is what fails when a new one is added without being reachable, or a hand-written verb
 * points at something that no longer exists.
 *
 * Pure — reads source files, no database, no browser.
 *
 * Run: npx tsx scripts/smoke-command-palette-coverage.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAV } from "../src/components/layout/app-nav";
import {
  ACTIONS,
  INTEGRATIONS,
  PAGES,
  SETTINGS,
  type Command,
} from "../src/components/layout/command-palette-entries";
import {
  INTEGRATION_TABS,
  SETTINGS_SECTIONS,
  resolveIntegrationParam,
} from "../src/components/settings/sections";
import { CONTACT_SORTS, parseQuietDays } from "../src/lib/contacts-page";
import { isReminderView } from "../src/lib/reminders-page";
import { SURFACES, surfaceForPathname, surfaceKeyForSettingsId } from "../src/lib/surfaces";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
}

const ALL: Command[] = [...ACTIONS, ...PAGES, ...SETTINGS, ...INTEGRATIONS];
const pathOf = (href: string) => href.split(/[?#]/)[0]!;

/** Every URL the app serves: `page.tsx` files, route groups dropped. */
function appRoutes(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string, base: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const segment = /^\(.*\)$/.test(entry.name) ? "" : `/${entry.name}`;
        walk(join(dir, entry.name), base + segment);
      } else if (entry.name === "page.tsx") {
        out.add(base || "/");
      }
    }
  };
  walk(join(__dirname, "..", "src", "app"), "");
  return out;
}
const routes = appRoutes();
const nextConfig = readFileSync(join(__dirname, "..", "next.config.ts"), "utf8");
/** A path that redirects (next.config.ts) still lands somewhere; the palette may use its old name. */
const redirects = new Set(
  [...nextConfig.matchAll(/source:\s*"(\/[a-z0-9-]+)"\s*,\s*destination:/g)].map((m) => m[1]!)
);
const lands = (path: string) => routes.has(path) || redirects.has(path);

console.log("Catalog shape");
const ids = ALL.map((c) => c.id);
check("every entry id is unique", new Set(ids).size === ids.length, ids.filter((id, i) => ids.indexOf(id) !== i).join(", "));
check(
  "an entry either links or is a verb — never both, never neither",
  ALL.every((c) => Boolean(c.href) !== Boolean(c.verb)),
  ALL.filter((c) => Boolean(c.href) === Boolean(c.verb)).map((c) => c.id).join(", ")
);
check(
  "a verb names the surface that gates it (it has no page to be hidden by)",
  ALL.filter((c) => c.verb).every((c) => Boolean(c.surface)),
  ALL.filter((c) => c.verb && !c.surface).map((c) => c.id).join(", ")
);

console.log("\nEvery link lands on a real page");
const dead = ALL.filter((c) => c.href && !lands(pathOf(c.href)));
check("every href is a page the app serves, or a redirect it keeps", dead.length === 0, dead.map((c) => `${c.id} → ${c.href}`).join(", "));

console.log("\nEvery parameter is one the page reads");
const CAPTURE_MODES = new Set(["messy", "voice", "cloud", "library", "imports"]);
/** The Outreach hub's tabs (`unified-outreach-hub.tsx`). */
const OUTREACH_TABS = new Set(["discover", "campaigns", "integrations"]);
const CONTACT_SORT_VALUES = new Set<string>(CONTACT_SORTS.map((s) => s.value));
const settingsIds = new Set<string>(SETTINGS_SECTIONS.map((s) => s.id));
const problems: string[] = [];
for (const c of ALL) {
  if (!c.href) continue;
  const url = new URL(c.href, "http://orbit.test");
  const q = url.searchParams;
  const path = url.pathname;
  const bad = (why: string) => problems.push(`${c.id} (${c.href}): ${why}`);
  if (path === "/capture") {
    const mode = q.get("mode");
    if (mode !== null && !CAPTURE_MODES.has(mode)) bad(`capture has no mode "${mode}"`);
  } else if (path === "/outreach") {
    const tab = q.get("tab");
    if (tab !== null && !OUTREACH_TABS.has(tab)) bad(`outreach has no tab "${tab}"`);
  } else if (path === "/reminders") {
    const view = q.get("view");
    if (view !== null && !isReminderView(view)) bad(`reminders has no view "${view}"`);
  } else if (path === "/contacts") {
    const followUp = q.get("followUp");
    if (followUp !== null && followUp !== "due") bad(`followUp only takes "due"`);
    const quiet = q.get("quiet");
    if (quiet !== null && parseQuietDays(quiet) === null) bad(`quiet ${quiet} is not an offered threshold`);
    const sort = q.get("sort");
    if (sort !== null && !CONTACT_SORT_VALUES.has(sort)) bad(`contacts has no sort "${sort}"`);
  } else if (path === "/settings") {
    const hash = url.hash.replace(/^#/, "");
    if (hash && !settingsIds.has(hash)) bad(`settings has no section "${hash}"`);
    const integration = q.get("integration");
    if (integration !== null && resolveIntegrationParam(integration) === null) bad(`no Integrations page "${integration}"`);
  }
}
check("every deep link carries parameters its page understands", problems.length === 0, problems.join("; "));
check(
  "nothing links to the retired capture form tab",
  !ALL.some((c) => c.href?.includes("mode=structured"))
);

console.log("\nEvery page, section and account has a way in");
const navMissing = APP_NAV.filter((n) => !PAGES.some((p) => p.id === `page:${n.href}`));
check("every sidebar destination is a Go to entry", navMissing.length === 0, navMissing.map((n) => n.href).join(", "));

// Any entry that lands on the page counts: Imports has no Go to row because "Import contacts"
// is the better door to it, and that is fine — what must not happen is a page with none.
const pageSurfaces = SURFACES.filter((s) => s.kind === "page" && s.href);
// A page that only redirects (`/find` → the Outreach discover tab) is reached by an entry that
// names its surface instead of its URL.
const unreachable = pageSurfaces.filter(
  (s) => !ALL.some((c) => c.surface === s.key || (c.href && pathOf(c.href) === s.href))
);
check(
  "every page the operator can hide is reachable from the palette",
  unreachable.length === 0,
  unreachable.map((s) => `${s.key} (${s.href})`).join(", ")
);

const sectionMissing = SETTINGS_SECTIONS.filter(
  (s) =>
    !SETTINGS.some((c) => c.settingsId === s.id) &&
    !INTEGRATIONS.some((c) => c.surface === surfaceKeyForSettingsId(s.id))
);
check("every settings section is findable", sectionMissing.length === 0, sectionMissing.map((s) => s.id).join(", "));

const tabMissing = INTEGRATION_TABS.filter((t) => {
  const entry = INTEGRATIONS.find((c) => c.id === `integration:${t.id}`);
  if (!entry?.href) return true;
  return resolveIntegrationParam(new URL(entry.href, "http://orbit.test").searchParams.get("integration"))?.view !== t.id;
});
check("every Integrations page has an entry that opens exactly that page", tabMissing.length === 0, tabMissing.map((t) => t.id).join(", "));

console.log("\nHiding a surface can remove every entry that leads to it");
const ungated = ALL.filter((c) => {
  if (c.verb || c.surface || c.settingsId) return false;
  const path = pathOf(c.href!);
  // /pricing is the one public page here: it has no surface, and nothing to hide.
  return path !== "/pricing" && surfaceForPathname(path) === null;
});
check("every link lands on a surface, names one, or is deliberately public", ungated.length === 0, ungated.map((c) => `${c.id} → ${c.href}`).join(", "));

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-command-palette-coverage: all checks passed");
process.exit(0);
