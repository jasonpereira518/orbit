# Integrations P0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the connector foundation — a registry, a generic connections table, a people-sync stream, a write-back outbox, a reusable OAuth2 helper and the API routes Shortcuts/Obsidian/Zapier need — so that every connector in the strategy spec is a manifest entry plus a fetcher/mapper rather than a new subsystem.

**Architecture:** Nothing here replaces the existing spine. `src/lib/ingest/events.ts` keeps writing interactions, `src/lib/import-engine.ts` keeps handling uploaded files, and `gmail_connections` / `outlook_connections` stay exactly as they are. P0 adds a parallel set of primitives for the ~20 connectors that are not Google or Microsoft: one `connector_connections` table shaped like `event_provider_connections`, a `ConnectorManifest` registry that the scheduler and the settings status action both read, a `people` ingest stream that mirrors `ingestEvents` for delta-token contact sources, and a `connector_outbox` modelled on `outbound_webhook_deliveries`.

**Tech Stack:** Next.js App Router (see `AGENTS.md` — read `node_modules/next/dist/docs/` before writing route code), TypeScript, Drizzle ORM over `neon-http` in production and PGlite locally, zod for API bodies, smoke scripts (`scripts/smoke-*.ts`, run by `scripts/run-smoke.ts`) as the test system. There is no jest/vitest in this repo.

**Spec:** `docs/superpowers/specs/2026-09-19-integrations-strategy-design.md` (section "Foundation work (Phase 0)"). Its companion `docs/superpowers/specs/2026-09-19-integrations-ui-design.md` consumes the registry this plan builds but is a separate plan.

## Global Constraints

- **Schema versions:** this plan claims **74** (Task 2) and **75** (Task 7). 71–73 are already taken on other branches (`claude/ai-api-optimization` = 72, `claude/mcp-server-vision-5e9a07` = 73), checked 2026-09-19. **Re-run the branch scan before each bump** (command in Task 2, Step 1); six silent collisions are recorded in the changelog above `SCHEMA_VERSION` in `src/db/index.ts:1595`.
- **Never run `drizzle-kit push`** (`npm run db:push:DANGEROUS`). It drops the runtime-created `contact_embeddings.embedding_vector` column. All DDL is hand-written in `src/db/index.ts`.
- **Every new table must be registered in the purge registry** (`src/lib/user-data.ts` `STEPS`) or `scripts/smoke-purge.ts` fails the whole suite — it derives its list from `schema.ts`.
- **Every new smoke script must be added to `MANIFEST` in `scripts/run-smoke.ts:29`** with a tier, or the runner exits 2 before anything runs. `pglite`/`manual` tier scripts must start with `import "./smoke/_env";`; `pure` tier scripts must not import `../src/db`.
- **`alters` entries are single-line template literals with no trailing semicolon** (PGlite's extended query protocol rejects multi-command statements). The same index must be written in both the `DDL` template and `alters`.
- **No `next/server` or `next/cache` import** in `src/lib/connectors/*`, `src/lib/ingest/*`, `src/lib/provider-connections.ts` or anything the scheduler loads: importing `next/server` retains the Node event loop and hangs every `tsx` script.
- **tsx scripts need an explicit `process.exit(0)`** — use the `run()` helper from `scripts/smoke/_env.ts`.
- **A non-async export in a `"use server"` file kills every export in it.** `tsc` cannot see this.
- Baseline: the build passes and eslint is 0 errors / ~36 warnings. Any error is yours.
- Toast/user-facing copy goes through `friendlyError` / `UserFacingError`; `scripts/smoke-toast-copy.ts` enforces the voice repo-wide.

---

### Task 1: The connector registry

**Files:**
- Create: `src/lib/connectors/registry.ts`
- Create: `scripts/smoke-connector-registry.ts`
- Modify: `scripts/run-smoke.ts:29` (MANIFEST)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `ConnectorId`, `ConnectorFamily`, `ConnectorAuthKind`, `ConnectorCapabilityId`, `ConnectorCapability`, `ConnectorManifest`, `CONNECTORS: readonly ConnectorManifest[]`, `connectorById(id): ConnectorManifest | null`, `connectorsByFamily(family): ConnectorManifest[]`, `syncableConnectors(): ConnectorManifest[]`. Tasks 3, 4, 8 and 9 read these.

This file is **pure metadata**: no `@/db` import, no `next/*` import. Both a client component (the settings dialog, later) and the scheduler load it, and a client component that reaches `@/db` fails the build with a `node:fs` chunking error naming neither file.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-connector-registry.ts`:

```ts
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
check(
  "connectorsByFamily partitions the registry",
  CONNECTORS.length ===
    new Set(CONNECTORS.map((c) => c.family)).size > 0
      ? CONNECTORS.every((c) => connectorsByFamily(c.family).includes(c))
      : false
);
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
```

Register it in `scripts/run-smoke.ts`, in the `// pure` block of `MANIFEST`:

```ts
  "smoke-connector-registry": "pure",
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-connector-registry.ts`
Expected: FAIL — `Cannot find module '../src/lib/connectors/registry'`.

- [ ] **Step 3: Write the registry**

Create `src/lib/connectors/registry.ts`:

```ts
/**
 * Every connector Orbit offers, as data.
 *
 * The scheduler, the settings status action, the integrations dialog, the account alerts and
 * the purge registry all derive from this list rather than each keeping their own. Before it
 * existed, `runSyncPass` hardcoded three sync families, `INTEGRATION_TABS` hardcoded nine
 * tabs and `getIntegrationStatuses` hardcoded six lookups — three lists that drifted
 * independently, which is the drift `sections.ts` already warns about in its own header.
 *
 * Deliberately free of `@/db` and `next/*` imports: a client component renders this catalog,
 * and a client component that reaches `@/db` fails the build with a `node:fs` chunking error
 * that names neither file. The sync function is a dynamic import for the same reason — the
 * manifest can be loaded without pulling a database driver into the browser bundle.
 */

export type ConnectorFamily =
  | "people"
  | "conversations"
  | "calendar"
  | "tasks"
  | "knowledge"
  | "crm"
  | "events"
  | "enrichment"
  | "automation";

/**
 * How Orbit holds the credential.
 *
 * `provider_oauth` means the connection lives in `gmail_connections` / `outlook_connections`
 * and is reached through `provider-connections.ts`; `oauth2` means it lives in the generic
 * `connector_connections` table. The distinction is historical and deliberate — see that
 * module's header for why the two legacy tables are not being migrated.
 */
export type ConnectorAuthKind =
  | "provider_oauth"
  | "oauth2"
  | "api_key"
  | "dav_password"
  | "ics_url"
  | "file"
  | "extension"
  | "api_token"
  | "none";

export type ConnectorCapabilityId =
  | "importContacts"
  | "syncPeople"
  | "syncEvents"
  | "writeTasks"
  | "logActivity"
  | "writeContact"
  | "enrich";

export type ConnectorCapability = {
  id: ConnectorCapabilityId;
  label: string;
  /** Reads are enabled at connect time; writes stay off until the user turns them on. */
  direction: "read" | "write";
  /** Extra scopes this capability needs. Empty when the base connection already covers it. */
  scopes: string[];
};

export type ConnectorManifest = {
  id: string;
  label: string;
  family: ConnectorFamily;
  auth: ConnectorAuthKind;
  capabilities: ConnectorCapability[];
  /** `planned` renders as a Request card and never syncs. */
  availability: "available" | "planned";
  /** The entitlement flag name in `src/lib/entitlements.ts`, or null for always-on. */
  entitlement: "sync" | "api" | "extension" | "recruiters" | null;
  /** The `RATE_LIMITS` bucket a sync run consumes, or null when it makes no outbound call. */
  rateBucket: "providerSync" | "eventEnrich" | null;
  /** Search aliases so "iCloud" finds Apple Contacts and "Teams" finds Outlook Calendar. */
  aliases?: string[];
  /**
   * One sync pass for one connection. Dynamically imported by the scheduler so this module
   * stays loadable from a client component.
   */
  sync?: (connectionId: string) => Promise<void>;
};

const read = (id: ConnectorCapabilityId, label: string, scopes: string[] = []): ConnectorCapability => ({
  id,
  label,
  direction: "read",
  scopes,
});
const write = (id: ConnectorCapabilityId, label: string, scopes: string[] = []): ConnectorCapability => ({
  id,
  label,
  direction: "write",
  scopes,
});

/**
 * Registered connectors, in catalog order.
 *
 * Everything already shipped is registered as `available` with the capabilities it really
 * has today — the registry describes reality, not the roadmap, and a `planned` entry is the
 * only place the roadmap appears.
 */
export const CONNECTORS: readonly ConnectorManifest[] = [
  {
    id: "google",
    label: "Google",
    family: "people",
    auth: "provider_oauth",
    availability: "available",
    entitlement: "sync",
    rateBucket: "providerSync",
    aliases: ["gmail", "google contacts", "google calendar"],
    capabilities: [
      read("importContacts", "Import Google Contacts", ["https://www.googleapis.com/auth/contacts.readonly"]),
      read("syncEvents", "Keep calendar meetings in sync", ["https://www.googleapis.com/auth/calendar.readonly"]),
    ],
  },
  {
    id: "outlook",
    label: "Outlook",
    family: "people",
    auth: "provider_oauth",
    availability: "available",
    entitlement: "sync",
    rateBucket: "providerSync",
    aliases: ["microsoft", "office", "outlook people"],
    capabilities: [read("importContacts", "Import Outlook contacts", ["Contacts.Read"])],
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    family: "people",
    auth: "file",
    availability: "available",
    entitlement: null,
    rateBucket: null,
    capabilities: [read("importContacts", "Import a connections export")],
  },
  {
    id: "calendar_ics",
    label: "Calendar subscription",
    family: "calendar",
    auth: "ics_url",
    availability: "available",
    entitlement: "sync",
    rateBucket: null,
    aliases: ["ics", "webcal"],
    capabilities: [read("syncEvents", "Log meetings from a calendar feed")],
  },
  {
    id: "luma",
    label: "Luma",
    family: "events",
    auth: "api_key",
    availability: "available",
    entitlement: "sync",
    rateBucket: "eventEnrich",
    capabilities: [read("syncEvents", "Import events and guest lists")],
  },
  {
    id: "eventbrite",
    label: "Eventbrite",
    family: "events",
    auth: "oauth2",
    availability: "available",
    entitlement: "sync",
    rateBucket: "eventEnrich",
    capabilities: [read("syncEvents", "Import events and attendees")],
  },
  {
    id: "apollo",
    label: "Apollo",
    family: "enrichment",
    auth: "api_key",
    availability: "available",
    entitlement: null,
    rateBucket: null,
    capabilities: [read("enrich", "Look up work history and contact details")],
  },
  {
    id: "zapier",
    label: "Zapier & Make",
    family: "automation",
    auth: "api_token",
    availability: "available",
    entitlement: "api",
    rateBucket: null,
    aliases: ["make", "n8n", "webhooks"],
    capabilities: [
      read("syncEvents", "Send events into Orbit"),
      write("logActivity", "Send Orbit events out"),
    ],
  },
  {
    id: "apple_contacts",
    label: "Apple Contacts",
    family: "people",
    auth: "dav_password",
    availability: "planned",
    entitlement: "sync",
    rateBucket: "providerSync",
    aliases: ["icloud", "carddav"],
    capabilities: [read("syncPeople", "Keep iCloud contacts in sync")],
  },
  {
    id: "apple_calendar",
    label: "Apple Calendar",
    family: "calendar",
    auth: "dav_password",
    availability: "planned",
    entitlement: "sync",
    rateBucket: "providerSync",
    aliases: ["icloud", "caldav"],
    capabilities: [read("syncEvents", "Log meetings from iCloud Calendar")],
  },
  {
    id: "apple_reminders",
    label: "Apple Reminders",
    family: "tasks",
    auth: "api_token",
    availability: "planned",
    entitlement: "api",
    rateBucket: null,
    aliases: ["shortcuts", "icloud"],
    capabilities: [write("writeTasks", "Create a reminder for each follow-up")],
  },
  {
    id: "hubspot",
    label: "HubSpot",
    family: "crm",
    auth: "oauth2",
    availability: "planned",
    entitlement: "sync",
    rateBucket: "providerSync",
    capabilities: [
      read("syncPeople", "Import the contacts you own"),
      read("syncEvents", "Import logged engagements"),
      write("logActivity", "Log Orbit interactions on the matching record"),
      write("writeContact", "Create a HubSpot contact"),
    ],
  },
  {
    id: "notion",
    label: "Notion",
    family: "knowledge",
    auth: "oauth2",
    availability: "planned",
    entitlement: "sync",
    rateBucket: "providerSync",
    capabilities: [
      read("importContacts", "Import a people database"),
      write("writeContact", "Mirror contacts into a Notion database"),
    ],
  },
] as const;

export type ConnectorId = (typeof CONNECTORS)[number]["id"];

export function connectorById(id: string): ConnectorManifest | null {
  return CONNECTORS.find((c) => c.id === id) ?? null;
}

export function connectorsByFamily(family: ConnectorFamily): ConnectorManifest[] {
  return CONNECTORS.filter((c) => c.family === family);
}

/** Connectors the scheduler may claim. `planned` entries never have a sync function. */
export function syncableConnectors(): ConnectorManifest[] {
  return CONNECTORS.filter((c) => c.availability === "available" && typeof c.sync === "function");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/smoke-connector-registry.ts`
Expected: PASS — "All connector registry checks passed."

Then: `npm run test:check`
Expected: no problems (the script is in the manifest).

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/connectors/registry.ts scripts/smoke-connector-registry.ts scripts/run-smoke.ts
git commit -m "Add the connector registry: every connector as one manifest entry"
```

---

### Task 2: The generic `connector_connections` table (schema v74)

**Files:**
- Modify: `src/db/schema.ts` (new table near `eventProviderConnections` at :4044)
- Modify: `src/db/index.ts` (the `DDL` template at :38, `alters` at :2710, the changelog + `SCHEMA_VERSION` at :1595)
- Modify: `src/lib/user-data.ts` (the `connections` step at :252)
- Create: `scripts/smoke-connector-connections.ts`
- Modify: `scripts/run-smoke.ts:29` (MANIFEST)
- Modify: `scripts/schema-ddl.lock.json` (regenerated, never hand-edited)

**Interfaces:**
- Consumes: nothing from Task 1 (the table is independent of the manifest).
- Produces: `connectorConnections` (Drizzle table), `ConnectorConnection` (`$inferSelect`), `ConnectorSyncCursor`. Task 3 reads all three.

- [ ] **Step 1: Re-check the free schema version**

```bash
bash -c 'for b in $(git branch -a --format="%(refname)" | grep -v HEAD); do v=$(git show "${b}:src/db/index.ts" 2>/dev/null | grep -m1 "^export const SCHEMA_VERSION" | grep -oE "[0-9]+"); [ -n "$v" ] && echo "$v $b"; done | sort -rn | head -6'
```

Expected on 2026-09-19: `73` is the highest, so this task takes **74**. If something above 73 appears, take the next free number and use it everywhere below instead. Note the `$b:...` form must run under `bash -c` — in zsh, `$b:src/...` fires a history modifier and every iteration fails with "bad substitution".

- [ ] **Step 2: Write the failing test**

Create `scripts/smoke-connector-connections.ts`:

```ts
/**
 * The generic connector table: its DDL, its unique index, and the claim predicate the
 * scheduler depends on.
 *
 * The `alters` path is exercised explicitly — it is the one neither smoke-schema-ddl (which
 * never touches a database) nor a fresh bootstrap (which only runs the CREATE TABLE) covers,
 * and it is the path every already-deployed database actually takes.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, reconcileSchema, rowsOf, SCHEMA_VERSION } from "../src/db";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

run(async () => {
  const db = await getDb();

  console.log("schema version");
  check("SCHEMA_VERSION is at least 74", SCHEMA_VERSION >= 74, String(SCHEMA_VERSION));

  console.log("\nthe alters path rebuilds the table on an existing database");
  await db.execute(sql.raw(`DROP TABLE IF EXISTS connector_connections`));
  await db.execute(sql`UPDATE schema_migrations SET version = ${SCHEMA_VERSION - 1}`);
  const result = await reconcileSchema();
  check("the sweep ran", result.applied);
  check("no DDL statement failed", result.failed.length === 0, JSON.stringify(result.failed));

  const cols = rowsOf<{ column_name: string }>(
    await db.execute(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'connector_connections'
    `)
  ).map((r) => r.column_name);
  for (const column of [
    "id", "user_id", "connector_id", "auth_kind", "label", "account_ref",
    "api_key_encrypted", "access_token_encrypted", "refresh_token_encrypted",
    "token_expires_at", "scopes", "capabilities", "status", "last_synced_at",
    "sync_cursor", "next_sync_at", "sync_status", "sync_started_at", "sync_error",
    "sync_failures", "created_at", "updated_at",
  ]) {
    check(`column ${column} exists`, cols.includes(column));
  }

  const idx = rowsOf<{ indexname: string }>(
    await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'connector_connections'`)
  ).map((r) => r.indexname);
  check("the user/connector unique index exists", idx.includes("connector_connections_user_uidx"));
  check("the due index exists", idx.includes("connector_connections_due_idx"));

  console.log("\none row per user per connector");
  await db.execute(sql`
    INSERT INTO connector_connections (user_id, connector_id, auth_kind)
    VALUES ('smoke-user', 'hubspot', 'oauth2')
  `);
  let rejected = false;
  try {
    await db.execute(sql`
      INSERT INTO connector_connections (user_id, connector_id, auth_kind)
      VALUES ('smoke-user', 'hubspot', 'oauth2')
    `);
  } catch {
    rejected = true;
  }
  check("a second row for the same connector is rejected", rejected);

  await db.execute(sql`DELETE FROM connector_connections WHERE user_id = 'smoke-user'`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector_connections checks passed.");
});
```

Register it in `scripts/run-smoke.ts` in the `// pglite` block:

```ts
  "smoke-connector-connections": "pglite",
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-connector-connections.ts`
Expected: FAIL — the column checks report nothing found, because the table does not exist.

- [ ] **Step 4: Add the table to `src/db/schema.ts`**

Add the cursor type next to `EventProviderSyncCursor` (around `src/db/schema.ts:2072`):

```ts
/**
 * A connector's incremental cursor. Deliberately open: a DAV connector stores a ctag, a
 * Graph connector a delta link, a CRM an updated-since timestamp. One jsonb column beats a
 * column per provider, and the shape is the connector's business.
 */
export type ConnectorSyncCursor = {
  /** Opaque provider cursor: delta link, page token, sync token. */
  cursor?: string | null;
  /** DAV collection tag, for connectors that poll a collection. */
  ctag?: string | null;
  /** High-water mark for `updated_since`-style APIs. */
  syncedThrough?: string | null;
};
```

Add the table immediately after `eventProviderConnections` (after `src/db/schema.ts:4098`):

```ts
/**
 * Every connector credential that is not Gmail or Outlook.
 *
 * One table with a `connector_id` discriminator, unlike `gmail_connections` /
 * `outlook_connections`, which are byte-identical twins kept apart only because migrating
 * them is a one-way door (see `provider-connections.ts`). Nothing here is deployed yet, so
 * the generic shape costs nothing and saves ~20 near-identical tables.
 *
 * `capabilities` is the enabled-capability list, and the reason write-back is opt-in: a
 * connection can hold a scope without Orbit acting on it, so revoking a capability is a row
 * update rather than an OAuth round trip.
 */
export const connectorConnections = pgTable(
  "connector_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    /** Matches a `ConnectorManifest.id` in `src/lib/connectors/registry.ts`. */
    connectorId: text("connector_id").notNull(),
    authKind: text("auth_kind")
      .$type<"oauth2" | "api_key" | "dav_password" | "api_token">()
      .notNull(),
    /** Account name or workspace, shown so a user can tell two connections apart. */
    label: text("label"),
    /** Remote account/workspace/portal id, when the provider has one. */
    accountRef: text("account_ref"),
    apiKeyEncrypted: text("api_key_encrypted"),
    accessTokenEncrypted: text("access_token_encrypted"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scopes: text("scopes"),
    /**
     * Enabled capability ids. Reads are written at connect time; a write capability lands
     * here only when the user turns it on, which is what keeps Orbit from putting rows in
     * someone else's system because a scope happened to be granted.
     */
    capabilities: jsonb("capabilities").$type<string[]>().default([]).notNull(),
    /**
     * Exactly two values, matching the Gmail/Outlook and event-provider rule: disconnecting
     * deletes the row, so a third value nothing writes would be dead code.
     */
    status: text("status").$type<"active" | "needs_reauth">().default("active").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    ...syncStateColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("connector_connections_user_uidx").on(t.userId, t.connectorId),
    index("connector_connections_due_idx")
      .on(t.nextSyncAt)
      .where(sql`next_sync_at is not null`),
  ]
);
```

Add the inferred type next to the other connection type exports (near `src/db/schema.ts:4241`):

```ts
export type ConnectorConnection = typeof connectorConnections.$inferSelect;
```

Note `syncStateColumns()` is **not exported** from `schema.ts` — spreading it works only inside that file, which is where this table lives.

- [ ] **Step 5: Add the DDL**

In `src/db/index.ts`, inside the `DDL` template (the one starting at :38), next to the `event_provider_connections` block at :1179:

```sql
CREATE TABLE IF NOT EXISTS connector_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  connector_id text NOT NULL,
  auth_kind text NOT NULL,
  label text,
  account_ref text,
  api_key_encrypted text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  scopes text,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  last_synced_at timestamptz,
  sync_cursor jsonb,
  next_sync_at timestamptz,
  sync_status text,
  sync_started_at timestamptz,
  sync_error text,
  sync_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_connections_user_uidx ON connector_connections(user_id, connector_id);
CREATE INDEX IF NOT EXISTS connector_connections_due_idx ON connector_connections(next_sync_at) WHERE next_sync_at IS NOT NULL;
```

Then in `alters` (the array at :2710), appended at the end, each entry **one line, no trailing semicolon**:

```ts
  // Schema v74: the connector platform's generic credential table. The CREATE TABLE in the
  // template above repairs a fresh database; this repairs one already stamped past v74's
  // predecessor, and both indexes are written in both places because smoke-schema-ddl
  // compares the `uniqueIndex()` declarations in schema.ts against this file by name and
  // column list.
  `CREATE TABLE IF NOT EXISTS connector_connections (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, connector_id text NOT NULL, auth_kind text NOT NULL, label text, account_ref text, api_key_encrypted text, access_token_encrypted text, refresh_token_encrypted text, token_expires_at timestamptz, scopes text, capabilities jsonb NOT NULL DEFAULT '[]'::jsonb, status text NOT NULL DEFAULT 'active', last_synced_at timestamptz, sync_cursor jsonb, next_sync_at timestamptz, sync_status text, sync_started_at timestamptz, sync_error text, sync_failures integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS connector_connections_user_uidx ON connector_connections(user_id, connector_id)`,
  `CREATE INDEX IF NOT EXISTS connector_connections_due_idx ON connector_connections(next_sync_at) WHERE next_sync_at IS NOT NULL`,
```

- [ ] **Step 6: Bump the version**

In `src/db/index.ts`, append to the changelog immediately above `SCHEMA_VERSION` (:1595) and change the constant:

```ts
// 74 = connector_connections: one credential row per (user, connector) for every connector
//      that is not Gmail or Outlook, with a capabilities list so write-back stays opt-in.
//      71-73 were already claimed on other branches (checked against every remote branch and
//      local worktree on Sep 19 2026: ai-api-optimization holds 72, mcp-server-vision 73).
export const SCHEMA_VERSION = 74;
```

- [ ] **Step 7: Register the table for purge**

In `src/lib/user-data.ts`, extend the `connections` step (:252). Import `connectorConnections` from `@/db/schema` at the top of the file alongside the other tables, then:

```ts
  connections: {
    exports: [
      own(gmailConnections),
      own(outlookConnections),
      own(calendarSubscriptions),
      own(eventProviderConnections),
      own(connectorConnections),
    ],
    counts: [
      gmailConnections,
      outlookConnections,
      calendarSubscriptions,
      eventProviderConnections,
      connectorConnections,
    ],
```

and inside `run`, after the `eventProviderConnections` delete:

```ts
      // Holds encrypted OAuth tokens, API keys and iCloud app passwords for every connector
      // that is not Gmail or Outlook. Same class of secret as the rows above, and it must
      // not outlive the account.
      await db.delete(connectorConnections).where(eq(connectorConnections.userId, userId));
```

- [ ] **Step 8: Refresh the DDL lock and run the tests**

```bash
npx tsx scripts/smoke-schema-ddl.ts --update
npx tsx scripts/smoke-connector-connections.ts
npx tsx scripts/smoke-purge.ts
npx tsx scripts/smoke-schema-upgrade.ts
```

Expected: all four pass. `smoke-purge` is the one that fails loudly if the table was left unregistered.

- [ ] **Step 9: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/db/schema.ts src/db/index.ts src/lib/user-data.ts scripts/smoke-connector-connections.ts scripts/run-smoke.ts scripts/schema-ddl.lock.json
git commit -m "Add connector_connections: one credential row per user per connector (schema v74)"
```

---

### Task 3: The connector connections access module

**Files:**
- Create: `src/lib/connectors/connections.ts`
- Create: `scripts/smoke-connector-claim.ts`
- Modify: `scripts/run-smoke.ts:29` (MANIFEST)

**Interfaces:**
- Consumes: `connectorConnections`, `ConnectorSyncCursor` (Task 2); `SYNC_LEASE_MS`, `MAX_SYNC_FAILURES`, `backoffMs` from `src/lib/provider-connections.ts`.
- Produces: `ClaimedConnectorConnection`, `CONNECTOR_SYNC_INTERVAL_MS`, `claimDueConnectorConnections(limit, now?)`, `ConnectorSyncOutcome`, `markConnectorSyncResult(id, outcome, now?)`, `disarmConnectorSync(id, reason, now?, failures?)`, `markConnectorNeedsReauth(id, error)`, `upsertConnectorConnection(input)`, `listConnectorConnections(userId)`, `getConnectorConnection(userId, connectorId)`, `setConnectorCapabilities(userId, connectorId, capabilities)`, `deleteConnectorConnection(userId, connectorId)`. Tasks 4, 8 and the UI plan read these.

This module is the only file that names the `connector_connections` table, exactly as `provider-connections.ts` is the only one naming the two legacy tables. Model it on `src/lib/events/connections.ts:80-334`, which solves the same problem for event providers and already imports the lease constants from `provider-connections.ts`.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-connector-claim.ts`:

```ts
/**
 * The claim/lease/backoff contract for connector connections.
 *
 * The lease is the load-bearing part: without it `sync_status = 'syncing'` latches forever
 * the first time an invocation is killed mid-run, and the connection is never swept again.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections } from "../src/db/schema";
import {
  claimDueConnectorConnections,
  disarmConnectorSync,
  markConnectorSyncResult,
  upsertConnectorConnection,
} from "../src/lib/connectors/connections";
import { SYNC_LEASE_MS } from "../src/lib/provider-connections";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-connector-claim";

run(async () => {
  const db = await getDb();
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));

  const now = new Date();
  const conn = await upsertConnectorConnection({
    userId: USER,
    connectorId: "hubspot",
    authKind: "oauth2",
    accessToken: "token-1",
    refreshToken: "refresh-1",
    scopes: "crm.objects.contacts.read",
    capabilities: ["syncPeople"],
    nextSyncAt: new Date(now.getTime() - 1000),
  });
  check("upsert returns a row", Boolean(conn.id));

  console.log("\nclaiming");
  const claimed = await claimDueConnectorConnections(10, now);
  const mine = claimed.filter((c) => c.userId === USER);
  check("a due connection is claimed", mine.length === 1);
  check("the secret comes back decrypted", mine[0]?.accessToken === "token-1");
  check("capabilities come back", mine[0]?.capabilities.includes("syncPeople") === true);

  const again = await claimDueConnectorConnections(10, now);
  check("a leased connection is not claimed twice", again.every((c) => c.userId !== USER));

  const afterLease = new Date(now.getTime() + SYNC_LEASE_MS + 1000);
  const reclaimed = await claimDueConnectorConnections(10, afterLease);
  check("an expired lease is reclaimable", reclaimed.some((c) => c.userId === USER));

  console.log("\noutcomes");
  const next = new Date(now.getTime() + 60_000);
  await markConnectorSyncResult(conn.id, { ok: true, cursor: { cursor: "abc" }, nextSyncAt: next });
  const [ok] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, conn.id));
  check("success clears the failure count", ok?.syncFailures === 0);
  check("success stores the cursor", ok?.syncCursor?.cursor === "abc");
  check("success re-arms the connection", ok?.nextSyncAt?.getTime() === next.getTime());
  check("success clears the lease", ok?.syncStatus === "idle");

  await markConnectorSyncResult(conn.id, { ok: false, error: "boom", retryable: true });
  const [failed] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, conn.id));
  check("a retryable failure counts", failed?.syncFailures === 1);
  check("a retryable failure backs off rather than disarming", failed?.nextSyncAt !== null);
  check("the error is recorded", failed?.syncError === "boom");

  await disarmConnectorSync(conn.id, "needs attention");
  const [disarmed] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, conn.id));
  check("disarming unschedules the connection", disarmed?.nextSyncAt === null);

  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector claim checks passed.");
});
```

Register in `scripts/run-smoke.ts` (`// pglite` block):

```ts
  "smoke-connector-claim": "pglite",
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-connector-claim.ts`
Expected: FAIL — `Cannot find module '../src/lib/connectors/connections'`.

- [ ] **Step 3: Write the module**

Create `src/lib/connectors/connections.ts`:

```ts
/**
 * The only module that names `connector_connections`.
 *
 * Mirrors `src/lib/events/connections.ts`, which solves the same problem for event
 * providers, and borrows its lease, failure ceiling and backoff from
 * `provider-connections.ts` rather than restating them — three sync families with three
 * different give-up rules would be three different operational stories for one symptom.
 *
 * Deliberately free of `next/server` and `next/cache` imports: the sync scheduler and its
 * smoke tests both load this, and importing `next/server` alone retains the Node event loop
 * and hangs any `tsx` script.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { connectorConnections, type ConnectorSyncCursor } from "@/db/schema";
import { decryptOrNull, encrypt } from "@/lib/crypto";
import { MAX_SYNC_FAILURES, SYNC_LEASE_MS, backoffMs } from "@/lib/provider-connections";

/** Cadence for a healthy connection. A floor, never a promise — GitHub cron lags 5-30 min. */
export const CONNECTOR_SYNC_INTERVAL_MS = 30 * 60 * 1000;

export type ClaimedConnectorConnection = {
  id: string;
  userId: string;
  connectorId: string;
  authKind: "oauth2" | "api_key" | "dav_password" | "api_token";
  accountRef: string | null;
  /** Already decrypted. Null means the row is unusable and the caller must flag reauth. */
  accessToken: string | null;
  refreshToken: string | null;
  scopes: string | null;
  capabilities: string[];
  cursor: ConnectorSyncCursor | null;
  syncFailures: number;
};

type ClaimRow = {
  id: string;
  user_id: string;
  connector_id: string;
  auth_kind: ClaimedConnectorConnection["authKind"];
  account_ref: string | null;
  api_key_encrypted: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  scopes: string | null;
  capabilities: string[] | string | null;
  sync_cursor: ConnectorSyncCursor | string | null;
  sync_failures: number;
};

/** PGlite hands back parsed jsonb; `neon-http` can hand back a string. */
function parseJson<T>(value: T | string | null): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Claim due connections for this run, taking a lease on each.
 *
 * The same predicate as `claimDueConnections` in `provider-connections.ts`: a row is due
 * when it is active, armed, and either idle or holding a lease older than its term.
 */
export async function claimDueConnectorConnections(
  limit: number,
  now: Date = new Date()
): Promise<ClaimedConnectorConnection[]> {
  const db = await getDb();
  const leaseCutoff = new Date(now.getTime() - SYNC_LEASE_MS);
  const rows = rowsOf<ClaimRow>(
    await db.execute(sql`
      UPDATE connector_connections
         SET sync_status = 'syncing', sync_started_at = ${now}, updated_at = ${now}
       WHERE id IN (
         SELECT id FROM connector_connections
          WHERE status = 'active'
            AND next_sync_at IS NOT NULL
            AND next_sync_at <= ${now}
            AND (sync_status IS DISTINCT FROM 'syncing' OR sync_started_at < ${leaseCutoff})
          ORDER BY next_sync_at
          LIMIT ${limit}
       )
      RETURNING id, user_id, connector_id, auth_kind, account_ref, api_key_encrypted,
                access_token_encrypted, refresh_token_encrypted, scopes, capabilities,
                sync_cursor, sync_failures
    `)
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    connectorId: row.connector_id,
    authKind: row.auth_kind,
    accountRef: row.account_ref,
    accessToken: decryptOrNull(
      row.auth_kind === "oauth2" ? row.access_token_encrypted : row.api_key_encrypted
    ),
    refreshToken: decryptOrNull(row.refresh_token_encrypted),
    scopes: row.scopes,
    capabilities: parseJson<string[]>(row.capabilities) ?? [],
    cursor: parseJson<ConnectorSyncCursor>(row.sync_cursor),
    syncFailures: row.sync_failures,
  }));
}

export type ConnectorSyncOutcome =
  | { ok: true; cursor: ConnectorSyncCursor | null; nextSyncAt?: Date }
  | { ok: false; error: string; retryable: boolean };

/**
 * Record the end of one sync run.
 *
 * A non-retryable failure disarms immediately — it is a consent problem, and retrying a
 * revoked grant on a backoff ladder only delays telling the user.
 */
export async function markConnectorSyncResult(
  id: string,
  outcome: ConnectorSyncOutcome,
  now: Date = new Date()
): Promise<void> {
  const db = await getDb();
  if (outcome.ok) {
    await db
      .update(connectorConnections)
      .set({
        syncCursor: outcome.cursor,
        syncStatus: "idle",
        syncStartedAt: null,
        syncError: null,
        syncFailures: 0,
        lastSyncedAt: now,
        nextSyncAt: outcome.nextSyncAt ?? new Date(now.getTime() + CONNECTOR_SYNC_INTERVAL_MS),
        updatedAt: now,
      })
      .where(eq(connectorConnections.id, id));
    return;
  }

  const [row] = await db
    .select({ failures: connectorConnections.syncFailures })
    .from(connectorConnections)
    .where(eq(connectorConnections.id, id));
  const failures = (row?.failures ?? 0) + 1;
  const error = outcome.error.slice(0, 500);

  if (!outcome.retryable || failures >= MAX_SYNC_FAILURES) {
    await disarmConnectorSync(id, error, now, failures);
    return;
  }

  await db
    .update(connectorConnections)
    .set({
      syncStatus: "error",
      syncStartedAt: null,
      syncError: error,
      syncFailures: failures,
      nextSyncAt: new Date(now.getTime() + backoffMs(failures)),
      updatedAt: now,
    })
    .where(eq(connectorConnections.id, id));
}

/** Stop scheduling this connection. Only reconnecting, or a capability change, re-arms it. */
export async function disarmConnectorSync(
  id: string,
  reason: string,
  now: Date = new Date(),
  failures?: number
): Promise<void> {
  const db = await getDb();
  await db
    .update(connectorConnections)
    .set({
      syncStatus: "error",
      syncStartedAt: null,
      syncError: reason.slice(0, 500),
      ...(failures === undefined ? {} : { syncFailures: failures }),
      nextSyncAt: null,
      updatedAt: now,
    })
    .where(eq(connectorConnections.id, id));
}

/** A token-level rejection: the only way back is re-running the connect flow. */
export async function markConnectorNeedsReauth(id: string, error: string): Promise<void> {
  const db = await getDb();
  await db
    .update(connectorConnections)
    .set({
      status: "needs_reauth",
      syncStatus: "error",
      syncStartedAt: null,
      syncError: error.slice(0, 500),
      nextSyncAt: null,
      updatedAt: new Date(),
    })
    .where(eq(connectorConnections.id, id));
}

export type UpsertConnectorConnectionInput = {
  userId: string;
  connectorId: string;
  authKind: ClaimedConnectorConnection["authKind"];
  label?: string | null;
  accountRef?: string | null;
  /** OAuth access token, API key or app-specific password, encrypted before it is stored. */
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: Date | null;
  scopes?: string | null;
  capabilities?: string[];
  nextSyncAt?: Date | null;
};

/**
 * Create or replace the one row for this (user, connector).
 *
 * Reconnecting clears `needs_reauth`, the failure count and the stale error: the grant is
 * new, so none of the old run's state describes it any more.
 */
export async function upsertConnectorConnection(
  input: UpsertConnectorConnectionInput
): Promise<{ id: string }> {
  const db = await getDb();
  const secret = input.accessToken ? encrypt(input.accessToken) : null;
  const values = {
    userId: input.userId,
    connectorId: input.connectorId,
    authKind: input.authKind,
    label: input.label ?? null,
    accountRef: input.accountRef ?? null,
    apiKeyEncrypted: input.authKind === "oauth2" ? null : secret,
    accessTokenEncrypted: input.authKind === "oauth2" ? secret : null,
    refreshTokenEncrypted: input.refreshToken ? encrypt(input.refreshToken) : null,
    tokenExpiresAt: input.tokenExpiresAt ?? null,
    scopes: input.scopes ?? null,
    capabilities: input.capabilities ?? [],
    status: "active" as const,
    syncStatus: "idle" as const,
    syncStartedAt: null,
    syncError: null,
    syncFailures: 0,
    nextSyncAt: input.nextSyncAt ?? new Date(),
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(connectorConnections)
    .values(values)
    .onConflictDoUpdate({
      target: [connectorConnections.userId, connectorConnections.connectorId],
      set: values,
    })
    .returning({ id: connectorConnections.id });
  return { id: row!.id };
}

export type ConnectorConnectionSummary = {
  id: string;
  connectorId: string;
  label: string | null;
  accountRef: string | null;
  status: "active" | "needs_reauth";
  capabilities: string[];
  lastSyncedAt: Date | null;
  syncError: string | null;
};

/** Never returns a secret: this feeds the settings UI. */
export async function listConnectorConnections(
  userId: string
): Promise<ConnectorConnectionSummary[]> {
  const db = await getDb();
  return db
    .select({
      id: connectorConnections.id,
      connectorId: connectorConnections.connectorId,
      label: connectorConnections.label,
      accountRef: connectorConnections.accountRef,
      status: connectorConnections.status,
      capabilities: connectorConnections.capabilities,
      lastSyncedAt: connectorConnections.lastSyncedAt,
      syncError: connectorConnections.syncError,
    })
    .from(connectorConnections)
    .where(eq(connectorConnections.userId, userId));
}

export async function getConnectorConnection(
  userId: string,
  connectorId: string
): Promise<ConnectorConnectionSummary | null> {
  const all = await listConnectorConnections(userId);
  return all.find((c) => c.connectorId === connectorId) ?? null;
}

/**
 * Turn capabilities on or off.
 *
 * Re-arms the connection, because enabling a capability is exactly when the user expects
 * something to happen — including on a connection a previous failure had disarmed.
 */
export async function setConnectorCapabilities(
  userId: string,
  connectorId: string,
  capabilities: string[]
): Promise<void> {
  const db = await getDb();
  await db
    .update(connectorConnections)
    .set({ capabilities, nextSyncAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(connectorConnections.userId, userId),
        eq(connectorConnections.connectorId, connectorId)
      )
    );
}

export async function deleteConnectorConnection(
  userId: string,
  connectorId: string
): Promise<void> {
  const db = await getDb();
  await db
    .delete(connectorConnections)
    .where(
      and(
        eq(connectorConnections.userId, userId),
        eq(connectorConnections.connectorId, connectorId)
      )
    );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/smoke-connector-claim.ts`
Expected: PASS — "All connector claim checks passed."

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/connectors/connections.ts scripts/smoke-connector-claim.ts scripts/run-smoke.ts
git commit -m "Add the connector connections module: claim, lease, backoff, capabilities"
```

---

### Task 4: A registry-driven family in the sync pass

**Files:**
- Modify: `src/lib/sync-scheduler.ts` (`SyncRunStats` at :119, `emptyRunStats()` at :148, `runSyncPass` at :278)
- Modify: `src/app/api/sync/run/route.ts` (the `finishCronRun` stats object)
- Create: `scripts/smoke-connector-sync-pass.ts`
- Modify: `scripts/run-smoke.ts:29` (MANIFEST)

**Interfaces:**
- Consumes: `syncableConnectors()` (Task 1); `claimDueConnectorConnections`, `markConnectorSyncResult`, `disarmConnectorSync` (Task 3).
- Produces: three new `SyncRunStats` fields — `connectorClaimed`, `connectorSynced`, `connectorFailed` — read by the sync route and by `getCronHealth`.

The fourth family slots in exactly like the event-provider block at `src/lib/sync-scheduler.ts:381-399`: an `if (!deadlineReached(deadline)) { … }` block, counters on `SyncRunStats`, surfaced in the route's stats object.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-connector-sync-pass.ts`:

```ts
/**
 * The connector family inside `runSyncPass`.
 *
 * What matters here is the contract, not any one connector: a due connection is claimed and
 * handed to its manifest's sync function, an unregistered connector_id disarms rather than
 * throwing (a row can outlive the code that made it), and a connector whose sync throws
 * costs one failure without taking the pass down.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections } from "../src/db/schema";
import { upsertConnectorConnection } from "../src/lib/connectors/connections";
import { runSyncPass } from "../src/lib/sync-scheduler";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-connector-pass";

run(async () => {
  const db = await getDb();
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));

  console.log("an unregistered connector is disarmed, not thrown on");
  const orphan = await upsertConnectorConnection({
    userId: USER,
    connectorId: "connector-that-no-longer-exists",
    authKind: "api_key",
    accessToken: "k",
    nextSyncAt: new Date(Date.now() - 1000),
  });
  const stats = await runSyncPass({ now: new Date() });
  check("the pass returned stats", typeof stats.connectorClaimed === "number");
  check("the orphan was claimed", stats.connectorClaimed >= 1);

  const [row] = await db
    .select()
    .from(connectorConnections)
    .where(eq(connectorConnections.id, orphan.id));
  check("the orphan is unscheduled", row?.nextSyncAt === null);
  check("the orphan records why", (row?.syncError ?? "").length > 0);
  check("the orphan did not fail the pass", stats.connectorFailed === 0);

  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector sync-pass checks passed.");
});
```

Register in `scripts/run-smoke.ts` (`// pglite` block):

```ts
  "smoke-connector-sync-pass": "pglite",
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-connector-sync-pass.ts`
Expected: FAIL — `stats.connectorClaimed` is `undefined`, so the first check fails.

- [ ] **Step 3: Add the counters**

In `src/lib/sync-scheduler.ts`, add to the `SyncRunStats` type (after the `eventConnections*` fields around :133):

```ts
  /** Connections claimed from `connector_connections` — every connector but Google/Outlook. */
  connectorClaimed: number;
  connectorSynced: number;
  connectorFailed: number;
```

and to `emptyRunStats()` (:148), in the same position:

```ts
    connectorClaimed: 0,
    connectorSynced: 0,
    connectorFailed: 0,
```

- [ ] **Step 4: Add the family to `runSyncPass`**

In `src/lib/sync-scheduler.ts`, import at the top:

```ts
import {
  claimDueConnectorConnections,
  disarmConnectorSync,
  markConnectorSyncResult,
} from "@/lib/connectors/connections";
import { connectorById } from "@/lib/connectors/registry";
```

Then insert this block immediately after the event-provider block (after :399, before the `backfillPersonKeys` call at :403):

```ts
  /**
   * Family four: every connector that is not Google, Outlook, an ICS feed or an event
   * provider. Dispatch is by manifest rather than by a `switch`, so adding a connector never
   * means editing the scheduler.
   */
  if (!deadlineReached(deadline)) {
    const connections = await claimDueConnectorConnections(CONNECTIONS_PER_RUN, now).catch(
      reportAndContinue({ where: "job.sync.connector-claim" }, [])
    );
    stats.connectorClaimed = connections.length;
    await runSettledPool(connections, SYNC_CONCURRENCY, async (conn) => {
      if (deadlineReached(deadline - PER_CONNECTION_BUDGET_MS)) {
        stats.budgetExhausted = true;
        await markConnectorSyncResult(conn.id, {
          ok: true,
          cursor: conn.cursor,
          nextSyncAt: now,
        }).catch(() => null);
        return;
      }
      const manifest = connectorById(conn.connectorId);
      if (!manifest?.sync) {
        // A row can outlive the code that made it — a connector removed from the registry,
        // or one whose row was written before its sync landed. Unschedule it and say so,
        // rather than counting a failure the user cannot act on.
        await disarmConnectorSync(
          conn.id,
          "This connector is no longer available — reconnect it from Settings.",
          now
        ).catch(() => null);
        return;
      }
      try {
        await manifest.sync(conn.id);
        stats.connectorSynced++;
      } catch (err) {
        stats.connectorFailed++;
        reportError(err, {
          where: "job.sync.connector",
          userId: conn.userId,
          level: "warning",
          extra: { connectionId: conn.id, connectorId: conn.connectorId },
        });
        await markConnectorSyncResult(conn.id, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          retryable: true,
        }).catch(reportAndContinue({ where: "job.sync.connector-mark" }, null));
      }
    });
  } else {
    stats.budgetExhausted = true;
  }
```

- [ ] **Step 5: Surface the counters on the route**

In `src/app/api/sync/run/route.ts`, add the three fields to the object passed to `finishCronRun`'s `stats`, next to the existing `eventConnections*` entries, so a partial run is visible in `cron_runs`:

```ts
      connectorClaimed: stats.connectorClaimed,
      connectorSynced: stats.connectorSynced,
      connectorFailed: stats.connectorFailed,
```

- [ ] **Step 6: Run the tests**

```bash
npx tsx scripts/smoke-connector-sync-pass.ts
npx tsx scripts/smoke-sync-scheduler.ts
npx tsx scripts/smoke-sync-concurrency.ts
```

Expected: all three pass. The last two are the guard that the existing three families still behave.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/sync-scheduler.ts src/app/api/sync/run/route.ts scripts/smoke-connector-sync-pass.ts scripts/run-smoke.ts
git commit -m "Dispatch connector syncs from the registry inside runSyncPass"
```

---

### Task 5: The people ingest stream

**Files:**
- Create: `src/lib/ingest/people.ts`
- Create: `scripts/smoke-ingest-people.ts`
- Modify: `scripts/run-smoke.ts:29` (MANIFEST)

**Interfaces:**
- Consumes: `openIngestContext`, `finalizeIngest`, `IngestContext` from `src/lib/ingest/events.ts`; `findDuplicateCandidatesIndexed`, `addToDuplicateIndex` from `src/lib/duplicates.ts`; `createContactsBulkForUser`, `bulkMergeContactsForUser`, `ContactInput` from `src/lib/contact-writes.ts`.
- Produces: `PersonRecord`, `PeopleIngestStats`, `ingestPeople(ctx: IngestContext, people: PersonRecord[]): Promise<PeopleIngestStats>`. Every future contact-sync connector calls it.

This is the contact analogue of `ingestEvents`: same duplicate index, same bulk writers, same contact cap, but no interaction rows. It deliberately reuses `IngestContext` rather than defining its own, so one connector pass that syncs both people and events opens one context and pays for one index build.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-ingest-people.ts`:

```ts
/**
 * The people stream: the contact analogue of `ingestEvents`.
 *
 * The three behaviours that matter are matching (a second pass over the same person updates
 * rather than duplicates), enrichment (a record with more fields fills blanks without
 * overwriting what the user typed), and the contact cap (the free plan's limit is enforced
 * here, not at the connector).
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { openIngestContext, finalizeIngest } from "../src/lib/ingest/events";
import { ingestPeople } from "../src/lib/ingest/people";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-ingest-people";

run(async () => {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const ctx = await openIngestContext(USER, { source: "smoke", createsContacts: true });

  console.log("first pass creates");
  const first = await ingestPeople(ctx, [
    { fullName: "Ada Lovelace", email: "ada@example.com", company: "Analytical" },
    { fullName: "Grace Hopper", email: "grace@example.com" },
  ]);
  check("two people created", first.created === 2, JSON.stringify(first));
  check("nothing matched on an empty workspace", first.matched === 0);

  console.log("\nsecond pass matches and enriches");
  const second = await ingestPeople(ctx, [
    { fullName: "Ada Lovelace", email: "ada@example.com", title: "Mathematician" },
  ]);
  check("the same person matched", second.matched === 1, JSON.stringify(second));
  check("no duplicate was created", second.created === 0);

  const [ada] = await db.select().from(contacts).where(eq(contacts.email, "ada@example.com"));
  check("the blank field was filled", ada?.title === "Mathematician");
  check("the existing field was kept", ada?.company === "Analytical");

  const all = await db.select().from(contacts).where(eq(contacts.userId, USER));
  check("still two contacts in total", all.length === 2, String(all.length));

  await finalizeIngest(ctx);
  await db.delete(contacts).where(eq(contacts.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll people ingest checks passed.");
});
```

Register in `scripts/run-smoke.ts` (`// pglite` block):

```ts
  "smoke-ingest-people": "pglite",
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-ingest-people.ts`
Expected: FAIL — `Cannot find module '../src/lib/ingest/people'`.

- [ ] **Step 3: Write the stream**

Create `src/lib/ingest/people.ts`:

```ts
/**
 * Contacts from a delta-token source, in bulk.
 *
 * `ingestEvents` is the same shape for interactions; this is its counterpart for address
 * books — Google People, Outlook People, iCloud CardDAV, a CRM's contact list. Uploaded
 * files keep going through the staged import engine, which owns resumability and per-row
 * poison isolation that a streamed sync does not need.
 *
 * It takes the same `IngestContext` rather than one of its own so a connector that syncs
 * both people and meetings builds the duplicate index once.
 *
 * Enrichment is fill-blanks-only, deliberately: a provider's stale title must never
 * overwrite what the user typed. `bulkMergeContactsForUser` already implements that rule.
 */
import {
  addToDuplicateIndex,
  findDuplicateCandidatesIndexed,
} from "@/lib/duplicates";
import {
  bulkMergeContactsForUser,
  createContactsBulkForUser,
  type ContactInput,
} from "@/lib/contact-writes";
import type { IngestContext } from "@/lib/ingest/events";

/** One person as a provider describes them. Every field but the name is optional. */
export type PersonRecord = {
  fullName: string;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  xHandle?: string | null;
  company?: string | null;
  title?: string | null;
  location?: string | null;
  notes?: string | null;
};

export type PeopleIngestStats = {
  seen: number;
  created: number;
  matched: number;
  /** Would have been created but for the plan's contact cap. */
  blockedByPlan: number;
};

function toContactInput(person: PersonRecord, source: string): ContactInput {
  return {
    fullName: person.fullName.trim(),
    email: person.email ?? undefined,
    phone: person.phone ?? undefined,
    linkedinUrl: person.linkedinUrl ?? undefined,
    xHandle: person.xHandle ?? undefined,
    company: person.company ?? undefined,
    title: person.title ?? undefined,
    location: person.location ?? undefined,
    notes: person.notes ?? undefined,
    source,
  } as ContactInput;
}

/**
 * Match every record against the workspace, then write in two bulk statements.
 *
 * Costs two statements in the steady state regardless of batch size — the same budget
 * discipline `ingestEvents` keeps, and the reason a 5,000-contact address book does not melt
 * `neon-http`, where every round trip is a separate HTTP request.
 */
export async function ingestPeople(
  ctx: IngestContext,
  people: PersonRecord[]
): Promise<PeopleIngestStats> {
  const stats: PeopleIngestStats = { seen: 0, created: 0, matched: 0, blockedByPlan: 0 };
  const toCreate: ContactInput[] = [];
  const toMerge: Array<{ contactId: string; input: Partial<ContactInput> }> = [];

  for (const person of people) {
    const name = person.fullName?.trim();
    if (!name) continue;
    stats.seen++;

    const [best] = findDuplicateCandidatesIndexed(ctx.index, {
      fullName: name,
      email: person.email ?? null,
      linkedinUrl: person.linkedinUrl ?? null,
      xHandle: person.xHandle ?? null,
      company: person.company ?? null,
      title: person.title ?? null,
    });

    if (best && best.confidence >= ctx.options.matchConfidence) {
      stats.matched++;
      ctx.touchedContactIds.add(best.contact.id);
      toMerge.push({ contactId: best.contact.id, input: toContactInput(person, ctx.options.source) });
      continue;
    }

    if (!ctx.options.createsContacts) continue;
    if (ctx.headroom !== null && ctx.headroom <= 0) {
      stats.blockedByPlan++;
      continue;
    }
    if (ctx.headroom !== null) ctx.headroom--;
    toCreate.push(toContactInput(person, ctx.options.source));
  }

  if (toMerge.length > 0) {
    await bulkMergeContactsForUser(ctx.userId, toMerge, ctx.companyResolve);
  }

  if (toCreate.length > 0) {
    const created = await createContactsBulkForUser(ctx.userId, toCreate, ctx.companyResolve, {
      skipRevalidate: true,
      skipEmbedding: true,
      skipSummary: true,
      skipCloseness: true,
      headroom: ctx.headroom,
    });
    for (const contact of created) {
      stats.created++;
      ctx.touchedContactIds.add(contact.id);
      // Keep the index current so two records for the same person inside one batch match
      // each other rather than both being created.
      addToDuplicateIndex(ctx.index, {
        id: contact.id,
        fullName: contact.fullName,
        email: contact.email,
        linkedinUrl: contact.linkedinUrl,
        xHandle: contact.xHandle,
        company: contact.company,
        title: contact.title,
      });
    }
  }

  return stats;
}
```

If `createContactsBulkForUser` does not return the created rows in the shape above, read its signature at `src/lib/contact-writes.ts:506` and adapt the destructuring — the contract the index needs is `id` plus the six `DuplicateSubject` fields listed at `src/lib/duplicates.ts:11`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/smoke-ingest-people.ts`
Expected: PASS — "All people ingest checks passed."

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/ingest/people.ts scripts/smoke-ingest-people.ts scripts/run-smoke.ts
git commit -m "Add the people ingest stream for delta-token contact sources"
```

---

### Task 6: The generic OAuth2 helper

**Files:**
- Create: `src/lib/connectors/oauth.ts`
- Create: `scripts/smoke-connector-oauth.ts`
- Modify: `scripts/run-smoke.ts:29` (MANIFEST)

**Interfaces:**
- Consumes: `connectorById` (Task 1); `upsertConnectorConnection`, `markConnectorNeedsReauth` (Task 3); `safeReturnPath` from `src/lib/oauth-return.ts`.
- Produces: `OAuthProviderConfig`, `OAUTH_PROVIDERS: Record<string, OAuthProviderConfig>`, `buildAuthorizeUrl(connectorId, opts)`, `parseOAuthState(raw)`, `exchangeCode(connectorId, code, redirectUri)`, `refreshAccessToken(connectorId, refreshToken)`, `OAuthTokenError`. Every `oauth2` connector's callback route uses these.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-connector-oauth.ts` (pure tier — no database, no network; `fetch` is injected):

```ts
/**
 * The generic OAuth2 helper. Pure: every network call is injected.
 *
 * The state parameter carries the return path, so a connect started from a settings deep
 * link comes back to that same pane. It is signed because an unsigned state is an open
 * redirect wearing a seatbelt.
 */
import {
  OAuthTokenError,
  buildAuthorizeUrl,
  exchangeCode,
  parseOAuthState,
  signOAuthState,
} from "../src/lib/connectors/oauth";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const url = buildAuthorizeUrl("hubspot", {
  userId: "u1",
  redirectUri: "https://app.example.com/api/connectors/hubspot/callback",
  scopes: ["crm.objects.contacts.read"],
  returnTo: "/settings?integration=hubspot",
});
const parsed = new URL(url);
check("authorize url points at the provider", parsed.hostname.endsWith("hubspot.com"), parsed.hostname);
check("response_type is code", parsed.searchParams.get("response_type") === "code");
check("scopes are joined", parsed.searchParams.get("scope") === "crm.objects.contacts.read");
check("a state is present", (parsed.searchParams.get("state") ?? "").length > 0);

const state = parseOAuthState(parsed.searchParams.get("state")!);
check("state round-trips the user", state?.userId === "u1");
check("state round-trips the return path", state?.returnTo === "/settings?integration=hubspot");

check("a tampered state is rejected", parseOAuthState("garbage.garbage") === null);
const forged = signOAuthState({ userId: "u1", connectorId: "hubspot", returnTo: "https://evil.example" });
check("an absolute return path is refused", parseOAuthState(forged)?.returnTo === "/settings");

async function exchange() {
  const ok = await exchangeCode("hubspot", "the-code", "https://app.example.com/cb", {
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 1800 }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof fetch,
  });
  check("the access token comes back", ok.accessToken === "at");
  check("the refresh token comes back", ok.refreshToken === "rt");
  check("the expiry is absolute", ok.expiresAt instanceof Date && ok.expiresAt > new Date());

  let threw: unknown = null;
  try {
    await exchangeCode("hubspot", "bad", "https://app.example.com/cb", {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch,
    });
  } catch (err) {
    threw = err;
  }
  check("a rejected grant throws OAuthTokenError", threw instanceof OAuthTokenError);
  check("the error is marked non-retryable", (threw as OAuthTokenError)?.needsReauth === true);
}

exchange().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector OAuth checks passed.");
  process.exit(0);
});
```

Register in `scripts/run-smoke.ts` (`// pure` block):

```ts
  "smoke-connector-oauth": "pure",
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-connector-oauth.ts`
Expected: FAIL — `Cannot find module '../src/lib/connectors/oauth'`.

- [ ] **Step 3: Write the helper**

Create `src/lib/connectors/oauth.ts`:

```ts
/**
 * One OAuth2 implementation for every connector that uses it.
 *
 * Google and Microsoft keep their own modules (`gmail.ts`, `outlook.ts`) — they predate this
 * and their quirks are load-bearing. Everything new goes through here, so a new provider is
 * a `OAUTH_PROVIDERS` entry rather than another copy of the same 200 lines.
 *
 * Pure enough to test: every network call takes an injectable `fetchImpl`, and nothing here
 * touches the database. The caller persists the result through
 * `upsertConnectorConnection`.
 */
import { createHmac, timingSafeEqual } from "crypto";

export type OAuthProviderConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Extra authorize-time parameters a provider demands. */
  extraAuthParams?: Record<string, string>;
};

/**
 * One entry per OAuth2 connector. The two env names are read at call time, never at module
 * load, so an unconfigured provider is a clear runtime error rather than a boot failure.
 */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  hubspot: {
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    clientIdEnv: "HUBSPOT_CLIENT_ID",
    clientSecretEnv: "HUBSPOT_CLIENT_SECRET",
  },
  notion: {
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    clientIdEnv: "NOTION_CLIENT_ID",
    clientSecretEnv: "NOTION_CLIENT_SECRET",
    extraAuthParams: { owner: "user" },
  },
};

/** A token-level rejection. `needsReauth` means retrying will never help. */
export class OAuthTokenError extends Error {
  constructor(
    message: string,
    readonly needsReauth: boolean
  ) {
    super(message);
    this.name = "OAuthTokenError";
  }
}

export type OAuthState = {
  userId: string;
  connectorId: string;
  /** Always an app-relative path — see `safeReturnTo`. */
  returnTo: string;
};

function stateSecret(): string {
  return process.env.ENCRYPTION_SECRET ?? "orbit-dev-secret-change-me-in-prod";
}

/**
 * Keep the return path app-relative.
 *
 * An absolute URL in `state` is an open redirect: the provider hands it straight back and
 * the callback would forward the user to it after a successful sign-in.
 */
function safeReturnTo(value: string | undefined | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/settings";
  return value;
}

export function signOAuthState(state: OAuthState): string {
  const payload = Buffer.from(
    JSON.stringify({ ...state, returnTo: safeReturnTo(state.returnTo) })
  ).toString("base64url");
  const mac = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function parseOAuthState(raw: string): OAuthState | null {
  const [payload, mac] = raw.split(".");
  if (!payload || !mac) return null;
  const expected = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (!parsed.userId || !parsed.connectorId) return null;
    return { ...parsed, returnTo: safeReturnTo(parsed.returnTo) };
  } catch {
    return null;
  }
}

function providerOrThrow(connectorId: string): OAuthProviderConfig {
  const provider = OAUTH_PROVIDERS[connectorId];
  if (!provider) throw new Error(`No OAuth config for connector "${connectorId}"`);
  return provider;
}

function clientCredentials(provider: OAuthProviderConfig): { id: string; secret: string } {
  const id = process.env[provider.clientIdEnv];
  const secret = process.env[provider.clientSecretEnv];
  if (!id || !secret) {
    throw new Error(`${provider.clientIdEnv} / ${provider.clientSecretEnv} are not configured`);
  }
  return { id, secret };
}

export function buildAuthorizeUrl(
  connectorId: string,
  opts: { userId: string; redirectUri: string; scopes: string[]; returnTo: string }
): string {
  const provider = providerOrThrow(connectorId);
  const { id } = clientCredentials(provider);
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", id);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", opts.scopes.join(" "));
  url.searchParams.set(
    "state",
    signOAuthState({ userId: opts.userId, connectorId, returnTo: opts.returnTo })
  );
  for (const [key, value] of Object.entries(provider.extraAuthParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string | null;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function postToken(
  provider: OAuthProviderConfig,
  body: URLSearchParams,
  fetchImpl: typeof fetch
): Promise<OAuthTokens> {
  const res = await fetchImpl(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    // 4xx means the grant itself is bad; 5xx is the provider having a bad day and is worth
    // retrying, which is exactly the retryable/needs-reauth split the scheduler acts on.
    const needsReauth = res.status >= 400 && res.status < 500;
    throw new OAuthTokenError(
      json.error_description ?? json.error ?? `Token endpoint returned ${res.status}`,
      needsReauth
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    scopes: json.scope ?? null,
  };
}

export async function exchangeCode(
  connectorId: string,
  code: string,
  redirectUri: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<OAuthTokens> {
  const provider = providerOrThrow(connectorId);
  const { id, secret } = clientCredentials(provider);
  return postToken(
    provider,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: id,
      client_secret: secret,
    }),
    opts.fetchImpl ?? fetch
  );
}

export async function refreshAccessToken(
  connectorId: string,
  refreshToken: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<OAuthTokens> {
  const provider = providerOrThrow(connectorId);
  const { id, secret } = clientCredentials(provider);
  return postToken(
    provider,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: id,
      client_secret: secret,
    }),
    opts.fetchImpl ?? fetch
  );
}
```

The smoke script sets no client id, so give it one before the assertions — add to the top of `scripts/smoke-connector-oauth.ts`:

```ts
process.env.HUBSPOT_CLIENT_ID = "test-client";
process.env.HUBSPOT_CLIENT_SECRET = "test-secret";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/smoke-connector-oauth.ts`
Expected: PASS — "All connector OAuth checks passed."

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/lib/connectors/oauth.ts scripts/smoke-connector-oauth.ts scripts/run-smoke.ts
git commit -m "Add a generic OAuth2 helper so a new connector is config, not code"
```

---

### Task 7: Write-back — `external_links` and `connector_outbox` (schema v75)

**Files:**
- Modify: `src/db/schema.ts` (two tables after `connectorConnections`)
- Modify: `src/db/index.ts` (`DDL`, `alters`, changelog, `SCHEMA_VERSION` → 75)
- Create: `src/lib/connectors/outbox.ts`
- Create: `src/app/api/connectors/outbox/drain/route.ts`
- Modify: `src/lib/public-routes.ts` (the internal-route list at :42-51)
- Modify: `src/lib/user-data.ts` (the `connections` step)
- Modify: `.github/workflows/ops.yml` (a new step on the ten-minute schedule)
- Create: `scripts/smoke-connector-outbox.ts`
- Modify: `scripts/run-smoke.ts:29` (MANIFEST)

**Interfaces:**
- Consumes: `connectorConnections` (Task 2); `ClaimedConnectorConnection` (Task 3); `connectorById` (Task 1).
- Produces: `externalLinks`, `connectorOutbox` tables; `OutboxAction`, `enqueueOutbox(input)`, `drainOutbox(opts)`, `OutboxDrainStats`, `recordExternalLink(input)`, `findExternalLink(userId, connectorId, entityType, entityId)`.

The retry rules are `outbound_webhook_deliveries`': 7 attempts, jittered backoff, dead after exhaustion. They are restated here rather than imported because `dispatch.ts` keeps `BACKOFF_MINUTES` and `backoffFor` module-private, and exporting them to share would widen a module that is deliberately narrow.

- [ ] **Step 1: Re-check the free schema version, then write the failing test**

```bash
bash -c 'for b in $(git branch -a --format="%(refname)" | grep -v HEAD); do v=$(git show "${b}:src/db/index.ts" 2>/dev/null | grep -m1 "^export const SCHEMA_VERSION" | grep -oE "[0-9]+"); [ -n "$v" ] && echo "$v $b"; done | sort -rn | head -4'
```

Create `scripts/smoke-connector-outbox.ts`:

```ts
/**
 * The write-back queue.
 *
 * Enqueue must be idempotent — the same follow-up must not create two tasks in someone's
 * Reminders — and the drain must survive one connector failing without stalling the queue.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorOutbox, externalLinks } from "../src/db/schema";
import {
  drainOutbox,
  enqueueOutbox,
  findExternalLink,
  recordExternalLink,
} from "../src/lib/connectors/outbox";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-outbox";

run(async () => {
  const db = await getDb();
  await db.delete(connectorOutbox).where(eq(connectorOutbox.userId, USER));
  await db.delete(externalLinks).where(eq(externalLinks.userId, USER));

  console.log("enqueue");
  const first = await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-1",
    payload: { title: "Follow up with Ada" },
  });
  const again = await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-1",
    payload: { title: "Follow up with Ada" },
  });
  check("the first enqueue creates a row", first !== null);
  check("the same action does not enqueue twice", again === null);

  const rows = await db.select().from(connectorOutbox).where(eq(connectorOutbox.userId, USER));
  check("exactly one queued row", rows.length === 1, String(rows.length));
  check("it starts pending", rows[0]?.status === "pending");

  console.log("\ndrain");
  const handled: string[] = [];
  const stats = await drainOutbox({
    budgetMs: 5_000,
    max: 10,
    deliver: async (item) => {
      handled.push(item.entityId);
      return { ok: true, remoteId: "remote-1" };
    },
  });
  check("the item was attempted", stats.attempted === 1, JSON.stringify(stats));
  check("the item was delivered", stats.delivered === 1);
  check("the handler saw the entity", handled[0] === "rem-1");

  const link = await findExternalLink(USER, "apple_reminders", "reminder", "rem-1");
  check("delivery records the remote id", link?.remoteId === "remote-1");

  console.log("\nfailure backs off rather than dying");
  await enqueueOutbox({
    userId: USER,
    connectorId: "apple_reminders",
    action: "writeTask",
    entityType: "reminder",
    entityId: "rem-2",
    payload: { title: "Second" },
  });
  const failStats = await drainOutbox({
    budgetMs: 5_000,
    max: 10,
    deliver: async () => {
      throw new Error("provider down");
    },
  });
  check("the failure is counted", failStats.failed === 1, JSON.stringify(failStats));
  const [failed] = await db
    .select()
    .from(connectorOutbox)
    .where(eq(connectorOutbox.entityId, "rem-2"));
  check("it stays pending for a retry", failed?.status === "pending");
  check("it is rescheduled", failed?.nextAttemptAt !== null);
  check("the attempt is recorded", (failed?.attempts ?? 0) === 1);

  await db.delete(connectorOutbox).where(eq(connectorOutbox.userId, USER));
  await db.delete(externalLinks).where(eq(externalLinks.userId, USER));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll outbox checks passed.");
});
```

Register in `scripts/run-smoke.ts` (`// pglite` block):

```ts
  "smoke-connector-outbox": "pglite",
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-connector-outbox.ts`
Expected: FAIL — the tables and module do not exist.

- [ ] **Step 3: Add the two tables to `src/db/schema.ts`**

After `connectorConnections`:

```ts
/**
 * What an Orbit row is called in someone else's system.
 *
 * Write-back needs this to be an update rather than a duplicate the second time: without a
 * recorded remote id, re-sending a follow-up creates a second task. Keyed by connection, so
 * disconnecting and reconnecting starts clean rather than pointing at rows the new grant may
 * not even be able to see.
 */
export const externalLinks = pgTable(
  "external_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    connectorId: text("connector_id").notNull(),
    /** `reminder` | `interaction` | `contact` — the Orbit side. */
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    /** The provider's id for the same thing. */
    remoteId: text("remote_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("external_links_entity_uidx").on(
      t.userId,
      t.connectorId,
      t.entityType,
      t.entityId
    ),
  ]
);

export type ExternalLink = typeof externalLinks.$inferSelect;

/**
 * Pending writes to other people's systems.
 *
 * Deliberately the same shape and the same retry rules as `outbound_webhook_deliveries`: an
 * at-least-once queue with a jittered ladder and a dead state. The unique index is what makes
 * enqueue idempotent — a retried server action cannot put two tasks in someone's Reminders.
 */
export const connectorOutbox = pgTable(
  "connector_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    connectorId: text("connector_id").notNull(),
    /** `writeTask` | `logActivity` | `writeContact`, matching the manifest's capabilities. */
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status")
      .$type<"pending" | "delivered" | "failed" | "dead">()
      .default("pending")
      .notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /** First 200 characters only, like every other error column here. */
    lastError: text("last_error"),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("connector_outbox_action_uidx").on(
      t.userId,
      t.connectorId,
      t.action,
      t.entityType,
      t.entityId
    ),
    // The drain's only scan.
    index("connector_outbox_due_idx").on(t.status, t.nextAttemptAt),
  ]
);

export type ConnectorOutboxRow = typeof connectorOutbox.$inferSelect;
```

- [ ] **Step 4: Add the DDL, the alters and the version bump**

In the `DDL` template of `src/db/index.ts`, after the `connector_connections` block:

```sql
CREATE TABLE IF NOT EXISTS external_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  connector_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  remote_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS external_links_entity_uidx ON external_links(user_id, connector_id, entity_type, entity_id);
CREATE TABLE IF NOT EXISTS connector_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  connector_id text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  last_attempted_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_outbox_action_uidx ON connector_outbox(user_id, connector_id, action, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS connector_outbox_due_idx ON connector_outbox(status, next_attempt_at);
```

In `alters`, appended (single lines, no trailing semicolons):

```ts
  // Schema v75: connector write-back. Same both-places rule as v74 above.
  `CREATE TABLE IF NOT EXISTS external_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, connector_id text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL, remote_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS external_links_entity_uidx ON external_links(user_id, connector_id, entity_type, entity_id)`,
  `CREATE TABLE IF NOT EXISTS connector_outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, connector_id text NOT NULL, action text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz, last_error text, last_attempted_at timestamptz, delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS connector_outbox_action_uidx ON connector_outbox(user_id, connector_id, action, entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS connector_outbox_due_idx ON connector_outbox(status, next_attempt_at)`,
```

Changelog and constant:

```ts
// 75 = external_links + connector_outbox: at-least-once write-back to other systems, with
//      the remote id recorded so a re-send updates instead of duplicating.
export const SCHEMA_VERSION = 75;
```

- [ ] **Step 5: Register both tables for purge**

In `src/lib/user-data.ts`, import both tables and extend the `connections` step's `exports`, `counts` and `run` the same way Task 2 did:

```ts
      own(externalLinks),
      own(connectorOutbox),
```

```ts
      // The outbox may hold an unsent payload and external_links maps this user's rows into
      // other systems. Both go with the connection that produced them.
      await db.delete(connectorOutbox).where(eq(connectorOutbox.userId, userId));
      await db.delete(externalLinks).where(eq(externalLinks.userId, userId));
```

- [ ] **Step 6: Write the outbox module**

Create `src/lib/connectors/outbox.ts`:

```ts
/**
 * At-least-once write-back to other people's systems.
 *
 * The retry rules are `outbound_webhook_deliveries`': seven attempts on a jittered ladder,
 * then dead. They are restated rather than imported because `webhooks/dispatch.ts` keeps its
 * ladder module-private, and widening that module to share it would be a worse trade than
 * twenty lines of duplication.
 *
 * `deliver` is injected rather than dispatched from the registry here, so this module stays
 * testable without a provider and the connector owns its own HTTP.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { connectorOutbox, externalLinks } from "@/db/schema";

/** Attempts before an item is abandoned. Mirrors MAX_DELIVERY_ATTEMPTS in dispatch.ts. */
export const MAX_OUTBOX_ATTEMPTS = 7;

/** Nominal backoff ladder in minutes. The drain runs every ten, so the first steps collapse. */
const BACKOFF_MINUTES = [0.5, 2, 10, 60, 360, 1440];

function backoffFor(attempt: number): number {
  const minutes = BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length - 1)]!;
  // ±20% jitter, so a provider-wide outage does not bring every item back on the same
  // ten-minute boundary once it clears.
  return minutes * (0.8 + Math.random() * 0.4) * 60_000;
}

export type OutboxAction = "writeTask" | "logActivity" | "writeContact";

export type EnqueueOutboxInput = {
  userId: string;
  connectorId: string;
  action: OutboxAction;
  entityType: "reminder" | "interaction" | "contact";
  entityId: string;
  payload: Record<string, unknown>;
};

/**
 * Queue one write. Returns null when this exact action is already queued or delivered —
 * the unique index is the idempotency story, so a retried server action is free.
 */
export async function enqueueOutbox(input: EnqueueOutboxInput): Promise<{ id: string } | null> {
  const db = await getDb();
  const [row] = await db
    .insert(connectorOutbox)
    .values({
      userId: input.userId,
      connectorId: input.connectorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
      status: "pending",
      nextAttemptAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: connectorOutbox.id });
  return row ?? null;
}

export type OutboxItem = {
  id: string;
  userId: string;
  connectorId: string;
  action: OutboxAction;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  attempts: number;
  /** The provider's id from a previous delivery, when there was one. */
  remoteId: string | null;
};

export type DeliverResult = { ok: true; remoteId?: string | null } | { ok: false; error: string };

export type OutboxDrainStats = { attempted: number; delivered: number; failed: number };

export async function drainOutbox(opts: {
  budgetMs: number;
  max: number;
  now?: Date;
  deliver: (item: OutboxItem) => Promise<DeliverResult>;
}): Promise<OutboxDrainStats> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + opts.budgetMs;
  const stats: OutboxDrainStats = { attempted: 0, delivered: 0, failed: 0 };
  const db = await getDb();

  const due = await db
    .select()
    .from(connectorOutbox)
    .where(
      and(
        eq(connectorOutbox.status, "pending"),
        sql`${connectorOutbox.nextAttemptAt} IS NOT NULL`,
        sql`${connectorOutbox.nextAttemptAt} <= ${now}`
      )
    )
    .orderBy(connectorOutbox.nextAttemptAt)
    .limit(opts.max);

  for (const row of due) {
    if (Date.now() >= deadline) break;
    stats.attempted++;
    const link = await findExternalLink(row.userId, row.connectorId, row.entityType, row.entityId);
    // One connector's failure must never stop the queue.
    const result = await opts
      .deliver({
        id: row.id,
        userId: row.userId,
        connectorId: row.connectorId,
        action: row.action as OutboxAction,
        entityType: row.entityType,
        entityId: row.entityId,
        payload: row.payload as Record<string, unknown>,
        attempts: row.attempts,
        remoteId: link?.remoteId ?? null,
      })
      .catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }));

    if (result.ok) {
      stats.delivered++;
      if (result.remoteId) {
        await recordExternalLink({
          userId: row.userId,
          connectorId: row.connectorId,
          entityType: row.entityType,
          entityId: row.entityId,
          remoteId: result.remoteId,
        });
      }
      await db
        .update(connectorOutbox)
        .set({
          status: "delivered",
          attempts: row.attempts + 1,
          lastAttemptedAt: now,
          deliveredAt: now,
          nextAttemptAt: null,
          lastError: null,
        })
        .where(eq(connectorOutbox.id, row.id));
      continue;
    }

    stats.failed++;
    const attempt = row.attempts + 1;
    const exhausted = attempt >= MAX_OUTBOX_ATTEMPTS;
    await db
      .update(connectorOutbox)
      .set({
        status: exhausted ? "dead" : "pending",
        attempts: attempt,
        lastError: result.error.slice(0, 200),
        lastAttemptedAt: now,
        nextAttemptAt: exhausted ? null : new Date(now.getTime() + backoffFor(attempt)),
      })
      .where(eq(connectorOutbox.id, row.id));
  }

  return stats;
}

export async function recordExternalLink(input: {
  userId: string;
  connectorId: string;
  entityType: string;
  entityId: string;
  remoteId: string;
}): Promise<void> {
  const db = await getDb();
  await db
    .insert(externalLinks)
    .values({ ...input, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [
        externalLinks.userId,
        externalLinks.connectorId,
        externalLinks.entityType,
        externalLinks.entityId,
      ],
      set: { remoteId: input.remoteId, updatedAt: new Date() },
    });
}

export async function findExternalLink(
  userId: string,
  connectorId: string,
  entityType: string,
  entityId: string
): Promise<{ remoteId: string } | null> {
  const db = await getDb();
  const [row] = await db
    .select({ remoteId: externalLinks.remoteId })
    .from(externalLinks)
    .where(
      and(
        eq(externalLinks.userId, userId),
        eq(externalLinks.connectorId, connectorId),
        eq(externalLinks.entityType, entityType),
        eq(externalLinks.entityId, entityId)
      )
    );
  return row ?? null;
}
```

- [ ] **Step 7: Add the drain route and schedule it**

Create `src/app/api/connectors/outbox/drain/route.ts`, modelled on `src/app/api/webhooks/outbound/drain/route.ts`:

```ts
/**
 * Drains the connector outbox. Rides the ten-minute ops schedule like the webhook drain: a
 * write that failed can wait ten minutes, and its own route keeps its latency off the sweep.
 *
 * Delivery is dispatched through the registry, so this route never learns a provider's API.
 */
import { NextResponse } from "next/server";
import { connectorById } from "@/lib/connectors/registry";
import { drainOutbox } from "@/lib/connectors/outbox";
import { finishCronRun, startCronRun } from "@/lib/cron-runs";
import { isInternalRequest } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const handle = await startCronRun("connectors.outbox");
  try {
    // 40s of a 60s budget, leaving room for the ledger write.
    const stats = await drainOutbox({
      budgetMs: 40_000,
      max: 200,
      deliver: async (item) => {
        const manifest = connectorById(item.connectorId);
        if (!manifest) {
          // The connector was removed. Fail it out rather than retrying forever.
          return { ok: false, error: "That connector is no longer available" };
        }
        const { deliverOutboxItem } = await import("@/lib/connectors/deliver");
        return deliverOutboxItem(manifest, item);
      },
    });
    await finishCronRun(handle, {
      status: stats.failed > 0 ? "partial" : "ok",
      stats,
    });
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    const ref = reportError(err, { where: "job.connector-outbox" });
    await finishCronRun(handle, { status: "failed", error: err });
    return NextResponse.json({ error: "drain failed", ref }, { status: 500 });
  }
}
```

Create `src/lib/connectors/deliver.ts` — the dispatch seam, which stays a stub until the first write-back connector ships in P2:

```ts
/**
 * Where an outbox item meets a provider's API.
 *
 * Empty on purpose: P0 builds the queue, and the first real writer (Apple Reminders, via the
 * Shortcut, then Microsoft To Do) arrives in P2. Returning a non-retryable failure rather
 * than throwing keeps an item that nothing can deliver out of a seven-attempt retry loop.
 */
import type { ConnectorManifest } from "@/lib/connectors/registry";
import type { DeliverResult, OutboxItem } from "@/lib/connectors/outbox";

export async function deliverOutboxItem(
  manifest: ConnectorManifest,
  _item: OutboxItem
): Promise<DeliverResult> {
  return { ok: false, error: `${manifest.label} cannot receive writes yet` };
}
```

Add the route to `src/lib/public-routes.ts`, in the internal-route list alongside `/api/webhooks/outbound/drain`:

```ts
  "/api/connectors/outbox/drain",
```

Add the step to `.github/workflows/ops.yml`, after the "Drain outbound webhooks" step:

```yaml
      # Connector write-back. Rides the ten-minute schedule for the same reason the webhook
      # drain does: a write that failed can wait, and its own route keeps its latency off the
      # sweep above.
      - name: Drain the connector outbox
        if: (github.event.schedule == '*/10 * * * *' || github.event_name == 'workflow_dispatch') && steps.health.outcome == 'success'
        run: |
          curl -sS --fail-with-body --max-time 55 -X POST \
            -H "Authorization: Bearer $CRON_SECRET" \
            "$APP_URL/api/connectors/outbox/drain"
        env:
          APP_URL: ${{ secrets.APP_URL }}
          CRON_SECRET: ${{ secrets.CRON_SECRET }}
```

Note a `secrets.*` reference inside an `if:` fails the whole workflow at parse time — gate on the schedule only, as every other step here does.

- [ ] **Step 8: Refresh the lock and run the tests**

```bash
npx tsx scripts/smoke-schema-ddl.ts --update
npx tsx scripts/smoke-connector-outbox.ts
npx tsx scripts/smoke-purge.ts
npx tsx scripts/smoke-schema-upgrade.ts
```

Expected: all pass.

- [ ] **Step 9: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/db/schema.ts src/db/index.ts src/lib/connectors/outbox.ts src/lib/connectors/deliver.ts src/app/api/connectors/outbox/drain/route.ts src/lib/public-routes.ts src/lib/user-data.ts .github/workflows/ops.yml scripts/smoke-connector-outbox.ts scripts/run-smoke.ts scripts/schema-ddl.lock.json
git commit -m "Add connector write-back: external_links, connector_outbox and its drain (schema v75)"
```

---

### Task 8: The API routes Shortcuts, Obsidian and Zapier need

**Files:**
- Create: `src/app/api/v1/notes/route.ts`
- Create: `src/app/api/v1/interactions/route.ts`
- Create: `src/app/api/v1/followups/[id]/route.ts`
- Modify: `src/lib/api/schemas.ts` (three new schemas)
- Modify: `src/app/api/v1/openapi.json/route.ts` (three new `paths` entries)
- Create: `scripts/smoke-api-connector-routes.ts`
- Modify: `scripts/run-smoke.ts:29` (MANIFEST)

**Interfaces:**
- Consumes: `apiHandler`, `apiOk`, `apiError`, `readJson`, `ApiRequestError` from `src/lib/api/http.ts`; `parseQuery` from `src/lib/api/schemas.ts`; `createCaptureJob` from `src/lib/capture-jobs.ts`; `completeReminder`, `snoozeReminderTo` from `src/lib/reminders.ts`.
- Produces: `noteBody`, `interactionsQuery`, `followupPatchBody` in `src/lib/api/schemas.ts`.

`POST /v1/notes` deliberately enqueues a capture job rather than calling `saveNoteBatch` directly: `saveNoteBatch` takes an already-parsed batch (participants, commitments, anchors), which is the *output* of the AI parse, not something a Shortcut can produce. Enqueuing puts API notes through the same pipeline as the app's own capture.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-api-connector-routes.ts`:

```ts
/**
 * The three routes the Shortcut, the Obsidian plugin and Zapier need.
 *
 * Checked at the schema level rather than over HTTP: the auth, rate-limit and error mapping
 * are `apiHandler`'s and already covered; what is new here is the request contracts.
 */
import { followupPatchBody, interactionsQuery, noteBody, parseQuery } from "../src/lib/api/schemas";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

console.log("notes");
check("a note with text parses", noteBody.safeParse({ text: "Met Ada at the museum" }).success);
check("an empty note is rejected", !noteBody.safeParse({ text: "" }).success);
check(
  "a source label is optional and bounded",
  noteBody.safeParse({ text: "hi", sourceLabel: "Apple Notes" }).success
);
check(
  "an oversized note is rejected",
  !noteBody.safeParse({ text: "x".repeat(50_001) }).success
);

console.log("\ninteractions");
const ok = parseQuery("https://x/api/v1/interactions?limit=10", interactionsQuery);
check("a plain query parses", ok.ok === true);
const since = parseQuery(
  "https://x/api/v1/interactions?updated_since=2026-09-01T00:00:00.000Z",
  interactionsQuery
);
check("updated_since parses", since.ok === true);
const bad = parseQuery("https://x/api/v1/interactions?updated_since=nope", interactionsQuery);
check("a bad updated_since is rejected", bad.ok === false);
const tooMany = parseQuery("https://x/api/v1/interactions?limit=5000", interactionsQuery);
check("an oversized limit is rejected", tooMany.ok === false);

console.log("\nfollow-up patch");
check("complete parses", followupPatchBody.safeParse({ status: "complete" }).success);
check(
  "snooze needs a date",
  !followupPatchBody.safeParse({ status: "snoozed" }).success
);
check(
  "snooze with a date parses",
  followupPatchBody.safeParse({ status: "snoozed", dueAt: "2026-10-01T09:00:00.000Z" }).success
);
check("an unknown status is rejected", !followupPatchBody.safeParse({ status: "yolo" }).success);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll connector API schema checks passed.");
process.exit(0);
```

Register in `scripts/run-smoke.ts` (`// pure` block):

```ts
  "smoke-api-connector-routes": "pure",
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-api-connector-routes.ts`
Expected: FAIL — `noteBody` is not exported from `src/lib/api/schemas.ts`.

- [ ] **Step 3: Add the schemas**

In `src/lib/api/schemas.ts`, after `followupsQuery` (:111):

```ts
/**
 * A note from outside the app — an Apple Note shared in, an Obsidian daily note, a Zap.
 *
 * Text only. The parse that turns it into people and commitments is the app's, and running
 * it here would mean duplicating the whole capture pipeline behind a second door.
 */
export const noteBody = z.object({
  text: z.string().trim().min(1, "A note needs some text").max(50_000),
  /** Shown on the capture card so a user can tell where it came from. */
  sourceLabel: z.string().trim().max(200).optional(),
  contactId: z.string().uuid().optional(),
});

export const interactionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** ISO 8601. Everything changed at or after this instant. */
  updated_since: z.string().datetime().optional(),
  contactId: z.string().uuid().optional(),
});

export const followupPatchBody = z
  .object({
    status: z.enum(["complete", "snoozed"]),
    dueAt: z.string().datetime().optional(),
  })
  .refine((v) => v.status !== "snoozed" || Boolean(v.dueAt), {
    message: "Snoozing needs a dueAt",
    path: ["dueAt"],
  });

export type NoteBody = z.infer<typeof noteBody>;
export type FollowupPatchBody = z.infer<typeof followupPatchBody>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx scripts/smoke-api-connector-routes.ts`
Expected: PASS — "All connector API schema checks passed."

- [ ] **Step 5: Write the three routes**

Read `node_modules/next/dist/docs/` for the current route-handler and dynamic-segment conventions before writing these — this Next.js differs from what you may remember.

`src/app/api/v1/notes/route.ts`:

```ts
/**
 * Send a note into Orbit.
 *
 * Enqueues a capture job rather than writing contacts directly: extracting people, dates and
 * commitments is the app's AI pipeline, and a second implementation behind the API would
 * drift from it immediately. The caller gets the job id and can poll, or simply forget it —
 * the result shows up in the app's capture queue either way.
 */
import { apiHandler, apiOk, readJson } from "@/lib/api/http";
import { noteBody } from "@/lib/api/schemas";
import { createCaptureJob } from "@/lib/capture-jobs";
import { runCaptureJobById } from "@/lib/capture-job-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = apiHandler({ scope: "write", bucket: "apiWrite" }, async (request, { caller }) => {
  const body = await readJson(request, noteBody);
  const job = await createCaptureJob(caller.userId, {
    sourceKind: "messy",
    status: "queued",
    inputText: body.text,
    sourceLabel: body.sourceLabel ?? "API",
    seedContactId: body.contactId ?? null,
  });
  // Fire and forget: the drain and the app's own poller both resume a stalled job, so a
  // dropped kick costs latency and never the note.
  void runCaptureJobById(job.id).catch(() => null);
  return apiOk({ noteId: job.id, status: "queued" }, { status: 202 });
});
```

`src/app/api/v1/interactions/route.ts`:

```ts
/**
 * The timeline, for tools that mirror it — the Obsidian plugin's incremental pull.
 *
 * `updated_since` is what makes that pull incremental; without it every sync is a full
 * table scan on the client's side.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactions } from "@/db/schema";
import { apiError, apiHandler, apiOk } from "@/lib/api/http";
import { interactionsQuery, parseQuery } from "@/lib/api/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiHandler({ scope: "read", bucket: "apiRead" }, async (request, { caller }) => {
  const parsed = parseQuery(request.url, interactionsQuery);
  if (!parsed.ok) {
    return apiError({ code: "invalid_request", message: parsed.message, param: parsed.param });
  }
  const db = await getDb();
  const filters = [eq(interactions.userId, caller.userId)];
  if (parsed.data.updated_since) {
    filters.push(gte(interactions.interactionDate, new Date(parsed.data.updated_since)));
  }
  if (parsed.data.contactId) {
    filters.push(eq(interactions.contactId, parsed.data.contactId));
  }
  const rows = await db
    .select({
      id: interactions.id,
      contactId: interactions.contactId,
      contactName: contacts.fullName,
      type: interactions.interactionType,
      occurredAt: interactions.interactionDate,
      source: interactions.source,
      summary: interactions.aiSummary,
      topics: interactions.topics,
    })
    .from(interactions)
    .leftJoin(contacts, eq(contacts.id, interactions.contactId))
    .where(and(...filters))
    .orderBy(desc(interactions.interactionDate))
    .limit(parsed.data.limit);

  return apiOk({
    interactions: rows.map((r) => ({
      ...r,
      occurredAt: r.occurredAt ? new Date(r.occurredAt).toISOString() : null,
    })),
  });
});
```

`src/app/api/v1/followups/[id]/route.ts`:

```ts
/**
 * Complete or snooze one follow-up.
 *
 * The write half of `GET /v1/followups`, and what makes the Apple Shortcut a round trip
 * rather than a one-way mirror: ticking the reminder off in Reminders comes back here.
 */
import { ApiRequestError, apiHandler, apiOk, readJson } from "@/lib/api/http";
import { followupPatchBody } from "@/lib/api/schemas";
import { completeReminder, snoozeReminderTo } from "@/lib/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = apiHandler({ scope: "write", bucket: "apiWrite" }, async (request, { caller }) => {
  const id = new URL(request.url).pathname.split("/").filter(Boolean).pop();
  if (!id) throw new ApiRequestError("invalid_request", "Which follow-up?", "id");
  const body = await readJson(request, followupPatchBody);

  if (body.status === "complete") {
    await completeReminder(caller.userId, id);
    return apiOk({ id, status: "complete" });
  }
  await snoozeReminderTo(caller.userId, id, new Date(body.dueAt!));
  return apiOk({ id, status: "snoozed", dueAt: body.dueAt });
});
```

Check the real signatures of `completeReminder` (`src/lib/reminders.ts:1287`) and `snoozeReminderTo` (:1177) before wiring — if either takes `(id, userId)` rather than `(userId, id)`, match the file, and if either returns a not-found signal rather than throwing, map it to `apiError({ code: "not_found", … })`.

- [ ] **Step 6: Document the routes**

In `src/app/api/v1/openapi.json/route.ts`, add three `paths` entries beside the existing ones. Request bodies go through the same `body()` helper so the spec cannot drift from validation:

```ts
      "/notes": {
        post: {
          summary: "Send a note into Orbit",
          description:
            "Queues the note for the same extraction the app's capture uses. Returns 202 and a note id.",
          requestBody: body(noteBody),
          responses: { "202": OK },
        },
      },
      "/interactions": {
        get: {
          summary: "List interactions",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
            {
              name: "updated_since",
              in: "query",
              schema: { type: "string", format: "date-time" },
              description: "Everything at or after this instant, for incremental pulls.",
            },
            { name: "contactId", in: "query", schema: { type: "string", format: "uuid" } },
          ],
          responses: { "200": OK },
        },
      },
      "/followups/{id}": {
        patch: {
          summary: "Complete or snooze a follow-up",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          requestBody: body(followupPatchBody),
          responses: { "200": OK },
        },
      },
```

and extend that file's import to `import { contactCreateBody, eventsBody, followupPatchBody, noteBody, webhookEndpointBody } from "@/lib/api/schemas";`.

- [ ] **Step 7: Typecheck, lint and commit**

```bash
npx tsc --noEmit
npx next lint --file src/app/api/v1/notes/route.ts --file src/app/api/v1/interactions/route.ts --file "src/app/api/v1/followups/[id]/route.ts"
git add src/app/api/v1 src/lib/api/schemas.ts scripts/smoke-api-connector-routes.ts scripts/run-smoke.ts
git commit -m "Add /v1/notes, /v1/interactions and PATCH /v1/followups/:id"
```

---

### Task 9: Make the settings status action read the registry

**Files:**
- Modify: `src/actions/integrations.ts` (`getIntegrationStatuses` at :52)
- Create: `scripts/smoke-integration-statuses.ts`
- Modify: `scripts/run-smoke.ts:29` (MANIFEST)

**Interfaces:**
- Consumes: `CONNECTORS` (Task 1).
- Produces: `CONNECTOR_STATUS_LOOKUPS: Record<string, (userId: string) => Promise<IntegrationStatus>>`, exported from `src/actions/integrations.ts`. `IntegrationStatuses` keeps its `Record<string, IntegrationStatus>` shape so `integrations-settings.tsx` needs no change in this plan.

This is the seam that stops the registry from being a fourth list nobody reads. The existing per-lookup 8s `settle()` timeout and `"unknown"` fallback stay exactly as they are — they are what keeps one slow provider from blanking the dialog.

Two kinds of key live in `IntegrationStatuses` and must not be confused:

- **Service sections** — `ai`, `outreach`, `calendar` (the outbound ICS feed), `api`, `webhooks`. These are settings sections, not connectors, and the UI spec keeps them in their own nav group. Their existing status code is untouched.
- **Connectors** — the registry ids. Today only `google`, `gmail`, `outlook` and `linkedin` have lookups; `calendar_ics`, `luma`, `eventbrite`, `apollo` and `zapier` are registered by Task 1 and need lookups added here, or the smoke test fails.

Note `statuses.gmail` and `statuses.google` deliberately share one value — they are one Google grant — and `gmail` is a tab id rather than a registry id, so it is written alongside the loop rather than inside it.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-integration-statuses.ts`:

```ts
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
  const has = CONNECTOR_STATUS_LOOKUP_IDS.includes(connector.id);
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
```

Register in `scripts/run-smoke.ts` (`// pure` block):

```ts
  "smoke-integration-statuses": "pure",
```

The script imports the id list from `src/lib/connectors/status.ts` rather than from the action: `src/actions/integrations.ts` reaches `@/db` through its lookups, and a `pure`-tier script that imports `../src/db` is rejected by `npm run test:check`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-integration-statuses.ts`
Expected: FAIL — `Cannot find module '../src/lib/connectors/status'`.

- [ ] **Step 3: Add the id list**

Create `src/lib/connectors/status.ts` — names only, no database reach, so both a pure smoke script and a client component can load it:

```ts
/**
 * Connector ids that `getIntegrationStatuses` answers for.
 *
 * Split from the action because the action reaches the database through its lookups, and
 * `scripts/smoke-integration-statuses.ts` has to compare this list against the registry
 * without loading a driver. The action asserts it implements exactly these ids, so the two
 * cannot drift.
 */
export const CONNECTOR_STATUS_LOOKUP_IDS = [
  "google",
  "outlook",
  "linkedin",
  "calendar_ics",
  "luma",
  "eventbrite",
  "apollo",
  "zapier",
] as const;

export type ConnectorStatusId = (typeof CONNECTOR_STATUS_LOOKUP_IDS)[number];
```

- [ ] **Step 4: Add the five missing lookups to the action**

In `src/actions/integrations.ts`, keep the existing `settle()` fan-out and every existing status body exactly as it is — `ai`, `outreach`, `calendar`, `api`, `webhooks`, `google`/`gmail`, `outlook` and `linkedin` are all correct, including LinkedIn's hardcoded `{ state: "off", detail: "Upload a CSV export" }`, which is right because there is nothing to connect.

Add these imports:

```ts
import { listCalendarSubscriptions } from "@/actions/calendar";
import { listEventConnections } from "@/lib/events/connections";
import { requireUserId } from "@/lib/auth";
import { CONNECTOR_STATUS_LOOKUP_IDS } from "@/lib/connectors/status";
```

Extend the existing `Promise.all` with two more settled reads:

```ts
  const [settings, feed, keys, webhooks, google, outlook, icsSubs, eventConns] =
    await Promise.all([
      settle(getSettings()),
      settle(getCalendarFeedStatus()),
      settle(listApiKeys()),
      settle(listWebhookEndpoints()),
      settle(getGmailConnectionStatus()),
      settle(getOutlookConnectionStatus()),
      settle(listCalendarSubscriptions()),
      settle(requireUserId().then((id) => listEventConnections(id))),
    ]);
```

Then, after the existing `statuses.linkedin` line and before the `return`:

```ts
  // Inbound calendar subscriptions, distinct from `statuses.calendar`, which is the OUTBOUND
  // feed Orbit publishes. Two different directions that have shared a word for too long.
  statuses.calendar_ics =
    icsSubs === "unknown"
      ? "unknown"
      : icsSubs.length === 0
        ? { state: "off", detail: "No feeds" }
        : {
            state: icsSubs.some((s) => s.lastSyncStatus === "error") ? "partial" : "on",
            detail: plural(icsSubs.length, "feed"),
          };

  if (eventConns === "unknown") {
    statuses.luma = "unknown";
    statuses.eventbrite = "unknown";
  } else {
    for (const id of ["luma", "eventbrite"] as const) {
      // `luma` and `luma_ics` are separate providers on the same platform; either one means
      // Luma is connected as far as the catalog is concerned.
      const conns = eventConns.filter((c) => c.provider.startsWith(id));
      statuses[id] =
        conns.length === 0
          ? { state: "off", detail: "Not connected" }
          : conns.some((c) => c.status === "needs_reauth")
            ? { state: "partial", detail: "Reconnect needed" }
            : { state: "on", detail: "Connected" };
    }
  }

  // Apollo and Zapier have no connection of their own: Apollo is a key on user_settings and
  // Zapier is whatever API keys exist. Both are read from data already fetched above.
  statuses.apollo =
    settings === "unknown"
      ? "unknown"
      : settings.outreach.apollo
        ? { state: "on", detail: "Key saved" }
        : { state: "off", detail: "No key yet" };

  statuses.zapier =
    keys === "unknown"
      ? "unknown"
      : keys.length > 0
        ? { state: "on", detail: plural(keys.length, "key") }
        : { state: "off", detail: "No keys" };

  // The registry and this action must answer for the same connectors. The smoke test checks
  // the list against the registry; this checks the implementation against the list.
  for (const id of CONNECTOR_STATUS_LOOKUP_IDS) {
    if (!(id in statuses)) statuses[id] = { state: "off", detail: "Not connected" };
  }
```

If `listCalendarSubscriptions()` or `listEventConnections()` returns a different field name than `lastSyncStatus` / `status` / `provider`, read the real shape (`src/actions/calendar.ts:52`, `src/lib/events/connections.ts:222`) and match it — the file is the truth.

- [ ] **Step 5: Run the tests**

```bash
npx tsx scripts/smoke-integration-statuses.ts
npm run test:check
npx tsc --noEmit
```

Expected: all pass.

- [ ] **Step 6: Verify the dialog still renders**

Start the preview (`preview_start` with the project's dev server; never `npm run dev` through Bash, and check no server is already running on this worktree — a second `next dev` sharing one `.next` wedges it). Open `/settings?integration=api`, confirm the Integrations dialog opens on the API tab and every row shows a status dot rather than a blank. Check the console for errors with `read_console_messages`.

- [ ] **Step 7: Commit**

```bash
git add src/actions/integrations.ts src/lib/connectors/status.ts scripts/smoke-integration-statuses.ts scripts/run-smoke.ts
git commit -m "Answer for every registered connector in the integration statuses"
```

---

### Task 10: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole smoke suite**

```bash
npm test
```

Expected: every script passes. If `smoke-admin-render` or `smoke-instrumentation` times out, check machine load first — they time out above load ~100 and rerunning them alone usually passes. A `PENDING:` row is degraded coverage, not a failure.

- [ ] **Step 2: Typecheck and lint the whole repo**

```bash
npx tsc --noEmit
npm run lint
```

Expected: 0 type errors; eslint 0 errors and roughly 36 warnings. Any error is from this plan.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: pass. A `node:fs` chunking error that names neither file means a client component now reaches `@/db` — the usual cause is `registry.ts` gaining a database import.

- [ ] **Step 4: Confirm the migration applies cleanly**

```bash
npx tsx scripts/smoke-schema-ddl.ts
npx tsx scripts/smoke-schema-upgrade.ts
npx tsx scripts/smoke-purge.ts
```

Expected: pass, with the lock file at version 75 and unmodified since Task 7's `--update`.

- [ ] **Step 5: Commit any lock or snapshot drift**

```bash
git status --short
```

Expected: clean. If `scripts/schema-ddl.lock.json` moved, commit it — never hand-edit it.

---

## Scope calls against the spec

Three items the spec lists under P0 are deliberately **not** in this plan, with reasons:

- **Harvesting `11ee7eba` (Outlook Calendar sync) and `c74dd8dd` (per-capability Google consent).** Both are connector work on the Google/Microsoft path, not foundation. Outlook Calendar belongs with the rest of Tier 1 in P1, and the consent split is the precedent P1 follows when it adds Gmail metadata scope. Porting them here would mean touching `gmail.ts` / `outlook.ts`, which this plan otherwise leaves alone.
- **`updated_since` on `/v1/contacts` and `/v1/followups`.** Task 8 adds it to `/v1/interactions`, which is the route the Obsidian plugin and the Shortcut actually poll. Adding it to the other two is a one-line schema change each and belongs with the first consumer that needs it, rather than shipping an untested parameter.
- **The closeness, metadata-default and scheduler-fairness guardrails.** They are per-connector rules with nothing to bind to until a connector produces volume. P1's Gmail task owns them: coverage-aware closeness through `loadCoverageSources`, metadata-only defaults, and push subscriptions in place of polling. The one guardrail that is here is the route registration in `PUBLIC_ROUTES` (Task 7).

## Notes for the executor

- **Do not touch** `gmail_connections`, `outlook_connections`, `src/lib/gmail.ts` or `src/lib/outlook.ts`. P0 adds a parallel path; migrating the legacy tables is explicitly rejected in `provider-connections.ts`'s header and is not in scope.
- **Do not wire the Integrations dialog's layout** (Home view, detail pane, Request button). That is the UI plan, built on `docs/superpowers/specs/2026-09-19-integrations-ui-design.md`. Task 9 only moves the status action onto the registry.
- **No connector is implemented here.** The registry's `sync` functions stay undefined for every entry; Task 4's smoke test proves the scheduler handles that case rather than throwing.
- If a task reveals that a signature in this plan does not match the code, fix the plan's assumption to match the file and say so in the commit message — the file is the truth.
