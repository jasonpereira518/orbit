# Leads P5: Salesforce Read Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A salesperson on a paid plan connects Salesforce (production or a sandbox) from the `/leads` page, next to HubSpot; every 30 minutes Orbit reads the Contacts and Leads they own, turns Contacts into work contacts and Leads into the Leads pipeline, through the same provider-agnostic write path P4 built. Everything stays behind the coming-soon gate.

**Architecture:** Salesforce differs from HubSpot in four ways that reach the spine: every API, refresh and revoke call goes to the org's own `instance_url` (stored on a new `connector_connections.instance_url` column, schema v124); the login host differs for sandboxes (a signed `variant` in the OAuth state); the app must use PKCE (the verifier is derived from the state's nonce with a server key, so nothing is stored); and the token response carries no `expires_in` (refresh is reactive only, on a 401 — `openConnectorAuth` already does that). The rest is a Salesforce module shaped like HubSpot's — pure `mapping.ts`, database-free `api.ts`, `sync.ts` — and a CRM layer (`types`, `connect`, `manage`, actions, card) that now answers for two providers.

**Tech Stack:** Next.js 16 App Router (Server Components, Server Actions, one route handler), React 19, Tailwind v4, Base UI kit in `src/components/ui/`, Drizzle on Postgres/PGlite, runtime DDL in `src/db/index.ts`, `tsx` smokes registered in `scripts/run-smoke.ts`, Salesforce REST API v66.0 + OAuth 2.0 web server flow with PKCE.

**Spec:** `docs/superpowers/specs/2026-09-22-leads-design.md` (Decisions, Modules, CRM sync; phase table row P5: "Salesforce read sync: OAuth variants (sandbox), PKCE, `instance_url` capture, SOQL"). P4's plan `docs/superpowers/plans/2026-09-23-leads-p4-hubspot.md` built everything this one generalizes — read its Rulings; they all still hold unless one below overrides it.

**Branch:** `claude/leads-p5-salesforce`, stacked on `claude/leads-p4-hubspot` (PR #279). The PR targets `claude/leads-p4-hubspot`.

## Verified Salesforce facts (Sept 2026)

- New **Connected Apps can no longer be created** (Spring '26); new integrations use an **External Client App (ECA)**. Settings: callback URL, OAuth scopes `api refresh_token id`, "Require Secret for Web Server Flow" on, "Require PKCE" on, refresh token policy "valid until revoked". Creating it is a manual step for Jason (Task 9 lists it).
- Authorize: `https://login.salesforce.com/services/oauth2/authorize` (production) or `https://test.salesforce.com/services/oauth2/authorize` (sandbox). Code exchange goes to the SAME host's `/services/oauth2/token`. Params: `response_type=code`, `client_id`, `redirect_uri` (exact match), `scope` (space-separated), `state`, `code_challenge` + `code_challenge_method=S256`.
- Token response: `access_token`, `refresh_token` (authorization-code grant only), `instance_url`, `id` (the identity URL), `token_type`, `issued_at`, `signature`, `scope`. **No `expires_in`** — access tokens live for the org's session timeout, which the API never states.
- Refresh: `POST {instance_url}/services/oauth2/token` works for production and sandbox alike (My Domain). The response has a new `access_token` and `instance_url`, and **no new `refresh_token`** unless the app rotates them.
- Identity URL (`id` field): `GET` with `Authorization: Bearer` returns `user_id`, `organization_id`, `username`, `display_name`, `email`.
- Errors: token endpoint `400 invalid_grant` → reconnect. REST errors are an ARRAY `[{ "message": "…", "errorCode": "…" }]`. `401 INVALID_SESSION_ID` → refresh once. `403 REQUEST_LIMIT_EXCEEDED` → the org's daily API allowance is spent, retry later. `403 API_DISABLED_FOR_ORG` / `API_CURRENTLY_DISABLED` → an admin must act, stop. `400 INVALID_FIELD` → a field the user cannot see (field-level security) or does not exist. `400 MALFORMED_QUERY` → our bug, stop.
- REST v66.0: `GET {instance_url}/services/data/v66.0/query?q=<SOQL>`. `SystemModstamp` is the reliable change marker (system writes move it; `LastModifiedDate` can be preserved by data loads). SOQL supports `ORDER BY SystemModstamp, Id` and comparisons on `Id` (the standard PK-chunking pattern). Datetime literals are unquoted, second precision: `2026-09-26T12:00:00Z`. Record datetimes come back as `2026-09-26T12:00:00.000+0000`.
- Revoke: `POST {instance_url}/services/oauth2/revoke`, form body `token=<refresh token>` — revokes the refresh token and every access token it issued.
- Limits: Enterprise Edition 100k API calls / 24 h + 1k per licence; one sync page is one call.

## Global Constraints

- `SCHEMA_VERSION` goes **123 → 124** in Task 1, with a changelog entry. Rescanned before writing this plan: the highest version on any ref or worktree is 123 (this stack); main is 118, `claude/integrations-ui-pass` 120. The controller rescans every ref and worktree again (`bash -c`, never zsh) before pushing. After any DDL change run `npx tsx scripts/smoke-schema-ddl.ts --update`.
- New column on an existing table: the Drizzle column in `src/db/schema.ts` + the template's `CREATE TABLE` in `src/db/index.ts` + an `alters` `ALTER TABLE … ADD COLUMN IF NOT EXISTS` + `ensureColumn` in `migratePglite` + every other literal `CREATE TABLE IF NOT EXISTS connector_connections` string in `src/db/index.ts` (there is a second one near line 3857 — grep for it). No `--` comments or `;` inside DDL strings. Never `db:push`.
- This repo's `Db` type is a union: write `.returning()` bare and read fields off the full row.
- `src/lib/connectors/registry.ts` stays client-safe: no value import of `@/db`, `next/*`, or any module that reaches them. Pure modules never value-import `@/db`: `src/lib/crm/types.ts`, `src/lib/crm/salesforce/mapping.ts`, `src/lib/crm/hubspot/mapping.ts`, `src/lib/crm/crm-leads-plan.ts`. `src/lib/crm/salesforce/api.ts` is database-free like HubSpot's. Files in `src/components/leads/` never value-import a server module.
- No `import "server-only"` anywhere: the package throws under `tsx`.
- Every export of a `"use server"` file is an `async function`; no `export type`, no `export const`. `src/actions/leads.ts` keeps exactly its 6 exports.
- Writes return `ActionResult` via `asActionResult`; reads return plain data. Every CRM Server Action's first statement is `const userId = await requireLeadsUser();`. Connect and sync check the `crm` entitlement inside `asActionResult`; disconnect never does. The callback route uses `requireCrmUser()`.
- Copy (toasts, `UserFacingError`, `ActionResult` errors, stored `sync_error` lines) passes `smoke-toast-copy`: no trailing period, curly ’ never a straight apostrophe, " — " joins an outcome to a next step, never "could not" or "failed".
- **No provider text reaches a person.** A message Orbit stores in `sync_error` or shows in a toast is a fixed sentence Orbit wrote; a provider's own `message`/`error_description` goes only to `reportError` or an error's `detail` field. (P4's final review parked this — Task 4 fixes HubSpot's side too.)
- Every string literal written into `src/components/leads/`, `src/lib/crm/` is plain UTF-8: curly ’ is E2 80 99, em dash E2 80 94. `scripts/smoke-leads-page.ts` byte-scans `src/components/leads` and `src/lib/crm` (recursively — confirm it picks up `src/lib/crm/salesforce/`; if it only reads one level, extend it in Task 3).
- Network calls take an injectable `fetchImpl` (default `fetch`) and a timeout via `AbortSignal.timeout(15_000)` (5 s for revoke). No smoke reaches the real network.
- A bearer token is only ever sent to an `https:` URL whose host is `salesforce.com`, `force.com` or `cloudforce.com` or ends in `.salesforce.com`, `.force.com` or `.cloudforce.com` (`isTrustedSalesforceUrl`). `instance_url` and the identity URL arrive in a token response and are checked before first use and before storage.
- Every new smoke is registered in `MANIFEST` in `scripts/run-smoke.ts`; `npx tsx scripts/run-smoke.ts --check` passes.
- Never pipe `npm test` through `tail`: zsh reports tail's exit code. Redirect to a file and grep `^ *FAIL`.
- `scripts/smoke-behavior-golden.ts` snapshots `getIntegrationStatuses` and the demo seed. If a task changes either on purpose, re-record with `--update` and say why in the commit; never re-record to silence a difference you cannot explain.
- Implementers never run `next dev`, `next build` or any drizzle push; the controller does the build and the browser check in Task 9.
- Commit after every task with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` — exactly that model name.

## Rulings against the spec (recorded here so reviewers judge them, not rediscover them)

1. **`instance_url` is a column, not cursor meta.** Refresh, revoke and every query need it, and a reconnect resets the cursor; a fact every call depends on does not belong in a value the code throws away. The column is generic (`instance_url`, "the account's own API host, for providers that assign one").
2. **PKCE without storage.** `code_verifier = base64url(HMAC-SHA256(k_pkce, state.nonce))`, `k_pkce = HMAC(ENCRYPTION_SECRET, "orbit:connector-oauth-pkce:v1")`. The state is public (it rides in the authorize URL); the verifier is not derivable without the server key, and the callback recomputes it from the state it was handed. A per-purpose subkey, never the state-signing key (the same domain-separation argument as `STATE_HMAC_LABEL`).
3. **Sandbox is a signed state `variant`.** The authorize host and the code-exchange host must match, and the callback must not trust a query parameter for it. `variant` is signed with the rest of the state. After connect, nothing distinguishes a sandbox: every later call goes to its `instance_url`.
4. **Salesforce Contacts are customers; Leads are leads.** A Salesforce Contact is someone at an account the org already does business with — a work contact. An unconverted Lead joins the pipeline. A **converted** Lead maps to lifecycle `customer` (stage `Converted`), so P4's `planCrmLeads` marks an existing pipeline row `converted`; its person usually also arrives as the Contact it became, and identity matching (email) lands both on one Orbit contact.
5. **Owned records only, filtered in SOQL:** `OwnerId = '<the connecting user's 18-char id>'`. Lead `OwnerId` can be a queue; the filter never matches a queue id, so queue-owned leads are not read (they are nobody's yet).
6. **Keyset paging, not query locators.** `ORDER BY SystemModstamp, Id LIMIT 200` with `(SystemModstamp > t OR (SystemModstamp = t AND Id > id))`. `nextRecordsUrl` locators expire after 15 idle minutes, and a run killed at its time limit would resume on a dead locator. The keyset resumes from the cursor forever. A finished phase rewinds its watermark by 5 minutes (the P4 overlap rule: a transaction committing late can carry an earlier stamp; the upsert is idempotent).
7. **No weekly full re-read.** HubSpot's search index lags and its offset paging drifts; `SystemModstamp` does neither. Reassigning a record TO the user moves its stamp, so it arrives; reassigning it AWAY is P4 Ruling 7 (no deletion propagation until P6).
8. **Field-level security fallback.** A `400 INVALID_FIELD` on the full field list switches that connection to a lean list (identity, name, email, owner, stamps, and Lead's company/status/conversion) for the rest of its life (`meta.lean = "1"`), rather than stopping a sync over a hidden phone field. A reconnect clears it.
9. **Identity is fixed at connect.** The identity URL is called once, in the callback; `organization_id` becomes `account_ref`, `username` the label, and `{ orgId, userId }` seed the cursor's `meta`. A sync whose cursor lost them, or whose `orgId` no longer matches `account_ref`, stops with "reconnect Salesforce" rather than guessing — only a reconnect can produce that state.
10. **No demo Salesforce.** The localhost demo keeps its one HubSpot connection; a second fake CRM would add seed surface and a golden re-record for nothing a reviewer cannot see from the card's own smoke.
11. **The card lists providers, one section each.** Connected providers render the P4 connected/reauth/paused layout under their own name; configured-but-unconnected providers render a connect button; Salesforce's has a secondary "Use a sandbox" button. The OAuth return toast stays provider-neutral ("CRM connected — …"): the callback's redirect carries a code, never a provider name, so the P4 URL contract is unchanged.
12. **P4's parked items land here:** (a) the "Sync now" toast for `needs_reauth` is a fixed sentence, never the token endpoint's text; (b) a sync's catch-path `stop()` checks the lease first, like every other write; (c) provider error detail never reaches a stored `sync_error` — `HubspotApiError`/`SalesforceApiError` messages are fixed sentences and the detail rides on `.detail`.

---

## File map

| File | Responsibility |
|---|---|
| `src/db/schema.ts`, `src/db/index.ts`, `scripts/schema-ddl.lock.json` | `connector_connections.instance_url`, v124 |
| `src/lib/connectors/connections.ts` | `instanceUrl` on the claim, the summary, upsert, `updateConnectorTokens`; `resetConnectorCursor` takes a seed |
| `src/lib/connectors/oauth.ts` | PKCE, `variant`, per-connection token host, the Salesforce provider, `isTrustedInstanceUrl` |
| `src/lib/connectors/token.ts` | refresh against `instance_url`, persist a moved `instance_url` |
| `src/lib/crm/salesforce/mapping.ts` (new, pure) | scopes, fields, host trust, SOQL, keyset progress, record mapping |
| `src/lib/crm/salesforce/api.ts` (new, database-free) | fetch client + `SalesforceApiError`; identity, query, revoke |
| `src/lib/crm/hubspot/api.ts` | fixed-sentence errors, `.detail` |
| `src/lib/crm/types.ts` | `CrmConnectorId`, `CRM_PROVIDERS`, multi-provider `CrmStatus`, `crmErrorLine` for both |
| `src/lib/crm/connect.ts`, `src/app/api/connectors/[connectorId]/callback/route.ts` | Salesforce connect: PKCE, sandbox, identity, `instance_url` |
| `src/lib/crm/salesforce/sync.ts` (new) | `syncSalesforce` |
| `src/lib/crm/hubspot/sync.ts` | lease-guarded catch-path stop |
| `src/lib/connectors/registry.ts`, `syncs.ts`, `status.ts`, `src/actions/integrations.ts` | Salesforce registered, synced, reported |
| `src/lib/crm/manage.ts`, `src/actions/crm.ts` | status, Sync now, disconnect for either provider |
| `src/components/leads/crm-card-view.tsx`, `crm-card.tsx` | the two-provider card |
| `.env.example` | Salesforce env |
| smokes (see each task) | tests |

---

### Task 1: `connector_connections.instance_url` (schema v124) and the connection plumbing

**Files:**
- Modify: `src/db/schema.ts` (`connectorConnections`, ~line 4768)
- Modify: `src/db/index.ts` (`SCHEMA_VERSION`, changelog, template `CREATE TABLE connector_connections`, the second literal near line 3857, `alters`, `migratePglite`'s `ensureColumn` list)
- Modify: `src/lib/connectors/connections.ts`
- Modify: `scripts/schema-ddl.lock.json` (regenerated)
- Test: `scripts/smoke-connector-claim.ts`

**Interfaces:**
- Produces:
  - `ClaimedConnectorConnection.instanceUrl: string | null`
  - `ConnectorConnectionSummary.instanceUrl: string | null`
  - `UpsertConnectorConnectionInput.instanceUrl?: string | null` (omitted → null)
  - `updateConnectorTokens(id, tokens: { accessToken: string; refreshToken: string | null; expiresAt: Date | null; instanceUrl?: string | null })` — a non-null `instanceUrl` replaces the stored one; null/omitted keeps it
  - `resetConnectorCursor(userId: string, connectorId: string, seed?: ConnectorSyncCursor | null): Promise<void>` — stores `seed ?? null`

- [ ] **Step 1: Write the failing checks.** Read `scripts/smoke-connector-claim.ts` to see its `check` helper and how it upserts a connection and claims it. Append a block (inside its `run`, before the failure summary):

```ts
  // --- instance_url (Leads P5) ---------------------------------------------------------
  const SF_USER = "smoke-claim-instance";
  await upsertConnectorConnection({
    userId: SF_USER, connectorId: "salesforce", authKind: "oauth2", label: "ada@acme.com",
    accountRef: "00D000000000001", accessToken: "at-1", refreshToken: "rt-1",
    instanceUrl: "https://acme.my.salesforce.com",
  });
  const sfSummary = await getConnectorConnection(SF_USER, "salesforce");
  check("the summary carries instance_url", sfSummary?.instanceUrl === "https://acme.my.salesforce.com", String(sfSummary?.instanceUrl));
  const sfClaim = await claimConnectorConnectionForUser(SF_USER, "salesforce");
  check("the claim carries instance_url", sfClaim?.instanceUrl === "https://acme.my.salesforce.com", String(sfClaim?.instanceUrl));
  await updateConnectorTokens(sfClaim!.id, { accessToken: "at-2", refreshToken: null, expiresAt: null });
  check("a refresh without instance_url keeps it", (await getConnectorConnection(SF_USER, "salesforce"))?.instanceUrl === "https://acme.my.salesforce.com");
  await updateConnectorTokens(sfClaim!.id, { accessToken: "at-3", refreshToken: null, expiresAt: null, instanceUrl: "https://acme2.my.salesforce.com" });
  check("a refresh that names a new instance_url stores it", (await getConnectorConnection(SF_USER, "salesforce"))?.instanceUrl === "https://acme2.my.salesforce.com");
  await resetConnectorCursor(SF_USER, "salesforce", { meta: { orgId: "00D000000000001", userId: "005000000000001" } });
  const seeded = await claimConnectorConnectionForUser(SF_USER, "salesforce", new Date(Date.now() + 60 * 60 * 1000));
  check("resetConnectorCursor stores the seed", seeded?.cursor?.meta?.userId === "005000000000001", JSON.stringify(seeded?.cursor));
  await resetConnectorCursor(SF_USER, "salesforce");
  const cleared = await getDb().then((db) => db.query.connectorConnections.findFirst({ where: eq(connectorConnections.userId, SF_USER) }));
  check("and without one clears it", cleared?.syncCursor === null, JSON.stringify(cleared?.syncCursor));
  await upsertConnectorConnection({ userId: SF_USER, connectorId: "salesforce", authKind: "oauth2", accessToken: "at-4" });
  check("an upsert without instance_url clears it", (await getConnectorConnection(SF_USER, "salesforce"))?.instanceUrl === null);
```

Add any missing imports (`getConnectorConnection`, `claimConnectorConnectionForUser`, `updateConnectorTokens`, `resetConnectorCursor`, `upsertConnectorConnection` from `../src/lib/connectors/connections`; `getDb`; `connectorConnections`; `eq`) and add `SF_USER`'s rows to whatever cleanup the smoke does at its start (it deletes its users' rows first — follow that pattern). The seeded claim passes a `now` an hour ahead so the previous claim's lease has lapsed.

- [ ] **Step 2: Run it to verify it fails.** `npx tsx scripts/smoke-connector-claim.ts` → TypeScript/`tsx` errors on `instanceUrl` (unknown property) or FAIL lines.

- [ ] **Step 3: Schema.** In `src/db/schema.ts`, `connectorConnections`, directly after `accountRef`:

```ts
    /**
     * The account's own API host, for providers that assign one (Salesforce's `instance_url`).
     * Every API, refresh and revoke call for the row goes here. Checked against the provider's
     * trusted hosts before it is stored — a bearer token is sent to it.
     */
    instanceUrl: text("instance_url"),
```

- [ ] **Step 4: DDL.** In `src/db/index.ts`:
  - `SCHEMA_VERSION` 123 → 124, and a changelog line after 123's in the same style: `// 124 = connector_connections.instance_url: the account's own API host (Leads P5, Salesforce).`
  - In the template's `CREATE TABLE IF NOT EXISTS connector_connections (…)`, add `instance_url text,` after `account_ref text,`. Do the same in every other literal `CREATE TABLE IF NOT EXISTS connector_connections` string in the file (grep; there is one near line 3857).
  - In `alters`, after the v123 entries, with a `// v124` comment: `` `ALTER TABLE connector_connections ADD COLUMN IF NOT EXISTS instance_url text`, ``
  - In `migratePglite`, add `ensureColumn` for `connector_connections.instance_url text` next to the other connector_connections / v123 columns (follow the existing call shape exactly).

- [ ] **Step 5: Plumbing** in `src/lib/connectors/connections.ts`:
  - `ClaimedConnectorConnection`: add `instanceUrl: string | null;` after `accountRef` (doc: "The account's own API host (Salesforce). Null for providers with one global host.").
  - `ClaimRow`: add `instance_url: string | null;`. Every claim query's `RETURNING` (or `SELECT`) list that feeds `toClaimed` gets `instance_url` — grep for `refresh_token_encrypted` inside SQL strings in this file to find them all (`claimDueConnectorConnections`, `claimConnectorConnectionForUser`). `toClaimed`: `instanceUrl: row.instance_url ?? null,`.
  - `UpsertConnectorConnectionInput`: add `instanceUrl?: string | null;`; in `upsertConnectorConnection`'s `values`: `instanceUrl: input.instanceUrl ?? null,` (it is also in the conflict `set`, if that set is built from `values` — confirm it is; a reconnect must replace it).
  - `updateConnectorTokens`: widen `tokens` with `instanceUrl?: string | null` and add `...(tokens.instanceUrl ? { instanceUrl: tokens.instanceUrl } : {}),` to the `set`.
  - `resetConnectorCursor(userId, connectorId, seed: ConnectorSyncCursor | null = null)`: `.set({ syncCursor: seed, updatedAt: new Date() })`. Update its doc comment: "A seed replaces the cursor with facts the next sync needs from the connect (Salesforce's org and user ids)."
  - `ConnectorConnectionSummary`: add `instanceUrl: string | null;` and `instanceUrl: connectorConnections.instanceUrl,` to `listConnectorConnections`' select. It is not a secret.

- [ ] **Step 6: Regenerate the lock and run.**

```bash
npx tsx scripts/smoke-schema-ddl.ts --update
npx tsx scripts/smoke-schema-ddl.ts
npx tsx scripts/smoke-connector-claim.ts
npx tsx scripts/smoke-connector-sync-pass.ts
npx tsc --noEmit -p .
```

Expected: all pass, tsc prints nothing. If tsc flags other constructions of `ClaimedConnectorConnection` (smokes building one by hand, e.g. `scripts/smoke-connector-token.ts`, `scripts/smoke-crm-sync.ts`), add `instanceUrl: null` there.

- [ ] **Step 7: Commit.** `git add -A src/db src/lib/connectors/connections.ts scripts && git commit -m "Store each connection's own API host (connector_connections.instance_url, schema 124)"` plus the trailer.

---

### Task 2: OAuth — PKCE, a sandbox variant, a per-connection token host, and the Salesforce provider

**Files:**
- Create: `src/lib/crm/salesforce/mapping.ts` — ONLY the host-trust part in this task (the rest is Task 3)
- Modify: `src/lib/connectors/oauth.ts`
- Modify: `src/lib/connectors/token.ts`
- Test: `scripts/smoke-connector-oauth.ts`, `scripts/smoke-connector-token.ts`

**Interfaces:**
- Consumes: Task 1's `ClaimedConnectorConnection.instanceUrl`, `updateConnectorTokens({ …, instanceUrl })`.
- Produces (all from `@/lib/connectors/oauth` unless noted):
  - `SALESFORCE_HOST_SUFFIXES: readonly string[]`, `isTrustedSalesforceUrl(url: string | null | undefined): url is string` — from `@/lib/crm/salesforce/mapping`
  - `OAuthProviderConfig` gains `pkce?: boolean`, `variants?: Record<string, { authorizeUrl: string; tokenUrl: string }>`, `instanceTokenPath?: string`, `trustInstanceUrl?: (url: string) => boolean`
  - `OAUTH_PROVIDERS.salesforce`
  - `OAuthState.variant?: string`
  - `buildAuthorizeUrl(connectorId, { userId, redirectUri, scopes, returnTo, variant? })` — adds `code_challenge`/`code_challenge_method=S256` when the provider has `pkce`
  - `pkceVerifierForState(rawState: string | null | undefined): string | null` — null for an invalid/expired state
  - `exchangeCode(connectorId, code, redirectUri, opts: { fetchImpl?; codeVerifier?: string; variant?: string })`
  - `refreshAccessToken(connectorId, refreshToken, opts: { fetchImpl?; instanceUrl?: string | null })`
  - `isTrustedInstanceUrl(connectorId: string, url: string | null | undefined): url is string`
  - `ConnectorAuthDeps.refresh?: (connectorId: string, refreshToken: string, instanceUrl: string | null) => Promise<OAuthTokens>` (third parameter added)

- [ ] **Step 1: The host-trust helper.** Create `src/lib/crm/salesforce/mapping.ts` with this header and the first export (Task 3 appends the rest):

```ts
/**
 * Salesforce, pure: the scopes and fields Orbit asks for, which hosts a token may be sent to,
 * the SOQL a sync runs, the keyset progress it carries across runs, and what a record becomes.
 *
 * Built on REST API v66.0. `instance_url` and the identity URL arrive in a token response;
 * both are checked with `isTrustedSalesforceUrl` before a bearer token goes near them.
 */

/** A token response names the org's host; nothing outside these domains is ever sent a token. */
export const SALESFORCE_HOST_SUFFIXES = ["salesforce.com", "force.com", "cloudforce.com"] as const;

export function isTrustedSalesforceUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return false;
    const host = parsed.hostname.toLowerCase();
    return SALESFORCE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Write the failing checks.** Read `scripts/smoke-connector-oauth.ts` for its helpers (it stubs `fetchImpl` and sets `HUBSPOT_CLIENT_ID`-style env). Add at its top, next to the existing env lines: `process.env.SALESFORCE_CLIENT_ID = "sf-cid"; process.env.SALESFORCE_CLIENT_SECRET = "sf-secret";`. Append a block:

```ts
  // --- Salesforce: PKCE, sandbox variant, instance token host (Leads P5) ----------------
  {
    const url = new URL(buildAuthorizeUrl("salesforce", { userId: "u1", redirectUri: "https://orbit.test/cb", scopes: ["api", "refresh_token", "id"], returnTo: "/leads" }));
    check("production authorizes at login.salesforce.com", url.origin === "https://login.salesforce.com" && url.pathname === "/services/oauth2/authorize", url.href);
    const state = url.searchParams.get("state");
    const verifier = pkceVerifierForState(state);
    check("the state yields a verifier", typeof verifier === "string" && /^[A-Za-z0-9_-]{43}$/.test(verifier ?? ""), String(verifier));
    const challenge = createHash("sha256").update(verifier ?? "").digest("base64url");
    check("the challenge is S256 of that verifier", url.searchParams.get("code_challenge") === challenge && url.searchParams.get("code_challenge_method") === "S256");
    check("the verifier is stable for one state", pkceVerifierForState(state) === verifier);
    const other = new URL(buildAuthorizeUrl("salesforce", { userId: "u1", redirectUri: "https://orbit.test/cb", scopes: ["api"], returnTo: "/leads" })).searchParams.get("state");
    check("and differs between states", pkceVerifierForState(other) !== verifier);
    check("a tampered state yields none", pkceVerifierForState(`${state}x`) === null);
    check("the verifier never appears in the URL", !url.href.includes(verifier ?? "∅"));

    const sandbox = new URL(buildAuthorizeUrl("salesforce", { userId: "u1", redirectUri: "https://orbit.test/cb", scopes: ["api"], returnTo: "/leads", variant: "sandbox" }));
    check("a sandbox authorizes at test.salesforce.com", sandbox.origin === "https://test.salesforce.com", sandbox.href);
    check("the variant is signed into the state", parseOAuthState(sandbox.searchParams.get("state"))?.variant === "sandbox");
    check("an unknown variant is refused", (() => { try { buildAuthorizeUrl("salesforce", { userId: "u1", redirectUri: "x", scopes: [], returnTo: "/", variant: "nope" }); return false; } catch { return true; } })());

    const hub = new URL(buildAuthorizeUrl("hubspot", { userId: "u1", redirectUri: "https://orbit.test/cb", scopes: ["a"], returnTo: "/leads" }));
    check("HubSpot sends no PKCE challenge", !hub.searchParams.has("code_challenge"));

    const seen: Array<{ url: string; body: string }> = [];
    const tokenStub = (json: object, status = 200): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const sfToken = { access_token: "at", refresh_token: "rt", instance_url: "https://acme.my.salesforce.com", id: "https://login.salesforce.com/id/00D1/0051", token_type: "Bearer", issued_at: "1790000000000", signature: "sig" };

    const tokens = await exchangeCode("salesforce", "code-1", "https://orbit.test/cb", { fetchImpl: tokenStub(sfToken), codeVerifier: verifier!, variant: "sandbox" });
    check("a sandbox exchange goes to test.salesforce.com", seen.at(-1)?.url === "https://test.salesforce.com/services/oauth2/token", seen.at(-1)?.url);
    check("and sends the verifier", new URLSearchParams(seen.at(-1)?.body).get("code_verifier") === verifier);
    check("no expires_in means no expiry", tokens.expiresAt === null);
    check("instance_url and id ride in extra", tokens.extra?.instance_url === "https://acme.my.salesforce.com" && tokens.extra?.id === sfToken.id);

    await refreshAccessToken("salesforce", "rt", { fetchImpl: tokenStub({ access_token: "at2", instance_url: "https://acme.my.salesforce.com" }), instanceUrl: "https://acme.my.salesforce.com" });
    check("a refresh goes to the org's own host", seen.at(-1)?.url === "https://acme.my.salesforce.com/services/oauth2/token", seen.at(-1)?.url);
    await refreshAccessToken("salesforce", "rt", { fetchImpl: tokenStub({ access_token: "at3" }) });
    check("without one it goes to login.salesforce.com", seen.at(-1)?.url === "https://login.salesforce.com/services/oauth2/token", seen.at(-1)?.url);
    const refused = await refreshAccessToken("salesforce", "rt", { fetchImpl: tokenStub({ access_token: "x" }), instanceUrl: "https://evil.example" }).then(() => null, (e: unknown) => e);
    check("an untrusted instance host is never sent the refresh token", refused instanceof OAuthTokenError && refused.needsReauth && !seen.some((s) => s.url.startsWith("https://evil.example")));
    const bad = await refreshAccessToken("salesforce", "rt", { fetchImpl: tokenStub({ error: "invalid_grant", error_description: "expired access/refresh token" }, 400), instanceUrl: "https://acme.my.salesforce.com" }).then(() => null, (e: unknown) => e);
    check("invalid_grant means reconnect", bad instanceof OAuthTokenError && bad.needsReauth);

    check("isTrustedInstanceUrl trusts a My Domain host", isTrustedInstanceUrl("salesforce", "https://acme.my.salesforce.com"));
    check("and refuses look-alikes", !isTrustedInstanceUrl("salesforce", "https://salesforce.com.evil.example") && !isTrustedInstanceUrl("salesforce", "http://acme.my.salesforce.com") && !isTrustedInstanceUrl("salesforce", "https://evilsalesforce.com"));
    check("a provider without instance hosts trusts none", !isTrustedInstanceUrl("hubspot", "https://api.hubapi.com"));
  }
```

Imports to add: `createHash` from `node:crypto`; `pkceVerifierForState`, `isTrustedInstanceUrl`, `refreshAccessToken`, `exchangeCode`, `OAuthTokenError`, `parseOAuthState`, `buildAuthorizeUrl` from `../src/lib/connectors/oauth` (merge with existing imports).

- [ ] **Step 3: Run it to verify it fails.** `npx tsx scripts/smoke-connector-oauth.ts` → errors on the missing exports.

- [ ] **Step 4: Implement in `oauth.ts`.**

Config type — add the four optional fields with doc comments:

```ts
  /**
   * RFC 7636 S256. The verifier is never stored: it is derived from the state's nonce with a
   * server-only key (`pkceVerifierForState`), so the callback recomputes it from the state it
   * is handed and an observer of the authorize URL cannot.
   */
  pkce?: boolean;
  /** Alternate login hosts, chosen by a signed `OAuthState.variant` (Salesforce's sandbox). */
  variants?: Record<string, { authorizeUrl: string; tokenUrl: string }>;
  /** For providers whose token endpoint lives on the account's own host: the path on it. */
  instanceTokenPath?: string;
  /** Which account hosts may be sent this provider's tokens. Absent = none. */
  trustInstanceUrl?: (url: string) => boolean;
```

The provider entry (import `isTrustedSalesforceUrl` from `@/lib/crm/salesforce/mapping` — a pure module, so `oauth.ts` stays database-free):

```ts
  salesforce: {
    authorizeUrl: "https://login.salesforce.com/services/oauth2/authorize",
    tokenUrl: "https://login.salesforce.com/services/oauth2/token",
    clientIdEnv: "SALESFORCE_CLIENT_ID",
    clientSecretEnv: "SALESFORCE_CLIENT_SECRET",
    // External Client Apps are created with "Require PKCE" on; the web server flow still
    // sends the secret too ("Require Secret for Web Server Flow").
    pkce: true,
    variants: {
      sandbox: {
        authorizeUrl: "https://test.salesforce.com/services/oauth2/authorize",
        tokenUrl: "https://test.salesforce.com/services/oauth2/token",
      },
    },
    // The org's My Domain answers refreshes for production and sandboxes alike.
    instanceTokenPath: "/services/oauth2/token",
    trustInstanceUrl: isTrustedSalesforceUrl,
  },
```

State: `OAuthState` gains

```ts
  /** A provider's alternate login host (`OAuthProviderConfig.variants`). Signed like the rest. */
  variant?: string;
```

Refactor signing so the nonce is reachable, keeping `signOAuthState`'s signature:

```ts
function mintState(state: OAuthState): { raw: string; nonce: string } {
  const payload: SignedStatePayload = {
    userId: state.userId,
    connectorId: state.connectorId,
    returnTo: safeReturnTo(state.returnTo),
    ...(state.variant ? { variant: state.variant } : {}),
    nonce: randomBytes(16).toString("hex"),
    iat: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", stateKey()).update(encoded).digest("base64url");
  return { raw: `${encoded}.${mac}`, nonce: payload.nonce };
}

export function signOAuthState(state: OAuthState): string {
  return mintState(state).raw;
}
```

Split `parseOAuthState` into a private `readSignedState(raw): SignedStatePayload | null` (everything it does today — MAC check, JSON parse, userId/connectorId/iat checks — returning the payload with `returnTo` sanitized and `variant` kept only when it is a string matching `/^[a-z]{1,32}$/`) and the public:

```ts
export function parseOAuthState(raw: string | null | undefined): OAuthState | null {
  const payload = readSignedState(raw);
  if (!payload) return null;
  return {
    userId: payload.userId,
    connectorId: payload.connectorId,
    returnTo: payload.returnTo,
    ...(payload.variant ? { variant: payload.variant } : {}),
  };
}
```

PKCE — a separate subkey (Ruling 2), next to `stateKey`:

```ts
/** Its own label, never the state key: see STATE_HMAC_LABEL on why purposes don't share a key. */
const PKCE_HMAC_LABEL = "orbit:connector-oauth-pkce:v1";

function pkceVerifierForNonce(nonce: string): string {
  const key = createHmac("sha256", stateSecret()).update(PKCE_HMAC_LABEL).digest();
  // 32 bytes → 43 base64url characters: inside RFC 7636's 43–128 and its unreserved alphabet.
  return createHmac("sha256", key).update(nonce).digest("base64url");
}

/** The PKCE verifier for a state this server signed — null when the state is invalid or expired. */
export function pkceVerifierForState(raw: string | null | undefined): string | null {
  const payload = readSignedState(raw);
  return payload ? pkceVerifierForNonce(payload.nonce) : null;
}
```

`SignedStatePayload` gains `variant?: string`. Add `createHash` to the `crypto` import.

`buildAuthorizeUrl` — opts gain `variant?: string`:

```ts
  const provider = providerOrThrow(connectorId);
  const { id } = clientCredentials(provider);
  const host = variantOrThrow(connectorId, provider, opts.variant);
  const url = new URL(host.authorizeUrl);
  // … extraAuthParams loop, client_id, redirect_uri, response_type, scope unchanged …
  const state = mintState({ userId: opts.userId, connectorId, returnTo: opts.returnTo, ...(opts.variant ? { variant: opts.variant } : {}) });
  url.searchParams.set("state", state.raw);
  if (provider.pkce) {
    url.searchParams.set("code_challenge", createHash("sha256").update(pkceVerifierForNonce(state.nonce)).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
```

with

```ts
function variantOrThrow(connectorId: string, provider: OAuthProviderConfig, variant: string | undefined): { authorizeUrl: string; tokenUrl: string } {
  if (!variant) return { authorizeUrl: provider.authorizeUrl, tokenUrl: provider.tokenUrl };
  const hosts = provider.variants?.[variant];
  if (!hosts) throw new Error(`Connector "${connectorId}" has no "${variant}" login host`);
  return hosts;
}
```

`postToken` takes the URL instead of reading `provider.tokenUrl`: change its first parameter to `tokenUrl: string` and pass it through to `fetchImpl`. Then:

```ts
export async function exchangeCode(
  connectorId: string,
  code: string,
  redirectUri: string,
  opts: { fetchImpl?: typeof fetch; codeVerifier?: string; variant?: string } = {}
): Promise<OAuthTokens> {
  const provider = providerOrThrow(connectorId);
  const { id, secret } = clientCredentials(provider);
  const { tokenUrl } = variantOrThrow(connectorId, provider, opts.variant);
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: id, client_secret: secret });
  if (opts.codeVerifier) body.set("code_verifier", opts.codeVerifier);
  return postToken(tokenUrl, body, opts.fetchImpl ?? fetch);
}

/** Whether `url` is a host this provider's tokens may be sent to (Salesforce's `instance_url`). */
export function isTrustedInstanceUrl(connectorId: string, url: string | null | undefined): url is string {
  const provider = OAUTH_PROVIDERS[connectorId];
  return Boolean(url && provider?.trustInstanceUrl?.(url));
}

export async function refreshAccessToken(
  connectorId: string,
  refreshToken: string,
  opts: { fetchImpl?: typeof fetch; instanceUrl?: string | null } = {}
): Promise<OAuthTokens> {
  const provider = providerOrThrow(connectorId);
  const { id, secret } = clientCredentials(provider);
  let tokenUrl = provider.tokenUrl;
  if (provider.instanceTokenPath && opts.instanceUrl) {
    // A stored host that fails the check was never written by Orbit's own connect: refuse to
    // hand it the refresh token, and ask for a reconnect that stores a good one.
    if (!isTrustedInstanceUrl(connectorId, opts.instanceUrl)) {
      throw new OAuthTokenError("The stored account host isn’t one Orbit trusts", true);
    }
    tokenUrl = new URL(provider.instanceTokenPath, opts.instanceUrl).href;
  }
  return postToken(
    tokenUrl,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: id, client_secret: secret }),
    opts.fetchImpl ?? fetch
  );
}
```

- [ ] **Step 5: `token.ts`.** Change the `refresh` dep and its default:

```ts
  refresh?: (connectorId: string, refreshToken: string, instanceUrl: string | null) => Promise<OAuthTokens>;
```

```ts
  const refresh =
    deps.refresh ??
    ((id: string, token: string, instanceUrl: string | null) => refreshAccessToken(id, token, { instanceUrl }));
```

In `renew`: call `refresh(conn.connectorId, conn.refreshToken, conn.instanceUrl)`; after it succeeds, compute

```ts
    // Salesforce names the org's host on every refresh; an org moved to a new instance says so here.
    const movedTo = tokens.extra?.instance_url;
    const instanceUrl = movedTo && movedTo !== conn.instanceUrl && isTrustedInstanceUrl(conn.connectorId, movedTo) ? movedTo : null;
```

pass `instanceUrl` into `persist(conn.id, { …, instanceUrl })`, and `if (instanceUrl) conn.instanceUrl = instanceUrl;`. Import `isTrustedInstanceUrl`. Update the module doc's first paragraph with one sentence: "Providers that never say when a token expires (Salesforce) have a null `tokenExpiresAt`, so only the reactive half runs for them."

- [ ] **Step 6: Token smoke.** In `scripts/smoke-connector-token.ts`, every hand-built `refresh` stub keeps working (the third parameter is ignored); add one case: a claimed connection `{ …, connectorId: "salesforce", instanceUrl: "https://acme.my.salesforce.com", tokenExpiresAt: null }` whose first call throws `ConnectorAuthError`, a `refresh` stub that records its third argument and returns `{ accessToken: "new", refreshToken: null, expiresAt: null, scopes: null, extra: { instance_url: "https://acme2.my.salesforce.com" } }`, and a `persist` stub that records its argument. Check: the stub received `"https://acme.my.salesforce.com"`; `persist` got `instanceUrl: "https://acme2.my.salesforce.com"` and `refreshToken: null`; `conn.instanceUrl` is now the new host; `conn.refreshToken` is unchanged; the second call used `"new"`. A second case with `extra: { instance_url: "https://evil.example" }` persists `instanceUrl: null` and leaves `conn.instanceUrl` alone.

- [ ] **Step 7: Run.**

```bash
npx tsx scripts/smoke-connector-oauth.ts
npx tsx scripts/smoke-connector-token.ts
npx tsx scripts/smoke-hubspot-api.ts
npx tsx scripts/smoke-crm-connect.ts
npx tsc --noEmit -p .
```

All pass (the HubSpot ones prove `postToken`'s new parameter kept HubSpot's dated token URL).

- [ ] **Step 8: Commit.** "Give connector OAuth PKCE, a sandbox login host, and refreshes against the account's own host" plus the trailer.

---

### Task 3: Salesforce, pure — fields, SOQL, keyset progress, and record mapping

**Files:**
- Modify: `src/lib/crm/salesforce/mapping.ts` (append)
- Create: `scripts/smoke-salesforce-mapping.ts`; register it in `scripts/run-smoke.ts` `MANIFEST`
- Modify (only if needed): `scripts/smoke-leads-page.ts` — its byte scan of `src/lib/crm` must reach `src/lib/crm/salesforce/`

**Interfaces:**
- Consumes: `CrmPerson` from `@/lib/crm/types`; `ConnectorSyncCursor` from `@/db/schema` (type-only).
- Produces (from `@/lib/crm/salesforce/mapping`):

```ts
export const SALESFORCE_API_VERSION = "v66.0";
export const SALESFORCE_SCOPES = ["api", "refresh_token", "id"] as const;
export const SALESFORCE_PAGE = 200;
export const SALESFORCE_WATERMARK_OVERLAP_MS = 5 * 60 * 1000;
export type SalesforceObject = "Contact" | "Lead";
export type SalesforceRecord = { Id: string; attributes?: { type?: string; url?: string } } & Record<string, unknown>;
export type SalesforceMark = { at: string; id: string };               // at: ISO
export type SalesforceProgress = { phase: SalesforceObject; contact: SalesforceMark | null; lead: SalesforceMark | null; lean: boolean };
export type SalesforceIdentity = { orgId: string; userId: string };
export function isSalesforceId(value: unknown): value is string;       // 15 or 18 alphanumerics
export function soqlDateTime(iso: string): string;                      // "2026-09-26T12:00:00Z"
export function parseSalesforceDate(value: unknown): Date | null;       // "…000+0000", ISO, "YYYY-MM-DD"
export function fieldsFor(object: SalesforceObject, lean: boolean): readonly string[];
export function buildOwnedQuery(object: SalesforceObject, input: { ownerId: string; after: SalesforceMark | null; lean: boolean }): string;
export function markOf(raw: SalesforceRecord): SalesforceMark | null;
export function advanceProgress(progress: SalesforceProgress, page: { last: SalesforceMark | null; full: boolean }): { progress: SalesforceProgress; done: boolean };
export function progressFromCursor(cursor: ConnectorSyncCursor | null | undefined): SalesforceProgress;
export function cursorFromProgress(progress: SalesforceProgress, identity: SalesforceIdentity): ConnectorSyncCursor;
export function identityFromCursor(cursor: ConnectorSyncCursor | null | undefined): SalesforceIdentity | null;
export function salesforceRecordUrl(instanceUrl: string, object: SalesforceObject, id: string): string;
export function mapSalesforceRecord(object: SalesforceObject, raw: SalesforceRecord, ctx: { instanceUrl: string }): CrmPerson | null;
```

- [ ] **Step 1: Write the failing smoke** `scripts/smoke-salesforce-mapping.ts` (pure — no `_env` import, no database; end with `process.exit(failures ? 1 : 0)`):

```ts
/**
 * Salesforce, pure: host trust, SOQL, the keyset progress a sync carries between runs, and
 * what a Contact or Lead becomes. No database, no network.
 *
 * Run: npx tsx scripts/smoke-salesforce-mapping.ts
 */
import {
  SALESFORCE_PAGE,
  advanceProgress,
  buildOwnedQuery,
  cursorFromProgress,
  identityFromCursor,
  isSalesforceId,
  isTrustedSalesforceUrl,
  mapSalesforceRecord,
  markOf,
  parseSalesforceDate,
  progressFromCursor,
  soqlDateTime,
  type SalesforceProgress,
} from "../src/lib/crm/salesforce/mapping";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const OWNER = "005000000000001AAA";
const INSTANCE = "https://acme.my.salesforce.com";

console.log("\nhosts");
check("a My Domain host is trusted", isTrustedSalesforceUrl("https://acme.my.salesforce.com/services/data"));
check("a sandbox host is trusted", isTrustedSalesforceUrl("https://acme--dev.sandbox.my.salesforce.com"));
check("force.com is trusted", isTrustedSalesforceUrl("https://acme.lightning.force.com"));
check("http is not", !isTrustedSalesforceUrl("http://acme.my.salesforce.com"));
check("a suffix look-alike is not", !isTrustedSalesforceUrl("https://evilsalesforce.com") && !isTrustedSalesforceUrl("https://salesforce.com.evil.example"));
check("credentials in the URL are not", !isTrustedSalesforceUrl("https://a:b@acme.my.salesforce.com"));
check("a port is not", !isTrustedSalesforceUrl("https://acme.my.salesforce.com:8443"));
check("garbage is not", !isTrustedSalesforceUrl("not a url") && !isTrustedSalesforceUrl(null));

console.log("\nids and dates");
check("15- and 18-char ids", isSalesforceId("003000000000001") && isSalesforceId(OWNER));
check("anything else is not an id", !isSalesforceId("003' OR Id != '") && !isSalesforceId("") && !isSalesforceId(42));
check("SOQL datetimes are second precision, unquoted", soqlDateTime("2026-09-26T12:00:00.789Z") === "2026-09-26T12:00:00Z");
check("Salesforce's +0000 offset parses", parseSalesforceDate("2026-09-26T12:00:00.000+0000")?.toISOString() === "2026-09-26T12:00:00.000Z");
check("a date-only value parses", parseSalesforceDate("2026-09-01")?.toISOString() === "2026-09-01T00:00:00.000Z");
check("empty is null", parseSalesforceDate("") === null && parseSalesforceDate(null) === null && parseSalesforceDate("nope") === null);

console.log("\nSOQL");
const first = buildOwnedQuery("Contact", { ownerId: OWNER, after: null, lean: false });
check("filters on the owner", first.includes(`WHERE OwnerId = '${OWNER}'`), first);
check("orders by the stamp, then the id", first.includes("ORDER BY SystemModstamp ASC, Id ASC"), first);
check("pages at 200", first.endsWith(`LIMIT ${SALESFORCE_PAGE}`), first);
check("reads the account name", first.includes("Account.Name"), first);
const next = buildOwnedQuery("Lead", { ownerId: OWNER, after: { at: "2026-09-26T12:00:00.000Z", id: "00Q000000000009AAA" }, lean: false });
check("resumes strictly after the mark", next.includes("(SystemModstamp > 2026-09-26T12:00:00Z OR (SystemModstamp = 2026-09-26T12:00:00Z AND Id > '00Q000000000009AAA'))"), next);
check("reads a lead's conversion", next.includes("IsConverted") && next.includes("ConvertedContactId") && next.includes("Company"), next);
const lean = buildOwnedQuery("Contact", { ownerId: OWNER, after: null, lean: true });
check("the lean list drops the optional fields", !lean.includes("Phone") && !lean.includes("Title") && lean.includes("Email"), lean);
const threw = (() => { try { buildOwnedQuery("Contact", { ownerId: "x' OR '1'='1", after: null, lean: false }); return false; } catch { return true; } })();
check("a non-id owner never reaches SOQL", threw);
const threwMark = (() => { try { buildOwnedQuery("Contact", { ownerId: OWNER, after: { at: "2026-09-26T12:00:00Z", id: "bad'" }, lean: false }); return false; } catch { return true; } })();
check("nor does a non-id mark", threwMark);

console.log("\nmapping");
const contact = mapSalesforceRecord("Contact", {
  Id: "003000000000001AAA", FirstName: "Ada", LastName: "Lovelace", Email: "ada@acme.com", Phone: "+1 555 0100",
  Title: "CTO", Account: { Name: "Acme" }, OwnerId: OWNER, CreatedDate: "2026-01-01T00:00:00.000+0000",
  SystemModstamp: "2026-09-26T12:00:00.000+0000", LastActivityDate: "2026-09-01",
}, { instanceUrl: INSTANCE });
check("a Contact is a customer", contact?.lifecycle === "customer" && contact.remoteType === "contact");
check("with its name, email, company, title", contact?.displayName === "Ada Lovelace" && contact.email === "ada@acme.com" && contact.companyName === "Acme" && contact.title === "CTO");
check("and a Lightning record URL on its own host", contact?.remoteUrl === `${INSTANCE}/lightning/r/Contact/003000000000001AAA/view`, String(contact?.remoteUrl));
check("its stamp is remoteUpdatedAt", contact?.remoteUpdatedAt?.toISOString() === "2026-09-26T12:00:00.000Z");
check("its last activity is read", contact?.lastActivityAt?.toISOString() === "2026-09-01T00:00:00.000Z");
check("the owner is kept", contact?.remoteOwnerRef === OWNER);

const lead = mapSalesforceRecord("Lead", { Id: "00Q000000000001AAA", FirstName: "Bo", LastName: "Chen", Email: null, Company: "[not provided]", Status: "Working - Contacted", IsConverted: false, OwnerId: OWNER, SystemModstamp: "2026-09-26T12:00:00.000+0000" }, { instanceUrl: INSTANCE });
check("an open Lead is a lead", lead?.lifecycle === "lead" && lead.remoteType === "lead" && lead.stage === "Working - Contacted");
check("Salesforce's company placeholder is no company", lead?.companyName === null, String(lead?.companyName));
check("its status is kept as a property", lead?.properties.sf_status === "Working - Contacted");
const converted = mapSalesforceRecord("Lead", { Id: "00Q000000000002AAA", LastName: "Diaz", Company: "Initech", IsConverted: true, ConvertedContactId: "003000000000002AAA", OwnerId: OWNER }, { instanceUrl: INSTANCE });
check("a converted Lead is a customer", converted?.lifecycle === "customer" && converted.stage === "Converted");
check("and remembers the Contact it became", converted?.properties.sf_converted_contact_id === "003000000000002AAA");
check("a record with no name and no email is skipped", mapSalesforceRecord("Contact", { Id: "003000000000003AAA", OwnerId: OWNER }, { instanceUrl: INSTANCE }) === null);
check("an email alone names someone", mapSalesforceRecord("Contact", { Id: "003000000000004AAA", Email: "x@y.com" }, { instanceUrl: INSTANCE })?.displayName === "x@y.com");
check("a record without a valid id is skipped", mapSalesforceRecord("Contact", { Id: "nope", LastName: "Z" }, { instanceUrl: INSTANCE }) === null);

console.log("\nprogress");
check("a record's mark", markOf({ Id: "003000000000001AAA", SystemModstamp: "2026-09-26T12:00:00.000+0000" })?.at === "2026-09-26T12:00:00.000Z");
check("no stamp, no mark", markOf({ Id: "003000000000001AAA" }) === null);
const fresh = progressFromCursor(null);
check("a fresh cursor starts on contacts, from the beginning", fresh.phase === "Contact" && fresh.contact === null && fresh.lead === null && !fresh.lean);
const mark = { at: "2026-09-26T12:00:00.000Z", id: "003000000000001AAA" };
const midContacts = advanceProgress(fresh, { last: mark, full: true });
check("a full page stays on contacts, at its last record", !midContacts.done && midContacts.progress.phase === "Contact" && midContacts.progress.contact?.id === mark.id);
const toLeads = advanceProgress(midContacts.progress, { last: mark, full: false });
check("a short page moves to leads", !toLeads.done && toLeads.progress.phase === "Lead");
check("and rewinds the contact watermark by the overlap", toLeads.progress.contact?.at === "2026-09-26T11:55:00.000Z" && toLeads.progress.contact?.id === "", JSON.stringify(toLeads.progress.contact));
const emptyLeads = advanceProgress(toLeads.progress, { last: null, full: false });
check("an empty lead page finishes the run, back on contacts", emptyLeads.done && emptyLeads.progress.phase === "Contact");
check("an empty page keeps the watermark", emptyLeads.progress.lead === null && emptyLeads.progress.contact?.at === "2026-09-26T11:55:00.000Z");
const emptyContacts = advanceProgress({ ...fresh, contact: { at: "2026-09-20T00:00:00.000Z", id: "" } }, { last: null, full: false });
check("an empty contact page moves on without rewinding again", emptyContacts.progress.phase === "Lead" && emptyContacts.progress.contact?.at === "2026-09-20T00:00:00.000Z");

const identity = { orgId: "00D000000000001AAA", userId: OWNER };
const withLean: SalesforceProgress = { ...toLeads.progress, lean: true };
const round = progressFromCursor(cursorFromProgress(withLean, identity));
check("progress round-trips through the cursor", JSON.stringify(round) === JSON.stringify(withLean), JSON.stringify(round));
check("identity round-trips", JSON.stringify(identityFromCursor(cursorFromProgress(withLean, identity))) === JSON.stringify(identity));
check("a cursor without identity has none", identityFromCursor({ meta: { orgId: "00D000000000001AAA" } }) === null && identityFromCursor(null) === null);
check("meta holds strings only", Object.values(cursorFromProgress(withLean, identity).meta ?? {}).every((v) => typeof v === "string"));

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Salesforce mapping checks passed.");
process.exit(0);
```

- [ ] **Step 2: Run it to verify it fails.** `npx tsx scripts/smoke-salesforce-mapping.ts` → missing exports.

- [ ] **Step 3: Implement.** Append to `src/lib/crm/salesforce/mapping.ts` (add the type imports at the top of the file: `import type { ConnectorSyncCursor } from "@/db/schema"; import type { CrmPerson } from "@/lib/crm/types";`):

```ts
export const SALESFORCE_API_VERSION = "v66.0";

/** Sent as the `scope` param; the External Client App grants the same three. */
export const SALESFORCE_SCOPES = ["api", "refresh_token", "id"] as const;

export const SALESFORCE_PAGE = 200;
/** How far a finished phase rewinds its watermark: a transaction committing late can carry an earlier stamp. */
export const SALESFORCE_WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

export type SalesforceObject = "Contact" | "Lead";
export type SalesforceRecord = { Id: string; attributes?: { type?: string; url?: string } } & Record<string, unknown>;
/** The last record a query read: its stamp (ISO) and id. `id: ""` sorts before every real id. */
export type SalesforceMark = { at: string; id: string };
export type SalesforceProgress = { phase: SalesforceObject; contact: SalesforceMark | null; lead: SalesforceMark | null; lean: boolean };
export type SalesforceIdentity = { orgId: string; userId: string };

const BASE_FIELDS = ["Id", "FirstName", "LastName", "Email", "OwnerId", "CreatedDate", "SystemModstamp"] as const;
const FULL_FIELDS: Record<SalesforceObject, readonly string[]> = {
  Contact: [...BASE_FIELDS, "Phone", "MobilePhone", "Title", "Account.Name", "LastActivityDate"],
  Lead: [...BASE_FIELDS, "Company", "Status", "IsConverted", "ConvertedContactId", "Phone", "MobilePhone", "Title", "LastActivityDate"],
};
/** Fields every user who can read the object can read; the fallback after an INVALID_FIELD. */
const LEAN_FIELDS: Record<SalesforceObject, readonly string[]> = {
  Contact: [...BASE_FIELDS, "Account.Name"],
  Lead: [...BASE_FIELDS, "Company", "Status", "IsConverted", "ConvertedContactId"],
};

export function fieldsFor(object: SalesforceObject, lean: boolean): readonly string[] {
  return (lean ? LEAN_FIELDS : FULL_FIELDS)[object];
}

export function isSalesforceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value);
}

/** SOQL datetime literals are unquoted and second-precision. */
export function soqlDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error("Not a date");
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** Salesforce writes `2026-09-26T12:00:00.000+0000`; dates are `2026-09-01`. */
export function parseSalesforceDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * The owned records of one object, strictly after `after`, oldest stamp first. Keyset, not
 * `nextRecordsUrl`: a locator dies after 15 idle minutes, and a run killed at its time limit
 * resumes from the cursor on the next one. Every interpolated value is an id or a date this
 * module validated — nothing a person or a provider typed reaches the query text.
 */
export function buildOwnedQuery(object: SalesforceObject, input: { ownerId: string; after: SalesforceMark | null; lean: boolean }): string {
  if (!isSalesforceId(input.ownerId)) throw new Error("Not a Salesforce user id");
  const where = [`OwnerId = '${input.ownerId}'`];
  if (input.after) {
    const at = soqlDateTime(input.after.at);
    if (input.after.id === "") where.push(`SystemModstamp >= ${at}`);
    else {
      if (!isSalesforceId(input.after.id)) throw new Error("Not a Salesforce record id");
      where.push(`(SystemModstamp > ${at} OR (SystemModstamp = ${at} AND Id > '${input.after.id}'))`);
    }
  }
  return `SELECT ${fieldsFor(object, input.lean).join(", ")} FROM ${object} WHERE ${where.join(" AND ")} ORDER BY SystemModstamp ASC, Id ASC LIMIT ${SALESFORCE_PAGE}`;
}

export function markOf(raw: SalesforceRecord): SalesforceMark | null {
  const at = parseSalesforceDate(raw.SystemModstamp);
  return at && isSalesforceId(raw.Id) ? { at: at.toISOString(), id: raw.Id } : null;
}

function rewind(mark: SalesforceMark | null): SalesforceMark | null {
  return mark ? { at: new Date(Date.parse(mark.at) - SALESFORCE_WATERMARK_OVERLAP_MS).toISOString(), id: "" } : null;
}

/**
 * One page read. A full page means more may follow in this phase; a short one finishes it. A
 * finished phase rewinds its mark by the overlap (`id: ""` re-reads the boundary second), but
 * only when this page moved it — an empty page leaves the already-rewound mark alone, so
 * nothing walks backwards run after run. Contacts finish into leads; leads finish the run.
 */
export function advanceProgress(
  progress: SalesforceProgress,
  page: { last: SalesforceMark | null; full: boolean }
): { progress: SalesforceProgress; done: boolean } {
  const key = progress.phase === "Contact" ? "contact" : "lead";
  const moved = page.last ?? progress[key];
  if (page.full && page.last) return { progress: { ...progress, [key]: moved }, done: false };
  const settled = { ...progress, [key]: page.last ? rewind(page.last) : progress[key] };
  return progress.phase === "Contact"
    ? { progress: { ...settled, phase: "Lead" }, done: false }
    : { progress: { ...settled, phase: "Contact" }, done: true };
}

function markFrom(meta: Record<string, string>, key: "contact" | "lead"): SalesforceMark | null {
  const at = meta[`${key}At`];
  return at ? { at, id: meta[`${key}Id`] ?? "" } : null;
}

export function progressFromCursor(cursor: ConnectorSyncCursor | null | undefined): SalesforceProgress {
  const meta = cursor?.meta ?? {};
  return {
    phase: meta.phase === "Lead" ? "Lead" : "Contact",
    contact: markFrom(meta, "contact"),
    lead: markFrom(meta, "lead"),
    lean: meta.lean === "1",
  };
}

export function cursorFromProgress(progress: SalesforceProgress, identity: SalesforceIdentity): ConnectorSyncCursor {
  const meta: Record<string, string> = { orgId: identity.orgId, userId: identity.userId, phase: progress.phase };
  if (progress.contact) Object.assign(meta, { contactAt: progress.contact.at, contactId: progress.contact.id });
  if (progress.lead) Object.assign(meta, { leadAt: progress.lead.at, leadId: progress.lead.id });
  if (progress.lean) meta.lean = "1";
  return { meta };
}

export function identityFromCursor(cursor: ConnectorSyncCursor | null | undefined): SalesforceIdentity | null {
  const meta = cursor?.meta;
  return meta?.orgId && meta.userId ? { orgId: meta.orgId, userId: meta.userId } : null;
}

export function salesforceRecordUrl(instanceUrl: string, object: SalesforceObject, id: string): string {
  return new URL(`/lightning/r/${object}/${encodeURIComponent(id)}/view`, instanceUrl).href;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Salesforce requires a Lead's company and fills this in when a form didn't ask. */
const NO_COMPANY = new Set(["[not provided]", "not provided", "n/a", "none", "unknown"]);

export function mapSalesforceRecord(object: SalesforceObject, raw: SalesforceRecord, ctx: { instanceUrl: string }): CrmPerson | null {
  if (!isSalesforceId(raw.Id)) return null;
  const email = text(raw.Email);
  const name = [text(raw.FirstName), text(raw.LastName)].filter(Boolean).join(" ");
  const displayName = name || email;
  if (!displayName) return null;
  const account = raw.Account && typeof raw.Account === "object" ? (raw.Account as Record<string, unknown>) : null;
  const company = object === "Contact" ? text(account?.Name) : text(raw.Company);
  const properties: CrmPerson["properties"] = {};
  let lifecycle: CrmPerson["lifecycle"] = "customer";
  let stage: string | null = null;
  if (object === "Lead") {
    stage = text(raw.Status);
    if (stage) properties.sf_status = stage;
    if (raw.IsConverted === true) {
      stage = "Converted";
      if (isSalesforceId(raw.ConvertedContactId)) properties.sf_converted_contact_id = raw.ConvertedContactId;
    } else {
      lifecycle = "lead";
    }
  }
  return {
    remoteType: object === "Contact" ? "contact" : "lead",
    remoteId: raw.Id,
    lifecycle,
    stage,
    displayName,
    email,
    phone: text(raw.Phone) ?? text(raw.MobilePhone),
    linkedinUrl: null,
    companyName: company && !NO_COMPANY.has(company.toLowerCase()) ? company : null,
    companyDomain: null,
    title: text(raw.Title),
    remoteOwnerRef: isSalesforceId(raw.OwnerId) ? raw.OwnerId : null,
    remoteUrl: salesforceRecordUrl(ctx.instanceUrl, object, raw.Id),
    lastActivityAt: parseSalesforceDate(raw.LastActivityDate),
    remoteCreatedAt: parseSalesforceDate(raw.CreatedDate),
    remoteUpdatedAt: parseSalesforceDate(raw.SystemModstamp),
    properties,
  };
}
```

Note the empty-page rule in `advanceProgress`: `settled[key]` is `rewind(page.last)` only when the page had records; otherwise the existing mark stays. Check this against the smoke's "an empty contact page moves on without rewinding again" before moving on.

- [ ] **Step 4: Register and run.** Add `"smoke-salesforce-mapping"` to `MANIFEST` in `scripts/run-smoke.ts` next to `smoke-hubspot-mapping` (same entry shape). Then:

```bash
npx tsx scripts/smoke-salesforce-mapping.ts
npx tsx scripts/run-smoke.ts --check
npx tsx scripts/smoke-leads-page.ts
npx tsc --noEmit -p .
```

If `smoke-leads-page` does not scan `src/lib/crm/salesforce/mapping.ts` (read how it lists files), make its walk recursive and rerun.

- [ ] **Step 5: Commit.** "Map Salesforce Contacts and Leads, and page them by SystemModstamp keyset" plus the trailer.

---

### Task 4: Salesforce's HTTP client, and fixed-sentence API errors for both providers

**Files:**
- Create: `src/lib/crm/salesforce/api.ts`
- Modify: `src/lib/crm/hubspot/api.ts`
- Create: `scripts/smoke-salesforce-api.ts`; register it
- Modify: `scripts/smoke-hubspot-api.ts` (its message expectations)

**Interfaces:**
- Consumes: `ConnectorAuthError` from `@/lib/connectors/auth-errors`; `SALESFORCE_API_VERSION`, `isTrustedSalesforceUrl`, `SalesforceRecord` from `./mapping`.
- Produces (from `@/lib/crm/salesforce/api`):

```ts
export type SalesforceErrorKind = "rate_limited" | "api_disabled" | "forbidden" | "invalid_field" | "bad_request" | "not_found" | "server" | "network" | "untrusted_host";
export class SalesforceApiError extends Error { kind; status: number | null; retryable: boolean; detail: string | null }
export type SalesforceIdentityInfo = { orgId: string; userId: string; username: string | null; displayName: string | null; email: string | null };
export function fetchSalesforceIdentity(accessToken: string, idUrl: string, fetchImpl?: typeof fetch): Promise<SalesforceIdentityInfo>;
export type SalesforceQueryPage = { records: SalesforceRecord[]; done: boolean };
export function querySalesforce(accessToken: string, instanceUrl: string, soql: string, fetchImpl?: typeof fetch): Promise<SalesforceQueryPage>;
export function revokeSalesforceToken(instanceUrl: string, refreshToken: string, fetchImpl?: typeof fetch): Promise<boolean>;
```
- `HubspotApiError` gains `readonly detail: string | null` (5th constructor argument, default null); every HubSpot error message becomes a fixed sentence.

- [ ] **Step 1: Write the failing smoke** `scripts/smoke-salesforce-api.ts` (no database; `process.exit` at the end):

```ts
/**
 * Salesforce's HTTP half: the error taxonomy the sync acts on, and the three calls it makes.
 * A stubbed fetch throughout. The invariant under test beyond shapes: no provider text in any
 * message, and no token sent to a host outside Salesforce's domains.
 *
 * Run: npx tsx scripts/smoke-salesforce-api.ts
 */
import { ConnectorAuthError } from "../src/lib/connectors/auth-errors";
import { SalesforceApiError, fetchSalesforceIdentity, querySalesforce, revokeSalesforceToken } from "../src/lib/crm/salesforce/api";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const INSTANCE = "https://acme.my.salesforce.com";
const calls: Array<{ url: string; init?: RequestInit }> = [];
function stub(status: number, body: unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const sfError = (errorCode: string, message = "SECRET PROVIDER TEXT") => [{ errorCode, message }];
async function caught(p: Promise<unknown>): Promise<unknown> {
  try { await p; return null; } catch (err) { return err; }
}

async function main() {
  console.log("\nquery");
  const page = await querySalesforce("tok", INSTANCE, "SELECT Id FROM Contact", stub(200, { totalSize: 1, done: true, records: [{ Id: "003000000000001AAA" }] }));
  check("reads records", page.records.length === 1 && page.done);
  const q = new URL(calls.at(-1)!.url);
  check("on the org's host, v66.0", q.origin === INSTANCE && q.pathname === "/services/data/v66.0/query", q.href);
  check("with the SOQL as q", q.searchParams.get("q") === "SELECT Id FROM Contact");
  check("and a bearer token", new Headers(calls.at(-1)!.init?.headers).get("authorization") === "Bearer tok");

  const expired = await caught(querySalesforce("tok", INSTANCE, "q", stub(401, sfError("INVALID_SESSION_ID"))));
  check("401 is an auth error (refresh once)", expired instanceof ConnectorAuthError);
  const limit = await caught(querySalesforce("tok", INSTANCE, "q", stub(403, sfError("REQUEST_LIMIT_EXCEEDED"))));
  check("the daily limit retries later", limit instanceof SalesforceApiError && limit.kind === "rate_limited" && limit.retryable);
  const off = await caught(querySalesforce("tok", INSTANCE, "q", stub(403, sfError("API_DISABLED_FOR_ORG"))));
  check("API access off stops", off instanceof SalesforceApiError && off.kind === "api_disabled" && !off.retryable);
  const off2 = await caught(querySalesforce("tok", INSTANCE, "q", stub(403, sfError("API_CURRENTLY_DISABLED"))));
  check("so does API_CURRENTLY_DISABLED", off2 instanceof SalesforceApiError && off2.kind === "api_disabled");
  const forbidden = await caught(querySalesforce("tok", INSTANCE, "q", stub(403, sfError("INSUFFICIENT_ACCESS"))));
  check("another 403 stops as forbidden", forbidden instanceof SalesforceApiError && forbidden.kind === "forbidden" && !forbidden.retryable);
  const field = await caught(querySalesforce("tok", INSTANCE, "q", stub(400, sfError("INVALID_FIELD"))));
  check("INVALID_FIELD is its own kind", field instanceof SalesforceApiError && field.kind === "invalid_field" && !field.retryable);
  const malformed = await caught(querySalesforce("tok", INSTANCE, "q", stub(400, sfError("MALFORMED_QUERY"))));
  check("another 400 is a bad request", malformed instanceof SalesforceApiError && malformed.kind === "bad_request" && !malformed.retryable);
  const down = await caught(querySalesforce("tok", INSTANCE, "q", stub(503, "<html>down</html>")));
  check("5xx retries", down instanceof SalesforceApiError && down.kind === "server" && down.retryable);
  const net = await caught(querySalesforce("tok", INSTANCE, "q", (async () => { throw new TypeError("fetch failed: SECRET"); }) as typeof fetch));
  check("a network failure retries", net instanceof SalesforceApiError && net.kind === "network" && net.retryable);
  const errors = [expired, limit, off, forbidden, field, malformed, down, net];
  check("no provider text in any message", errors.every((e) => e instanceof Error && !e.message.includes("SECRET")), errors.map((e) => (e as Error).message).join(" | "));
  check("every message starts with Salesforce", errors.filter((e) => e instanceof SalesforceApiError).every((e) => (e as Error).message.startsWith("Salesforce ")));
  check("the detail is kept for the report", limit instanceof SalesforceApiError && (limit.detail ?? "").includes("REQUEST_LIMIT_EXCEEDED"));

  const before = calls.length;
  const evil = await caught(querySalesforce("tok", "https://evil.example", "q", stub(200, { records: [] })));
  check("an untrusted host is never sent the token", evil instanceof SalesforceApiError && evil.kind === "untrusted_host" && calls.length === before);

  console.log("\nidentity");
  const who = await fetchSalesforceIdentity("tok", "https://login.salesforce.com/id/00D000000000001AAA/005000000000001AAA", stub(200, {
    user_id: "005000000000001AAA", organization_id: "00D000000000001AAA", username: "ada@acme.com", display_name: "Ada Lovelace", email: "ada@acme.com",
  }));
  check("reads org and user", who.orgId === "00D000000000001AAA" && who.userId === "005000000000001AAA" && who.username === "ada@acme.com");
  check("with a bearer token", new Headers(calls.at(-1)!.init?.headers).get("authorization") === "Bearer tok");
  const nobody = await caught(fetchSalesforceIdentity("tok", "https://login.salesforce.com/id/x/y", stub(200, { username: "a" })));
  check("an identity without ids is refused", nobody instanceof SalesforceApiError && nobody.kind === "bad_request");
  const before2 = calls.length;
  const evilId = await caught(fetchSalesforceIdentity("tok", "https://evil.example/id/x/y", stub(200, {})));
  check("an untrusted identity URL is never called", evilId instanceof SalesforceApiError && calls.length === before2);

  console.log("\nrevoke");
  check("a 200 revokes", await revokeSalesforceToken(INSTANCE, "rt", stub(200, "")));
  const r = calls.at(-1)!;
  check("on the org's host, form-encoded", r.url === `${INSTANCE}/services/oauth2/revoke` && new URLSearchParams(String(r.init?.body)).get("token") === "rt");
  check("a 400 says no", !(await revokeSalesforceToken(INSTANCE, "rt", stub(400, { error: "unsupported_token_type" }))));
  check("a network failure says no", !(await revokeSalesforceToken(INSTANCE, "rt", (async () => { throw new Error("x"); }) as typeof fetch)));
  const before3 = calls.length;
  check("an untrusted host says no without a call", !(await revokeSalesforceToken("https://evil.example", "rt", stub(200, ""))) && calls.length === before3);

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll Salesforce API checks passed.");
  process.exit(0);
}

void main();
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement `src/lib/crm/salesforce/api.ts`.**

```ts
/**
 * Salesforce's HTTP half: one request path with the error taxonomy the sync acts on, and the
 * three calls P5 makes. Every call takes `fetchImpl`, so no smoke reaches the network, and
 * every call checks its host first — `instance_url` and the identity URL come from a token
 * response, and a bearer token only ever goes to Salesforce's own domains.
 *
 * A 401 becomes `ConnectorAuthError` and nothing else does: Salesforce never says when a token
 * expires, so `openConnectorAuth`'s reactive refresh is the only one that runs.
 *
 * Messages are sentences Orbit wrote; Salesforce's own text rides on `.detail` for the error
 * report and never reaches `sync_error` or a toast.
 */
import { ConnectorAuthError } from "@/lib/connectors/auth-errors";
import { SALESFORCE_API_VERSION, isTrustedSalesforceUrl, type SalesforceRecord } from "./mapping";

export type SalesforceErrorKind =
  | "rate_limited"
  | "api_disabled"
  | "forbidden"
  | "invalid_field"
  | "bad_request"
  | "not_found"
  | "server"
  | "network"
  | "untrusted_host";

export class SalesforceApiError extends Error {
  constructor(
    message: string,
    readonly kind: SalesforceErrorKind,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly detail: string | null = null
  ) {
    super(message);
    this.name = "SalesforceApiError";
  }
}

const TIMEOUT_MS = 15_000;

const UNTRUSTED = "Salesforce named a server Orbit doesn’t trust — reconnect Salesforce";

async function send(url: string, init: RequestInit, fetchImpl: typeof fetch, timeoutMs = TIMEOUT_MS): Promise<Response> {
  if (!isTrustedSalesforceUrl(url)) throw new SalesforceApiError(UNTRUSTED, "untrusted_host", null, false, url.slice(0, 200));
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SalesforceApiError("Salesforce didn’t answer — the next sync will try again", "network", null, true, detail.slice(0, 300));
  }
}

/** Salesforce's REST errors are an array of `{ errorCode, message }`. */
function errorCodeOf(body: unknown): { code: string; detail: string } {
  const first = Array.isArray(body) ? (body[0] as { errorCode?: unknown; message?: unknown } | undefined) : undefined;
  const code = typeof first?.errorCode === "string" ? first.errorCode : "";
  const message = typeof first?.message === "string" ? first.message : "";
  return { code, detail: `${code}${message ? `: ${message}` : ""}`.slice(0, 300) };
}

function failure(status: number, body: unknown): Error {
  const { code, detail } = errorCodeOf(body);
  if (status === 401) return new ConnectorAuthError("Salesforce refused the access token");
  if (code === "REQUEST_LIMIT_EXCEEDED") {
    return new SalesforceApiError("Salesforce’s daily API allowance for your org is used up — the next sync picks up where this one stopped", "rate_limited", status, true, detail);
  }
  if (code === "API_DISABLED_FOR_ORG" || code === "API_CURRENTLY_DISABLED") {
    return new SalesforceApiError("Salesforce says API access is off for your user — ask a Salesforce admin to turn on API Enabled, then sync again", "api_disabled", status, false, detail);
  }
  if (status === 403) {
    return new SalesforceApiError("Salesforce says this connection can’t read your contacts and leads — ask a Salesforce admin for read access, then sync again", "forbidden", status, false, detail);
  }
  if (status === 404) return new SalesforceApiError("Salesforce couldn’t find what Orbit asked for — reconnect Salesforce", "not_found", status, false, detail);
  if (status >= 500) return new SalesforceApiError("Salesforce is having trouble — the next sync will try again", "server", status, true, detail);
  if (code === "INVALID_FIELD") {
    return new SalesforceApiError("Salesforce hides some contact fields from your user — Orbit will read the ones you can see", "invalid_field", status, false, detail);
  }
  return new SalesforceApiError("Salesforce turned down Orbit’s request — reconnect Salesforce, and tell us if it keeps happening", "bad_request", status, false, detail);
}

async function salesforceJson<T>(accessToken: string, url: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await send(url, { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, fetchImpl);
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw failure(res.status, json);
  return (json ?? {}) as T;
}

export type SalesforceIdentityInfo = {
  orgId: string;
  userId: string;
  username: string | null;
  displayName: string | null;
  email: string | null;
};

/** The identity URL from the token response: who connected, and in which org. */
export async function fetchSalesforceIdentity(accessToken: string, idUrl: string, fetchImpl: typeof fetch = fetch): Promise<SalesforceIdentityInfo> {
  const json = await salesforceJson<Record<string, unknown>>(accessToken, idUrl, fetchImpl);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const orgId = str(json.organization_id);
  const userId = str(json.user_id);
  if (!orgId || !userId) throw new SalesforceApiError("Salesforce didn’t say who connected — reconnect Salesforce", "bad_request", 200, false);
  return { orgId, userId, username: str(json.username), displayName: str(json.display_name), email: str(json.email) };
}

export type SalesforceQueryPage = { records: SalesforceRecord[]; done: boolean };

export async function querySalesforce(accessToken: string, instanceUrl: string, soql: string, fetchImpl: typeof fetch = fetch): Promise<SalesforceQueryPage> {
  let url: string;
  try {
    url = new URL(`/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent(soql)}`, instanceUrl).href;
  } catch {
    throw new SalesforceApiError(UNTRUSTED, "untrusted_host", null, false);
  }
  const json = await salesforceJson<{ records?: unknown; done?: unknown }>(accessToken, url, fetchImpl);
  const records = Array.isArray(json.records) ? (json.records as SalesforceRecord[]) : [];
  return { records, done: json.done !== false };
}

/** Best effort and time-boxed: a Salesforce outage must never block a disconnect. */
export async function revokeSalesforceToken(instanceUrl: string, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await send(
      new URL("/services/oauth2/revoke", instanceUrl).href,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refreshToken }) },
      fetchImpl,
      5_000
    );
    return res.ok;
  } catch {
    return false;
  }
}
```

(The revoke smoke's "untrusted host says no without a call" holds because `send` throws before `fetchImpl`, and `new URL(…, "https://evil.example")` stays on evil.example. A malformed `instanceUrl` makes `new URL` throw, which the `try` also turns into `false`.)

- [ ] **Step 4: HubSpot's side (Ruling 12c).** In `src/lib/crm/hubspot/api.ts`:
  - `HubspotApiError`'s constructor gains a fifth parameter `readonly detail: string | null = null`.
  - `send`'s catch: message `"HubSpot didn’t answer — the next sync will try again"`, detail = the caught message (sliced to 300).
  - `failure`: keep computing `detail`, but NO message interpolates it. 401 → `new ConnectorAuthError("HubSpot refused the access token")`. 404 → `"HubSpot couldn’t find what Orbit asked for — reconnect HubSpot"`. 5xx → `"HubSpot is having trouble — the next sync will try again"`. Other 4xx → `"HubSpot turned down Orbit’s request — reconnect HubSpot, and tell us if it keeps happening"`. 429 and 403 keep their sentences. Pass `detail` (e.g. `` `${status}: ${detail}` ``) as the fifth argument everywhere.
  - Then open `scripts/smoke-hubspot-api.ts` and update every assertion that expected provider text in a message to expect the fixed sentence, and add one check: a 400 whose body is `{ message: "SECRET PROVIDER TEXT" }` yields an error whose `.message` lacks `SECRET` and whose `.detail` contains it.
  - `grep -rn "HubSpot didn’t answer\|HubSpot rejected\|HubSpot returned" src scripts` — update any other smoke or copy that matched the old sentences (e.g. `scripts/smoke-crm-sync.ts`).

- [ ] **Step 5: Register and run.** Add `"smoke-salesforce-api"` to `MANIFEST`. Then:

```bash
npx tsx scripts/smoke-salesforce-api.ts
npx tsx scripts/smoke-hubspot-api.ts
npx tsx scripts/smoke-crm-sync.ts
npx tsx scripts/smoke-toast-copy.ts
npx tsx scripts/run-smoke.ts --check
npx tsc --noEmit -p .
```

- [ ] **Step 6: Commit.** "Add Salesforce's API client, and keep provider text out of every CRM error message" plus the trailer.

---

### Task 5: A CRM layer for two providers — types, connect, and the callback

**Files:**
- Modify: `src/lib/crm/types.ts`
- Modify: `src/lib/crm/connect.ts`
- Modify: `src/app/api/connectors/[connectorId]/callback/route.ts`
- Modify: `.env.example` (Salesforce block after HubSpot's, ~line 222)
- Test: `scripts/smoke-crm-connect.ts`

**Interfaces:**
- Consumes: Task 1 (`instanceUrl` on upsert, `resetConnectorCursor(…, seed)`), Task 2 (`buildAuthorizeUrl` `variant`, `pkceVerifierForState`, `exchangeCode` opts, `isTrustedInstanceUrl`), Task 3 (`SALESFORCE_SCOPES`, `cursorFromProgress`, `progressFromCursor`), Task 4 (`fetchSalesforceIdentity`).
- Produces:
  - from `@/lib/crm/types` (pure): `type CrmConnectorId = "hubspot" | "salesforce"`, `CRM_PROVIDERS: readonly { id: CrmConnectorId; label: string }[]` (HubSpot first), `isCrmConnectorId(id: string): id is CrmConnectorId`, `crmProviderLabel(id: CrmConnectorId): string`, `crmErrorLine(error: string | null): string | null` (passes lines starting `"HubSpot "` or `"Salesforce "`)
  - `CrmConnectionView.connectorId: CrmConnectorId` (was the literal `"hubspot"`)
  - `CrmProviderStatus = { id: CrmConnectorId; label: string; configured: boolean; connection: CrmConnectionView | null; counts: { workContacts: number; pipeline: number; blocked: number } | null }`
  - `CrmStatus = { entitled: boolean; providers: CrmProviderStatus[] }` — REPLACES `{ entitled, configured, connection, counts }`; Task 7 builds it, Task 8 renders it
  - from `@/lib/crm/connect`: `CrmConnectorId` and `isCrmConnectorId` re-exported from types (existing imports keep working); `crmAuthorizeUrl(userId, id, returnTo, opts?: { sandbox?: boolean })`; `completeCrmConnect({ sessionUserId, connectorId, code, state, rawState, fetchImpl? })` — `rawState: string` is new and required

- [ ] **Step 1: Write the failing checks.** In `scripts/smoke-crm-connect.ts`, set `process.env.SALESFORCE_CLIENT_ID = "sf-cid"; process.env.SALESFORCE_CLIENT_SECRET = "sf-secret";` next to its HubSpot env lines, and pass `rawState` to every existing `completeCrmConnect` call (the smoke builds `state` by parsing a signed one — keep the raw string it parsed and pass it; where a test forges a state object, pass `signOAuthState(thatState)`). Then append a Salesforce block:

```ts
  // --- Salesforce (Leads P5) -----------------------------------------------------------
  {
    const SF = "smoke-crm-connect-sf";
    await cleanup(SF); // the smoke's existing per-user cleanup helper — use whatever it calls
    const authorize = new URL(crmAuthorizeUrl(SF, "salesforce", "/leads", { sandbox: true }));
    check("a sandbox connect authorizes at test.salesforce.com", authorize.origin === "https://test.salesforce.com");
    check("and asks for api, refresh_token and id", authorize.searchParams.get("scope") === "api refresh_token id");
    const rawState = authorize.searchParams.get("state")!;
    const state = parseOAuthState(rawState)!;

    const seen: Array<{ url: string; body: string; auth: string | null }> = [];
    const sfProvider = (opts: { instanceUrl?: string; idUrl?: string; orgId?: string } = {}): typeof fetch =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        seen.push({ url, body: String(init?.body ?? ""), auth: new Headers(init?.headers).get("authorization") });
        if (url.endsWith("/services/oauth2/token")) {
          return Response.json({ access_token: "sf-at", refresh_token: "sf-rt", instance_url: opts.instanceUrl ?? "https://acme--dev.sandbox.my.salesforce.com", id: opts.idUrl ?? "https://test.salesforce.com/id/00D000000000001AAA/005000000000001AAA", token_type: "Bearer", issued_at: "1790000000000", signature: "s" });
        }
        if (url.includes("/id/")) {
          return Response.json({ organization_id: opts.orgId ?? "00D000000000001AAA", user_id: "005000000000001AAA", username: "ada@acme.com.dev", display_name: "Ada" });
        }
        return new Response("{}", { status: 404 });
      }) as typeof fetch;

    const done = await completeCrmConnect({ sessionUserId: SF, connectorId: "salesforce", code: "c1", state, rawState, fetchImpl: sfProvider() });
    const exchange = seen.find((s) => s.url.endsWith("/services/oauth2/token"));
    check("the code is exchanged on the sandbox host", exchange?.url === "https://test.salesforce.com/services/oauth2/token", exchange?.url);
    check("with the state's PKCE verifier", new URLSearchParams(exchange?.body).get("code_verifier") === pkceVerifierForState(rawState));
    check("the label is the Salesforce username", done.label === "ada@acme.com.dev");
    const row = await getConnectorConnection(SF, "salesforce");
    check("the org id is the account ref", row?.accountRef === "00D000000000001AAA");
    check("instance_url is stored", row?.instanceUrl === "https://acme--dev.sandbox.my.salesforce.com", String(row?.instanceUrl));
    const claimed = await claimConnectorConnectionForUser(SF, "salesforce");
    check("the cursor is seeded with org and user", claimed?.cursor?.meta?.orgId === "00D000000000001AAA" && claimed.cursor.meta.userId === "005000000000001AAA", JSON.stringify(claimed?.cursor));
    check("and armed", row?.nextSyncAt !== null);
    await markConnectorSyncResult(claimed!.id, { ok: true });

    const evilInstance = await caught(completeCrmConnect({ sessionUserId: SF, connectorId: "salesforce", code: "c2", state, rawState, fetchImpl: sfProvider({ instanceUrl: "https://evil.example" }) }));
    check("an untrusted instance_url is refused", evilInstance instanceof CrmConnectError && evilInstance.kind === "identify_failed");
    const evilId = await caught(completeCrmConnect({ sessionUserId: SF, connectorId: "salesforce", code: "c3", state, rawState, fetchImpl: sfProvider({ idUrl: "https://evil.example/id/x/y" }) }));
    check("an untrusted identity URL is refused", evilId instanceof CrmConnectError && evilId.kind === "identify_failed");
    check("and neither was sent a token", !seen.some((s) => s.url.startsWith("https://evil.example")));
    check("the stored host survived both refusals", (await getConnectorConnection(SF, "salesforce"))?.instanceUrl === "https://acme--dev.sandbox.my.salesforce.com");

    await upsertCrmRecords(SF, "salesforce", [/* one CrmPerson — use the smoke's existing person() helper */ person({ remoteId: "003000000000009AAA" })]);
    const switched = await completeCrmConnect({ sessionUserId: SF, connectorId: "salesforce", code: "c4", state, rawState, fetchImpl: sfProvider({ orgId: "00D000000000002AAA" }) });
    check("another org is a switched account", switched.switchedAccount);
    check("whose old records are gone", (await listCrmRecordsForSmoke(SF, "salesforce")).length === 0);

    const forged = await caught(completeCrmConnect({ sessionUserId: SF, connectorId: "salesforce", code: "c5", state: { ...state, userId: "someone-else" }, rawState, fetchImpl: sfProvider() }));
    check("a state for someone else is refused", forged instanceof CrmConnectError && forged.kind === "state_mismatch");
    const noVerifier = await caught(completeCrmConnect({ sessionUserId: SF, connectorId: "salesforce", code: "c6", state, rawState: "garbage", fetchImpl: sfProvider() }));
    check("a state that yields no verifier is refused", noVerifier instanceof CrmConnectError && noVerifier.kind === "state_mismatch");
  }
```

`listCrmRecordsForSmoke` stands for however this smoke already reads `crm_records` rows (a `db.select().from(crmRecords).where(…)`); use that. Add imports as needed (`crmAuthorizeUrl`, `pkceVerifierForState`, `parseOAuthState`, `signOAuthState`, `claimConnectorConnectionForUser`, `markConnectorSyncResult`, `getConnectorConnection`, `upsertCrmRecords`).

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: `types.ts`.** Add, above `crmErrorLine`:

```ts
export type CrmConnectorId = "hubspot" | "salesforce";

/** The CRMs Leads connects, in the order the card lists them. */
export const CRM_PROVIDERS: readonly { id: CrmConnectorId; label: string }[] = [
  { id: "hubspot", label: "HubSpot" },
  { id: "salesforce", label: "Salesforce" },
];

export function isCrmConnectorId(id: string): id is CrmConnectorId {
  return CRM_PROVIDERS.some((p) => p.id === id);
}

export function crmProviderLabel(id: CrmConnectorId): string {
  return CRM_PROVIDERS.find((p) => p.id === id)?.label ?? "your CRM";
}
```

`crmErrorLine`: pass a line through when it starts with `"HubSpot "` or `"Salesforce "`; rewrite its doc comment to say both providers' API modules write only fixed sentences (Ruling 12c), so the prefix check is a second net, not the only one. `CrmConnectionView.connectorId: CrmConnectorId`. Replace `CrmStatus`:

```ts
/** One CRM's row on the card: whether this server can connect it, and its connection if any. */
export type CrmProviderStatus = {
  id: CrmConnectorId;
  label: string;
  configured: boolean;
  connection: CrmConnectionView | null;
  counts: { workContacts: number; pipeline: number; blocked: number } | null;
};

export type CrmStatus = {
  entitled: boolean;
  providers: CrmProviderStatus[];
};
```

- [ ] **Step 4: `connect.ts`.** Remove the local `CrmConnectorId`/`isCrmConnectorId` and re-export them: `export { isCrmConnectorId, type CrmConnectorId } from "@/lib/crm/types";` (import them for local use too). Then:

```ts
const SCOPES: Record<CrmConnectorId, readonly string[]> = { hubspot: HUBSPOT_SCOPES, salesforce: SALESFORCE_SCOPES };
const REDIRECT_ENV: Record<CrmConnectorId, string> = { hubspot: "HUBSPOT_REDIRECT_URI", salesforce: "SALESFORCE_REDIRECT_URI" };

export function crmAuthorizeUrl(userId: string, id: CrmConnectorId, returnTo: string, opts: { sandbox?: boolean } = {}): string {
  return buildAuthorizeUrl(id, {
    userId,
    redirectUri: crmRedirectUri(id),
    scopes: [...SCOPES[id]],
    returnTo,
    ...(id === "salesforce" && opts.sandbox ? { variant: "sandbox" } : {}),
  });
}
```

Replace the HubSpot-only identify step with a per-provider one:

```ts
type CrmAccount = {
  accountRef: string;
  label: string | null;
  instanceUrl: string | null;
  /** Facts the first sync needs from the connect; null resets the cursor. */
  cursorSeed: ConnectorSyncCursor | null;
};

async function identifyCrmAccount(connectorId: CrmConnectorId, tokens: OAuthTokens, fetchImpl: typeof fetch): Promise<CrmAccount> {
  if (connectorId === "hubspot") {
    const info = await introspectHubspotToken(tokens.accessToken, fetchImpl);
    return { accountRef: info.hubId, label: info.hubDomain, instanceUrl: null, cursorSeed: null };
  }
  const instanceUrl = tokens.extra?.instance_url;
  if (!isTrustedInstanceUrl("salesforce", instanceUrl)) throw new Error("Salesforce named an org host Orbit doesn’t trust");
  const idUrl = tokens.extra?.id;
  if (!idUrl) throw new Error("Salesforce’s token named no identity URL");
  // fetchSalesforceIdentity refuses an untrusted identity host before sending the token.
  const who = await fetchSalesforceIdentity(tokens.accessToken, idUrl, fetchImpl);
  const identity = { orgId: who.orgId, userId: who.userId };
  return {
    accountRef: who.orgId,
    label: who.username ?? who.displayName,
    instanceUrl,
    // Ruling 9: identity is fixed at connect; the sync reads it from here and never guesses.
    cursorSeed: cursorFromProgress(progressFromCursor(null), identity),
  };
}
```

In `completeCrmConnect`: add `rawState: string` to the input; after the userId/connectorId check,

```ts
  // PKCE: the verifier is recomputed from the state this callback was handed (see
  // `pkceVerifierForState`). A state that yields none was never Orbit's to begin with.
  let codeVerifier: string | undefined;
  if (OAUTH_PROVIDERS[input.connectorId]?.pkce) {
    const verifier = pkceVerifierForState(input.rawState);
    if (!verifier) throw new CrmConnectError("The sign-in doesn’t match who started it", "state_mismatch");
    codeVerifier = verifier;
  }
```

and exchange with `exchangeCode(input.connectorId, input.code, crmRedirectUri(input.connectorId), { fetchImpl, codeVerifier, variant: input.state.variant })`. Replace the introspect call with `account = await identifyCrmAccount(input.connectorId, tokens, fetchImpl)` inside the same `identify_failed` try/catch. `switchedAccount` compares `previous.accountRef` with `account.accountRef`. The upsert passes `label: account.label, accountRef: account.accountRef, instanceUrl: account.instanceUrl`. The cursor line becomes `await resetConnectorCursor(input.sessionUserId, input.connectorId, account.cursorSeed);` (keep and adapt its comment). Return `{ label: account.label, accountRef: account.accountRef, switchedAccount }`. The file's doc comment: "HubSpot and Salesforce". Imports: `OAUTH_PROVIDERS`, `pkceVerifierForState`, `isTrustedInstanceUrl`, `type OAuthTokens` from oauth; `fetchSalesforceIdentity`; `SALESFORCE_SCOPES`, `cursorFromProgress`, `progressFromCursor`; `type ConnectorSyncCursor` from `@/db/schema`.

The state check must also compare the variant against nothing — the variant is signed, so it is trusted as-is; there is no query parameter to compare it with.

- [ ] **Step 5: The callback route.** Keep the raw state: `const rawState = url.searchParams.get("state");` before parsing, and pass `rawState: rawState ?? ""` to `completeCrmConnect`. Nothing else changes: its redirect codes stay provider-neutral (Ruling 11).

- [ ] **Step 6: `.env.example`**, after the HubSpot block and in its style:

```bash
# Salesforce (Leads P5). An External Client App (Setup → External Client App Manager) with
# OAuth on, callback APP_BASE_URL + /api/connectors/salesforce/callback, scopes "Manage user
# data via APIs (api)", "Perform requests at any time (refresh_token, offline_access)" and
# "Access the identity URL service (id)", "Require Secret for Web Server Flow" and "Require
# PKCE" on, refresh tokens valid until revoked. Leave these unset and the Leads card says
# Salesforce isn't set up. Sandboxes use the same app (installed in the sandbox org).
# SALESFORCE_CLIENT_ID=
# SALESFORCE_CLIENT_SECRET=
# SALESFORCE_REDIRECT_URI=http://localhost:3000/api/connectors/salesforce/callback
```

If `src/lib/env.ts` lists HubSpot's vars (grep `HUBSPOT_CLIENT_ID` there), add Salesforce's in the same optional form — never required: an unset optional var must not block a production deploy.

- [ ] **Step 7: Run.** `tsc` will now fail in `manage.ts`, `crm-card-view.tsx` and the smokes that build `CrmStatus` — those are Tasks 7 and 8. For THIS task run:

```bash
npx tsx scripts/smoke-crm-connect.ts
npx tsx scripts/smoke-connector-oauth.ts
npx tsc --noEmit -p . 2>&1 | grep -v "manage.ts\|crm-card\|smoke-crm-manage\|smoke-leads-page" | grep "error TS"
```

The last command must print nothing: the only type errors left are the `CrmStatus` consumers Task 7/8 rewrite. To keep the branch green between commits, ALSO make the minimal compile fix in `src/lib/crm/manage.ts`'s `crmStatusFor` now — return `{ entitled, providers: [{ id: "hubspot", label: "HubSpot", configured, connection, counts }] }` with the existing HubSpot-only body — and in `crm-card-view.tsx` read `status.providers[0]` where it read `status.connection`/`status.configured`/`status.counts`, and update the two smokes' literal `CrmStatus` values to the new shape. Task 7/8 replace these stopgaps; say so in the commit body. Then `npx tsc --noEmit -p .` must be clean and `npx tsx scripts/smoke-crm-manage.ts && npx tsx scripts/smoke-leads-page.ts` pass.

- [ ] **Step 8: Commit.** "Connect Salesforce: PKCE, sandboxes, the org's identity and host" plus the trailer.

---

### Task 6: The Salesforce sync — registered, scheduled, and reported; the lease guard on every stop

**Files:**
- Create: `src/lib/crm/salesforce/sync.ts`
- Modify: `src/lib/crm/hubspot/sync.ts` (catch-path lease guard)
- Modify: `src/lib/connectors/registry.ts`, `src/lib/connectors/syncs.ts`, `src/lib/connectors/status.ts`, `src/actions/integrations.ts`
- Create: `scripts/smoke-salesforce-sync.ts`; register it
- Modify: `scripts/smoke-crm-sync.ts` (HubSpot guard case), `scripts/smoke-connector-registry.ts`, `scripts/smoke-integration-statuses.ts` (if it enumerates connector ids)

**Interfaces:**
- Consumes: everything in Tasks 1–4; `persistCrmPage(ctx, connectorId, people, now)`; `openIngestContext`, `finalizeIngest`; `connectorLeaseHeld`, `markConnectorSyncResult`, `saveConnectorCursor`; `openConnectorAuth`; `getEntitlements`.
- Produces:
  - `SALESFORCE_SYNC_BUDGET_MS = 45_000`
  - `type SalesforceSyncDeps = { fetchImpl?: typeof fetch; now?: () => Date; budgetMs?: number; auth?: ConnectorAuthDeps }`
  - `type CrmSyncResult = { outcome: "complete" | "partial" | "needs_reauth" | "stopped"; pages: number; records: number; contactsCreated: number; leadsCreated: number; blocked: number; message?: string }` — exported from `@/lib/crm/types` (pure); `HubspotSyncResult` becomes `export type HubspotSyncResult = CrmSyncResult;`
  - `syncSalesforce(conn: ClaimedConnectorConnection, deps?: SalesforceSyncDeps): Promise<CrmSyncResult>`
  - registry entry `salesforce`, `CONNECTOR_SYNCS.salesforce`, `"salesforce"` in `CONNECTOR_STATUS_LOOKUP_IDS`, `connectors.salesforce` in `getIntegrationStatuses`

- [ ] **Step 1: Write the failing smoke** `scripts/smoke-salesforce-sync.ts`. Model it on `scripts/smoke-crm-sync.ts` (read it first: how it seeds an entitled user — `userSettings` plan — upserts and claims a connection, stubs `fetchImpl`, and reads `crm_records`/`contacts`/`leads` back). Use a routing stub that answers SOQL by object and by the resume clause:

```ts
const INSTANCE = "https://acme.my.salesforce.com";
const OWNER = "005000000000001AAA";
const ORG = "00D000000000001AAA";

function contactRecord(n: number, stamp: string) {
  return { Id: `003000000000${String(n).padStart(3, "0")}AAA`, FirstName: "C", LastName: `Person ${n}`, Email: `c${n}@acme.com`, OwnerId: OWNER, SystemModstamp: stamp, Account: { Name: "Acme" } };
}
function leadRecord(n: number, stamp: string, converted = false) {
  return { Id: `00Q000000000${String(n).padStart(3, "0")}AAA`, FirstName: "L", LastName: `Lead ${n}`, Email: `l${n}@prospect.com`, Company: "Prospect", Status: "Open", IsConverted: converted, OwnerId: OWNER, SystemModstamp: stamp };
}

type Route = (soql: string) => { status: number; body: unknown };
const soqls: string[] = [];
function salesforce(route: Route): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const soql = url.searchParams.get("q") ?? "";
    soqls.push(soql);
    const { status, body } = route(soql);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
```

Seed each case's connection with `upsertConnectorConnection({ userId, connectorId: "salesforce", authKind: "oauth2", accountRef: ORG, label: "ada@acme.com", accessToken: "at", refreshToken: "rt", instanceUrl: INSTANCE, capabilities: ["syncPeople"] })` then `resetConnectorCursor(userId, "salesforce", cursorFromProgress(progressFromCursor(null), { orgId: ORG, userId: OWNER }))`, then `claimConnectorConnectionForUser`. Cases and checks (one `check` each):

1. **First run, both objects.** Route: a Contact query without a resume clause → 2 contacts (`2026-09-01T00:00:00.000+0000`, `2026-09-02T…`); any Lead query → 1 open lead + 1 converted lead; everything else → `{ records: [] }`. Expect: outcome `complete`; `records === 4`; the two contacts are Orbit contacts (`crm_records` rows with `contact_id` set, `connector_id = 'salesforce'`); the open lead is in `leads` with `crm_record_id` set; the converted lead's `crm_records.lifecycle` is `customer`; every SOQL contains `OwnerId = '${OWNER}'`; the stored cursor's `meta.phase === "Contact"`, `meta.contactAt === "2026-09-01T23:55:00.000Z"` (2 Sept minus 5 min) and `meta.contactId === ""`; `sync_status` is `idle`, `last_synced_at` set, `sync_error` null.
2. **Resume.** Run again with a route that returns nothing: every Contact SOQL now contains `SystemModstamp >= 2026-09-01T23:55:00Z`; outcome `complete`; `records === 0`; no ingest context opened (no new contacts — compare contact count).
3. **A full page continues, and the budget makes it partial.** Route returns exactly 200 contacts for the first Contact query and 200 more for the resumed one; `deps.now` advances 30 s per call and `budgetMs: 45_000`. Expect outcome `partial`, `next_sync_at` ≈ now (re-armed), and the cursor's `meta.contactId` is the last record's id (mid-phase, not rewound).
4. **Field-level security.** Route: a Contact query containing `Phone` → `400 [{ errorCode: "INVALID_FIELD", message: "No such column 'Phone'" }]`; a lean query → 1 contact. Expect outcome `complete`, `records >= 1`, the cursor's `meta.lean === "1"`, and a SOQL without `Phone` was sent.
5. **API disabled stops.** Route → `403 API_DISABLED_FOR_ORG`. Expect outcome `stopped`; the row's `sync_error` starts with `"Salesforce says API access is off"`; `next_sync_at` null (disarmed); `sync_error` contains no provider text.
6. **Daily limit throws for the scheduler.** Route → `403 REQUEST_LIMIT_EXCEEDED`. `syncSalesforce` rejects with a `SalesforceApiError` whose `retryable` is true.
7. **401 → one refresh → retry.** Route answers 401 `INVALID_SESSION_ID` when the `authorization` header is `Bearer at`, else data (the stub needs the header — read it from `init.headers`). `deps.auth = { refresh: async (_id, _rt, instanceUrl) => { refreshedWith.push(instanceUrl); return { accessToken: "at2", refreshToken: null, expiresAt: null, scopes: null }; } }`. Expect `refreshedWith` is `[INSTANCE]` and outcome `complete`.
8. **Refresh refused → needs_reauth.** `refresh` throws `new OAuthTokenError("expired access/refresh token", true)`. Expect outcome `needs_reauth`, the row's `status === "needs_reauth"`.
9. **Lost lease writes nothing.** A route that, on its first call, runs `claimConnectorConnectionForUser(userId, "salesforce", new Date(Date.now() + SYNC_LEASE_MS + 1000))` (stealing the lease), then returns 1 contact. Expect outcome `stopped`, message about the connection changing, zero `crm_records` for this user, and the stolen claim's `sync_started_at` still on the row.
10. **Lost lease on the stop path (Ruling 12b).** A route that steals the lease the same way, then answers `403 API_DISABLED_FOR_ORG`. Expect outcome `stopped` and the row's `sync_error` still null — the stop was not recorded over the new holder.
11. **Not entitled.** A user on the free plan: outcome `stopped`, `sync_error` is the upgrade line, no SOQL sent.
12. **No identity / another org.** A cursor without meta → outcome `stopped`, message says reconnect, no SOQL sent. A cursor whose `meta.orgId` differs from `account_ref` → same.
13. **Untrusted host.** `instance_url` set directly in the database to `https://evil.example` (a raw `db.update`) → outcome `stopped`, no fetch at all.

Also append to `scripts/smoke-crm-sync.ts` (HubSpot) a case mirroring #10: steal the lease inside the stubbed fetch, then answer a 403; expect `sync_error` null on the row.

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement `src/lib/crm/salesforce/sync.ts`.** Move the result type first: add `CrmSyncResult` to `src/lib/crm/types.ts` (the shape above) and in `hubspot/sync.ts` replace the `HubspotSyncResult` definition with `export type HubspotSyncResult = CrmSyncResult;`.

```ts
/**
 * One Salesforce sync run for one claimed connection: the Contacts and Leads the person who
 * connected OWNS (`OwnerId` — the API user can usually read far more), Contacts into work
 * contacts, open Leads into the Leads pipeline, converted Leads as customers.
 *
 * The same contract as `syncHubspot` (read its doc): a cursor after every page, the run's end
 * recorded by the run, retryable throws, and no write — not even a stop — once the lease is
 * gone. Salesforce-specific: every call goes to the org's own `instance_url`, identity comes
 * from the connect (Ruling 9), and paging is a keyset on `(SystemModstamp, Id)` (Ruling 6).
 */
import type { ClaimedConnectorConnection } from "@/lib/connectors/connections";
import { connectorLeaseHeld, markConnectorSyncResult, saveConnectorCursor } from "@/lib/connectors/connections";
import { ConnectorNeedsReauthError } from "@/lib/connectors/auth-errors";
import { openConnectorAuth, type ConnectorAuthDeps } from "@/lib/connectors/token";
import { persistCrmPage } from "@/lib/crm/persist";
import type { CrmPerson, CrmSyncResult } from "@/lib/crm/types";
import { getEntitlements } from "@/lib/entitlements";
import { finalizeIngest, openIngestContext, type IngestContext } from "@/lib/ingest/events";
import { SalesforceApiError, querySalesforce } from "./api";
import {
  SALESFORCE_PAGE,
  advanceProgress,
  buildOwnedQuery,
  cursorFromProgress,
  identityFromCursor,
  isTrustedSalesforceUrl,
  mapSalesforceRecord,
  markOf,
  progressFromCursor,
} from "./mapping";

/** Inside the scheduler's 60 s per-connection share, with room to record the result. */
export const SALESFORCE_SYNC_BUDGET_MS = 45_000;

export type SalesforceSyncDeps = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  budgetMs?: number;
  auth?: ConnectorAuthDeps;
};

const NOT_ENTITLED = "Salesforce sync is on Orbit Pro and Lifetime — upgrade to keep it running";
const RECONNECT = "Salesforce didn’t say which org and user to sync — reconnect Salesforce";
const LEASE_LOST = "Salesforce’s connection changed during the sync";

export async function syncSalesforce(conn: ClaimedConnectorConnection, deps: SalesforceSyncDeps = {}): Promise<CrmSyncResult> {
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const budget = deps.budgetMs ?? SALESFORCE_SYNC_BUDGET_MS;
  const started = now().getTime();
  const result: CrmSyncResult = { outcome: "complete", pages: 0, records: 0, contactsCreated: 0, leadsCreated: 0, blocked: 0 };

  const holdsLease = () => connectorLeaseHeld(conn.id, conn.leaseStartedAt);
  // Nothing recorded: the row is gone, or belongs to a newer run.
  const leaseLost = (): CrmSyncResult => ({ ...result, outcome: "stopped", message: LEASE_LOST });
  // A stop disarms the row — so it checks the lease first, like every other write (Ruling 12b).
  const stop = async (message: string): Promise<CrmSyncResult> => {
    if (!(await holdsLease())) return leaseLost();
    await markConnectorSyncResult(conn.id, { ok: false, error: message, retryable: false });
    return { ...result, outcome: "stopped", message };
  };

  const entitlements = await getEntitlements(conn.userId);
  if (!entitlements.canUseCrm) return stop(NOT_ENTITLED);

  const instanceUrl = conn.instanceUrl;
  const identity = identityFromCursor(conn.cursor);
  if (!isTrustedSalesforceUrl(instanceUrl) || !identity || identity.orgId !== conn.accountRef) return stop(RECONNECT);

  const auth = openConnectorAuth(conn, deps.auth);
  let progress = progressFromCursor(conn.cursor);
  let ctx: IngestContext | null = null;
  let done = false;
  let lost = false;
  try {
    try {
      while (now().getTime() - started < budget) {
        const object = progress.phase;
        const after = object === "Contact" ? progress.contact : progress.lead;
        let page;
        try {
          // `conn.instanceUrl`, not the local: a refresh inside `auth.call` may have moved it.
          page = await auth.call((token) =>
            querySalesforce(token, conn.instanceUrl ?? instanceUrl, buildOwnedQuery(object, { ownerId: identity.userId, after, lean: progress.lean }), fetchImpl)
          );
        } catch (err) {
          // Ruling 8: a field this user can't see. Read the ones they can, for good.
          if (err instanceof SalesforceApiError && err.kind === "invalid_field" && !progress.lean) {
            progress = { ...progress, lean: true };
            continue;
          }
          throw err;
        }
        const people = page.records
          .map((raw) => mapSalesforceRecord(object, raw, { instanceUrl: conn.instanceUrl ?? instanceUrl }))
          .filter((p): p is CrmPerson => p !== null);
        if (!(await holdsLease())) {
          lost = true;
          break;
        }
        if (people.length > 0) {
          ctx ??= await openIngestContext(conn.userId, { source: "salesforce", createsContacts: true, reportResolutions: true });
          const stats = await persistCrmPage(ctx, "salesforce", people, now());
          result.records += stats.records;
          result.contactsCreated += stats.contactsCreated;
          result.leadsCreated += stats.leadsCreated;
          result.blocked += stats.blocked;
        }
        result.pages++;
        // From the RAW records: a page of skipped (nameless) records must still move the mark.
        const last = page.records.length ? markOf(page.records[page.records.length - 1]) : null;
        const step = advanceProgress(progress, { last, full: page.records.length >= SALESFORCE_PAGE });
        progress = step.progress;
        await saveConnectorCursor(conn.id, cursorFromProgress(progress, identity));
        if (step.done) {
          done = true;
          break;
        }
      }
    } finally {
      // A lost lease writes nothing more — not even the derived-state kick for pages already in.
      if (ctx && !lost) await finalizeIngest(ctx);
    }

    if (lost || !(await holdsLease())) return leaseLost();
    await markConnectorSyncResult(conn.id, {
      ok: true,
      cursor: cursorFromProgress(progress, identity),
      ...(done ? {} : { nextSyncAt: now() }),
    });
    return { ...result, outcome: done ? "complete" : "partial" };
  } catch (err) {
    if (err instanceof ConnectorNeedsReauthError) return { ...result, outcome: "needs_reauth", message: err.message };
    if (err instanceof SalesforceApiError && !err.retryable) return stop(err.message);
    throw err;
  }
}
```

Check before moving on: `openIngestContext`'s `source` parameter type — if it is a union that lacks `"salesforce"`, add it where `"hubspot"` was added in P4 (grep `"hubspot"` in `src/lib/ingest/`). If `markOf` returns null for a last record without a stamp, the mark does not move; the page still counts. A page where EVERY record lacks a valid stamp and is full would loop — `advanceProgress` with `last: null, full: true` finishes the phase (its `page.full && page.last` guard), which is the safe outcome.

- [ ] **Step 4: HubSpot's catch path (Ruling 12b).** In `src/lib/crm/hubspot/sync.ts`, make `stop` check the lease first exactly as above (`if (!(await holdsLease())) return leaseLost();` before `markConnectorSyncResult`). Move the `holdsLease`/`leaseLost` definitions above `stop` so it can call them. The entitlement stop at the top also goes through it — harmless, the lease was just taken.

- [ ] **Step 5: Register.**
  - `registry.ts`, after the `hubspot` entry:

```ts
  {
    id: "salesforce",
    label: "Salesforce",
    family: "crm",
    auth: "oauth2",
    availability: "available",
    entitlement: "crm",
    rateBucket: "providerSync",
    purgeCategory: "connections",
    // P5 reads people. Scopes mirror `SALESFORCE_SCOPES` in src/lib/crm/salesforce/mapping.ts
    // (smoke-connector-registry compares them).
    capabilities: [read("syncPeople", "Read the contacts and leads you own", ["api", "refresh_token", "id"])],
  },
```

  - `syncs.ts`: `salesforce: async (conn) => { await syncSalesforce(conn); },` with the import.
  - `status.ts`: add `"salesforce"` to `CONNECTOR_STATUS_LOOKUP_IDS` after `"hubspot"`.
  - `src/actions/integrations.ts`: add `settle(requireUserId().then((id) => getConnectorConnection(id, "salesforce")))` as the 11th lookup (destructure name `salesforce`), and after the HubSpot block:

```ts
  // Salesforce's row (Leads P5): the connected username, or why not.
  connectors.salesforce =
    salesforce === "unknown"
      ? "unknown"
      : salesforce === null
        ? { state: "off", detail: "Not connected" }
        : salesforce.status === "needs_reauth"
          ? { state: "partial", detail: "Reconnect needed" }
          : { state: "on", detail: salesforce.label ?? "Connected" };
```

  - `scripts/smoke-connector-registry.ts`: wherever it compares HubSpot's registry scopes with `HUBSPOT_SCOPES`, add the same comparison for Salesforce with `SALESFORCE_SCOPES`. `scripts/smoke-integration-statuses.ts`: if it lists connector ids or asserts `CONNECTOR_STATUS_LOOKUP_IDS`, add `salesforce`.
  - The behavior golden (`smoke-behavior-golden`) records `getIntegrationStatuses`; the demo user has no Salesforce row, so `connectors.salesforce` appears as `{ "state": "off", "detail": "Not connected" }`. Run it; if that is the only difference, re-record with `--update` and say so in the commit.

- [ ] **Step 6: Register the smoke and run.**

```bash
npx tsx scripts/smoke-salesforce-sync.ts
npx tsx scripts/smoke-crm-sync.ts
npx tsx scripts/smoke-connector-registry.ts
npx tsx scripts/smoke-connector-sync-pass.ts
npx tsx scripts/smoke-integration-statuses.ts
npx tsx scripts/smoke-behavior-golden.ts
npx tsx scripts/run-smoke.ts --check
npx tsc --noEmit -p .
```

- [ ] **Step 7: Commit.** "Sync the Salesforce Contacts and Leads a person owns, and record no stop after a lost lease" plus the trailer.

---

### Task 7: Status, "Sync now" and disconnect for either CRM

**Files:**
- Modify: `src/lib/crm/manage.ts`
- Modify: `src/actions/crm.ts`
- Test: `scripts/smoke-crm-manage.ts`

**Interfaces:**
- Consumes: `CRM_PROVIDERS`, `crmProviderLabel`, `CrmStatus`, `CrmProviderStatus`, `CrmSyncResult` (types); `syncHubspot`, `syncSalesforce`; `revokeHubspotToken`, `revokeSalesforceToken`; `ConnectorConnectionSummary.instanceUrl`.
- Produces:
  - `crmStatusFor(userId): Promise<CrmStatus>` — one `CrmProviderStatus` per `CRM_PROVIDERS` entry, in order
  - `runCrmSyncNow(userId, connectorId: CrmConnectorId, deps?: { sync?: (conn, opts: { budgetMs: number }) => Promise<CrmSyncResult>; consume? })`
  - `disconnectCrm(userId, connectorId, deps?: { revoke?: (refreshToken: string, instanceUrl: string | null) => Promise<boolean> })`
  - `startCrmConnectAction(connectorId: string, options?: { sandbox?: boolean })`

- [ ] **Step 1: Write the failing checks.** In `scripts/smoke-crm-manage.ts` (set the Salesforce env next to HubSpot's), update existing expectations to the new `CrmStatus` shape (`status.providers.find((p) => p.id === "hubspot")`), then add:
  - `crmStatusFor` for a user with no connections lists `["hubspot", "salesforce"]` in that order, both `connection: null`, `counts: null`, `configured: true` (env set).
  - With a Salesforce connection upserted (`instanceUrl` set, label `"ada@acme.com"`) and two `crm_records` (`connectorId: "salesforce"`, one customer linked, one lead): the Salesforce entry's `connection.label === "ada@acme.com"`, `connection.connectorId === "salesforce"`, and `counts` match; the HubSpot entry is unaffected.
  - `runCrmSyncNow(user, "salesforce", { sync: stub, consume: noop })` hands the stub a claimed row whose `connectorId` is `"salesforce"` and whose `instanceUrl` is set; the stub's result comes back.
  - The not-connected / needs-reauth / already-syncing refusals name the provider: `"Connect Salesforce first"`, `"Salesforce needs you to reconnect — use Reconnect, then sync"`.
  - `disconnectCrm(user, "salesforce", { revoke })` calls `revoke` with the refresh token AND `"https://acme.my.salesforce.com"`, then deletes the connection and only Salesforce's `crm_records` (a HubSpot record for the same user survives).
  - Default revoke wiring: with `revoke` omitted and a fake `instanceUrl` of `https://evil.example` written straight to the row, `disconnectCrm` still disconnects (revoke returns false without a network call — `revokeSalesforceToken` refuses the host) and does not throw.

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: `manage.ts`.**

```ts
const SYNCS: Record<CrmConnectorId, (conn: ClaimedConnectorConnection, opts: { budgetMs: number }) => Promise<CrmSyncResult>> = {
  hubspot: (conn, opts) => syncHubspot(conn, opts),
  salesforce: (conn, opts) => syncSalesforce(conn, opts),
};

function defaultRevoke(connectorId: CrmConnectorId): (refreshToken: string, instanceUrl: string | null) => Promise<boolean> {
  return async (token, instanceUrl) => {
    if (!isOAuthConfigured(connectorId)) return false;
    if (connectorId === "hubspot") return revokeHubspotToken(token);
    return instanceUrl ? revokeSalesforceToken(instanceUrl, token) : false;
  };
}

export async function crmStatusFor(userId: string): Promise<CrmStatus> {
  const [entitlements, connections] = await Promise.all([getEntitlements(userId), listConnectorConnections(userId)]);
  const leaseCutoff = Date.now() - SYNC_LEASE_MS;
  const providers = await Promise.all(
    CRM_PROVIDERS.map(async ({ id, label }): Promise<CrmProviderStatus> => {
      const connection = connections.find((c) => c.connectorId === id) ?? null;
      return {
        id,
        label,
        configured: isOAuthConfigured(id),
        connection: connection ? viewOf(id, connection, leaseCutoff) : null,
        counts: connection ? await crmCounts(userId, id) : null,
      };
    })
  );
  return { entitled: entitlements.canUseCrm, providers };
}
```

`viewOf(id, connection, leaseCutoff): CrmConnectionView` is the existing object literal from `crmStatusFor`, with `connectorId: id`. Import `listConnectorConnections` (one read for both providers instead of two `getConnectorConnection` calls).

In `runCrmSyncNow`: `const label = crmProviderLabel(connectorId);` and every message interpolates it — `` `Connect ${label} first` ``, `` `${label} needs you to reconnect — use Reconnect, then sync` `` (identical sentence the card toasts for `needs_reauth`, Ruling 12a), `` `The demo’s ${label} data is sample data — there’s nothing to sync` ``, and `DIDNT_ANSWER` becomes `` `${label} didn’t answer — the next automatic sync will try again` ``. The sync call becomes `(deps.sync ?? SYNCS[connectorId])(conn, { budgetMs: SYNC_NOW_BUDGET_MS })`. The backstop comment: "which both CRM syncs always do".

**Ruling 12a on the server:** when the result's `outcome` is `"needs_reauth"`, return `message: `${label} needs you to reconnect — use Reconnect, then sync`` instead of `result.message` (the token endpoint's own text). For `"stopped"`, `result.message` is already a fixed sentence (Task 4/6), so pass it through `crmErrorLine` anyway — a second net.

In `disconnectCrm`: the lease refusal names the provider (`` `${label} is syncing right now — disconnect again in a minute` ``), `revoke` gets `(refresh, summary.instanceUrl)`, the report message becomes `` `${label} did not accept the token revoke` ``. The file's doc comment: "either CRM".

- [ ] **Step 4: `src/actions/crm.ts`.** `UPGRADE = "CRM sync is on Orbit Pro and Lifetime — upgrade to connect it"`. `startCrmConnectAction(connectorId: string, options: { sandbox?: boolean } = {})`: after the id check, `` if (!isOAuthConfigured(connectorId)) throw new UserFacingError(`${crmProviderLabel(connectorId)} isn’t set up on this server yet`); `` and `crmAuthorizeUrl(userId, connectorId, "/leads", { sandbox: options.sandbox === true })` (a strict `=== true`: the argument arrives from the client). Import `crmProviderLabel` from `@/lib/crm/types`. No new exports, all `async function`.

- [ ] **Step 5: Run.**

```bash
npx tsx scripts/smoke-crm-manage.ts
npx tsx scripts/smoke-leads-page.ts
npx tsx scripts/smoke-toast-copy.ts
npx tsx scripts/smoke-use-server-exports.ts 2>/dev/null || true   # if this smoke exists; otherwise skip
npx tsc --noEmit -p .
```

(If `smoke-leads-page` pins the actions file's text — e.g. that each action starts with `requireLeadsUser` — keep those pins true.)

- [ ] **Step 6: Commit.** "Run Sync now, status and disconnect for Salesforce as well as HubSpot" plus the trailer.

---

### Task 8: The two-provider CRM card

**Files:**
- Modify: `src/components/leads/crm-card-view.tsx`
- Modify: `src/components/leads/crm-card.tsx`
- Test: `scripts/smoke-leads-page.ts`

**Interfaces:**
- Consumes: `CrmStatus`, `CrmProviderStatus` (Task 5), the actions (Task 7).
- Produces:
  - `type CrmPending = { action: "connect" | "sync" | "disconnect"; id: CrmConnectorId } | null`
  - `CrmCardView({ status, pending, onConnect, onSync, onDisconnect })` with `onConnect: (id: CrmConnectorId, opts?: { sandbox?: boolean }) => void`, `onSync: (id: CrmConnectorId) => void`, `onDisconnect: (id: CrmConnectorId) => void`

- [ ] **Step 1: Write the failing checks.** In `scripts/smoke-leads-page.ts`'s card section (it renders `CrmCardView` to text with `React.createElement` and a `text()` helper), rebuild `base` in the new shape and cover:
  - **Nothing connected, entitled, both configured:** the text contains "Connect your CRM", "Connect HubSpot", "Connect Salesforce" and "Use a sandbox".
  - **Only HubSpot configured:** "Connect HubSpot" present, "Connect Salesforce" absent, and no sentence claims Salesforce is missing (the card lists only what this server can connect; an unconfigured provider is simply not offered).
  - **Neither configured:** "isn’t set up on this server yet" (one sentence, no provider named twice).
  - **Not entitled:** "CRM sync is on Orbit Pro and Lifetime." and "See plans"; no connect buttons.
  - **HubSpot connected, Salesforce configured but not:** "HubSpot · acme.hubspot.com", its counts and "Sync now", AND "Connect Salesforce" (a smaller row — assert the button text is present, and "Connect your CRM" is not).
  - **Salesforce connected:** "Salesforce · ada@acme.com", its counts; the reauth variant says "Salesforce needs you to reconnect" and "Reconnect Salesforce".
  - **Both connected:** both titles, two "Sync now" and two "Disconnect" buttons (count occurrences).
  - **Pending:** `pending: { action: "sync", id: "salesforce" }` → "Syncing…" appears once and every button is disabled (render with `renderToStaticMarkup` and count `disabled=""` if the helper can; otherwise assert the Salesforce section's text).
  - Keep the existing checks that a stored raw error (`"Token endpoint returned 400"`) never renders — now for both providers.
  - `crm-card.tsx` pins (text checks on the source, the pattern the smoke already uses): it calls `startCrmConnectAction(id, { sandbox })`, `syncCrmNowAction(id)`, `disconnectCrmAction(id)`; the `needs_reauth` toast is the fixed `` `${label} needs you to reconnect — use Reconnect, then sync` `` — assert the source does NOT contain `r.message ?? ` inside the `needs_reauth` branch (Ruling 12a).

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: `crm-card-view.tsx`.** Structure:

```tsx
const PITCH =
  "Bring your CRM in: your customers become work contacts, and your leads join this pipeline — ranked by who on your team knows them.";

export type CrmPending = { action: "connect" | "sync" | "disconnect"; id: CrmConnectorId } | null;

export function CrmCardView({ status, pending, onConnect, onSync, onDisconnect }: {
  status: CrmStatus;
  pending: CrmPending;
  onConnect: (id: CrmConnectorId, opts?: { sandbox?: boolean }) => void;
  onSync: (id: CrmConnectorId) => void;
  onDisconnect: (id: CrmConnectorId) => void;
}) {
  const connected = status.providers.filter((p) => p.connection);
  const connectable = status.providers.filter((p) => !p.connection && p.configured);
  const busy = pending !== null || connected.some((p) => p.connection?.syncing);

  if (connected.length === 0) {
    return (
      <Shell title="Connect your CRM" body={PITCH}>
        {!status.entitled ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted-foreground">CRM sync is on Orbit Pro and Lifetime.</span>
            <Link href="/upgrade" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>See plans</Link>
          </div>
        ) : connectable.length === 0 ? (
          <p className="text-sm text-muted-foreground">CRM sync isn’t set up on this server yet.</p>
        ) : (
          <ConnectButtons providers={connectable} pending={pending} disabled={busy} onConnect={onConnect} />
        )}
      </Shell>
    );
  }

  return (
    <div className="space-y-4">
      {connected.map((p) => (
        <ConnectedProvider key={p.id} provider={p} entitled={status.entitled} pending={pending} busy={busy}
          onConnect={onConnect} onSync={onSync} onDisconnect={onDisconnect} />
      ))}
      {status.entitled && connectable.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-border/70 px-5 py-3 text-sm">
          <span className="text-muted-foreground">Use another CRM too?</span>
          <ConnectButtons providers={connectable} pending={pending} disabled={busy} onConnect={onConnect} size="sm" />
        </div>
      ) : null}
    </div>
  );
}
```

- `ConnectButtons`: for each provider a `<Button>` "Connect {label}" (busy text "Opening {label}…" when `pending` is `{ action: "connect", id }`); for Salesforce also a `variant="ghost"` button "Use a sandbox" calling `onConnect("salesforce", { sandbox: true })`, with `aria-label="Connect a Salesforce sandbox"`.
- `ConnectedProvider`: the P4 body — needs-reauth `Shell` and the connected `Shell` — with every "HubSpot" replaced by `provider.label`, every handler called with `provider.id`, "Reconnect {label}" (the Salesforce reconnect keeps production; a sandbox user reconnects with the sandbox button — add a ghost "Reconnect a sandbox" next to it for Salesforce in the needs-reauth and paused states), `pending` checks comparing both `action` and `id`, and the per-connection `disabled={busy}` so one provider's sync blocks the other's buttons (two parallel claims would be fine server-side, but one busy card is less confusing). "See work contacts" stays on each connected section.
- `Shell` unchanged, but its `aria-label` becomes the title for connected sections (`aria-label={title}`) so two sections are not both "Your CRM"; keep "Your CRM" for the unconnected shell.

- [ ] **Step 4: `crm-card.tsx`.** `pending` state becomes `CrmPending`; `confirming` becomes `CrmConnectorId | null`. `CRM_RETURN.provider` → `"your CRM"`, `connectedText` → `"CRM connected — your first sync starts within a few minutes"`, `not_entitled` → `"CRM sync is on Orbit Pro and Lifetime — upgrade, then connect again"`. `connect(id, opts)` → `startCrmConnectAction(id, { sandbox: opts?.sandbox === true })`, error fallback `` `Couldn’t open ${label} — try again?` ``. `sync(id)`:

```ts
        const r = result.value;
        const label = crmProviderLabel(id);
        // Fixed words: the server already swapped a token endpoint's text for this sentence,
        // and the card must never be the place provider text leaks back in (Ruling 12a).
        if (r.outcome === "needs_reauth") toast.error(`${label} needs you to reconnect — use Reconnect, then sync`);
        else if (r.outcome === "stopped") toast.error(r.message ?? `${label} sync stopped — see the card for why`);
        else if (r.outcome === "partial") toast.message(`Synced part of ${label} — the rest follows automatically`);
        else toast.success(r.records === 0 ? `${label} is up to date` : `Synced ${r.records.toLocaleString()} from ${label}`);
```

`disconnect()` reads the id from `confirming`; the dialog title is `` `Disconnect ${label}?` `` and its description names the provider ("Orbit stops syncing, asks {label} to revoke its access, and forgets which contacts came from it. …"). Toasts `` `${label} disconnected` ``. Import `crmProviderLabel`, `type CrmConnectorId` from `@/lib/crm/types` (pure — allowed in a client component).

- [ ] **Step 5: Run.**

```bash
npx tsx scripts/smoke-leads-page.ts
npx tsx scripts/smoke-toast-copy.ts
npx eslint src/components/leads src/lib/crm src/actions/crm.ts
npx tsc --noEmit -p .
```

Also grep the `/leads` page and `loading.tsx` for anything that read the old `CrmStatus` fields (`status.connection`, `status.configured`) and update it.

- [ ] **Step 6: Commit.** "Show HubSpot and Salesforce on the CRM card, each with its own connect, sync and disconnect" plus the trailer.

---

### Task 9: Whole-branch verification, the browser, and the PR (controller)

- [ ] **Step 1: Rescan schema versions** across every ref and worktree (`bash -c`, the loop from the P4 plan's Task 15). 124 must still be free; if not, take the next free number, move the changelog/alters comments, `--update` the lock.
- [ ] **Step 2: Suite.** `npm test > /tmp/p5-suite.txt 2>&1; echo $?`, then `grep -E "^ *FAIL|passed in" /tmp/p5-suite.txt`. A lone admin-render/instrumentation load timeout is rerun alone (`orbit-smoke-suite-load-flakes`). `npx eslint .` → 0 errors (baseline 45 warnings).
- [ ] **Step 3: Build.** Stop any dev server on this worktree; `npm run build`; then `rm -rf .next` (a build wedges the next `next dev`).
- [ ] **Step 4: Browser.** Move `.data/pglite` aside (it is stamped 123), start the preview (`.claude/launch.json`), sign in as the localhost demo, turn on "Preview unreleased" from /admin if `/leads` is gated, and check `/leads`: the demo's HubSpot section renders as before plus the "Use another CRM too?" row IF `SALESFORCE_CLIENT_ID`/`SECRET` are set in `.env.local` (set throwaway values for the check — never real ones — and remove them after); "Connect Salesforce" navigates to `login.salesforce.com/services/oauth2/authorize?…code_challenge=…` (read the URL, do not complete a login); "Use a sandbox" to `test.salesforce.com`. Screenshot light and dark, and a 375 px width. Check the console for errors.
- [ ] **Step 5: Push and open the PR** against `claude/leads-p4-hubspot`: title "Leads P5: Salesforce read sync (schema 124)". The body lists what shipped, the 12 rulings in one line each, the verification, and Jason's manual steps:
  1. Create the External Client App in a Salesforce org (Setup → External Client App Manager → New): OAuth on; callback `https://<prod host>/api/connectors/salesforce/callback` (plus `http://localhost:3000/…` on a dev app); scopes `api`, `refresh_token`, `id`; "Require Secret for Web Server Flow" and "Require PKCE" on; refresh token policy "valid until revoked".
  2. Put its consumer key/secret in Vercel as `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` (and `.env.local`).
  3. One real round trip against a Developer Edition org: connect, Sync now, see a Contact as a work contact and a Lead in the pipeline, disconnect.
  Plus the trailer line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 6: Memory.** Update `orbit-leads-program.md` and its `MEMORY.md` line (P5 = PR number, schema 124).
