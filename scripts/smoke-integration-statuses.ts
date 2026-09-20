/**
 * Every registered connector must be answerable by the status action, or the dialog renders
 * a card with no state — the exact drift the registry exists to prevent.
 */
import { CONNECTORS } from "../src/lib/connectors/registry";
import { CONNECTOR_STATUS_LOOKUP_IDS } from "../src/lib/connectors/status";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

for (const connector of CONNECTORS) {
  const has = (CONNECTOR_STATUS_LOOKUP_IDS as readonly string[]).includes(connector.id);
  if (connector.availability === "planned") {
    check(`${connector.id}: planned connectors need no lookup`, !has);
    continue;
  }
  check(`${connector.id}: has a status lookup`, has);
}

for (const id of CONNECTOR_STATUS_LOOKUP_IDS) {
  check(`${id}: the lookup names a registered connector`, CONNECTORS.some((c) => c.id === id));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll integration status checks passed.");
process.exit(0);
