/**
 * The registry is the single source of truth for connectors. These checks are the reason a
 * new connector cannot be half-registered: every manifest entry must be internally
 * consistent, and ids must be unique because they are used as database discriminators.
 */
import {
  CONNECTORS,
  connectorById,
  connectorsByFamily,
  syncableConnectors,
} from "../src/lib/connectors/registry";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const ids = CONNECTORS.map((c) => c.id);
check("ids are unique", new Set(ids).size === ids.length, ids.join(","));
check("every connector has at least one capability", CONNECTORS.every((c) => c.capabilities.length > 0));
check(
  "capability ids are unique within a connector",
  CONNECTORS.every((c) => new Set(c.capabilities.map((cap) => cap.id)).size === c.capabilities.length)
);
check(
  "write capabilities declare scopes or need none",
  CONNECTORS.every((c) => c.capabilities.every((cap) => Array.isArray(cap.scopes)))
);
check(
  "planned connectors declare no sync",
  CONNECTORS.every((c) => c.availability !== "planned" || c.sync === undefined)
);
check(
  "syncable connectors are available and have a sync fn",
  syncableConnectors().every((c) => c.availability === "available" && typeof c.sync === "function")
);
check("connectorById finds a known id", connectorById("google") !== null);
check("connectorById rejects an unknown id", connectorById("nope") === null);
check("connectorsByFamily partitions the registry", CONNECTORS.every((c) => connectorsByFamily(c.family).includes(c)));
check(
  "every connector names an entitlement the plan layer knows",
  CONNECTORS.every((c) => ["sync", "api", "extension", "recruiters", null].includes(c.entitlement))
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll connector registry checks passed.");
process.exit(0);
