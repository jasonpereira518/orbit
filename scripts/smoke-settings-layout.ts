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
  INTEGRATION_TAB_FOR_LEGACY_HASH,
  INTEGRATION_TABS,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  integrationHref,
  isIntegrationTabId,
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
const tabIds = INTEGRATION_TABS.map((t) => t.id);
check("tab ids are unique", new Set(tabIds).size === tabIds.length);
for (const section of SETTINGS_SECTIONS.filter((s) => s.group === "integrations")) {
  const tabs = INTEGRATION_TABS.filter((t) => "section" in t && t.section === section.id);
  check(`${section.id} has exactly one dialog tab`, tabs.length === 1, `found ${tabs.length}`);
  check(
    `#${section.id} still opens its tab`,
    INTEGRATION_TAB_FOR_LEGACY_HASH[section.id] === tabs[0]?.id
  );
}
for (const tab of INTEGRATION_TABS) {
  if ("section" in tab) {
    const section = SETTINGS_SECTIONS.find((s) => s.id === tab.section);
    check(
      `tab "${tab.id}" points at an Integrations section`,
      section?.group === "integrations",
      tab.section
    );
  } else {
    check(`tab "${tab.id}" follows a real surface`, getSurface(tab.surface) !== undefined, tab.surface);
  }
  check(
    `integrationHref("${tab.id}") round-trips`,
    isIntegrationTabId(new URL(integrationHref(tab.id), "http://x").searchParams.get("integration"))
  );
}

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
