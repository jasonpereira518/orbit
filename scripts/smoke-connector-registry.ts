/**
 * The registry is the single source of truth for connectors. These checks are the reason a
 * new connector cannot be half-registered: every manifest entry must be internally
 * consistent, ids must be unique because they are used as database discriminators, and the
 * three things a manifest promises about OTHER modules — an entitlement the plan layer gates
 * on, a rate bucket the limiter knows, a purge category that erases the connector's rows —
 * are checked against those modules rather than against a second copy of their contents here.
 *
 * pglite tier, though it touches no table: `entitlements.ts` and `rate-limit.ts` both reach
 * `@/db` transitively, and a cross-module guarantee that compares against a hand-copied
 * literal list is exactly the drift it claims to prevent. The preamble forces a throwaway
 * PGlite so importing them can never point at Neon.
 */
import "./smoke/_env";
import { DATA_CATEGORY_META } from "../src/lib/data-categories";
import { FEATURE_KEYS, type FeatureKey } from "../src/lib/entitlements";
import { RATE_LIMITS } from "../src/lib/rate-limit";
import {
  CONNECTORS,
  connectorById,
  connectorsByFamily,
  isSyncable,
  syncableConnectors,
  type ConnectorManifest,
} from "../src/lib/connectors/registry";
import { CONNECTOR_SYNCS, resolveConnectorWithSync } from "../src/lib/connectors/syncs";
import { HUBSPOT_SCOPES } from "../src/lib/crm/hubspot/mapping";

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

// What the label promises, tested on what the label names. The previous version iterated
// EVERY capability, reads included, so it passed on a registry whose writes were all reads —
// and `read()` supplies `scopes` too, so the reads were carrying the check. Writes are the
// ones that matter: a write capability is consent the user has to grant separately, and a
// write whose extra scopes are unstated is a connect flow that asks for too little and a
// `deliver` that 403s at the far end.
const writeCaps = CONNECTORS.flatMap((c) =>
  c.capabilities.filter((cap) => cap.direction === "write").map((cap) => ({ c, cap }))
);
check("the registry has write capabilities to check at all", writeCaps.length > 0, String(writeCaps.length));
check(
  "every write capability states its scopes (possibly none)",
  writeCaps.every(({ cap }) => Array.isArray(cap.scopes)),
  writeCaps.filter(({ cap }) => !Array.isArray(cap.scopes)).map(({ c, cap }) => `${c.id}.${cap.id}`).join(",")
);

check(
  "planned connectors declare no sync",
  CONNECTORS.every((c) => c.availability !== "planned" || c.sync === undefined)
);

// The rule itself, tested on manifests the catalog does not contain. Every assertion about
// `syncableConnectors()`'s OUTPUT is vacuous while P0 ships no `sync` at all — the old check
// re-asserted the function's own filter about its own result, which is true for any filter
// forever, and inverting the filter to `"planned"` still passed. `isSyncable` takes a
// manifest, so the inversion fails here.
const stub = (over: Partial<ConnectorManifest>): ConnectorManifest => ({
  id: "stub",
  label: "Stub",
  family: "crm",
  auth: "oauth2",
  availability: "available",
  entitlement: "sync",
  rateBucket: null,
  purgeCategory: "connections",
  capabilities: [{ id: "syncPeople", label: "Stub", direction: "read", scopes: [] }],
  ...over,
});
const noop = async () => {};
check("an available connector with a sync is syncable", isSyncable(stub({ sync: noop })));
check("a planned connector with a sync is NOT syncable", !isSyncable(stub({ availability: "planned", sync: noop })));
check("an available connector without a sync is NOT syncable", !isSyncable(stub({})));

const syncable = syncableConnectors();
check(
  "the catalog's syncable set is exactly the entries the predicate accepts",
  syncable.length === CONNECTORS.filter(isSyncable).length && syncable.every((c) => CONNECTORS.includes(c)),
  `${syncable.length} of ${CONNECTORS.length}`
);
// Sync functions never live on the registry's own entries: a sync reaches the database, and
// this file must stay loadable from a client component. They are attached by
// `resolveConnectorWithSync` in `./syncs.ts`, which only the scheduler and actions import.
check(
  "the registry's own entries carry no sync function (they live in syncs.ts)",
  syncable.length === 0,
  syncable.map((c) => c.id).join(",")
);

check("connectorById finds a known id", connectorById("google") !== null);
check("connectorById rejects an unknown id", connectorById("nope") === null);
check("connectorsByFamily partitions the registry", CONNECTORS.every((c) => connectorsByFamily(c.family).includes(c)));

// --- The three cross-module promises -------------------------------------------------------

// Against `entitlements.ts` itself, not a literal copy of its keys. The old check compared
// against `["sync", "api", "extension", "recruiters", null]` written out here, so a feature
// key renamed or removed in the plan layer left this green and the gate silently unreachable.
check(
  "every connector names an entitlement the plan layer knows",
  CONNECTORS.every((c) => c.entitlement === null || (FEATURE_KEYS as readonly string[]).includes(c.entitlement)),
  CONNECTORS.filter((c) => c.entitlement !== null && !(FEATURE_KEYS as readonly string[]).includes(c.entitlement))
    .map((c) => `${c.id}:${c.entitlement}`)
    .join(",")
);
// The compile-time half of the same promise: `ConnectorManifest.entitlement` is typed
// `FeatureKey | null`, so a bogus value is a tsc error before it is a failing check.
const _entitlementsAreFeatureKeys: readonly (FeatureKey | null)[] = CONNECTORS.map((c) => c.entitlement);
void _entitlementsAreFeatureKeys;

// A rate bucket that does not exist in RATE_LIMITS is a `consumeBucket` call that throws on
// the first sync run — named in the spec's own P0 verification bullet, and missing here.
const buckets = Object.keys(RATE_LIMITS);
check(
  "every connector's rate bucket exists in RATE_LIMITS",
  CONNECTORS.every((c) => c.rateBucket === null || buckets.includes(c.rateBucket)),
  CONNECTORS.filter((c) => c.rateBucket !== null && !buckets.includes(c.rateBucket))
    .map((c) => `${c.id}:${c.rateBucket}`)
    .join(",")
);
// Not vacuous the other way either: a connector that makes an outbound call per sync must
// name one. Every `available` connector with a `syncEvents`/`syncPeople` read either polls a
// provider or does not; the ones that do are the ones with a bucket, and this pins that at
// least one entry exercises the check above.
check(
  "and at least one connector actually names a bucket",
  CONNECTORS.some((c) => c.rateBucket !== null),
  CONNECTORS.map((c) => `${c.id}:${c.rateBucket}`).join(",")
);

// The purge category: which of `DATA_CATEGORY_META`'s units erases this connector's rows.
// `smoke-purge` proves every TABLE is registered; this proves every CONNECTOR names the
// category that takes it, which is the question a P1 author adding a credential store has to
// answer and the one nothing asked before.
const categoryIds = DATA_CATEGORY_META.map((m) => m.id);
check(
  "every connector names a real purge category",
  CONNECTORS.every((c) => categoryIds.includes(c.purgeCategory)),
  CONNECTORS.filter((c) => !categoryIds.includes(c.purgeCategory)).map((c) => `${c.id}:${c.purgeCategory}`).join(",")
);
// Anything whose credential lives in `connector_connections` — every auth kind `./connections.ts`
// can claim — goes with the `connections` category, because that is the step that deletes that
// table. A new connector on one of these auth kinds that names something else is claiming its
// encrypted token survives an account deletion it does not survive.
const GENERIC_STORE_AUTH = ["oauth2", "api_key", "dav_password"];
const genericStore = CONNECTORS.filter((c) => GENERIC_STORE_AUTH.includes(c.auth));
check("there are connector_connections-backed connectors to check", genericStore.length > 0, String(genericStore.length));
check(
  "a connector_connections credential is purged with the connections category",
  genericStore.every((c) => c.purgeCategory === "connections"),
  genericStore.filter((c) => c.purgeCategory !== "connections").map((c) => `${c.id}:${c.purgeCategory}`).join(",")
);
// Luma and Eventbrite are the reason `event_provider` exists as an auth kind: both live in
// `event_provider_connections` (src/lib/events/connections.ts), NOT in `connector_connections`,
// and registering Eventbrite as `oauth2` told a P1 author to build it a second credential store.
// The same pairing for the other stores: an `orbit_api_key` connector holds one of Orbit's
// own keys (`api_keys` → the `api` category) and a `settings_key` one holds a provider key on
// `user_settings` (→ `preferences`). Both used to be registered `api_key`/`api_token`, which
// said "connector_connections" and meant "somewhere else entirely" — the Eventbrite mistake
// with two more instances.
const STORE_CATEGORY: Record<string, string> = {
  orbit_api_key: "api",
  settings_key: "preferences",
  event_provider: "connections",
  provider_oauth: "connections",
  ics_url: "connections",
};
const elsewhere = CONNECTORS.filter((c) => c.auth in STORE_CATEGORY);
check(
  "every other credential store names the category that actually erases it",
  elsewhere.every((c) => c.purgeCategory === STORE_CATEGORY[c.auth]),
  elsewhere
    .filter((c) => c.purgeCategory !== STORE_CATEGORY[c.auth])
    .map((c) => `${c.id}:${c.auth}→${c.purgeCategory}`)
    .join(",")
);

check(
  "the event-provider connectors are not registered as generic-store auth kinds",
  ["luma", "eventbrite"].every((id) => connectorById(id)?.auth === "event_provider"),
  ["luma", "eventbrite"].map((id) => `${id}:${connectorById(id)?.auth}`).join(",")
);

console.log("\nthe server-only sync resolver");
const stubSync = async () => {};
check(
  "a connector with no registered sync resolves without one",
  resolveConnectorWithSync("google", {})?.sync === undefined
);
check(
  "an available connector with a registered sync resolves with it",
  resolveConnectorWithSync("google", { google: stubSync })?.sync === stubSync
);
check(
  "a planned connector never gets a sync, even if one is registered",
  resolveConnectorWithSync("notion", { notion: stubSync })?.sync === undefined
);
check("an unknown id resolves to null", resolveConnectorWithSync("nope", {}) === null);
const GENERIC = ["oauth2", "api_key", "dav_password"];
check(
  "every registered sync belongs to an available connections-table connector",
  Object.keys(CONNECTOR_SYNCS).every((id) => {
    const m = connectorById(id);
    return m !== null && m.availability === "available" && GENERIC.includes(m.auth);
  }),
  Object.keys(CONNECTOR_SYNCS).join(",")
);

check(
  "HubSpot is gated on the crm entitlement, not sync",
  connectorById("hubspot")?.entitlement === "crm",
  String(connectorById("hubspot")?.entitlement)
);
check(
  "HubSpot's syncPeople asks for exactly the scopes the sync uses",
  JSON.stringify(connectorById("hubspot")?.capabilities.find((c) => c.id === "syncPeople")?.scopes) === JSON.stringify([...HUBSPOT_SCOPES])
);
check(
  "HubSpot lists only what P4 really does (reads people)",
  JSON.stringify(connectorById("hubspot")?.capabilities.map((c) => c.id)) === JSON.stringify(["syncPeople"])
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll connector registry checks passed.");
process.exit(0);
