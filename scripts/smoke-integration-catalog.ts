/**
 * The Integrations catalog is a hand-ordered list of tiles over the connector registry. These
 * checks keep the two from drifting: a connector added to the registry has to be placed in the
 * catalog (or deliberately left out, below), a planned connector can never grow a Connect
 * button, and search reads the registry's aliases.
 */
import { CATALOG, matchesCatalogQuery } from "../src/components/settings/integration-catalog";
import { INTEGRATION_TABS } from "../src/components/settings/sections";
import { CONNECTORS, connectorById } from "../src/lib/connectors/registry";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Registry entries with no tile yet, and why. Remove one when its tile lands. */
const LEFT_OUT: Record<string, string> = {
  chat_exports: "its /imports row is surface-gated; gets a tile with its own dialog page",
};

const items = CATALOG.flatMap((g) => g.items);
const ids = items.map((i) => i.id);
const tabIds = new Set<string>(INTEGRATION_TABS.map((t) => t.id));

check("tile ids are unique", new Set(ids).size === ids.length, ids.join(","));
check(
  "every tile is a registry connector or a dialog page",
  ids.every((id) => connectorById(id) || tabIds.has(id)),
  ids.filter((id) => !connectorById(id) && !tabIds.has(id)).join(",")
);

const missing = CONNECTORS.filter((c) => !ids.includes(c.id) && !(c.id in LEFT_OUT)).map((c) => c.id);
check("every registry connector has a tile or a LEFT_OUT reason", missing.length === 0, missing.join(","));
check(
  "LEFT_OUT names only real, untiled connectors",
  Object.keys(LEFT_OUT).every((id) => connectorById(id) && !ids.includes(id))
);

const plannedMismatch = items.filter((i) => {
  const manifest = connectorById(i.id);
  if (!manifest) return "planned" in i.to;
  return (manifest.availability === "planned") !== "planned" in i.to;
});
check(
  "a tile is Coming soon exactly when its connector is planned",
  plannedMismatch.length === 0,
  plannedMismatch.map((i) => i.id).join(",")
);

check(
  "tab targets are real dialog pages",
  items.every((i) => !("tab" in i.to) || tabIds.has(i.to.tab))
);
check("every group has a tile", CATALOG.every((g) => g.items.length > 0));

const find = (q: string) => items.filter((i) => matchesCatalogQuery(i, q)).map((i) => i.id);
check("empty search shows everything", find("  ").length === items.length);
check("search reads aliases (icloud → Apple)", find("icloud").includes("apple_contacts"));
check("search is case-insensitive on labels", find("HUBSPOT").includes("hubspot"));
check("search with no match finds nothing", find("zzzz-no-such").length === 0);

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll integration catalog checks passed.");
process.exit(0);
