# Leads P4: HubSpot Read Sync, the `crm` Entitlement, and Work Contacts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A salesperson on a paid plan connects HubSpot from the `/leads` page; every 30 minutes Orbit reads the HubSpot contacts they own, turns customers into Orbit contacts (a "Work" view on Contacts lists them), and puts leads into the Leads pipeline — where the P2/P3 warm-path ranking already shows who on the team knows them. Everything stays behind the coming-soon gate.

**Architecture:** A `crm_records` table (schema v94) is the sync ledger and the contact↔CRM map; `leads.crm_record_id` ties a pipeline row to its CRM record. The connector spine (PR #262, merged into this branch) gains three fixes: `sync` receives the claimed connection, a server-only sync resolver keeps the registry client-safe, and the cursor gets a `meta` bag. HubSpot is a pure mapping module, a thin fetch client with an error taxonomy, and a sync that pages owned contacts by `lastmodifieddate`, writes one page at a time, and records its own cursor. OAuth starts in a Server Action (every existing flow does) and returns through one route handler. The paid half is a new `crm` FeatureKey.

**Tech Stack:** Next.js 16 App Router (Server Components, Server Actions, one route handler), React 19, Tailwind v4, Base UI kit in `src/components/ui/`, Drizzle on Postgres/PGlite, runtime DDL in `src/db/index.ts`, `tsx` smokes registered in `scripts/run-smoke.ts`, HubSpot CRM v3 REST (verified facts in Task 6).

**Spec:** `docs/superpowers/specs/2026-09-22-leads-design.md` (Decisions, Data model `crm_records` and `leads`, Modules, CRM sync). P3's plan `docs/superpowers/plans/2026-09-23-leads-p3-pipeline.md` built the `leads` store this one extends. The spine's own plan is `docs/superpowers/plans/2026-09-19-integrations-p0-foundation.md`.

**Branch:** `claude/leads-p4-hubspot`, stacked on `claude/leads-p3-pipeline` (PR #267), with `origin/claude/orbit-integrations-strategy-0b8be6` (PR #262, the connector spine) already merged in at commit `63f2e17e`. The PR targets `claude/leads-p3-pipeline` and says in its body that it carries #262's diff until #262 merges.

## Global Constraints

- `SCHEMA_VERSION` is already **94** (set by the spine merge; its changelog entry names P4's DDL). 93 = `claude/onboarding-flow-revision-b7be62`. Do not bump again inside this branch; the controller rescans every ref and worktree (`bash -c`, never zsh) before pushing. After any DDL change run `npx tsx scripts/smoke-schema-ddl.ts --update`. Local `.data/pglite` stamped 94 before Task 2 lands will NOT pick up Task 2's DDL — smokes use their own directory; the controller moves `.data/pglite` aside before the browser check.
- New table: Drizzle in `src/db/schema.ts` + `CREATE TABLE IF NOT EXISTS` with its indexes in the `DDL` template + `scripts/setup-db.ts` `EXPECTED_TABLES` + a purge step + a seeded row in `scripts/smoke-purge.ts` + counted AND exported in `src/lib/user-data.ts`. New column on an existing table: the template's `CREATE TABLE` + an `alters` `ALTER TABLE … ADD COLUMN IF NOT EXISTS` + `ensureColumn` in `migratePglite`. An index on a NEW column of an EXISTING table goes in `alters` only (after its ADD COLUMN): the template runs before `alters`, so an index there would fail on every existing database and the version would never stamp. No `--` comments or `;` inside DDL strings. Never `db:push`.
- This repo's `Db` type is a union: write `.returning()` bare and read fields off the full row.
- Identity columns (`email_normalized` on `crm_records`; every identity column on `leads`) come only from `identityKeysFor` (via `normalizeLeadInput` for leads). Company key = `normalizeCompanyName(displayCompanyName(raw))`.
- `src/lib/connectors/registry.ts` stays client-safe: no value import of `@/db`, `next/*`, or any module that reaches them; type-only imports are fine. Sync functions live in `src/lib/connectors/syncs.ts`. Pure modules never value-import `@/db`: `src/lib/crm/types.ts`, `src/lib/crm/hubspot/mapping.ts`, `src/lib/crm/crm-leads-plan.ts`. Files in `src/components/leads/` and `src/components/contacts/` never value-import a server module.
- No `import "server-only"` anywhere: the package throws under `tsx`, and the scheduler's smokes load these modules.
- Every export of a `"use server"` file is an `async function`; no `export type`, no `export const`. `src/actions/leads.ts` keeps exactly its 6 exports (`scripts/smoke-warm-path.ts` counts them) — CRM actions live in a NEW `src/actions/crm.ts`.
- Writes return `ActionResult` via `asActionResult`; reads return plain data. Every CRM Server Action's first statement is `const userId = await requireLeadsUser();`; connect and sync then check the `crm` entitlement inside `asActionResult` (so the refusal reaches the person as words), disconnect never does. The OAuth callback route uses `requireCrmUser()`.
- `UserFacingError`, toast copy and `ActionResult` error strings pass `smoke-toast-copy`: no trailing period, curly ’ never a straight apostrophe, " — " joins an outcome to a next step, never "could not" or "failed". Toasts from `@/lib/toast`; errors through `friendlyError(err, fallback)`.
- Every string literal written into `src/components/leads/`, `src/components/contacts/`, `src/lib/crm/` is plain UTF-8: curly ’ is the one byte sequence E2 80 99, em dash E2 80 94. `scripts/smoke-leads-page.ts` byte-scans `src/components/leads`; Task 11 extends it to `src/lib/crm` and the new contacts files.
- Network calls take an injectable `fetchImpl` (default `fetch`) and a timeout via `AbortSignal.timeout(15_000)`. No smoke ever reaches the real network.
- Every new smoke is registered in `MANIFEST` in `scripts/run-smoke.ts`; `npx tsx scripts/run-smoke.ts --check` passes.
- Never pipe `npm test` through `tail`: zsh reports tail's exit code. Redirect to a file and grep `^ *FAIL`.
- Implementers never run `next dev`, `next build` or any drizzle push; the controller does the build and the browser check in Task 14.
- Commit after every task with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` — exactly that model name.

## Rulings against the spec (recorded here so reviewers judge them, not rediscover them)

1. **P1 is PR #262.** The spine landed as its own PR at schema 87 while P4 waited. This branch merges it rather than waiting for it; the three spine fixes the spec assigned to P1 (claimed connection into `sync`, server-only resolver, cursor `meta`) are Task 1 here.
2. **Connect lives on `/leads`, not in Settings.** PR #257 is still open and reshapes the Integrations dialog; a HubSpot settings tab now would conflict with it and would also need the settings page's coming-soon filter fix. A CRM card on `/leads` is gated by the page itself. A settings tab can follow at P7.
3. **OAuth starts in a Server Action, not a `connect` route.** Gmail, Outlook and Eventbrite all start this way; a GET route would answer a signed-out browser with the proxy's raw JSON 401, and the action gets `requireCrmUser()` (paywall + released surface) for free. Only the callback is a route: `src/app/api/connectors/[connectorId]/callback/route.ts`.
4. **Engagements (`syncEvents`) are deferred.** The spec calls them optional; P4 reads people only. The manifest lists only `syncPeople`; engagements and write-back return with P6.
5. **Lifecycle routing:** `customer` → Orbit contact (a work contact); `lead` AND `other` (including no stage and custom stages) → the Leads pipeline. Most portals leave `lifecyclestage` blank on hand-created contacts; routing "other" nowhere would make a first connect look empty. The pipeline never touches the contact cap, and the user can "Add to contacts" or dismiss.
6. **A record already linked to a live contact is not re-ingested.** Its `crm_records` row still updates; only unlinked customers go through `ingestPeople`. Re-ingesting would risk a duplicate when the user has edited the contact's email since. Consequence: a work contact the user deletes in Orbit comes back the next time HubSpot modifies that record.
7. **No deletion propagation.** A HubSpot contact deleted, archived, or reassigned to another owner keeps its `crm_records` row until disconnect. P6 revisits.
8. **"Sync now"** runs one bounded sync in the action (claims the row with a lease so it never overlaps the scheduler; 40 s budget; resumable cursor), rate-limited on the `providerSync` bucket (4/hour), which nothing else consumes.
9. **Disconnect** revokes the refresh token best-effort, deletes the connection and that connector's `crm_records`. Contacts it created stay (they are the user's now); CRM leads stay as leads with `crm_record_id` nulled by the FK.
10. **Localhost demo** seeds a HubSpot connection with no token and `next_sync_at` null, plus `crm_records` for four demo contacts and two CRM leads, only into a local database (the P3 `demoTeamAllowed` rule). "Sync now" in demo mode answers that the demo's HubSpot data is sample data.
11. **Public pricing stays silent until P7.** `plan-comparison.tsx`, `PLAN_COPY` and the pricing FAQ are marketing; a row for a coming-soon feature would sell something nobody can reach. The `crm` key, its denial copy, the gate and the admin/demand rows land now.
12. **A downgrade stops the sync, it deletes nothing.** Every run checks `canUseCrm`; without it the connection is disarmed with an upgrade message. Disconnect never checks the plan.
13. **No retry pass for cap-refused customers.** Paid plans (the only ones that can connect) have no contact cap, so `link_blocked_at` is reachable only through a downgrade-and-reconnect edge; such a record is retried the next time HubSpot modifies it. The card shows the count.
14. **HubSpot's dated `2026-09` API from day one.** OAuth v1 (`/oauth/v1/*`) shuts down 2027-02-16 and CRM v3 goes unsupported Sept 2027; the spine's `oauth/v1/token` URL moves to `oauth/2026-09/token` in Task 7. Company comes from the contact's own `company` property (`associatedcompanyid` is gone), so there is no companies scope and no company batch read.

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/connectors/registry.ts` | `sync` takes the claimed connection; HubSpot → available, `crm` entitlement, scopes |
| `src/lib/connectors/syncs.ts` (new, server) | `CONNECTOR_SYNCS`, `resolveConnectorWithSync` |
| `src/lib/connectors/connections.ts` | `tokenExpiresAt` on the claim, `claimConnectorConnectionForUser`, `updateConnectorTokens`, `saveConnectorCursor`, `getConnectorRefreshToken`, richer summary |
| `src/lib/connectors/auth-errors.ts` (new, import-free) | `ConnectorAuthError`, `ConnectorNeedsReauthError` |
| `src/lib/connectors/token.ts` (new, server) | `openConnectorAuth`: proactive + one reactive refresh, then needs-reauth |
| `src/lib/connectors/oauth.ts` | HubSpot's dated token URL, the `scopes` array, `extra`, `oauthClientCredentials`, `isOAuthConfigured` |
| `src/lib/connectors/status.ts`, `src/actions/integrations.ts` | a `hubspot` status lookup |
| `src/lib/sync-scheduler.ts` | resolve through `resolveConnectorWithSync`, pass the claimed row |
| `src/db/schema.ts`, `src/db/index.ts`, `scripts/setup-db.ts` | `crm_records`, `leads.crm_record_id`, cursor `meta` |
| `src/lib/user-data.ts`, `src/lib/data-categories.ts`, `src/lib/contact-merge.ts` | purge, export, merge repoint |
| `src/lib/entitlements.ts` + 9 more (Task 3) | the `crm` FeatureKey |
| `src/lib/plan-guards.ts` | `requireCrmUser()` |
| `src/lib/ingest/people.ts` | `resolutions` by input index |
| `src/lib/crm/types.ts` (pure) | `CrmPerson`, `CrmLifecycle` |
| `src/lib/crm/hubspot/mapping.ts` (pure) | properties list, lifecycle, search body, record mapping, record URL |
| `src/lib/crm/hubspot/api.ts` (server, database-free) | fetch client + `HubspotApiError`; token introspection, owner, search, revoke |
| `src/lib/crm/records.ts` (server) | `upsertCrmRecords`, `linkCrmRecords`, `markCrmLinksBlocked`, counts, remote URL lookup, delete |
| `src/lib/crm/crm-leads-plan.ts` (pure), `src/lib/leads/crm-leads.ts` (server) | CRM leads into the pipeline, in bulk |
| `src/lib/crm/persist.ts` (server) | one CRM page into Orbit — records, contacts, links, leads |
| `src/lib/crm/manage.ts` (server) | the CRM card's status, Sync now, disconnect |
| `src/lib/crm/work-contacts.ts` | the Work view's WHERE fragment |
| `src/lib/crm/hubspot/sync.ts` (server) | `syncHubspot` |
| `src/lib/crm/connect.ts` (server) | `crmRedirectUri`, `completeCrmConnect` |
| `src/app/api/connectors/[connectorId]/callback/route.ts` | the OAuth callback |
| `src/lib/error-events.ts`, `.env.example` | `oauthConnectorCallback`, HubSpot env |
| `src/actions/crm.ts` (new) | `loadCrmStatusAction`, `startCrmConnectAction`, `syncCrmNowAction`, `disconnectCrmAction` |
| `src/components/leads/crm-card-view.tsx` (new, pure), `src/components/leads/crm-card.tsx` (new, client), `src/app/(clerk)/(app)/(main)/leads/{page,loading}.tsx`, `src/components/loading/page-skeletons.tsx`, `src/components/leads/lead-detail-sheet.tsx` | the CRM card; "Open in HubSpot" |
| `src/lib/surface-visibility.ts`, `src/lib/people-nav.ts`, `src/components/contacts/{people-list-shell,contacts-filters,contacts-list}.tsx`, `src/lib/contacts-page.ts`, `src/actions/contacts.ts`, `contacts/page.tsx`, `contacts/[id]/page.tsx`, `recruiters/page.tsx` | the Work view (`isSurfaceReleased`) |
| `src/lib/demo-data/crm.ts` (new), `src/lib/demo-data/seed.ts` | the demo HubSpot |
| smokes (see each task) | tests |

---

### Task 1: Spine fixes — `sync` gets the claimed connection, a server-only resolver, cursor `meta`, token plumbing

**Files:**
- Modify: `src/lib/connectors/registry.ts` (the `sync?` field, ~line 168, and its doc comment)
- Create: `src/lib/connectors/syncs.ts`
- Modify: `src/lib/connectors/connections.ts` (`ClaimedConnectorConnection`, `ClaimRow`, the claim's RETURNING, new functions)
- Modify: `src/db/schema.ts` (`ConnectorSyncCursor`, ~line 2198)
- Modify: `src/lib/sync-scheduler.ts` (import, `SyncDeps.resolveConnector` doc, `DEFAULT_DEPS`, the dispatch ~line 610-622)
- Test: `scripts/smoke-connector-sync-pass.ts`, `scripts/smoke-connector-claim.ts`, `scripts/smoke-connector-registry.ts`

**Interfaces:**
- Produces:
  - `ConnectorManifest.sync?: (conn: ClaimedConnectorConnection) => Promise<void>`
  - `ClaimedConnectorConnection` gains `tokenExpiresAt: Date | null`
  - `ConnectorSyncCursor` gains `meta?: Record<string, string> | null`
  - `CONNECTOR_SYNCS: Partial<Record<ConnectorId, ConnectorSync>>`, `type ConnectorSync = (conn: ClaimedConnectorConnection) => Promise<void>`, `resolveConnectorWithSync(id: string, syncs?: Partial<Record<string, ConnectorSync>>): ConnectorManifest | null` — all from `@/lib/connectors/syncs`
  - `claimConnectorConnectionForUser(userId: string, connectorId: string, now?: Date): Promise<ClaimedConnectorConnection | null>`
  - `updateConnectorTokens(id: string, tokens: { accessToken: string; refreshToken: string | null; expiresAt: Date | null }): Promise<void>`
  - `saveConnectorCursor(id: string, cursor: ConnectorSyncCursor): Promise<void>` — stores progress mid-run WITHOUT releasing the lease, so a run killed after page 7 resumes at page 8
  - `ConnectorConnectionSummary` gains `syncStatus: string | null`, `syncStartedAt: Date | null`, `nextSyncAt: Date | null`

- [ ] **Step 1: Write the failing checks**

In `scripts/smoke-connector-sync-pass.ts`:
- change the `ConnectorManifest` import line to also import the claimed type: add `import type { ClaimedConnectorConnection } from "../src/lib/connectors/connections";`
- change `stubManifest`'s parameter to `sync: (conn: ClaimedConnectorConnection) => Promise<void>`
- change `const handed: string[] = [];` to `const handed: ClaimedConnectorConnection[] = [];`, the stub body to `handed.push(conn);` (param renamed `conn`), and the check to:

```ts
  check("its sync was actually called, with its claimed connection", handed[0]?.id === okConn.id, JSON.stringify(handed.map((c) => c.id)));
  // The point of passing the row rather than its id: the claim already decrypted the secret,
  // and a sync that had to re-read it would hold a second copy of the decrypt path.
  check("and the secret arrives already decrypted", handed[0]?.accessToken === "k", String(handed[0]?.accessToken));
```

- in the `stub-owns-result` stub, rename the param to `conn` and call `markConnectorSyncResult(conn.id, …)`
- in the "one connector's failure" block, `const bothHanded: string[]` stays; its stub becomes `async (conn) => { bothHanded.push(conn.id); }`

In `scripts/smoke-connector-claim.ts`, extend the import from `connections` with `claimConnectorConnectionForUser`, `updateConnectorTokens` and `saveConnectorCursor`, pass `tokenExpiresAt: new Date(now.getTime() + 3_600_000)` to the first `upsertConnectorConnection` call, and add after the existing `check("capabilities come back", …)`:

```ts
  check(
    "the token expiry comes back with the claim",
    mine[0]?.tokenExpiresAt?.getTime() === now.getTime() + 3_600_000,
    String(mine[0]?.tokenExpiresAt?.toISOString())
  );
```

Then, directly before the final `await db.delete(connectorConnections)…` cleanup, add:

```ts
  console.log("\nclaiming one user's connection on demand (Sync now)");
  const onDemand = await upsertConnectorConnection({
    userId: USER,
    connectorId: "on-demand",
    authKind: "oauth2",
    accessToken: "od-access",
    refreshToken: "od-refresh",
    nextSyncAt: null,
  });
  const firstClaim = await claimConnectorConnectionForUser(USER, "on-demand");
  check("an idle connection is claimed even when it is not armed", firstClaim?.id === onDemand.id);
  const secondClaim = await claimConnectorConnectionForUser(USER, "on-demand");
  check("a leased connection is not claimed twice", secondClaim === null);
  const laterClaim = await claimConnectorConnectionForUser(
    USER,
    "on-demand",
    new Date(Date.now() + SYNC_LEASE_MS + 1000)
  );
  check("an expired lease is claimable again", laterClaim?.id === onDemand.id);
  await db
    .update(connectorConnections)
    .set({ status: "needs_reauth", syncStatus: "idle" })
    .where(eq(connectorConnections.id, onDemand.id));
  check(
    "a connection that needs reauth is never claimed",
    (await claimConnectorConnectionForUser(USER, "on-demand")) === null
  );
  check("nobody else's connection is claimed", (await claimConnectorConnectionForUser("someone-else", "on-demand")) === null);

  console.log("\nstoring a refreshed token");
  const expires = new Date(Date.now() + 1_800_000);
  await updateConnectorTokens(onDemand.id, { accessToken: "od-access-2", refreshToken: null, expiresAt: expires });
  const [refreshed] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, onDemand.id));
  check("the new access token is stored encrypted", decryptOrNull(refreshed?.accessTokenEncrypted ?? null) === "od-access-2");
  check("a refresh that returns no refresh token keeps the old one", decryptOrNull(refreshed?.refreshTokenEncrypted ?? null) === "od-refresh");
  check("the expiry is stored", refreshed?.tokenExpiresAt?.getTime() === expires.getTime());
  await updateConnectorTokens(onDemand.id, { accessToken: "od-access-3", refreshToken: "od-refresh-2", expiresAt: null });
  const [rotated] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, onDemand.id));
  check("a rotated refresh token replaces the old one", decryptOrNull(rotated?.refreshTokenEncrypted ?? null) === "od-refresh-2");

  console.log("\nsaving progress mid-run");
  await db
    .update(connectorConnections)
    .set({ status: "active", syncStatus: "idle" })
    .where(eq(connectorConnections.id, onDemand.id));
  const midRun = await claimConnectorConnectionForUser(USER, "on-demand");
  await saveConnectorCursor(onDemand.id, { cursor: "200", syncedThrough: "2026-09-01T00:00:00.000Z", meta: { portalId: "42" } });
  const [progressed] = await db.select().from(connectorConnections).where(eq(connectorConnections.id, onDemand.id));
  check("the cursor is stored", progressed?.syncCursor?.cursor === "200" && progressed?.syncCursor?.meta?.portalId === "42", JSON.stringify(progressed?.syncCursor));
  check("the lease is kept", progressed?.syncStatus === "syncing" && midRun !== null, String(progressed?.syncStatus));
```

In `scripts/smoke-connector-registry.ts`, replace the `"P0 ships no sync functions …"` check with:

```ts
// Sync functions never live on the registry's own entries: a sync reaches the database, and
// this file must stay loadable from a client component. They are attached by
// `resolveConnectorWithSync` in `./syncs.ts`, which only the scheduler and actions import.
check(
  "the registry's own entries carry no sync function (they live in syncs.ts)",
  syncable.length === 0,
  syncable.map((c) => c.id).join(",")
);
```

and append before the final summary:

```ts
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
```

with `import { CONNECTOR_SYNCS, resolveConnectorWithSync } from "../src/lib/connectors/syncs";` at the top (the file already imports `connectorById`; if not, add it to the registry import).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx scripts/run-smoke.ts --only smoke-connector-sync-pass smoke-connector-claim smoke-connector-registry`
Expected: FAIL — tsc-level import errors (`syncs` module missing, `claimConnectorConnectionForUser` not exported), or the sync-pass check "and the secret arrives already decrypted" failing because the stub receives a string.

- [ ] **Step 3: Implement**

`src/db/schema.ts`, in `ConnectorSyncCursor` after `syncedThrough`:

```ts
  /**
   * Small facts a sync learns once and reuses every pass — a CRM's portal id and the owner
   * record it filters on. Strings only: it round-trips through jsonb on both drivers.
   */
  meta?: Record<string, string> | null;
```

`src/lib/connectors/registry.ts`: add `import type { ClaimedConnectorConnection } from "@/lib/connectors/connections";` under the existing type imports (type-only: erased at build, so the client-bundle rule holds), change the field to `sync?: (conn: ClaimedConnectorConnection) => Promise<void>;`, and replace the first paragraph of its doc comment ("One sync pass for one connection, resolved by the scheduler …") with:

```ts
   * One sync pass for one claimed connection — secrets already decrypted by the claim.
   *
   * Never set on an entry in this file: a sync reaches the database, and this module must
   * stay loadable from a client component. `resolveConnectorWithSync` in `./syncs.ts`
   * attaches it, and only server code (the scheduler, the CRM actions) imports that.
```

Create `src/lib/connectors/syncs.ts`:

```ts
/**
 * The one place a connector's manifest meets its sync function.
 *
 * Server code only — the scheduler and the CRM actions import it — because every sync reaches
 * the database, and `registry.ts` has to stay loadable from a client component. Not marked
 * with `import "server-only"`: that package throws under `tsx`, and the scheduler's smokes
 * load this module.
 */
import type { ClaimedConnectorConnection } from "@/lib/connectors/connections";
import {
  connectorById,
  isSyncable,
  type ConnectorId,
  type ConnectorManifest,
} from "@/lib/connectors/registry";

export type ConnectorSync = (conn: ClaimedConnectorConnection) => Promise<void>;

/** Keyed by connector id. A planned connector listed here is still never synced. */
export const CONNECTOR_SYNCS: Partial<Record<ConnectorId, ConnectorSync>> = {};

/**
 * The manifest for `id` with its sync attached, when it has one and may run it. `syncs` is
 * injectable so a smoke can prove the planned-connector rule without registering a real sync.
 */
export function resolveConnectorWithSync(
  id: string,
  syncs: Partial<Record<string, ConnectorSync>> = CONNECTOR_SYNCS
): ConnectorManifest | null {
  const manifest = connectorById(id);
  if (!manifest) return null;
  const sync = syncs[manifest.id];
  if (!sync) return manifest;
  const withSync: ConnectorManifest = { ...manifest, sync };
  return isSyncable(withSync) ? withSync : manifest;
}
```

`src/lib/connectors/connections.ts`:

1. Add `tokenExpiresAt: Date | null;` to `ClaimedConnectorConnection` after `refreshToken`, and `token_expires_at: Date | string | null;` to `ClaimRow` after `refresh_token_encrypted`.
2. Add `token_expires_at` to the claim's `RETURNING` list (after `refresh_token_encrypted`).
3. Replace the inline `rows.map((row) => ({ … }))` in `claimDueConnectorConnections` with `rows.map(toClaimed)` and add above that function:

```ts
function toClaimed(row: ClaimRow): ClaimedConnectorConnection {
  return {
    id: row.id,
    userId: row.user_id,
    connectorId: row.connector_id,
    authKind: row.auth_kind,
    accountRef: row.account_ref,
    accessToken: decryptOrNull(
      row.auth_kind === "oauth2" ? row.access_token_encrypted : row.api_key_encrypted
    ),
    refreshToken: decryptOrNull(row.refresh_token_encrypted),
    tokenExpiresAt: row.token_expires_at ? new Date(row.token_expires_at) : null,
    scopes: row.scopes,
    capabilities: parseJson<string[]>(row.capabilities) ?? [],
    cursor: parseJson<ConnectorSyncCursor>(row.sync_cursor),
    syncFailures: row.sync_failures,
  };
}
```

4. Add after `claimDueConnectorConnections`:

```ts
/**
 * Claim ONE user's connection now, for "Sync now". The same lease as the scheduler's claim,
 * so the two can never run one connection at once — but it ignores `next_sync_at`: a
 * connection a failure disarmed is exactly the one a person presses "Sync now" on. Null when
 * there is no active connection or a run already holds the lease.
 */
export async function claimConnectorConnectionForUser(
  userId: string,
  connectorId: string,
  now: Date = new Date()
): Promise<ClaimedConnectorConnection | null> {
  const db = await getDb();
  const leaseCutoff = new Date(now.getTime() - SYNC_LEASE_MS);
  const rows = rowsOf<ClaimRow>(
    await db.execute(sql`
      UPDATE connector_connections
         SET sync_status = 'syncing', sync_started_at = ${now}, updated_at = ${now}
       WHERE user_id = ${userId}
         AND connector_id = ${connectorId}
         AND status = 'active'
         AND (sync_status IS DISTINCT FROM 'syncing' OR sync_started_at < ${leaseCutoff})
      RETURNING id, user_id, connector_id, auth_kind, account_ref, api_key_encrypted,
                access_token_encrypted, refresh_token_encrypted, token_expires_at, scopes,
                capabilities, sync_cursor, sync_failures
    `)
  );
  return rows[0] ? toClaimed(rows[0]) : null;
}

/**
 * Store a refreshed OAuth token. A refresh that returns no refresh token keeps the stored one
 * (most providers only rotate it sometimes); one that does replaces it.
 */
export async function updateConnectorTokens(
  id: string,
  tokens: { accessToken: string; refreshToken: string | null; expiresAt: Date | null }
): Promise<void> {
  const db = await getDb();
  await db
    .update(connectorConnections)
    .set({
      accessTokenEncrypted: encrypt(tokens.accessToken),
      ...(tokens.refreshToken ? { refreshTokenEncrypted: encrypt(tokens.refreshToken) } : {}),
      tokenExpiresAt: tokens.expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(connectorConnections.id, id));
}

/**
 * Store a sync's progress without ending the run: the lease stays, `sync_status` stays
 * `syncing`. A long first sync saves after every page, so a function killed at its time limit
 * (or a 429 that ends the run) resumes at the next page instead of the first.
 */
export async function saveConnectorCursor(id: string, cursor: ConnectorSyncCursor): Promise<void> {
  const db = await getDb();
  await db
    .update(connectorConnections)
    .set({ syncCursor: cursor, updatedAt: new Date() })
    .where(eq(connectorConnections.id, id));
}
```

5. In `ConnectorConnectionSummary` add `syncStatus: string | null; syncStartedAt: Date | null; nextSyncAt: Date | null;` after `syncError`, and in `listConnectorConnections`'s select add `syncStatus: connectorConnections.syncStatus, syncStartedAt: connectorConnections.syncStartedAt, nextSyncAt: connectorConnections.nextSyncAt,`.

`src/lib/sync-scheduler.ts`:
1. Add `import { resolveConnectorWithSync } from "@/lib/connectors/syncs";` next to the registry import; keep the `connectorById` import only if still referenced (the `SyncDeps` type uses `typeof connectorById` — change that field to `resolveConnector?: (id: string) => ConnectorManifest | null;` and import `type ConnectorManifest` from the registry, then drop `connectorById` if unused).
2. Replace the doc comment's first sentence on `resolveConnector` with "How a claimed connection's `connector_id` becomes a manifest with its sync attached." and keep the rest.
3. `DEFAULT_DEPS.resolveConnector: resolveConnectorWithSync,`
4. In the dispatch: `const manifest = (deps.resolveConnector ?? resolveConnectorWithSync)(conn.connectorId);` and `await manifest.sync(conn);`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx tsc --noEmit -p . > /tmp/p4-t1-tsc.txt 2>&1; echo tsc=$?` then `npx tsx scripts/run-smoke.ts --only smoke-connector-sync-pass smoke-connector-claim smoke-connector-registry smoke-connector-connections smoke-integration-statuses`
Expected: `tsc=0`; `5/5 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/connectors/registry.ts src/lib/connectors/syncs.ts src/lib/connectors/connections.ts src/db/schema.ts src/lib/sync-scheduler.ts scripts/smoke-connector-sync-pass.ts scripts/smoke-connector-claim.ts scripts/smoke-connector-registry.ts
git commit -m "Hand each sync its claimed connection, and keep sync functions out of the registry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: `crm_records` and `leads.crm_record_id` (schema v94), purge, export, merge

**Files:**
- Modify: `src/db/schema.ts` (new types + `crmRecords` directly ABOVE the `leads` table ~line 4781; a `crmRecordId` column and a partial unique on `leads`)
- Modify: `src/db/index.ts` (template: `crm_records` block directly ABOVE `CREATE TABLE IF NOT EXISTS leads`, and `crm_record_id` inside the leads CREATE; `alters`: the ADD COLUMN and the partial unique; `migratePglite`: an `ensureColumn`)
- Modify: `scripts/setup-db.ts` (`EXPECTED_TABLES`)
- Modify: `src/lib/user-data.ts` (the `connections` step: export, count, delete), `src/lib/data-categories.ts` (the `connections` description)
- Modify: `src/lib/contact-merge.ts` (`REPOINTED_TABLES`)
- Test: `scripts/smoke-purge.ts` (seed), `scripts/smoke-data-export.ts` (seed), `scripts/smoke-contact-merge.ts` (repoint + undo), `scripts/smoke-schema-ddl.ts` (`--update`)
- Regenerate: `scripts/schema-ddl.lock.json`

**Interfaces:**
- Produces (all from `@/db/schema`): `crmRecords` table; types `CrmRecord = typeof crmRecords.$inferSelect`, `CrmRemoteType = "contact" | "lead"`, `CrmLifecycle = "lead" | "customer" | "other"`, `CrmScalar = string | number | boolean | null`; `leads.crmRecordId` (nullable uuid).

- [ ] **Step 1: Write the failing checks**

`scripts/smoke-purge.ts`, in `seed()` directly after the `connectorConnections` insert:

```ts
  // A synced CRM person: connection-derived, so it goes with `connections`.
  const [crmRecord] = await db
    .insert(schema.crmRecords)
    .values({
      userId: USER,
      connectorId: "hubspot",
      remoteType: "contact",
      remoteId: "hs-1",
      lifecycle: "customer",
      displayName: "Katherine Johnson",
      emailNormalized: "katherine@nasa.test",
    })
    .returning();
```

and change the later `leads` insert to carry `crmRecordId: crmRecord.id,` (so the purge proves a lead pointing at a CRM record is deleted without an FK error). The table list is derived from the schema, so no other edit is needed there.

`scripts/smoke-data-export.ts`, in `seed()` after the `gmailConnections` insert:

```ts
  await db.insert(schema.crmRecords).values({ userId: USER, connectorId: "hubspot", remoteType: "contact", remoteId: "hs-export", lifecycle: "customer", displayName: "Katherine Johnson" });
```

`scripts/smoke-contact-merge.ts`:
- in `reset()`, directly above the `DELETE FROM leads` line add `await db.execute(sql\`DELETE FROM crm_records WHERE user_id = ${user}\`);` (with a short comment: `crm_records.contact_id` is ON DELETE SET NULL too)
- directly after the `leadId` insert add:

```ts
    // A work contact's CRM record pointing at the loser: the same SET NULL, the same silence.
    const crmRecordId = rowsOf<{ id: string }>(
      await db.execute(
        sql`INSERT INTO crm_records (user_id, connector_id, remote_type, remote_id, contact_id, lifecycle, display_name)
            VALUES (${USER}, 'hubspot', 'contact', 'hs-merge', ${loser}::uuid, 'customer', 'Record for the loser')
            RETURNING id`
      )
    )[0]!.id;
```

- after the check `"the converted lead followed the contact it became, onto the winner"` add:

```ts
    check(
      "the CRM record followed its contact onto the winner",
      (await scalar<string | null>(
        sql`SELECT contact_id::text AS v FROM crm_records WHERE id = ${crmRecordId}::uuid`
      )) === winner
    );
```

- after `"the lead is repointed back to the loser on undo"` add the same check with `=== loser` and the label `"the CRM record is repointed back to the loser on undo"`. (`crmRecordId` must be in scope there: if the undo half is a separate block, hoist the declaration as the file already does for `leadId`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx scripts/run-smoke.ts --only smoke-purge smoke-data-export smoke-contact-merge`
Expected: FAIL — `schema.crmRecords` does not exist (tsx type-strips, so this surfaces as `Cannot read properties of undefined` or `relation "crm_records" does not exist`).

- [ ] **Step 3: Implement the schema**

`src/db/schema.ts`, directly above the `leads` doc comment:

```ts
export type CrmRemoteType = "contact" | "lead";
/** What the CRM says the person is to the business. Anything else a provider sends is `other`. */
export type CrmLifecycle = "lead" | "customer" | "other";
export type CrmScalar = string | number | boolean | null;

/**
 * One person as a connected CRM describes them: the sync ledger, and the map between an Orbit
 * contact and its CRM record in both directions. Connection-derived — deleted on disconnect,
 * purged with `connections`, rebuilt by the next sync — unlike `leads`, which is the user's own.
 *
 * A HubSpot contact moving lead → customer keeps its row and flips `lifecycle`; the unique
 * `(user_id, connector_id, remote_type, remote_id)` is what the sync upserts on. `contact_id` is
 * set once a customer becomes (or matches) an Orbit contact: "work contacts" are exactly the
 * contacts with a row here. `link_blocked_at` marks a customer the plan's contact cap refused.
 */
export const crmRecords = pgTable(
  "crm_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    connectorId: text("connector_id").notNull(),
    remoteType: text("remote_type").$type<CrmRemoteType>().notNull(),
    remoteId: text("remote_id").notNull(),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    lifecycle: text("lifecycle").$type<CrmLifecycle>().notNull(),
    /** The provider's raw stage value, never interpreted beyond `lifecycle`. */
    stage: text("stage"),
    displayName: text("display_name").notNull(),
    email: text("email"),
    /** `identityKeysFor`'s email value. */
    emailNormalized: text("email_normalized"),
    phone: text("phone"),
    linkedinUrl: text("linkedin_url"),
    companyName: text("company_name"),
    companyNormalized: text("company_normalized"),
    companyDomain: text("company_domain"),
    title: text("title"),
    remoteOwnerRef: text("remote_owner_ref"),
    remoteUrl: text("remote_url"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    remoteCreatedAt: timestamp("remote_created_at", { withTimezone: true }),
    remoteUpdatedAt: timestamp("remote_updated_at", { withTimezone: true }),
    /** Whitelisted scalar properties only (see the provider's mapping module). */
    properties: jsonb("properties").$type<Record<string, CrmScalar>>().default({}).notNull(),
    linkBlockedAt: timestamp("link_blocked_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("crm_records_remote_uidx").on(t.userId, t.connectorId, t.remoteType, t.remoteId),
    index("crm_records_user_contact_idx").on(t.userId, t.contactId),
    /** Without this, deleting a contact scans the table (see `leads_contact_idx`). */
    index("crm_records_contact_idx").on(t.contactId),
    index("crm_records_user_lifecycle_idx").on(t.userId, t.connectorId, t.lifecycle),
    index("crm_records_link_blocked_idx")
      .on(t.userId, t.connectorId)
      .where(sql`link_blocked_at is not null`),
  ]
);

export type CrmRecord = typeof crmRecords.$inferSelect;
```

In the `leads` table, after `contactId`:

```ts
    /** The CRM record a `source = 'crm'` lead came from; kept when a manual lead merges into one. */
    crmRecordId: uuid("crm_record_id").references(() => crmRecords.id, { onDelete: "set null" }),
```

and in its index list, after `leads_user_apollo_uidx`:

```ts
    uniqueIndex("leads_user_crm_record_uidx")
      .on(t.userId, t.crmRecordId)
      .where(sql`crm_record_id is not null`),
```

Update the `leads` doc comment's last sentence to: "`source = 'crm'` rows and `crm_record_id` arrive with the CRM sync (P4)."

- [ ] **Step 4: Implement the DDL**

`src/db/index.ts`, template, directly above `CREATE TABLE IF NOT EXISTS leads (`:

```sql
CREATE TABLE IF NOT EXISTS crm_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  connector_id text NOT NULL,
  remote_type text NOT NULL,
  remote_id text NOT NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  lifecycle text NOT NULL,
  stage text,
  display_name text NOT NULL,
  email text,
  email_normalized text,
  phone text,
  linkedin_url text,
  company_name text,
  company_normalized text,
  company_domain text,
  title text,
  remote_owner_ref text,
  remote_url text,
  last_activity_at timestamptz,
  remote_created_at timestamptz,
  remote_updated_at timestamptz,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  link_blocked_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_records_remote_uidx ON crm_records(user_id, connector_id, remote_type, remote_id);
CREATE INDEX IF NOT EXISTS crm_records_user_contact_idx ON crm_records(user_id, contact_id);
CREATE INDEX IF NOT EXISTS crm_records_contact_idx ON crm_records(contact_id);
CREATE INDEX IF NOT EXISTS crm_records_user_lifecycle_idx ON crm_records(user_id, connector_id, lifecycle);
CREATE INDEX IF NOT EXISTS crm_records_link_blocked_idx ON crm_records(user_id, connector_id) WHERE link_blocked_at IS NOT NULL;
```

In the template's `CREATE TABLE IF NOT EXISTS leads (`, after the `contact_id …` line add `  crm_record_id uuid REFERENCES crm_records(id) ON DELETE SET NULL,`. Do NOT add the `leads_user_crm_record_uidx` index to the template (see Global Constraints: on an existing database the template runs before the column exists).

At the END of the `alters` array add:

```ts
  // v94: a CRM lead's record (P4). The partial unique lives here only, after its column: the
  // template runs first, and on a database that already has `leads` the column is not there yet.
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS crm_record_id uuid REFERENCES crm_records(id) ON DELETE SET NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS leads_user_crm_record_uidx ON leads(user_id, crm_record_id) WHERE crm_record_id IS NOT NULL`,
```

In `migratePglite`, after the last `ensureColumn` (the `connector_outbox` ones) add:

```ts
  await ensureColumn(client, "leads", "crm_record_id", "uuid REFERENCES crm_records(id) ON DELETE SET NULL");
```

`scripts/setup-db.ts` `EXPECTED_TABLES`: after `"leads",` add `"connector_connections", "external_links", "connector_outbox", "crm_records",` (the spine's three were never listed).

Run `npx tsx scripts/smoke-schema-ddl.ts --update`.

- [ ] **Step 5: Purge, export, merge**

`src/lib/user-data.ts`: import `crmRecords` alongside the other schema imports; in `connections.exports` add `own(crmRecords),`; in `connections.counts` add `crmRecords,`; in `connections.run`, directly after the `connectorConnections` delete, add:

```ts
      // What a CRM connection synced. The contacts it created are the user's and stay with
      // `contacts`; this is only the ledger that mapped them, and it must not outlive the grant.
      await db.delete(crmRecords).where(eq(crmRecords.userId, userId));
```

`src/lib/data-categories.ts`, the `connections` description becomes:

```ts
      "Gmail, Outlook, calendar subscriptions, event-provider tokens and connected CRMs, with the record of what each CRM synced. Orbit stops syncing and you would reconnect from scratch.",
```

`src/lib/contact-merge.ts`, append to `REPOINTED_TABLES`:

```ts
  // crm_records.contact_id is ON DELETE SET NULL as well: a merge would otherwise silently turn
  // a work contact back into an unlinked record. Its unique index does not include contact_id.
  { table: "crm_records", column: "contact_id", scoped: true },
```

- [ ] **Step 6: Run to verify they pass**

Run: `npx tsc --noEmit -p . > /tmp/p4-t2-tsc.txt 2>&1; echo tsc=$?` then `npx tsx scripts/run-smoke.ts --only smoke-schema-ddl smoke-schema-upgrade smoke-purge smoke-purge-selective smoke-purge-resume smoke-data-export smoke-contact-merge smoke-leads smoke-connector-connections`
Expected: `tsc=0`; `9/9 passed`. (If `smoke-purge-resume` names the connections step's statements, update its expected step string exactly as P2 did for `leads`.)

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/index.ts scripts/setup-db.ts scripts/schema-ddl.lock.json src/lib/user-data.ts src/lib/data-categories.ts src/lib/contact-merge.ts scripts/smoke-purge.ts scripts/smoke-data-export.ts scripts/smoke-contact-merge.ts
git commit -m "Add crm_records and leads.crm_record_id, purged with connections and carried through merges

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: The `crm` entitlement and `requireCrmUser`

The public pricing surfaces (`src/components/pricing/plan-comparison.tsx`, `PLAN_COPY` in `src/lib/plan-copy.ts`, `src/components/pricing/pricing-faq.tsx`) are deliberately NOT touched (Ruling 11): their rows land at P7 with the release.

**Files:**
- Modify: `src/lib/entitlements.ts` (`Entitlements`, `FEATURE_KEYS`, `entitlementsForPlan`, `FEATURE_DENIAL`, `FEATURE_FLAG`)
- Modify: `src/lib/gate-events.ts` (`GateFeature`)
- Modify: `src/lib/money-metrics.ts` (`KNOWN_GATES`)
- Modify: `src/app/(clerk)/(admin)/admin/billing/demand/page.tsx` (`GATE_LABELS`)
- Modify: `src/app/(clerk)/(admin)/admin/users/[userId]/page.tsx` (`entitlementFlags`)
- Modify: `src/lib/plan-guards.ts` (`requireCrmUser`, and the `requireLeadsUser` comment)
- Modify: `src/lib/connectors/registry.ts` (HubSpot `entitlement: "crm"`)
- Test: `scripts/smoke-entitlements.ts`, `scripts/smoke-connector-registry.ts`

**Interfaces:**
- Produces: `FeatureKey` includes `"crm"`; `Entitlements.canUseCrm: boolean`; `requireCrmUser(): Promise<string>` from `@/lib/plan-guards` (surface first, then plan — so a gate hit is only recorded for someone who can see Leads).

- [ ] **Step 1: Write the failing checks**

`scripts/smoke-entitlements.ts`:
- after `check("hosted enrichment gated", ent.canUseHostedEnrichment === false);` in the free-tier block add `check("crm gated", ent.canUseCrm === false);`
- after `check("extension unlocked", ent.canUseExtension === true);` in the comped-Lifetime block add `check("crm unlocked on lifetime", ent.canUseCrm === true);`
- after `check("hosted enrichment unlocked", ent.canUseHostedEnrichment === true);` in the Pro block add `check("crm unlocked on pro", ent.canUseCrm === true);`
- in the showcase chain, change `ent.canUseApi,` to `ent.canUseApi &&\n        ent.canUseCrm,`

`scripts/smoke-connector-registry.ts`, append before the summary:

```ts
check(
  "HubSpot is gated on the crm entitlement, not sync",
  connectorById("hubspot")?.entitlement === "crm",
  String(connectorById("hubspot")?.entitlement)
);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx scripts/run-smoke.ts --only smoke-entitlements smoke-connector-registry`
Expected: FAIL on "crm unlocked on lifetime" (undefined !== true) and on the HubSpot entitlement check.

- [ ] **Step 3: Implement**

`src/lib/entitlements.ts`:
- in `Entitlements`, directly after `canUseApi: boolean;`:

```ts
  /**
   * Connecting Salesforce or HubSpot to Leads. Its own key, like `canUseApi`, so the denial
   * copy names the right thing and `gate_events` tells CRM demand apart from mailbox sync.
   * Joining a team and looking up warm paths are free and never consult it.
   */
  canUseCrm: boolean;
```

- `FEATURE_KEYS`: add `"crm",` after `"api",`
- `entitlementsForPlan`: add `canUseCrm: paid,` after `canUseApi: paid,`
- `FEATURE_DENIAL`: add `crm: "Salesforce and HubSpot sync are available on Orbit Pro and Orbit Lifetime.",` after `api`
- `FEATURE_FLAG`: add `crm: "canUseCrm",` after `api`

`src/lib/gate-events.ts` `GateFeature`: add `| "crm"` after `| "api"`.

`src/lib/money-metrics.ts` `KNOWN_GATES`: add `"api",` and `"crm",` after `"extension",` (`api` was missed when it was added; same row, same fix).

`src/app/(clerk)/(admin)/admin/billing/demand/page.tsx` `GATE_LABELS`: add `api: "API and webhooks",` and `crm: "CRM (Salesforce / HubSpot)",`.

`src/app/(clerk)/(admin)/admin/users/[userId]/page.tsx` `entitlementFlags`: add `["api", ent.canUseApi],` and `["crm", ent.canUseCrm],` after the `extension` row.

`src/lib/plan-guards.ts`: change the `requireLeadsUser` doc comment's parenthesis to "(the CRM connection is the paid part: `requireCrmUser`)" and append:

```ts
/**
 * `requireLeadsUser` plus the paid half of Leads: connecting, syncing and disconnecting a CRM.
 * The surface is checked first, so a paywall hit is only ever recorded for someone who can
 * see the page.
 */
export async function requireCrmUser() {
  const userId = await requireLeadsUser();
  await requireEntitlement(userId, "crm");
  return userId;
}
```

`src/lib/connectors/registry.ts`, the `hubspot` entry: `entitlement: "crm",`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsc --noEmit -p . > /tmp/p4-t3-tsc.txt 2>&1; echo tsc=$?` then `npx tsx scripts/run-smoke.ts --only smoke-entitlements smoke-connector-registry smoke-connector-sync-pass smoke-admin-analytics`
Expected: `tsc=0`; `4/4 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/entitlements.ts src/lib/gate-events.ts src/lib/money-metrics.ts "src/app/(clerk)/(admin)/admin/billing/demand/page.tsx" "src/app/(clerk)/(admin)/admin/users/[userId]/page.tsx" src/lib/plan-guards.ts src/lib/connectors/registry.ts scripts/smoke-entitlements.ts scripts/smoke-connector-registry.ts
git commit -m "Add the crm entitlement: its own key, denial copy and demand row, and requireCrmUser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: `ingestPeople` reports which contact each input became

**Files:**
- Modify: `src/lib/ingest/people.ts` (`PeopleIngestStats`, the loop, the create block)
- Test: `scripts/smoke-ingest-people.ts`

**Interfaces:**
- Consumes: `IngestOptions.reportResolutions` (already on the type in `src/lib/ingest/events.ts`; `openIngestContext` copies every option into `ctx.options`).
- Produces: `PeopleIngestStats.resolutions?: Array<{ index: number; contactId: string }>` — sorted by `index`, one entry per input that ended on a contact (matched, created, or folded into another input's create). No entry for an input with no name, an input the cap refused, or any input when `createsContacts` is false and nothing matched.

- [ ] **Step 1: Write the failing check**

`scripts/smoke-ingest-people.ts`, directly before `await finalizeIngest(ctx);`:

```ts
  console.log("\neighth pass: resolutions, by input index");
  // A CRM sync links each of ITS records to a contact, and a batch can name one person
  // twice — so the answer has to be per input index, not per created contact.
  const reporting = await openIngestContext(USER, {
    source: "smoke",
    createsContacts: true,
    reportResolutions: true,
  });
  reporting.headroom = 1;
  const eighth = await ingestPeople(reporting, [
    { fullName: "Ada Lovelace", email: "ada@example.com" }, // 0: matches the existing Ada
    { fullName: "Hedy Lamarr", email: "hedy@example.com" }, // 1: created (uses the headroom)
    { fullName: "Hedy Lamarr", email: "hedy@example.com", title: "Inventor" }, // 2: folds into 1
    { fullName: "   " }, // 3: no name, skipped
    { fullName: "Over The Cap", email: "cap@example.com" }, // 4: refused by the cap
  ]);
  const [adaNow] = await db.select().from(contacts).where(eq(contacts.email, "ada@example.com"));
  const [hedy] = await db.select().from(contacts).where(eq(contacts.email, "hedy@example.com"));
  const byIndex = new Map((eighth.resolutions ?? []).map((r) => [r.index, r.contactId]));
  check("resolutions are reported when asked for", Array.isArray(eighth.resolutions), JSON.stringify(eighth));
  check("a match resolves to the existing contact", byIndex.get(0) === adaNow?.id, JSON.stringify([...byIndex]));
  check("a create resolves to the new contact", byIndex.get(1) === hedy?.id);
  check("an in-batch repeat resolves to the same new contact", byIndex.get(2) === hedy?.id);
  check("a nameless input has no resolution", !byIndex.has(3));
  check("a capped input has no resolution", !byIndex.has(4));
  check(
    "they come back in input order",
    (eighth.resolutions ?? []).map((r) => r.index).join(",") === "0,1,2",
    JSON.stringify(eighth.resolutions)
  );
  const silent = await ingestPeople(ctx, [{ fullName: "Ada Lovelace", email: "ada@example.com" }]);
  check("and are not reported unless asked for", silent.resolutions === undefined);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/run-smoke.ts --only smoke-ingest-people`
Expected: FAIL on "resolutions are reported when asked for".

- [ ] **Step 3: Implement**

`src/lib/ingest/people.ts`:

1. Extend the stats type:

```ts
export type PeopleIngestStats = {
  seen: number;
  created: number;
  matched: number;
  /** Would have been created but for the plan's contact cap. */
  blockedByPlan: number;
  /**
   * Which contact each INPUT resolved to, by its index in the array passed in — only when
   * `ctx.options.reportResolutions` is set. By index rather than by object: a batch naming one
   * person twice folds both rows into one contact, and a caller linking its own records (a CRM
   * sync) needs an answer for each. No entry for a nameless input or one the cap refused.
   */
  resolutions?: Array<{ index: number; contactId: string }>;
};
```

2. In `ingestPeople`, next to `toCreate` declare:

```ts
  const resolved: Array<{ index: number; contactId: string }> = [];
  /** `toCreate` position → the input indices that will become that contact. */
  const inputsByCreate = new Map<number, number[]>();
```

3. Change the loop header to `for (const [index, person] of people.entries()) {` and:
   - in the match branch, right after `ctx.touchedContactIds.add(best.contact.id);` add `resolved.push({ index, contactId: best.contact.id });`
   - in the fold-into-pending branch, before its `continue`, add `inputsByCreate.get(pending)?.push(index);`
   - in the new-create branch, directly before `toCreate.push(input);` add `inputsByCreate.set(toCreate.length, [index]);`

4. In the create block, inside the existing `for (const contact of created)` loop, change it to iterate with the position — `for (const [i, contact] of created.entries()) {` — and add as its first line:

```ts
      // `created[i]` is `toCreate[i]`: one multi-row INSERT … RETURNING, the same pairing
      // `ingestEvents` relies on. The cap only ever trims the tail.
      for (const inputIndex of inputsByCreate.get(i) ?? []) resolved.push({ index: inputIndex, contactId: contact.id });
```

5. Before `return stats;`:

```ts
  if (ctx.options.reportResolutions) {
    stats.resolutions = resolved.sort((a, b) => a.index - b.index);
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc --noEmit -p . > /tmp/p4-t4-tsc.txt 2>&1; echo tsc=$?` then `npx tsx scripts/run-smoke.ts --only smoke-ingest-people smoke-ingest-events`
Expected: `tsc=0`; `2/2 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ingest/people.ts scripts/smoke-ingest-people.ts
git commit -m "Report which contact each ingested person became, by input index

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: `openConnectorAuth` — a valid token for every provider call

**Files:**
- Create: `src/lib/connectors/auth-errors.ts` (no imports at all — the HubSpot client imports it, and its smoke is pure-tier)
- Create: `src/lib/connectors/token.ts`
- Test: `scripts/smoke-connector-token.ts` (new, pglite) + `MANIFEST` entry `"smoke-connector-token": "pglite",`

**Interfaces:**
- Consumes: `ClaimedConnectorConnection`, `updateConnectorTokens`, `markConnectorNeedsReauth` (Task 1 / spine); `refreshAccessToken`, `OAuthTokenError`, `OAuthTokens` from `@/lib/connectors/oauth`.
- Produces (the two error classes from `@/lib/connectors/auth-errors`, re-exported by `@/lib/connectors/token`; everything else from `@/lib/connectors/token`):
  - `class ConnectorAuthError extends Error` — a provider client throws this when the ACCESS TOKEN was refused (HTTP 401). Nothing else.
  - `class ConnectorNeedsReauthError extends Error` — thrown once the connection has been marked `needs_reauth`; the row is already resolved, so a sync that catches it returns normally.
  - `TOKEN_REFRESH_SKEW_MS = 60_000`
  - `type ConnectorAuth = { call<T>(fn: (accessToken: string) => Promise<T>): Promise<T> }`
  - `type ConnectorAuthDeps = { now?: () => Date; refresh?: (connectorId: string, refreshToken: string) => Promise<OAuthTokens>; persist?: typeof updateConnectorTokens; markNeedsReauth?: typeof markConnectorNeedsReauth }`
  - `openConnectorAuth(conn: ClaimedConnectorConnection, deps?: ConnectorAuthDeps): ConnectorAuth` — synchronous; the first `call` does any refresh.

Rules the module enforces (and the smoke pins, one check each):
1. Before every call, a token within `TOKEN_REFRESH_SKEW_MS` of `tokenExpiresAt` (or a null/unreadable token) is refreshed first — proactive.
2. A call that throws `ConnectorAuthError` gets ONE refresh-and-retry per `ConnectorAuth` (per sync run). A second `ConnectorAuthError` in the same run → needs reauth.
3. A refresh rejected with `OAuthTokenError.needsReauth === true`, or no refresh token at all → `markNeedsReauth(conn.id, message)` then throw `ConnectorNeedsReauthError`.
4. A retryable refresh failure (`OAuthTokenError.needsReauth === false`, or any other error) propagates unchanged, and the row stays `active`.
5. A successful refresh is persisted (`persist`) and updates the in-memory `conn` (`accessToken`, `refreshToken` when rotated, `tokenExpiresAt`), so a later refresh in the same run uses the rotated refresh token.

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-connector-token.ts`:

```ts
/**
 * `openConnectorAuth`: every provider call gets a token that is valid when it is sent.
 *
 * The rules are the ones the sync scheduler's error handling depends on — a refresh that the
 * provider refuses must end in `needs_reauth` (the person has to reconnect), while a provider
 * having a bad minute must NOT (the scheduler backs off and tries again).
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections } from "../src/db/schema";
import {
  claimConnectorConnectionForUser,
  upsertConnectorConnection,
} from "../src/lib/connectors/connections";
import { OAuthTokenError, type OAuthTokens } from "../src/lib/connectors/oauth";
import {
  ConnectorAuthError,
  ConnectorNeedsReauthError,
  openConnectorAuth,
} from "../src/lib/connectors/token";
import { decryptOrNull } from "../src/lib/crypto";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-connector-token";

async function fresh(opts: { expiresInMs: number | null; refreshToken?: string | null }) {
  const db = await getDb();
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
  await upsertConnectorConnection({
    userId: USER,
    connectorId: "hubspot",
    authKind: "oauth2",
    accessToken: "access-old",
    refreshToken: opts.refreshToken === undefined ? "refresh-old" : opts.refreshToken,
    tokenExpiresAt: opts.expiresInMs === null ? null : new Date(Date.now() + opts.expiresInMs),
    nextSyncAt: null,
  });
  const conn = await claimConnectorConnectionForUser(USER, "hubspot");
  if (!conn) throw new Error("setup: could not claim");
  return conn;
}

async function row() {
  const db = await getDb();
  const [r] = await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER));
  return r;
}

function refresher(result: OAuthTokens | Error) {
  const calls: string[] = [];
  const refresh = async (_id: string, refreshToken: string) => {
    calls.push(refreshToken);
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, refresh };
}

const NEW_TOKENS: OAuthTokens = {
  accessToken: "access-new",
  refreshToken: null,
  expiresAt: new Date(Date.now() + 1_800_000),
  scopes: null,
};

run(async () => {
  console.log("a token with time left is used as stored");
  {
    const conn = await fresh({ expiresInMs: 3_600_000 });
    const r = refresher(NEW_TOKENS);
    const seen: string[] = [];
    await openConnectorAuth(conn, { refresh: r.refresh }).call(async (t) => seen.push(t));
    check("the stored token is sent", seen[0] === "access-old", seen.join(","));
    check("and nothing is refreshed", r.calls.length === 0);
  }

  console.log("\na token about to lapse is refreshed first (proactive)");
  {
    const conn = await fresh({ expiresInMs: 30_000 });
    const r = refresher(NEW_TOKENS);
    const seen: string[] = [];
    await openConnectorAuth(conn, { refresh: r.refresh }).call(async (t) => seen.push(t));
    check("the refresh ran once, with the stored refresh token", r.calls.join(",") === "refresh-old");
    check("the call got the new token", seen[0] === "access-new");
    const stored = await row();
    check("the new token is stored", decryptOrNull(stored?.accessTokenEncrypted ?? null) === "access-new");
    check("the refresh token is kept when none comes back", decryptOrNull(stored?.refreshTokenEncrypted ?? null) === "refresh-old");
  }

  console.log("\na 401 refreshes once and retries the call (reactive)");
  {
    const conn = await fresh({ expiresInMs: 3_600_000 });
    const r = refresher({ ...NEW_TOKENS, refreshToken: "refresh-rotated" });
    const seen: string[] = [];
    const auth = openConnectorAuth(conn, { refresh: r.refresh });
    const out = await auth.call(async (t) => {
      seen.push(t);
      if (t === "access-old") throw new ConnectorAuthError("401");
      return "ok";
    });
    check("the retry succeeded", out === "ok");
    check("it was sent with the old token, then the new", seen.join(",") === "access-old,access-new");
    check("a rotated refresh token is kept in memory", conn.refreshToken === "refresh-rotated");
    check("and stored", decryptOrNull((await row())?.refreshTokenEncrypted ?? null) === "refresh-rotated");

    console.log("\n…but only once per run");
    let second: unknown = null;
    try {
      await auth.call(async () => {
        throw new ConnectorAuthError("401 again");
      });
    } catch (err) {
      second = err;
    }
    check("a second 401 in the same run means reconnect", second instanceof ConnectorNeedsReauthError, String(second));
    check("no second refresh was attempted", r.calls.length === 1, String(r.calls.length));
    check("the row is marked needs_reauth", (await row())?.status === "needs_reauth");
  }

  console.log("\na refused refresh means reconnect");
  {
    const conn = await fresh({ expiresInMs: 30_000 });
    const r = refresher(new OAuthTokenError("BAD_REFRESH_TOKEN", true));
    let caught: unknown = null;
    try {
      await openConnectorAuth(conn, { refresh: r.refresh }).call(async () => "never");
    } catch (err) {
      caught = err;
    }
    check("it throws ConnectorNeedsReauthError", caught instanceof ConnectorNeedsReauthError, String(caught));
    const stored = await row();
    check("the row needs reauth", stored?.status === "needs_reauth");
    check("and is disarmed", stored?.nextSyncAt === null);
  }

  console.log("\na provider having a bad minute does NOT mean reconnect");
  {
    const conn = await fresh({ expiresInMs: 30_000 });
    const r = refresher(new OAuthTokenError("Token endpoint returned 503", false));
    let caught: unknown = null;
    try {
      await openConnectorAuth(conn, { refresh: r.refresh }).call(async () => "never");
    } catch (err) {
      caught = err;
    }
    check("the provider's error propagates as-is", caught instanceof OAuthTokenError && !(caught instanceof ConnectorNeedsReauthError));
    check("the row stays active", (await row())?.status === "active");
  }

  console.log("\nno refresh token and an expired access token means reconnect");
  {
    const conn = await fresh({ expiresInMs: -1000, refreshToken: null });
    const r = refresher(NEW_TOKENS);
    let caught: unknown = null;
    try {
      await openConnectorAuth(conn, { refresh: r.refresh }).call(async () => "never");
    } catch (err) {
      caught = err;
    }
    check("it throws ConnectorNeedsReauthError", caught instanceof ConnectorNeedsReauthError);
    check("without trying to refresh", r.calls.length === 0);
  }

  const db = await getDb();
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll connector token checks passed.");
});
```

Add `"smoke-connector-token": "pglite",` to `MANIFEST` in `scripts/run-smoke.ts` next to `"smoke-connector-claim"`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/run-smoke.ts --only smoke-connector-token`
Expected: FAIL — `Cannot find module '../src/lib/connectors/token'`.

- [ ] **Step 3: Implement**

Create `src/lib/connectors/auth-errors.ts`:

```ts
/**
 * The two errors a connector's provider client and `openConnectorAuth` speak. Import-free on
 * purpose: a provider client (`src/lib/crm/hubspot/api.ts`) throws `ConnectorAuthError`, and
 * that client's smoke runs without a database — `token.ts` reaches `@/db`.
 */

/** A provider client throws this when the ACCESS TOKEN was refused (HTTP 401) — and only then. */
export class ConnectorAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorAuthError";
  }
}

/**
 * The connection has been marked `needs_reauth` and disarmed. The row is already resolved, so
 * a sync that catches this returns normally — the scheduler's success backstop is guarded on
 * the row still being `syncing` and leaves it alone.
 */
export class ConnectorNeedsReauthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorNeedsReauthError";
  }
}
```

Create `src/lib/connectors/token.ts`:

```ts
/**
 * A valid access token for every provider call a sync makes.
 *
 * Mirrors `getValidAccessToken` in `src/lib/gmail.ts` for the generic connector table:
 * refresh a token that is about to lapse BEFORE the call (proactive), refresh once more if the
 * provider refuses it anyway (reactive — clocks drift, tokens get revoked), and past that, or
 * when the provider refuses the refresh itself, mark the connection `needs_reauth` so the
 * person is told to reconnect instead of the scheduler retrying a dead grant for days.
 *
 * A retryable failure (the token endpoint timing out, a 5xx) is NOT a reason to reconnect: it
 * propagates unchanged so the scheduler backs off. That split is the whole point of
 * `OAuthTokenError.needsReauth`.
 */
import {
  markConnectorNeedsReauth,
  updateConnectorTokens,
  type ClaimedConnectorConnection,
} from "@/lib/connectors/connections";
import { OAuthTokenError, refreshAccessToken, type OAuthTokens } from "@/lib/connectors/oauth";
import { ConnectorAuthError, ConnectorNeedsReauthError } from "@/lib/connectors/auth-errors";

export { ConnectorAuthError, ConnectorNeedsReauthError };

/** Refresh this long before the stored expiry, so a token never lapses mid-request. */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

export type ConnectorAuth = {
  /** Run one provider call with a valid token. */
  call<T>(fn: (accessToken: string) => Promise<T>): Promise<T>;
};

export type ConnectorAuthDeps = {
  now?: () => Date;
  refresh?: (connectorId: string, refreshToken: string) => Promise<OAuthTokens>;
  persist?: typeof updateConnectorTokens;
  markNeedsReauth?: typeof markConnectorNeedsReauth;
};

const RECONNECT = "Reconnect to keep syncing";

export function openConnectorAuth(
  conn: ClaimedConnectorConnection,
  deps: ConnectorAuthDeps = {}
): ConnectorAuth {
  const now = deps.now ?? (() => new Date());
  const refresh = deps.refresh ?? ((id: string, token: string) => refreshAccessToken(id, token));
  const persist = deps.persist ?? updateConnectorTokens;
  const markNeedsReauth = deps.markNeedsReauth ?? markConnectorNeedsReauth;
  let reactiveUsed = false;

  async function giveUp(reason: string): Promise<never> {
    await markNeedsReauth(conn.id, `${reason} — ${RECONNECT}`);
    throw new ConnectorNeedsReauthError(reason);
  }

  async function renew(reason: string): Promise<string> {
    if (!conn.refreshToken) return giveUp(reason);
    let tokens: OAuthTokens;
    try {
      tokens = await refresh(conn.connectorId, conn.refreshToken);
    } catch (err) {
      if (err instanceof OAuthTokenError && err.needsReauth) return giveUp(err.message);
      throw err;
    }
    await persist(conn.id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });
    conn.accessToken = tokens.accessToken;
    if (tokens.refreshToken) conn.refreshToken = tokens.refreshToken;
    conn.tokenExpiresAt = tokens.expiresAt;
    return tokens.accessToken;
  }

  async function current(): Promise<string> {
    if (!conn.accessToken) return renew("The stored access token is unreadable");
    const expires = conn.tokenExpiresAt?.getTime();
    if (expires !== undefined && expires - TOKEN_REFRESH_SKEW_MS <= now().getTime()) {
      return renew("The access token expired");
    }
    return conn.accessToken;
  }

  return {
    async call<T>(fn: (accessToken: string) => Promise<T>): Promise<T> {
      const token = await current();
      try {
        return await fn(token);
      } catch (err) {
        if (!(err instanceof ConnectorAuthError)) throw err;
        if (reactiveUsed) return giveUp(err.message);
        reactiveUsed = true;
        const renewed = await renew(err.message);
        try {
          return await fn(renewed);
        } catch (again) {
          if (again instanceof ConnectorAuthError) return giveUp(again.message);
          throw again;
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc --noEmit -p . > /tmp/p4-t5-tsc.txt 2>&1; echo tsc=$?` then `npx tsx scripts/run-smoke.ts --check` then `npx tsx scripts/run-smoke.ts --only smoke-connector-token smoke-connector-oauth smoke-oauth-refresh-rejection`
Expected: `tsc=0`; check passes; `3/3 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/connectors/auth-errors.ts src/lib/connectors/token.ts scripts/smoke-connector-token.ts scripts/run-smoke.ts
git commit -m "Give every connector call a valid token: refresh ahead, retry once, then ask to reconnect

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: HubSpot, pure — the person shape, property mapping, the search body, and the paging window

Verified against HubSpot's developer docs on 2026-09-23 (the raw pages the research read are listed in the PR body):

- Build on the **dated** paths. OAuth v1 (`/oauth/v1/token`, `/oauth/v1/access-tokens/{token}`) shuts down **2027-02-16**; CRM v1–v3 go unsupported **Sept 2027**. Version `2026-09` is current. API host `https://api.hubapi.com`.
- Search: `POST /crm/objects/2026-09/contacts/search`, body `{ filterGroups: [{ filters: [{ propertyName, operator, value }] }], sorts: [{ propertyName, direction }], properties, limit, after }`. One sort rule only. Max `limit` 200 (we use 100). A single query can never page past **10,000** results (a 400). 5 requests/second per account. Response `{ total, results: [{ id, properties, createdAt, updatedAt, archived, url? }], paging?: { next?: { after } } }`; no `paging.next` = last page. Dates in `properties` are ISO strings; filter values may be epoch-ms strings.
- Contacts' last-modified property is `lastmodifieddate` (not `hs_lastmodifieddate`, which is companies'). Confirmed names: `firstname`, `lastname`, `email`, `phone`, `mobilephone`, `company`, `jobtitle`, `hs_linkedin_url`, `lifecyclestage`, `hs_lead_status`, `hubspot_owner_id`, `createdate`, `lastmodifieddate`, `notes_last_updated` ("Last Activity Date").
- `associatedcompanyid` is read-only and absent from the 2026-09 definition: company comes from the contact's own `company` text property. We read no company objects, so no `crm.objects.companies.read` scope. `company_domain` stays null for HubSpot.
- `lifecyclestage` standard values: `subscriber`, `lead`, `marketingqualifiedlead`, `salesqualifiedlead`, `opportunity`, `customer`, `evangelist` (and `other`); portals can add custom stages, so anything unknown maps to `other`.
- Record URL: `https://app.hubspot.com/contacts/{portalId}/record/0-1/{contactId}`; a 2026-09 result may carry its own `url` — prefer it when it is an `https://…hubspot.com/` URL (EU portals live on `app-eu1`).
- Scopes (the app's `requiredScopes`, sent as the `scope` param): `crm.objects.contacts.read crm.objects.owners.read`. `oauth` is added to every app by default and is not sent.

**Files:**
- Create: `src/lib/crm/types.ts` (pure)
- Create: `src/lib/crm/hubspot/mapping.ts` (pure)
- Test: `scripts/smoke-hubspot-mapping.ts` (new, pure) + `MANIFEST` entry `"smoke-hubspot-mapping": "pure",`

**Interfaces:**
- Consumes: `CrmLifecycle`, `CrmRemoteType`, `CrmScalar`, `ConnectorSyncCursor` (types, `@/db/schema`).
- Produces:
  - `@/lib/crm/types`: `type CrmPerson = { remoteType: CrmRemoteType; remoteId: string; lifecycle: CrmLifecycle; stage: string | null; displayName: string; email: string | null; phone: string | null; linkedinUrl: string | null; companyName: string | null; companyDomain: string | null; title: string | null; remoteOwnerRef: string | null; remoteUrl: string | null; lastActivityAt: Date | null; remoteCreatedAt: Date | null; remoteUpdatedAt: Date | null; properties: Record<string, CrmScalar> }`
  - `@/lib/crm/hubspot/mapping`: `HUBSPOT_API_BASE`, `HUBSPOT_API_VERSION`, `HUBSPOT_SCOPES`, `HUBSPOT_SEARCH_PAGE` (100), `HUBSPOT_SEARCH_CEILING` (10_000), `HUBSPOT_FULL_RESYNC_MS` (7 days), `HUBSPOT_CONTACT_PROPERTIES`, `type HubspotContactResult`, `lifecycleForStage(stage)`, `hubspotRecordUrl(portalId, contactId)`, `parseHubspotDate(value)`, `mapHubspotContact(raw, { portalId })`, `buildContactSearchBody({ ownerId, since, after })`, `type HubspotWindow`, `windowFromCursor(cursor, now)`, `advanceWindow(window, page, now)`, `cursorFromWindow(window, identity)`, `type HubspotIdentity = { portalId: string; ownerId: string; hubUserId?: string }`, `identityFromCursor(cursor)`.

The paging window, in words (the smoke pins each line):
1. A window is one query: `hubspot_owner_id = owner` AND (`lastmodifieddate >= since`, when `since` is set), sorted by `lastmodifieddate` ascending, paged with `after`.
2. Starting a window (`after` null): if the last FULL window finished more than 7 days ago (or never), this window is full — `since` null, flagged `full`. That weekly re-read is the safety net for a record skipped when another record moved during paging (Ruling 7's cousin; the upsert is idempotent).
3. Each page raises `windowMax` to the newest `lastmodifieddate` seen.
4. More pages and the next one stays under the 10,000 ceiling (`Number(after) + 100 <= 10_000`): keep `since`, take `after`.
5. More pages but the next would cross the ceiling: restart the query at `since = windowMax`, `after` null, keeping `full` — `>=` re-reads the boundary records, harmlessly. If `windowMax` did not move past `since` (10,000 records with one timestamp), the window ends instead of looping.
6. No more pages: the window is done — `since = windowMax ?? since`, `after` null, `windowMax` cleared; a `full` window stamps `fullSyncedAt = now` and clears `full`.

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-hubspot-mapping.ts`:

```ts
/**
 * HubSpot's pure half: what a contact search result becomes, what the search asks for, and
 * how a sync pages through an owner's contacts across runs without HubSpot's 10,000-result
 * ceiling ever stopping it. Run: npx tsx scripts/smoke-hubspot-mapping.ts
 */
import {
  HUBSPOT_CONTACT_PROPERTIES,
  HUBSPOT_FULL_RESYNC_MS,
  HUBSPOT_SCOPES,
  advanceWindow,
  buildContactSearchBody,
  cursorFromWindow,
  hubspotRecordUrl,
  identityFromCursor,
  lifecycleForStage,
  mapHubspotContact,
  parseHubspotDate,
  windowFromCursor,
  type HubspotWindow,
} from "../src/lib/crm/hubspot/mapping";
import { readFileSync } from "node:fs";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const NOW = new Date("2026-09-23T12:00:00.000Z");

console.log("lifecycle");
for (const [stage, want] of [
  ["customer", "customer"],
  ["evangelist", "customer"],
  ["subscriber", "lead"],
  ["lead", "lead"],
  ["marketingqualifiedlead", "lead"],
  ["salesqualifiedlead", "lead"],
  ["opportunity", "lead"],
  ["other", "other"],
  ["1234567", "other"],
  ["", "other"],
  [null, "other"],
  ["Customer", "customer"],
] as const) {
  check(`${JSON.stringify(stage)} → ${want}`, lifecycleForStage(stage) === want, lifecycleForStage(stage));
}

console.log("\nscopes and properties");
check("reads contacts and owners only", HUBSPOT_SCOPES.join(" ") === "crm.objects.contacts.read crm.objects.owners.read");
for (const p of ["lastmodifieddate", "hubspot_owner_id", "lifecyclestage", "company", "hs_linkedin_url"]) {
  check(`asks for ${p}`, (HUBSPOT_CONTACT_PROPERTIES as readonly string[]).includes(p));
}
check("never asks for associatedcompanyid (read-only, absent in 2026-09)", !(HUBSPOT_CONTACT_PROPERTIES as readonly string[]).includes("associatedcompanyid"));

console.log("\ndates");
check("ISO", parseHubspotDate("2026-09-01T10:00:00.000Z")?.toISOString() === "2026-09-01T10:00:00.000Z");
check("epoch ms string", parseHubspotDate("1788256800000")?.getTime() === 1788256800000);
check("empty is null", parseHubspotDate("") === null && parseHubspotDate(null) === null && parseHubspotDate(undefined) === null);
check("garbage is null", parseHubspotDate("soon") === null);

console.log("\nmapping a contact");
const full = mapHubspotContact(
  {
    id: "501",
    properties: {
      firstname: "Dana",
      lastname: "Whitfield",
      email: "Dana@Acme.test",
      phone: "",
      mobilephone: "+1 415 555 0100",
      company: "Acme",
      jobtitle: "VP Sales",
      hs_linkedin_url: "https://www.linkedin.com/in/danaw",
      lifecyclestage: "customer",
      hs_lead_status: "CONNECTED",
      hubspot_owner_id: "77",
      createdate: "2026-01-01T00:00:00.000Z",
      lastmodifieddate: "2026-09-20T08:00:00.000Z",
      notes_last_updated: "2026-09-19T08:00:00.000Z",
    },
  },
  { portalId: "4242" }
);
check("a full record maps", full !== null);
check("name from first + last", full?.displayName === "Dana Whitfield");
check("remote id and type", full?.remoteId === "501" && full?.remoteType === "contact");
check("lifecycle and raw stage", full?.lifecycle === "customer" && full?.stage === "customer");
check("email kept as written", full?.email === "Dana@Acme.test");
check("an empty phone falls back to the mobile", full?.phone === "+1 415 555 0100");
check("company from the contact's own company property", full?.companyName === "Acme" && full?.companyDomain === null);
check("title and linkedin", full?.title === "VP Sales" && full?.linkedinUrl === "https://www.linkedin.com/in/danaw");
check("owner ref", full?.remoteOwnerRef === "77");
check("record url built from the portal", full?.remoteUrl === "https://app.hubspot.com/contacts/4242/record/0-1/501", String(full?.remoteUrl));
check("updated / created / activity dates", full?.remoteUpdatedAt?.toISOString() === "2026-09-20T08:00:00.000Z" && full?.remoteCreatedAt?.toISOString() === "2026-01-01T00:00:00.000Z" && full?.lastActivityAt?.toISOString() === "2026-09-19T08:00:00.000Z");
check("lead status is the only whitelisted extra", JSON.stringify(full?.properties) === JSON.stringify({ hs_lead_status: "CONNECTED" }));

const emailOnly = mapHubspotContact({ id: "502", properties: { email: "solo@acme.test", lastmodifieddate: "2026-09-20T09:00:00.000Z" } }, { portalId: "4242" });
check("no name falls back to the email", emailOnly?.displayName === "solo@acme.test");
check("no stage is other", emailOnly?.lifecycle === "other" && emailOnly?.stage === null);
check("no extras is an empty object", JSON.stringify(emailOnly?.properties) === "{}");

check("nothing to call them by is skipped", mapHubspotContact({ id: "503", properties: {} }, { portalId: "4242" }) === null);
check(
  "an EU record url from HubSpot is preferred",
  mapHubspotContact({ id: "504", properties: { firstname: "Eu" }, url: "https://app-eu1.hubspot.com/contacts/9/record/0-1/504" }, { portalId: "9" })?.remoteUrl === "https://app-eu1.hubspot.com/contacts/9/record/0-1/504"
);
check(
  "a url that is not HubSpot's is ignored",
  mapHubspotContact({ id: "505", properties: { firstname: "X" }, url: "https://evil.test/x" }, { portalId: "9" })?.remoteUrl === hubspotRecordUrl("9", "505")
);
check("an archived result is skipped", mapHubspotContact({ id: "506", properties: { firstname: "Gone" }, archived: true }, { portalId: "9" }) === null);

console.log("\nthe search body");
const first = buildContactSearchBody({ ownerId: "77", since: null, after: null }) as Record<string, unknown>;
const firstFilters = (first.filterGroups as Array<{ filters: Array<Record<string, string>> }>)[0].filters;
check("always filtered to the owner", firstFilters.length === 1 && firstFilters[0].propertyName === "hubspot_owner_id" && firstFilters[0].operator === "EQ" && firstFilters[0].value === "77");
check("sorted oldest-modified first", JSON.stringify(first.sorts) === JSON.stringify([{ propertyName: "lastmodifieddate", direction: "ASCENDING" }]));
check("a page of 100", first.limit === 100);
check("no after on a first page", !("after" in first));
check("asks for the property list", JSON.stringify(first.properties) === JSON.stringify(HUBSPOT_CONTACT_PROPERTIES));
const later = buildContactSearchBody({ ownerId: "77", since: "2026-09-20T08:00:00.000Z", after: "200" }) as Record<string, unknown>;
const laterFilters = (later.filterGroups as Array<{ filters: Array<Record<string, string>> }>)[0].filters;
check("a since filter, as epoch ms, GTE", laterFilters[1]?.propertyName === "lastmodifieddate" && laterFilters[1]?.operator === "GTE" && laterFilters[1]?.value === String(Date.parse("2026-09-20T08:00:00.000Z")));
check("carries after", later.after === "200");
check("stays under HubSpot's 3,000-character body limit", JSON.stringify(later).length < 3000, String(JSON.stringify(later).length));

console.log("\nthe paging window");
const fresh = windowFromCursor(null, NOW);
check("a first run is a full window", fresh.full && fresh.since === null && fresh.after === null);
const recent = windowFromCursor({ syncedThrough: "2026-09-20T08:00:00.000Z", cursor: null, meta: { portalId: "1", ownerId: "2", fullSyncedAt: "2026-09-22T00:00:00.000Z" } }, NOW);
check("a recent full sync means an incremental window", !recent.full && recent.since === "2026-09-20T08:00:00.000Z");
const stale = windowFromCursor({ syncedThrough: "2026-09-20T08:00:00.000Z", cursor: null, meta: { fullSyncedAt: new Date(NOW.getTime() - HUBSPOT_FULL_RESYNC_MS - 1).toISOString() } }, NOW);
check("a week-old full sync means a full window again", stale.full && stale.since === null);
const resumed = windowFromCursor({ syncedThrough: null, cursor: "300", meta: { full: "1", windowMax: "2026-09-10T00:00:00.000Z" } }, NOW);
check("a window mid-page resumes as it was", resumed.full && resumed.after === "300" && resumed.windowMax === "2026-09-10T00:00:00.000Z");

const w0: HubspotWindow = { since: null, after: null, windowMax: null, full: true, fullSyncedAt: null };
const p1 = advanceWindow(w0, { maxModified: "2026-09-01T00:00:00.000Z", nextAfter: "100" }, NOW);
check("more pages: take after, keep since", !p1.done && p1.window.after === "100" && p1.window.since === null);
check("the window max rises", p1.window.windowMax === "2026-09-01T00:00:00.000Z");
const p2 = advanceWindow({ ...p1.window, after: "9900" }, { maxModified: "2026-09-05T00:00:00.000Z", nextAfter: "10000" }, NOW);
check("crossing the ceiling restarts at the window max", !p2.done && p2.window.since === "2026-09-05T00:00:00.000Z" && p2.window.after === null);
check("…and stays a full window", p2.window.full);
const stuck = advanceWindow({ since: "2026-09-05T00:00:00.000Z", after: "9900", windowMax: "2026-09-05T00:00:00.000Z", full: false, fullSyncedAt: null }, { maxModified: "2026-09-05T00:00:00.000Z", nextAfter: "10000" }, NOW);
check("a ceiling that cannot advance ends instead of looping", stuck.done);
const last = advanceWindow(p2.window, { maxModified: "2026-09-06T00:00:00.000Z", nextAfter: null }, NOW);
check("the last page ends the window at its max", last.done && last.window.since === "2026-09-06T00:00:00.000Z" && last.window.after === null && last.window.windowMax === null);
check("a full window stamps fullSyncedAt and clears the flag", last.window.fullSyncedAt === NOW.toISOString() && !last.window.full);
const empty = advanceWindow({ since: "2026-09-06T00:00:00.000Z", after: null, windowMax: null, full: false, fullSyncedAt: "2026-09-22T00:00:00.000Z" }, { maxModified: null, nextAfter: null }, NOW);
check("an empty incremental window keeps its since", empty.done && empty.window.since === "2026-09-06T00:00:00.000Z" && empty.window.fullSyncedAt === "2026-09-22T00:00:00.000Z");

console.log("\nthe cursor round trip");
const cursor = cursorFromWindow(p1.window, { portalId: "4242", ownerId: "77", hubUserId: "9" });
check("identity survives", JSON.stringify(identityFromCursor(cursor)) === JSON.stringify({ portalId: "4242", ownerId: "77", hubUserId: "9" }));
const back = windowFromCursor(cursor, NOW);
check("the window survives", back.after === "100" && back.full && back.windowMax === "2026-09-01T00:00:00.000Z");
check("meta is strings only", Object.values(cursor.meta ?? {}).every((v) => typeof v === "string"));
check("no identity without both portal and owner", identityFromCursor({ meta: { portalId: "1" } }) === null && identityFromCursor(null) === null);

console.log("\npurity");
for (const file of ["src/lib/crm/types.ts", "src/lib/crm/hubspot/mapping.ts"]) {
  const src = readFileSync(file, "utf8");
  check(`${file} imports no database or server module`, !/from\s+["']@\/db["']|from\s+["']@\/lib\/(?!crm\/)/.test(src.replace(/import type[^;]+;/g, "")));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll HubSpot mapping checks passed.");
```

Register `"smoke-hubspot-mapping": "pure",` in `MANIFEST`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-hubspot-mapping.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/crm/types.ts`:

```ts
/**
 * What every CRM connector hands the shared write path (`src/lib/crm/persist.ts`): one person
 * as the provider describes them, already mapped. Pure and client-safe.
 */
import type { CrmLifecycle, CrmRemoteType, CrmScalar } from "@/db/schema";

export type CrmPerson = {
  remoteType: CrmRemoteType;
  remoteId: string;
  lifecycle: CrmLifecycle;
  /** The provider's raw stage, never interpreted beyond `lifecycle`. */
  stage: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  companyName: string | null;
  companyDomain: string | null;
  title: string | null;
  remoteOwnerRef: string | null;
  remoteUrl: string | null;
  lastActivityAt: Date | null;
  remoteCreatedAt: Date | null;
  remoteUpdatedAt: Date | null;
  properties: Record<string, CrmScalar>;
};
```

Create `src/lib/crm/hubspot/mapping.ts`:

```ts
/**
 * HubSpot, pure: the scopes and properties Orbit asks for, what a contact search result
 * becomes, the search body, and the paging window a sync carries across runs in its cursor.
 *
 * Built on HubSpot's dated `2026-09` API. The undated v1 OAuth endpoints stop working on
 * 2027-02-16 and CRM v3 goes unsupported in Sept 2027 — bump `HUBSPOT_API_VERSION` each
 * March/September rather than falling back to them.
 */
import type { ConnectorSyncCursor, CrmLifecycle } from "@/db/schema";
import type { CrmPerson } from "@/lib/crm/types";

export const HUBSPOT_API_BASE = "https://api.hubapi.com";
export const HUBSPOT_API_VERSION = "2026-09";

/** The app's `requiredScopes`, sent as the `scope` param. `oauth` is added to every app by default. */
export const HUBSPOT_SCOPES = ["crm.objects.contacts.read", "crm.objects.owners.read"] as const;

export const HUBSPOT_SEARCH_PAGE = 100;
/** HubSpot answers a 400 to any search paged past this many results. */
export const HUBSPOT_SEARCH_CEILING = 10_000;
/** How often a sync re-reads every owned contact, as a net under incremental paging. */
export const HUBSPOT_FULL_RESYNC_MS = 7 * 24 * 60 * 60 * 1000;

export const HUBSPOT_CONTACT_PROPERTIES = [
  "firstname",
  "lastname",
  "email",
  "phone",
  "mobilephone",
  "company",
  "jobtitle",
  "hs_linkedin_url",
  "lifecyclestage",
  "hs_lead_status",
  "hubspot_owner_id",
  "createdate",
  "lastmodifieddate",
  "notes_last_updated",
] as const;

export type HubspotContactResult = {
  id: string;
  properties: Record<string, string | null | undefined>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  url?: string;
};

const CUSTOMER_STAGES = new Set(["customer", "evangelist"]);
const LEAD_STAGES = new Set(["subscriber", "lead", "marketingqualifiedlead", "salesqualifiedlead", "opportunity"]);

/** Anything a portal invented (custom stages are numeric ids) is `other`. */
export function lifecycleForStage(stage: string | null | undefined): CrmLifecycle {
  const value = (stage ?? "").trim().toLowerCase();
  if (CUSTOMER_STAGES.has(value)) return "customer";
  if (LEAD_STAGES.has(value)) return "lead";
  return "other";
}

export function hubspotRecordUrl(portalId: string, contactId: string): string {
  return `https://app.hubspot.com/contacts/${encodeURIComponent(portalId)}/record/0-1/${encodeURIComponent(contactId)}`;
}

/** HubSpot sends ISO strings in properties and accepts epoch-ms strings; read both. */
export function parseHubspotDate(value: string | null | undefined): Date | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

function isHubspotUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "hubspot.com" || parsed.hostname.endsWith(".hubspot.com"));
  } catch {
    return false;
  }
}

/** Null when there is nothing to call the person by, or HubSpot says the record is archived. */
export function mapHubspotContact(raw: HubspotContactResult, ctx: { portalId: string }): CrmPerson | null {
  if (raw.archived) return null;
  const p = raw.properties ?? {};
  const email = text(p.email);
  const name = [text(p.firstname), text(p.lastname)].filter(Boolean).join(" ");
  const displayName = name || email;
  if (!displayName) return null;
  const stage = text(p.lifecyclestage);
  const leadStatus = text(p.hs_lead_status);
  return {
    remoteType: "contact",
    remoteId: raw.id,
    lifecycle: lifecycleForStage(stage),
    stage,
    displayName,
    email,
    phone: text(p.phone) ?? text(p.mobilephone),
    linkedinUrl: text(p.hs_linkedin_url),
    companyName: text(p.company),
    companyDomain: null,
    title: text(p.jobtitle),
    remoteOwnerRef: text(p.hubspot_owner_id),
    remoteUrl: isHubspotUrl(raw.url) ? raw.url : hubspotRecordUrl(ctx.portalId, raw.id),
    lastActivityAt: parseHubspotDate(p.notes_last_updated),
    remoteCreatedAt: parseHubspotDate(p.createdate ?? raw.createdAt),
    remoteUpdatedAt: parseHubspotDate(p.lastmodifieddate ?? raw.updatedAt),
    properties: leadStatus ? { hs_lead_status: leadStatus } : {},
  };
}

export function buildContactSearchBody(input: { ownerId: string; since: string | null; after: string | null }): object {
  const filters: Array<{ propertyName: string; operator: string; value: string }> = [
    { propertyName: "hubspot_owner_id", operator: "EQ", value: input.ownerId },
  ];
  if (input.since) {
    filters.push({ propertyName: "lastmodifieddate", operator: "GTE", value: String(Date.parse(input.since)) });
  }
  return {
    filterGroups: [{ filters }],
    sorts: [{ propertyName: "lastmodifieddate", direction: "ASCENDING" }],
    properties: [...HUBSPOT_CONTACT_PROPERTIES],
    limit: HUBSPOT_SEARCH_PAGE,
    ...(input.after ? { after: input.after } : {}),
  };
}

/** One search query's progress. Stored in the connection's cursor between runs. */
export type HubspotWindow = {
  /** Lower bound (ISO) on `lastmodifieddate`; null reads every owned contact. */
  since: string | null;
  /** HubSpot's `after` offset within this query; null = its first page. */
  after: string | null;
  /** Newest `lastmodifieddate` seen in this window (ISO). */
  windowMax: string | null;
  /** This window began as a full re-read. */
  full: boolean;
  /** When the last full window finished (ISO). */
  fullSyncedAt: string | null;
};

export type HubspotIdentity = { portalId: string; ownerId: string; hubUserId?: string };

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

export function windowFromCursor(cursor: ConnectorSyncCursor | null | undefined, now: Date): HubspotWindow {
  const meta = cursor?.meta ?? {};
  const window: HubspotWindow = {
    since: cursor?.syncedThrough ?? null,
    after: cursor?.cursor ?? null,
    windowMax: meta.windowMax ?? null,
    full: meta.full === "1",
    fullSyncedAt: meta.fullSyncedAt ?? null,
  };
  if (window.after !== null) return window;
  const lastFull = window.fullSyncedAt ? Date.parse(window.fullSyncedAt) : Number.NaN;
  if (!Number.isFinite(lastFull) || now.getTime() - lastFull >= HUBSPOT_FULL_RESYNC_MS) {
    return { ...window, since: null, windowMax: null, full: true };
  }
  return window;
}

export function advanceWindow(
  window: HubspotWindow,
  page: { maxModified: string | null; nextAfter: string | null },
  now: Date
): { window: HubspotWindow; done: boolean } {
  const windowMax = later(window.windowMax, page.maxModified);
  if (page.nextAfter !== null) {
    if (Number(page.nextAfter) + HUBSPOT_SEARCH_PAGE <= HUBSPOT_SEARCH_CEILING) {
      return { window: { ...window, after: page.nextAfter, windowMax }, done: false };
    }
    // The next page would cross HubSpot's ceiling: restart the query from the newest
    // modified time seen. `>=` re-reads the boundary records; the upsert is idempotent.
    if (windowMax !== null && (window.since === null || Date.parse(windowMax) > Date.parse(window.since))) {
      return { window: { ...window, since: windowMax, after: null, windowMax }, done: false };
    }
  }
  return {
    window: {
      since: windowMax ?? window.since,
      after: null,
      windowMax: null,
      full: false,
      fullSyncedAt: window.full ? now.toISOString() : window.fullSyncedAt,
    },
    done: true,
  };
}

export function cursorFromWindow(window: HubspotWindow, identity: HubspotIdentity): ConnectorSyncCursor {
  const meta: Record<string, string> = { portalId: identity.portalId, ownerId: identity.ownerId };
  if (identity.hubUserId) meta.hubUserId = identity.hubUserId;
  if (window.windowMax) meta.windowMax = window.windowMax;
  if (window.full) meta.full = "1";
  if (window.fullSyncedAt) meta.fullSyncedAt = window.fullSyncedAt;
  return { syncedThrough: window.since, cursor: window.after, meta };
}

export function identityFromCursor(cursor: ConnectorSyncCursor | null | undefined): HubspotIdentity | null {
  const meta = cursor?.meta;
  if (!meta?.portalId || !meta.ownerId) return null;
  return { portalId: meta.portalId, ownerId: meta.ownerId, ...(meta.hubUserId ? { hubUserId: meta.hubUserId } : {}) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc --noEmit -p . > /tmp/p4-t6-tsc.txt 2>&1; echo tsc=$?` then `npx tsx scripts/run-smoke.ts --check && npx tsx scripts/smoke-hubspot-mapping.ts`
Expected: `tsc=0`; "All HubSpot mapping checks passed."

- [ ] **Step 5: Commit**

```bash
git add src/lib/crm/types.ts src/lib/crm/hubspot/mapping.ts scripts/smoke-hubspot-mapping.ts scripts/run-smoke.ts
git commit -m "Map HubSpot contacts, build the owner search, and page it across runs past the 10,000 ceiling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: HubSpot's HTTP client, and the OAuth helper on HubSpot's dated token endpoint

Verified facts this task relies on (2026-09-23): token `POST https://api.hubapi.com/oauth/2026-09/token`, form-encoded, `client_secret` in the body; the response is `{ token_type, access_token, refresh_token, expires_in: 1800, hub_id, scopes: [...] }` — `scopes` is an ARRAY, not the RFC's `scope` string. A refused refresh is `{ error: "invalid_grant", … }` with a 4xx. Introspection `POST /oauth/2026-09/token/introspect`, form `{ client_id, client_secret, token, token_type_hint }` → `{ active, hub_id, hub_domain, user_id, user (email), scopes, … }`. Revoke `POST /oauth/2026-09/token/revoke`, form `{ client_id, client_secret, token, token_type_hint }`. Owner by user id `GET /crm/owners/2026-09/{userId}?idProperty=userId` → `{ id, … }`; by email `GET /crm/owners/2026-09?email=…&limit=1` → `{ results: [{ id }] }`. Filter contacts on the owner's `id`, never its `userId`. A 401 on a CRM call means the token; 403 means a missing scope.

**Files:**
- Modify: `src/lib/connectors/oauth.ts` (HubSpot token URL, `scopes` array, `extra`, `oauthClientCredentials`, `isOAuthConfigured`)
- Create: `src/lib/crm/hubspot/api.ts`
- Test: `scripts/smoke-hubspot-api.ts` (new, pure) + `MANIFEST` `"smoke-hubspot-api": "pure",`

**Interfaces:**
- Consumes: `ConnectorAuthError` (`@/lib/connectors/auth-errors`, Task 5); `HUBSPOT_API_BASE`, `HUBSPOT_API_VERSION`, `HubspotContactResult` (Task 6).
- Produces:
  - `@/lib/connectors/oauth`: `OAuthTokens.extra?: Record<string, string>` (every other scalar field of the token response, e.g. `hub_id`); `oauthClientCredentials(connectorId): { id: string; secret: string }` (throws when unconfigured, as `buildAuthorizeUrl` does); `isOAuthConfigured(connectorId): boolean`.
  - `@/lib/crm/hubspot/api`: `class HubspotApiError extends Error { kind: HubspotErrorKind; status: number | null; retryable: boolean }`, `type HubspotErrorKind = "rate_limited" | "forbidden" | "not_found" | "bad_request" | "server" | "network"`, `type HubspotTokenInfo = { hubId: string; hubDomain: string | null; userId: string | null; userEmail: string | null; scopes: string[] }`, `introspectHubspotToken(accessToken, fetchImpl?)`, `findHubspotOwner(accessToken, { userId, email }, fetchImpl?): Promise<{ id: string } | null>`, `type HubspotSearchPage = { total: number; results: HubspotContactResult[]; nextAfter: string | null }`, `searchHubspotContacts(accessToken, body, fetchImpl?)`, `revokeHubspotToken(refreshToken, fetchImpl?): Promise<boolean>` (never throws).

Error taxonomy (the sync's decisions hang on it): 401 → `ConnectorAuthError` (openConnectorAuth refreshes once); 429 → `rate_limited`, retryable; 403 → `forbidden`, NOT retryable; 404 → `not_found`, not retryable; 5xx → `server`, retryable; any other non-2xx → `bad_request`, not retryable; a rejected fetch or timeout → `network`, retryable. Messages are shown to the person on the CRM card, so they follow the house voice (curly ’, " — ", no trailing period).

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-hubspot-api.ts`:

```ts
/**
 * HubSpot's HTTP client against a scripted fetch: the dated endpoints, the auth header, the
 * form bodies OAuth wants, and the error taxonomy the sync acts on. No network, no database.
 * Run: npx tsx scripts/smoke-hubspot-api.ts
 */
process.env.HUBSPOT_CLIENT_ID = "cid";
process.env.HUBSPOT_CLIENT_SECRET = "csecret";

import { ConnectorAuthError } from "../src/lib/connectors/auth-errors";
import { OAUTH_PROVIDERS, exchangeCode, isOAuthConfigured } from "../src/lib/connectors/oauth";
import {
  HubspotApiError,
  findHubspotOwner,
  introspectHubspotToken,
  revokeHubspotToken,
  searchHubspotContacts,
} from "../src/lib/crm/hubspot/api";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };

/** A fetch that answers from a list of (predicate, response) pairs and records every call. */
function scripted(routes: Array<[(url: string) => boolean, () => Response | Promise<Response>]>) {
  const seen: Seen[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? ""),
    });
    const route = routes.find(([match]) => match(url));
    if (!route) throw new Error(`unscripted ${url}`);
    return route[1]();
  }) as typeof fetch;
  return { impl, seen };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
}

async function main() {
  console.log("search");
  {
    const f = scripted([
      [(u) => u.endsWith("/contacts/search"), () => json(200, { total: 2, results: [{ id: "1", properties: {} }], paging: { next: { after: "100" } } })],
    ]);
    const page = await searchHubspotContacts("tok", { limit: 100 }, f.impl);
    check("posts to the dated search path", f.seen[0]?.url === "https://api.hubapi.com/crm/objects/2026-09/contacts/search" && f.seen[0]?.method === "POST", f.seen[0]?.url);
    check("with a bearer token", f.seen[0]?.headers.authorization === "Bearer tok");
    check("and a JSON body", f.seen[0]?.headers["content-type"] === "application/json" && f.seen[0]?.body === JSON.stringify({ limit: 100 }));
    check("reads results, total and the next offset", page.results.length === 1 && page.total === 2 && page.nextAfter === "100");
    const last = scripted([[(u) => u.endsWith("/contacts/search"), () => json(200, { total: 1, results: [] })]]);
    check("no paging.next is the last page", (await searchHubspotContacts("tok", {}, last.impl)).nextAfter === null);
  }

  console.log("\nthe error taxonomy");
  const fail = (status: number) => scripted([[() => true, () => json(status, { message: "nope" })]]).impl;
  const e401 = await caught(searchHubspotContacts("tok", {}, fail(401)));
  check("401 is the token", e401 instanceof ConnectorAuthError, String(e401));
  const e429 = await caught(searchHubspotContacts("tok", {}, fail(429)));
  check("429 is retryable rate limiting", e429 instanceof HubspotApiError && e429.kind === "rate_limited" && e429.retryable);
  const e403 = await caught(searchHubspotContacts("tok", {}, fail(403)));
  check("403 is a missing permission, not retryable", e403 instanceof HubspotApiError && e403.kind === "forbidden" && !e403.retryable);
  const e500 = await caught(searchHubspotContacts("tok", {}, fail(502)));
  check("5xx is retryable", e500 instanceof HubspotApiError && e500.kind === "server" && e500.retryable);
  const e400 = await caught(searchHubspotContacts("tok", {}, fail(400)));
  check("another 4xx is not retryable", e400 instanceof HubspotApiError && e400.kind === "bad_request" && !e400.retryable);
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const eNet = await caught(searchHubspotContacts("tok", {}, down));
  check("a network failure is retryable", eNet instanceof HubspotApiError && eNet.kind === "network" && eNet.retryable);
  check("messages never end in a period", [e429, e403, e500, e400, eNet].every((e) => !(e as Error).message.endsWith(".")));

  console.log("\nintrospection");
  {
    const f = scripted([
      [(u) => u.endsWith("/oauth/2026-09/token/introspect"), () => json(200, { active: true, hub_id: 4242, hub_domain: "acme.hubspot.com", user_id: 9, user: "sam@acme.test", scopes: ["crm.objects.contacts.read"] })],
    ]);
    const info = await introspectHubspotToken("tok", f.impl);
    const form = new URLSearchParams(f.seen[0]?.body);
    check("posts a form to the dated introspection path", f.seen[0]?.url === "https://api.hubapi.com/oauth/2026-09/token/introspect" && f.seen[0]?.headers["content-type"] === "application/x-www-form-urlencoded");
    check("with the client credentials and the token", form.get("client_id") === "cid" && form.get("client_secret") === "csecret" && form.get("token") === "tok" && form.get("token_type_hint") === "access_token");
    check("and no bearer header", f.seen[0]?.headers.authorization === undefined);
    check("portal id as a string", info.hubId === "4242");
    check("user, domain and scopes", info.userId === "9" && info.userEmail === "sam@acme.test" && info.hubDomain === "acme.hubspot.com" && info.scopes.length === 1);
    const inactive = scripted([[() => true, () => json(200, { active: false })]]);
    check("an inactive token is the token", (await caught(introspectHubspotToken("tok", inactive.impl))) instanceof ConnectorAuthError);
  }

  console.log("\nthe owner");
  {
    const byId = scripted([[(u) => u.includes("/crm/owners/2026-09/9?idProperty=userId"), () => json(200, { id: "77", userId: 9 })]]);
    check("found by user id", (await findHubspotOwner("tok", { userId: "9", email: "sam@acme.test" }, byId.impl))?.id === "77");
    check("with a bearer token", byId.seen[0]?.headers.authorization === "Bearer tok");
    const byEmail = scripted([
      [(u) => u.includes("idProperty=userId"), () => json(404, { message: "not found" })],
      [(u) => u.includes("/crm/owners/2026-09?email="), () => json(200, { results: [{ id: 78 }] })],
    ]);
    check("falls back to the email", (await findHubspotOwner("tok", { userId: "9", email: "sam@acme.test" }, byEmail.impl))?.id === "78");
    check("the email is encoded", byEmail.seen[1]?.url.includes("email=sam%40acme.test") === true, byEmail.seen[1]?.url);
    const none = scripted([
      [(u) => u.includes("idProperty=userId"), () => json(404, {})],
      [(u) => u.includes("email="), () => json(200, { results: [] })],
    ]);
    check("nobody is null", (await findHubspotOwner("tok", { userId: "9", email: "x@y.test" }, none.impl)) === null);
    const boom = scripted([[() => true, () => json(500, {})]]);
    check("a 5xx is not mistaken for no owner", (await caught(findHubspotOwner("tok", { userId: "9", email: null }, boom.impl))) instanceof HubspotApiError);
  }

  console.log("\nrevoke");
  {
    const ok = scripted([[(u) => u.endsWith("/oauth/2026-09/token/revoke"), () => new Response("", { status: 200 })]]);
    check("a revoke that lands is true", (await revokeHubspotToken("refresh", ok.impl)) === true);
    const form = new URLSearchParams(ok.seen[0]?.body);
    check("revokes the refresh token with the client credentials", form.get("token") === "refresh" && form.get("token_type_hint") === "refresh_token" && form.get("client_id") === "cid");
    check("a revoke that fails is false, never a throw", (await revokeHubspotToken("refresh", down)) === false);
  }

  console.log("\nthe OAuth helper on HubSpot's dated token endpoint");
  {
    check("the token URL is dated", OAUTH_PROVIDERS.hubspot?.tokenUrl === "https://api.hubapi.com/oauth/2026-09/token");
    const f = scripted([
      [(u) => u.endsWith("/oauth/2026-09/token"), () => json(200, { token_type: "bearer", access_token: "a", refresh_token: "r", expires_in: 1800, hub_id: 4242, scopes: ["crm.objects.contacts.read", "crm.objects.owners.read", "oauth"] })],
    ]);
    const before = Date.now();
    const tokens = await exchangeCode("hubspot", "code-1", "https://app.example.com/api/connectors/hubspot/callback", { fetchImpl: f.impl });
    check("scopes arrive as an array and are joined", tokens.scopes === "crm.objects.contacts.read crm.objects.owners.read oauth", String(tokens.scopes));
    check("hub_id lands in extra, as a string", tokens.extra?.hub_id === "4242", JSON.stringify(tokens.extra));
    check("known fields stay out of extra", tokens.extra?.access_token === undefined && tokens.extra?.token_type === undefined);
    check("the 30-minute expiry is read", Math.abs((tokens.expiresAt?.getTime() ?? 0) - (before + 1_800_000)) < 5_000);
    check("configured when both env vars are set", isOAuthConfigured("hubspot"));
    delete process.env.HUBSPOT_CLIENT_SECRET;
    check("not configured without the secret", !isOAuthConfigured("hubspot"));
    check("an unknown connector is not configured", !isOAuthConfigured("nope"));
    process.env.HUBSPOT_CLIENT_SECRET = "csecret";
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll HubSpot API checks passed.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
```

Register `"smoke-hubspot-api": "pure",` in `MANIFEST`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-hubspot-api.ts`
Expected: FAIL — `../src/lib/crm/hubspot/api` not found.

- [ ] **Step 3: Implement the OAuth changes**

`src/lib/connectors/oauth.ts`:

1. `OAUTH_PROVIDERS.hubspot.tokenUrl: "https://api.hubapi.com/oauth/2026-09/token",` with a one-line comment above the entry: `// HubSpot's dated OAuth API; the undated v1 endpoints stop working on 2027-02-16.`
2. Replace `clientCredentials` with an exported, connector-keyed version and add `isOAuthConfigured`:

```ts
/** The app's client id and secret, read at call time. Throws when either is missing. */
export function oauthClientCredentials(connectorId: string): { id: string; secret: string } {
  return clientCredentials(providerOrThrow(connectorId));
}

/** Whether this server can run the connector's OAuth flow at all — for the UI, never a throw. */
export function isOAuthConfigured(connectorId: string): boolean {
  const provider = OAUTH_PROVIDERS[connectorId];
  if (!provider) return false;
  return Boolean(process.env[provider.clientIdEnv]?.trim() && process.env[provider.clientSecretEnv]?.trim());
}
```

(keep the private `clientCredentials(provider)` — `buildAuthorizeUrl`, `exchangeCode` and `refreshAccessToken` still use it).

3. Types:

```ts
export type OAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string | null;
  /**
   * Every other scalar field of the token response, as strings — HubSpot's `hub_id` is the
   * one P4 reads. Optional so a hand-built token (a refresh stub in a smoke) need not carry it.
   */
  extra?: Record<string, string>;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  /** RFC 6749's space-separated string. */
  scope?: string;
  /** HubSpot's array instead. */
  scopes?: unknown;
  error?: string;
  error_description?: string;
  [key: string]: unknown;
};

const KNOWN_TOKEN_FIELDS = new Set([
  "access_token",
  "refresh_token",
  "expires_in",
  "scope",
  "scopes",
  "token_type",
  "id_token",
  "error",
  "error_description",
]);
```

4. In `postToken`, replace the success `return { … }` with:

```ts
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(json)) {
    if (KNOWN_TOKEN_FIELDS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number") extra[key] = String(value);
  }
  const scopes =
    typeof json.scope === "string"
      ? json.scope
      : Array.isArray(json.scopes)
        ? json.scopes.filter((s): s is string => typeof s === "string").join(" ")
        : null;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    scopes: scopes || null,
    extra,
  };
```

- [ ] **Step 4: Implement the client**

Create `src/lib/crm/hubspot/api.ts`:

```ts
/**
 * HubSpot's HTTP half: one request path with the error taxonomy the sync acts on, and the
 * four calls P4 makes. Every call takes `fetchImpl`, so no smoke reaches the network.
 *
 * A 401 becomes `ConnectorAuthError` and nothing else does: `openConnectorAuth` refreshes once
 * on it. HubSpot's own guidance is to refresh on `expires_in` rather than trust a 401, which
 * is what the proactive half of `openConnectorAuth` does — the reactive half is the net.
 */
import { ConnectorAuthError } from "@/lib/connectors/auth-errors";
import { oauthClientCredentials } from "@/lib/connectors/oauth";
import { HUBSPOT_API_BASE, HUBSPOT_API_VERSION, type HubspotContactResult } from "./mapping";

export type HubspotErrorKind = "rate_limited" | "forbidden" | "not_found" | "bad_request" | "server" | "network";

export class HubspotApiError extends Error {
  constructor(
    message: string,
    readonly kind: HubspotErrorKind,
    readonly status: number | null,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "HubspotApiError";
  }
}

const TIMEOUT_MS = 15_000;
const V = HUBSPOT_API_VERSION;

async function send(url: string, init: RequestInit, fetchImpl: typeof fetch, timeoutMs = TIMEOUT_MS): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new HubspotApiError(`HubSpot didn’t answer — ${detail}`.slice(0, 300), "network", null, true);
  }
}

function failure(status: number, body: { message?: unknown }): Error {
  const detail = typeof body.message === "string" ? body.message.slice(0, 200).replace(/\.$/, "") : "";
  if (status === 401) return new ConnectorAuthError(`HubSpot refused the access token${detail ? ` — ${detail}` : ""}`);
  if (status === 429) {
    return new HubspotApiError("HubSpot is rate-limiting this account — the next sync picks up where this one stopped", "rate_limited", 429, true);
  }
  if (status === 403) {
    return new HubspotApiError("HubSpot says this connection can’t read contacts or owners — reconnect HubSpot and approve every permission", "forbidden", 403, false);
  }
  if (status === 404) return new HubspotApiError(`HubSpot couldn’t find that${detail ? ` — ${detail}` : ""}`, "not_found", 404, false);
  if (status >= 500) return new HubspotApiError(`HubSpot returned ${status} — the next sync will try again`, "server", status, true);
  return new HubspotApiError(`HubSpot rejected the request (${status})${detail ? ` — ${detail}` : ""}`, "bad_request", status, false);
}

async function hubspotJson<T>(
  accessToken: string,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  fetchImpl: typeof fetch
): Promise<T> {
  const res = await send(
    `${HUBSPOT_API_BASE}${path}`,
    {
      method: init.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    },
    fetchImpl
  );
  const json = (await res.json().catch(() => ({}))) as { message?: unknown };
  if (!res.ok) throw failure(res.status, json);
  return json as T;
}

function oauthForm(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  };
}

export type HubspotTokenInfo = {
  hubId: string;
  hubDomain: string | null;
  userId: string | null;
  userEmail: string | null;
  scopes: string[];
};

export async function introspectHubspotToken(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<HubspotTokenInfo> {
  const { id, secret } = oauthClientCredentials("hubspot");
  const res = await send(
    `${HUBSPOT_API_BASE}/oauth/${V}/token/introspect`,
    oauthForm({ client_id: id, client_secret: secret, token: accessToken, token_type_hint: "access_token" }),
    fetchImpl
  );
  const json = (await res.json().catch(() => ({}))) as {
    active?: boolean;
    hub_id?: string | number;
    hub_domain?: string;
    user_id?: string | number;
    user?: string;
    scopes?: unknown;
    message?: unknown;
  };
  if (!res.ok) throw failure(res.status, json);
  if (json.active === false) throw new ConnectorAuthError("HubSpot says this access token is no longer active");
  if (json.hub_id === undefined || json.hub_id === null) {
    throw new HubspotApiError("HubSpot’s token details named no account", "bad_request", res.status, false);
  }
  return {
    hubId: String(json.hub_id),
    hubDomain: typeof json.hub_domain === "string" ? json.hub_domain : null,
    userId: json.user_id === undefined || json.user_id === null ? null : String(json.user_id),
    userEmail: typeof json.user === "string" ? json.user : null,
    scopes: Array.isArray(json.scopes) ? json.scopes.filter((s): s is string => typeof s === "string") : [],
  };
}

/** The owner record for the person who connected — its `id` is what contacts are filtered on. */
export async function findHubspotOwner(
  accessToken: string,
  who: { userId: string | null; email: string | null },
  fetchImpl: typeof fetch = fetch
): Promise<{ id: string } | null> {
  if (who.userId) {
    try {
      const owner = await hubspotJson<{ id?: string | number | null }>(
        accessToken,
        `/crm/owners/${V}/${encodeURIComponent(who.userId)}?idProperty=userId`,
        { method: "GET" },
        fetchImpl
      );
      if (owner.id !== undefined && owner.id !== null) return { id: String(owner.id) };
    } catch (err) {
      if (!(err instanceof HubspotApiError && err.kind === "not_found")) throw err;
    }
  }
  if (who.email) {
    const list = await hubspotJson<{ results?: Array<{ id?: string | number | null }> }>(
      accessToken,
      `/crm/owners/${V}?email=${encodeURIComponent(who.email)}&limit=1`,
      { method: "GET" },
      fetchImpl
    );
    const first = list.results?.[0];
    if (first?.id !== undefined && first.id !== null) return { id: String(first.id) };
  }
  return null;
}

export type HubspotSearchPage = { total: number; results: HubspotContactResult[]; nextAfter: string | null };

export async function searchHubspotContacts(
  accessToken: string,
  body: object,
  fetchImpl: typeof fetch = fetch
): Promise<HubspotSearchPage> {
  const json = await hubspotJson<{
    total?: number;
    results?: HubspotContactResult[];
    paging?: { next?: { after?: string } };
  }>(accessToken, `/crm/objects/${V}/contacts/search`, { method: "POST", body }, fetchImpl);
  return {
    total: typeof json.total === "number" ? json.total : 0,
    results: Array.isArray(json.results) ? json.results : [],
    nextAfter: json.paging?.next?.after ?? null,
  };
}

/** Best effort and time-boxed: a HubSpot outage must never block a disconnect. */
export async function revokeHubspotToken(refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const { id, secret } = oauthClientCredentials("hubspot");
    const res = await send(
      `${HUBSPOT_API_BASE}/oauth/${V}/token/revoke`,
      oauthForm({ client_id: id, client_secret: secret, token: refreshToken, token_type_hint: "refresh_token" }),
      fetchImpl,
      5_000
    );
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsc --noEmit -p . > /tmp/p4-t7-tsc.txt 2>&1; echo tsc=$?` then `npx tsx scripts/run-smoke.ts --check && npx tsx scripts/run-smoke.ts --only smoke-hubspot-api smoke-hubspot-mapping smoke-connector-oauth smoke-oauth-refresh-rejection smoke-connector-token smoke-env-documented`
Expected: `tsc=0`; `6/6 passed`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/connectors/oauth.ts src/lib/crm/hubspot/api.ts scripts/smoke-hubspot-api.ts scripts/run-smoke.ts
git commit -m "Add HubSpot's client on the dated 2026-09 API, and read HubSpot's token response

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: The `crm_records` store

**Files:**
- Create: `src/lib/crm/records.ts`
- Test: `scripts/smoke-crm-records.ts` (new, pglite) + `MANIFEST` `"smoke-crm-records": "pglite",`

**Interfaces:**
- Consumes: `crmRecords`, `CrmRecord` (Task 2); `CrmPerson` (Task 6); `identityKeysFor` (`@/lib/duplicates`); `displayCompanyName`, `normalizeCompanyName` (`@/lib/company-name`).
- Produces (from `@/lib/crm/records`):
  - `upsertCrmRecords(userId, connectorId, people: CrmPerson[], now?): Promise<CrmRecord[]>` — one statement; in-batch duplicates collapse (last wins); an existing row keeps `contact_id`, `link_blocked_at` and `created_at`.
  - `linkCrmRecords(userId, links: Array<{ recordId: string; contactId: string }>, now?): Promise<void>` — one statement; clears `link_blocked_at`; scoped to `userId`.
  - `markCrmLinksBlocked(userId, recordIds: string[], now?): Promise<void>`
  - `type CrmCounts = { workContacts: number; pipeline: number; blocked: number }`, `crmCounts(userId, connectorId): Promise<CrmCounts>` — work contacts are DISTINCT linked contacts; pipeline is every non-customer record; blocked is refused-and-still-unlinked.
  - `crmRecordLinks(userId, recordIds: string[]): Promise<Map<string, { connectorId: string; remoteUrl: string | null }>>`
  - `deleteCrmRecordsForConnector(userId, connectorId): Promise<number>`

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-crm-records.ts`:

```ts
/**
 * `crm_records`: the upsert every CRM sync page goes through, the contact links, and the
 * counts the CRM card shows. The properties that matter are the silent ones — a re-sync must
 * never unlink a work contact, and one user's link call must never touch another's rows.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, crmRecords } from "../src/db/schema";
import type { CrmPerson } from "../src/lib/crm/types";
import {
  crmCounts,
  crmRecordLinks,
  deleteCrmRecordsForConnector,
  linkCrmRecords,
  markCrmLinksBlocked,
  upsertCrmRecords,
} from "../src/lib/crm/records";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-crm-records";
const OTHER = "smoke-crm-records-other";

function person(over: Partial<CrmPerson> & Pick<CrmPerson, "remoteId">): CrmPerson {
  return {
    remoteType: "contact",
    lifecycle: "lead",
    stage: "lead",
    displayName: "Someone",
    email: null,
    phone: null,
    linkedinUrl: null,
    companyName: null,
    companyDomain: null,
    title: null,
    remoteOwnerRef: "77",
    remoteUrl: null,
    lastActivityAt: null,
    remoteCreatedAt: null,
    remoteUpdatedAt: null,
    properties: {},
    ...over,
  };
}

async function reset() {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(crmRecords).where(eq(crmRecords.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }
}

run(async () => {
  await reset();
  const db = await getDb();

  console.log("the first upsert");
  const first = await upsertCrmRecords(USER, "hubspot", [
    person({ remoteId: "1", lifecycle: "customer", stage: "customer", displayName: "Dana Whitfield", email: "Dana@Acme.test", companyName: "  Acme   Corp ", remoteUrl: "https://app.hubspot.com/contacts/1/record/0-1/1" }),
    person({ remoteId: "2", displayName: "Grace Park", email: "grace@beta.test" }),
    person({ remoteId: "2", displayName: "Grace Park", email: "grace@beta.test", title: "CTO" }),
  ]);
  check("in-batch duplicates collapse", first.length === 2, String(first.length));
  const dana = first.find((r) => r.remoteId === "1");
  const grace = first.find((r) => r.remoteId === "2");
  check("the email identity is normalised", dana?.emailNormalized === "dana@acme.test", String(dana?.emailNormalized));
  check("the raw email is kept", dana?.email === "Dana@Acme.test");
  check("the company is tidied and keyed", dana?.companyName === "Acme Corp" && dana?.companyNormalized === "acme corp");
  check("the last duplicate wins", grace?.title === "CTO");

  console.log("\nlinking");
  const [contact] = await db.insert(contacts).values({ userId: USER, fullName: "Dana Whitfield" }).returning();
  await markCrmLinksBlocked(USER, [dana!.id]);
  const [blocked] = await db.select().from(crmRecords).where(eq(crmRecords.id, dana!.id));
  check("a refused create is marked", blocked?.linkBlockedAt !== null);
  await linkCrmRecords(USER, [{ recordId: dana!.id, contactId: contact.id }]);
  const [linked] = await db.select().from(crmRecords).where(eq(crmRecords.id, dana!.id));
  check("the link is stored", linked?.contactId === contact.id);
  check("and clears the refusal", linked?.linkBlockedAt === null);

  console.log("\na re-sync");
  const second = await upsertCrmRecords(USER, "hubspot", [
    person({ remoteId: "1", lifecycle: "customer", stage: "evangelist", displayName: "Dana Whitfield", title: "CRO" }),
    person({ remoteId: "2", lifecycle: "customer", stage: "customer", displayName: "Grace Park" }),
  ]);
  const dana2 = second.find((r) => r.remoteId === "1");
  const grace2 = second.find((r) => r.remoteId === "2");
  check("the same row, not a new one", dana2?.id === dana?.id && grace2?.id === grace?.id);
  check("never unlinks a work contact", dana2?.contactId === contact.id);
  check("CRM fields follow the CRM", dana2?.stage === "evangelist" && dana2?.title === "CRO");
  check("lead → customer flips the lifecycle in place", grace2?.lifecycle === "customer");
  check("created_at is kept", dana2?.createdAt.getTime() === dana?.createdAt.getTime());

  console.log("\nscoping");
  const [theirs] = await upsertCrmRecords(OTHER, "hubspot", [person({ remoteId: "1", displayName: "Their Dana" })]);
  check("the same remote id under another user is another row", theirs.id !== dana?.id);
  await linkCrmRecords(USER, [{ recordId: theirs.id, contactId: contact.id }]);
  const [untouched] = await db.select().from(crmRecords).where(eq(crmRecords.id, theirs.id));
  check("a link call never touches another user's row", untouched?.contactId === null);

  console.log("\ncounts and links");
  const counts = await crmCounts(USER, "hubspot");
  check("one work contact, nothing blocked", counts.workContacts === 1 && counts.blocked === 0, JSON.stringify(counts));
  check("no pipeline records once both are customers", counts.pipeline === 0, JSON.stringify(counts));
  const links = await crmRecordLinks(USER, [dana!.id, theirs.id]);
  check("links carry the connector and url", links.get(dana!.id)?.connectorId === "hubspot" && links.get(dana!.id)?.remoteUrl !== undefined);
  check("links never include another user's record", !links.has(theirs.id));

  console.log("\ndeleting a contact unlinks, it does not delete");
  await db.delete(contacts).where(eq(contacts.id, contact.id));
  const [afterDelete] = await db.select().from(crmRecords).where(eq(crmRecords.id, dana!.id));
  check("the record stays, unlinked", afterDelete !== undefined && afterDelete.contactId === null);

  console.log("\ndisconnect");
  await upsertCrmRecords(USER, "salesforce", [person({ remoteId: "sf-1" })]);
  const removed = await deleteCrmRecordsForConnector(USER, "hubspot");
  check("removes that connector's rows", removed === 2, String(removed));
  const left = await db.select().from(crmRecords).where(eq(crmRecords.userId, USER));
  check("and only that connector's", left.length === 1 && left[0]?.connectorId === "salesforce");
  check("another user's rows are untouched", (await db.select().from(crmRecords).where(eq(crmRecords.userId, OTHER))).length === 1);

  await reset();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll CRM record checks passed.");
});
```

Register `"smoke-crm-records": "pglite",` in `MANIFEST`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/run-smoke.ts --only smoke-crm-records`
Expected: FAIL — `../src/lib/crm/records` not found.

- [ ] **Step 3: Implement**

Create `src/lib/crm/records.ts`:

```ts
/**
 * `crm_records`: the ledger every CRM sync writes, and the map between an Orbit contact and
 * its CRM record. One statement per write however long the page — a sync runs on `neon-http`,
 * where every statement is its own HTTP round trip.
 *
 * Every statement carries the owner's `user_id` in its WHERE, including the bulk UPDATE whose
 * VALUES list names ids: an id from another account must match nothing.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { crmRecords, type CrmRecord } from "@/db/schema";
import { displayCompanyName, normalizeCompanyName } from "@/lib/company-name";
import type { CrmPerson } from "@/lib/crm/types";
import { identityKeysFor } from "@/lib/duplicates";

/** A provider field is data, not a document: past this, it is cut. */
const FIELD_MAX = 500;

function clip(value: string | null): string | null {
  return value === null ? null : value.slice(0, FIELD_MAX);
}

export async function upsertCrmRecords(
  userId: string,
  connectorId: string,
  people: CrmPerson[],
  now: Date = new Date()
): Promise<CrmRecord[]> {
  // ON CONFLICT DO UPDATE cannot touch one row twice in a statement, and a provider page can
  // list a record twice: collapse first, last one wins.
  const byKey = new Map<string, CrmPerson>();
  for (const p of people) byKey.set(`${p.remoteType}:${p.remoteId}`, p);
  if (byKey.size === 0) return [];

  const values = [...byKey.values()].map((p) => {
    const email = p.email?.trim() || null;
    const company = p.companyName ? displayCompanyName(p.companyName) || null : null;
    return {
      userId,
      connectorId,
      remoteType: p.remoteType,
      remoteId: p.remoteId,
      lifecycle: p.lifecycle,
      stage: clip(p.stage),
      displayName: clip(p.displayName) ?? "",
      email: clip(email),
      emailNormalized: identityKeysFor({ email }).find((k) => k.kind === "email")?.value ?? null,
      phone: clip(p.phone),
      linkedinUrl: clip(p.linkedinUrl),
      companyName: clip(company),
      companyNormalized: company ? normalizeCompanyName(company) || null : null,
      companyDomain: clip(p.companyDomain),
      title: clip(p.title),
      remoteOwnerRef: clip(p.remoteOwnerRef),
      remoteUrl: clip(p.remoteUrl),
      lastActivityAt: p.lastActivityAt,
      remoteCreatedAt: p.remoteCreatedAt,
      remoteUpdatedAt: p.remoteUpdatedAt,
      properties: p.properties,
      syncedAt: now,
      updatedAt: now,
    };
  });

  const db = await getDb();
  return db
    .insert(crmRecords)
    .values(values)
    .onConflictDoUpdate({
      target: [crmRecords.userId, crmRecords.connectorId, crmRecords.remoteType, crmRecords.remoteId],
      // Everything the CRM owns follows the CRM. `contact_id` and `link_blocked_at` are
      // Orbit's and are deliberately absent: a re-sync must never unlink a work contact.
      set: {
        lifecycle: sql`excluded.lifecycle`,
        stage: sql`excluded.stage`,
        displayName: sql`excluded.display_name`,
        email: sql`excluded.email`,
        emailNormalized: sql`excluded.email_normalized`,
        phone: sql`excluded.phone`,
        linkedinUrl: sql`excluded.linkedin_url`,
        companyName: sql`excluded.company_name`,
        companyNormalized: sql`excluded.company_normalized`,
        companyDomain: sql`excluded.company_domain`,
        title: sql`excluded.title`,
        remoteOwnerRef: sql`excluded.remote_owner_ref`,
        remoteUrl: sql`excluded.remote_url`,
        lastActivityAt: sql`excluded.last_activity_at`,
        remoteCreatedAt: sql`excluded.remote_created_at`,
        remoteUpdatedAt: sql`excluded.remote_updated_at`,
        properties: sql`excluded.properties`,
        syncedAt: sql`excluded.synced_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .returning();
}

export async function linkCrmRecords(
  userId: string,
  links: Array<{ recordId: string; contactId: string }>,
  now: Date = new Date()
): Promise<void> {
  if (links.length === 0) return;
  const db = await getDb();
  const rows = sql.join(
    links.map((l) => sql`(${l.recordId}::uuid, ${l.contactId}::uuid)`),
    sql`, `
  );
  await db.execute(sql`
    UPDATE crm_records AS cr
       SET contact_id = v.contact_id, link_blocked_at = NULL, updated_at = ${now}
      FROM (VALUES ${rows}) AS v(id, contact_id)
     WHERE cr.id = v.id AND cr.user_id = ${userId}
  `);
}

/** A customer the plan's contact cap refused to create. Cleared by the link that follows. */
export async function markCrmLinksBlocked(userId: string, recordIds: string[], now: Date = new Date()): Promise<void> {
  if (recordIds.length === 0) return;
  const db = await getDb();
  await db
    .update(crmRecords)
    .set({ linkBlockedAt: now, updatedAt: now })
    .where(and(eq(crmRecords.userId, userId), inArray(crmRecords.id, recordIds)));
}

export type CrmCounts = { workContacts: number; pipeline: number; blocked: number };

export async function crmCounts(userId: string, connectorId: string): Promise<CrmCounts> {
  const db = await getDb();
  const [row] = rowsOf<{ work: number; pipeline: number; blocked: number }>(
    await db.execute(sql`
      SELECT count(DISTINCT contact_id)::int AS work,
             count(*) FILTER (WHERE lifecycle <> 'customer')::int AS pipeline,
             count(*) FILTER (WHERE link_blocked_at IS NOT NULL AND contact_id IS NULL)::int AS blocked
        FROM crm_records
       WHERE user_id = ${userId} AND connector_id = ${connectorId}
    `)
  );
  return { workContacts: row?.work ?? 0, pipeline: row?.pipeline ?? 0, blocked: row?.blocked ?? 0 };
}

export async function crmRecordLinks(
  userId: string,
  recordIds: string[]
): Promise<Map<string, { connectorId: string; remoteUrl: string | null }>> {
  const out = new Map<string, { connectorId: string; remoteUrl: string | null }>();
  if (recordIds.length === 0) return out;
  const db = await getDb();
  const rows = await db
    .select({ id: crmRecords.id, connectorId: crmRecords.connectorId, remoteUrl: crmRecords.remoteUrl })
    .from(crmRecords)
    .where(and(eq(crmRecords.userId, userId), inArray(crmRecords.id, recordIds)));
  for (const r of rows) out.set(r.id, { connectorId: r.connectorId, remoteUrl: r.remoteUrl });
  return out;
}

/** Disconnect: the ledger goes; the contacts it created stay, and CRM leads keep their rows. */
export async function deleteCrmRecordsForConnector(userId: string, connectorId: string): Promise<number> {
  const db = await getDb();
  const removed = await db
    .delete(crmRecords)
    .where(and(eq(crmRecords.userId, userId), eq(crmRecords.connectorId, connectorId)))
    .returning();
  return removed.length;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc --noEmit -p . > /tmp/p4-t8-tsc.txt 2>&1; echo tsc=$?` then `npx tsx scripts/run-smoke.ts --check && npx tsx scripts/run-smoke.ts --only smoke-crm-records`
Expected: `tsc=0`; `1/1 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/crm/records.ts scripts/smoke-crm-records.ts scripts/run-smoke.ts
git commit -m "Store CRM records in bulk, link them to contacts, and never unlink one on re-sync

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: One CRM page into Orbit — customers become contacts, everyone else joins the pipeline

**Files:**
- Create: `src/lib/crm/crm-leads-plan.ts` (pure)
- Create: `src/lib/leads/crm-leads.ts` (server)
- Create: `src/lib/crm/persist.ts` (server; provider-agnostic — Salesforce reuses it in P5)
- Modify: `src/lib/leads/pipeline.ts` (`PipelineRow.crm`), `src/lib/leads/store.ts` (`listLeads` unchanged; nothing else)
- Test: `scripts/smoke-crm-leads.ts` (new, pglite) + `MANIFEST` `"smoke-crm-leads": "pglite",`

**Interfaces:**
- Consumes: `normalizeLeadInput`, `NormalizedLead` (P3); `upsertCrmRecords`, `linkCrmRecords`, `markCrmLinksBlocked`, `crmRecordLinks` (Task 8); `ingestPeople`, `PersonRecord` (Task 4); `IngestContext`, `openIngestContext` (`@/lib/ingest/events`); `CrmPerson` (Task 6); `connectorById` (registry).
- Produces:
  - `@/lib/crm/crm-leads-plan`: `type CrmLeadRecord = { id: string; lifecycle: CrmLifecycle; contactId: string | null; displayName: string; email: string | null; phone: string | null; linkedinUrl: string | null; companyName: string | null; title: string | null }`, `type ExistingLead`, `type CrmLeadFill`, `type CrmLeadPlan = { inserts; fills; conversions }`, `planCrmLeads(records, existing): CrmLeadPlan`
  - `@/lib/leads/crm-leads`: `syncCrmLeads(userId, records: CrmLeadRecord[]): Promise<{ created: number; updated: number; converted: number }>` — at most 4 statements (1 read, ≤1 insert, ≤1 bulk fill, ≤1 bulk convert)
  - `@/lib/crm/persist`: `type CrmPageStats = { records: number; customers: number; contactsCreated: number; contactsMatched: number; blocked: number; leadsCreated: number; leadsUpdated: number; leadsConverted: number }`, `persistCrmPage(ctx: IngestContext, connectorId: string, people: CrmPerson[], now?): Promise<CrmPageStats>` — `ctx` MUST be opened with `{ createsContacts: true, reportResolutions: true }`; it throws otherwise.
  - `@/lib/leads/pipeline`: `PipelineRow = { lead: Lead; path: WarmPath | null; crm: { label: string; url: string } | null }`

The pipeline rules (`planCrmLeads`, one smoke check each):
1. A record already tied to a lead (`leads.crm_record_id`) updates that lead.
2. Otherwise an UNTIED lead sharing an identifier (normalised email, LinkedIn slug, E.164 phone — P3's dedupe keys) adopts the record: a manual or Apollo target that later appears in HubSpot is one lead, not two.
3. Otherwise a `lead`/`other` record becomes a new `source = 'crm'` lead. A `customer` record creates no lead.
4. Updates only fill blanks, raw and normalised columns together (P3's `fillPair` rule), and never change status: a lead the user dismissed stays dismissed.
5. A `customer` record with a contact converts the lead it matched when that lead is `open` or `intro_requested` (status `converted`, `contact_id` set). A converted or dismissed lead is left alone. A customer without a contact (cap-refused) only attaches its record.
6. Each existing lead is claimed by at most one record per page (first wins).

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-crm-leads.ts`:

```ts
/**
 * A CRM page into Orbit: the pipeline rules as a pure table, then `persistCrmPage` end to end
 * — customers become (or match) contacts and are linked; leads land in the pipeline, merge
 * with the manual targets they duplicate, and convert when the CRM says they became customers.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, crmRecords, leads, type Lead } from "../src/db/schema";
import { planCrmLeads, type CrmLeadRecord, type ExistingLead } from "../src/lib/crm/crm-leads-plan";
import { persistCrmPage } from "../src/lib/crm/persist";
import type { CrmPerson } from "../src/lib/crm/types";
import { openIngestContext } from "../src/lib/ingest/events";
import { loadPipeline } from "../src/lib/leads/pipeline";
import { saveLead } from "../src/lib/leads/store";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-crm-leads";

function rec(over: Partial<CrmLeadRecord> & Pick<CrmLeadRecord, "id">): CrmLeadRecord {
  return { lifecycle: "lead", contactId: null, displayName: "Someone", email: null, phone: null, linkedinUrl: null, companyName: null, title: null, ...over };
}

function lead(over: Partial<ExistingLead> & Pick<ExistingLead, "id">): ExistingLead {
  return {
    crmRecordId: null,
    status: "open",
    contactId: null,
    email: null,
    emailNormalized: null,
    linkedinUrl: null,
    linkedinSlug: null,
    phone: null,
    phoneE164: null,
    companyName: null,
    companyNormalized: null,
    title: null,
    ...over,
  };
}

function person(over: Partial<CrmPerson> & Pick<CrmPerson, "remoteId" | "displayName">): CrmPerson {
  return {
    remoteType: "contact",
    lifecycle: "lead",
    stage: "lead",
    email: null,
    phone: null,
    linkedinUrl: null,
    companyName: null,
    companyDomain: null,
    title: null,
    remoteOwnerRef: "77",
    remoteUrl: `https://app.hubspot.com/contacts/1/record/0-1/${over.remoteId}`,
    lastActivityAt: null,
    remoteCreatedAt: null,
    remoteUpdatedAt: null,
    properties: {},
    ...over,
  };
}

async function reset() {
  const db = await getDb();
  await db.delete(leads).where(eq(leads.userId, USER));
  await db.delete(crmRecords).where(eq(crmRecords.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
}

run(async () => {
  console.log("the rules, pure");
  {
    const tied = planCrmLeads([rec({ id: "r1", title: "CTO" })], [lead({ id: "L1", crmRecordId: "r1" })]);
    check("1. a tied record fills its lead", tied.fills.length === 1 && tied.fills[0].leadId === "L1" && tied.fills[0].title === "CTO" && tied.inserts.length === 0);

    const adopt = planCrmLeads(
      [rec({ id: "r2", email: "Ada@Example.test" })],
      [lead({ id: "L2", email: "ada@example.test", emailNormalized: "ada@example.test" })]
    );
    check("2. an untied lead with the same email adopts the record", adopt.fills[0]?.leadId === "L2" && adopt.fills[0]?.crmRecordId === "r2" && adopt.inserts.length === 0);

    const tiedElsewhere = planCrmLeads(
      [rec({ id: "r3", email: "ada@example.test" })],
      [lead({ id: "L3", crmRecordId: "someone-else", email: "ada@example.test", emailNormalized: "ada@example.test" })]
    );
    check("2b. a lead tied to another record is never adopted", tiedElsewhere.fills.length === 0 && tiedElsewhere.inserts.length === 1);

    const fresh = planCrmLeads([rec({ id: "r4", displayName: "New Person", email: "new@example.test", lifecycle: "other" })], []);
    check("3. a lead/other record with no match becomes a new lead", fresh.inserts.length === 1 && fresh.inserts[0].crmRecordId === "r4" && fresh.inserts[0].emailNormalized === "new@example.test");
    const customerOnly = planCrmLeads([rec({ id: "r5", lifecycle: "customer", contactId: "c5" })], []);
    check("3b. a customer creates no lead", customerOnly.inserts.length === 0 && customerOnly.fills.length === 0 && customerOnly.conversions.length === 0);

    const blanks = planCrmLeads(
      [rec({ id: "r6", email: "second@example.test", title: "VP", companyName: "Acme" })],
      [lead({ id: "L6", crmRecordId: "r6", email: "first@example.test", emailNormalized: "first@example.test", title: null })]
    );
    const f6 = blanks.fills[0];
    check("4. an existing email is never overwritten", f6?.email === undefined && f6?.emailNormalized === undefined);
    check("4b. blanks fill, pairs together", f6?.title === "VP" && f6?.companyName === "Acme" && f6?.companyNormalized === "acme");
    const nothingNew = planCrmLeads([rec({ id: "r7" })], [lead({ id: "L7", crmRecordId: "r7" })]);
    check("4c. a tied lead with nothing to fill is left alone", nothingNew.fills.length === 0);
    const dismissed = planCrmLeads([rec({ id: "r8", title: "CEO" })], [lead({ id: "L8", crmRecordId: "r8", status: "dismissed" })]);
    check("4d. a dismissed lead is filled but never reopened (plans carry no status)", dismissed.fills.length === 1 && !("status" in dismissed.fills[0]));

    const becameCustomer = planCrmLeads([rec({ id: "r9", lifecycle: "customer", contactId: "c9" })], [lead({ id: "L9", crmRecordId: "r9", status: "intro_requested" })]);
    check("5. a customer converts its lead", becameCustomer.conversions[0]?.leadId === "L9" && becameCustomer.conversions[0]?.contactId === "c9");
    const alreadyDone = planCrmLeads([rec({ id: "r10", lifecycle: "customer", contactId: "c10" })], [lead({ id: "L10", crmRecordId: "r10", status: "dismissed" })]);
    check("5b. a dismissed lead is not converted", alreadyDone.conversions.length === 0);
    const capped = planCrmLeads(
      [rec({ id: "r11", lifecycle: "customer", contactId: null, email: "cap@example.test" })],
      [lead({ id: "L11", email: "cap@example.test", emailNormalized: "cap@example.test" })]
    );
    check("5c. a cap-refused customer only attaches its record", capped.conversions.length === 0 && capped.fills[0]?.crmRecordId === "r11");

    const twice = planCrmLeads(
      [rec({ id: "r12", email: "dup@example.test" }), rec({ id: "r13", email: "dup@example.test" })],
      [lead({ id: "L12", email: "dup@example.test", emailNormalized: "dup@example.test" })]
    );
    check("6. one lead is claimed by one record per page", twice.fills.filter((f) => f.leadId === "L12").length === 1 && twice.inserts.length === 1);
  }

  console.log("\npersistCrmPage, end to end");
  await reset();
  const db = await getDb();
  // An existing contact the CRM customer should MATCH, not duplicate.
  await db.insert(contacts).values({ userId: USER, fullName: "Dana Whitfield", email: "dana@acme.test" });
  // A manual target the CRM lead should MERGE with.
  const { lead: manual } = await saveLead(USER, { source: "manual", displayName: "Grace Park", email: "grace@beta.test" });

  const ctx = await openIngestContext(USER, { source: "hubspot", createsContacts: true, reportResolutions: true });
  const page1 = await persistCrmPage(ctx, "hubspot", [
    person({ remoteId: "1", displayName: "Dana Whitfield", email: "dana@acme.test", lifecycle: "customer", stage: "customer" }),
    person({ remoteId: "2", displayName: "Grace Park", email: "Grace@Beta.test", title: "CTO" }),
    person({ remoteId: "3", displayName: "Ivy Chen", email: "ivy@gamma.test", lifecycle: "other", stage: null }),
    person({ remoteId: "4", displayName: "Marco Rossi", email: "marco@delta.test", lifecycle: "customer", stage: "customer" }),
  ]);
  check("four records stored", page1.records === 4, JSON.stringify(page1));
  check("two customers: one matched, one created", page1.customers === 2 && page1.contactsMatched === 1 && page1.contactsCreated === 1, JSON.stringify(page1));
  const records = await db.select().from(crmRecords).where(eq(crmRecords.userId, USER));
  const byRemote = new Map(records.map((r) => [r.remoteId, r]));
  const [danaContact] = await db.select().from(contacts).where(eq(contacts.email, "dana@acme.test"));
  check("the existing contact is linked, not duplicated", byRemote.get("1")?.contactId === danaContact?.id);
  check("the new customer is linked to its new contact", byRemote.get("4")?.contactId !== null);
  check("a work contact's source says where it came from", (await db.select().from(contacts).where(eq(contacts.email, "marco@delta.test")))[0]?.source === "hubspot");
  const allLeads = await db.select().from(leads).where(eq(leads.userId, USER));
  const grace = allLeads.find((l) => l.id === manual.id);
  check("the CRM lead merged into the manual target", allLeads.filter((l) => l.emailNormalized === "grace@beta.test").length === 1 && grace?.crmRecordId === byRemote.get("2")?.id);
  check("…keeping it a manual lead, now with the CRM's title", grace?.source === "manual" && grace?.title === "CTO");
  const ivy = allLeads.find((l) => l.emailNormalized === "ivy@gamma.test");
  check("a no-stage record became a crm lead", ivy?.source === "crm" && ivy?.crmRecordId === byRemote.get("3")?.id && ivy?.status === "open");
  check("customers created no leads", allLeads.length === 2, String(allLeads.length));

  console.log("\na re-sync, and a lead that became a customer");
  const page2 = await persistCrmPage(ctx, "hubspot", [
    person({ remoteId: "3", displayName: "Ivy Chen", email: "ivy@gamma.test", lifecycle: "customer", stage: "customer" }),
  ]);
  check("the converted customer was created as a contact", page2.contactsCreated === 1, JSON.stringify(page2));
  const [ivyAfter] = await db.select().from(leads).where(eq(leads.id, ivy!.id));
  const [ivyRecord] = await db.select().from(crmRecords).where(eq(crmRecords.remoteId, "3"));
  check("its lead converted, pointing at the contact", ivyAfter?.status === "converted" && ivyAfter?.contactId === ivyRecord?.contactId && ivyAfter?.contactId !== null);

  console.log("\nthe cap");
  const capped = await openIngestContext(USER, { source: "hubspot", createsContacts: true, reportResolutions: true });
  capped.headroom = 0;
  const page3 = await persistCrmPage(capped, "hubspot", [person({ remoteId: "5", displayName: "Over Cap", email: "over@cap.test", lifecycle: "customer", stage: "customer" })]);
  const [overCap] = await db.select().from(crmRecords).where(eq(crmRecords.remoteId, "5"));
  check("a refused customer is counted and marked", page3.blocked === 1 && overCap?.linkBlockedAt !== null && overCap?.contactId === null);

  console.log("\nthe guard");
  const wrong = await openIngestContext(USER, { source: "hubspot", createsContacts: true });
  let threw = false;
  try {
    await persistCrmPage(wrong, "hubspot", []);
  } catch {
    threw = true;
  }
  check("a context without resolutions is refused", threw);

  console.log("\nthe pipeline shows where a CRM lead lives");
  const pipeline = await loadPipeline(USER);
  const graceRow = pipeline.rows.find((r: { lead: Lead }) => r.lead.id === manual.id);
  check("a CRM-tied lead carries its record link", graceRow?.crm?.label === "HubSpot" && graceRow.crm.url === "https://app.hubspot.com/contacts/1/record/0-1/2", JSON.stringify(graceRow?.crm));
  const { lead: plain } = await saveLead(USER, { source: "manual", displayName: "No Crm" });
  check("a lead with no CRM record has none", (await loadPipeline(USER)).rows.find((r) => r.lead.id === plain.id)?.crm === null);

  await reset();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll CRM lead checks passed.");
});
```

Register `"smoke-crm-leads": "pglite",` in `MANIFEST`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/run-smoke.ts --only smoke-crm-leads`
Expected: FAIL — `../src/lib/crm/crm-leads-plan` not found.

- [ ] **Step 3: Implement the planner**

Create `src/lib/crm/crm-leads-plan.ts`:

```ts
/**
 * Where a CRM page's people land in the Leads pipeline — pure, so the matching rules are a
 * table of cases (scripts/smoke-crm-leads.ts) rather than a database fixture.
 *
 *  1. A record already tied to a lead (`crm_record_id`) updates that lead.
 *  2. Otherwise an untied lead sharing an identifier (P3's dedupe keys) adopts the record: a
 *     manual or Apollo target that later appears in the CRM is one lead, not two.
 *  3. Otherwise a lead/other record becomes a new `source = 'crm'` lead. A customer creates no
 *     lead — customers become contacts.
 *  4. Updates only fill blanks, raw and normalised columns together, and never touch status: a
 *     lead the user dismissed stays dismissed however often the CRM edits the record.
 *  5. A customer with a contact converts the lead it matched when that lead is still open or
 *     intro-asked. A cap-refused customer (no contact yet) only attaches its record.
 *  6. Each existing lead is claimed by at most one record per page.
 */
import type { CrmLifecycle, Lead } from "@/db/schema";
import { normalizeLeadInput, type NormalizedLead } from "@/lib/leads/lead-identity";

export type CrmLeadRecord = {
  id: string;
  lifecycle: CrmLifecycle;
  contactId: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  companyName: string | null;
  title: string | null;
};

export type ExistingLead = Pick<
  Lead,
  | "id"
  | "crmRecordId"
  | "status"
  | "contactId"
  | "email"
  | "emailNormalized"
  | "linkedinUrl"
  | "linkedinSlug"
  | "phone"
  | "phoneE164"
  | "companyName"
  | "companyNormalized"
  | "title"
>;

export type CrmLeadFill = { leadId: string; crmRecordId: string } & Partial<NormalizedLead>;

export type CrmLeadPlan = {
  inserts: Array<{ crmRecordId: string } & NormalizedLead>;
  fills: CrmLeadFill[];
  conversions: Array<{ leadId: string; crmRecordId: string; contactId: string }>;
};

type PairKey = keyof NormalizedLead & keyof ExistingLead;

/** P3's rule: fill a pair only when the RAW column is blank, and always fill both halves. */
function fillPair<Raw extends PairKey, Derived extends PairKey>(
  fill: Partial<NormalizedLead>,
  existing: ExistingLead,
  normalized: NormalizedLead,
  raw: Raw,
  derived: Derived
): boolean {
  if (existing[raw] == null && normalized[raw] != null) {
    fill[raw] = normalized[raw];
    fill[derived] = normalized[derived];
    return true;
  }
  return false;
}

export function planCrmLeads(records: CrmLeadRecord[], existing: ExistingLead[]): CrmLeadPlan {
  const plan: CrmLeadPlan = { inserts: [], fills: [], conversions: [] };
  const byRecord = new Map(existing.filter((l) => l.crmRecordId).map((l) => [l.crmRecordId as string, l]));
  const untied = existing.filter((l) => !l.crmRecordId);
  const claimed = new Set<string>();

  const matchUntied = (n: NormalizedLead) =>
    untied.find(
      (l) =>
        !claimed.has(l.id) &&
        ((n.emailNormalized !== null && l.emailNormalized === n.emailNormalized) ||
          (n.linkedinSlug !== null && l.linkedinSlug === n.linkedinSlug) ||
          (n.phoneE164 !== null && l.phoneE164 === n.phoneE164))
    );

  for (const record of records) {
    const normalized = normalizeLeadInput({
      displayName: record.displayName,
      email: record.email,
      linkedinUrl: record.linkedinUrl,
      phone: record.phone,
      companyName: record.companyName,
      title: record.title,
    });
    const tied = byRecord.get(record.id);
    const match = tied && !claimed.has(tied.id) ? tied : matchUntied(normalized);
    if (match) claimed.add(match.id);

    if (record.lifecycle === "customer") {
      if (!match) continue;
      const open = match.status === "open" || match.status === "intro_requested";
      if (record.contactId && open && !match.contactId) {
        plan.conversions.push({ leadId: match.id, crmRecordId: record.id, contactId: record.contactId });
      } else if (match.crmRecordId !== record.id) {
        plan.fills.push({ leadId: match.id, crmRecordId: record.id });
      }
      continue;
    }

    if (!match) {
      if (normalized.displayName) plan.inserts.push({ crmRecordId: record.id, ...normalized });
      continue;
    }
    const fill: CrmLeadFill = { leadId: match.id, crmRecordId: record.id };
    let changed = match.crmRecordId !== record.id;
    changed = fillPair(fill, match, normalized, "email", "emailNormalized") || changed;
    changed = fillPair(fill, match, normalized, "linkedinUrl", "linkedinSlug") || changed;
    changed = fillPair(fill, match, normalized, "phone", "phoneE164") || changed;
    changed = fillPair(fill, match, normalized, "companyName", "companyNormalized") || changed;
    if (match.title == null && normalized.title != null) {
      fill.title = normalized.title;
      changed = true;
    }
    if (changed) plan.fills.push(fill);
  }
  return plan;
}
```

- [ ] **Step 4: Implement the writer**

Create `src/lib/leads/crm-leads.ts`:

```ts
/**
 * CRM records into the Leads pipeline, by the rules in `src/lib/crm/crm-leads-plan.ts`. At
 * most four statements a page — one read, one insert, one bulk fill, one bulk convert — and
 * every one scoped to the owner's `user_id`, including the VALUES-list UPDATEs.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { leads } from "@/db/schema";
import { planCrmLeads, type CrmLeadFill, type CrmLeadRecord } from "@/lib/crm/crm-leads-plan";
import { normalizeLeadInput } from "./lead-identity";

const unique = (values: Array<string | null>) => [...new Set(values.filter((v): v is string => Boolean(v)))];

export async function syncCrmLeads(
  userId: string,
  records: CrmLeadRecord[]
): Promise<{ created: number; updated: number; converted: number }> {
  if (records.length === 0) return { created: 0, updated: 0, converted: 0 };
  const normalized = records.map((r) =>
    normalizeLeadInput({ displayName: r.displayName, email: r.email, linkedinUrl: r.linkedinUrl, phone: r.phone })
  );
  const identity: SQL[] = [];
  const emails = unique(normalized.map((n) => n.emailNormalized));
  const slugs = unique(normalized.map((n) => n.linkedinSlug));
  const phones = unique(normalized.map((n) => n.phoneE164));
  if (emails.length) identity.push(inArray(leads.emailNormalized, emails));
  if (slugs.length) identity.push(inArray(leads.linkedinSlug, slugs));
  if (phones.length) identity.push(inArray(leads.phoneE164, phones));

  const db = await getDb();
  const existing = await db
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.userId, userId),
        or(
          inArray(leads.crmRecordId, records.map((r) => r.id)),
          identity.length ? and(isNull(leads.crmRecordId), or(...identity)) : undefined
        )
      )
    );

  const plan = planCrmLeads(records, existing);
  let created = 0;
  if (plan.inserts.length) {
    const rows = await db
      .insert(leads)
      .values(plan.inserts.map((i) => ({ userId, source: "crm" as const, ...i })))
      .returning();
    created = rows.length;
  }
  if (plan.fills.length) await applyFills(userId, plan.fills);
  if (plan.conversions.length) {
    const rows = sql.join(
      plan.conversions.map((c) => sql`(${c.leadId}::uuid, ${c.crmRecordId}::uuid, ${c.contactId}::uuid)`),
      sql`, `
    );
    await db.execute(sql`
      UPDATE leads AS l
         SET crm_record_id = v.crm_record_id, contact_id = v.contact_id, status = 'converted', updated_at = now()
        FROM (VALUES ${rows}) AS v(id, crm_record_id, contact_id)
       WHERE l.id = v.id AND l.user_id = ${userId} AND l.status IN ('open', 'intro_requested')
    `);
  }
  return { created, updated: plan.fills.length, converted: plan.conversions.length };
}

/** A NULL in the VALUES row means "nothing to fill"; the CASEs gate each pair on its raw column. */
async function applyFills(userId: string, fills: CrmLeadFill[]): Promise<void> {
  const db = await getDb();
  const rows = sql.join(
    fills.map(
      (f) => sql`(${f.leadId}::uuid, ${f.crmRecordId}::uuid, ${f.email ?? null}::text, ${f.emailNormalized ?? null}::text,
        ${f.linkedinUrl ?? null}::text, ${f.linkedinSlug ?? null}::text, ${f.phone ?? null}::text, ${f.phoneE164 ?? null}::text,
        ${f.companyName ?? null}::text, ${f.companyNormalized ?? null}::text, ${f.title ?? null}::text)`
    ),
    sql`, `
  );
  await db.execute(sql`
    UPDATE leads AS l
       SET crm_record_id = v.crm_record_id,
           email = CASE WHEN l.email IS NULL THEN v.email ELSE l.email END,
           email_normalized = CASE WHEN l.email IS NULL THEN v.email_normalized ELSE l.email_normalized END,
           linkedin_url = CASE WHEN l.linkedin_url IS NULL THEN v.linkedin_url ELSE l.linkedin_url END,
           linkedin_slug = CASE WHEN l.linkedin_url IS NULL THEN v.linkedin_slug ELSE l.linkedin_slug END,
           phone = CASE WHEN l.phone IS NULL THEN v.phone ELSE l.phone END,
           phone_e164 = CASE WHEN l.phone IS NULL THEN v.phone_e164 ELSE l.phone_e164 END,
           company_name = CASE WHEN l.company_name IS NULL THEN v.company_name ELSE l.company_name END,
           company_normalized = CASE WHEN l.company_name IS NULL THEN v.company_normalized ELSE l.company_normalized END,
           title = COALESCE(l.title, v.title),
           updated_at = now()
      FROM (VALUES ${rows}) AS v(id, crm_record_id, email, email_normalized, linkedin_url, linkedin_slug, phone, phone_e164, company_name, company_normalized, title)
     WHERE l.id = v.id AND l.user_id = ${userId}
  `);
}
```

- [ ] **Step 5: Implement the page write**

Create `src/lib/crm/persist.ts`:

```ts
/**
 * One page of CRM people into Orbit — the write path every CRM connector shares:
 *
 *   1. upsert the page into `crm_records` (one statement);
 *   2. customers not yet linked go through `ingestPeople` — matched to an existing contact or
 *      created (the plan's cap applies) — and are linked; a refused one is marked blocked;
 *   3. everyone goes through `syncCrmLeads`: leads/others join the pipeline, and a customer
 *      converts the lead it used to be.
 *
 * A customer already linked to a live contact is not re-ingested (Ruling 6): its record row
 * still updates, but re-matching could create a duplicate when the person's email changed in
 * Orbit since.
 */
import type { CrmRecord } from "@/db/schema";
import type { CrmLeadRecord } from "@/lib/crm/crm-leads-plan";
import { linkCrmRecords, markCrmLinksBlocked, upsertCrmRecords } from "@/lib/crm/records";
import type { CrmPerson } from "@/lib/crm/types";
import type { IngestContext } from "@/lib/ingest/events";
import { ingestPeople, type PersonRecord } from "@/lib/ingest/people";
import { syncCrmLeads } from "@/lib/leads/crm-leads";

export type CrmPageStats = {
  records: number;
  customers: number;
  contactsCreated: number;
  contactsMatched: number;
  blocked: number;
  leadsCreated: number;
  leadsUpdated: number;
  leadsConverted: number;
};

function toPerson(record: CrmRecord): PersonRecord {
  return {
    fullName: record.displayName,
    email: record.email,
    phone: record.phone,
    linkedinUrl: record.linkedinUrl,
    company: record.companyName,
    title: record.title,
  };
}

export async function persistCrmPage(
  ctx: IngestContext,
  connectorId: string,
  people: CrmPerson[],
  now: Date = new Date()
): Promise<CrmPageStats> {
  if (!ctx.options.reportResolutions || !ctx.options.createsContacts) {
    throw new Error("persistCrmPage needs an ingest context opened with createsContacts and reportResolutions");
  }
  const rows = await upsertCrmRecords(ctx.userId, connectorId, people, now);
  const customers = rows.filter((r) => r.lifecycle === "customer");
  const unlinked = customers.filter((r) => !r.contactId);

  const stats: CrmPageStats = {
    records: rows.length,
    customers: customers.length,
    contactsCreated: 0,
    contactsMatched: 0,
    blocked: 0,
    leadsCreated: 0,
    leadsUpdated: 0,
    leadsConverted: 0,
  };

  const linked = new Map<string, string>();
  if (unlinked.length) {
    const result = await ingestPeople(ctx, unlinked.map(toPerson));
    stats.contactsCreated = result.created;
    stats.contactsMatched = result.matched;
    const byIndex = new Map((result.resolutions ?? []).map((r) => [r.index, r.contactId]));
    const blocked: string[] = [];
    unlinked.forEach((record, i) => {
      const contactId = byIndex.get(i);
      if (contactId) linked.set(record.id, contactId);
      else blocked.push(record.id);
    });
    await linkCrmRecords(ctx.userId, [...linked].map(([recordId, contactId]) => ({ recordId, contactId })), now);
    await markCrmLinksBlocked(ctx.userId, blocked, now);
    stats.blocked = blocked.length;
  }

  const leadRecords: CrmLeadRecord[] = rows.map((r) => ({
    id: r.id,
    lifecycle: r.lifecycle,
    contactId: r.contactId ?? linked.get(r.id) ?? null,
    displayName: r.displayName,
    email: r.email,
    phone: r.phone,
    linkedinUrl: r.linkedinUrl,
    companyName: r.companyName,
    title: r.title,
  }));
  const leadStats = await syncCrmLeads(ctx.userId, leadRecords);
  stats.leadsCreated = leadStats.created;
  stats.leadsUpdated = leadStats.updated;
  stats.leadsConverted = leadStats.converted;
  return stats;
}
```

- [ ] **Step 6: The pipeline carries the record link**

`src/lib/leads/pipeline.ts`: import `crmRecordLinks` from `@/lib/crm/records` and `connectorById` from `@/lib/connectors/registry`; change the row type and fill it with ONE extra statement, only when some lead is CRM-tied:

```ts
/** `crm` is where the lead lives in the CRM it came from, when it came from one. */
export type PipelineRow = { lead: Lead; path: WarmPath | null; crm: { label: string; url: string } | null };
```

In `loadPipeline`, after `const list = await listLeads(userId, opts);`:

```ts
  const tied = list.flatMap((lead) => (lead.crmRecordId ? [lead.crmRecordId] : []));
  const links = tied.length ? await crmRecordLinks(userId, tied) : new Map<string, { connectorId: string; remoteUrl: string | null }>();
  const crmFor = (lead: Lead): PipelineRow["crm"] => {
    const link = lead.crmRecordId ? links.get(lead.crmRecordId) : undefined;
    if (!link?.remoteUrl) return null;
    return { label: connectorById(link.connectorId)?.label ?? "your CRM", url: link.remoteUrl };
  };
```

and build every row as `{ lead, path: …, crm: crmFor(lead) }` (both the non-ok branch and the ranked branch). Update the file's header comment: "One read of the leads, one read of their CRM links when any are CRM-tied, and at most two warm-path statements however long the list."

Update any other place that constructs a `PipelineRow` literal (grep `path: null` and `PipelineRow` under `src/` and `scripts/`; `scripts/smoke-leads-page.ts` renders rows — add `crm: null` to its fixtures).

- [ ] **Step 7: Run to verify it passes**

Run: `npx tsc --noEmit -p . > /tmp/p4-t9-tsc.txt 2>&1; echo tsc=$?` then `npx tsx scripts/run-smoke.ts --check && npx tsx scripts/run-smoke.ts --only smoke-crm-leads smoke-crm-records smoke-leads smoke-leads-page smoke-ingest-people`
Expected: `tsc=0`; `5/5 passed`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/crm/crm-leads-plan.ts src/lib/leads/crm-leads.ts src/lib/crm/persist.ts src/lib/leads/pipeline.ts scripts/smoke-crm-leads.ts scripts/smoke-leads-page.ts scripts/run-smoke.ts
git commit -m "Land a CRM page in Orbit: customers become linked contacts, leads join and merge into the pipeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: The HubSpot sync — registered, available, and reporting status

**Files:**
- Create: `src/lib/crm/hubspot/sync.ts`
- Modify: `src/lib/connectors/syncs.ts` (register `hubspot`)
- Modify: `src/lib/connectors/registry.ts` (HubSpot → `available`, capabilities = what it really does)
- Modify: `src/lib/connectors/status.ts` (`"hubspot"`), `src/actions/integrations.ts` (its lookup)
- Test: `scripts/smoke-crm-sync.ts` (new, pglite) + `MANIFEST` `"smoke-crm-sync": "pglite",`; `scripts/smoke-integration-statuses.ts`; `scripts/smoke-connector-registry.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 3, 5–9. `getEntitlements` (`@/lib/entitlements`).
- Produces (from `@/lib/crm/hubspot/sync`):
  - `HUBSPOT_SYNC_BUDGET_MS = 45_000` (inside the scheduler's 60 s per-connection share)
  - `type HubspotSyncDeps = { fetchImpl?: typeof fetch; now?: () => Date; budgetMs?: number; auth?: ConnectorAuthDeps }`
  - `type HubspotSyncResult = { outcome: "complete" | "partial" | "needs_reauth" | "stopped"; pages: number; records: number; contactsCreated: number; leadsCreated: number; blocked: number; message?: string }`
  - `syncHubspot(conn: ClaimedConnectorConnection, deps?: HubspotSyncDeps): Promise<HubspotSyncResult>`

What `syncHubspot` does, in order (each is a smoke check):
1. `getEntitlements(conn.userId).canUseCrm` false → disarm with "HubSpot sync is on Orbit Pro and Lifetime — upgrade to keep it running" (non-retryable `markConnectorSyncResult`), outcome `stopped`. A downgraded account's connection stops; nothing is deleted.
2. Identity from `conn.cursor.meta` (`portalId`, `ownerId`). If missing — or `portalId` differs from `conn.accountRef` (reconnected to another HubSpot account) — introspect the token and look up the owner; start a fresh window; save the cursor at once. No owner → disarm with the no-owner message, outcome `stopped`.
3. Open ONE ingest context (`source: "hubspot"`, `createsContacts: true`, `reportResolutions: true`) for the whole run; `finalizeIngest` in a `finally`.
4. Page while the budget lasts: search → `mapHubspotContact` → `persistCrmPage` → `advanceWindow` (its `maxModified` is the newest `lastmodifieddate` among the RAW results, so a page of skipped records still moves the window) → `saveConnectorCursor` after every page.
5. Done → `markConnectorSyncResult(ok, cursor)` (default 30-minute cadence), outcome `complete`. Budget ran out first → `markConnectorSyncResult(ok, cursor, nextSyncAt: now)`, outcome `partial` — due again on the next pass, resuming at the saved page.
6. `ConnectorNeedsReauthError` → return outcome `needs_reauth` (the row is already resolved). A non-retryable `HubspotApiError` (403, 404, other 4xx) → disarm with its message, outcome `stopped`. Anything else (429, 5xx, network) → rethrow: the scheduler records a retryable failure, and the page cursor saved so far survives it.

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-crm-sync.ts`:

```ts
/**
 * The HubSpot sync end to end against a scripted HubSpot: identify the owner, page the owned
 * contacts, write them through `persistCrmPage`, and record progress so a run cut short
 * resumes where it stopped. Every outcome the scheduler depends on is pinned here.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
process.env.HUBSPOT_CLIENT_ID = "cid";
process.env.HUBSPOT_CLIENT_SECRET = "csecret";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections, contacts, crmRecords, leads, userSettings } from "../src/db/schema";
import {
  claimConnectorConnectionForUser,
  upsertConnectorConnection,
} from "../src/lib/connectors/connections";
import { resolveConnectorWithSync } from "../src/lib/connectors/syncs";
import { syncHubspot } from "../src/lib/crm/hubspot/sync";
import { ensureUserSettings } from "../src/lib/user-settings";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-crm-sync";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function contact(id: string, first: string, email: string, stage: string | null, modified: string) {
  return {
    id,
    properties: { firstname: first, lastname: "Test", email, lifecyclestage: stage, hubspot_owner_id: "77", lastmodifieddate: modified },
  };
}

/** A HubSpot with owner 77 and the given pages of search results, answered in order. */
function hubspot(
  pages: Array<{ results: unknown[]; after: string | null } | "429" | "403">,
  opts: { onSearch?: () => void } = {}
) {
  const searches: Array<Record<string, unknown>> = [];
  let introspections = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/token/introspect")) {
      introspections++;
      return json(200, { active: true, hub_id: 4242, hub_domain: "acme.hubspot.com", user_id: 9, user: "sam@acme.test" });
    }
    if (url.includes("/crm/owners/2026-09/9?idProperty=userId")) return json(200, { id: "77" });
    if (url.endsWith("/contacts/search")) {
      searches.push(JSON.parse(String(init?.body)));
      opts.onSearch?.();
      const next = pages.shift();
      if (!next) return json(200, { total: 0, results: [] });
      if (next === "429") return json(429, { errorType: "RATE_LIMIT" });
      if (next === "403") return json(403, { message: "missing scopes" });
      return json(200, { total: 999, results: next.results, ...(next.after ? { paging: { next: { after: next.after } } } : {}) });
    }
    throw new Error(`unscripted ${url}`);
  }) as typeof fetch;
  return { impl, searches, introspections: () => introspections };
}

async function connect() {
  await upsertConnectorConnection({
    userId: USER,
    connectorId: "hubspot",
    authKind: "oauth2",
    label: "acme.hubspot.com",
    accountRef: "4242",
    accessToken: "access",
    refreshToken: "refresh",
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    nextSyncAt: null,
  });
}

async function claim() {
  const conn = await claimConnectorConnectionForUser(USER, "hubspot");
  if (!conn) throw new Error("setup: could not claim");
  return conn;
}

async function row() {
  const db = await getDb();
  const [r] = await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER));
  return r;
}

async function reset() {
  const db = await getDb();
  for (const table of [leads, crmRecords, contacts, connectorConnections]) {
    await db.delete(table).where(eq(table.userId, USER));
  }
}

run(async () => {
  await reset();
  const db = await getDb();
  // A paid plan: `crm` is a paid entitlement and the sync checks it every run. Comped the way
  // scripts/smoke-entitlements.ts comps an account.
  await ensureUserSettings(USER);
  await db.update(userSettings).set({ compedPlan: "lifetime" }).where(eq(userSettings.userId, USER));

  console.log("registration");
  check("HubSpot is available", resolveConnectorWithSync("hubspot")?.availability === "available");
  check("and resolves with a sync", typeof resolveConnectorWithSync("hubspot")?.sync === "function");

  console.log("\na first run: identify, then page to the end");
  await connect();
  const first = hubspot([
    { results: [contact("1", "Dana", "dana@acme.test", "customer", "2026-09-01T00:00:00.000Z"), contact("2", "Grace", "grace@beta.test", "lead", "2026-09-02T00:00:00.000Z")], after: "100" },
    { results: [contact("3", "Ivy", "ivy@gamma.test", null, "2026-09-03T00:00:00.000Z")], after: null },
  ]);
  const r1 = await syncHubspot(await claim(), { fetchImpl: first.impl });
  check("complete", r1.outcome === "complete" && r1.pages === 2, JSON.stringify(r1));
  check("introspected once", first.introspections() === 1);
  const filters1 = (first.searches[0]?.filterGroups as Array<{ filters: Array<{ propertyName: string; value: string }> }>)[0].filters;
  check("searched the owner's contacts", filters1[0]?.propertyName === "hubspot_owner_id" && filters1[0]?.value === "77");
  check("the first run is a full read (no since)", filters1.length === 1);
  check("the second page carried after", first.searches[1]?.after === "100");
  const records = await db.select().from(crmRecords).where(eq(crmRecords.userId, USER));
  check("three records stored", records.length === 3, String(records.length));
  check("the customer became a linked contact", records.find((r) => r.remoteId === "1")?.contactId !== null);
  const pipeline = await db.select().from(leads).where(eq(leads.userId, USER));
  check("the lead and the no-stage record joined the pipeline", pipeline.length === 2 && pipeline.every((l) => l.source === "crm"), String(pipeline.length));
  const after1 = await row();
  check("the row is idle and re-armed on the normal cadence", after1?.syncStatus === "idle" && (after1?.nextSyncAt?.getTime() ?? 0) > Date.now() + 20 * 60_000);
  check("the cursor holds the identity", after1?.syncCursor?.meta?.portalId === "4242" && after1?.syncCursor?.meta?.ownerId === "77");
  check("…and the watermark is the newest modified time", after1?.syncCursor?.syncedThrough === "2026-09-03T00:00:00.000Z", String(after1?.syncCursor?.syncedThrough));
  check("…and the full read is stamped", Boolean(after1?.syncCursor?.meta?.fullSyncedAt));

  console.log("\nthe next run is incremental, and re-uses the identity");
  const second = hubspot([{ results: [contact("2", "Grace", "grace@beta.test", "customer", "2026-09-04T00:00:00.000Z")], after: null }]);
  const r2 = await syncHubspot(await claim(), { fetchImpl: second.impl });
  check("complete", r2.outcome === "complete", JSON.stringify(r2));
  check("no second introspection", second.introspections() === 0);
  const filters2 = (second.searches[0]?.filterGroups as Array<{ filters: Array<{ propertyName: string; operator: string; value: string }> }>)[0].filters;
  check("filtered on lastmodifieddate >= the watermark", filters2[1]?.propertyName === "lastmodifieddate" && filters2[1]?.operator === "GTE" && filters2[1]?.value === String(Date.parse("2026-09-03T00:00:00.000Z")));
  const graceLead = (await db.select().from(leads).where(eq(leads.userId, USER))).find((l) => l.emailNormalized === "grace@beta.test");
  check("a lead that became a customer converted", graceLead?.status === "converted" && graceLead?.contactId !== null);

  console.log("\na run that runs out of budget saves its page and comes back");
  await db.update(connectorConnections).set({ syncCursor: null }).where(eq(connectorConnections.userId, USER));
  // Each search "takes" 1.2 s of a 1 s budget: one page fits, the second does not start.
  let clock = Date.now();
  let ticking = true;
  const slow = hubspot(
    [
      { results: [contact("5", "Page", "p1@x.test", "lead", "2026-09-05T00:00:00.000Z")], after: "100" },
      { results: [contact("6", "Page", "p2@x.test", "lead", "2026-09-06T00:00:00.000Z")], after: null },
    ],
    { onSearch: () => {
      if (ticking) clock += 1_200;
    } }
  );
  const r3 = await syncHubspot(await claim(), {
    fetchImpl: slow.impl,
    budgetMs: 1_000,
    now: () => new Date(clock),
  });
  ticking = false;
  check("partial after one page", r3.outcome === "partial" && r3.pages === 1, JSON.stringify(r3));
  const after3 = await row();
  check("due again now", (after3?.nextSyncAt?.getTime() ?? Infinity) <= Date.now() + 5_000);
  check("resuming at the next page", after3?.syncCursor?.cursor === "100");
  const r4 = await syncHubspot(await claim(), { fetchImpl: slow.impl });
  check("the next run finishes it", r4.outcome === "complete" && slow.searches[1]?.after === "100", JSON.stringify(r4));

  console.log("\na 429 mid-run: retryable, progress kept");
  await db.update(connectorConnections).set({ syncCursor: null }).where(eq(connectorConnections.userId, USER));
  const limited = hubspot([{ results: [contact("7", "Rate", "r@x.test", "lead", "2026-09-07T00:00:00.000Z")], after: "100" }, "429"]);
  let thrown: unknown = null;
  try {
    await syncHubspot(await claim(), { fetchImpl: limited.impl });
  } catch (err) {
    thrown = err;
  }
  check("the 429 propagates for the scheduler to back off", thrown !== null && (thrown as { retryable?: boolean }).retryable === true, String(thrown));
  check("the first page's cursor survived", (await row())?.syncCursor?.cursor === "100");
  await db.update(connectorConnections).set({ syncStatus: "idle" }).where(eq(connectorConnections.userId, USER));

  console.log("\na 403: stop and say why");
  const forbidden = hubspot(["403"]);
  const r5 = await syncHubspot(await claim(), { fetchImpl: forbidden.impl });
  const after5 = await row();
  check("stopped", r5.outcome === "stopped", JSON.stringify(r5));
  check("disarmed with HubSpot's reason in the house voice", after5?.nextSyncAt === null && (after5?.syncError ?? "").includes("reconnect HubSpot"), String(after5?.syncError));

  console.log("\na reconnect to another HubSpot account starts over");
  await db
    .update(connectorConnections)
    .set({ accountRef: "999", syncStatus: "idle", nextSyncAt: new Date() })
    .where(eq(connectorConnections.userId, USER));
  const other = hubspot([]);
  await syncHubspot(await claim(), { fetchImpl: other.impl });
  check("it re-identified", other.introspections() === 1);
  await db.update(connectorConnections).set({ accountRef: "4242", syncStatus: "idle" }).where(eq(connectorConnections.userId, USER));

  console.log("\na downgraded account stops syncing");
  await db.update(userSettings).set({ compedPlan: null }).where(eq(userSettings.userId, USER));
  const unpaid = hubspot([]);
  const r6 = await syncHubspot(await claim(), { fetchImpl: unpaid.impl });
  check("stopped without calling HubSpot", r6.outcome === "stopped" && unpaid.searches.length === 0 && unpaid.introspections() === 0);
  check("with the upgrade message", ((await row())?.syncError ?? "").includes("Orbit Pro and Lifetime"));
  check("and nothing was deleted", (await db.select().from(crmRecords).where(eq(crmRecords.userId, USER))).length > 0);

  await reset();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll CRM sync checks passed.");
});
```

Register `"smoke-crm-sync": "pglite",` in `MANIFEST`. (`ensureUserSettings` is imported from wherever `scripts/smoke-entitlements.ts` imports it — copy that import line exactly if the path above differs.)

In `scripts/smoke-integration-statuses.ts`: add `"connector_connections"` to the `cleanup` table list; seed

```ts
  await db.execute(sql`
    INSERT INTO connector_connections (user_id, connector_id, auth_kind, label, status)
    VALUES (${USER}, 'hubspot', 'oauth2', 'acme.hubspot.com', 'active')
  `);
```

and add `hubspot: "acme.hubspot.com",` to `EXPECTED`.

In `scripts/smoke-connector-registry.ts`, append:

```ts
check(
  "HubSpot's syncPeople asks for exactly the scopes the sync uses",
  JSON.stringify(connectorById("hubspot")?.capabilities.find((c) => c.id === "syncPeople")?.scopes) === JSON.stringify([...HUBSPOT_SCOPES])
);
check(
  "HubSpot lists only what P4 really does (reads people)",
  JSON.stringify(connectorById("hubspot")?.capabilities.map((c) => c.id)) === JSON.stringify(["syncPeople"])
);
```

with `import { HUBSPOT_SCOPES } from "../src/lib/crm/hubspot/mapping";`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/run-smoke.ts --only smoke-crm-sync smoke-integration-statuses smoke-connector-registry`
Expected: FAIL — `../src/lib/crm/hubspot/sync` not found; the statuses smoke reports `hubspot` missing its lookup.

- [ ] **Step 3: Implement the sync**

Create `src/lib/crm/hubspot/sync.ts`:

```ts
/**
 * One HubSpot sync run for one claimed connection: the contacts the person who connected
 * OWNS in HubSpot (an account-level token reads the whole portal, so the owner filter is
 * ours to apply), customers into contacts, everyone else into the Leads pipeline.
 *
 * It records its own outcome — the contract on `ConnectorManifest.sync`: a cursor after every
 * page (so a run killed at its time limit resumes at the next page), and the run's end. What
 * it throws is retryable by construction; everything the person has to act on is resolved on
 * the row before it returns.
 */
import type { ClaimedConnectorConnection } from "@/lib/connectors/connections";
import { markConnectorSyncResult, saveConnectorCursor } from "@/lib/connectors/connections";
import { ConnectorNeedsReauthError } from "@/lib/connectors/auth-errors";
import { openConnectorAuth, type ConnectorAuthDeps } from "@/lib/connectors/token";
import { persistCrmPage } from "@/lib/crm/persist";
import type { CrmPerson } from "@/lib/crm/types";
import { getEntitlements } from "@/lib/entitlements";
import { finalizeIngest, openIngestContext } from "@/lib/ingest/events";
import { HubspotApiError, findHubspotOwner, introspectHubspotToken, searchHubspotContacts } from "./api";
import {
  advanceWindow,
  buildContactSearchBody,
  cursorFromWindow,
  identityFromCursor,
  mapHubspotContact,
  parseHubspotDate,
  windowFromCursor,
  type HubspotIdentity,
} from "./mapping";

/** Inside the scheduler's 60 s per-connection share, with room to record the result. */
export const HUBSPOT_SYNC_BUDGET_MS = 45_000;

export type HubspotSyncDeps = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  budgetMs?: number;
  auth?: ConnectorAuthDeps;
};

export type HubspotSyncResult = {
  outcome: "complete" | "partial" | "needs_reauth" | "stopped";
  pages: number;
  records: number;
  contactsCreated: number;
  leadsCreated: number;
  blocked: number;
  message?: string;
};

const NOT_ENTITLED = "HubSpot sync is on Orbit Pro and Lifetime — upgrade to keep it running";
const NO_OWNER =
  "HubSpot has no owner record for the person who connected, so no contacts are assigned to you — ask a HubSpot admin to add you as a user, then sync again";

export async function syncHubspot(
  conn: ClaimedConnectorConnection,
  deps: HubspotSyncDeps = {}
): Promise<HubspotSyncResult> {
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const budget = deps.budgetMs ?? HUBSPOT_SYNC_BUDGET_MS;
  const started = now().getTime();
  const result: HubspotSyncResult = { outcome: "complete", pages: 0, records: 0, contactsCreated: 0, leadsCreated: 0, blocked: 0 };

  const stop = async (message: string): Promise<HubspotSyncResult> => {
    await markConnectorSyncResult(conn.id, { ok: false, error: message, retryable: false });
    return { ...result, outcome: "stopped", message };
  };

  const entitlements = await getEntitlements(conn.userId);
  if (!entitlements.canUseCrm) return stop(NOT_ENTITLED);

  const auth = openConnectorAuth(conn, deps.auth);
  try {
    let identity: HubspotIdentity | null = identityFromCursor(conn.cursor);
    let cursor = conn.cursor;
    // Reconnected to a different HubSpot account: the old window describes someone else's data.
    if (identity && conn.accountRef && identity.portalId !== conn.accountRef) {
      identity = null;
      cursor = null;
    }
    if (!identity) {
      const info = await auth.call((token) => introspectHubspotToken(token, fetchImpl));
      const owner = await auth.call((token) =>
        findHubspotOwner(token, { userId: info.userId, email: info.userEmail }, fetchImpl)
      );
      if (!owner) return stop(NO_OWNER);
      identity = { portalId: info.hubId, ownerId: owner.id, ...(info.userId ? { hubUserId: info.userId } : {}) };
      cursor = null;
    }
    const who: HubspotIdentity = identity;

    let window = windowFromCursor(cursor, now());
    await saveConnectorCursor(conn.id, cursorFromWindow(window, who));

    const ctx = await openIngestContext(conn.userId, { source: "hubspot", createsContacts: true, reportResolutions: true });
    let done = false;
    try {
      while (now().getTime() - started < budget) {
        const page = await auth.call((token) =>
          searchHubspotContacts(token, buildContactSearchBody({ ownerId: who.ownerId, since: window.since, after: window.after }), fetchImpl)
        );
        const people = page.results
          .map((raw) => mapHubspotContact(raw, { portalId: who.portalId }))
          .filter((p): p is CrmPerson => p !== null);
        const stats = await persistCrmPage(ctx, "hubspot", people, now());
        result.pages++;
        result.records += stats.records;
        result.contactsCreated += stats.contactsCreated;
        result.leadsCreated += stats.leadsCreated;
        result.blocked += stats.blocked;

        // From the RAW results: a page of skipped (nameless, archived) records must still move
        // the window, or the next query would read the same page forever.
        let maxModified: string | null = null;
        for (const raw of page.results) {
          const at = parseHubspotDate(raw.properties?.lastmodifieddate ?? raw.updatedAt);
          if (at && (!maxModified || at.getTime() > Date.parse(maxModified))) maxModified = at.toISOString();
        }
        const step = advanceWindow(window, { maxModified, nextAfter: page.nextAfter }, now());
        window = step.window;
        await saveConnectorCursor(conn.id, cursorFromWindow(window, who));
        if (step.done) {
          done = true;
          break;
        }
      }
    } finally {
      await finalizeIngest(ctx);
    }

    await markConnectorSyncResult(conn.id, {
      ok: true,
      cursor: cursorFromWindow(window, who),
      ...(done ? {} : { nextSyncAt: now() }),
    });
    return { ...result, outcome: done ? "complete" : "partial" };
  } catch (err) {
    if (err instanceof ConnectorNeedsReauthError) return { ...result, outcome: "needs_reauth", message: err.message };
    if (err instanceof HubspotApiError && !err.retryable) return stop(err.message);
    throw err;
  }
}
```

- [ ] **Step 4: Register it and make HubSpot available**

`src/lib/connectors/syncs.ts`: `import { syncHubspot } from "@/lib/crm/hubspot/sync";` and

```ts
export const CONNECTOR_SYNCS: Partial<Record<ConnectorId, ConnectorSync>> = {
  hubspot: async (conn) => {
    await syncHubspot(conn);
  },
};
```

`src/lib/connectors/registry.ts`, the `hubspot` entry becomes:

```ts
  {
    id: "hubspot",
    label: "HubSpot",
    family: "crm",
    auth: "oauth2",
    availability: "available",
    entitlement: "crm",
    rateBucket: "providerSync",
    purgeCategory: "connections",
    // P4 reads people. Engagements and write-back (`logActivity`, `writeContact`) land in P6;
    // the registry lists what a connector really does. Scopes mirror `HUBSPOT_SCOPES` in
    // src/lib/crm/hubspot/mapping.ts (smoke-connector-registry compares them).
    capabilities: [
      read("syncPeople", "Read the contacts you own", ["crm.objects.contacts.read", "crm.objects.owners.read"]),
    ],
  },
```

`src/lib/connectors/status.ts`: add `"hubspot",` to `CONNECTOR_STATUS_LOOKUP_IDS`.

`src/actions/integrations.ts`: import `getConnectorConnection` from `@/lib/connectors/connections`; add a ninth lookup to the `Promise.all` destructure — `hubspot` — as `settle(requireUserId().then((id) => getConnectorConnection(id, "hubspot")))`; and before the back-fill loop:

```ts
  statuses.hubspot =
    hubspot === "unknown"
      ? "unknown"
      : hubspot === null
        ? { state: "off", detail: "Not connected" }
        : hubspot.status === "needs_reauth"
          ? { state: "partial", detail: "Reconnect needed" }
          : { state: "on", detail: hubspot.label ?? "Connected" };
```

(update the header comment's "nine lookups" count to ten).

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsc --noEmit -p . > /tmp/p4-t10-tsc.txt 2>&1; echo tsc=$?` then `npx tsx scripts/run-smoke.ts --check && npx tsx scripts/run-smoke.ts --only smoke-crm-sync smoke-integration-statuses smoke-connector-registry smoke-connector-sync-pass smoke-crm-leads smoke-hubspot-mapping`
Expected: `tsc=0`; `6/6 passed`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/crm/hubspot/sync.ts src/lib/connectors/syncs.ts src/lib/connectors/registry.ts src/lib/connectors/status.ts src/actions/integrations.ts scripts/smoke-crm-sync.ts scripts/smoke-integration-statuses.ts scripts/smoke-connector-registry.ts scripts/run-smoke.ts
git commit -m "Sync the HubSpot contacts you own: resumable paging, its own cursor, and every stop explained

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Connecting HubSpot — the authorize URL, the callback route, and what it stores

**Files:**
- Create: `src/lib/crm/connect.ts`
- Create: `src/app/api/connectors/[connectorId]/callback/route.ts`
- Modify: `src/lib/error-events.ts` (`ERROR_SOURCES.oauthConnectorCallback`)
- Modify: `.env.example` (a HubSpot block)
- Test: `scripts/smoke-crm-connect.ts` (new, pglite) + `MANIFEST` `"smoke-crm-connect": "pglite",`

**Interfaces:**
- Consumes: `buildAuthorizeUrl`, `exchangeCode`, `OAuthState` (oauth); `upsertConnectorConnection`, `getConnectorConnection` (connections); `introspectHubspotToken` (Task 7); `HUBSPOT_SCOPES` (Task 6); `deleteCrmRecordsForConnector` (Task 8); `getAppBaseUrl` (`@/lib/app-url`); `requireCrmUser` (Task 3).
- Produces (from `@/lib/crm/connect`):
  - `type CrmConnectorId = "hubspot"`, `isCrmConnectorId(id: string): id is CrmConnectorId`
  - `crmCallbackPath(id)`, `crmRedirectUri(id): string` (`HUBSPOT_REDIRECT_URI` when set, else `APP_BASE_URL`-derived — the Eventbrite rule)
  - `crmAuthorizeUrl(userId, id, returnTo): string`
  - `class CrmConnectError extends Error { kind: "state_mismatch" | "exchange_failed" | "identify_failed" }`
  - `completeCrmConnect({ sessionUserId, connectorId, code, state, fetchImpl? }): Promise<{ label: string | null; accountRef: string; switchedAccount: boolean }>`
- The route redirects to the state's `returnTo` (default `/leads`) with `crm=connected`, or `crm=error&reason=<access_denied | not_entitled | oauth_failed>` — a code, never an error message (the Eventbrite callback's rule: messages in URLs leak into history and logs).

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-crm-connect.ts`:

```ts
/**
 * Connecting a CRM: the authorize URL, and `completeCrmConnect` — the part of the callback
 * with the security properties. A validly-signed state is not enough: it must name the person
 * whose session is finishing the flow (see `OAuthState` in src/lib/connectors/oauth.ts).
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
process.env.HUBSPOT_CLIENT_ID = "cid";
process.env.HUBSPOT_CLIENT_SECRET = "csecret";
process.env.APP_BASE_URL = "https://orbit.test";
delete process.env.HUBSPOT_REDIRECT_URI;

import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections, crmRecords } from "../src/db/schema";
import { parseOAuthState } from "../src/lib/connectors/oauth";
import {
  CrmConnectError,
  completeCrmConnect,
  crmAuthorizeUrl,
  crmRedirectUri,
  isCrmConnectorId,
} from "../src/lib/crm/connect";
import { upsertCrmRecords } from "../src/lib/crm/records";
import { decryptOrNull } from "../src/lib/crypto";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-crm-connect";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function provider(hubId: number, opts: { exchange?: number } = {}) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/oauth/2026-09/token")) {
      if (opts.exchange && opts.exchange !== 200) return json(opts.exchange, { error: "invalid_grant", error_description: "bad code" });
      return json(200, { token_type: "bearer", access_token: "acc", refresh_token: "ref", expires_in: 1800, hub_id: hubId, scopes: ["crm.objects.contacts.read", "crm.objects.owners.read"] });
    }
    if (url.endsWith("/token/introspect")) return json(200, { active: true, hub_id: hubId, hub_domain: `portal-${hubId}.hubspot.com`, user_id: 9, user: "sam@acme.test" });
    throw new Error(`unscripted ${url}`);
  }) as typeof fetch;
}

async function caught(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
}

run(async () => {
  const db = await getDb();
  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
  await db.delete(crmRecords).where(eq(crmRecords.userId, USER));

  console.log("the authorize URL");
  check("hubspot is a CRM connector; notion is not", isCrmConnectorId("hubspot") && !isCrmConnectorId("notion"));
  check("the redirect is derived from APP_BASE_URL", crmRedirectUri("hubspot") === "https://orbit.test/api/connectors/hubspot/callback");
  process.env.HUBSPOT_REDIRECT_URI = "https://preview.orbit.test/api/connectors/hubspot/callback";
  check("HUBSPOT_REDIRECT_URI wins when set", crmRedirectUri("hubspot") === "https://preview.orbit.test/api/connectors/hubspot/callback");
  delete process.env.HUBSPOT_REDIRECT_URI;
  const url = new URL(crmAuthorizeUrl(USER, "hubspot", "/leads"));
  check("HubSpot's authorize endpoint", url.origin + url.pathname === "https://app.hubspot.com/oauth/authorize");
  check("the client id", url.searchParams.get("client_id") === "cid");
  check("the redirect", url.searchParams.get("redirect_uri") === "https://orbit.test/api/connectors/hubspot/callback");
  check("the app's required scopes, space-separated", url.searchParams.get("scope") === "crm.objects.contacts.read crm.objects.owners.read");
  const state = parseOAuthState(url.searchParams.get("state"));
  check("a signed state naming this user, connector and return path", state?.userId === USER && state?.connectorId === "hubspot" && state?.returnTo === "/leads", JSON.stringify(state));

  console.log("\ncompleting the connect");
  const done = await completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "c1", state: state!, fetchImpl: provider(4242) });
  check("reports the account", done.accountRef === "4242" && done.label === "portal-4242.hubspot.com" && !done.switchedAccount);
  const [row] = await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER));
  check("one oauth2 connection row", row?.connectorId === "hubspot" && row?.authKind === "oauth2");
  check("tokens stored encrypted", decryptOrNull(row?.accessTokenEncrypted ?? null) === "acc" && decryptOrNull(row?.refreshTokenEncrypted ?? null) === "ref");
  check("the 30-minute expiry", Math.abs((row?.tokenExpiresAt?.getTime() ?? 0) - (Date.now() + 1_800_000)) < 10_000);
  check("label and account", row?.label === "portal-4242.hubspot.com" && row?.accountRef === "4242");
  check("granted scopes", row?.scopes === "crm.objects.contacts.read crm.objects.owners.read");
  check("reads switched on", JSON.stringify(row?.capabilities) === JSON.stringify(["syncPeople"]));
  check("armed: the sync ships in the same change", row?.nextSyncAt !== null && row?.status === "active");

  console.log("\nthe state must name the person finishing the flow");
  const stolen = await caught(completeCrmConnect({ sessionUserId: "someone-else", connectorId: "hubspot", code: "c2", state: state!, fetchImpl: provider(4242) }));
  check("another session is refused", stolen instanceof CrmConnectError && stolen.kind === "state_mismatch");
  check("and nothing is written for them", (await db.select().from(connectorConnections).where(eq(connectorConnections.userId, "someone-else"))).length === 0);
  const crossed = await caught(completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "c3", state: { ...state!, connectorId: "salesforce" }, fetchImpl: provider(4242) }));
  check("a state minted for another connector is refused", crossed instanceof CrmConnectError && crossed.kind === "state_mismatch");
  const badCode = await caught(completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "bad", state: state!, fetchImpl: provider(4242, { exchange: 400 }) }));
  check("a refused code is an exchange failure", badCode instanceof CrmConnectError && badCode.kind === "exchange_failed");

  console.log("\nreconnecting");
  await upsertCrmRecords(USER, "hubspot", [
    { remoteType: "contact", remoteId: "1", lifecycle: "lead", stage: null, displayName: "Kept", email: null, phone: null, linkedinUrl: null, companyName: null, companyDomain: null, title: null, remoteOwnerRef: null, remoteUrl: null, lastActivityAt: null, remoteCreatedAt: null, remoteUpdatedAt: null, properties: {} },
  ]);
  const same = await completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "c4", state: state!, fetchImpl: provider(4242) });
  check("the same account keeps its records", !same.switchedAccount && (await db.select().from(crmRecords).where(eq(crmRecords.userId, USER))).length === 1);
  const other = await completeCrmConnect({ sessionUserId: USER, connectorId: "hubspot", code: "c5", state: state!, fetchImpl: provider(999) });
  check("another account clears the old account's records", other.switchedAccount && (await db.select().from(crmRecords).where(eq(crmRecords.userId, USER))).length === 0);
  check("still one connection row", (await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER))).length === 1);

  console.log("\nthe route stays a thin shell");
  const route = readFileSync("src/app/api/connectors/[connectorId]/callback/route.ts", "utf8");
  check("awaits its params (Next 16)", /const \{ connectorId \} = await params/.test(route));
  check("parses the signed state", route.includes("parseOAuthState("));
  check("gates on the paid, released Leads surface", route.includes("requireCrmUser()"));
  check("hands the security-bearing part to completeCrmConnect", route.includes("completeCrmConnect("));
  check("never writes an error message into the URL", !/searchParams\.set\([^)]*message/.test(route) && !/searchParams\.set\([^)]*String\(err/.test(route));
  check("records the failure", route.includes("ERROR_SOURCES.oauthConnectorCallback"));

  await db.delete(connectorConnections).where(eq(connectorConnections.userId, USER));
  await db.delete(crmRecords).where(eq(crmRecords.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll CRM connect checks passed.");
});
```

Register `"smoke-crm-connect": "pglite",` in `MANIFEST`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/run-smoke.ts --only smoke-crm-connect`
Expected: FAIL — `../src/lib/crm/connect` not found.

- [ ] **Step 3: Implement the library half**

Create `src/lib/crm/connect.ts`:

```ts
/**
 * Connecting a CRM: where the Leads page sends a person, and what the OAuth callback does with
 * the code that comes back. The route handler is a thin shell over `completeCrmConnect`, so the
 * part with the security properties runs in a smoke.
 */
import { getAppBaseUrl } from "@/lib/app-url";
import { getConnectorConnection, upsertConnectorConnection } from "@/lib/connectors/connections";
import { buildAuthorizeUrl, exchangeCode, type OAuthState } from "@/lib/connectors/oauth";
import { introspectHubspotToken } from "@/lib/crm/hubspot/api";
import { HUBSPOT_SCOPES } from "@/lib/crm/hubspot/mapping";
import { deleteCrmRecordsForConnector } from "@/lib/crm/records";

export type CrmConnectorId = "hubspot";

export function isCrmConnectorId(id: string): id is CrmConnectorId {
  return id === "hubspot";
}

const SCOPES: Record<CrmConnectorId, readonly string[]> = { hubspot: HUBSPOT_SCOPES };
const REDIRECT_ENV: Record<CrmConnectorId, string> = { hubspot: "HUBSPOT_REDIRECT_URI" };

export function crmCallbackPath(id: CrmConnectorId): string {
  return `/api/connectors/${id}/callback`;
}

/** Exactly the URL registered on the provider's app: an explicit override, else the app's base URL. */
export function crmRedirectUri(id: CrmConnectorId): string {
  const override = process.env[REDIRECT_ENV[id]]?.trim();
  return override || new URL(crmCallbackPath(id), getAppBaseUrl()).href;
}

export function crmAuthorizeUrl(userId: string, id: CrmConnectorId, returnTo: string): string {
  return buildAuthorizeUrl(id, { userId, redirectUri: crmRedirectUri(id), scopes: [...SCOPES[id]], returnTo });
}

export class CrmConnectError extends Error {
  constructor(
    message: string,
    readonly kind: "state_mismatch" | "exchange_failed" | "identify_failed"
  ) {
    super(message);
    this.name = "CrmConnectError";
  }
}

export async function completeCrmConnect(input: {
  sessionUserId: string;
  connectorId: CrmConnectorId;
  code: string;
  state: OAuthState;
  fetchImpl?: typeof fetch;
}): Promise<{ label: string | null; accountRef: string; switchedAccount: boolean }> {
  // The signature proves Orbit minted the state. Only this proves THIS person started the
  // flow — without it, an attacker's authorize URL finished by a victim attaches the victim's
  // HubSpot to the attacker's account.
  if (input.state.userId !== input.sessionUserId || input.state.connectorId !== input.connectorId) {
    throw new CrmConnectError("The sign-in doesn’t match who started it", "state_mismatch");
  }
  const fetchImpl = input.fetchImpl ?? fetch;

  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode(input.connectorId, input.code, crmRedirectUri(input.connectorId), { fetchImpl });
  } catch (err) {
    throw new CrmConnectError(err instanceof Error ? err.message : String(err), "exchange_failed");
  }

  let info: Awaited<ReturnType<typeof introspectHubspotToken>>;
  try {
    info = await introspectHubspotToken(tokens.accessToken, fetchImpl);
  } catch (err) {
    throw new CrmConnectError(err instanceof Error ? err.message : String(err), "identify_failed");
  }

  const previous = await getConnectorConnection(input.sessionUserId, input.connectorId);
  const switchedAccount = Boolean(previous?.accountRef && previous.accountRef !== info.hubId);
  // Records synced from another HubSpot account describe someone else's CRM.
  if (switchedAccount) await deleteCrmRecordsForConnector(input.sessionUserId, input.connectorId);

  await upsertConnectorConnection({
    userId: input.sessionUserId,
    connectorId: input.connectorId,
    authKind: "oauth2",
    label: info.hubDomain,
    accountRef: info.hubId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    capabilities: ["syncPeople"],
    // Armed now: HubSpot's sync ships in this same change (the rule on ConnectorManifest.sync).
    nextSyncAt: new Date(),
  });
  return { label: info.hubDomain, accountRef: info.hubId, switchedAccount };
}
```

- [ ] **Step 4: Implement the route**

Create `src/app/api/connectors/[connectorId]/callback/route.ts`:

```ts
import { NextResponse } from "next/server";
import { parseOAuthState } from "@/lib/connectors/oauth";
import { CrmConnectError, completeCrmConnect, isCrmConnectorId } from "@/lib/crm/connect";
import { isPaywallError } from "@/lib/entitlements";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import { requireCrmUser } from "@/lib/plan-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ connectorId: string }> };

/** The codes the Leads page knows how to say. A code, never a message: URLs land in history and logs. */
type Reason = "access_denied" | "not_entitled" | "oauth_failed";

export async function GET(request: Request, { params }: Params) {
  // Next 16: route params are a Promise and must be awaited.
  const { connectorId } = await params;
  const url = new URL(request.url);
  const state = parseOAuthState(url.searchParams.get("state"));
  const back = new URL(state?.returnTo ?? "/leads", url.origin);

  async function fail(kind: string, reason: Reason, message?: unknown) {
    await recordErrorEvent({
      source: ERROR_SOURCES.oauthConnectorCallback,
      kind,
      message,
      context: { connectorId },
    });
    back.searchParams.set("crm", "error");
    back.searchParams.set("reason", reason);
    return NextResponse.redirect(back);
  }

  const denied = url.searchParams.get("error");
  if (denied) return fail("provider_denied", denied === "access_denied" ? "access_denied" : "oauth_failed", denied);
  if (!isCrmConnectorId(connectorId)) return fail("unknown_connector", "oauth_failed", connectorId);
  if (!state) return fail("state_invalid", "oauth_failed");
  const code = url.searchParams.get("code");
  if (!code) return fail("missing_code", "oauth_failed");

  let userId: string;
  try {
    // The same gate as every CRM action: signed in, Leads released for them, and paid.
    userId = await requireCrmUser();
  } catch (err) {
    return isPaywallError(err) ? fail("not_entitled", "not_entitled", err) : fail("not_allowed", "oauth_failed", err);
  }

  try {
    await completeCrmConnect({ sessionUserId: userId, connectorId, code, state });
  } catch (err) {
    return fail(err instanceof CrmConnectError ? err.kind : "other", "oauth_failed", err);
  }

  back.searchParams.set("crm", "connected");
  return NextResponse.redirect(back);
}
```

`src/lib/error-events.ts`, in `ERROR_SOURCES` directly after `oauthEventbriteCallback`:

```ts
  /** The generic connector OAuth callback (`/api/connectors/[id]/callback`) — HubSpot first. */
  oauthConnectorCallback: "oauth.connector.callback",
```

`.env.example`, directly after the Eventbrite block:

```
# HubSpot (optional — "Connect HubSpot" on /leads, behind the Leads coming-soon gate). HubSpot
# no longer creates legacy public apps: make a project app with the HubSpot CLI
# (`hs project create`), auth type oauth, required scopes crm.objects.contacts.read and
# crm.objects.owners.read, and the redirect below. Private distribution allows 10 allowlisted
# accounts; an unlisted marketplace app, 25. Without the id and secret the Leads page says
# HubSpot isn't set up. The redirect defaults to APP_BASE_URL + /api/connectors/hubspot/callback.
# HUBSPOT_CLIENT_ID=
# HUBSPOT_CLIENT_SECRET=
# HUBSPOT_REDIRECT_URI=http://localhost:3000/api/connectors/hubspot/callback
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx tsc --noEmit -p . > /tmp/p4-t11-tsc.txt 2>&1; echo tsc=$?` then `npx tsx scripts/run-smoke.ts --check && npx tsx scripts/run-smoke.ts --only smoke-crm-connect smoke-env-documented smoke-public-routes smoke-connector-oauth`
Expected: `tsc=0`; `4/4 passed`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/crm/connect.ts "src/app/api/connectors/[connectorId]/callback/route.ts" src/lib/error-events.ts .env.example scripts/smoke-crm-connect.ts scripts/run-smoke.ts
git commit -m "Connect HubSpot: a signed authorize URL out, and a callback that checks who came back

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: The CRM card on `/leads` — connect, sync now, disconnect — and "Open in HubSpot"

**Files:**
- Modify: `src/lib/crm/types.ts` (status types, `DEMO_CRM_ACCOUNT_REF`)
- Modify: `src/lib/connectors/connections.ts` (`getConnectorRefreshToken`)
- Create: `src/lib/crm/manage.ts` (server: `crmStatusFor`, `runCrmSyncNow`, `disconnectCrm`)
- Create: `src/actions/crm.ts` (`"use server"`, four thin actions)
- Create: `src/components/leads/crm-card-view.tsx` (pure view: no hooks, no actions — the smoke renders it)
- Create: `src/components/leads/crm-card.tsx` (client: hooks, actions, the OAuth return toast, the disconnect dialog)
- Modify: `src/app/(clerk)/(app)/(main)/leads/page.tsx`, `…/leads/loading.tsx`, `src/components/loading/page-skeletons.tsx` (`CrmCardSkeleton`)
- Modify: `src/components/leads/lead-detail-sheet.tsx` ("Open in HubSpot")
- Test: `scripts/smoke-crm-manage.ts` (new, pglite) + `MANIFEST` `"smoke-crm-manage": "pglite",`; `scripts/smoke-leads-page.ts`

**Interfaces:**
- Consumes: Tasks 1–11.
- Produces:
  - `@/lib/crm/types`: `DEMO_CRM_ACCOUNT_REF = "orbit-demo"`; `type CrmConnectionView = { connectorId: "hubspot"; label: string | null; status: "active" | "needs_reauth"; syncing: boolean; lastSyncedAgo: string | null; error: string | null; demo: boolean }`; `type CrmStatus = { entitled: boolean; configured: boolean; connection: CrmConnectionView | null; counts: { workContacts: number; pipeline: number; blocked: number } | null }`; `type CrmSyncNowResult = { outcome: "complete" | "partial" | "needs_reauth" | "stopped"; pages: number; records: number; message: string | null }`
  - `@/lib/connectors/connections`: `getConnectorRefreshToken(userId, connectorId): Promise<string | null>`
  - `@/lib/crm/manage`: `crmStatusFor(userId): Promise<CrmStatus>`; `runCrmSyncNow(userId, connectorId: CrmConnectorId, deps?: { sync?: (conn: ClaimedConnectorConnection, opts: { budgetMs: number }) => Promise<HubspotSyncResult>; consume?: () => Promise<unknown> }): Promise<CrmSyncNowResult>` (throws `UserFacingError`); `disconnectCrm(userId, connectorId: CrmConnectorId, deps?: { revoke?: (refreshToken: string) => Promise<boolean> }): Promise<void>`; `SYNC_NOW_BUDGET_MS = 40_000`
  - `@/actions/crm`: `loadCrmStatusAction(): Promise<CrmStatus>`, `startCrmConnectAction(connectorId: string): Promise<ActionResult<{ url: string }>>`, `syncCrmNowAction(connectorId: string): Promise<ActionResult<CrmSyncNowResult>>`, `disconnectCrmAction(connectorId: string): Promise<ActionResult<{ disconnected: true }>>`. Each body starts `const userId = await requireLeadsUser();`. Connect and sync add the `crm` entitlement inside `asActionResult` (a `PaywallError` becomes the upgrade `UserFacingError`); disconnect does NOT — a downgraded account must always be able to disconnect.
  - `@/components/leads/crm-card-view`: `CrmCardView({ status, pending, onConnect, onSync, onDisconnect })`
  - `@/components/leads/crm-card`: `CrmCard({ status })`
  - `@/components/loading/page-skeletons`: `CrmCardSkeleton()`

The card's states (the smoke renders each through `CrmCardView` and checks its words):

| State | Heading | What else shows |
|---|---|---|
| not entitled | "Connect your CRM" | the pitch; "HubSpot sync is on Orbit Pro and Lifetime." + "See plans" → `/upgrade`; no connect button |
| entitled, no connection, not configured | "Connect your CRM" | the pitch; "HubSpot isn’t set up on this server yet."; no connect button |
| entitled, no connection | "Connect your CRM" | the pitch; "Connect HubSpot" |
| connected, needs reauth | "HubSpot needs you to reconnect" | the stored error; "Reconnect HubSpot" (entitled + configured only); "Disconnect" |
| connected, active | "HubSpot · {label}" | "Syncing now" / "Last synced {ago}" / "The first sync starts within a few minutes"; the error when one is stored; "{n} work contacts · {m} in your pipeline" + "See work contacts" → `/contacts?view=work`; the blocked count when > 0; "Sync now" (hidden for demo, disabled while syncing); "Disconnect" |
| demo | as active | "Sample data — this demo connection doesn’t sync." instead of "Sync now" |

The pitch: "Bring HubSpot in: your customers become work contacts, and your leads join this pipeline — ranked by who on your team knows them."

- [ ] **Step 1: Write the failing smokes**

Create `scripts/smoke-crm-manage.ts`:

```ts
/**
 * The CRM card's server half: the status it shows, "Sync now", and disconnect. The actions in
 * src/actions/crm.ts are thin shells over these (smoke-leads-page pins that), because a Server
 * Action behind the coming-soon gate cannot be called from a script.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
process.env.HUBSPOT_CLIENT_ID = "cid";
process.env.HUBSPOT_CLIENT_SECRET = "csecret";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { connectorConnections, crmRecords, leads, userSettings } from "../src/db/schema";
import { upsertConnectorConnection } from "../src/lib/connectors/connections";
import { crmStatusFor, disconnectCrm, runCrmSyncNow } from "../src/lib/crm/manage";
import { upsertCrmRecords } from "../src/lib/crm/records";
import { DEMO_CRM_ACCOUNT_REF, type CrmPerson } from "../src/lib/crm/types";
import { UserFacingError } from "../src/lib/errors";
import { RateLimitedError } from "../src/lib/rate-limit";
import { saveLead } from "../src/lib/leads/store";
import { ensureUserSettings } from "../src/lib/user-settings";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const USER = "smoke-crm-manage";

const person = (remoteId: string, lifecycle: CrmPerson["lifecycle"]): CrmPerson => ({
  remoteType: "contact", remoteId, lifecycle, stage: null, displayName: `P ${remoteId}`, email: null, phone: null,
  linkedinUrl: null, companyName: null, companyDomain: null, title: null, remoteOwnerRef: null, remoteUrl: null,
  lastActivityAt: null, remoteCreatedAt: null, remoteUpdatedAt: null, properties: {},
});

async function message(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof UserFacingError ? err.message : `not a UserFacingError: ${String(err)}`;
  }
}

async function reset() {
  const db = await getDb();
  for (const table of [leads, crmRecords, connectorConnections]) await db.delete(table).where(eq(table.userId, USER));
}

run(async () => {
  await reset();
  const db = await getDb();
  await ensureUserSettings(USER);

  console.log("status");
  await db.update(userSettings).set({ compedPlan: null }).where(eq(userSettings.userId, USER));
  const free = await crmStatusFor(USER);
  check("a free account is not entitled", free.entitled === false && free.connection === null && free.counts === null);
  await db.update(userSettings).set({ compedPlan: "lifetime" }).where(eq(userSettings.userId, USER));
  const paid = await crmStatusFor(USER);
  check("a paid account is, and the server is configured", paid.entitled && paid.configured);

  await upsertConnectorConnection({ userId: USER, connectorId: "hubspot", authKind: "oauth2", label: "acme.hubspot.com", accountRef: "4242", accessToken: "a", refreshToken: "r", nextSyncAt: null });
  await upsertCrmRecords(USER, "hubspot", [person("1", "customer"), person("2", "lead"), person("3", "other")]);
  const connected = await crmStatusFor(USER);
  check("the connection shows", connected.connection?.label === "acme.hubspot.com" && connected.connection.status === "active" && !connected.connection.demo);
  check("never synced yet", connected.connection?.lastSyncedAgo === null && connected.connection?.syncing === false);
  check("counts: pipeline is every non-customer", connected.counts?.pipeline === 2 && connected.counts.workContacts === 0, JSON.stringify(connected.counts));
  await db.update(connectorConnections).set({ syncStatus: "syncing", syncStartedAt: new Date(), lastSyncedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(connectorConnections.userId, USER));
  const busy = await crmStatusFor(USER);
  check("a live lease reads as syncing", busy.connection?.syncing === true);
  check("with a relative last sync", /minutes? ago/.test(busy.connection?.lastSyncedAgo ?? ""), String(busy.connection?.lastSyncedAgo));
  await db.update(connectorConnections).set({ syncStartedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(connectorConnections.userId, USER));
  check("an expired lease does not", (await crmStatusFor(USER)).connection?.syncing === false);
  await db.update(connectorConnections).set({ syncStatus: "idle" }).where(eq(connectorConnections.userId, USER));

  console.log("\nsync now");
  const calls: string[] = [];
  const okSync = async (conn: { id: string; accessToken: string | null }, opts: { budgetMs: number }) => {
    calls.push(`${conn.accessToken}:${opts.budgetMs}`);
    return { outcome: "complete" as const, pages: 2, records: 3, contactsCreated: 1, leadsCreated: 2, blocked: 0 };
  };
  const result = await runCrmSyncNow(USER, "hubspot", { sync: okSync, consume: async () => {} });
  check("runs the sync with the claimed connection and a 40 s budget", calls[0] === "a:40000", calls.join(","));
  check("reports what it did", result.outcome === "complete" && result.pages === 2 && result.records === 3 && result.message === null);
  check("and releases the lease", (await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER)))[0]?.syncStatus === "idle");

  const limited = await message(runCrmSyncNow(USER, "hubspot", { sync: okSync, consume: async () => { throw new RateLimitedError("providerSync", 600); } }));
  check("rate limited, in words", limited === "You’ve synced a few times this hour — the automatic sync keeps running", String(limited));

  await db.update(connectorConnections).set({ syncStatus: "syncing", syncStartedAt: new Date() }).where(eq(connectorConnections.userId, USER));
  check("a sync already running is said so", (await message(runCrmSyncNow(USER, "hubspot", { sync: okSync, consume: async () => {} }))) === "A sync is already running — give it a minute");
  await db.update(connectorConnections).set({ syncStatus: "idle" }).where(eq(connectorConnections.userId, USER));

  const broken = async () => {
    throw new Error("socket hang up");
  };
  const failed = await message(runCrmSyncNow(USER, "hubspot", { sync: broken, consume: async () => {} }));
  check("a provider failure is said plainly", failed === "HubSpot didn’t answer — the next automatic sync will try again", String(failed));
  const [afterFail] = await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER));
  check("and recorded as retryable", afterFail?.syncStatus === "error" && afterFail?.nextSyncAt !== null && (afterFail?.syncError ?? "").includes("socket hang up"));

  const stopped = await runCrmSyncNow(USER, "hubspot", { sync: async () => ({ outcome: "stopped", pages: 0, records: 0, contactsCreated: 0, leadsCreated: 0, blocked: 0, message: "HubSpot says no" }), consume: async () => {} });
  check("a stop comes back with its reason", stopped.outcome === "stopped" && stopped.message === "HubSpot says no");

  await db.update(connectorConnections).set({ status: "needs_reauth" }).where(eq(connectorConnections.userId, USER));
  check("needs reauth is said before trying", (await message(runCrmSyncNow(USER, "hubspot", { sync: okSync, consume: async () => {} }))) === "HubSpot needs you to reconnect — use Reconnect, then sync");
  await db.update(connectorConnections).set({ status: "active", accountRef: DEMO_CRM_ACCOUNT_REF }).where(eq(connectorConnections.userId, USER));
  check("the demo connection never syncs", (await message(runCrmSyncNow(USER, "hubspot", { sync: okSync, consume: async () => {} }))) === "The demo’s HubSpot data is sample data — there’s nothing to sync");
  check("…and says it is the demo", (await crmStatusFor(USER)).connection?.demo === true);
  await db.update(connectorConnections).set({ accountRef: "4242" }).where(eq(connectorConnections.userId, USER));

  console.log("\ndisconnect");
  const records = await db.select().from(crmRecords).where(eq(crmRecords.userId, USER));
  const { lead } = await saveLead(USER, { source: "manual", displayName: "Tied Lead" });
  await db.update(leads).set({ crmRecordId: records[1]!.id }).where(eq(leads.id, lead.id));
  const revoked: string[] = [];
  await disconnectCrm(USER, "hubspot", { revoke: async (t) => { revoked.push(t); return true; } });
  check("the refresh token was revoked", revoked.join(",") === "r");
  check("the connection is gone", (await db.select().from(connectorConnections).where(eq(connectorConnections.userId, USER))).length === 0);
  check("so are its records", (await db.select().from(crmRecords).where(eq(crmRecords.userId, USER))).length === 0);
  const [keptLead] = await db.select().from(leads).where(eq(leads.id, lead.id));
  check("a CRM-tied lead stays, untied", keptLead !== undefined && keptLead.crmRecordId === null);
  check("disconnecting nothing is fine", (await message(disconnectCrm(USER, "hubspot", { revoke: async () => true }))) === null);

  await upsertConnectorConnection({ userId: USER, connectorId: "hubspot", authKind: "oauth2", accountRef: DEMO_CRM_ACCOUNT_REF, nextSyncAt: null });
  const demoRevokes: string[] = [];
  await disconnectCrm(USER, "hubspot", { revoke: async (t) => { demoRevokes.push(t); return true; } });
  check("the demo connection is never revoked at HubSpot", demoRevokes.length === 0);

  await reset();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll CRM manage checks passed.");
});
```

Register `"smoke-crm-manage": "pglite",` in `MANIFEST`. (`RateLimitedError` is constructed `(scope, retryAfterSec)`.)

`scripts/smoke-leads-page.ts`:
- append `"crm-card.tsx",` to `CLIENT_COMPONENTS`
- import `CrmCardView` from `../src/components/leads/crm-card-view` and add a section before "structure":

```ts
  console.log("\nthe CRM card says the right thing in every state");
  {
    const noop = () => {};
    const view = (status: Parameters<typeof CrmCardView>[0]["status"]) =>
      text(React.createElement(CrmCardView, { status, pending: null, onConnect: noop, onSync: noop, onDisconnect: noop }));
    const base = { entitled: true, configured: true, connection: null, counts: null };
    const conn = { connectorId: "hubspot" as const, label: "acme.hubspot.com", status: "active" as const, syncing: false, lastSyncedAgo: "5 minutes ago", error: null, demo: false };

    const locked = view({ ...base, entitled: false });
    check("free: the paywall, not a connect button", locked.includes("HubSpot sync is on Orbit Pro and Lifetime") && locked.includes("See plans") && !locked.includes("Connect HubSpot"), locked);
    const unset = view({ ...base, configured: false });
    check("unconfigured: says so, no button", unset.includes("isn’t set up on this server yet") && !unset.includes("Connect HubSpot"), unset);
    const ready = view(base);
    check("ready: the pitch and the button", ready.includes("Connect your CRM") && ready.includes("work contacts") && ready.includes("Connect HubSpot"), ready);
    const live = view({ ...base, connection: conn, counts: { workContacts: 12, pipeline: 3, blocked: 0 } });
    check("connected: account, last sync, counts", live.includes("HubSpot · acme.hubspot.com") && live.includes("Last synced 5 minutes ago") && live.includes("12 work contacts") && live.includes("3 in your pipeline"), live);
    check("connected: sync and disconnect", live.includes("Sync now") && live.includes("Disconnect") && live.includes("See work contacts"), live);
    const first = view({ ...base, connection: { ...conn, lastSyncedAgo: null }, counts: { workContacts: 0, pipeline: 0, blocked: 0 } });
    check("never synced: when it will", first.includes("The first sync starts within a few minutes"), first);
    const running = view({ ...base, connection: { ...conn, syncing: true }, counts: { workContacts: 0, pipeline: 0, blocked: 0 } });
    check("syncing: says so", running.includes("Syncing now"), running);
    const erred = view({ ...base, connection: { ...conn, error: "HubSpot is rate-limiting this account — the next sync picks up where this one stopped" }, counts: { workContacts: 1, pipeline: 0, blocked: 2 } });
    check("an error and the cap are shown", erred.includes("rate-limiting") && erred.includes("2 customers didn’t fit your plan’s contact limit"), erred);
    const reauth = view({ ...base, connection: { ...conn, status: "needs_reauth", error: "HubSpot refused the access token" }, counts: null });
    check("needs reauth: reconnect, not sync", reauth.includes("HubSpot needs you to reconnect") && reauth.includes("Reconnect HubSpot") && !reauth.includes("Sync now"), reauth);
    const demo = view({ ...base, connection: { ...conn, demo: true }, counts: { workContacts: 4, pipeline: 2, blocked: 0 } });
    check("demo: sample data, no sync", demo.includes("Sample data") && !demo.includes("Sync now"), demo);
    check("one work contact is singular", view({ ...base, connection: conn, counts: { workContacts: 1, pipeline: 1, blocked: 0 } }).includes("1 work contact ·"));
  }

  console.log("\nthe CRM actions are thin, gated shells");
  {
    const actions = code("src/actions/crm.ts");
    const exports = [...actions.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{\s*([^;]*;)/g)];
    check("four actions", exports.length === 4, exports.map((m) => m[1]).join(","));
    check("each starts with requireLeadsUser", exports.every((m) => m[2].trim() === "const userId = await requireLeadsUser();"), exports.map((m) => m[2]).join(" | "));
    check("no other kind of export", !/export\s+(const|type|let|function\s)/.test(actions.replace(/export\s+async\s+function/g, "")));
    check("disconnect never checks the plan", !/disconnectCrmAction[\s\S]*?requireCrm\(/.test(actions.slice(actions.indexOf("disconnectCrmAction"))));
  }
```

- in the client-safety loop's `serverOnly` regex add `@\/lib\/crm\/(manage|records|persist|connect|hubspot\/(api|sync))` and `@\/lib\/connectors\/(connections|token|syncs)` to the alternation
- extend the byte scan: after the `src/components/leads` loop, run the same mis-encoding and curly-apostrophe checks over every `.ts` file under `src/lib/crm` (walk `src/lib/crm` and `src/lib/crm/hubspot`)
- in "structure": require `CrmSection` below the page (add it to the `for (const section of …)` list), `<CrmSection` among the parts, and `CrmCardSkeleton` in `loading.tsx`'s mirror list

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx scripts/run-smoke.ts --only smoke-crm-manage smoke-leads-page`
Expected: FAIL — missing modules.

- [ ] **Step 3: Types and the refresh-token read**

Append to `src/lib/crm/types.ts`:

```ts
/** `connector_connections.account_ref` of the localhost demo's HubSpot: never synced, never revoked. */
export const DEMO_CRM_ACCOUNT_REF = "orbit-demo";

/** What the CRM card shows about one connection. Dates arrive pre-worded, so SSR and hydration agree. */
export type CrmConnectionView = {
  connectorId: "hubspot";
  label: string | null;
  status: "active" | "needs_reauth";
  syncing: boolean;
  lastSyncedAgo: string | null;
  error: string | null;
  demo: boolean;
};

export type CrmStatus = {
  entitled: boolean;
  configured: boolean;
  connection: CrmConnectionView | null;
  counts: { workContacts: number; pipeline: number; blocked: number } | null;
};

export type CrmSyncNowResult = {
  outcome: "complete" | "partial" | "needs_reauth" | "stopped";
  pages: number;
  records: number;
  message: string | null;
};
```

Append to `src/lib/connectors/connections.ts`:

```ts
/** The decrypted refresh token, for the revoke on disconnect. Server code only — never the UI. */
export async function getConnectorRefreshToken(userId: string, connectorId: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db
    .select({ refresh: connectorConnections.refreshTokenEncrypted })
    .from(connectorConnections)
    .where(and(eq(connectorConnections.userId, userId), eq(connectorConnections.connectorId, connectorId)))
    .limit(1);
  return decryptOrNull(row?.refresh ?? null);
}
```

- [ ] **Step 4: The server half**

Create `src/lib/crm/manage.ts`:

```ts
/**
 * The CRM card's server half: what it shows, "Sync now", and disconnect. The Server Actions in
 * src/actions/crm.ts are thin shells over these, so this runs in a smoke.
 */
import { formatDistanceToNow } from "date-fns";
import {
  claimConnectorConnectionForUser,
  deleteConnectorConnection,
  getConnectorConnection,
  getConnectorRefreshToken,
  markConnectorSyncResult,
  markConnectorSyncSucceeded,
  type ClaimedConnectorConnection,
} from "@/lib/connectors/connections";
import { isOAuthConfigured } from "@/lib/connectors/oauth";
import type { CrmConnectorId } from "@/lib/crm/connect";
import { revokeHubspotToken } from "@/lib/crm/hubspot/api";
import { syncHubspot, type HubspotSyncResult } from "@/lib/crm/hubspot/sync";
import { crmCounts, deleteCrmRecordsForConnector } from "@/lib/crm/records";
import { DEMO_CRM_ACCOUNT_REF, type CrmStatus, type CrmSyncNowResult } from "@/lib/crm/types";
import { getEntitlements } from "@/lib/entitlements";
import { UserFacingError } from "@/lib/errors";
import { SYNC_LEASE_MS } from "@/lib/provider-connections";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";

/** A person is waiting on the button: shorter than the scheduler's share, and resumable. */
export const SYNC_NOW_BUDGET_MS = 40_000;

export async function crmStatusFor(userId: string): Promise<CrmStatus> {
  const [entitlements, connection] = await Promise.all([
    getEntitlements(userId),
    getConnectorConnection(userId, "hubspot"),
  ]);
  const counts = connection ? await crmCounts(userId, "hubspot") : null;
  const leaseCutoff = Date.now() - SYNC_LEASE_MS;
  return {
    entitled: entitlements.canUseCrm,
    configured: isOAuthConfigured("hubspot"),
    connection: connection
      ? {
          connectorId: "hubspot",
          label: connection.label,
          status: connection.status,
          syncing: connection.syncStatus === "syncing" && (connection.syncStartedAt?.getTime() ?? 0) > leaseCutoff,
          lastSyncedAgo: connection.lastSyncedAt ? formatDistanceToNow(connection.lastSyncedAt, { addSuffix: true }) : null,
          error: connection.syncError,
          demo: connection.accountRef === DEMO_CRM_ACCOUNT_REF,
        }
      : null,
    counts,
  };
}

export async function runCrmSyncNow(
  userId: string,
  connectorId: CrmConnectorId,
  deps: {
    sync?: (conn: ClaimedConnectorConnection, opts: { budgetMs: number }) => Promise<HubspotSyncResult>;
    consume?: () => Promise<unknown>;
  } = {}
): Promise<CrmSyncNowResult> {
  const summary = await getConnectorConnection(userId, connectorId);
  if (!summary) throw new UserFacingError("Connect HubSpot first");
  if (summary.accountRef === DEMO_CRM_ACCOUNT_REF) {
    throw new UserFacingError("The demo’s HubSpot data is sample data — there’s nothing to sync");
  }
  if (summary.status === "needs_reauth") {
    throw new UserFacingError("HubSpot needs you to reconnect — use Reconnect, then sync");
  }
  try {
    await (deps.consume ?? (() => consumeBucket("providerSync", userId, RATE_LIMITS.providerSync)))();
  } catch (err) {
    if (isRateLimitedError(err)) {
      throw new UserFacingError("You’ve synced a few times this hour — the automatic sync keeps running");
    }
    throw err;
  }
  const conn = await claimConnectorConnectionForUser(userId, connectorId);
  if (!conn) throw new UserFacingError("A sync is already running — give it a minute");

  const sync = deps.sync ?? ((c, opts) => syncHubspot(c, opts));
  let result: HubspotSyncResult;
  try {
    result = await sync(conn, { budgetMs: SYNC_NOW_BUDGET_MS });
  } catch (err) {
    // What the scheduler does with a throw: retryable, backed off, the error kept for the card.
    await markConnectorSyncResult(conn.id, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      retryable: true,
    });
    throw new UserFacingError("HubSpot didn’t answer — the next automatic sync will try again");
  }
  // The backstop: a no-op when the sync recorded its own outcome, which HubSpot's always does.
  await markConnectorSyncSucceeded(conn.id);
  return { outcome: result.outcome, pages: result.pages, records: result.records, message: result.message ?? null };
}

/**
 * Revoke (best effort), then forget. No plan check: a downgraded account must always be able
 * to disconnect. The contacts a sync created stay — they are the person's now — and CRM leads
 * stay as leads, untied by the foreign key.
 */
export async function disconnectCrm(
  userId: string,
  connectorId: CrmConnectorId,
  deps: { revoke?: (refreshToken: string) => Promise<boolean> } = {}
): Promise<void> {
  const summary = await getConnectorConnection(userId, connectorId);
  if (summary && summary.accountRef !== DEMO_CRM_ACCOUNT_REF) {
    const refresh = await getConnectorRefreshToken(userId, connectorId);
    const revoke = deps.revoke ?? ((token: string) => (isOAuthConfigured(connectorId) ? revokeHubspotToken(token) : Promise.resolve(false)));
    if (refresh) await revoke(refresh);
  }
  await deleteConnectorConnection(userId, connectorId);
  await deleteCrmRecordsForConnector(userId, connectorId);
}
```

(`markConnectorSyncSucceeded`'s default `now` is fine. If `RATE_LIMITS`/`consumeBucket` are exported under different names, use the ones `src/actions/events.ts` imports — note that file passes `consumeBucket`'s first two arguments swapped; the signature is `(scope, key, policy)`.)

- [ ] **Step 5: The actions**

Create `src/actions/crm.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { isCrmConnectorId, crmAuthorizeUrl } from "@/lib/crm/connect";
import { crmStatusFor, disconnectCrm, runCrmSyncNow } from "@/lib/crm/manage";
import type { CrmStatus, CrmSyncNowResult } from "@/lib/crm/types";
import { isOAuthConfigured } from "@/lib/connectors/oauth";
import { isPaywallError, requireEntitlement } from "@/lib/entitlements";
import { asActionResult, UserFacingError, type ActionResult } from "@/lib/errors";
import { requireLeadsUser } from "@/lib/plan-guards";

/*
 * Every action starts with `requireLeadsUser()`: while Leads is coming soon this refuses
 * everyone, a direct POST included. Connecting and syncing are the paid half and check the
 * `crm` entitlement inside `asActionResult`, so the refusal reaches the person as words;
 * disconnecting never checks the plan.
 */

type ConnectStart = { url: string };
type Disconnected = { disconnected: true };

const NOT_AVAILABLE = "That CRM isn’t available yet";
const UPGRADE = "HubSpot sync is on Orbit Pro and Lifetime — upgrade to connect it";

async function requireCrm(userId: string): Promise<void> {
  try {
    await requireEntitlement(userId, "crm");
  } catch (err) {
    if (isPaywallError(err)) throw new UserFacingError(UPGRADE);
    throw err;
  }
}

export async function loadCrmStatusAction(): Promise<CrmStatus> {
  const userId = await requireLeadsUser();
  return crmStatusFor(userId);
}

export async function startCrmConnectAction(connectorId: string): Promise<ActionResult<ConnectStart>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    await requireCrm(userId);
    if (!isCrmConnectorId(connectorId)) throw new UserFacingError(NOT_AVAILABLE);
    if (!isOAuthConfigured(connectorId)) throw new UserFacingError("HubSpot isn’t set up on this server yet");
    return { url: crmAuthorizeUrl(userId, connectorId, "/leads") };
  });
}

export async function syncCrmNowAction(connectorId: string): Promise<ActionResult<CrmSyncNowResult>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    await requireCrm(userId);
    if (!isCrmConnectorId(connectorId)) throw new UserFacingError(NOT_AVAILABLE);
    const result = await runCrmSyncNow(userId, connectorId);
    revalidatePath("/leads");
    revalidatePath("/contacts");
    return result;
  });
}

export async function disconnectCrmAction(connectorId: string): Promise<ActionResult<Disconnected>> {
  const userId = await requireLeadsUser();
  return asActionResult(async () => {
    if (!isCrmConnectorId(connectorId)) throw new UserFacingError(NOT_AVAILABLE);
    await disconnectCrm(userId, connectorId);
    revalidatePath("/leads");
    revalidatePath("/contacts");
    return { disconnected: true as const };
  });
}
```

(Non-exported helpers and consts are fine in a `"use server"` file; only exports must be async functions.)

- [ ] **Step 6: The card**

Create `src/components/leads/crm-card-view.tsx` (no `"use client"`, no hooks, no actions — the smoke renders it):

```tsx
import Link from "next/link";
import { Building2, RefreshCw } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import type { CrmStatus } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

const PITCH =
  "Bring HubSpot in: your customers become work contacts, and your leads join this pipeline — ranked by who on your team knows them.";

function plural(n: number, one: string, many: string) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** The CRM card's words and buttons for one status. `pending` names the button that is busy. */
export function CrmCardView({
  status,
  pending,
  onConnect,
  onSync,
  onDisconnect,
}: {
  status: CrmStatus;
  pending: "connect" | "sync" | "disconnect" | null;
  onConnect: () => void;
  onSync: () => void;
  onDisconnect: () => void;
}) {
  const { connection, counts } = status;
  const canConnect = status.entitled && status.configured;

  if (!connection) {
    return (
      <Shell title="Connect your CRM" body={PITCH}>
        {!status.entitled ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted-foreground">HubSpot sync is on Orbit Pro and Lifetime.</span>
            <Link href="/upgrade" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              See plans
            </Link>
          </div>
        ) : !status.configured ? (
          <p className="text-sm text-muted-foreground">HubSpot isn’t set up on this server yet.</p>
        ) : (
          <Button type="button" disabled={pending !== null} onClick={onConnect}>
            {pending === "connect" ? "Opening HubSpot…" : "Connect HubSpot"}
          </Button>
        )}
      </Shell>
    );
  }

  if (connection.status === "needs_reauth") {
    return (
      <Shell title="HubSpot needs you to reconnect" body={connection.error ?? "HubSpot stopped accepting Orbit’s sign-in."}>
        <div className="flex flex-wrap gap-2">
          {canConnect ? (
            <Button type="button" disabled={pending !== null} onClick={onConnect}>
              {pending === "connect" ? "Opening HubSpot…" : "Reconnect HubSpot"}
            </Button>
          ) : null}
          <Button type="button" variant="outline" disabled={pending !== null} onClick={onDisconnect}>
            Disconnect
          </Button>
        </div>
      </Shell>
    );
  }

  const when = connection.syncing
    ? "Syncing now"
    : connection.lastSyncedAgo
      ? `Last synced ${connection.lastSyncedAgo}`
      : "The first sync starts within a few minutes";

  return (
    <Shell title={connection.label ? `HubSpot · ${connection.label}` : "HubSpot"} body={when}>
      {connection.error ? <p className="text-sm text-amber-700 dark:text-amber-400">{connection.error}</p> : null}
      {counts ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink">
          <span>
            {plural(counts.workContacts, "work contact", "work contacts")} · {counts.pipeline.toLocaleString()} in your pipeline
          </span>
          <Link href="/contacts?view=work" className="text-primary underline-offset-4 hover:underline">
            See work contacts
          </Link>
        </p>
      ) : null}
      {counts && counts.blocked > 0 ? (
        <p className="text-xs text-muted-foreground">
          {plural(counts.blocked, "customer didn’t fit your plan’s contact limit", "customers didn’t fit your plan’s contact limit")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {connection.demo ? (
          <span className="text-xs text-muted-foreground">Sample data — this demo connection doesn’t sync.</span>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled={pending !== null || connection.syncing} onClick={onSync}>
            <RefreshCw aria-hidden className={cn(pending === "sync" && "animate-spin motion-reduce:animate-none")} />
            {pending === "sync" ? "Syncing…" : "Sync now"}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" disabled={pending !== null} onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>
    </Shell>
  );
}

function Shell({ title, body, children }: { title: string; body: string; children: React.ReactNode }) {
  return (
    <section aria-label="Your CRM" className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
      <div className="flex gap-3">
        <div className="mt-0.5 h-9 w-9 shrink-0 rounded-full bg-primary/10 p-2 text-primary">
          <Building2 className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0">
          <h2 className="font-medium text-ink">{title}</h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">{body}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
```

Create `src/components/leads/crm-card.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { disconnectCrmAction, startCrmConnectAction, syncCrmNowAction } from "@/actions/crm";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CrmStatus } from "@/lib/crm/types";
import { friendlyError } from "@/lib/errors";
import { readOAuthReturn } from "@/lib/oauth-return";
import { toast } from "@/lib/toast";
import { CrmCardView } from "./crm-card-view";

const CRM_RETURN = {
  param: "crm",
  provider: "HubSpot",
  connectedText: "HubSpot connected — your first sync starts within a few minutes",
  reasons: {
    not_entitled: "HubSpot sync is on Orbit Pro and Lifetime — upgrade, then connect again",
  },
};

/** The CRM card: connect, sync now, disconnect, and what came back from HubSpot's sign-in. */
export function CrmCard({ status }: { status: CrmStatus }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [pending, setPending] = useState<"connect" | "sync" | "disconnect" | null>(null);
  const [confirming, setConfirming] = useState(false);

  // The callback's outcome, toasted once. The params are stripped on the first gesture, never
  // in this effect — see `readOAuthReturn`: a replaceState here would drop a sibling's action.
  const toasted = useRef(false);
  useEffect(() => {
    const result = readOAuthReturn(window.location.search, CRM_RETURN);
    if (!result) return;
    if (!toasted.current) {
      toasted.current = true;
      if (result.tone === "success") toast.success(result.text);
      else if (result.tone === "message") toast.message(result.text);
      else toast.error(result.text);
    }
    const strip = () =>
      window.history.replaceState(null, "", `${window.location.pathname}${result.nextSearch}${window.location.hash}`);
    window.addEventListener("pointerdown", strip, { once: true, capture: true });
    window.addEventListener("keydown", strip, { once: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", strip, true);
      window.removeEventListener("keydown", strip, true);
    };
  }, []);

  function connect() {
    setPending("connect");
    start(async () => {
      try {
        const result = await startCrmConnectAction("hubspot");
        if (!result.ok) {
          toast.error(result.error);
          setPending(null);
          return;
        }
        // A full navigation, not a router push: HubSpot's consent screen is another origin.
        window.location.assign(result.value.url);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t open HubSpot — try again?"));
        setPending(null);
      }
    });
  }

  function sync() {
    setPending("sync");
    start(async () => {
      try {
        const result = await syncCrmNowAction("hubspot");
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        const r = result.value;
        if (r.outcome === "stopped" || r.outcome === "needs_reauth") toast.error(r.message ?? "HubSpot sync stopped — see the card for why");
        else if (r.outcome === "partial") toast.message("Synced part of HubSpot — the rest follows automatically");
        else toast.success(r.records === 0 ? "HubSpot is up to date" : `Synced ${r.records.toLocaleString()} from HubSpot`);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t sync HubSpot — try again?"));
      } finally {
        setPending(null);
      }
    });
  }

  function disconnect() {
    setConfirming(false);
    setPending("disconnect");
    start(async () => {
      try {
        const result = await disconnectCrmAction("hubspot");
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success("HubSpot disconnected");
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t disconnect HubSpot — try again?"));
      } finally {
        setPending(null);
      }
    });
  }

  return (
    <>
      <CrmCardView status={status} pending={pending} onConnect={connect} onSync={sync} onDisconnect={() => setConfirming(true)} />
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect HubSpot?</DialogTitle>
            <DialogDescription>
              Orbit stops syncing, asks HubSpot to revoke its access, and forgets which contacts came
              from it. The work contacts it added stay in your network, and your leads stay in the
              pipeline.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={disconnect}>
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

(`ActionResult<T>` is `{ ok: true; value: T } | { ok: false; error: string }`. `toast.message` exists in `@/lib/toast` — `event-connections-card.tsx` uses it.)

`src/components/loading/page-skeletons.tsx`, after `TeamPanelSkeleton`:

```tsx
/** Mirrors the /leads CRM card: icon, heading, a line, a button. */
export function CrmCardSkeleton() {
  return <Skeleton className="h-32 w-full rounded-2xl" />;
}
```

- [ ] **Step 7: Put it on the page**

`src/app/(clerk)/(app)/(main)/leads/page.tsx`: import `loadCrmStatusAction` from `@/actions/crm`, `CrmCard` from `@/components/leads/crm-card`, and `CrmCardSkeleton`; between the team block and `FindPath` add

```tsx
      <div className="reveal-mount" style={{ "--reveal-delay": "75ms" } as React.CSSProperties}>
        <Suspense fallback={<CrmCardSkeleton />}>
          <CrmSection />
        </Suspense>
      </div>
```

and BELOW the default export (after `TeamSection`):

```tsx
async function CrmSection() {
  const status = await loadCrmStatusAction();
  return <CrmCard status={status} />;
}
```

`loading.tsx`: add `CrmCardSkeleton` to the import and render `<CrmCardSkeleton />` between `<TeamPanelSkeleton />` and `<FindPath />`; update its doc comment to "the three data sections as skeletons".

`src/components/leads/lead-detail-sheet.tsx`: import `ExternalLink` from `lucide-react`; directly after the status line's closing `</div>` (the one holding the `WarmthChip` and status/source text) add:

```tsx
        {row.crm ? (
          <a
            href={row.crm.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
          >
            Open in {row.crm.label}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        ) : null}
```

- [ ] **Step 8: Run to verify they pass**

Run: `npx tsc --noEmit -p . > /tmp/p4-t12-tsc.txt 2>&1; echo tsc=$?` then `npm run lint > /tmp/p4-t12-lint.txt 2>&1; grep -E "^\s+[0-9]+:[0-9]+\s+error" /tmp/p4-t12-lint.txt | head` then `npx tsx scripts/run-smoke.ts --check && npx tsx scripts/run-smoke.ts --only smoke-crm-manage smoke-leads-page smoke-toast-copy smoke-warm-path`
Expected: `tsc=0`; no lint errors; `4/4 passed`.

- [ ] **Step 9: Commit**

```bash
git add src/lib/crm/types.ts src/lib/connectors/connections.ts src/lib/crm/manage.ts src/actions/crm.ts src/components/leads/crm-card-view.tsx src/components/leads/crm-card.tsx src/components/loading/page-skeletons.tsx "src/app/(clerk)/(app)/(main)/leads/page.tsx" "src/app/(clerk)/(app)/(main)/leads/loading.tsx" src/components/leads/lead-detail-sheet.tsx scripts/smoke-crm-manage.ts scripts/smoke-leads-page.ts scripts/run-smoke.ts
git commit -m "Add the CRM card to /leads: connect HubSpot, sync now, disconnect, and open a lead in HubSpot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: The "Work" view on Contacts

Work contacts are contacts a connected CRM synced — a `crm_records` row with this contact's id. They get a third pill beside Contacts and Recruiters, at `/contacts?view=work`, shown only while Leads is released for the viewer (the spec's "gated at page level"; `src/lib/surfaces.ts` already says so where `page.leads` has no companions).

**Files:**
- Create: `src/lib/crm/work-contacts.ts` (the WHERE fragment)
- Modify: `src/lib/surface-visibility.ts` (`isSurfaceReleased`)
- Modify: `src/lib/people-nav.ts` (`PeopleView`, index direction)
- Modify: `src/components/contacts/people-list-shell.tsx` (the Work option, `showWork`)
- Modify: `src/lib/contacts-page.ts` (`ContactsPageFilters.work`), `src/actions/contacts.ts` (`listContactsPage`)
- Modify: `src/components/contacts/contacts-filters.tsx` (`view` survives `apply()`), `src/components/contacts/contacts-list.tsx` (`ContactsListFilters.work`, `seekToLetter`, the empty state)
- Modify: `src/app/(clerk)/(app)/(main)/contacts/page.tsx`, `src/app/(clerk)/(app)/(main)/recruiters/page.tsx`, `src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx` (use `isSurfaceReleased`)
- Test: `scripts/smoke-work-contacts.ts` (new, pglite) + `MANIFEST` `"smoke-work-contacts": "pglite",`

**Interfaces:**
- Consumes: `crm_records` (Task 2); `resolveSurfaceVisibility`.
- Produces:
  - `@/lib/crm/work-contacts`: `workContactsCondition(userId: string): SQL` — for a query `FROM contacts`; the user id is BOUND, never correlated (a correlated tenant predicate is the one the planner's hashed-SubPlan rewrite has dropped before — see the warm-path rules).
  - `@/lib/surface-visibility`: `isSurfaceReleased(userId, surfaceKey): Promise<boolean>` — `!hidden.has(key) && !comingSoon.has(key)` (always-visible keys are true).
  - `@/lib/people-nav`: `type PeopleView = "contacts" | "work" | "recruiters"`, `PEOPLE_VIEWS` (that order), `directionForPeopleNav(from: PeopleView, to: PeopleView): -1 | 0 | 1` by index.
  - `PeopleListShell` props gain `showWork?: boolean` and `active: PeopleView`.
  - `ContactsPageFilters.work?: true`, `ContactsListFilters.work?: true`.

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-work-contacts.ts`:

```ts
/**
 * Work contacts: the SQL that picks them, the pill that shows them, and the paths that must
 * keep `view=work` when the list re-queries. The SQL half runs on PGlite; the wiring half
 * reads the source, because the list is a client component behind a gated page.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, crmRecords } from "../src/db/schema";
import { workContactsCondition } from "../src/lib/crm/work-contacts";
import { PEOPLE_VIEWS, directionForPeopleNav } from "../src/lib/people-nav";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const code = (file: string) =>
  readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const USER = "smoke-work-contacts";
const OTHER = "smoke-work-contacts-other";

run(async () => {
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(crmRecords).where(eq(crmRecords.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }

  console.log("the SQL");
  const [work, personal, planted] = await db
    .insert(contacts)
    .values([
      { userId: USER, fullName: "Work Person" },
      { userId: USER, fullName: "Personal Friend" },
      { userId: USER, fullName: "Planted" },
    ])
    .returning();
  await db.insert(crmRecords).values([
    { userId: USER, connectorId: "hubspot", remoteType: "contact", remoteId: "1", lifecycle: "customer", displayName: "Work Person", contactId: work.id },
    { userId: USER, connectorId: "hubspot", remoteType: "contact", remoteId: "2", lifecycle: "customer", displayName: "Also Work", contactId: work.id },
    { userId: USER, connectorId: "hubspot", remoteType: "contact", remoteId: "3", lifecycle: "lead", displayName: "Unlinked" },
    // Another account's record naming this user's contact must not make it a work contact.
    { userId: OTHER, connectorId: "hubspot", remoteType: "contact", remoteId: "9", lifecycle: "customer", displayName: "Planted", contactId: planted.id },
  ]);
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.userId, USER), workContactsCondition(USER)));
  check("only the linked contact, once", rows.length === 1 && rows[0]?.id === work.id, JSON.stringify(rows));
  check("a personal contact is not work", !rows.some((r) => r.id === personal.id));
  check("another account's record never counts", !rows.some((r) => r.id === planted.id));
  const src = code("src/lib/crm/work-contacts.ts");
  check("the user id is bound, not correlated", /cr\.user_id = \$\{userId\}/.test(src) && !/cr\.user_id = contacts\.user_id/.test(src));

  console.log("\nthe pill's direction");
  check("contacts, work, recruiters", PEOPLE_VIEWS.join(",") === "contacts,work,recruiters");
  check("contacts → work slides forward", directionForPeopleNav("contacts", "work") === 1);
  check("work → recruiters slides forward", directionForPeopleNav("work", "recruiters") === 1);
  check("recruiters → work slides back", directionForPeopleNav("recruiters", "work") === -1);
  check("work → contacts slides back", directionForPeopleNav("work", "contacts") === -1);
  check("staying put does not slide", directionForPeopleNav("work", "work") === 0);

  console.log("\nthe wiring");
  const shell = code("src/components/contacts/people-list-shell.tsx");
  check("the shell offers Work at /contacts?view=work", shell.includes('"/contacts?view=work"') && shell.includes('"Work"'));
  check("only when told to", shell.includes("showWork"));
  const page = code("src/app/(clerk)/(app)/(main)/contacts/page.tsx");
  check("the contacts page asks whether Leads is released", page.includes('isSurfaceReleased(') && page.includes('"page.leads"'));
  check("and honours view=work only then", /showWork\s*&&\s*params\.view\s*===\s*"work"/.test(page));
  check("the list is keyed on the view", /key=\{\[[^\]]*work/.test(page));
  check("the recruiters page shows the pill the same way", code("src/app/(clerk)/(app)/(main)/recruiters/page.tsx").includes("showWork"));
  check("the filters keep view=work", /params\.set\("view", "work"\)/.test(code("src/components/contacts/contacts-filters.tsx")));
  check("the A–Z seek keeps view=work", /params\.set\("view", "work"\)/.test(code("src/components/contacts/contacts-list.tsx")));
  const action = code("src/actions/contacts.ts");
  check("the list query re-checks the release before filtering", action.includes("workContactsCondition(") && action.includes('isSurfaceReleased(userId, "page.leads")'));

  for (const u of [USER, OTHER]) {
    await db.delete(crmRecords).where(eq(crmRecords.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll work contact checks passed.");
});
```

Register `"smoke-work-contacts": "pglite",` in `MANIFEST`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/run-smoke.ts --only smoke-work-contacts`
Expected: FAIL — `../src/lib/crm/work-contacts` not found.

- [ ] **Step 3: The SQL and the release check**

Create `src/lib/crm/work-contacts.ts`:

```ts
/**
 * "Work contacts": contacts a connected CRM synced — the ones with a `crm_records` row.
 *
 * A WHERE fragment for a query `FROM contacts`. The owner's id is bound as a parameter rather
 * than correlated to `contacts.user_id`, so the tenant predicate lives inside the subquery
 * whatever the planner does with it (the warm-path rules explain why that matters).
 */
import { sql, type SQL } from "drizzle-orm";

export function workContactsCondition(userId: string): SQL {
  return sql`exists (select 1 from crm_records cr where cr.contact_id = contacts.id and cr.user_id = ${userId})`;
}
```

`src/lib/surface-visibility.ts`, after `requireReleasedSurface`:

```ts
/** The boolean form of `requireReleasedSurface`: switched on AND not coming soon for this viewer. */
export async function isSurfaceReleased(userId: string, surfaceKey: string): Promise<boolean> {
  if (isAlwaysVisible(surfaceKey)) return true;
  const { hidden, comingSoon } = await resolveSurfaceVisibility(userId);
  return !hidden.has(surfaceKey) && !comingSoon.has(surfaceKey);
}
```

In `src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx`, the `teamPillPromise` becomes `Promise.all([getViewerTeam(u), isSurfaceReleased(u, "page.leads")])` → `membership !== null && released` (import `isSurfaceReleased` in place of `resolveSurfaceVisibility` if nothing else uses it). `scripts/smoke-leads-page.ts` checks this file for `comingSoon.has("page.leads")` and `hidden.has("page.leads")` — replace that check with `contactPage.includes('isSurfaceReleased(u, "page.leads")')`, same message.

- [ ] **Step 4: The pill**

`src/lib/people-nav.ts`:

```ts
export const PEOPLE_NAV_COOKIE = "orbit_people_nav";

/** The people views, left to right as the toggle shows them. */
export const PEOPLE_VIEWS = ["contacts", "work", "recruiters"] as const;
export type PeopleView = (typeof PEOPLE_VIEWS)[number];

/** Direction for people-list transitions (View Transition typed): rightward is forward. */
export function directionForPeopleNav(from: PeopleView, to: PeopleView): -1 | 0 | 1 {
  const delta = PEOPLE_VIEWS.indexOf(to) - PEOPLE_VIEWS.indexOf(from);
  return delta === 0 ? 0 : delta > 0 ? 1 : -1;
}
```

(keep `markPeopleNavInBrowser` / `clearPeopleNavInBrowser` as they are).

`src/components/contacts/people-list-shell.tsx`:
- import `type PeopleView` from `@/lib/people-nav`
- `const OPTIONS: Array<{ key: PeopleView; href: string; label: string }> = [ { key: "contacts", href: "/contacts", label: "Contacts" }, { key: "work", href: "/contacts?view=work", label: "Work" }, { key: "recruiters", href: "/recruiters", label: "Recruiters" } ];`
- `PeopleViewToggle` takes `showWork: boolean`, renders `OPTIONS.filter((o) => showWork || o.key !== "work")`, types `visual`/`onNavigate` with `PeopleView`, and sizes the tablist `showWork ? "w-[16.5rem]" : "w-[11.5rem]"` (three equal segments of the same width as two)
- `PeopleListShell` props: `active: PeopleView; showWork?: boolean;` (default false); pass it through; prefetch `/contacts?view=work` too when `showWork`
- `navigateTo(key: PeopleView, href: string)`

- [ ] **Step 5: The list**

`src/lib/contacts-page.ts` `ContactsPageFilters`: add

```ts
  /** Only contacts a connected CRM synced ("work contacts"). Ignored while Leads is not released. */
  work?: true;
```

`src/actions/contacts.ts` `listContactsPage`: import `workContactsCondition` and `isSurfaceReleased`; after the `followUp` condition add

```ts
  // Work contacts are a Leads feature: while Leads is closed to this viewer the flag reads as
  // the plain list, the same as the pill that would have set it.
  if (filters?.work && (await isSurfaceReleased(userId, "page.leads"))) {
    conditions.push(workContactsCondition(userId));
  }
```

(`countContacts(and(...conditions))` then counts work contacts too — no other change.)

`src/components/contacts/contacts-list.tsx`: add `work?: true;` to `ContactsListFilters`; in `seekToLetter` add `if (filters.work) params.set("view", "work");` after the `followUp` line; and at the top of the empty-state branch:

```tsx
  if (contacts.length === 0 && filters.work) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        No work contacts yet. Connect HubSpot on the{" "}
        <Link href="/leads" className="text-primary underline">
          Leads page
        </Link>{" "}
        and your customers show up here.
      </div>
    );
  }
```

`src/components/contacts/contacts-filters.tsx`: add a `view?: "work"` prop; in `apply()` after the `followUp` line add `if (view === "work") params.set("view", "work");`.

`src/app/(clerk)/(app)/(main)/contacts/page.tsx`:
- `searchParams` type gains `view?: string`
- import `requireUserId` from `@/lib/auth` and `isSurfaceReleased` from `@/lib/surface-visibility`
- after `const params = await searchParams;`:

```ts
  // The Work pill follows Leads' release, like the team pill on a contact page. A `view=work`
  // link opened while Leads is closed is simply the plain list.
  const showWork = await isSurfaceReleased(await requireUserId(), "page.leads");
  const work = showWork && params.view === "work";
```

- `filters` gains `work: work ? (true as const) : undefined,`
- `<PeopleListShell active={work ? "work" : "contacts"} showWork={showWork} title={work ? "Work contacts" : "Contacts"}` and the subtitle, when `work`, reads `page.total === null ? "From your CRM" : \`${page.total.toLocaleString()} ${page.total === 1 ? "person" : "people"} from your CRM\``
- `<ContactsFilters … view={work ? "work" : undefined}>`
- the list key becomes `[params.q, params.company, params.minScore, params.followUp, sort, work ? "work" : ""].join("|")`

`src/app/(clerk)/(app)/(main)/recruiters/page.tsx`: hoist `const userId = await requireUserId();`, use it for `getEntitlements(userId)`, and pass `showWork={await isSurfaceReleased(userId, "page.leads")}` to `PeopleListShell` (compute it into a const next to the other awaits).

- [ ] **Step 6: Run to verify it passes**

Run: `npx tsc --noEmit -p . > /tmp/p4-t13-tsc.txt 2>&1; echo tsc=$?` then `npx tsx scripts/run-smoke.ts --check && npx tsx scripts/run-smoke.ts --only smoke-work-contacts smoke-leads-page smoke-surface-visibility smoke-contacts-page`
(`smoke-contacts-page` only if it exists in `MANIFEST`; otherwise run the other three.)
Expected: `tsc=0`; all passed.

- [ ] **Step 7: Commit**

```bash
git add src/lib/crm/work-contacts.ts src/lib/surface-visibility.ts src/lib/people-nav.ts src/components/contacts/people-list-shell.tsx src/lib/contacts-page.ts src/actions/contacts.ts src/components/contacts/contacts-filters.tsx src/components/contacts/contacts-list.tsx "src/app/(clerk)/(app)/(main)/contacts/page.tsx" "src/app/(clerk)/(app)/(main)/recruiters/page.tsx" "src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx" scripts/smoke-work-contacts.ts scripts/smoke-leads-page.ts scripts/run-smoke.ts
git commit -m "Add a Work view to Contacts: the people your CRM synced, while Leads is released

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: The demo HubSpot

On localhost the demo account gets a HubSpot connection that never syncs (no token, `next_sync_at` null, `account_ref` = `DEMO_CRM_ACCOUNT_REF`), written through the REAL page write path: four customers who match four existing demo contacts (so the Work view has people), and two CRM leads — one a teammate knows (so a CRM lead shows a warm path), one cold. Local database only, by the P3 rule.

**Files:**
- Create: `src/lib/demo-data/crm.ts`
- Modify: `src/lib/demo-data/seed.ts` (a `crm` step after `team`)
- Test: `scripts/smoke-demo-data.ts`

**Interfaces:**
- Consumes: `persistCrmPage` (Task 9), `upsertConnectorConnection`, `getConnectorConnection`, `openIngestContext`/`finalizeIngest`, `DEMO_CRM_ACCOUNT_REF` (Task 12), `demoTeamAllowed` (P3).
- Produces (from `@/lib/demo-data/crm`): `DEMO_CRM_LABEL = "orbit-demo.hubspot.com"`, `type DemoCrmPerson`, `DEMO_CRM_PEOPLE`, `demoCrmPeople(): CrmPerson[]`.

- [ ] **Step 1: Write the failing checks**

`scripts/smoke-demo-data.ts`:
- import `connectorConnections`, `crmRecords` from the schema, `DEMO_CRM_PEOPLE` from `../src/lib/demo-data/crm`, and `workContactsCondition` from `../src/lib/crm/work-contacts`; add `crmRecords, connectorConnections` to the front of `cleanup()`'s table list (before `leads`)
- change the existing lead-count check to count only non-CRM leads:

```ts
    const handLeads = pipeline.rows.filter((r) => r.lead.source !== "crm");
    check(`the demo leads are seeded (${DEMO_LEADS.length})`, handLeads.length === DEMO_LEADS.length, String(handLeads.length));
```

(and build `warmthOf` from `handLeads`)
- append after the demo-team block:

```ts
    console.log("\nthe demo HubSpot");
    const [crmConn] = await db.select().from(connectorConnections).where(and(eq(connectorConnections.userId, FRESH), eq(connectorConnections.connectorId, "hubspot")));
    check("a demo HubSpot connection exists", crmConn?.accountRef === "orbit-demo" && crmConn?.label === "orbit-demo.hubspot.com");
    check("it is never armed for the scheduler", crmConn?.nextSyncAt === null);
    check("it holds no token", crmConn?.accessTokenEncrypted === null && crmConn?.refreshTokenEncrypted === null);
    const customers = DEMO_CRM_PEOPLE.filter((p) => p.lifecycle === "customer");
    const work = await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.userId, FRESH), workContactsCondition(FRESH)));
    check(`the ${customers.length} customers are work contacts`, work.length === customers.length, String(work.length));
    check("…matched to demo contacts, not duplicated", (await contactCount(FRESH)) === DEMO_PEOPLE.length, String(await contactCount(FRESH)));
    const crmLeads = pipeline.rows.filter((r) => r.lead.source === "crm");
    check("the CRM leads joined the pipeline", crmLeads.length === DEMO_CRM_PEOPLE.length - customers.length, String(crmLeads.length));
    check("one of them has a warm path through the team", crmLeads.some((r) => r.path?.warmth === "cool" || r.path?.warmth === "warm" || r.path?.warmth === "hot"));
    check("each CRM lead links to its HubSpot record", crmLeads.every((r) => r.crm?.label === "HubSpot" && r.crm.url.startsWith("https://app.hubspot.com/")));
    check("the demo HubSpot is never seeded into a shared database", !demoTeamAllowed({ DATABASE_URL: "postgres://shared.example/orbit" }));
```

(`pipeline` is the `loadPipeline(FRESH)` result already computed in the team block; if the team block computes it after this point, move this block below it. Import `DEMO_PEOPLE` if the file does not already.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/run-smoke.ts --only smoke-demo-data`
Expected: FAIL — `../src/lib/demo-data/crm` not found.

- [ ] **Step 3: Implement**

Create `src/lib/demo-data/crm.ts`:

```ts
/**
 * The demo HubSpot: a connection that never syncs, four customers who are already in the demo
 * network (so the Work view has people), and two CRM leads — one a demo teammate knows, one
 * nobody does. Seeded through `persistCrmPage`, the same write path a real sync uses.
 */
import { hubspotRecordUrl } from "@/lib/crm/hubspot/mapping";
import type { CrmPerson } from "@/lib/crm/types";

export const DEMO_CRM_LABEL = "orbit-demo.hubspot.com";
const DEMO_PORTAL = "1000";

export type DemoCrmPerson = {
  remoteId: string;
  displayName: string;
  email: string;
  companyName: string;
  title: string;
  lifecycle: "customer" | "lead";
};

export const DEMO_CRM_PEOPLE: readonly DemoCrmPerson[] = [
  // Customers: the four demo contacts with an email, so the match is exact.
  { remoteId: "101", displayName: "Sarah Chen", email: "sarah.chen@example.com", companyName: "OpenAI", title: "Partnerships Lead", lifecycle: "customer" },
  { remoteId: "102", displayName: "Marcus Lee", email: "marcus.lee@example.com", companyName: "Stripe", title: "Technical Recruiter", lifecycle: "customer" },
  { remoteId: "103", displayName: "James Okafor", email: "james@bellwether.example", companyName: "Bellwether Ventures", title: "Partner", lifecycle: "customer" },
  { remoteId: "104", displayName: "Maya Thompson", email: "maya.thompson@example.com", companyName: "Innovate Carolina", title: "Program Director", lifecycle: "customer" },
  // Leads: Alex knows Leo (outer), so this one arrives with a path; nobody knows Nora.
  { remoteId: "201", displayName: "Leo Martins", email: "leo@northwind.example", companyName: "Northwind Health", title: "Procurement Lead", lifecycle: "lead" },
  { remoteId: "202", displayName: "Nora Quinn", email: "nora@harborline.example", companyName: "Harborline", title: "COO", lifecycle: "lead" },
];

export function demoCrmPeople(): CrmPerson[] {
  return DEMO_CRM_PEOPLE.map((p) => ({
    remoteType: "contact",
    remoteId: p.remoteId,
    lifecycle: p.lifecycle,
    stage: p.lifecycle,
    displayName: p.displayName,
    email: p.email,
    phone: null,
    linkedinUrl: null,
    companyName: p.companyName,
    companyDomain: null,
    title: p.title,
    remoteOwnerRef: "demo-owner",
    remoteUrl: hubspotRecordUrl(DEMO_PORTAL, p.remoteId),
    lastActivityAt: null,
    remoteCreatedAt: null,
    remoteUpdatedAt: null,
    properties: {},
  }));
}
```

`src/lib/demo-data/seed.ts`:
- imports: `and` is already imported from drizzle-orm; add `connectorConnections` to the schema import; `getConnectorConnection, upsertConnectorConnection` from `@/lib/connectors/connections`; `persistCrmPage` from `@/lib/crm/persist`; `DEMO_CRM_ACCOUNT_REF` from `@/lib/crm/types`; `finalizeIngest, openIngestContext` from `@/lib/ingest/events`; `DEMO_CRM_LABEL, demoCrmPeople` from `@/lib/demo-data/crm`
- add `["crm", () => seedCrm(userId, summary)],` after the `team` entry
- after `seedTeam`:

```ts
/**
 * The demo HubSpot. Local database only, for the reason the demo team is: a fake connection on
 * a shared database would show a real account a HubSpot it never connected. No token and
 * `next_sync_at` null, so the scheduler never claims it; "Sync now" and disconnect recognise
 * `DEMO_CRM_ACCOUNT_REF` and never call HubSpot.
 */
async function seedCrm(userId: string, summary: DemoSeedSummary): Promise<void> {
  if (!demoTeamAllowed()) return;
  if (await getConnectorConnection(userId, "hubspot")) return;
  await upsertConnectorConnection({
    userId,
    connectorId: "hubspot",
    authKind: "oauth2",
    label: DEMO_CRM_LABEL,
    accountRef: DEMO_CRM_ACCOUNT_REF,
    capabilities: ["syncPeople"],
    nextSyncAt: null,
  });
  const db = await getDb();
  await db
    .update(connectorConnections)
    .set({ lastSyncedAt: new Date(Date.now() - 12 * 60_000) })
    .where(and(eq(connectorConnections.userId, userId), eq(connectorConnections.connectorId, "hubspot")));
  const ctx = await openIngestContext(userId, { source: "hubspot", createsContacts: true, reportResolutions: true });
  const stats = await persistCrmPage(ctx, "hubspot", demoCrmPeople());
  await finalizeIngest(ctx);
  summary.crmRecords = stats.records;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc --noEmit -p . > /tmp/p4-t14-tsc.txt 2>&1; echo tsc=$?` then `npx tsx scripts/run-smoke.ts --only smoke-demo-data smoke-crm-leads smoke-leads`
Expected: `tsc=0`; `3/3 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/demo-data/crm.ts src/lib/demo-data/seed.ts scripts/smoke-demo-data.ts
git commit -m "Seed a demo HubSpot on localhost: four work contacts and two CRM leads, never synced

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: Whole-branch verification, the browser, and the PR (controller)

- [ ] **Step 1: Suite, types, lint, build**

```bash
npx tsc --noEmit -p . > /tmp/p4-tsc.txt 2>&1; echo tsc=$?
npm run lint > /tmp/p4-lint.txt 2>&1; echo lint=$?; tail -3 /tmp/p4-lint.txt
npx tsx scripts/run-smoke.ts --check
npm test > /tmp/p4-suite.txt 2>&1; echo suite=$?; grep -E "^ *FAIL|passed in" /tmp/p4-suite.txt
npm run build > /tmp/p4-build.txt 2>&1; echo build=$?
```

Expected: `tsc=0`, lint 0 errors (baseline ~46 warnings), check passes, `suite=0` with every script passed, `build=0` and `/api/connectors/[connectorId]/callback` in the route list. A lone `smoke-constellation-match` / `smoke-admin-render` timeout under load is the known flake: rerun it alone. Then `rm -rf .next` before any `next dev` (a build wedges the dev server's chunks).

- [ ] **Step 2: Schema rescan** — `bash -c` loop over `git for-each-ref` and `git worktree list` (the P3 command); 94 must still be unclaimed elsewhere. If it is taken, take the next free number, update the changelog line, rerun `smoke-schema-ddl --update`, and rerun the schema smokes.

- [ ] **Step 3: Browser (the built-in browser pane)** — `mv .data/pglite .data/pglite-before-p4` (P3's move left `.data/pglite-before-p3`; keep both), start the dev server via `preview_start`, sign in as the demo account, set `document.cookie = "orbit_preview_unreleased=1; path=/"`, and check:
  1. `/leads` without the cookie: coming soon. With it: the CRM card reads "HubSpot · orbit-demo.hubspot.com", "Last synced 12 minutes ago", "4 work contacts · 2 in your pipeline", "Sample data — this demo connection doesn’t sync."
  2. The pipeline shows Leo Martins with a path through Alex and Nora Quinn cold; opening Leo's sheet shows "Open in HubSpot" → `https://app.hubspot.com/contacts/1000/record/0-1/201`.
  3. "See work contacts" → `/contacts?view=work`: title "Work contacts", 4 people, the Work pill selected; the pill slides between Contacts / Work / Recruiters; searching inside Work keeps `view=work`; the A–Z rail keeps it.
  4. Clearing the cookie: `/contacts` shows only Contacts / Recruiters, and `/contacts?view=work` is the full list.
  5. "Disconnect" → the dialog → confirm: the card returns to "Connect your CRM" / "HubSpot isn’t set up on this server yet" (no HubSpot env locally); the Work view is empty with the Leads link; the four contacts still exist; Leo and Nora stay as leads.
  6. `/leads?crm=error&reason=not_entitled` toasts the upgrade line once; `?crm=connected` toasts the connected line.
  7. 375px: no horizontal scroll on `/leads` or `/contacts?view=work`; the three-way pill fits.
  8. Console: no errors beyond the known dev noise.

- [ ] **Step 4: Final whole-branch review** — dispatch a reviewer over `git diff 63f2e17e..HEAD` (the P4 commits only, not the spine merge) with the spec, this plan and the rulings; fix what it finds in one wave; audit every commit trailer (`git log --format=%B 63f2e17e..HEAD | grep Co-Authored-By | sort | uniq -c` — exactly `Claude Opus 5.5`).

- [ ] **Step 5: PR** — push `claude/leads-p4-hubspot`; `gh pr create --base claude/leads-p3-pipeline`; the body says it carries PR #262's diff (the spine) until #262 merges and lists: what ships, rulings 1–14, verification, the manual steps (create the HubSpot project app with `hs project create`, required scopes, redirect URL, env vars on Vercel; the first real round trip against a HubSpot developer test account is still owed), and the HubSpot facts to re-verify on the first real run (sorting and filtering on `lastmodifieddate`, the token response's `hub_id`, owner lookup by `idProperty=userId`). Ends with the Claude Code line.
