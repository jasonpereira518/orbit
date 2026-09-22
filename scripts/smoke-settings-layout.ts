/**
 * The settings page's structure: five groups, every section in one of them, and the
 * Integrations group fully covered by the dialog's tabs.
 *
 * What it guards against is a section silently vanishing. A section added to
 * `SETTINGS_SECTIONS` with `group: "integrations"` but no dialog tab would be hideable in the
 * admin console and appear nowhere; one in any other group that `page.tsx` never renders
 * would do the same. Neither fails a type check.
 *
 * Run: npx tsx scripts/smoke-settings-layout.ts
 */
import { readFileSync } from "node:fs";
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

if (failures > 0) {
  console.error(`\nsmoke-settings-layout: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-settings-layout: all ok");
process.exit(0);
