# Launch Phase 3a — Integrations and AI Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Orbit's Google/Microsoft/Eventbrite connections report and recover from their real state, and make every AI-key failure (rejected, out of credit, unavailable model, client gone) stop the work it breaks and say so in plain words, while bounding the third-party quotas Orbit pays for.
**Architecture:** Token refresh stops re-arming sync; Google HTTP calls share one DB-free retry wrapper; connection health is one pure derivation (`src/lib/connection-status.ts`) read by the actions, the cards and the account-alert bell. AI failures gain a `quota` kind in `src/lib/errors.ts`, and the recruiter scan, meeting chunks, chat stream and embedding backfill each act on the classified kind instead of retrying blindly. Shared quotas (avatar sources, hosted Apollo, the public contact form) go through the existing `consumeBucket` table.
**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle over Neon (neon-http) / PGlite, Clerk, Stripe, tsx smoke scripts
**Spec:** docs/production-readiness-audit-2026-09-15.md (items: B5 — refresh/re-arm, sync_error surfacing, `connection.google_calendar` alert, Eventbrite outcome, Microsoft reauth regex, People/Calendar retry wrapper, 401 in `fetchGmailHeaders`; B8 — quota kind, scan abort before the watermark, meeting-chunk terminal codes, `request.signal` into `streamText`, per-provider clear; A9 remainder — embedding failures surfaced in chat, unembeddable rows; B14 — shared avatar budget, Apollo daily buckets, contact-form limit, Twilio STOP)
**Roadmap:** docs/superpowers/plans/2026-09-15-launch-readiness-roadmap.md

## Global Constraints

- Branch: create `claude/launch-p3a` off `origin/main` in a fresh worktree; run `npm ci` in it (worktrees share no node_modules). Commit after every task; commit messages end with the line `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Next.js 16 has breaking changes versus common training data: before using any Next API (route handlers, `proxy.ts`, `after()`, server actions, config), read the matching guide under `node_modules/next/dist/docs/`.
- Tests are tsx smoke scripts `scripts/smoke-<name>.ts`, each an executable spec that prints `ok`/`FAIL` lines and exits nonzero on failure. Pure scripts touch no database. Database scripts MUST start with `import "./smoke/_env";` (deletes DATABASE_URL, uses a throwaway PGlite dir) and wrap main in `run()` from that module. EVERY new smoke script must be added to `MANIFEST` in `scripts/run-smoke.ts` with tier `"pure"` or `"pglite"` or the whole suite refuses to run. Run one: `npx tsx scripts/smoke-<name>.ts`. Run all: `npm test`.
- Every task ends green on: the task's smoke script, `npm run typecheck`, `npm run lint` (baseline is 0 errors; any error is yours), and `npx tsx scripts/smoke-toast-copy.ts` when user-facing copy changed.
- tsx scripts must exit explicitly (`run()` or `process.exit(0)`); PGlite keeps the loop alive. Never import `next/server` into a low-level `src/lib/*` module that scripts import — the import alone hangs every script.
- A `"use server"` module may export ONLY async functions; a const/type export silently breaks every export in it. Put shared constants/types in `src/lib/*-types.ts`.
- A client component must not import anything that reaches `@/db` (build fails with a node:fs chunk error). Pure metadata goes in a DB-free module.
- User-facing errors: throw `new UserFacingError("…")` for copy you want shown; across a server-action boundary return it as data via `asActionResult`; catch sites use `friendlyError(err, fallback)` from `src/lib/errors.ts`, never `err.message`. Toast/copy voice (enforced by `scripts/smoke-toast-copy.ts`): curly apostrophes (’), "Couldn’t" not "Could not", never the word "failed", no trailing period, " — " as the one connector.
- Drizzle: use bare `.returning()` (partial returning does not typecheck across the driver union); read `db.execute()` results with `rowsOf<T>()` from `@/db`; `db.transaction` does not exist on neon-http — use `runAtomicWrite` (src/db/index.ts) or accept sequential idempotent writes; a column interpolated into a `sql```` template inside `.select()` loses its table prefix.
- Schema changes: table in `src/db/schema.ts`; `CREATE TABLE IF NOT EXISTS` in the `DDL` template in `src/db/index.ts` (the template has ZERO `--` comments, no backticks, no `;` inside comments — explanations go on the Drizzle table); new columns ALSO go in the `alters` list; new tables go in `EXPECTED_TABLES` in `scripts/setup-db.ts`; bump `export const SCHEMA_VERSION` with a changelog comment line; then `npx tsx scripts/smoke-schema-ddl.ts --update` and `npm run db:setup` (read the printed table list). NEVER hardcode the new version in the plan: compute it at execution time as one more than the highest value claimed by any remote branch:
  `git fetch -q --all && for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do git show "${b}:src/db/index.ts" 2>/dev/null | grep -oE 'export const SCHEMA_VERSION = [0-9]+'; done | grep -oE '[0-9]+$' | sort -n | tail -1`
  (56 is already claimed by three open branches as of 2026-09-15.) Re-run the scan immediately before pushing. Never put backticks in comments inside the `alters`/`SCALE_DDL` arrays.
- Tailwind compiles utility classes it finds in comments: never write an arbitrary-value class (e.g. `w-[123px]`) in a code comment.
- UI changes are verified in the browser: start the `orbit-web` configuration from `.claude/launch.json` (port 3001, demo mode on local PGlite when no Clerk keys are set). Controlled React inputs must be driven with real keystrokes, not DOM value writes.
- Do not add dependencies unless a task explicitly says so and gives the exact package and version.
- Scope: implement only the audit items assigned to this plan. Do not refactor neighbours.

### Plan-specific constraints

- **Line numbers are from `origin/main` at `33a213c`.** Phases 0–2 land first and shift them. Every edit below also names the function or the exact text it changes — find it by name, then apply the change. If an anchor text no longer exists, stop and read the file; do not guess.
- **Assumed from earlier phases:** Phase 0 routed `streamText`/transcription/embedding errors through `aiProviderErrorMessage` and narrowed `isMissingAiApiKeyError` so it matches only Orbit's own `MISSING_AI_API_KEY_MESSAGE` (it may also have reworded the `auth` template). Phase 1 introduced `googleScopesFor(purpose)`, `hasGmailReadScope` and per-purpose incremental consent (it may have changed `startGmailOAuth`'s arguments and `upsertGmailConnection`'s `scopes` value). Phase 2 revokes Google tokens on disconnect and may have reshaped `purgeUserData`'s step registry. Where a task touches one of those, it says what to keep.
- **Do not edit** `src/lib/ops-alerts.ts`, `src/lib/ops-sweep.ts`, the reconcile code in `src/db/index.ts` (`reconcileSchema`, `recordSchemaVersion`, the lease) or `.github/workflows/ops.yml` — Phase 3b owns them. Task 12 edits only the `DDL` template and `SCHEMA_VERSION` line in `src/db/index.ts`. Ops conditions this plan wants are listed under "Handoff to 3b".
- **Seeding the dev database for browser checks:** the dev server holds `.data/pglite` (single writer). Stop the server, run the seed script, then start it again. Seed scripts live under `.data/` (gitignored) and are deleted after the check — never commit them. Fake OAuth config for the connection cards goes in a worktree-local `.env.local` containing ONLY the lines given in the task (no `DATABASE_URL`, no Clerk keys), deleted after the check.
- One schema change only (Task 12). Its version number is computed at execution time with the scan above.

---

## File structure

| File | Task | Responsibility |
|---|---|---|
| `src/lib/errors.ts` (modify) | 1, 4 | `isRefreshRejection` widened; `quota` kind, `isQuotaExhaustion`, quota copy |
| `src/lib/gmail.ts` (modify) | 2, 3 | `storeRefreshedGmailToken`; `getValidAccessToken` rethrows `ReauthRequiredError`, takes `minValidityMs`; People/profile through the wrapper; 401 in `fetchGmailHeaders` |
| `src/lib/outlook.ts` (modify) | 2 | `storeRefreshedOutlookToken`; reauth rethrow |
| `src/lib/google-fetch.ts` (new, DB-free) | 3 | `googleFetchWithRetry` (moved out of `gmail.ts`, injectable fetch/sleep) |
| `src/lib/connectors/google-calendar.ts` (modify) | 3 | `fetchCalendarPage` through the wrapper |
| `src/lib/gmail-scan-processor.ts` (modify) | 5 | `ScanDeps`, token validity for the job budget, abort on key problems and five straight failures |
| `src/lib/connection-status.ts` (new, DB-free) | 6 | `deriveConnectionHealth`, `connectionSummary`, `SESSION_EXPIRED_LINE`, `calendarPauseLine` |
| `src/actions/gmail.ts`, `src/actions/outlook.ts`, `src/actions/integrations.ts` (modify) | 6 | status/syncError/nextSyncAt; summary line |
| `src/components/imports/google-contacts-import.tsx`, `src/components/imports/outlook-contacts-import.tsx`, `src/components/recruiters/gmail-import-panel.tsx` (modify) | 7 | render session-expired and paused states |
| `src/lib/account-alerts.ts`, `src/lib/account-health.ts` (modify) | 8 | `connection.google_calendar` alert |
| `src/lib/oauth-return.ts` (new, DB-free) | 9 | `readOAuthReturn` |
| `src/components/events/event-connections-card.tsx`, `src/app/api/events/eventbrite/callback/route.ts` (modify) | 9 | Eventbrite outcome toast; cookie consumed on deny; `no_organization` reason |
| `src/lib/meeting-chunk-errors.ts` (new, DB-free) | 10 | `chunkFailureResponse` |
| `src/app/api/capture/meetings/[id]/chunks/route.ts`, `src/lib/meeting-upload-queue.ts`, `src/components/capture/meeting-capture-panel.tsx` (modify) | 10 | 422 for key problems; `transcription-refused` fatal |
| `src/lib/usage-events.ts`, `src/lib/ai.ts`, `src/app/api/chat/route.ts` (modify) | 11 | `cancelSignal` → `cancelled`; `request.signal` into `streamText` |
| `src/db/schema.ts`, `src/db/index.ts`, `scripts/setup-db.ts`, `src/lib/user-data.ts`, `scripts/schema-ddl.lock.json` (modify) | 12 | `embedding_failures` table |
| `src/lib/embedding-batches.ts` (new, DB-free) | 13 | `planEmbeddingBatches`, `embedWithBisect` |
| `src/lib/embedding-backfill.ts` (modify) | 14 | bisect, token cap, mark unembeddable rows |
| `src/lib/chat-search-notice.ts` (new, DB-free) | 15 | `embeddingFailureNotice` |
| `src/lib/chat-context.ts`, `src/lib/chat-stream-protocol.ts`, `src/components/chat/chat-panel.tsx`, `src/components/layout/floating-ask-bar.tsx` (modify) | 15 | "keywords only" line |
| `src/actions/settings.ts`, `src/components/settings/ai-settings.tsx` (modify) | 16, 17 | per-provider Clear; Wispr notice |
| `src/lib/wispr.ts`, `src/lib/error-events.ts` (modify) | 17 | `transcribeWithWisprOutcome`, rejection record/lookup |
| `src/lib/rate-limit.ts` (modify) | 18, 19, 20 | new `RATE_LIMITS` entries |
| `src/lib/contact-avatar.ts`, `src/app/api/avatars/[contactId]/route.ts`, `src/actions/contacts.ts` (modify) | 18 | shared + per-user source budget |
| `src/lib/apollo.ts`, `src/actions/outreach.ts`, `src/components/outreach/outreach-wizard.tsx`, `src/components/outreach/campaign-workspace.tsx` (modify) | 19 | hosted Apollo daily buckets |
| `src/lib/client-ip.ts`, `src/lib/contact-message-submit.ts` (new) ; `src/actions/contact.ts`, `src/actions/interest-list.ts` (modify) | 20 | per-IP contact-form bucket, shared IP helper |
| `src/lib/twilio-errors.ts` (new) ; `src/lib/outreach-send.ts` (modify) | 21 | STOP'd numbers read as opted out |
| `src/lib/outreach-sender.ts` (new) ; `src/lib/outreach-send.ts` (modify) | 22 | From address on a user's own Resend key |
| `scripts/smoke-*.ts` (new/modify), `scripts/run-smoke.ts` (modify) | all | the specs |

---

### Task 1: Classify consent-type refresh errors as "reconnect" (audit B5, item 4)

Microsoft returns `interaction_required` / `consent_required` / `login_required` and Google returns `invalid_rapt` for grants that only the user can revive. Today those read as transient, so the row stays `active` and fails forever.

**Files:**
- Modify: `src/lib/errors.ts:301-309` (`isRefreshRejection` and its doc comment)
- Create: `scripts/smoke-oauth-refresh-rejection.ts`
- Modify: `scripts/run-smoke.ts:29-119` (pure section of `MANIFEST`)

**Interfaces:**
- Consumes: nothing.
- Produces: `isRefreshRejection(status: number, body: string): boolean` (same signature, wider match). Task 2's smoke relies on `interaction_required` being a rejection.

- [ ] **Step 1: Create the branch and install**

```bash
cd /Users/jasonpereira/Projects/orbit
git fetch -q origin
git worktree add .claude/worktrees/launch-p3a -b claude/launch-p3a origin/main
cd .claude/worktrees/launch-p3a
npm ci
```
Expected: `npm ci` ends with "added N packages". All later commands run in this worktree.

- [ ] **Step 2: Write the failing test**

Create `scripts/smoke-oauth-refresh-rejection.ts`:

```ts
/**
 * Which OAuth token-endpoint answers mean "this grant is dead, reconnect" rather than
 * "try again later". A wrong "transient" keeps a dead Outlook/Google row `active` and failing
 * forever with no alert; a wrong "dead" flags every account the day a provider has an outage.
 *
 * Run: npx tsx scripts/smoke-oauth-refresh-rejection.ts
 */
import { isRefreshRejection } from "../src/lib/errors";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

console.log("dead grants → reconnect");
for (const [status, body] of [
  [400, '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}'],
  [401, '{"error":"invalid_client"}'],
  [400, '{"error":"unauthorized_client"}'],
  [400, '{"error":"interaction_required","error_description":"AADSTS50076: multi-factor authentication required"}'],
  [400, '{"error":"consent_required","error_description":"AADSTS65001: The user or administrator has not consented"}'],
  [400, '{"error":"login_required"}'],
  [400, '{"error":"invalid_grant","error_subtype":"invalid_rapt"}'],
  [400, '{"error":"invalid_rapt"}'],
] as const) {
  check(`${status} ${body.slice(0, 48)}`, isRefreshRejection(status, body) === true);
}

console.log("transient or unrelated → retry");
for (const [status, body] of [
  [500, '{"error":"interaction_required"}'],
  [503, "Service Unavailable"],
  [429, '{"error":"rate_limited"}'],
  [400, '{"error":"invalid_request","error_description":"Missing parameter"}'],
  [403, '{"error":"access_denied"}'],
] as const) {
  check(`${status} ${body.slice(0, 48)}`, isRefreshRejection(status, body) === false);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```

Add to `MANIFEST` in `scripts/run-smoke.ts`, in the pure section directly after `"smoke-friendly-error": "pure",`:

```ts
  "smoke-oauth-refresh-rejection": "pure",
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx scripts/smoke-oauth-refresh-rejection.ts`
Expected: `FAIL` on the four `interaction_required` / `consent_required` / `login_required` / `invalid_rapt` lines (the `invalid_grant … invalid_rapt` line already passes), exit 1.

- [ ] **Step 4: Implement**

In `src/lib/errors.ts`, replace the doc comment and body of `isRefreshRejection` (lines 301-309) with:

```ts
/**
 * Whether an OAuth token-endpoint response means "this grant is dead, reconnect" rather
 * than "try again later". Google and Microsoft both return 400 with an `invalid_grant`
 * error code for a revoked or expired refresh token.
 *
 * The consent family is the same verdict in different words: Microsoft answers a refresh
 * that now needs MFA or fresh admin consent with `interaction_required`, `consent_required`
 * or `login_required`, and Google answers a Workspace re-auth policy with `invalid_rapt`.
 * None of them clears on its own, so treating them as transient kept those rows `active`
 * and failing on every run with no alert.
 */
export function isRefreshRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 401) return false;
  return /invalid_grant|invalid_client|unauthorized_client|interaction_required|consent_required|login_required|invalid_rapt/i.test(
    body
  );
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx tsx scripts/smoke-oauth-refresh-rejection.ts`
Expected: every line `ok`, `ALL PASS`, exit 0.

- [ ] **Step 6: Typecheck, lint, suite structure**

Run: `npm run typecheck && npm run lint && npx tsx scripts/run-smoke.ts --check`
Expected: no type errors, 0 lint errors, `structure ok.`

- [ ] **Step 7: Commit**

```bash
git add src/lib/errors.ts scripts/smoke-oauth-refresh-rejection.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Treat consent-type refresh errors as a dead grant

interaction_required, consent_required, login_required and invalid_rapt all mean
only the user can revive the grant; they used to read as transient.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: A token refresh stores the token and nothing else (audit B5, item 1; token half of item 5)

`getValidAccessToken` calls `upsertGmailConnection` after every refresh, which resets `next_sync_at`, `sync_failures` and `sync_error` — so calendar-sync backoff never converges and a disarmed row is re-armed by any Gmail action. It also converts `ReauthRequiredError` into a plain `Error`, so `runSyncPass` (`src/lib/sync-scheduler.ts:296-307`) takes the *retryable* branch and re-arms a row `markNeedsReauth` just disarmed. The recruiter scan also needs a token that stays valid for its whole 4.5-minute budget.

**Files:**
- Modify: `src/lib/gmail.ts:193-199` (`type TokenResponse` → exported), `:258-313` (keep `upsertGmailConnection`; add `storeRefreshedGmailToken` after it), `:350-392` (`getValidAccessToken`)
- Modify: `src/lib/outlook.ts:106-112` (`type TokenResponse` → exported), `:177-232` (add `storeRefreshedOutlookToken` after `upsertOutlookConnection`), `:269-311` (`getValidAccessToken`)
- Create: `scripts/smoke-token-refresh.ts`
- Modify: `scripts/run-smoke.ts` (pglite section)
- No change needed in `src/lib/sync-scheduler.ts`: its `retryable = !(err instanceof ReauthRequiredError)` (line 301) becomes correct once the class survives.

**Interfaces:**
- Consumes: Task 1's `isRefreshRejection` (the Outlook `interaction_required` case).
- Produces:
  - `export type TokenResponse` in both `gmail.ts` and `outlook.ts` (unchanged shape).
  - `storeRefreshedGmailToken(userId: string, tokens: TokenResponse): Promise<void>` in `src/lib/gmail.ts`.
  - `storeRefreshedOutlookToken(userId: string, tokens: TokenResponse): Promise<void>` in `src/lib/outlook.ts`.
  - `getValidAccessToken(userId: string, opts?: { minValidityMs?: number }): Promise<string>` in `src/lib/gmail.ts` (default 60 000 ms; Task 5 passes the scan budget).
  - Both `getValidAccessToken`s now throw `ReauthRequiredError` (message `"Gmail session expired — reconnect"` / `"Outlook session expired — reconnect"`) for `needs_reauth` rows, missing refresh tokens and rejected refreshes. `"… is not connected"` stays a plain `Error`.
  - `upsertGmailConnection` / `upsertOutlookConnection` are unchanged and remain the OAuth-callback-only path (keep whatever `scopes` Phase 1 made them write).

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-token-refresh.ts`:

```ts
/**
 * What a token refresh may and may not touch.
 *
 * A refresh is not a reconnect. Only the OAuth callback may re-arm calendar sync; a refresh
 * that resets `next_sync_at`/`sync_failures`/`sync_error` makes backoff never converge and
 * re-arms rows the scheduler disarmed. And a dead grant must reach the scheduler as a
 * `ReauthRequiredError`, or the scheduler re-arms the row `markNeedsReauth` just parked.
 *
 * The token endpoints are stubbed on `globalThis.fetch`; nothing leaves the machine.
 *
 * Run: npx tsx scripts/smoke-token-refresh.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

// Read lazily inside refreshAccessToken, so setting them here lands before any read.
process.env.GOOGLE_CLIENT_ID = "smoke-google-client";
process.env.GOOGLE_CLIENT_SECRET = "smoke-google-secret";
process.env.MICROSOFT_CLIENT_ID = "smoke-ms-client";
process.env.MICROSOFT_CLIENT_SECRET = "smoke-ms-secret";

import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { gmailConnections, outlookConnections } from "../src/db/schema";
import { decrypt, encrypt } from "../src/lib/crypto";
import { ReauthRequiredError } from "../src/lib/errors";
import { getValidAccessToken } from "../src/lib/gmail";
import { getValidAccessToken as getValidOutlookAccessToken } from "../src/lib/outlook";
import { runSyncPass } from "../src/lib/sync-scheduler";

const G_USER = "refresh-gmail-user";
const O_USER = "refresh-outlook-user";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const MINUTE = 60_000;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const realFetch = globalThis.fetch;
let tokenCalls = 0;
let tokenReply: () => Response = () =>
  Response.json({ access_token: "fresh-access", expires_in: 3600 });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://oauth2.googleapis.com/token") || url.includes("login.microsoftonline.com")) {
    tokenCalls++;
    return tokenReply();
  }
  return realFetch(input, init);
}) as typeof fetch;

async function seedGmail(over: Partial<typeof gmailConnections.$inferInsert> = {}) {
  const db = await getDb();
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, G_USER));
  await db.insert(gmailConnections).values({
    userId: G_USER,
    emailAddress: "refresh@example.com",
    accessTokenEncrypted: encrypt("stale-access"),
    refreshTokenEncrypted: encrypt("refresh-1"),
    tokenExpiresAt: new Date(Date.now() - MINUTE),
    scopes: CALENDAR_SCOPE,
    status: "active",
    nextSyncAt: null,
    syncStatus: "error",
    syncFailures: 3,
    syncError: "Google Calendar 503: upstream",
    ...over,
  });
}

async function gmailRow() {
  const db = await getDb();
  return (await db.query.gmailConnections.findFirst({ where: eq(gmailConnections.userId, G_USER) }))!;
}

run(async () => {
  console.log("a refresh stores the token and leaves sync state alone");
  await seedGmail();
  tokenCalls = 0;
  tokenReply = () => Response.json({ access_token: "fresh-access", expires_in: 3600 });
  const token = await getValidAccessToken(G_USER);
  let row = await gmailRow();
  check("returns the refreshed token", token === "fresh-access", token);
  check("stores the refreshed token", decrypt(row.accessTokenEncrypted) === "fresh-access");
  check("stores the new expiry", (row.tokenExpiresAt?.getTime() ?? 0) > Date.now() + 50 * MINUTE);
  check("keeps the refresh token when none is rotated", decrypt(row.refreshTokenEncrypted!) === "refresh-1");
  check("does NOT re-arm a disarmed sync", row.nextSyncAt === null, String(row.nextSyncAt));
  check("does NOT reset the failure counter", row.syncFailures === 3, String(row.syncFailures));
  check("does NOT clear the sync error", row.syncError === "Google Calendar 503: upstream", String(row.syncError));

  console.log("a rotated refresh token is kept");
  await seedGmail();
  tokenReply = () => Response.json({ access_token: "fresh-2", refresh_token: "refresh-2", expires_in: 3600 });
  await getValidAccessToken(G_USER);
  row = await gmailRow();
  check("stores the rotated refresh token", decrypt(row.refreshTokenEncrypted!) === "refresh-2");

  console.log("a caller can ask for a token that outlives its own budget");
  await seedGmail({ tokenExpiresAt: new Date(Date.now() + 3 * MINUTE), accessTokenEncrypted: encrypt("three-minutes-left") });
  tokenCalls = 0;
  tokenReply = () => Response.json({ access_token: "long-lived", expires_in: 3600 });
  const plain = await getValidAccessToken(G_USER);
  check("the default window reuses a token with three minutes left", plain === "three-minutes-left" && tokenCalls === 0, `${plain} after ${tokenCalls} refreshes`);
  const long = await getValidAccessToken(G_USER, { minValidityMs: 5 * MINUTE });
  check("asking for five minutes refreshes it", long === "long-lived" && tokenCalls === 1, `${long} after ${tokenCalls} refreshes`);

  console.log("a dead grant surfaces as ReauthRequiredError");
  await seedGmail();
  tokenReply = () => new Response('{"error":"invalid_grant"}', { status: 400 });
  let thrown: unknown = null;
  try {
    await getValidAccessToken(G_USER);
  } catch (err) {
    thrown = err;
  }
  check("rejects with ReauthRequiredError", thrown instanceof ReauthRequiredError, String(thrown));
  check("…with the reconnect message", (thrown as Error | null)?.message === "Gmail session expired — reconnect");
  row = await gmailRow();
  check("marks the row needs_reauth", row.status === "needs_reauth", row.status);

  console.log("the scheduler keeps a dead grant disarmed");
  {
    const db = await getDb();
    await db.execute(sql`UPDATE gmail_connections SET next_sync_at = NULL WHERE user_id <> ${G_USER}`);
    await seedGmail({ nextSyncAt: new Date(Date.now() - MINUTE), syncFailures: 0, syncError: null, syncStatus: "idle" });
    tokenReply = () => new Response('{"error":"invalid_grant"}', { status: 400 });
    await runSyncPass({
      deps: {
        getAccessToken: getValidAccessToken,
        fetchPage: async () => {
          throw new Error("must not fetch a calendar with a dead grant");
        },
      },
    });
    row = await gmailRow();
    check("status is needs_reauth", row.status === "needs_reauth", row.status);
    check("next_sync_at stays NULL (not re-armed by a retryable failure)", row.nextSyncAt === null, String(row.nextSyncAt));
    check("the failure did not walk the backoff ladder", row.syncFailures === 0, String(row.syncFailures));
  }

  console.log("Outlook: same split, and interaction_required is a dead grant");
  {
    const db = await getDb();
    const seedOutlook = async () => {
      await db.delete(outlookConnections).where(eq(outlookConnections.userId, O_USER));
      await db.insert(outlookConnections).values({
        userId: O_USER,
        emailAddress: "refresh@outlook.test",
        accessTokenEncrypted: encrypt("stale-ms"),
        refreshTokenEncrypted: encrypt("ms-refresh"),
        tokenExpiresAt: new Date(Date.now() - MINUTE),
        status: "active",
        nextSyncAt: null,
        syncFailures: 2,
        syncError: "earlier failure",
      });
    };
    await seedOutlook();
    tokenReply = () => Response.json({ access_token: "fresh-ms", expires_in: 3600 });
    const msToken = await getValidOutlookAccessToken(O_USER);
    const ms = (await db.query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, O_USER) }))!;
    check("returns the refreshed token", msToken === "fresh-ms");
    check("does NOT re-arm or reset sync state", ms.nextSyncAt === null && ms.syncFailures === 2 && ms.syncError === "earlier failure");

    await seedOutlook();
    tokenReply = () => new Response('{"error":"interaction_required","error_description":"AADSTS50076"}', { status: 400 });
    let msThrown: unknown = null;
    try {
      await getValidOutlookAccessToken(O_USER);
    } catch (err) {
      msThrown = err;
    }
    const after = (await db.query.outlookConnections.findFirst({ where: eq(outlookConnections.userId, O_USER) }))!;
    check("interaction_required rejects with ReauthRequiredError", msThrown instanceof ReauthRequiredError, String(msThrown));
    check("…and marks the row needs_reauth", after.status === "needs_reauth", after.status);
    await db.delete(outlookConnections).where(eq(outlookConnections.userId, O_USER));
  }

  const db = await getDb();
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, G_USER));
  globalThis.fetch = realFetch;
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll token-refresh checks passed.");
});
```

Add to `MANIFEST` in `scripts/run-smoke.ts`, pglite section, directly after `"smoke-sync-scheduler": "pglite",`:

```ts
  "smoke-token-refresh": "pglite",
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-token-refresh.ts`
Expected FAIL lines: "does NOT re-arm a disarmed sync", "does NOT reset the failure counter", "does NOT clear the sync error", "asking for five minutes refreshes it", "rejects with ReauthRequiredError", "next_sync_at stays NULL", "the failure did not walk the backoff ladder", both Outlook re-arm/ReauthRequiredError lines. Exit 1.

- [ ] **Step 3: Implement — Gmail**

In `src/lib/gmail.ts`:

1. Line 193: change `type TokenResponse = {` to `export type TokenResponse = {`.

2. Directly after the closing `}` of `upsertGmailConnection` (line 313), add:

```ts
/**
 * Stores a refreshed access token — and only the token.
 *
 * A refresh is not a reconnect. `upsertGmailConnection` re-arms calendar sync (resets
 * `next_sync_at`, `sync_failures`, `sync_error`) because the OAuth callback is the one place
 * a person proves they want the connection back. Running that on every hourly refresh meant
 * calendar-sync backoff never converged and a connection the scheduler had disarmed was
 * re-armed by any unrelated Gmail action. Status is not touched either: a refresh only
 * happens on an `active` row.
 *
 * Google usually omits `refresh_token` on a refresh; when it does rotate one, keep it.
 */
export async function storeRefreshedGmailToken(
  userId: string,
  tokens: TokenResponse
): Promise<void> {
  const db = await getDb();
  await db
    .update(gmailConnections)
    .set({
      accessTokenEncrypted: encrypt(tokens.access_token),
      ...(tokens.refresh_token
        ? { refreshTokenEncrypted: encrypt(tokens.refresh_token) }
        : {}),
      tokenExpiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null,
      updatedAt: new Date(),
    })
    .where(eq(gmailConnections.userId, userId));
}

const GMAIL_SESSION_EXPIRED = "Gmail session expired — reconnect";
```

3. Replace the whole of `getValidAccessToken` (lines 350-392) with:

```ts
/**
 * A usable access token, refreshing when it would expire within `minValidityMs`.
 *
 * `minValidityMs` defaults to a minute. A caller that will keep using the token for a
 * long, time-boxed job (the recruiter scan) asks for its whole budget instead, so the token
 * cannot expire half-way through a page of fetches.
 *
 * A dead grant is thrown as `ReauthRequiredError` itself, not re-wrapped: the sync scheduler
 * decides retryable-or-not on the class, and a plain `Error` made it retry — re-arming the
 * row `markNeedsReauth` had just parked.
 */
export async function getValidAccessToken(
  userId: string,
  opts: { minValidityMs?: number } = {}
): Promise<string> {
  const db = await getDb();
  // No `status` predicate here on purpose. Filtering it out would make a needs_reauth row
  // invisible and turn a precise "session expired — reconnect" into a wrong
  // "is not connected".
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
  });
  if (!conn) throw new Error("Gmail is not connected");
  if (conn.status !== "active") {
    throw new ReauthRequiredError(GMAIL_SESSION_EXPIRED);
  }

  const minValidityMs = opts.minValidityMs ?? 60_000;
  const expiresSoon =
    conn.tokenExpiresAt &&
    conn.tokenExpiresAt.getTime() < Date.now() + minValidityMs;

  if (!expiresSoon) {
    await touchLastSynced(conn);
    return decrypt(conn.accessTokenEncrypted);
  }

  if (!conn.refreshTokenEncrypted) {
    await markNeedsReauth(userId);
    throw new ReauthRequiredError(GMAIL_SESSION_EXPIRED);
  }

  let refreshed;
  try {
    refreshed = await refreshAccessToken(decrypt(conn.refreshTokenEncrypted));
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      await markNeedsReauth(userId);
      throw new ReauthRequiredError(GMAIL_SESSION_EXPIRED);
    }
    throw err;
  }

  await storeRefreshedGmailToken(userId, refreshed);
  await touchLastSynced({ id: conn.id, lastSyncedAt: null });
  return refreshed.access_token;
}
```

Also update the comment inside `markNeedsReauth` (line 327) that says "`upsert...Connection` re-arms it there" — it is still accurate (the OAuth callback's upsert); leave it.

- [ ] **Step 4: Implement — Outlook**

In `src/lib/outlook.ts`:

1. Line 106: `type TokenResponse = {` → `export type TokenResponse = {`.

2. Directly after `upsertOutlookConnection` (ends line 232), add:

```ts
/**
 * Stores a refreshed access token and nothing else — see `storeRefreshedGmailToken` in
 * `gmail.ts` for why a refresh must not re-arm sync or reset its failure state.
 */
export async function storeRefreshedOutlookToken(
  userId: string,
  tokens: TokenResponse
): Promise<void> {
  const db = await getDb();
  await db
    .update(outlookConnections)
    .set({
      accessTokenEncrypted: encrypt(tokens.access_token),
      ...(tokens.refresh_token
        ? { refreshTokenEncrypted: encrypt(tokens.refresh_token) }
        : {}),
      tokenExpiresAt: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null,
      updatedAt: new Date(),
    })
    .where(eq(outlookConnections.userId, userId));
}

const OUTLOOK_SESSION_EXPIRED = "Outlook session expired — reconnect";
```

3. In `getValidAccessToken` (lines 269-311): replace each of the three `throw new Error("Outlook session expired — reconnect");` with `throw new ReauthRequiredError(OUTLOOK_SESSION_EXPIRED);`, and replace

```ts
  // The upsert resets status to "active", which is the only path back from needs_reauth.
  await upsertOutlookConnection(userId, refreshed, conn.emailAddress);
```
with
```ts
  await storeRefreshedOutlookToken(userId, refreshed);
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx tsx scripts/smoke-token-refresh.ts`
Expected: every line `ok`, "All token-refresh checks passed.", exit 0.

- [ ] **Step 6: Neighbouring specs still hold**

Run: `npx tsx scripts/smoke-sync-scheduler.ts && npx tsx scripts/smoke-instrumentation.ts && npx tsx scripts/smoke-account-alerts.ts`
Expected: all three exit 0 (`smoke-instrumentation` still calls `upsertGmailConnection`, which is unchanged).

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean. (`SyncDeps.getAccessToken: typeof getValidAccessToken` still accepts the one-argument stubs in `smoke-sync-scheduler.ts`.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/gmail.ts src/lib/outlook.ts scripts/smoke-token-refresh.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Store refreshed tokens without re-arming sync; keep ReauthRequiredError

A token refresh no longer runs the OAuth upsert, so calendar backoff converges and a
disarmed row stays disarmed. Dead grants reach the scheduler as ReauthRequiredError,
which takes its non-retryable branch. getValidAccessToken takes minValidityMs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: Google People, profile and Calendar calls go through the retry wrapper; a mid-job 401 is a reauth (audit B5, item 5)

`fetchGooglePeopleContacts`, `fetchGoogleProfileEmail` and `fetchCalendarPage` use bare `fetch` with no timeout and no quota backoff. `fetchGmailHeaders` returns `null` on a 401, so a page of expired-token failures counts as scanned.

**Files:**
- Create: `src/lib/google-fetch.ts`
- Modify: `src/lib/gmail.ts:9-50` (move the wrapper out), `:394-402` (`fetchGoogleProfileEmail`), `:426-474` (`fetchGooglePeopleContacts`), `:767-801` (`fetchGmailHeaders`)
- Modify: `src/lib/connectors/google-calendar.ts:27-30` (imports), `:201-203` (the `doFetch` call in `fetchCalendarPage`)
- Create: `scripts/smoke-google-fetch.ts`
- Modify: `scripts/run-smoke.ts` (pure section)

**Interfaces:**
- Consumes: `ReauthRequiredError` from `src/lib/errors.ts`.
- Produces:
  - `src/lib/google-fetch.ts` (no imports at all): `export const GOOGLE_MAX_RETRIES = 5`, `export const GOOGLE_MAX_RETRY_DELAY_MS = 30_000`, `export type GoogleFetchInit = { method?: string; headers?: HeadersInit; body?: BodyInit; timeoutMs: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }`, `export async function googleFetchWithRetry(url: string | URL, init: GoogleFetchInit): Promise<Response>`.
  - `fetchGmailHeaders` now rejects with `ReauthRequiredError("Gmail session expired — reconnect")` when any message GET answers 401 (Task 5's scan fails the job with it).

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-google-fetch.ts`:

```ts
/**
 * Google HTTP calls: backoff on quota answers, a fresh timeout per attempt, and a 401 in
 * the middle of a scan treated as a dead session rather than as "nothing here".
 *
 * No network: the wrapper takes an injected fetch and sleep; the gmail.ts helpers are driven
 * through a stubbed `globalThis.fetch`.
 *
 * Run: npx tsx scripts/smoke-google-fetch.ts
 */
import { googleFetchWithRetry, GOOGLE_MAX_RETRIES, GOOGLE_MAX_RETRY_DELAY_MS } from "../src/lib/google-fetch";
import { fetchGmailHeaders, fetchGoogleProfileEmail, fetchGooglePeopleContacts } from "../src/lib/gmail";
import { fetchCalendarPage } from "../src/lib/connectors/google-calendar";
import { ReauthRequiredError } from "../src/lib/errors";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Script = (call: number, url: string) => Response;
function scripted(script: Script) {
  const calls: { url: string; signal: AbortSignal | null | undefined }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, signal: init?.signal });
    return script(calls.length, url);
  }) as typeof fetch;
  return { impl, calls };
}

const quota403 = () =>
  new Response('{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}', { status: 403 });

const realFetch = globalThis.fetch;

async function main() {
  console.log("googleFetchWithRetry");
  {
    const sleeps: number[] = [];
    const { impl, calls } = scripted((n) => (n === 1 ? new Response("", { status: 429 }) : new Response("{}", { status: 200 })));
    const res = await googleFetchWithRetry("https://example.test/a", { timeoutMs: 1000, fetchImpl: impl, sleep: async (ms) => { sleeps.push(ms); } });
    check("a 429 is retried", res.status === 200 && calls.length === 2, `${calls.length} calls`);
    check("…after one backoff sleep", sleeps.length === 1);
    check("each attempt gets its own signal", Boolean(calls[0].signal) && calls[0].signal !== calls[1].signal);
  }
  {
    const { impl, calls } = scripted((n) => (n === 1 ? quota403() : new Response("{}", { status: 200 })));
    await googleFetchWithRetry("https://example.test/b", { timeoutMs: 1000, fetchImpl: impl, sleep: async () => {} });
    check("a quota 403 is retried", calls.length === 2, `${calls.length} calls`);
  }
  {
    const { impl, calls } = scripted(() => new Response('{"error":"forbidden"}', { status: 403 }));
    const res = await googleFetchWithRetry("https://example.test/c", { timeoutMs: 1000, fetchImpl: impl, sleep: async () => {} });
    check("a permission 403 is returned, not retried", res.status === 403 && calls.length === 1);
  }
  {
    const { impl, calls } = scripted(() => new Response("", { status: 429 }));
    const res = await googleFetchWithRetry("https://example.test/d", { timeoutMs: 1000, fetchImpl: impl, sleep: async () => {} });
    check("gives up after GOOGLE_MAX_RETRIES retries", res.status === 429 && calls.length === GOOGLE_MAX_RETRIES + 1, `${calls.length} calls`);
  }
  {
    const sleeps: number[] = [];
    const { impl } = scripted((n) => (n === 1 ? new Response("", { status: 429, headers: { "retry-after": "600" } }) : new Response("{}", { status: 200 })));
    await googleFetchWithRetry("https://example.test/e", { timeoutMs: 1000, fetchImpl: impl, sleep: async (ms) => { sleeps.push(ms); } });
    check("a huge Retry-After is capped", sleeps[0] === GOOGLE_MAX_RETRY_DELAY_MS, String(sleeps[0]));
  }

  console.log("fetchGmailHeaders");
  {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/messages/m2")) return new Response('{"error":{"code":401}}', { status: 401 });
      if (url.includes("/messages/m3")) return new Response("", { status: 404 });
      return Response.json({ id: "m1", threadId: "t1", snippet: "hi", payload: { headers: [{ name: "From", value: "a@b.com" }] } });
    }) as typeof fetch;
    let thrown: unknown = null;
    try {
      await fetchGmailHeaders("tok", [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }], 1);
    } catch (err) {
      thrown = err;
    }
    check("a 401 rejects with ReauthRequiredError", thrown instanceof ReauthRequiredError, String(thrown));
    const kept = await fetchGmailHeaders("tok", [{ id: "m1", threadId: "t1" }, { id: "m3", threadId: "t3" }], 1);
    check("a 404 is still just dropped", kept.length === 1 && kept[0].id === "m1", JSON.stringify(kept.map((k) => k.id)));
  }

  console.log("People API and profile");
  {
    let peopleCalls = 0;
    const signals: (AbortSignal | null | undefined)[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      signals.push(init?.signal);
      if (url.includes("people.googleapis.com")) {
        peopleCalls++;
        if (peopleCalls === 1) return new Response("", { status: 429 });
        return Response.json({ connections: [{ resourceName: "people/1", names: [{ displayName: "Ada Lovelace" }] }] });
      }
      if (url.includes("oauth2/v2/userinfo")) return Response.json({ email: "ada@example.com" });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const people = await fetchGooglePeopleContacts("tok");
    check("a People 429 is retried", peopleCalls === 2 && people.length === 1, `${peopleCalls} calls, ${people.length} people`);
    const email = await fetchGoogleProfileEmail("tok");
    check("profile email still resolves", email === "ada@example.com");
    check("every Google call carried a timeout signal", signals.every((s) => s instanceof AbortSignal), `${signals.length} calls`);
  }

  console.log("Calendar");
  {
    const { impl, calls } = scripted((n) => (n === 1 ? quota403() : Response.json({ items: [], nextSyncToken: "s" })));
    const page = await fetchCalendarPage({ accessToken: "tok", cursor: null, fetchImpl: impl });
    check("a Calendar quota 403 is retried", calls.length === 2 && page.nextSyncToken === "s", `${calls.length} calls`);
    check("the Calendar call carries a signal", calls[0].signal instanceof AbortSignal);
  }

  globalThis.fetch = realFetch;
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  globalThis.fetch = realFetch;
  console.error(err);
  process.exit(1);
});
```

Add to `MANIFEST`, pure section, directly after `"smoke-gmail-send-mime": "pure",`:

```ts
  "smoke-google-fetch": "pure",
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-google-fetch.ts`
Expected: exits 1 with `Cannot find module '../src/lib/google-fetch'`.

- [ ] **Step 3: Create the wrapper module**

Create `src/lib/google-fetch.ts`:

```ts
/**
 * `fetch` for Google APIs: backoff on quota answers and a fresh timeout per attempt.
 *
 * Moved out of `gmail.ts` so the Calendar connector — "fetch and map only", no database —
 * can use it without importing `@/db`. No imports at all, for the same reason.
 *
 * Gmail's "Units per minute per user" quota is cost-based, not request-count-based, so a
 * heavy scan can trip it well before any endpoint's own rate limit. A 403 for that reason
 * (`rateLimitExceeded` / `quotaExceeded` / `userRateLimitExceeded`, distinct from a genuine
 * permission-denied 403) and any 429 are transient and worth waiting out. People and
 * Calendar share the same quota vocabulary.
 */
export const GOOGLE_MAX_RETRIES = 5;

/**
 * Ceiling on one wait. Calendar sync gives each connection a 60-second budget, and an
 * uncapped `Retry-After` would spend all of it asleep.
 */
export const GOOGLE_MAX_RETRY_DELAY_MS = 30_000;

export type GoogleFetchInit = {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
  timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

async function isRetryableGoogleResponse(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  const text = await res.clone().text();
  return /rateLimitExceeded|quotaExceeded|userRateLimitExceeded/i.test(text);
}

/**
 * A fresh `AbortSignal.timeout` per attempt — reusing one across retries would leave later
 * attempts pre-aborted. Honours `Retry-After` (capped), otherwise exponential backoff with
 * jitter. Returns the last response when retries run out; callers decide what a non-2xx means.
 */
export async function googleFetchWithRetry(
  url: string | URL,
  init: GoogleFetchInit
): Promise<Response> {
  const doFetch = init.fetchImpl ?? fetch;
  const sleep =
    init.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    if (res.ok || attempt >= GOOGLE_MAX_RETRIES || !(await isRetryableGoogleResponse(res))) {
      return res;
    }
    const retryAfterSeconds = Number(res.headers.get("retry-after"));
    const delayMs =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 250;
    await sleep(Math.min(delayMs, GOOGLE_MAX_RETRY_DELAY_MS));
  }
}
```

- [ ] **Step 4: Point gmail.ts at it**

In `src/lib/gmail.ts`:

1. Delete lines 9-50 (the doc comment starting "Gmail's \"Units per minute per user\" quota…", `GMAIL_MAX_RETRIES`, `isRetryableGmailResponse`, and `gmailFetchWithRetry`). Add to the imports at the top:

```ts
import { googleFetchWithRetry as gmailFetchWithRetry } from "@/lib/google-fetch";
```
Every existing `gmailFetchWithRetry(` call site below keeps compiling unchanged.

2. Replace `fetchGoogleProfileEmail` (lines 394-402) with:

```ts
export async function fetchGoogleProfileEmail(accessToken: string) {
  const res = await gmailFetchWithRetry("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeoutMs: 10_000,
  });
  // "profile" stays in this message: the callback's classifyOAuthFailure keys on it.
  if (!res.ok) throw new Error("Failed to load Google profile");
  const data = (await res.json()) as { email?: string };
  if (!data.email) throw new Error("Google account has no email");
  return data.email;
}
```

3. In `fetchGooglePeopleContacts` (lines 426-474), replace

```ts
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
```
with
```ts
    const res = await gmailFetchWithRetry(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeoutMs: 30_000,
    });
```

4. In `fetchGmailHeaders` (lines 767-801), replace the body of the per-ref callback's `try … catch` so it reads:

```ts
    try {
      const res = await gmailFetchWithRetry(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Id&metadataHeaders=Precedence`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeoutMs: 10_000,
        }
      );
      // A 401 is the session, not the message. Returning null here used to count a whole
      // page of expired-token failures as "scanned, nothing recruiter-shaped".
      if (res.status === 401) throw new ReauthRequiredError("Gmail session expired — reconnect");
      if (!res.ok) return null;
      const msg = (await res.json()) as RawGmailMessage;
      const internal = Number(msg.internalDate);
      return {
        id: ref.id,
        threadId: msg.threadId || ref.threadId,
        from: headerValue(msg, "From"),
        to: headerValue(msg, "To"),
        subject: headerValue(msg, "Subject"),
        snippet: msg.snippet || "",
        internalDate: Number.isFinite(internal) ? internal : null,
        listUnsubscribe: headerValue(msg, "List-Unsubscribe"),
        listId: headerValue(msg, "List-Id"),
        precedence: headerValue(msg, "Precedence"),
      } satisfies GmailHeaderSummary;
    } catch (err) {
      if (err instanceof ReauthRequiredError) throw err;
      return null;
    }
```

- [ ] **Step 5: Point the Calendar connector at it**

In `src/lib/connectors/google-calendar.ts`, add after line 30 (`import type { NetworkEvent } from "@/lib/ingest/events";`):

```ts
import { googleFetchWithRetry } from "@/lib/google-fetch";
```

In `fetchCalendarPage`, delete the line `const doFetch = opts.fetchImpl ?? fetch;` and replace

```ts
  const res = await doFetch(`${CALENDAR_API}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
```
with
```ts
  const res = await googleFetchWithRetry(`${CALENDAR_API}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    // Well inside the scheduler's 60-second per-connection budget.
    timeoutMs: 20_000,
    fetchImpl: opts.fetchImpl,
  });
```

- [ ] **Step 6: Run it and watch it pass, plus the neighbours**

Run: `npx tsx scripts/smoke-google-fetch.ts && npx tsx scripts/smoke-gmail-batch.ts && npx tsx scripts/smoke-google-calendar-map.ts && npx tsx scripts/smoke-event-gmail-scan.ts`
Expected: `ALL PASS` from the new script (it takes ~1 s — the People and Calendar retries use the real timer once each), and the three existing scripts exit 0. (The calendar map's stub response has no `headers`/`clone`; the wrapper only reads them on a 429/403, which that script never returns.)

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/google-fetch.ts src/lib/gmail.ts src/lib/connectors/google-calendar.ts scripts/smoke-google-fetch.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Route People, profile and Calendar calls through the Google retry wrapper

The wrapper moves to a DB-free module with injectable fetch/sleep and a capped
Retry-After. fetchGmailHeaders now treats a 401 as a dead session instead of an
empty result.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: A `quota` failure kind with "top up" copy (audit B8, item 6)

`insufficient_quota`, "exceeded your current quota", daily `RESOURCE_EXHAUSTED` and "credit balance is too low" are classified `rate_limit` ("give it a moment") — the wrong next action. Gemini also uses "exceeded your current quota" for per-minute limits, so a short-term hint (`retry in`, `PerMinute`) keeps those as `rate_limit`.

**Files:**
- Modify: `src/lib/errors.ts:102-141` (`AI_FAILURE_COPY`, `aiProviderErrorMessage`), `:262-286` (`AiErrorKind`, `classifyAiError`)
- Modify: `scripts/smoke-friendly-error.ts:78-105`

**Interfaces:**
- Consumes: nothing.
- Produces: `AiErrorKind` gains `"quota"`; `export function isQuotaExhaustion(text: string): boolean`; `AI_FAILURE_COPY.quota(p) = "<p> says your account is out of credit — top up with them, then try again"` (automatically in `OWN_WORDS`, so `friendlyError` passes it through). `classifyAiError` checks quota before auth and rate limit. Tasks 5, 10 and 14 branch on `"quota"`.

- [ ] **Step 1: Write the failing test**

In `scripts/smoke-friendly-error.ts`:

1. Add `isQuotaExhaustion,` to the import list from `"../src/lib/errors"` (lines 16-27).

2. In the `kinds` array (lines 79-85), add after the `rate_limit` row:

```ts
  ["quota", new Error("429 You exceeded your current quota, please check your plan and billing details."), "quota"],
```

3. After the "the catch-all no longer repeats whatever the provider said" block (after line 99), add:

```ts
console.log("out of credit is not 'give it a moment'");
const quotaCases: [string, string, "quota" | "rate_limit"][] = [
  ["OpenAI billing", "429 You exceeded your current quota, please check your plan and billing details.", "quota"],
  ["OpenAI code", '{"error":{"code":"insufficient_quota","type":"insufficient_quota"}}', "quota"],
  ["Anthropic credit", '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}', "quota"],
  ["Gemini daily", '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for metric: generate_content_free_tier_requests, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier"}}', "quota"],
  ["Gemini billing", '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Billing account has no credit"}}', "quota"],
  ["Gemini per-minute", '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"You exceeded your current quota, please check your plan and billing details. Please retry in 31.2s. quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}}', "rate_limit"],
  ["plain 429", "429 Too Many Requests: rate limit exceeded", "rate_limit"],
  ["bare RESOURCE_EXHAUSTED", "429 RESOURCE_EXHAUSTED quota", "rate_limit"],
];
for (const [label, raw, expected] of quotaCases) {
  check(`${label} → ${expected}`, classifyAiError(new Error(raw)) === expected, classifyAiError(new Error(raw)));
  check(`${label}: isQuotaExhaustion agrees`, isQuotaExhaustion(raw) === (expected === "quota"));
}
check(
  "quota copy tells you where to go",
  aiProviderErrorMessage(new Error(quotaCases[0][1]), "OpenAI") === "OpenAI says your account is out of credit — top up with them, then try again",
  aiProviderErrorMessage(new Error(quotaCases[0][1]), "OpenAI")
);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-friendly-error.ts`
Expected: exits 1. `isQuotaExhaustion` is not exported, so every `isQuotaExhaustion agrees` check throws `TypeError: isQuotaExhaustion is not a function` on the first call (the process stops there with a stack trace). That is the expected failure.

- [ ] **Step 3: Implement**

In `src/lib/errors.ts`:

1. In `AI_FAILURE_COPY` (lines 112-120), add a `quota` entry after `rate_limit`, and extend the doc comment's list of trigger words (line 105) from `("API key", "rate limit", "timed out", "model")` to `("API key", "rate limit", "out of credit", "timed out", "model")`:

```ts
  quota: (p: string) =>
    `${p} says your account is out of credit — top up with them, then try again`,
```

2. Directly above `export function aiProviderErrorMessage` add:

```ts
/**
 * An account that has run out of money with its provider, as opposed to one going too fast.
 *
 * The distinction is the next action: a rate limit clears if you wait, an empty balance
 * never does. Gemini words its per-MINUTE limit exactly like OpenAI words an empty balance
 * ("You exceeded your current quota…"), so a short-term hint — "retry in 31s", a
 * `PerMinute` quota id, `retryDelay` — keeps those as rate limits, and a daily or billing
 * hint makes a `RESOURCE_EXHAUSTED` a quota.
 */
const QUOTA_DAILY = /per.?day|daily/i;
const QUOTA_SHORT_TERM = /per.?minute|retry in \d|retrydelay/i;
const QUOTA_EXHAUSTED =
  /insufficient_quota|exceeded your current quota|credit balance is too low|out of credit/i;

export function isQuotaExhaustion(text: string): boolean {
  if (QUOTA_DAILY.test(text) && /quota|resource.?exhausted|429/i.test(text)) return true;
  if (QUOTA_SHORT_TERM.test(text)) return false;
  if (QUOTA_EXHAUSTED.test(text)) return true;
  return /resource.?exhausted/i.test(text) && /billing/i.test(text);
}
```

3. In `aiProviderErrorMessage`, insert as the FIRST check after `const base = …`:

```ts
  // Before auth and rate limit: an empty balance can arrive as a 429 (OpenAI) or a 400
  // (Anthropic), and either earlier branch would send the person to the wrong fix.
  if (isQuotaExhaustion(base)) {
    return AI_FAILURE_COPY.quota(provider);
  }
```

4. `AiErrorKind` (lines 269-275): add `| "quota"` after `| "rate_limit"`.

5. In `classifyAiError`, insert after the `empty_response` line:

```ts
  if (isQuotaExhaustion(base)) return "quota";
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-friendly-error.ts && npx tsx scripts/smoke-usage-events.ts && npx tsx scripts/smoke-toast-copy.ts`
Expected: `ALL PASS`; usage-events still passes (its fixture "429 rate limit exceeded" stays `rate_limit`); toast copy clean.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean. (`OUR_ERROR_KINDS` in `src/lib/admin-system.ts` intentionally omits `quota`: an empty balance is the user's account, not Orbit breaking.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/errors.ts scripts/smoke-friendly-error.ts
git commit -m "$(cat <<'MSG'
Add a quota failure kind with top-up copy

Out-of-credit answers from OpenAI, Anthropic and Gemini (daily or billing) now read
as "out of credit — top up with them" instead of "give it a moment". Gemini's
per-minute wording stays a rate limit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: The recruiter scan stops on a key problem and never advances the watermark past it (audit B8, item 7; scan half of item 5)

Today a rejected/empty key fails every sender one by one, the job ends `completed`, and `markScanCompleted` advances the watermark — those messages are never rescanned. The job's token is also minted once and can expire mid-run.

**Files:**
- Modify: `src/lib/gmail-scan-processor.ts` — imports (1-29), constants (after 48), `runDiscovery` (78-192), `processSender` (195-255), `runGmailRecruiterScanJob` (264-418)
- Create: `scripts/smoke-gmail-scan-abort.ts`; Modify: `scripts/run-smoke.ts` (pglite section)

**Interfaces:**
- Consumes: Task 2 `getValidAccessToken(userId, { minValidityMs })`; Task 3 `fetchGmailHeaders` throwing `ReauthRequiredError`; Task 4 `classifyAiError` → `"quota"`.
- Produces (all exported from `src/lib/gmail-scan-processor.ts`):
  - `type ScanDeps = { getAccessToken: (userId: string, opts?: { minValidityMs?: number }) => Promise<string>; listPage: typeof listGmailMessagePage; fetchHeaders: typeof fetchGmailHeaders; fetchMessages: typeof fetchGmailMessages; classify: typeof classifyRecruiterSender; continueLater: (importId: string) => Promise<void> }`
  - `SCAN_KEY_PROBLEM_COPY: { auth: string; quota: string; model_unavailable: string }`, `SCAN_CONSECUTIVE_FAILURES_COPY: string`, `MAX_CONSECUTIVE_SENDER_FAILURES = 5`
  - `runGmailRecruiterScanJob(importId: string, deps?: ScanDeps): Promise<void>` (callers in `src/actions/gmail.ts:206` and `src/lib/import-job-dispatch.ts:73` keep passing one argument).

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-gmail-scan-abort.ts`:

```ts
/**
 * The recruiter scan must stop — without advancing its watermark — when the AI key is the
 * problem, or when senders keep failing in a row. Otherwise a dead key "completes" the scan
 * and the unread window is skipped forever. Gmail and the classifier are injected.
 *
 * Run: npx tsx scripts/smoke-gmail-scan-abort.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { importJobRows, imports, recruiterScanState } from "../src/db/schema";
import { aiProviderErrorMessage } from "../src/lib/errors";
import type { GmailMessageContent } from "../src/lib/gmail";
import {
  MAX_CONSECUTIVE_SENDER_FAILURES,
  SCAN_CONSECUTIVE_FAILURES_COPY,
  SCAN_KEY_PROBLEM_COPY,
  runGmailRecruiterScanJob,
  type ScanDeps,
} from "../src/lib/gmail-scan-processor";

const USER = "smoke-scan-abort-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Classify = ScanDeps["classify"];
const notRecruiter: Awaited<ReturnType<Classify>> = {
  isRecruiter: false, confidence: 0.1, fullName: null, firm: null,
  companiesMentioned: [], rolesDiscussed: [], summary: null,
};

async function seedJob(senders: number): Promise<string> {
  const db = await getDb();
  await db.delete(importJobRows).where(eq(importJobRows.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(recruiterScanState).where(eq(recruiterScanState.userId, USER));
  const [job] = await db.insert(imports).values({
    userId: USER,
    importType: "gmail_recruiter_scan",
    status: "processing",
    totalRows: senders,
    stats: {
      discoveryComplete: true,
      scanAfter: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      scanIsFull: false,
      scanStartedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  }).returning();
  await db.insert(importJobRows).values(
    Array.from({ length: senders }, (_, i) => ({
      importId: job.id, userId: USER, rowIndex: i, status: "pending",
      payload: { kind: "gmail_sender" as const, email: `s${i}@agency.test`, name: `Sender ${i}`, firm: "Agency", messageIds: [`m${i}`] },
    }))
  );
  return job.id;
}

function depsWith(classify: Classify) {
  let calls = 0;
  const message = (id: string): GmailMessageContent => ({
    id, threadId: `t-${id}`, from: "Sender <s@agency.test>", to: "me@example.com",
    subject: "Role at Acme", snippet: "open role", internalDate: Date.now(),
    listUnsubscribe: "", listId: "", precedence: "", body: "We are hiring.",
  });
  const deps: ScanDeps = {
    getAccessToken: async () => "stub-token",
    listPage: async () => { throw new Error("discovery must not run"); },
    fetchHeaders: async () => { throw new Error("discovery must not run"); },
    fetchMessages: async (_token, ids) => ids.map(message),
    classify: async (userId, input) => { calls++; return classify(userId, input); },
    continueLater: async () => {},
  };
  return { deps, calls: () => calls };
}

async function outcome(importId: string) {
  const db = await getDb();
  const job = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  const mark = await db.query.recruiterScanState.findFirst({ where: eq(recruiterScanState.userId, USER) });
  return { status: job?.status, error: job?.errorMessage ?? null, watermark: mark?.lastScanAt ?? null };
}

run(async () => {
  console.log("an out-of-credit key stops the scan at the first sender");
  {
    const id = await seedJob(6);
    const { deps, calls } = depsWith(async () => {
      throw new Error("429 You exceeded your current quota, please check your plan and billing details.");
    });
    await runGmailRecruiterScanJob(id, deps);
    const o = await outcome(id);
    check("the job ends failed", o.status === "failed", String(o.status));
    check("with the top-up copy", o.error === SCAN_KEY_PROBLEM_COPY.quota, String(o.error));
    check("after one classifier call", calls() === 1, String(calls()));
    check("the watermark does not move", o.watermark === null, String(o.watermark));
  }

  console.log("already-rewritten provider copy passes through");
  {
    const id = await seedJob(3);
    const copy = aiProviderErrorMessage(new Error("401 Unauthorized: invalid x-api-key"), "Anthropic");
    const { deps } = depsWith(async () => { throw new Error(copy); });
    await runGmailRecruiterScanJob(id, deps);
    const o = await outcome(id);
    check("the job ends failed with the provider's own words", o.status === "failed" && o.error === copy, String(o.error));
  }

  console.log(`${MAX_CONSECUTIVE_SENDER_FAILURES} failures in a row stop it too`);
  {
    const id = await seedJob(8);
    const { deps, calls } = depsWith(async () => { throw new Error("Unexpected token < in JSON"); });
    await runGmailRecruiterScanJob(id, deps);
    const o = await outcome(id);
    check("the job ends failed", o.status === "failed" && o.error === SCAN_CONSECUTIVE_FAILURES_COPY, String(o.error));
    check(`after exactly ${MAX_CONSECUTIVE_SENDER_FAILURES} calls`, calls() === MAX_CONSECUTIVE_SENDER_FAILURES, String(calls()));
    check("the watermark does not move", o.watermark === null);
  }

  console.log("a success resets the streak");
  {
    const id = await seedJob(8);
    let n = 0;
    const { deps } = depsWith(async () => {
      n++;
      if (n <= MAX_CONSECUTIVE_SENDER_FAILURES - 1) throw new Error("Unexpected token < in JSON");
      return notRecruiter;
    });
    await runGmailRecruiterScanJob(id, deps);
    const o = await outcome(id);
    check("the job completes", o.status === "completed", `${o.status} ${o.error}`);
    check("and advances the watermark", o.watermark !== null);
  }

  const db = await getDb();
  await db.delete(importJobRows).where(eq(importJobRows.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(recruiterScanState).where(eq(recruiterScanState.userId, USER));
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll scan-abort checks passed.");
});
```

Add to `MANIFEST` pglite section after `"smoke-sync-columns": "pglite",`: `  "smoke-gmail-scan-abort": "pglite",`

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-gmail-scan-abort.ts`
Expected: FAIL — the named exports don't exist yet, so `MAX_CONSECUTIVE_SENDER_FAILURES` is undefined and the real Gmail deps run (`getValidAccessToken` throws "Gmail is not connected"); job ends failed with the wrong message; exit 1.

- [ ] **Step 3: Implement**

In `src/lib/gmail-scan-processor.ts`:

1. Add to the imports: `import { classifyAiError, friendlyError } from "@/lib/errors";`

2. After `const MAX_CANDIDATE_SENDERS = 400;` add:

```ts
/** Senders failing back to back before the scan gives up rather than "completing". */
export const MAX_CONSECUTIVE_SENDER_FAILURES = 5;

/**
 * Failure kinds that mean the KEY is the problem, not the sender. Every later sender would
 * fail the same way, so the scan stops at the first — and, crucially, never reaches
 * `markScanCompleted`, which would step the watermark over mail it never read.
 */
export const SCAN_KEY_PROBLEM_COPY = {
  auth: "Your AI provider didn’t accept your API key — check it in Settings, then scan again",
  quota: "Your AI provider says your account is out of credit — top up with them, then scan again",
  model_unavailable: "Your AI model isn’t available — pick another in Settings, then scan again",
} as const;

export const SCAN_CONSECUTIVE_FAILURES_COPY =
  "The scan stopped after several conversations in a row couldn’t be read — try again in a while";

function scanAbortReason(err: unknown): string | null {
  const kind = classifyAiError(err);
  if (kind === "auth" || kind === "quota" || kind === "model_unavailable") {
    // Provider copy that is already Orbit's own words passes through; raw text does not.
    return friendlyError(err, SCAN_KEY_PROBLEM_COPY[kind]);
  }
  return null;
}

/** Gmail, the classifier and the continuation kick — injectable so the loop is testable. */
export type ScanDeps = {
  getAccessToken: (userId: string, opts?: { minValidityMs?: number }) => Promise<string>;
  listPage: typeof listGmailMessagePage;
  fetchHeaders: typeof fetchGmailHeaders;
  fetchMessages: typeof fetchGmailMessages;
  classify: typeof classifyRecruiterSender;
  continueLater: (importId: string) => Promise<void>;
};
```

3. After the `scheduleContinuation` function (ends line 67) add:

```ts
const DEFAULT_SCAN_DEPS: ScanDeps = {
  getAccessToken: getValidAccessToken,
  listPage: listGmailMessagePage,
  fetchHeaders: fetchGmailHeaders,
  fetchMessages: fetchGmailMessages,
  classify: classifyRecruiterSender,
  continueLater: scheduleContinuation,
};
```

4. `runDiscovery`: add a final parameter `deps: ScanDeps`; inside it replace `await scheduleContinuation(importId);` → `await deps.continueLater(importId);`, `await listGmailMessagePage(accessToken, {` → `await deps.listPage(accessToken, {`, `await fetchGmailHeaders(accessToken, page.messages)` → `await deps.fetchHeaders(accessToken, page.messages)`.

5. `processSender`: add a final parameter `deps: ScanDeps`; replace `await fetchGmailMessages(` → `await deps.fetchMessages(` and `await classifyRecruiterSender(userId, {` → `await deps.classify(userId, {`.

6. `runGmailRecruiterScanJob`: change the signature to `export async function runGmailRecruiterScanJob(importId: string, deps: ScanDeps = DEFAULT_SCAN_DEPS): Promise<void> {`. Replace `accessToken = await getValidAccessToken(userId);` with:

```ts
    // Valid for the whole invocation: a token minted with two minutes left would expire
    // half-way through a page and read as a run of empty messages.
    accessToken = await deps.getAccessToken(userId, { minValidityMs: TIME_BUDGET_MS + 60_000 });
```
Pass `deps` as the last argument to `runDiscovery(...)`, replace `await scheduleContinuation(importId);` inside the chunk loop with `await deps.continueLater(importId);`, and replace the block from `let found = current.stats?.recruitersFound ?? 0;` through the end of the `for (const row of pending) { … }` loop (lines 346-383) with:

```ts
      let found = current.stats?.recruitersFound ?? 0;
      let rejected = current.stats?.sendersRejected ?? 0;

      for (const row of pending) {
        if (!isGmailSenderRow(row.payload)) {
          await db
            .update(importJobRows)
            .set({ status: "skipped", updatedAt: new Date() })
            .where(eq(importJobRows.id, row.id));
          continue;
        }

        try {
          const outcome = await processSender(userId, row.payload, accessToken, deps);
          consecutiveFailures = 0;
          if (outcome === "recruiter") found += 1;
          else rejected += 1;
          await db
            .update(importJobRows)
            .set({
              status: outcome === "recruiter" ? "done" : "skipped",
              updatedAt: new Date(),
            })
            .where(eq(importJobRows.id, row.id));
        } catch (err) {
          // The key, not the sender: stop now, row left pending, watermark untouched.
          const keyProblem = scanAbortReason(err);
          if (keyProblem) {
            await failImport(importId, new Error(keyProblem));
            return;
          }
          // A dead sender must not kill the scan — record why and move on.
          const message = err instanceof Error ? err.message : "Classification failed";
          rejected += 1;
          consecutiveFailures += 1;
          await db
            .update(importJobRows)
            .set({
              status: "skipped",
              errorMessage: message.slice(0, 300),
              updatedAt: new Date(),
            })
            .where(eq(importJobRows.id, row.id));
          // Unless they keep dying: a streak means the scan as a whole is broken, and
          // "completing" would advance the watermark past everything it skipped.
          if (consecutiveFailures >= MAX_CONSECUTIVE_SENDER_FAILURES) {
            await failImport(importId, new Error(SCAN_CONSECUTIVE_FAILURES_COPY));
            return;
          }
        }
        processed += 1;
      }
```
and declare the counter next to `let processed = importRow.rowsProcessed ?? 0;`:

```ts
    let consecutiveFailures = 0;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx scripts/smoke-gmail-scan-abort.ts && npx tsx scripts/smoke-recruiter-scan.ts`
Expected: "All scan-abort checks passed."; recruiter-scan still exits 0.

- [ ] **Step 5: Typecheck, lint, copy voice**

Run: `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts`
Expected: clean. (The panel's failure toast already runs `friendlyError(next.errorMessage, …)`; these copies are plain strings, so it shows its fallback — the stored copy renders verbatim in the panel's failed-scan paragraph.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/gmail-scan-processor.ts scripts/smoke-gmail-scan-abort.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Stop the recruiter scan on key problems before it advances the watermark

Auth, quota and unavailable-model failures end the job at the first sender; five
failures in a row end it too. The job's token is minted valid for its whole budget.
Gmail and the classifier are injectable for the new pglite smoke.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 6: One derivation of connection health, returned by the status actions (audit B5, item 2 — server half)

`needs_reauth` reads as "Not connected" and a disarmed calendar sync reads as "Connected". No schema change: "disarmed" is `status = 'active' AND next_sync_at IS NULL AND sync_error IS NOT NULL`, and only counts when the grant includes calendar (a contacts-only grant parked by the scheduler is the user's choice, not a fault).

**Files:**
- Create: `src/lib/connection-status.ts` (DB-free, client-safe)
- Modify: `src/actions/gmail.ts:12-66` (imports, `GmailConnectionStatus`, `getGmailConnectionStatus`)
- Modify: `src/actions/outlook.ts:1-47` (imports, `OutlookConnectionStatus`, `getOutlookConnectionStatus`)
- Modify: `src/actions/integrations.ts:110-129` (google/gmail/outlook summaries)
- Create: `scripts/smoke-connection-status.ts`; Modify: `scripts/run-smoke.ts` (pure section)

**Interfaces:**
- Consumes: `hasCalendarScope` from `src/lib/gmail.ts`.
- Produces (`src/lib/connection-status.ts`):
  - `type ConnectionHealth = "active" | "needs_reauth" | "disarmed"`
  - `deriveConnectionHealth(row: { status: string; nextSyncAt: Date | null; syncError: string | null; calendarScopeGranted: boolean }): ConnectionHealth`
  - `SESSION_EXPIRED_LINE = "Session expired — reconnect"`, `CALENDAR_PAUSED_SHORT = "Calendar sync paused"`
  - `calendarPauseLine(syncError: string | null): string`
  - `connectionSummary(c: { configured: boolean; connected: boolean; status: ConnectionHealth | null }): { state: "on" | "partial" | "off"; detail: string }`
  - `GmailConnectionStatus` and `OutlookConnectionStatus` gain `status: ConnectionHealth | null`, `syncError: string | null`, `nextSyncAt: string | null` (ISO). `connected` keeps its meaning. Tasks 7 and 8 read these.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-connection-status.ts`:

```ts
/**
 * How a connection row reads to a person: active, session expired, or calendar sync paused.
 * Pure — the same derivation feeds the cards, the Integrations nav and the account bell.
 *
 * Run: npx tsx scripts/smoke-connection-status.ts
 */
import {
  CALENDAR_PAUSED_SHORT,
  SESSION_EXPIRED_LINE,
  calendarPauseLine,
  connectionSummary,
  deriveConnectionHealth,
} from "../src/lib/connection-status";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const row = (over: Partial<Parameters<typeof deriveConnectionHealth>[0]> = {}) => ({
  status: "active", nextSyncAt: new Date() as Date | null, syncError: null as string | null,
  calendarScopeGranted: true, ...over,
});

console.log("deriveConnectionHealth");
check("a healthy armed row is active", deriveConnectionHealth(row()) === "active");
check("needs_reauth wins over everything", deriveConnectionHealth(row({ status: "needs_reauth", nextSyncAt: null, syncError: "x" })) === "needs_reauth");
check("parked with an error is disarmed", deriveConnectionHealth(row({ nextSyncAt: null, syncError: "Google Calendar 403" })) === "disarmed");
check("in backoff (still scheduled) is not disarmed", deriveConnectionHealth(row({ syncError: "Google Calendar 503" })) === "active");
check("never scheduled, no error, is not disarmed", deriveConnectionHealth(row({ nextSyncAt: null })) === "active");
check("no calendar scope is never disarmed", deriveConnectionHealth(row({ nextSyncAt: null, syncError: "Calendar access not granted", calendarScopeGranted: false })) === "active");

console.log("calendarPauseLine");
check("scope trouble asks for calendar access", calendarPauseLine("Google Calendar 403: insufficient scope") === "Calendar sync paused — reconnect Google and allow calendar access");
check("anything else asks to reconnect", calendarPauseLine("Google Calendar 503: upstream") === "Calendar sync paused — reconnect Google to start it again");
check("never repeats the raw provider text", !calendarPauseLine('{"error":"secret"}').includes("secret"));

console.log("connectionSummary");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
check("unconfigured", same(connectionSummary({ configured: false, connected: false, status: null }), { state: "off", detail: "Unavailable" }));
check("expired", same(connectionSummary({ configured: true, connected: false, status: "needs_reauth" }), { state: "partial", detail: SESSION_EXPIRED_LINE }));
check("paused", same(connectionSummary({ configured: true, connected: true, status: "disarmed" }), { state: "partial", detail: CALENDAR_PAUSED_SHORT }));
check("connected", connectionSummary({ configured: true, connected: true, status: "active" }).detail === "Connected");
check("no row", connectionSummary({ configured: true, connected: false, status: null }).detail === "Not connected");

console.log("house voice");
for (const line of [SESSION_EXPIRED_LINE, calendarPauseLine(null), calendarPauseLine("scope")]) {
  check(`"${line}"`, !line.includes("'") && !line.endsWith(".") && !/failed/i.test(line));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```

Add to `MANIFEST` pure section after `"smoke-clerk-session-hint": "pure",`: `  "smoke-connection-status": "pure",`

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-connection-status.ts`
Expected: `Cannot find module '../src/lib/connection-status'`, exit 1.

- [ ] **Step 3: Create the module**

Create `src/lib/connection-status.ts`:

```ts
/**
 * How a Google or Microsoft connection row reads to a person.
 *
 * DB-free and import-free: client cards, the "use server" status actions and the account
 * bell all derive the same three states from the same columns, so they cannot disagree.
 *
 * "disarmed" is the scheduler having given up (`next_sync_at IS NULL` with an error) on a
 * grant that DID include calendar. A contacts-only grant parked for lack of the calendar
 * scope is the user's choice, not a fault, and reads as plain active.
 */
export type ConnectionHealth = "active" | "needs_reauth" | "disarmed";

export function deriveConnectionHealth(row: {
  status: string;
  nextSyncAt: Date | null;
  syncError: string | null;
  calendarScopeGranted: boolean;
}): ConnectionHealth {
  if (row.status !== "active") return "needs_reauth";
  if (row.calendarScopeGranted && row.nextSyncAt === null && row.syncError) return "disarmed";
  return "active";
}

export const SESSION_EXPIRED_LINE = "Session expired — reconnect";
export const CALENDAR_PAUSED_SHORT = "Calendar sync paused";

/** The full line for a card. Never echoes `sync_error`, which can be a provider's raw body. */
export function calendarPauseLine(syncError: string | null): string {
  if (syncError && /not granted|insufficient|scope/i.test(syncError)) {
    return `${CALENDAR_PAUSED_SHORT} — reconnect Google and allow calendar access`;
  }
  return `${CALENDAR_PAUSED_SHORT} — reconnect Google to start it again`;
}

/** One line for the Integrations card and nav, which truncate — so the short forms. */
export function connectionSummary(c: {
  configured: boolean;
  connected: boolean;
  status: ConnectionHealth | null;
}): { state: "on" | "partial" | "off"; detail: string } {
  if (!c.configured) return { state: "off", detail: "Unavailable" };
  if (c.status === "needs_reauth") return { state: "partial", detail: SESSION_EXPIRED_LINE };
  if (c.status === "disarmed") return { state: "partial", detail: CALENDAR_PAUSED_SHORT };
  if (c.connected) return { state: "on", detail: "Connected" };
  return { state: "off", detail: "Not connected" };
}
```

- [ ] **Step 4: Return the fields from the actions**

`src/actions/gmail.ts`: add `hasCalendarScope` to the `@/lib/gmail` import (lines 16-20) and add `import { deriveConnectionHealth, type ConnectionHealth } from "@/lib/connection-status";`. In `GmailConnectionStatus`, after `canSend: boolean;`:

```ts
  /** Null when there is no connection row. See `deriveConnectionHealth`. */
  status: ConnectionHealth | null;
  /** The scheduler's last error, verbatim — never rendered as-is (`calendarPauseLine`). */
  syncError: string | null;
  /** ISO time of the next calendar sync, or null when none is scheduled. */
  nextSyncAt: string | null;
```
In the unconfigured early return add `status: null, syncError: null, nextSyncAt: null,`. In the final return add:

```ts
    status: conn
      ? deriveConnectionHealth({
          status: conn.status,
          nextSyncAt: conn.nextSyncAt,
          syncError: conn.syncError,
          calendarScopeGranted: hasCalendarScope(conn.scopes),
        })
      : null,
    syncError: conn?.syncError ?? null,
    nextSyncAt: conn?.nextSyncAt?.toISOString() ?? null,
```

`src/actions/outlook.ts`: same import, same three fields on `OutlookConnectionStatus` (after `lastSyncedAt`), `status: null, syncError: null, nextSyncAt: null,` in the unconfigured return, and the same three lines in the final return with `calendarScopeGranted: false` (there is no Microsoft calendar sync; `runSyncPass` claims Google only).

`src/actions/integrations.ts`: add `import { connectionSummary } from "@/lib/connection-status";` and replace lines 110-129 with:

```ts
  // Google Contacts and the Gmail recruiter scan share one Google connection.
  const googleStatus: IntegrationStatus | "unknown" =
    google === "unknown" ? "unknown" : connectionSummary(google);
  statuses.google = googleStatus;
  statuses.gmail = googleStatus;

  statuses.outlook = outlook === "unknown" ? "unknown" : connectionSummary(outlook);
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx tsx scripts/smoke-connection-status.ts`
Expected: `ALL PASS`.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/connection-status.ts src/actions/gmail.ts src/actions/outlook.ts src/actions/integrations.ts scripts/smoke-connection-status.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Derive connection health once and return it from the status actions

Session-expired and paused-calendar rows no longer read as "Not connected" and
"Connected" in the Integrations summary.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 7: The connection cards say "Session expired" and "Calendar sync paused" (audit B5, item 2 — UI half)

**Files:**
- Modify: `src/components/imports/google-contacts-import.tsx:1-20` (imports), `:106-202` (header text and buttons)
- Modify: `src/components/imports/outlook-contacts-import.tsx:118-145` (header text, button label)
- Modify: `src/components/recruiters/gmail-import-panel.tsx:185-215` (header text, button label)

**Interfaces:**
- Consumes: Task 6 `SESSION_EXPIRED_LINE`, `calendarPauseLine`, and `status`/`syncError` on the two status types.
- Produces: no new exports.

There is no pure seam here; the test is a browser check against a seeded demo database.

- [ ] **Step 1: Write the seed script and fake OAuth config (the "test")**

Create `.data/seed-connection-state.ts` (gitignored; deleted in Step 6):

```ts
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { gmailConnections, outlookConnections } from "../src/db/schema";

// getDb reads DATABASE_URL lazily; no dotenv is loaded, so this is the worktree PGlite.
delete process.env.DATABASE_URL;
const mode = process.argv[2] as "expired" | "paused" | "clear";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

async function main() {
  const db = await getDb();
  await db.delete(gmailConnections).where(eq(gmailConnections.userId, "demo-user"));
  await db.delete(outlookConnections).where(eq(outlookConnections.userId, "demo-user"));
  if (mode === "clear") return;
  await db.insert(gmailConnections).values({
    userId: "demo-user", emailAddress: "demo@gmail.test", accessTokenEncrypted: "x",
    refreshTokenEncrypted: "y", scopes: SCOPES,
    status: mode === "expired" ? "needs_reauth" : "active",
    nextSyncAt: null, syncStatus: "error",
    syncError: mode === "paused" ? "Google Calendar 403: forbidden" : null,
  });
  await db.insert(outlookConnections).values({
    userId: "demo-user", emailAddress: "demo@outlook.test", accessTokenEncrypted: "x",
    status: mode === "expired" ? "needs_reauth" : "active",
  });
}
main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
```

Create a worktree-local `.env.local` with exactly:

```
GOOGLE_CLIENT_ID=dev-fake-client
GOOGLE_CLIENT_SECRET=dev-fake-secret
GOOGLE_REDIRECT_URI=http://localhost:3001/api/gmail/callback
MICROSOFT_CLIENT_ID=dev-fake-client
MICROSOFT_CLIENT_SECRET=dev-fake-secret
MICROSOFT_REDIRECT_URI=http://localhost:3001/api/outlook/callback
```

- [ ] **Step 2: See the wrong copy first**

With no dev server running: `npx tsx .data/seed-connection-state.ts expired`. Start `orbit-web`; open `/imports`. Expected (the bug): the Google and Outlook cards say "Connect your … account to import contacts directly." with "Connect Google"/"Connect Microsoft"; Settings → Integrations nav shows "Session expired — reconnect" already (Task 6) — the cards do not. Stop the server, run `npx tsx .data/seed-connection-state.ts paused`, restart: the Google card says "Connected as demo@gmail.test" with nothing about calendar.

- [ ] **Step 3: Implement — Google card**

`src/components/imports/google-contacts-import.tsx`: add `import { SESSION_EXPIRED_LINE, calendarPauseLine } from "@/lib/connection-status";`. Inside the component, directly after `const busy = …` (line 39), add one handler both buttons share:

```tsx
  // Keep exactly the arguments the Connect button already passes — Phase 1 may have added
  // a purpose to `startGmailOAuth`; copy that call here if it did.
  const connect = () =>
    start(async () => {
      try {
        const { url } = await startGmailOAuth(returnTo);
        window.location.href = url;
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.connectFailed));
      }
    });
```
Replace the header `<div>` holding `<h2>Google Contacts</h2>` and its `<p>` (lines 128-135) with:

```tsx
        <div>
          <h2 className="text-lg font-medium text-ink">Google Contacts</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {status.status === "needs_reauth"
              ? `${SESSION_EXPIRED_LINE} to import contacts again`
              : status.connected
                ? `Connected as ${status.emailAddress}${!contactsScopeGranted ? " — reconnect to grant contacts access" : ""}`
                : "Connect your Google account to import contacts directly."}
          </p>
          {status.status === "disarmed" ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-warning">
              <span>{calendarPauseLine(status.syncError)}</span>
              <Button variant="link" size="sm" className="h-auto px-0" disabled={busy} onClick={connect}>
                Reconnect Google
              </Button>
            </p>
          ) : null}
        </div>
```
Change the connect `<Button>`'s `onClick={() => start(async () => { … startGmailOAuth … })}` to `onClick={connect}`, and its label to:

```tsx
              {status.connected || status.status === "needs_reauth" ? "Reconnect Google" : "Connect Google"}
```

- [ ] **Step 4: Implement — Outlook card and Gmail panel**

`src/components/imports/outlook-contacts-import.tsx`: add `import { SESSION_EXPIRED_LINE } from "@/lib/connection-status";`; replace the header text expression (lines 124-126) with:

```tsx
            {status.status === "needs_reauth"
              ? `${SESSION_EXPIRED_LINE} to import contacts again`
              : status.connected
                ? `Connected as ${status.emailAddress}`
                : "Connect your Microsoft account to import contacts directly."}
```
and the button label `Connect Microsoft` (line 143) with `{status.status === "needs_reauth" ? "Reconnect Microsoft" : "Connect Microsoft"}`.

`src/components/recruiters/gmail-import-panel.tsx`: add `import { SESSION_EXPIRED_LINE } from "@/lib/connection-status";`; replace the description expression (lines 195-197) with:

```tsx
            {connection.status === "needs_reauth"
              ? `${SESSION_EXPIRED_LINE} to scan your mailbox again.`
              : connection.connected
                ? `Connected as ${connection.emailAddress}. Orbit searches your whole mailbox for recruiter threads and writes a private summary of each one.`
                : "Search your whole mailbox for recruiters, the companies they hired for, and a summary of every conversation."}
```
and the label `Connect Gmail` (line 214) with `{connection.status === "needs_reauth" ? "Reconnect Gmail" : "Connect Gmail"}`.

- [ ] **Step 5: See the right copy**

Stop the server; `npx tsx .data/seed-connection-state.ts expired`; start `orbit-web`.
- `/imports`: Google card "Session expired — reconnect to import contacts again" + "Reconnect Google"; Outlook card the same with "Reconnect Microsoft".
- `/recruiters`: "Session expired — reconnect to scan your mailbox again." + "Reconnect Gmail".
Stop; `npx tsx .data/seed-connection-state.ts paused`; start.
- `/imports`: Google card "Connected as demo@gmail.test" plus an amber "Calendar sync paused — reconnect Google to start it again" with a "Reconnect Google" link; Import/Disconnect still present. Settings → Integrations: Google row "Calendar sync paused".
- Resize to 375 px: the pause line wraps, no horizontal scroll.

- [ ] **Step 6: Clean up, typecheck, lint, commit**

Stop the server; `npx tsx .data/seed-connection-state.ts clear && rm .data/seed-connection-state.ts .env.local`.
Run: `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts`
Expected: clean.

```bash
git add src/components/imports/google-contacts-import.tsx src/components/imports/outlook-contacts-import.tsx src/components/recruiters/gmail-import-panel.tsx
git commit -m "$(cat <<'MSG'
Show session-expired and paused-calendar states on the connection cards

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 8: A `connection.google_calendar` alert in the bell (audit B5, item 2 — alert)

**Files:**
- Modify: `src/lib/account-alerts.ts:65-81` (`HealthCode`), `:102-132` (`HealthInput`), after `:235` (predicate), `:342-363` (dismissible list + doc), `:365-376` (`KIND_BY_CODE`), `:393-404` (`CODE_RANK`), after `:478` (copy case)
- Modify: `src/lib/account-health.ts:1-29` (imports), `:118-144` (select), `:216-234` (return)
- Modify: `scripts/smoke-account-alerts.ts` (17c blocking list; new case 20 before `// --- 19. query budget`)

**Interfaces:**
- Consumes: Task 6 `deriveConnectionHealth`; `hasCalendarScope` from `src/lib/gmail.ts`.
- Produces: `HealthCode` `"connection.google_calendar"` (severity `warn`, kind `connection`, not dismissible, CTA `/imports#import-google-contacts`, surface `page.imports`); `HealthInput.googleCalendar: { paused: boolean; reason: string | null } | null`. Still ONE combined select (query budget unchanged).

- [ ] **Step 1: Write the failing test**

In `scripts/smoke-account-alerts.ts`, add `"connection.google_calendar",` to the `blocking` array in case 17c (after `"connection.outlook",`), and insert before `// --- 19. query budget`:

```ts
  // --- 20. paused Google Calendar sync ---------------------------------------------------
  const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
  await reset();
  await db.insert(gmailConnections).values({
    ...gmailBase, status: "active", refreshTokenEncrypted: "enc:refresh",
    scopes: CALENDAR_SCOPE, nextSyncAt: null, syncError: "Google Calendar 403: forbidden",
  });
  const paused = await getAccountAlerts(USER);
  const pausedAlert = paused.find((a) => a.code === "connection.google_calendar");
  check("20 a disarmed calendar sync alerts", Boolean(pausedAlert), JSON.stringify(paused.map((a) => a.code)));
  check("20 it is a warning (no red dot)", pausedAlert?.severity === "warn");
  check("20 it points at the Google card", pausedAlert?.cta?.href === "/imports#import-google-contacts");
  check("20 it never shows the raw sync error", !(pausedAlert?.body ?? "").includes("403"));

  await reset();
  await db.insert(gmailConnections).values({
    ...gmailBase, status: "active", refreshTokenEncrypted: "enc:refresh",
    scopes: "https://www.googleapis.com/auth/gmail.readonly", nextSyncAt: null,
    syncError: "Calendar access not granted — reconnect Google to enable calendar sync",
  });
  check("20b no calendar scope is silent", !(await codes()).includes("connection.google_calendar"));

  await reset();
  await db.insert(gmailConnections).values({
    ...gmailBase, status: "active", refreshTokenEncrypted: "enc:refresh",
    scopes: CALENDAR_SCOPE, nextSyncAt: new Date(Date.now() + 60 * MINUTE), syncError: "Google Calendar 503",
  });
  check("20c a sync still in backoff is not paused", !(await codes()).includes("connection.google_calendar"));

  await reset();
  await db.insert(gmailConnections).values({
    ...gmailBase, status: "needs_reauth", refreshTokenEncrypted: "enc:refresh",
    scopes: CALENDAR_SCOPE, nextSyncAt: null, syncError: "Gmail session expired — reconnect",
  });
  const dead = await codes();
  check("20d a dead grant raises only the reconnect alert", dead.includes("connection.gmail") && !dead.includes("connection.google_calendar"), dead.join(","));
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-account-alerts.ts`
Expected (17c already passes — an unknown code is not in `DISMISSIBLE_CODES`): FAIL on `20 a disarmed calendar sync alerts`, `20 it is a warning`, `20 it points at the Google card`. Exit 1.

- [ ] **Step 3: Implement the pure half (`src/lib/account-alerts.ts`)**

1. `HealthCode`: add `| "connection.google_calendar"` after `| "connection.outlook"`.
2. `HealthInput`: add after `outlook: ConnectionFacts | null;`:

```ts
  /**
   * Google Calendar sync, only when the grant includes the calendar scope. Null for no
   * connection, no OAuth app, or a grant without calendar — a sync the user never asked
   * for being parked is not something to alert about.
   */
  googleCalendar: { paused: boolean; reason: string | null } | null;
```
3. After the mailbox-connections `for` loop (ends line 235) add:

```ts
  // --- Google Calendar sync -----------------------------------------------------------
  // Only on a healthy grant: a dead one already raises `connection.gmail`, and two alerts
  // for one reconnect is noise. `warn`, not `error` — calendar is one input among many.
  if (input.googleCalendar?.paused && input.gmail?.status === "active") {
    findings.push({
      code: "connection.google_calendar",
      severity: "warn",
      data: { reason: truncate(input.googleCalendar.reason) },
    });
  }
```
4. In the doc comment above `isDismissible`, change the `connection.gmail` line to: `` *   `connection.gmail` / `connection.outlook` / `connection.google_calendar` — sync and mailbox scans stay paused. `` Do NOT add the code to `DISMISSIBLE_CODES`.
5. `KIND_BY_CODE`: add `"connection.google_calendar": "connection",`. `CODE_RANK`: insert `"connection.google_calendar",` after `"connection.outlook",`.
6. In `toAccountAlerts`, after the `connection.gmail`/`connection.outlook` case's `break; }`, add:

```ts
      case "connection.google_calendar": {
        alerts.push({
          ...base,
          title: "Calendar sync is paused",
          body: "New meetings aren’t reaching Orbit. Reconnect Google to start calendar sync again.",
          cta: { label: "Reconnect", href: "/imports#import-google-contacts", external: false },
          surfaceKey: "page.imports",
        });
        break;
      }
```

- [ ] **Step 4: Implement the loader (`src/lib/account-health.ts`)**

1. Change `import { getGmailOAuthConfigSummary } from "@/lib/gmail";` to `import { getGmailOAuthConfigSummary, hasCalendarScope } from "@/lib/gmail";` and add `import { deriveConnectionHealth } from "@/lib/connection-status";`.
2. After `function connectionFacts(…)` add:

```ts
function googleCalendarFacts(
  configured: boolean,
  status: unknown,
  nextSyncAt: unknown,
  syncError: unknown,
  scopes: unknown
): HealthInput["googleCalendar"] {
  const resolved = text(status);
  if (!configured || !resolved || !hasCalendarScope(text(scopes))) return null;
  const reason = text(syncError);
  return {
    paused:
      deriveConnectionHealth({
        status: resolved,
        nextSyncAt: toDate(nextSyncAt),
        syncError: reason,
        calendarScopeGranted: true,
      }) === "disarmed",
    reason,
  };
}
```
3. In the single `.select({ … })`, after `gmailHasRefresh`, add (same scalar-subquery shape as its neighbours):

```ts
      gmailNextSyncAt: sql<Date | string | null>`(
        SELECT ${gmailConnections.nextSyncAt} FROM ${gmailConnections}
        WHERE ${gmailConnections.userId} = ${userId} LIMIT 1)`,
      gmailSyncError: sql<string | null>`(
        SELECT ${gmailConnections.syncError} FROM ${gmailConnections}
        WHERE ${gmailConnections.userId} = ${userId} LIMIT 1)`,
      gmailScopes: sql<string | null>`(
        SELECT ${gmailConnections.scopes} FROM ${gmailConnections}
        WHERE ${gmailConnections.userId} = ${userId} LIMIT 1)`,
```
4. In the returned object, after `outlook: connectionFacts(…),` add:

```ts
    googleCalendar: googleCalendarFacts(
      getGmailOAuthConfigSummary().configured,
      row.gmailStatus,
      row.gmailNextSyncAt,
      row.gmailSyncError,
      row.gmailScopes
    ),
```

`admin-user-detail.ts` keeps its own health list on purpose (see the header of `account-alerts.ts`); do not add the code there.

- [ ] **Step 5: Run it and watch it pass**

Run: `npx tsx scripts/smoke-account-alerts.ts`
Expected: every line `ok` including 20–20d, 17c, and `19 paid account costs few statements` (still ≤ 4).

- [ ] **Step 6: Typecheck, lint, copy**

Run: `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/account-alerts.ts src/lib/account-health.ts scripts/smoke-account-alerts.ts
git commit -m "$(cat <<'MSG'
Alert in the bell when Google Calendar sync is paused

Non-dismissible warning, only for grants that include calendar and are otherwise
healthy; loaded in the existing single select.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 9: Eventbrite OAuth outcomes reach the person; a cancelled consent consumes its cookie (audit B5, item 3)

Nothing reads `?eventbrite=connected|error&reason=`, so cancel, "no organization" and a token failure all look like nothing happened. The deny path also leaves the state cookie behind. Params are stripped on the first user gesture, not on mount: in Next 16 `history.replaceState` is a router restore and drops any server action a sibling queued on mount (the avatar backfill fires one on every authenticated page).

**Files:**
- Create: `src/lib/oauth-return.ts` (DB-free, client-safe)
- Modify: `src/components/events/event-connections-card.tsx:21-37` (imports), `:78-90` (effect after the hooks)
- Modify: `src/app/api/events/eventbrite/callback/route.ts:32-43` (deny path), `:76-90` (catch)
- Create: `scripts/smoke-oauth-return.ts`; Modify: `scripts/run-smoke.ts` (pure section)

**Interfaces:**
- Consumes: `describeOAuthReason` from `src/lib/errors.ts`.
- Produces: `readOAuthReturn(search: string, opts: { param: string; provider: string; connectedText: string; reasons?: Record<string, string> }): { tone: "success" | "message" | "error"; text: string; nextSearch: string } | null`. The callback sets `reason=no_organization` when that is the failure (otherwise still `oauth_failed`).

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-oauth-return.ts`:

```ts
/**
 * Reading an OAuth callback's result off the URL: what to say, and what the URL becomes.
 * Run: npx tsx scripts/smoke-oauth-return.ts
 */
import { readOAuthReturn } from "../src/lib/oauth-return";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const OPTS = {
  param: "eventbrite",
  provider: "Eventbrite",
  connectedText: "Eventbrite connected — events you host will sync automatically",
  reasons: { no_organization: "That Eventbrite account has no organization to sync — create one on Eventbrite, then connect again" },
};

const ok = readOAuthReturn("?eventbrite=connected&tab=hosts", OPTS);
check("connected is a success toast", ok?.tone === "success" && ok.text === OPTS.connectedText, JSON.stringify(ok));
check("…and keeps unrelated params", ok?.nextSearch === "?tab=hosts", ok?.nextSearch);

const cancel = readOAuthReturn("?eventbrite=error&reason=access_denied", OPTS);
check("a cancel is a quiet message", cancel?.tone === "message" && /cancelled/.test(cancel.text), JSON.stringify(cancel));
check("…and strips both params", cancel?.nextSearch === "", cancel?.nextSearch);

const noOrg = readOAuthReturn("?eventbrite=error&reason=no_organization", OPTS);
check("a known reason gets its own copy", noOrg?.tone === "error" && noOrg.text === OPTS.reasons.no_organization);

const failed = readOAuthReturn("?eventbrite=error&reason=oauth_failed", OPTS);
check("anything else gets the generic copy", failed?.tone === "error" && failed.text === "Couldn’t connect Eventbrite — try again?", failed?.text);

check("no param, no toast", readOAuthReturn("?tab=hosts&reason=x", OPTS) === null);
check("an unknown value is ignored", readOAuthReturn("?eventbrite=maybe", OPTS) === null);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```

Add to `MANIFEST` pure section after `"smoke-oauth-refresh-rejection": "pure",`: `  "smoke-oauth-return": "pure",`

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-oauth-return.ts` — Expected: `Cannot find module '../src/lib/oauth-return'`, exit 1.

- [ ] **Step 3: Implement the helper**

Create `src/lib/oauth-return.ts`:

```ts
import { describeOAuthReason } from "@/lib/errors";

/**
 * What an OAuth callback's redirect params mean to the person who just came back.
 *
 * Client-safe (errors.ts has no imports). The caller shows `text` with the given tone and
 * later replaces the URL with `nextSearch` — later, on a gesture, never in a mount effect:
 * in Next 16 `history.replaceState` is a router restore that drops any server action a
 * sibling component queued on mount.
 */
export type OAuthReturn = {
  tone: "success" | "message" | "error";
  text: string;
  /** The query string with this flow's params removed: "" or "?…". */
  nextSearch: string;
};

export function readOAuthReturn(
  search: string,
  opts: {
    /** The param the callback sets to "connected" or "error". */
    param: string;
    provider: string;
    connectedText: string;
    /** Copy for reason codes the callback sets on purpose, beyond `access_denied`. */
    reasons?: Record<string, string>;
  }
): OAuthReturn | null {
  const params = new URLSearchParams(search);
  const outcome = params.get(opts.param);
  if (outcome !== "connected" && outcome !== "error") return null;
  const reason = params.get("reason");
  params.delete(opts.param);
  params.delete("reason");
  const rest = params.toString();
  const nextSearch = rest ? `?${rest}` : "";

  if (outcome === "connected") return { tone: "success", text: opts.connectedText, nextSearch };
  const known = reason && Object.hasOwn(opts.reasons ?? {}, reason) ? opts.reasons![reason] : null;
  if (known) return { tone: "error", text: known, nextSearch };
  const described = describeOAuthReason(reason, opts.provider);
  return { tone: described.cancelled ? "message" : "error", text: described.message, nextSearch };
}
```

- [ ] **Step 4: Wire the card**

In `src/components/events/event-connections-card.tsx`: change line 21 to `import { useEffect, useRef, useState, useTransition } from "react";` and add `import { readOAuthReturn } from "@/lib/oauth-return";`. Above `export function EventConnectionsCard`, add:

```tsx
const EVENTBRITE_RETURN = {
  param: "eventbrite",
  provider: "Eventbrite",
  connectedText: "Eventbrite connected — events you host will sync automatically",
  reasons: {
    no_organization:
      "That Eventbrite account has no organization to sync — create one on Eventbrite, then connect again",
  },
};
```
Inside the component, after `const [openFeed, setOpenFeed] = …` (line 83):

```tsx
  const oauthToasted = useRef(false);
  useEffect(() => {
    const result = readOAuthReturn(window.location.search, EVENTBRITE_RETURN);
    if (!result) return;
    if (!oauthToasted.current) {
      oauthToasted.current = true;
      if (result.tone === "success") toast.success(result.text);
      else if (result.tone === "message") toast.message(result.text);
      else toast.error(result.text);
    }
    // Stripped on the first gesture, not now — see `readOAuthReturn`. pointerdown/keydown
    // fire before the click that could queue an action, so the restore lands first.
    const strip = () =>
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${result.nextSearch}${window.location.hash}`
      );
    window.addEventListener("pointerdown", strip, { once: true, capture: true });
    window.addEventListener("keydown", strip, { once: true, capture: true });
    return () => {
      window.removeEventListener("pointerdown", strip, true);
      window.removeEventListener("keydown", strip, true);
    };
  }, []);
```

- [ ] **Step 5: Fix the callback**

In `src/app/api/events/eventbrite/callback/route.ts`, at the top of the `if (denied) {` block (before `await recordErrorEvent`), add:

```ts
    // A cancelled consent ends the flow: consume the state cookie as the Gmail callback
    // does, rather than leaving it replayable until it expires. Throws on a mismatch —
    // after deleting the cookie, which is all this is for.
    await consumeEventbriteOAuthState(state).catch(() => null);
```
In the `catch (err)` block, replace the `recordErrorEvent` call and the `reason` param with:

```ts
    const kind = classifyOAuthFailure(err);
    await recordErrorEvent({
      source: ERROR_SOURCES.oauthEventbriteCallback,
      kind,
      message: err,
    });
    redirect.searchParams.set("eventbrite", "error");
    redirect.searchParams.set(
      "reason",
      // A code, not the message — the full error is in recordErrorEvent above. The one
      // code worth its own copy is a person's own fixable mistake: no organization.
      kind === "no_organization" ? "no_organization" : "oauth_failed"
    );
    return NextResponse.redirect(redirect);
```

- [ ] **Step 6: Pass, then verify in the browser and with curl**

Run: `npx tsx scripts/smoke-oauth-return.ts` — Expected: `ALL PASS`.
Start `orbit-web`. Open `/events?eventbrite=error&reason=access_denied`: a neutral "Eventbrite connection cancelled — connect again whenever you’re ready" toast; the URL keeps the params until you click anywhere, then reads `/events`. Open `/events?eventbrite=error&reason=no_organization`: the no-organization error toast. Reload `/events` afterwards: no toast.
Then: `curl -s -D - -o /dev/null -b "orbit_eventbrite_oauth_state=abc" "http://localhost:3001/api/events/eventbrite/callback?error=access_denied&state=abc"`
Expected: `location: …/events?eventbrite=error&reason=access_denied` and a `set-cookie: orbit_eventbrite_oauth_state=;` line with an expiry in the past.

- [ ] **Step 7: Typecheck, lint, copy, commit**

Run: `npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts` — Expected: clean.

```bash
git add src/lib/oauth-return.ts src/components/events/event-connections-card.tsx src/app/api/events/eventbrite/callback/route.ts scripts/smoke-oauth-return.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Tell people how an Eventbrite connect ended

The events card reads the callback params (stripped on the next gesture, not on
mount), the callback reports no_organization distinctly, and a cancelled consent
consumes its state cookie.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 10: A dead or empty transcription key stops the meeting recorder instead of six retries per chunk (audit B8, item 8)

The chunk route answers 502 ("retry") for everything except a missing key, so a rejected or out-of-credit key is retried six times per chunk for the whole call.

**Files:**
- Create: `src/lib/meeting-chunk-errors.ts` (DB-free)
- Modify: `src/app/api/capture/meetings/[id]/chunks/route.ts:3` (import), `:29-31` (doc), `:105-119` (catch)
- Modify: `src/lib/meeting-upload-queue.ts:38-45` (`QueueFatal`), `:283-285` (`case 422`)
- Modify: `src/components/capture/meeting-capture-panel.tsx:103-109` (`FATAL_COPY`), `:269-273` (`onFatal`)
- Create: `scripts/smoke-meeting-chunk-errors.ts`; Modify: `scripts/smoke-meeting-upload-queue.ts:139-155`, `scripts/run-smoke.ts` (pure section)

**Interfaces:**
- Consumes: Task 4 `classifyAiError` (`"quota"`), `friendlyError`, `isMissingAiApiKeyError`, `MISSING_AI_API_KEY_MESSAGE`.
- Produces: `chunkFailureResponse(err: unknown): { status: 422 | 502; body: { error: string; code?: string } }` — `code` is `"no-transcription-key"` or `"transcription-auth" | "transcription-quota" | "transcription-model_unavailable"`; `QueueFatal` gains `"transcription-refused"`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/smoke-meeting-chunk-errors.ts`:

```ts
/**
 * Which transcription failures are worth retrying. A key problem is terminal (422): every
 * later chunk of an hour-long call would fail the same way.
 * Run: npx tsx scripts/smoke-meeting-chunk-errors.ts
 */
import { chunkFailureResponse } from "../src/lib/meeting-chunk-errors";
import { MISSING_AI_API_KEY_MESSAGE, aiProviderErrorMessage } from "../src/lib/errors";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const noKey = chunkFailureResponse(new Error(MISSING_AI_API_KEY_MESSAGE));
check("no key → 422 no-transcription-key", noKey.status === 422 && noKey.body.code === "no-transcription-key");

// Depends on Phase 0 narrowing isMissingAiApiKeyError to Orbit's own message. If this
// comes back as no-transcription-key, Phase 0 has not landed — stop and check.
const authCopy = aiProviderErrorMessage(new Error("401 Unauthorized: invalid api key"), "OpenAI");
const auth = chunkFailureResponse(new Error(authCopy));
check("rejected key → 422 transcription-auth", auth.status === 422 && auth.body.code === "transcription-auth", JSON.stringify(auth));
check("…with the provider copy", auth.body.error === authCopy, auth.body.error);

const quota = chunkFailureResponse(new Error("429 You exceeded your current quota, please check your plan and billing details."));
check("out of credit → 422 transcription-quota", quota.status === 422 && quota.body.code === "transcription-quota", JSON.stringify(quota));
check("…never the raw provider text", !quota.body.error.includes("billing details"), quota.body.error);

const model = chunkFailureResponse(new Error("404 model not found: whisper-9"));
check("missing model → 422", model.status === 422 && model.body.code === "transcription-model_unavailable");

const timeout = chunkFailureResponse(new Error("Request timed out"));
check("a timeout is retryable (502)", timeout.status === 502 && timeout.body.code === undefined);
const rate = chunkFailureResponse(new Error("429 rate limit exceeded"));
check("a rate limit is retryable (502)", rate.status === 502);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```
Add `  "smoke-meeting-chunk-errors": "pure",` to `MANIFEST` after `"smoke-meeting-chunking": "pure",`.

In `scripts/smoke-meeting-upload-queue.ts`, replace the "Responses that mean stop" loop header and stub (lines 139-146) with:

```ts
  for (const [status, code, body] of [
    [409, "taken-over", { error: "no" }],
    [410, "gone", { error: "no" }],
    [422, "no-transcription-key", { error: "no", code: "no-transcription-key" }],
    [422, "transcription-refused", { error: "OpenAI says your account is out of credit — top up with them, then try again", code: "transcription-quota" }],
    [401, "signed-out", { error: "no" }],
  ] as const) {
    const f = stubFetch(() => ({ status, body }));
```
and after the existing `check(`…and keeps the chunks for a later recorder`, …)` line inside that loop add:

```ts
    if (code === "transcription-refused") {
      check("…passing the server's copy through", messages.at(-1) === body.error, String(messages.at(-1)));
    }
```
In the same file's `makeQueue` (lines 61-73): add `const messages: string[] = [];` after line 64, change line 70 `onFatal: (code) => fatals.push(code),` to `onFatal: (code, message) => { fatals.push(code); messages.push(message); },`, and line 72 to `return { queue, results, statuses, fatals, messages };`. In the loop change `const { queue, fatals } = makeQueue();` to `const { queue, fatals, messages } = makeQueue();`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx tsx scripts/smoke-meeting-chunk-errors.ts` → `Cannot find module`. Run: `npx tsx scripts/smoke-meeting-upload-queue.ts` → throws `422 stops the queue as "transcription-refused" failed: no-transcription-key after 1`.

- [ ] **Step 3: Implement the classifier and the route**

Create `src/lib/meeting-chunk-errors.ts`:

```ts
import {
  MISSING_AI_API_KEY_MESSAGE,
  classifyAiError,
  friendlyError,
  isMissingAiApiKeyError,
} from "@/lib/errors";

/**
 * The response for a chunk that could not be transcribed.
 *
 * 422 is terminal to the recorder: no key, a rejected key, an empty balance or a missing
 * model fail every later chunk identically, and six retries per chunk of an hour-long call
 * is hundreds of wasted provider calls. Everything else (timeouts, rate limits, outages) is
 * 502, which the recorder retries with backoff.
 */
export type ChunkFailure = { status: 422 | 502; body: { error: string; code?: string } };

const KEY_PROBLEM_FALLBACK = {
  auth: "Your transcription provider didn’t accept your API key — check it in Settings",
  quota: "Your transcription provider says your account is out of credit — top up with them, then try again",
  model_unavailable: "That transcription model isn’t available — pick another in Settings",
} as const;

export function chunkFailureResponse(err: unknown): ChunkFailure {
  const message = err instanceof Error ? err.message : "";
  if (isMissingAiApiKeyError(message)) {
    return { status: 422, body: { error: MISSING_AI_API_KEY_MESSAGE, code: "no-transcription-key" } };
  }
  const kind = classifyAiError(err);
  if (kind === "auth" || kind === "quota" || kind === "model_unavailable") {
    return {
      status: 422,
      body: { error: friendlyError(err, KEY_PROBLEM_FALLBACK[kind]), code: `transcription-${kind}` },
    };
  }
  return { status: 502, body: { error: friendlyError(err, "Couldn’t transcribe that part of the meeting") } };
}
```

In the route: replace the line-3 import with `import { friendlyError } from "@/lib/errors";` plus `import { chunkFailureResponse } from "@/lib/meeting-chunk-errors";`; in the doc comment change `422 no transcription key (stop retrying)` to `422 no usable transcription key — missing, rejected, out of credit or unknown model (stop retrying)`; replace the whole `catch (err) { … }` (lines 105-119) with:

```ts
  } catch (err) {
    const failure = chunkFailureResponse(err);
    return NextResponse.json(failure.body, { status: failure.status });
  }
```

- [ ] **Step 4: Implement the queue and panel**

`src/lib/meeting-upload-queue.ts`: add to `QueueFatal` after `"no-transcription-key"`:

```ts
  /** A key the provider refused, an empty balance, or a model it does not have. */
  | "transcription-refused"
```
and replace `case 422: this.fail("no-transcription-key", message); return;` with:

```ts
      case 422:
        this.fail(body?.code === "no-transcription-key" ? "no-transcription-key" : "transcription-refused", message);
        return;
```

`src/components/capture/meeting-capture-panel.tsx`: add to `FATAL_COPY` after `"no-transcription-key": …`:

```ts
  "transcription-refused": "This meeting is kept and can be resumed once that’s sorted.",
```
and change the `onFatal` body's `setFatal(FATAL_COPY[code] ?? message);` to:

```ts
          // A refused key's message is the provider-specific copy from the server.
          setFatal(code === "transcription-refused" ? `${message}. ${FATAL_COPY[code]}` : FATAL_COPY[code] ?? message);
```

- [ ] **Step 5: Pass, typecheck, lint, commit**

Run: `npx tsx scripts/smoke-meeting-chunk-errors.ts && npx tsx scripts/smoke-meeting-upload-queue.ts && npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts`
Expected: both smokes pass, clean.

```bash
git add src/lib/meeting-chunk-errors.ts "src/app/api/capture/meetings/[id]/chunks/route.ts" src/lib/meeting-upload-queue.ts src/components/capture/meeting-capture-panel.tsx scripts/smoke-meeting-chunk-errors.ts scripts/smoke-meeting-upload-queue.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Stop meeting uploads on a rejected, empty or unknown transcription key

The chunk route answers 422 for key problems; the queue stops and shows the
provider's copy instead of retrying every chunk six times.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 11: Streaming chat stops the provider call when the client goes away (audit B8, item 9)

`/api/chat` never passes `request.signal` to `streamText`, so a closed tab keeps the model generating (and billing) until the 45 s `aiSignal()` fires. Verified in `node_modules/next/dist/build/templates/app-route.js:243` (Next 16.2.10): the route's request is built with `signalFromNodeResponse(res)`, which aborts on the response's `close` before `finish` — a client disconnect. (Vercel's runtime is covered by the manual step at the end.) An aborted call is recorded as `cancelled`, not `other`, so it never counts toward `OUR_ERROR_KINDS`.

**Files:**
- Modify: `src/lib/usage-events.ts:99-135` (`withUsage`)
- Modify: `src/lib/ai.ts:1849-1938` (`streamText`), `:1953-1990` (`chatWithNetworkStream`)
- Modify: `src/app/api/chat/route.ts:93-143` (stream `start`)
- Modify: `scripts/smoke-usage-events.ts` (new section before `await cleanup();` at the end of `main`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `withUsage<T>(meta, run, opts?: { cancelSignal?: AbortSignal }): Promise<T>`; `streamText` input gains `signal?: AbortSignal`; `chatWithNetworkStream(…, focusProfile, attachedContext, options?: { signal?: AbortSignal })`.

- [ ] **Step 1: Write the failing test**

In `scripts/smoke-usage-events.ts`, insert before the final `await cleanup();` in `main`:

```ts
  console.log("\nClient disconnect");
  {
    const controller = new AbortController();
    controller.abort();
    const aborted = new Error("Request was aborted.");
    let caught: unknown = null;
    try {
      await withUsage(
        { ...META, operation: "smoke.cancelled" },
        async () => {
          throw aborted;
        },
        { cancelSignal: controller.signal }
      );
    } catch (err) {
      caught = err;
    }
    check("the abort is still rethrown unchanged", caught === aborted);
    await settle();
    const rows = await rowsFor(USER);
    const row = rows.find((r) => r.operation === "smoke.cancelled");
    check("a cancelled call writes a row", Boolean(row));
    check("…filed as cancelled, not other", row?.errorKind === "cancelled", String(row?.errorKind));

    const live = new AbortController();
    try {
      await withUsage(
        { ...META, operation: "smoke.not-cancelled" },
        async () => {
          throw new Error("429 rate limit exceeded");
        },
        { cancelSignal: live.signal }
      );
    } catch {
      // expected
    }
    await settle();
    const other = (await rowsFor(USER)).find((r) => r.operation === "smoke.not-cancelled");
    check("an unaborted signal keeps the real classification", other?.errorKind === "rate_limit", String(other?.errorKind));
  }
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-usage-events.ts`
Expected: throws `…filed as cancelled, not other failed: other`.

- [ ] **Step 3: Implement `withUsage`**

Replace `withUsage` in `src/lib/usage-events.ts` with:

```ts
export async function withUsage<T>(
  meta: UsageMeta,
  run: (report: (tokens: TokenCounts) => void) => Promise<T>,
  opts: {
    /**
     * The caller's own abort — a client that closed the tab. When it has fired, the
     * failure is `cancelled`: nobody broke, and filed as `other` it would read as Orbit's
     * fault in `OUR_ERROR_KINDS`.
     */
    cancelSignal?: AbortSignal;
  } = {}
): Promise<T> {
  const started = Date.now();
  let tokens: TokenCounts = {};
  const report = (t: TokenCounts) => {
    tokens = t;
  };

  try {
    const result = await run(report);
    recordUsage({
      ...meta,
      ...tokens,
      success: true,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (err) {
    recordUsage({
      ...meta,
      ...tokens,
      success: false,
      errorKind: opts.cancelSignal?.aborted ? "cancelled" : classifyAiError(err),
      durationMs: Date.now() - started,
    });
    throw err;
  }
}
```

- [ ] **Step 4: Thread the signal through `ai.ts`**

In `streamText`: add `signal?: AbortSignal;` to the `input` type after `operation: string;`. After `const maxOutputTokens = …;` add:

```ts
  // One deadline per call plus the caller's abort. A fresh aiSignal() per call, as always.
  const signal = input.signal ? AbortSignal.any([aiSignal(), input.signal]) : aiSignal();
```
Replace the three `aiSignal()` uses inside `streamText` only (Gemini `abortSignal: aiSignal(),`, OpenAI `{ signal: aiSignal() }`, Anthropic `{ signal: aiSignal() }` — lines 1880, 1906, 1924 at `33a213c`) with `signal`. Pass the cancel signal to `withUsage`: its call becomes `withUsage({ … }, async (report) => { … }, { cancelSignal: input.signal })`. If Phase 0 wrapped this `withUsage` call in a try/catch that rewrites errors via `aiProviderErrorMessage`, keep that wrapper as is.

In `chatWithNetworkStream`, add a last parameter `options: { signal?: AbortSignal } = {}` after `attachedContext: … = null`, and add `signal: options.signal,` to the object passed to `streamText` (after `system: …`).

- [ ] **Step 5: Pass it from the route**

In `src/app/api/chat/route.ts`, in the `chatWithNetworkStream(…)` call add a final argument after `ctx.attachedContext`: `{ signal: request.signal }`. Replace the `catch (err) { … } finally { controller.close(); }` of the stream's `start` with:

```ts
      } catch (err) {
        // The client is gone: there is nobody to tell, and enqueueing now would throw.
        if (request.signal.aborted) return;
        send({ type: "error", message: friendlyError(err, TOAST_COPY.chatFailed) });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by the runtime when the client disconnected.
        }
      }
```

- [ ] **Step 6: Pass, typecheck, lint**

Run: `npx tsx scripts/smoke-usage-events.ts && npx tsx scripts/smoke-chat-stream.ts && npm run typecheck && npm run lint`
Expected: both smokes pass; clean (`AbortSignal.any` is typed in `lib.dom.d.ts` and `@types/node` 20.19).

Optional, only with a real provider key in a local `.env.local`: start `orbit-web`, ask a long question in `/chat`, close the tab mid-answer, and confirm in the dev-server log that the `POST /api/chat` line completes within about a second instead of running to the end of the answer. The smoke above is the gate; the production check is in "Manual steps".

- [ ] **Step 7: Commit**

```bash
git add src/lib/usage-events.ts src/lib/ai.ts src/app/api/chat/route.ts scripts/smoke-usage-events.ts
git commit -m "$(cat <<'MSG'
Abort streaming chat on client disconnect and record it as cancelled

request.signal joins the 45s deadline in streamText; withUsage files a caller abort
as "cancelled" rather than a provider failure.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 12: `embedding_failures` table — the one schema change (audit A9 remainder, item 10 prerequisite)

Rows the provider can never embed need a timestamped mark so the hourly backfill stops retrying them. Meetings have no flag of their own (their pending state is the *absence* of a `contact_embeddings` row), so the mark needs a table. One new table, no new columns.

**Files:**
- Modify: `src/db/schema.ts` (new table directly after `contactEmbeddings`, which ends at line 1665)
- Modify: `src/db/index.ts` — the `DDL` template only (after the `contact_embeddings` block, line 350) and the `SCHEMA_VERSION` line + changelog (line 1406). Do not touch reconcile code.
- Modify: `scripts/setup-db.ts:12-50` (`EXPECTED_TABLES`), `src/lib/user-data.ts:5-56` (import), `:122-129` (`insights` step), `scripts/smoke-purge.ts` (seed, after the `contactEmbeddings` insert at line 324-330), `scripts/schema-ddl.lock.json` (regenerated)

**Interfaces:**
- Consumes: nothing.
- Produces: Drizzle `embeddingFailures` (`id`, `userId`, `sourceType: "profile" | "meeting"`, `sourceId`, `errorKind`, `failedAt`) with unique `(user_id, source_type, source_id)` named `embedding_failures_source_uidx`. Purged with the `insights` category. Task 14 writes and reads it.

- [ ] **Step 1: Write the failing test**

In `scripts/smoke-purge.ts`, directly after the `schema.contactEmbeddings` insert (lines 324-330), add:

```ts
  await db.insert(schema.embeddingFailures).values({
    userId: USER,
    sourceType: "meeting",
    sourceId: `cal:evt-unembeddable:${contact.id}`,
    errorKind: "other",
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-purge.ts` — Expected: a TypeError / insert failure on `schema.embeddingFailures` (undefined table), exit 1. Run `npx tsx scripts/smoke-schema-ddl.ts` — passes now; it is the guard for Step 4.

- [ ] **Step 3: Declare the table**

In `src/db/schema.ts`, after the closing `);` of `contactEmbeddings` (line 1665):

```ts
/**
 * Rows the embedding provider refused on their own, after the backfill bisected a failing
 * batch down to a single text.
 *
 * Without a mark, one poison row fails its 200-row batch on every hourly pass forever and
 * holds 199 healthy rows hostage with it. A profile row is also un-flagged
 * (`contacts.embedding_stale_at = NULL`), so an edit re-stamps it and it gets another try; a
 * meeting has no flag, so `PENDING_MEETINGS` in `embedding-backfill.ts` excludes anything
 * listed here. `failed_at` is the last failure; `error_kind` is `classifyAiError`'s token.
 * Purged with the `insights` category.
 */
export const embeddingFailures = pgTable(
  "embedding_failures",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    sourceType: text("source_type").$type<"profile" | "meeting">().notNull(),
    sourceId: text("source_id").notNull(),
    errorKind: text("error_kind"),
    failedAt: timestamp("failed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("embedding_failures_source_uidx").on(t.userId, t.sourceType, t.sourceId),
  ]
);
```

- [ ] **Step 4: Create it in the DDL and bump the version**

In `src/db/index.ts`, inside the `DDL` template, directly after the `contact_embeddings` `CREATE TABLE … );` (line 350), add (no comments inside the template):

```sql
CREATE TABLE IF NOT EXISTS embedding_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  error_kind text,
  failed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS embedding_failures_source_uidx ON embedding_failures(user_id, source_type, source_id);
```

Compute the version: run the scan from Global Constraints; call its output `MAX`. Set `export const SCHEMA_VERSION = <MAX + 1>;` and add a changelog line directly above it:

```ts
// <MAX + 1> = embedding_failures, the backfill's mark for rows the provider refused on their
// own, so one poison row stops failing its batch every hour (launch phase 3a).
```

Then: `npx tsx scripts/smoke-schema-ddl.ts --update` — Expected: prints the new fingerprint and exits 0.

- [ ] **Step 5: Expected tables and purge**

`scripts/setup-db.ts`: add `"embedding_failures",` after `"contact_embeddings",` in `EXPECTED_TABLES`.

`src/lib/user-data.ts`: add `embeddingFailures,` to the `@/db/schema` import (after `duplicateSuggestions,`), and in `STEPS.insights.run` add as the first line:

```ts
      await db.delete(embeddingFailures).where(eq(embeddingFailures.userId, userId));
```
(Leave `counts` alone — failure marks are not something a person counts beside a checkbox. If Phase 2 reshaped `STEPS`, add this delete to whichever step deletes `contactEmbeddings`.)

- [ ] **Step 6: Pass, bootstrap, typecheck, lint**

Run: `npx tsx scripts/smoke-purge.ts && npx tsx scripts/smoke-purge-selective.ts && npx tsx scripts/smoke-schema-ddl.ts && npx tsx scripts/smoke-schema-upgrade.ts && npm run db:setup`
Expected: purge prints `ok  embedding_failures is empty` and passes; schema checks pass; `db:setup` lists `embedding_failures` and reports no missing tables (in this worktree it runs on local PGlite — confirm it printed `(pglite)`).
Run: `npm run typecheck && npm run lint` — clean.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/index.ts scripts/setup-db.ts src/lib/user-data.ts scripts/smoke-purge.ts scripts/schema-ddl.lock.json
git commit -m "$(cat <<'MSG'
Add embedding_failures to mark rows the provider refuses

New table (bumped SCHEMA_VERSION), purged with insights, covered by smoke-purge.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 13: Plan embedding batches by estimated tokens and bisect a failing batch (audit A9 remainder, item 10 — pure half)

`createEmbeddingsBatch` cuts each text to 8,000 characters (≈ 2,000 tokens), so a 200-row batch of long contacts is ≈ 400k tokens — over OpenAI's 300k-per-request cap — and fails every pass. One bad row fails its whole batch the same way.

**Files:**
- Create: `src/lib/embedding-batches.ts` (DB-free)
- Create: `scripts/smoke-embedding-batches.ts`; Modify: `scripts/run-smoke.ts` (pure section)

**Interfaces:**
- Consumes: nothing (callers pass `isFatal`).
- Produces: `EMBED_BATCH_MAX_ITEMS = 200`, `EMBED_BATCH_MAX_TOKENS = 250_000`, `EMBED_INPUT_MAX_CHARS = 8_000`, `estimateEmbeddingTokens(text: string): number`, `planEmbeddingBatches<T>(items: readonly T[], textOf: (item: T) => string, limits?: { maxItems: number; maxTokens: number }): T[][]`, `type BisectOutcome<T> = { embedded: Array<{ item: T; vector: number[] }>; failed: Array<{ item: T; error: unknown }>; calls: number }`, `embedWithBisect<T>(items: readonly T[], textOf: (item: T) => string, embed: (texts: string[]) => Promise<number[][]>, isFatal: (err: unknown) => boolean): Promise<BisectOutcome<T>>`.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-embedding-batches.ts`:

```ts
/**
 * How the backfill slices embedding work, and how it isolates a row the provider refuses.
 * Run: npx tsx scripts/smoke-embedding-batches.ts
 */
import {
  EMBED_BATCH_MAX_TOKENS,
  embedWithBisect,
  estimateEmbeddingTokens,
  planEmbeddingBatches,
} from "../src/lib/embedding-batches";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const id = (s: string) => s;
const sizes = (b: string[][]) => b.map((x) => x.length).join(",");

async function main() {
  console.log("planEmbeddingBatches");
  check("item cap", sizes(planEmbeddingBatches(["a", "b", "c"], id, { maxItems: 2, maxTokens: 1e9 })) === "2,1");
  const long = "x".repeat(8_000);
  check("tokens are estimated on the 8,000-char cut", estimateEmbeddingTokens("x".repeat(20_000)) === 2_000);
  check("token cap", sizes(planEmbeddingBatches(Array(5).fill(long), id, { maxItems: 200, maxTokens: 5_000 })) === "2,2,1");
  check("an oversize text still gets a batch of its own", sizes(planEmbeddingBatches([long, "a"], id, { maxItems: 200, maxTokens: 1_000 })) === "1,1");
  const defaults = planEmbeddingBatches(Array(200).fill(long), id);
  check(
    "200 long contacts no longer go out as one ~400k-token request",
    defaults.length === 2 && defaults.every((b) => b.length * 2_000 <= EMBED_BATCH_MAX_TOKENS),
    sizes(defaults)
  );
  check("order is preserved", planEmbeddingBatches(["a", "b", "c"], id, { maxItems: 2, maxTokens: 1e9 }).flat().join("") === "abc");

  console.log("embedWithBisect");
  const vec = [0.1, 0.2];
  const poisonAware = async (texts: string[]) => {
    if (texts.includes("POISON")) throw new Error("Invalid input at index 3");
    return texts.map(() => vec);
  };
  const items = ["a", "b", "c", "d", "e", "POISON", "g", "h"];
  const out = await embedWithBisect(items, id, poisonAware, () => false);
  check("everything else is embedded", out.embedded.map((e) => e.item).join("") === "abcdegh", out.embedded.map((e) => e.item).join(""));
  check("the poison row is isolated", out.failed.length === 1 && out.failed[0].item === "POISON");
  check("in O(log n) extra calls", out.calls <= 7, String(out.calls));

  let fatalCalls = 0;
  let thrown: unknown = null;
  try {
    await embedWithBisect(items, id, async () => { fatalCalls++; throw new Error("401 Unauthorized"); }, (err) => /401/.test(String(err)));
  } catch (err) {
    thrown = err;
  }
  check("a key-level error is rethrown without bisecting", thrown instanceof Error && fatalCalls === 1, `${fatalCalls} calls`);

  const short = await embedWithBisect(["a", "b"], id, async (texts) => (texts.length > 1 ? [vec] : [vec]), () => false);
  check("a short response is a failure that bisects, then succeeds per row", short.embedded.length === 2 && short.failed.length === 0);

  const empty = await embedWithBisect([], id, async () => { throw new Error("must not call"); }, () => false);
  check("no items, no calls", empty.calls === 0);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => { console.error(err); process.exit(1); });
```
Add `  "smoke-embedding-batches": "pure",` to `MANIFEST` after `"smoke-embedding-cache": "pure",`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-embedding-batches.ts` — Expected: `Cannot find module '../src/lib/embedding-batches'`.

- [ ] **Step 3: Implement**

Create `src/lib/embedding-batches.ts`:

```ts
/**
 * How an embedding backfill slices work into provider calls, and what it does when a call
 * fails. Pure: no database, no provider — the caller passes `embed` and `isFatal`.
 */

/** Texts per provider call. */
export const EMBED_BATCH_MAX_ITEMS = 200;

/**
 * Estimated tokens per call. OpenAI rejects an embeddings request over 300k tokens in total;
 * 200 texts at the 8,000-character cut are ~400k, so the item cap alone bounded nothing.
 */
export const EMBED_BATCH_MAX_TOKENS = 250_000;

/** Mirrors the `text.slice(0, 8000)` in `createEmbeddingsBatch` (src/lib/ai.ts). */
export const EMBED_INPUT_MAX_CHARS = 8_000;

/** ≈ 4 characters per token, on the text as it will actually be sent. */
export function estimateEmbeddingTokens(text: string): number {
  return Math.ceil(Math.min(text.length, EMBED_INPUT_MAX_CHARS) / 4);
}

/** Consecutive batches within both caps. A text over the token cap goes alone. */
export function planEmbeddingBatches<T>(
  items: readonly T[],
  textOf: (item: T) => string,
  limits: { maxItems: number; maxTokens: number } = {
    maxItems: EMBED_BATCH_MAX_ITEMS,
    maxTokens: EMBED_BATCH_MAX_TOKENS,
  }
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const cost = estimateEmbeddingTokens(textOf(item));
    if (current.length > 0 && (current.length >= limits.maxItems || tokens + cost > limits.maxTokens)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(item);
    tokens += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export type BisectOutcome<T> = {
  embedded: Array<{ item: T; vector: number[] }>;
  failed: Array<{ item: T; error: unknown }>;
  /** Provider calls made, for tests and logs. */
  calls: number;
};

/**
 * Embed `items`; when a call fails, split it in half and try each half, down to single
 * items. A single item that still fails is reported, not thrown — that is the row to mark.
 *
 * `isFatal` errors (a rejected or empty key, a rate limit, a missing model) are rethrown at
 * once: bisecting would only multiply a failure that has nothing to do with the rows, and
 * the caller's existing contract — a provider failure leaves the work pending — must hold.
 */
export async function embedWithBisect<T>(
  items: readonly T[],
  textOf: (item: T) => string,
  embed: (texts: string[]) => Promise<number[][]>,
  isFatal: (err: unknown) => boolean
): Promise<BisectOutcome<T>> {
  const outcome: BisectOutcome<T> = { embedded: [], failed: [], calls: 0 };

  async function attempt(slice: readonly T[]): Promise<void> {
    if (slice.length === 0) return;
    outcome.calls += 1;
    try {
      const vectors = await embed(slice.map(textOf));
      if (vectors.length !== slice.length || vectors.some((v) => !Array.isArray(v) || v.length === 0)) {
        throw new Error("Incomplete embedding batch response");
      }
      slice.forEach((item, i) => outcome.embedded.push({ item, vector: vectors[i] }));
    } catch (err) {
      if (isFatal(err)) throw err;
      if (slice.length === 1) {
        outcome.failed.push({ item: slice[0], error: err });
        return;
      }
      const mid = Math.ceil(slice.length / 2);
      await attempt(slice.slice(0, mid));
      await attempt(slice.slice(mid));
    }
  }

  await attempt(items);
  return outcome;
}
```

- [ ] **Step 4: Pass, typecheck, lint, commit**

Run: `npx tsx scripts/smoke-embedding-batches.ts && npm run typecheck && npm run lint` — Expected: `ALL PASS`, clean.

```bash
git add src/lib/embedding-batches.ts scripts/smoke-embedding-batches.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Add a token-capped embedding batch planner and a bisecting embed

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 14: The backfill caps batches by tokens, isolates poison rows and stops retrying them (audit A9 remainder, item 10 — backfill)

**Files:**
- Modify: `src/lib/embedding-backfill.ts:20-32` (imports, drop `EMBED_BATCH`), `:108-160` (profile loop), `:206-220` (`PENDING_MEETINGS`), `:286-330` (meeting loop)
- Modify: `scripts/smoke-embedding-backfill.ts` (new section + a line in `main`)

**Interfaces:**
- Consumes: Task 12 `embeddingFailures`; Task 13 `planEmbeddingBatches`, `embedWithBisect`; Task 4 `classifyAiError`.
- Produces: `runEmbeddingBackfill(userId, embed?, budgetMs?)` — same signature and the same contract that a key-level provider failure throws and leaves work pending. New: a single row the provider refuses is written to `embedding_failures` (`source_id` = contact id for `profile`, `"<contact_id>:<external_id>"` for `meeting`) and is not claimed again; `pendingMeetingCount` excludes marked meetings.

- [ ] **Step 1: Write the failing test**

In `scripts/smoke-embedding-backfill.ts`: add `embeddingFailures` to the `../src/db/schema` import and `pendingMeetingCount` to the `../src/lib/embedding-backfill` import; add `const POISON_USER = "smoke-embedding-backfill-poison-user";` beside the other user constants; add this function before `async function main()`:

```ts
/**
 * Section 5: one row the provider refuses must not hold its batch hostage, and must not be
 * retried every hour. The stub refuses any batch containing "POISON".
 */
async function testPoisonRowsAreIsolated() {
  const db = await getDb();
  await db.delete(embeddingFailures).where(eq(embeddingFailures.userId, POISON_USER));
  await db.delete(contacts).where(eq(contacts.userId, POISON_USER));
  await ensureUserSettings(POISON_USER);
  const now = new Date();
  await db.insert(contacts).values(
    ["Ada One", "Bea Two", "Cy Three", "POISON Person"].map((fullName) => ({
      userId: POISON_USER, fullName, embeddingStaleAt: now,
    }))
  );
  const [guest] = await db.insert(contacts).values({ userId: POISON_USER, fullName: "Meeting Guest" }).returning();
  await db.insert(interactions).values([
    { userId: POISON_USER, contactId: guest.id, interactionType: "meeting", interactionDate: new Date("2024-06-01T10:00:00Z"),
      source: "calendar_import", externalId: `cal:ok:${guest.id}`, rawNotes: "Meeting: Planning" },
    { userId: POISON_USER, contactId: guest.id, interactionType: "meeting", interactionDate: new Date("2024-06-02T10:00:00Z"),
      source: "calendar_import", externalId: `cal:bad:${guest.id}`, rawNotes: "Meeting: POISON agenda" },
  ]);

  let poisonCalls = 0;
  const refusing: typeof createEmbeddingsBatch = async (_userId, texts) => {
    if (texts.some((t) => t.includes("POISON"))) {
      poisonCalls++;
      throw new Error("Invalid input: content could not be embedded");
    }
    return texts.map(() => Array(1536).fill(0.01));
  };

  const first = await runEmbeddingBackfill(POISON_USER, refusing);
  check("the pass finishes instead of throwing", first.remaining === 0, JSON.stringify(first));
  const marks = await db.select().from(embeddingFailures).where(eq(embeddingFailures.userId, POISON_USER));
  check("the poison contact is marked", marks.some((m) => m.sourceType === "profile"), JSON.stringify(marks.map((m) => m.sourceType)));
  check("the poison meeting is marked", marks.some((m) => m.sourceType === "meeting" && m.sourceId === `${guest.id}:cal:bad:${guest.id}`));
  const [rowCount] = await db.select({ value: count() }).from(contactEmbeddings).where(eq(contactEmbeddings.userId, POISON_USER));
  check("every healthy row was embedded (3 profiles + 1 meeting)", (rowCount?.value ?? 0) === 4, `rows ${rowCount?.value}`);
  check("no marked meeting is pending", (await pendingMeetingCount(POISON_USER)) === 0);

  poisonCalls = 0;
  const second = await runEmbeddingBackfill(POISON_USER, refusing);
  check("the next pass never sends the poison rows again", poisonCalls === 0 && second.embedded === 0, `${poisonCalls} poison calls`);

  await db.delete(embeddingFailures).where(eq(embeddingFailures.userId, POISON_USER));
  await db.delete(contacts).where(eq(contacts.userId, POISON_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, POISON_USER));
}
```
In `main`, after the profile section, add:

```ts
  console.log("\n-- a refused row is isolated, marked and not retried --");
  await testPoisonRowsAreIsolated();
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-embedding-backfill.ts`
Expected: section 5 throws `Invalid input: content could not be embedded` out of `runEmbeddingBackfill` (the whole batch fails), exit 1.

- [ ] **Step 3: Implement**

In `src/lib/embedding-backfill.ts`:

1. Imports: `import { contacts, embeddingFailures } from "@/db/schema";`, add `import { classifyAiError, isMissingAiApiKeyError } from "@/lib/errors";` and `import { embedWithBisect, planEmbeddingBatches } from "@/lib/embedding-batches";`. Delete the `EMBED_BATCH` constant and its comment (lines 29-30).

2. After `kickEmbeddingBackfill`, add:

```ts
/**
 * Errors about the KEY or the account, not the rows: bisecting them would only multiply the
 * failure, and rethrowing keeps the old contract — the work stays pending for the next pass.
 */
function isKeyLevelEmbeddingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (isMissingAiApiKeyError(message) || /configured for embeddings|has no embeddings api/i.test(message)) {
    return true;
  }
  const kind = classifyAiError(err);
  return kind === "auth" || kind === "quota" || kind === "rate_limit" || kind === "model_unavailable";
}

/** Marks rows the provider refused on their own; see `embeddingFailures` in schema.ts. */
async function recordEmbeddingFailures(
  userId: string,
  sourceType: "profile" | "meeting",
  failed: Array<{ sourceId: string; error: unknown }>
): Promise<void> {
  if (failed.length === 0) return;
  const db = await getDb();
  await db
    .insert(embeddingFailures)
    .values(failed.map((f) => ({ userId, sourceType, sourceId: f.sourceId, errorKind: classifyAiError(f.error) })))
    .onConflictDoUpdate({
      target: [embeddingFailures.userId, embeddingFailures.sourceType, embeddingFailures.sourceId],
      set: { failedAt: new Date(), errorKind: sql`excluded.error_kind` },
    });
}
```

3. Replace the profile loop `for (let i = 0; i < entries.length; i += EMBED_BATCH) { … }` (lines 108-160) with:

```ts
    for (const slice of planEmbeddingBatches(entries, (entry) => entry.content)) {
      // Key-level failures are rethrown by embedWithBisect, leaving `embedding_stale_at` set
      // so the next pass retries. Only a row refused on its own is isolated and marked.
      const outcome = await embedWithBisect(
        slice,
        (entry) => entry.content,
        (texts) => embed(userId, texts),
        isKeyLevelEmbeddingError
      );
      const done = outcome.embedded;

      if (done.length > 0) {
        const tuples = done.map(
          ({ item, vector }) => sql`(
            ${userId}::text, ${item.contactId}::uuid, 'profile'::text,
            ${item.contactId}::text, ${JSON.stringify(vector)}::jsonb,
            ${item.content}::text
          )`
        );
        const result = await db.execute(sql`
          INSERT INTO contact_embeddings
            (user_id, contact_id, source_type, source_id, embedding, content)
          VALUES ${sql.join(tuples, sql`, `)}
          ON CONFLICT (user_id, contact_id, source_type, source_id)
          DO UPDATE SET embedding = EXCLUDED.embedding, content = EXCLUDED.content
          RETURNING id, contact_id
        `);
        const idByContact = new Map(
          rowsOf<{ id: string; contact_id: string }>(result).map((r) => [r.contact_id, r.id])
        );
        await persistEmbeddingVectors(
          done
            .map(({ item, vector }) => ({ id: idByContact.get(item.contactId) ?? "", embedding: vector }))
            .filter((row) => row.id)
        );
        await db
          .update(contacts)
          .set({ embeddingStaleAt: null })
          .where(
            and(
              inArray(contacts.id, done.map(({ item }) => item.contactId)),
              lte(contacts.embeddingStaleAt, claimedAt)
            )
          );
        embedded += done.length;
      }

      if (outcome.failed.length > 0) {
        const failedIds = outcome.failed.map(({ item }) => item.contactId);
        await recordEmbeddingFailures(
          userId,
          "profile",
          outcome.failed.map(({ item, error }) => ({ sourceId: item.contactId, error }))
        );
        // Un-flagged so the claim stops returning it; an edit re-stamps it for another try.
        await db
          .update(contacts)
          .set({ embeddingStaleAt: null })
          .where(and(inArray(contacts.id, failedIds), lte(contacts.embeddingStaleAt, claimedAt)));
      }
    }
```

4. In `PENDING_MEETINGS`, add before its closing backtick (after the `NOT EXISTS (… contact_embeddings …)` block):

```sql
    AND NOT EXISTS (
      SELECT 1 FROM embedding_failures f
      WHERE f.user_id = i.user_id
        AND f.source_type = 'meeting'
        AND f.source_id = i.contact_id::text || ':' || i.external_id
    )
```
and add one sentence to its doc comment: "A meeting the provider refused on its own is listed in `embedding_failures` and excluded, or it would keep `remaining > 0` and be resent every hour."

5. Replace the meeting loop `for (let i = 0; i < claimed.length; i += EMBED_BATCH) { … }` (lines 286-330) with:

```ts
    for (const slice of planEmbeddingBatches(claimed, (row) => row.content)) {
      const outcome = await embedWithBisect(
        slice,
        (row) => row.content,
        (texts) => embed(userId, texts),
        isKeyLevelEmbeddingError
      );
      const done = outcome.embedded;

      if (done.length > 0) {
        const tuples = done.map(
          ({ item, vector }) => sql`(
            ${userId}::text, ${item.contact_id}::uuid, 'meeting'::text,
            ${item.external_id}::text, ${JSON.stringify(vector)}::jsonb,
            ${item.content}::text
          )`
        );
        // Four-column conflict target, matching `embeddings_user_contact_source_id_uidx`.
        const result = await db.execute(sql`
          INSERT INTO contact_embeddings
            (user_id, contact_id, source_type, source_id, embedding, content)
          VALUES ${sql.join(tuples, sql`, `)}
          ON CONFLICT (user_id, contact_id, source_type, source_id)
          DO UPDATE SET embedding = EXCLUDED.embedding, content = EXCLUDED.content
          RETURNING id, source_id
        `);
        const idBySourceId = new Map(
          rowsOf<{ id: string; source_id: string }>(result).map((r) => [r.source_id, r.id])
        );
        await persistEmbeddingVectors(
          done
            .map(({ item, vector }) => ({ id: idBySourceId.get(item.external_id) ?? "", embedding: vector }))
            .filter((row) => row.id)
        );
        embedded += done.length;
      }

      await recordEmbeddingFailures(
        userId,
        "meeting",
        outcome.failed.map(({ item, error }) => ({ sourceId: `${item.contact_id}:${item.external_id}`, error }))
      );
    }
```

- [ ] **Step 4: Pass, typecheck, lint, commit**

Run: `npx tsx scripts/smoke-embedding-backfill.ts && npx tsx scripts/smoke-embedding-writes.ts && npm run typecheck && npm run lint`
Expected: all five backfill sections pass (section 1 still throws the no-key error, now as a key-level error); clean.

```bash
git add src/lib/embedding-backfill.ts scripts/smoke-embedding-backfill.ts
git commit -m "$(cat <<'MSG'
Cap embedding batches by tokens and stop retrying rows the provider refuses

Batches split under ~250k estimated tokens; a failing batch is bisected to the bad
row, which is marked in embedding_failures and not claimed again. Key-level errors
still throw and leave the work pending.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 15: Chat says so when search fell back to keywords (audit A9 remainder, item 10 — chat)

`retrieveRankedContacts` (`src/lib/chat-context.ts:207`) swallows a failed query embedding with `.catch(() => null)`; the model then answers from keyword hits alone and may say you know nobody like that. Having no embedding key at all (an Anthropic-only account) is a configuration, not an outage, and stays silent.

**Files:**
- Create: `src/lib/chat-search-notice.ts` (DB-free)
- Modify: `src/lib/chat-context.ts:31` (import), `:59-100` (`ChatContext`), `:201-216` (`retrieveRankedContacts`), `:346-380` (destructure), final `return` (~`:472`)
- Modify: `src/lib/chat-stream-protocol.ts:33-46` (`done` event)
- Modify: `src/app/api/chat/route.ts:124-136` (`done` payload)
- Modify: `src/components/chat/chat-panel.tsx:591-593`, `src/components/layout/floating-ask-bar.tsx:414-417` (`onDone`)
- Create: `scripts/smoke-chat-search-notice.ts`; Modify: `scripts/run-smoke.ts` (pure section)

**Interfaces:**
- Consumes: `isMissingAiApiKeyError` from `src/lib/errors.ts`.
- Produces: `KEYWORD_ONLY_SEARCH_NOTICE = "Search used keywords only — Orbit couldn’t reach your embedding provider"`, `embeddingFailureNotice(err: unknown): string | null`; `ChatContext.searchNotice: string | null`; `done` event gains `notice?: string | null`.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-chat-search-notice.ts`:

```ts
/**
 * When a chat answer was grounded in keywords only, and when that is worth saying.
 * Run: npx tsx scripts/smoke-chat-search-notice.ts
 */
import { KEYWORD_ONLY_SEARCH_NOTICE, embeddingFailureNotice } from "../src/lib/chat-search-notice";
import { MISSING_AI_API_KEY_MESSAGE } from "../src/lib/errors";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

check("no embedding key is a configuration, not news", embeddingFailureNotice(new Error("No Gemini API key configured for embeddings. Add your own key in Settings.")) === null);
check("Anthropic-only is silent", embeddingFailureNotice(new Error("Anthropic has no embeddings API. Add an OpenAI or Gemini key.")) === null);
check("Orbit's own no-key message is silent", embeddingFailureNotice(new Error(MISSING_AI_API_KEY_MESSAGE)) === null);
check("a timeout says keywords only", embeddingFailureNotice(new Error("Gemini timed out — try again, or ask something shorter")) === KEYWORD_ONLY_SEARCH_NOTICE);
check("a network failure says keywords only", embeddingFailureNotice(new TypeError("fetch failed")) === KEYWORD_ONLY_SEARCH_NOTICE);
check("a thrown string says keywords only", embeddingFailureNotice("boom") === KEYWORD_ONLY_SEARCH_NOTICE);
check("house voice", !KEYWORD_ONLY_SEARCH_NOTICE.includes("'") && !KEYWORD_ONLY_SEARCH_NOTICE.endsWith(".") && KEYWORD_ONLY_SEARCH_NOTICE.split(" — ").length === 2);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```
Add `  "smoke-chat-search-notice": "pure",` to `MANIFEST` after `"smoke-chat-retrieval": "pure",`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-chat-search-notice.ts` — Expected: `Cannot find module`.

- [ ] **Step 3: Implement the helper**

Create `src/lib/chat-search-notice.ts`:

```ts
import { isMissingAiApiKeyError } from "@/lib/errors";

/** Shown once, under the answer, when retrieval had to fall back to keywords. */
export const KEYWORD_ONLY_SEARCH_NOTICE =
  "Search used keywords only — Orbit couldn’t reach your embedding provider";

/**
 * Having no embedding key is a setup fact, not an outage: an Anthropic-only account simply
 * has no semantic arm (`resolveEmbeddingBackend` in ai.ts throws these messages). If Phase 0
 * reworded those throws, match the new wording here.
 */
const NO_EMBEDDING_KEY = /configured for embeddings|has no embeddings api/i;

export function embeddingFailureNotice(err: unknown): string | null {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (isMissingAiApiKeyError(message) || NO_EMBEDDING_KEY.test(message)) return null;
  return KEYWORD_ONLY_SEARCH_NOTICE;
}
```

- [ ] **Step 4: Carry it through retrieval, the stream and the UI**

`src/lib/chat-context.ts`:
1. Add `import { embeddingFailureNotice } from "@/lib/chat-search-notice";`.
2. In `ChatContext`, after `scopedQuestion: string;` add:

```ts
  /** One line to show under the answer when the semantic arm was unavailable. */
  searchNotice: string | null;
```
3. Replace `retrieveRankedContacts` (lines 201-216) with:

```ts
/** Stage 0-3: query embedding + parse (parallel), wide hybrid retrieval, flash rerank. */
async function retrieveRankedContacts(
  userId: string,
  q: string
): Promise<{ ranked: RankedContact[]; searchNotice: string | null }> {
  const activeGoals = await loadActiveGoalTexts(userId);
  let searchNotice: string | null = null;
  const [queryEmbedding, parsedQuery] = await Promise.all([
    // Still degrades to keywords — but now says so, instead of letting the model conclude
    // the user knows nobody like that.
    getQueryEmbedding(userId, q).catch((err) => {
      searchNotice = embeddingFailureNotice(err);
      return null;
    }),
    understandQuery(userId, q, activeGoals),
  ]);
  const candidates = await hybridSearchContacts(userId, {
    query: q,
    embedding: queryEmbedding,
    filters: parsedQuery.filters,
    expansionTerms: parsedQuery.expansionTerms,
    limit: CANDIDATE_POOL,
  });
  const ranked = await rerankCandidates(userId, q, candidates, undefined, parsedQuery.semanticQuery);
  return { ranked, searchNotice };
}
```
4. In `prepareChatContext`, rename `retrieved` to `retrieval` in the `Promise.all` destructuring (line 347), and directly after `if (threadId && !thread) throw new Error("Chat not found");` add `const retrieved = retrieval.ranked;`. In the returned object add `searchNotice: retrieval.searchNotice,` after `scopedQuestion,`.

`src/lib/chat-stream-protocol.ts`: in the `done` variant, after the `retrieved: Array<…>;` member add:

```ts
      /** One line of context about how the answer was found, e.g. keywords-only search. */
      notice?: string | null;
```

`src/app/api/chat/route.ts`: in the `send({ type: "done", … })` object add `notice: ctx.searchNotice,` after `title: saved.title,`.

`src/components/chat/chat-panel.tsx` `onDone` (after `ensurePlaceholder();`) and `src/components/layout/floating-ask-bar.tsx` `onDone` (after `ensurePlaceholder();`), add:

```tsx
              if (info.notice) toast.message(info.notice);
```

- [ ] **Step 5: Pass, neighbours, typecheck, lint, copy**

Run: `npx tsx scripts/smoke-chat-search-notice.ts && npx tsx scripts/smoke-chat-context.ts && npx tsx scripts/smoke-chat-stream.ts && npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts`
Expected: all pass, clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/chat-search-notice.ts src/lib/chat-context.ts src/lib/chat-stream-protocol.ts src/app/api/chat/route.ts src/components/chat/chat-panel.tsx src/components/layout/floating-ask-bar.tsx scripts/smoke-chat-search-notice.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Tell the person when chat searched by keywords only

A failed query embedding still degrades to keywords, but the done event now carries
a one-line notice the chat panel and ask bar show. No notice for accounts that
simply have no embedding key.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 16: Clear any saved provider key from the "Saved keys" list (audit B8, item 11)

Switching provider keeps the old key working for embeddings and transcription, and the only Clear button clears whichever provider the dropdown shows. `clearApiKey(provider)` (`src/actions/settings.ts:263-283`) already takes a provider; the list gets a button per saved key. Clearing can move embeddings to another provider (Anthropic falls back OpenAI → Gemini), so stale vectors go exactly as `saveAiSettings` does it. `revalidatePath` becomes `revalidatePathIfRequestScoped` so a smoke can drive the action.

**Files:**
- Modify: `src/actions/settings.ts:1-38` (imports), `:263-283` (`clearApiKey`)
- Modify: `src/components/settings/ai-settings.tsx:284-293` (Saved keys)
- Create: `scripts/smoke-clear-api-key.ts`; Modify: `scripts/run-smoke.ts` (pglite section)

**Interfaces:**
- Consumes: private `embeddingBackendFor` (same file, lines 162-189); `revalidatePathIfRequestScoped` from `src/lib/reminder-paths.ts`.
- Produces: `clearApiKey(provider?: AiProvider): Promise<{ ok: true; embeddingReset: boolean }>` (callers that ignore the result are unaffected).

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-clear-api-key.ts`:

```ts
/**
 * Clearing one provider's key: only that key goes, and embeddings made by a provider that
 * is no longer the embedding backend are dropped, as saving a new key already does.
 * Drives the server action as demo mode's `demo-user`.
 *
 * Run: npx tsx scripts/smoke-clear-api-key.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";
process.env.ORBIT_DEMO_DATA = "off"; // no demo workspace seeding
process.env.VERCEL = "1"; // env provider keys must not count as "usable"

import { count, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactEmbeddings, contacts, userSettings } from "../src/db/schema";
import { clearApiKey } from "../src/actions/settings";
import { encrypt } from "../src/lib/crypto";

const USER = "demo-user";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function seed() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({
    userId: USER,
    aiProvider: "anthropic",
    anthropicApiKeyEncrypted: encrypt("sk-ant-test"),
    openaiApiKeyEncrypted: encrypt("sk-openai-test"),
    geminiApiKeyEncrypted: encrypt("AIza-test"),
  });
  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Embedded Person" }).returning();
  await db.insert(contactEmbeddings).values({
    userId: USER, contactId: c.id, sourceType: "profile", sourceId: c.id, embedding: [0.1, 0.2], content: "Embedded Person",
  });
}

async function embeddingCount() {
  const db = await getDb();
  const [row] = await db.select({ n: count() }).from(contactEmbeddings).where(eq(contactEmbeddings.userId, USER));
  return row?.n ?? 0;
}

run(async () => {
  await seed();
  let result: Awaited<ReturnType<typeof clearApiKey>> | null = null;
  let thrown: unknown = null;
  try {
    result = await clearApiKey("openai");
  } catch (err) {
    thrown = err;
  }
  check("runs outside a request (no revalidatePath throw)", thrown === null, String(thrown));
  const db = await getDb();
  const s = (await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) }))!;
  check("the OpenAI key is gone", s.openaiApiKeyEncrypted === null);
  check("the other keys stay", Boolean(s.geminiApiKeyEncrypted) && Boolean(s.anthropicApiKeyEncrypted));
  check("the selected provider is unchanged", s.aiProvider === "anthropic");
  check("the backend moved OpenAI → Gemini, so it reports a reset", result?.embeddingReset === true, JSON.stringify(result));
  check("…and the OpenAI-space vectors are gone", (await embeddingCount()) === 0);

  await seed();
  const same = await clearApiKey("anthropic");
  check("clearing a key that does not embed keeps the vectors", same.embeddingReset === false && (await embeddingCount()) === 1);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll clear-key checks passed.");
});
```
Add `  "smoke-clear-api-key": "pglite",` to `MANIFEST` pglite section after `"smoke-chat-context": "pglite",`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-clear-api-key.ts`
Expected: `FAIL runs outside a request` (`Invariant: static generation store missing in revalidatePath /settings`), reset and vector checks FAIL, exit 1.

- [ ] **Step 3: Implement the action**

In `src/actions/settings.ts` add `import { revalidatePathIfRequestScoped } from "@/lib/reminder-paths";` and replace `clearApiKey` (lines 263-283) with:

```ts
export async function clearApiKey(provider?: AiProvider) {
  const userId = await requireUserId();
  const db = await getDb();
  const existing = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  const active = resolveAiProvider(provider || existing?.aiProvider);

  const patch =
    active === "gemini"
      ? { geminiApiKeyEncrypted: null }
      : active === "openai"
        ? { openaiApiKeyEncrypted: null }
        : { anthropicApiKeyEncrypted: null };

  await db
    .update(userSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId));

  // Clearing a key can move embeddings to another provider — an Anthropic account falls
  // back from OpenAI to Gemini. Vectors from two providers cannot be compared, so stale ones
  // go, by the same rule `saveAiSettings` applies when a save changes the backend.
  let embeddingReset = false;
  if (existing) {
    const selected = resolveAiProvider(existing.aiProvider);
    const previousBackend = await embeddingBackendFor(selected, existing);
    const nextBackend = await embeddingBackendFor(selected, { ...existing, ...patch });
    embeddingReset = Boolean(previousBackend && nextBackend && previousBackend !== nextBackend);
    if (embeddingReset) {
      await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, userId));
    }
  }

  revalidatePathIfRequestScoped("/settings");
  return { ok: true as const, embeddingReset };
}
```

- [ ] **Step 4: Implement the list**

In `src/components/settings/ai-settings.tsx`, replace the `<SettingsRow title="Saved keys">…</SettingsRow>` block (lines 284-293) with:

```tsx
      <SettingsRow title="Saved keys">
        <ul className="space-y-1 text-sm text-muted-foreground">
          {settings.providers.map((p) => (
            <li key={p.id} className="flex min-h-9 items-center justify-between gap-3">
              <span>
                {p.label}: {p.hasPersonalKey ? "saved" : p.usingEnv ? "local env" : "none"}
              </span>
              {p.hasPersonalKey ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  aria-label={`Clear saved ${p.label} key`}
                  onClick={() =>
                    start(async () => {
                      try {
                        const res = await clearApiKey(p.id);
                        setSettings(await getSettings());
                        toast.success(
                          res.embeddingReset
                            ? `${p.label} key cleared — search will re-index`
                            : `${p.label} key cleared`
                        );
                      } catch (err) {
                        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
                      }
                    })
                  }
                >
                  Clear
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </SettingsRow>
```

- [ ] **Step 5: Pass, typecheck, lint, copy**

Run: `npx tsx scripts/smoke-clear-api-key.ts && npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts` — Expected: all checks pass, clean.

- [ ] **Step 6: Browser check**

Stop any dev server. Create `.data/seed-keys.ts`:

```ts
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { encrypt } from "../src/lib/crypto";

delete process.env.DATABASE_URL;
async function main() {
  const db = await getDb();
  await db.update(userSettings)
    .set({ aiProvider: "gemini", openaiApiKeyEncrypted: encrypt("sk-fake"), geminiApiKeyEncrypted: encrypt("AIza-fake") })
    .where(eq(userSettings.userId, "demo-user"));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
```
Run `npx tsx .data/seed-keys.ts` (open the app once first if `demo-user` has no settings row yet), start `orbit-web`, open Settings → Integrations → AI. Expected: "OpenAI: saved" and "Gemini: saved" each with a Clear button. Click OpenAI's Clear: toast "OpenAI key cleared", the row reads "OpenAI: none", Gemini untouched, the provider dropdown still Gemini. Check at 375 px that rows don't overflow. Stop the server; `rm .data/seed-keys.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/actions/settings.ts src/components/settings/ai-settings.tsx scripts/smoke-clear-api-key.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Clear any saved AI key from the Saved keys list

Per-provider Clear buttons; clearing a key that moves the embedding backend drops the
stale vectors, as saving already did.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 17: A rejected Wispr key is recorded and shown in Settings; a null Wispr result is not a success (audit B8/A9, item 12)

`transcribeWithWispr` returns null for everything, and `ai.ts:908-935` wraps it in `withUsage`, so a rejected key is logged as a *successful* call and the user never learns their key is dead. No schema change: the rejection is an `error_events` row carrying a 16-hex fingerprint of the key (a hash prefix, never the key), and Settings shows the notice while the saved key's fingerprint matches the latest rejection — replace or clear the key and it goes away.

**Files:**
- Modify: `src/lib/wispr.ts:24-27` (imports), `:117-149` (call), append helpers
- Modify: `src/lib/error-events.ts:33-81` (`ERROR_SOURCES.wisprTranscribe`)
- Modify: `src/lib/ai.ts:9` (import), `:18-24` (import `recordUsage`), `:908-935` (Wispr branch)
- Modify: `src/actions/settings.ts:17` (import `decryptOrNull`), `:40-147` (`getSettings`)
- Modify: `src/components/settings/ai-settings.tsx:239-249` (Voice transcription row)
- Modify: `scripts/smoke-wispr.ts` (outcome checks, explicit exit)
- Create: `scripts/smoke-wispr-key-rejection.ts`; Modify: `scripts/run-smoke.ts` (pglite section)

**Interfaces:**
- Produces (`src/lib/wispr.ts`): `type WisprOutcome = { text: string } | { text: null; reason: "rejected_key"; status: number } | { text: null; reason: "empty" | "error" }`; `transcribeWithWisprOutcome(apiKey, input): Promise<WisprOutcome>`; `transcribeWithWispr` kept (returns `outcome.text`); `wisprKeyFingerprint(apiKey: string): string`; `recordWisprKeyRejected(userId: string, apiKey: string, status: number): Promise<void>`; `wisprKeyWasRejected(userId: string, apiKey: string): Promise<boolean>`. `getSettings()` gains `wisprKeyRejected: boolean`. Usage rows for Wispr: `success=0` with `error_kind` `"auth"` (401/403 — the user's key, kept out of `OUR_ERROR_KINDS`) or `"empty_response"` (every other null).

- [ ] **Step 1: Write the failing tests**

In `scripts/smoke-wispr.ts`, add `transcribeWithWisprOutcome` to the `../src/lib/wispr` import, delete the final `console.log("\nsmoke-wispr: all checks passed");`, and append:

```ts
// ── transcribeWithWisprOutcome ────────────────────────────────────────────────────────
async function outcomeChecks() {
  console.log("\ntranscribeWithWisprOutcome");
  const realFetch = globalThis.fetch;
  const input = { audioBase64: "AAAA", context: { dictionary_context: [], app: { name: "Orbit", type: "other" as const } } };
  const answer = (res: Response) => { globalThis.fetch = (async () => res) as typeof fetch; };
  try {
    answer(new Response('{"error":"bad key"}', { status: 401 }));
    const r401 = await transcribeWithWisprOutcome("k", input);
    check("a 401 is a rejected key", r401.text === null && "reason" in r401 && r401.reason === "rejected_key");
    answer(new Response("{}", { status: 403 }));
    const r403 = await transcribeWithWisprOutcome("k", input);
    check("a 403 is a rejected key", "reason" in r403 && r403.reason === "rejected_key");
    answer(Response.json({ text: "Met Priya." }));
    check("a transcript comes back", (await transcribeWithWisprOutcome("k", input)).text === "Met Priya.");
    answer(Response.json({ text: "  " }));
    const empty = await transcribeWithWisprOutcome("k", input);
    check("silence is empty, not an error", "reason" in empty && empty.reason === "empty");
    answer(new Response("oops", { status: 500 }));
    const down = await transcribeWithWisprOutcome("k", input);
    check("an outage is an error", "reason" in down && down.reason === "error");
  } finally {
    globalThis.fetch = realFetch;
  }
}

outcomeChecks().then(
  () => {
    console.log("\nsmoke-wispr: all checks passed");
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
```

Create `scripts/smoke-wispr-key-rejection.ts`:

```ts
/**
 * A rejected Wispr key is remembered per key, not per user: replacing the key clears it.
 * Run: npx tsx scripts/smoke-wispr-key-rejection.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { errorEvents } from "../src/db/schema";
import { recordWisprKeyRejected, wisprKeyFingerprint, wisprKeyWasRejected } from "../src/lib/wispr";

const USER = "smoke-wispr-reject-user";
const OTHER = "smoke-wispr-reject-other";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

run(async () => {
  const db = await getDb();
  const clean = () => db.delete(errorEvents).where(and(eq(errorEvents.source, "wispr.transcribe")));
  await clean();
  check("nothing recorded, nothing rejected", !(await wisprKeyWasRejected(USER, "key-a")));
  await recordWisprKeyRejected(USER, "key-a", 401);
  check("the rejected key reads as rejected", await wisprKeyWasRejected(USER, "key-a"));
  check("a replacement key does not", !(await wisprKeyWasRejected(USER, "key-b")));
  check("another user is unaffected", !(await wisprKeyWasRejected(OTHER, "key-a")));
  await new Promise((r) => setTimeout(r, 20));
  await recordWisprKeyRejected(USER, "key-b", 403);
  check("the newest rejection is what counts", (await wisprKeyWasRejected(USER, "key-b")) && !(await wisprKeyWasRejected(USER, "key-a")));
  const rows = await db.select().from(errorEvents).where(eq(errorEvents.userId, USER));
  check("the key itself is never stored", rows.every((r) => !JSON.stringify(r).includes("key-a") && !JSON.stringify(r).includes("key-b")));
  check("the fingerprint is 16 hex characters", /^[0-9a-f]{16}$/.test(wisprKeyFingerprint("key-a")));
  await clean();
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll Wispr rejection checks passed.");
});
```
Add `  "smoke-wispr-key-rejection": "pglite",` to `MANIFEST` pglite section after `"smoke-webhook-delivery": "pglite",`.

- [ ] **Step 2: Run them and watch them fail**

`npx tsx scripts/smoke-wispr.ts` → `TypeError: transcribeWithWisprOutcome is not a function`. `npx tsx scripts/smoke-wispr-key-rejection.ts` → `recordWisprKeyRejected is not a function`.

- [ ] **Step 3: Implement `wispr.ts` and the error source**

`src/lib/error-events.ts`: add to `ERROR_SOURCES` after `providerHealthCheck`:

```ts
  /**
   * Wispr answered 401/403 to a user's own key. One row per rejected capture at most; the
   * key's fingerprint (never the key) lets Settings say "this key" rather than "a key".
   */
  wisprTranscribe: "wispr.transcribe",
```

`src/lib/wispr.ts`: add imports `import { createHash } from "node:crypto";`, `import { and, desc, eq } from "drizzle-orm";`, `import { getDb } from "@/db";`, `import { errorEvents } from "@/db/schema";`, `import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";`. Replace `transcribeWithWispr` (lines 117-149) with:

```ts
export type WisprOutcome =
  | { text: string }
  | { text: null; reason: "rejected_key"; status: number }
  | { text: null; reason: "empty" | "error" };

/**
 * Transcribe one recording. Never throws — every failure is "try the next engine" — but,
 * unlike before, says WHICH failure, so a dead key is not logged as a successful call.
 */
export async function transcribeWithWisprOutcome(
  apiKey: string,
  input: WisprTranscribeInput,
): Promise<WisprOutcome> {
  if (!apiKey.trim()) return { text: null, reason: "error" };
  // base64 is 4 bytes per 3, so this is the decoded size the endpoint will see.
  const decodedBytes = Math.floor((input.audioBase64.length * 3) / 4);
  if (decodedBytes > WISPR_MAX_AUDIO_BYTES) return { text: null, reason: "error" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(WISPR_ENDPOINT, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(buildTranscribeBody(input)),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { text: null, reason: "rejected_key", status: response.status };
    }
    if (!response.ok) return { text: null, reason: "error" };
    const text = parseTranscribeResponse(await response.json());
    return text ? { text } : { text: null, reason: "empty" };
  } catch {
    return { text: null, reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}

/** Text or null, for callers that only need the transcript. */
export async function transcribeWithWispr(
  apiKey: string,
  input: WisprTranscribeInput,
): Promise<string | null> {
  return (await transcribeWithWisprOutcome(apiKey, input)).text;
}
```
Append at the end of the file:

```ts
/** A stable, irreversible handle on a key: enough to tell "this key" from "a new key". */
export function wisprKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey.trim(), "utf8").digest("hex").slice(0, 16);
}

export async function recordWisprKeyRejected(userId: string, apiKey: string, status: number): Promise<void> {
  await recordErrorEvent({
    source: ERROR_SOURCES.wisprTranscribe,
    kind: "key_rejected",
    userId,
    context: { status, keyFingerprint: wisprKeyFingerprint(apiKey) },
  });
}

/** Whether the newest Wispr rejection for this user was for THIS key. */
export async function wisprKeyWasRejected(userId: string, apiKey: string): Promise<boolean> {
  const db = await getDb();
  const [latest] = await db
    .select({ context: errorEvents.context })
    .from(errorEvents)
    .where(
      and(
        eq(errorEvents.userId, userId),
        eq(errorEvents.source, ERROR_SOURCES.wisprTranscribe),
        eq(errorEvents.kind, "key_rejected")
      )
    )
    .orderBy(desc(errorEvents.createdAt))
    .limit(1);
  return latest?.context?.keyFingerprint === wisprKeyFingerprint(apiKey);
}
```

- [ ] **Step 4: Record honestly in `ai.ts` and show it in Settings**

`src/lib/ai.ts`: line 9 becomes `import { buildWisprContext, recordWisprKeyRejected, transcribeWithWisprOutcome } from "@/lib/wispr";`; add `recordUsage,` to the `@/lib/usage-events` import. Replace the `if (wisprKey) { … }` block (from `const text = await withUsage(` through the closing `}` before `const openaiKey`) with:

```ts
  if (wisprKey) {
    const keyOwner = settings?.wisprApiKeyEncrypted ? "user" : "orbit";
    const started = Date.now();
    const outcome = await transcribeWithWisprOutcome(wisprKey, {
      audioBase64: input.base64,
      context: await buildWisprContext(userId, {
        firstName: settings?.firstName,
        lastName: settings?.lastName,
      }),
    });
    // Recorded by hand: Wispr never throws, so `withUsage` filed every null — a dead key
    // included — as a success. A rejected key is the user's (`auth`, outside
    // OUR_ERROR_KINDS); any other null is `empty_response`.
    recordUsage({
      userId, operation, provider: "wispr", model: "flow", kind: "transcription", keyOwner,
      success: outcome.text !== null,
      errorKind: outcome.text !== null ? null : outcome.reason === "rejected_key" ? "auth" : "empty_response",
      durationMs: Date.now() - started,
    });
    if (outcome.text !== null) return { text: outcome.text, engine: "wispr" };
    if (outcome.reason === "rejected_key" && keyOwner === "user") {
      await recordWisprKeyRejected(userId, wisprKey, outcome.status);
    }
    // Fall through to Whisper, then Gemini — see src/lib/wispr.ts.
  }
```

`src/actions/settings.ts`: `import { decryptOrNull, encrypt } from "@/lib/crypto";` and `import { wisprKeyWasRejected } from "@/lib/wispr";`. In `getSettings` replace the `Promise.all([getEntitlements(userId), userHasApolloKey(userId)])` with:

```ts
  const wisprKey = decryptOrNull(settings?.wisprApiKeyEncrypted);
  const [entitlements, hasApolloKey, wisprKeyRejected] = await Promise.all([
    getEntitlements(userId),
    userHasApolloKey(userId),
    wisprKey ? wisprKeyWasRejected(userId, wisprKey).catch(() => false) : Promise.resolve(false),
  ]);
```
and add to the returned object after `hasWisprKey`:

```ts
    /** Wispr refused the saved key on its latest try; clears when the key changes. */
    wisprKeyRejected,
```

`src/components/settings/ai-settings.tsx`: directly after the `wispr-key` `<div className="space-y-1.5">…</div>` (ends line 249) add:

```tsx
        {settings.wisprKeyRejected ? (
          <p role="status" className="text-sm text-warning">
            Wispr didn’t accept this key, so voice notes use your AI provider instead — replace it or clear it
          </p>
        ) : null}
```

- [ ] **Step 5: Pass, typecheck, lint, commit**

Run: `npx tsx scripts/smoke-wispr.ts && npx tsx scripts/smoke-wispr-key-rejection.ts && npx tsx scripts/smoke-instrumentation.ts && npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts` — Expected: all pass, clean.

```bash
git add src/lib/wispr.ts src/lib/error-events.ts src/lib/ai.ts src/actions/settings.ts src/components/settings/ai-settings.tsx scripts/smoke-wispr.ts scripts/smoke-wispr-key-rejection.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Record rejected Wispr keys and say so in Settings

Wispr nulls are no longer logged as successes: 401/403 is error_kind auth plus an
error event keyed by a key fingerprint; other nulls are empty_response. Settings
shows a notice until the key is replaced or cleared.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 18: Shared daily budgets for Unavatar and Microlink, with a per-user share (audit B14, item 14a)

Both sources are ~25 lookups a day for the whole app, guarded only by per-Lambda cooldowns, and the avatar backfill runs on every authenticated page — one large network drains photos for everyone. Budgets go in `rate_limit_buckets`: `avatarSource.shared:<source>` (app-wide) and `avatarSource.user:<source>:<userId>` (one user's slice). An exhausted budget is a *deferral* (`AvatarSourceRateLimitError`), never "no photo", so the 30-day cooldown is not stamped. A limiter DB error also defers (fail closed: never spend quota we cannot count).

**Files:**
- Modify: `src/lib/rate-limit.ts:36-121` (`RATE_LIMITS`)
- Modify: `src/lib/contact-avatar.ts:1-8` (imports), after `:92` (budget helper), `:185-231` (`fetchLinkedInPhotoUrl`)
- Modify: `src/app/api/avatars/[contactId]/route.ts:144`, `src/actions/contacts.ts:1061` and `:1230-1233`
- Modify: `scripts/smoke-avatar-tiers.ts:113, 146, 270, 282`
- Create: `scripts/smoke-avatar-source-budget.ts`; Modify: `scripts/run-smoke.ts` (pglite section)

**Interfaces:**
- Produces: `RATE_LIMITS.avatarSourceShared = { limit: 25, windowSec: 86_400 }`, `RATE_LIMITS.avatarSourceUser = { limit: 5, windowSec: 86_400 }`; `claimAvatarSourceLookup(source: "unavatar" | "microlink", userId: string | null): Promise<AvatarSourceRateLimitError | null>`; `fetchLinkedInPhotoUrl(contactId: string, linkedinUrl: string, userId: string | null)` — `userId` is now REQUIRED; `null` (tests/scripts only) skips the budget. Microlink's shared budget is skipped when `MICROLINK_API_KEY` is set (a paid plan's quota is sized separately); the per-user share still applies.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-avatar-source-budget.ts`:

```ts
/**
 * Unavatar and Microlink are app-wide daily allowances. One user may take only a slice;
 * everyone together may take only the allowance; running out defers, never "no photo".
 * Run: npx tsx scripts/smoke-avatar-source-budget.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { like } from "drizzle-orm";
import { getDb } from "../src/db";
import { rateLimitBuckets } from "../src/db/schema";
import { AvatarSourceRateLimitError, fetchLinkedInPhotoUrl } from "../src/lib/contact-avatar";
import { RATE_LIMITS } from "../src/lib/rate-limit";

delete process.env.MICROLINK_API_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;
const PIXEL = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";
const URL_ = "https://www.linkedin.com/in/budget-person/";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const realFetch = globalThis.fetch;
let unavatarCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes("unavatar.io")) {
    unavatarCalls++;
    return new Response(Buffer.from(PIXEL, "base64"), { headers: { "content-type": "image/jpeg" } });
  }
  return Response.json({ status: "success", data: {} }); // Microlink: nothing found
}) as typeof fetch;

async function attempt(userId: string) {
  try {
    return { photo: await fetchLinkedInPhotoUrl(`c-${userId}`, URL_, userId), deferred: false };
  } catch (err) {
    if (err instanceof AvatarSourceRateLimitError) return { photo: null, deferred: true };
    throw err;
  }
}

run(async () => {
  const db = await getDb();
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "avatarSource%"));
  const share = RATE_LIMITS.avatarSourceUser.limit;
  const pool = RATE_LIMITS.avatarSourceShared.limit;

  for (let i = 0; i < share; i++) await attempt("budget-a");
  const before = unavatarCalls;
  const over = await attempt("budget-a");
  check(`user A gets ${share} Unavatar lookups a day`, before === share, String(before));
  check("the next one is a deferral, not 'no photo'", over.deferred, JSON.stringify(over));
  check("…and makes no Unavatar request", unavatarCalls === before);

  const other = await attempt("budget-b");
  check("user B still has a share", other.photo !== null && !other.deferred, JSON.stringify(other));

  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "avatarSource%"));
  unavatarCalls = 0;
  for (let u = 0; unavatarCalls < pool; u++) await attempt(`budget-pool-${u}`);
  const late = await attempt("budget-latecomer");
  check(`the whole app stops at ${pool} a day`, unavatarCalls === pool && late.deferred, `${unavatarCalls} calls`);

  const unbudgeted = await fetchLinkedInPhotoUrl("c-null", URL_, null);
  check("a null user (tests, scripts) is not budgeted", unbudgeted !== null);

  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "avatarSource%"));
  globalThis.fetch = realFetch;
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll avatar budget checks passed.");
});
```
Add `  "smoke-avatar-source-budget": "pglite",` to `MANIFEST` after `"smoke-avatar-migration": "pglite",`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-avatar-source-budget.ts` — Expected: `RATE_LIMITS.avatarSourceUser` is undefined → `TypeError: Cannot read properties of undefined (reading 'limit')`, exit 1.

- [ ] **Step 3: Budgets and helper**

`src/lib/rate-limit.ts`, add to `RATE_LIMITS` after `avatarResolve`:

```ts
  /**
   * App-wide daily allowance per quota'd photo source (Unavatar, Microlink), keyed on the
   * source, not the user: both free tiers are ~25 lookups a day for the whole deployment,
   * and the per-Lambda cooldowns cannot see each other.
   */
  avatarSourceShared: { limit: 25, windowSec: 86_400 },
  /** One user's daily slice of each source, so one large network cannot drain it for all. */
  avatarSourceUser: { limit: 5, windowSec: 86_400 },
```

`src/lib/contact-avatar.ts`: add `import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";`. After `MicrolinkRateLimitError` (ends line 92) add:

```ts
export type AvatarQuotaSource = "unavatar" | "microlink";

/**
 * Takes one lookup from the user's daily slice and from the app-wide allowance for this
 * source. Returns the deferral to throw when either is spent, or null to go ahead.
 * `userId: null` is for tests and scripts only. A limiter that cannot count defers too:
 * spending quota we cannot see is exactly what this exists to stop.
 */
export async function claimAvatarSourceLookup(
  source: AvatarQuotaSource,
  userId: string | null
): Promise<AvatarSourceRateLimitError | null> {
  if (userId === null) return null;
  const label = source === "unavatar" ? "unavatar.io" : "microlink";
  try {
    await consumeBucket("avatarSource.user", `${source}:${userId}`, RATE_LIMITS.avatarSourceUser);
    if (!(source === "microlink" && process.env.MICROLINK_API_KEY?.trim())) {
      await consumeBucket("avatarSource.shared", source, RATE_LIMITS.avatarSourceShared);
    }
    return null;
  } catch (err) {
    const retryAfterMs = isRateLimitedError(err) ? err.retryAfterSec * 1000 : 60_000;
    return new AvatarSourceRateLimitError(Date.now() + retryAfterMs, label);
  }
}
```

- [ ] **Step 4: Apply it in `fetchLinkedInPhotoUrl` and pass `userId` everywhere**

Change the signature to `export async function fetchLinkedInPhotoUrl(contactId: string, linkedinUrl: string, userId: string | null): Promise<string | null> {` (add a doc line: "`userId` pays for the lookup from its daily share; null only in tests"). Replace the `else { … }` Unavatar branch's first line so it reads:

```ts
  } else {
    const budget = await claimAvatarSourceLookup("unavatar", userId);
    if (budget) {
      deferred = budget;
    } else {
      const unavatarUrl = `https://unavatar.io/linkedin/${encodeURIComponent(slug)}?fallback=false`;
      try {
        const fromUnavatar = await downloadAndPersistAvatar(contactId, unavatarUrl);
        if (fromUnavatar) return fromUnavatar;
      } catch (err) {
        if (!(err instanceof AvatarSourceRateLimitError)) throw err;
        noteUnavatarRateLimit(err.resetAt);
        deferred = err;
      }
    }
  }
```
and directly after the `if (isMicrolinkRateLimited()) { throw … }` check add:

```ts
  const microlinkBudget = await claimAvatarSourceLookup("microlink", userId);
  if (microlinkBudget) throw deferred ?? microlinkBudget;
```

Callers: `src/app/api/avatars/[contactId]/route.ts:144` → `photoUrl = await fetchLinkedInPhotoUrl(contactId, linkedinUrl, userId);`. `src/actions/contacts.ts:1061` → `resolveLinkedIn: (contactId, url) => fetchLinkedInPhotoUrl(contactId, url, userId),`. `src/actions/contacts.ts:1230-1233` → `profileImageUrl = await fetchLinkedInPhotoUrl(contact.id, contact.linkedinUrl, userId);`. `scripts/smoke-avatar-tiers.ts` lines 113, 146, 270, 282: add `, null` as the third argument (e.g. `fetchLinkedInPhotoUrl("tier-1", LINKEDIN_URL, null)`) — that script is pure-tier and must not reach the database.

- [ ] **Step 5: Pass, typecheck, lint, commit**

Run: `npx tsx scripts/smoke-avatar-source-budget.ts && npx tsx scripts/smoke-avatar-tiers.ts && npx tsx scripts/smoke-rate-limit.ts && npm run typecheck && npm run lint`
Expected: all pass (typecheck would flag any caller that forgot the third argument), clean.

```bash
git add src/lib/rate-limit.ts src/lib/contact-avatar.ts "src/app/api/avatars/[contactId]/route.ts" src/actions/contacts.ts scripts/smoke-avatar-tiers.ts scripts/smoke-avatar-source-budget.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Budget Unavatar and Microlink per app and per user

Daily buckets in rate_limit_buckets; an exhausted budget defers the contact instead
of recording it as photoless.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 19: Daily caps on hosted Apollo search and enrichment (audit B14, item 14b)

Pro users spend Orbit's `APOLLO_API_KEY` with no bound. The cap lives in `src/lib/apollo.ts`, where the key is chosen, so every caller (outreach search, contact refresh, profile fill) is covered and a user's OWN key is never counted. `searchProspects` returns the cap message as data via `asActionResult` so it survives the server-action boundary.

**Files:**
- Modify: `src/lib/rate-limit.ts` (`RATE_LIMITS`)
- Modify: `src/lib/apollo.ts:1-14` (imports), `:121-140` (key resolution), `:408-452` (`searchPeople`), `:454-477` (`enrichPerson`), `:483-511` (`enrichPeopleFromLinkedIn`)
- Modify: `src/actions/outreach.ts:43` (import), `:354` (`searchProspects` wrapper)
- Modify: `src/components/outreach/outreach-wizard.tsx:105`, `src/components/outreach/campaign-workspace.tsx:204`
- Create: `scripts/smoke-apollo-hosted-budget.ts`; Modify: `scripts/run-smoke.ts` (pglite section)

**Interfaces:**
- Produces: `RATE_LIMITS.apolloSearch = { limit: 20, windowSec: 86_400 }`, `RATE_LIMITS.apolloEnrich = { limit: 50, windowSec: 86_400 }`; `APOLLO_DAILY_LIMIT_MESSAGE` (exported from `src/lib/apollo.ts`); hosted calls past the cap throw `UserFacingError(APOLLO_DAILY_LIMIT_MESSAGE)`; `searchProspects(campaignId, page?)` now returns `ActionResult<{ imported; matched; mismatched; total; source }>`.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-apollo-hosted-budget.ts`:

```ts
/**
 * Orbit's hosted Apollo key is capped per user per day; a user's own key is not.
 * Run: npx tsx scripts/smoke-apollo-hosted-budget.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { rateLimitBuckets, userSettings } from "../src/db/schema";
import { APOLLO_DAILY_LIMIT_MESSAGE, searchPeople } from "../src/lib/apollo";
import { encrypt } from "../src/lib/crypto";
import { RATE_LIMITS } from "../src/lib/rate-limit";
import { ensureUserSettings } from "../src/lib/user-settings";

process.env.APOLLO_API_KEY = "hosted-apollo-key";
const HOSTED = "smoke-apollo-hosted";
const OWN = "smoke-apollo-own-key";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const realFetch = globalThis.fetch;
let apolloCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://api.apollo.io/")) {
    apolloCalls++;
    return Response.json({ people: [], pagination: { total_entries: 0 } });
  }
  return realFetch(input, init);
}) as typeof fetch;

run(async () => {
  const db = await getDb();
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "apollo.%"));
  for (const userId of [HOSTED, OWN]) {
    await db.delete(userSettings).where(eq(userSettings.userId, userId));
    await ensureUserSettings(userId);
  }
  // Pro via a comp grants hosted enrichment; OWN also has its own key.
  await db.update(userSettings).set({ compedPlan: "orbit" }).where(eq(userSettings.userId, HOSTED));
  await db.update(userSettings).set({ compedPlan: "orbit", apolloApiKeyEncrypted: encrypt("own-key") }).where(eq(userSettings.userId, OWN));

  const limit = RATE_LIMITS.apolloSearch.limit;
  for (let i = 0; i < limit; i++) await searchPeople(HOSTED, {});
  let thrown: unknown = null;
  try {
    await searchPeople(HOSTED, {});
  } catch (err) {
    thrown = err;
  }
  check(`the hosted key allows ${limit} searches a day`, apolloCalls === limit, String(apolloCalls));
  check("the next one is refused with the cap copy", thrown instanceof Error && thrown.message === APOLLO_DAILY_LIMIT_MESSAGE, String(thrown));
  check("…and never reaches Apollo", apolloCalls === limit);

  apolloCalls = 0;
  for (let i = 0; i < limit + 2; i++) await searchPeople(OWN, {});
  check("a user's own key is never capped", apolloCalls === limit + 2, String(apolloCalls));

  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "apollo.%"));
  for (const userId of [HOSTED, OWN]) await db.delete(userSettings).where(eq(userSettings.userId, userId));
  globalThis.fetch = realFetch;
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll hosted Apollo budget checks passed.");
});
```
Add `  "smoke-apollo-hosted-budget": "pglite",` to `MANIFEST` after `"smoke-api-routes": "pglite",`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-apollo-hosted-budget.ts` — Expected: FAIL on "the next one is refused…" (it goes through: `apolloCalls` becomes `limit + 1`), exit 1. (`APOLLO_DAILY_LIMIT_MESSAGE` imports as undefined until Step 3.)

- [ ] **Step 3: Implement**

`src/lib/rate-limit.ts`, add to `RATE_LIMITS`:

```ts
  /** People searches per user per day on Orbit's HOSTED Apollo key. Own keys are uncapped. */
  apolloSearch: { limit: 20, windowSec: 86_400 },
  /** Person matches (one Apollo credit each) per user per day on the hosted key. */
  apolloEnrich: { limit: 50, windowSec: 86_400 },
```

`src/lib/apollo.ts`: add `import { UserFacingError } from "@/lib/errors";` and `import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";`. Replace `getApolloApiKey` (lines 121-136) with:

```ts
/** Shown once a user has spent the day's share of Orbit's hosted Apollo key. */
export const APOLLO_DAILY_LIMIT_MESSAGE =
  "You’ve used today’s Apollo lookups on Orbit’s key — add your own Apollo key in Settings, or try again tomorrow";

async function resolveApolloKey(userId: string): Promise<{ apiKey: string; hosted: boolean } | null> {
  const db = await getDb();
  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  const personal = decryptOrNull(settings?.apolloApiKeyEncrypted);
  if (personal) return { apiKey: personal, hosted: false };

  // Enrichment has no quota anywhere else in the product — unlike sending, which every plan
  // caps at DAILY_SEND_LIMIT — so Orbit's shared key stays subscription-only, and is now
  // also capped per day (`spendHostedApollo`).
  const { canUseHostedEnrichment } = await getEntitlements(userId);
  if (!canUseHostedEnrichment) return null;
  const hosted = process.env.APOLLO_API_KEY || null;
  return hosted ? { apiKey: hosted, hosted: true } : null;
}

export async function getApolloApiKey(userId: string): Promise<string | null> {
  return (await resolveApolloKey(userId))?.apiKey ?? null;
}

/** Counts `units` hosted calls against the user's day. A user's own key never gets here. */
async function spendHostedApollo(userId: string, kind: "search" | "enrich", units = 1): Promise<void> {
  const policy = kind === "search" ? RATE_LIMITS.apolloSearch : RATE_LIMITS.apolloEnrich;
  try {
    for (let i = 0; i < units; i++) {
      await consumeBucket(`apollo.${kind}`, userId, policy);
    }
  } catch (err) {
    if (isRateLimitedError(err)) throw new UserFacingError(APOLLO_DAILY_LIMIT_MESSAGE);
    throw err;
  }
}
```
In `searchPeople`: replace `const apiKey = await getApolloApiKey(userId);` / `if (!apiKey) {` with `const key = await resolveApolloKey(userId);` / `if (!key) {`, insert `if (key.hosted) await spendHostedApollo(userId, "search");` before `const response = await apolloFetch(`, and pass `key.apiKey` instead of `apiKey`.
In `enrichPerson`: `const key = await resolveApolloKey(userId); if (!key || externalId.startsWith("demo-")) return null; if (key.hosted) await spendHostedApollo(userId, "enrich");` and pass `key.apiKey`.
In `enrichPeopleFromLinkedIn`: replace `const maybeApiKey = await getApolloApiKey(userId); if (!maybeApiKey) { throw … }` and `const apiKey = maybeApiKey;` with:

```ts
  const key = await resolveApolloKey(userId);
  if (!key) {
    throw new Error(
      "Add an Apollo API key in Settings → Outreach to refresh LinkedIn profiles."
    );
  }
  if (key.hosted) await spendHostedApollo(userId, "enrich", people.length);
  // Rebound post-guard so the hoisted matchOne closure sees `string`.
  const apiKey = key.apiKey;
```

`src/actions/outreach.ts`: add `asActionResult` to the `@/lib/errors` import. Rename `export async function searchProspects(campaignId: string, page = 1) {` to `async function searchProspectsCore(campaignId: string, page = 1) {` and add directly above it:

```ts
/** Returned as data so the hosted-Apollo daily cap copy survives the action boundary. */
export async function searchProspects(campaignId: string, page = 1) {
  return asActionResult(() => searchProspectsCore(campaignId, page));
}
```

`outreach-wizard.tsx:105` and `campaign-workspace.tsx:204`: replace `const result = await searchProspects(<id>);` with

```tsx
        const res = await searchProspects(campaignId);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        const result = res.value;
```
(using `campaign.id` in `campaign-workspace.tsx`).

- [ ] **Step 4: Pass, typecheck, lint, copy, commit**

Run: `npx tsx scripts/smoke-apollo-hosted-budget.ts && npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts` — Expected: all pass, clean (the new `UserFacingError` copy is checked by `smoke-toast-copy`).

```bash
git add src/lib/rate-limit.ts src/lib/apollo.ts src/actions/outreach.ts src/components/outreach/outreach-wizard.tsx src/components/outreach/campaign-workspace.tsx scripts/smoke-apollo-hosted-budget.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Cap hosted Apollo search and enrichment per user per day

Only calls on Orbit's key are counted; the cap message reaches the outreach UI via
asActionResult.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 20: A per-IP bucket on the public contact form, sharing the interest list's IP helper (audit B14, item 14c)

`/contact` sends mail on Orbit's Resend key behind a per-instance `Map` throttle that does not hold across Lambdas. The body moves to a headers-free core (the `interest-list-join.ts` pattern) so a smoke can drive it; the `"use server"` file keeps only request reading.

**Files:**
- Modify: `src/lib/rate-limit.ts` (`RATE_LIMITS.contactForm`)
- Create: `src/lib/client-ip.ts` (import-free), `src/lib/contact-message-submit.ts` (server)
- Modify (rewrite): `src/actions/contact.ts:1-165`; Modify: `src/actions/interest-list.ts:15-20`
- Create: `scripts/smoke-contact-form-limit.ts`; Modify: `scripts/run-smoke.ts` (pglite section)

**Interfaces:**
- Produces: `clientIpFrom(headers: { get(name: string): string | null }): string`; `RATE_LIMITS.contactForm = { limit: 3, windowSec: 600 }`; `contactInboxConfig(): { apiKey: string; to: string; from: string } | null`; `type ContactSender = (apiKey: string, mail: { from: string; to: string; replyTo: string; subject: string; text: string }) => Promise<{ error: unknown }>`; `submitContactMessageCore(input: ContactInput, ctx: { ip: string; send?: ContactSender }): Promise<ContactResult>`. `isContactFormEnabled` / `submitContactMessage` keep their signatures. All existing user-visible strings are kept verbatim.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-contact-form-limit.ts`:

```ts
/**
 * The public contact form spends Orbit's Resend key, so it is limited per IP in Postgres —
 * across every instance, unlike the old in-memory Map.
 * Run: npx tsx scripts/smoke-contact-form-limit.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { like } from "drizzle-orm";
import { getDb } from "../src/db";
import { rateLimitBuckets } from "../src/db/schema";
import { clientIpFrom } from "../src/lib/client-ip";
import { submitContactMessageCore, type ContactSender } from "../src/lib/contact-message-submit";
import { RATE_LIMITS } from "../src/lib/rate-limit";

process.env.RESEND_API_KEY = "re_smoke";
process.env.CONTACT_INBOX_EMAIL = "inbox@example.test";
process.env.RESEND_FROM_EMAIL = "orbit@example.test";
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const input = {
  name: "Ada", email: "ada@example.test", topic: "idea" as const,
  message: "Orbit should remember birthdays for me, please.", website: "", elapsedMs: 5_000,
};

run(async () => {
  console.log("clientIpFrom");
  const h = (pairs: Record<string, string>) => ({ get: (k: string) => pairs[k.toLowerCase()] ?? null });
  check("first x-forwarded-for hop", clientIpFrom(h({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })) === "203.0.113.7");
  check("then x-real-ip", clientIpFrom(h({ "x-real-ip": " 198.51.100.2 " })) === "198.51.100.2");
  check("then unknown", clientIpFrom(h({})) === "unknown");

  console.log("submitContactMessageCore");
  const db = await getDb();
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "contactForm:%"));
  let sent = 0;
  const send: ContactSender = async () => { sent++; return { error: null }; };
  const limit = RATE_LIMITS.contactForm.limit;
  for (let i = 0; i < limit; i++) {
    const r = await submitContactMessageCore(input, { ip: "203.0.113.7", send });
    check(`message ${i + 1} goes out`, r.ok === true);
  }
  const over = await submitContactMessageCore(input, { ip: "203.0.113.7", send });
  check("the next one from that IP is refused", over.ok === false && /few messages/.test(over.ok ? "" : over.message));
  check(`…and only ${limit} were sent`, sent === limit, String(sent));
  const elsewhere = await submitContactMessageCore(input, { ip: "203.0.113.8", send });
  check("another IP is unaffected", elsewhere.ok === true);
  const bot = await submitContactMessageCore({ ...input, website: "spam" }, { ip: "203.0.113.9", send });
  check("a honeypot hit is refused before the limiter", bot.ok === false);

  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "contactForm:%"));
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll contact-form checks passed.");
});
```
Add `  "smoke-contact-form-limit": "pglite",` to `MANIFEST` after `"smoke-contact-brief": "pglite",`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-contact-form-limit.ts` — Expected: `Cannot find module '../src/lib/client-ip'`.

- [ ] **Step 3: Implement the helpers**

`src/lib/rate-limit.ts`, add to `RATE_LIMITS`:

```ts
  /** `/contact`: sends on Orbit's own Resend key. Per IP, shared across instances. */
  contactForm: { limit: 3, windowSec: 600 },
```

Create `src/lib/client-ip.ts`:

```ts
/**
 * The caller's IP from proxy headers: the first `x-forwarded-for` hop (the client; the rest
 * are proxies), then `x-real-ip`, else "unknown". Import-free so any server action or core
 * can use it with Next's `headers()` or a plain test object.
 */
export function clientIpFrom(headers: { get(name: string): string | null }): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}
```

Create `src/lib/contact-message-submit.ts` — the body of today's `submitContactMessage`, minus the request:

```ts
/**
 * The /contact submission, minus the request. `src/actions/contact.ts` reads the IP and
 * hands it in, so a smoke script can drive this with a fake IP and a recording sender.
 */
import { Resend } from "resend";
import {
  contactSchema,
  MIN_FILL_MS,
  TOPIC_LABELS,
  type ContactInput,
  type ContactResult,
} from "@/lib/contact-message";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";

export type ContactMail = { from: string; to: string; replyTo: string; subject: string; text: string };
export type ContactSender = (apiKey: string, mail: ContactMail) => Promise<{ error: unknown }>;

const resendSender: ContactSender = async (apiKey, mail) => {
  const { error } = await new Resend(apiKey).emails.send(mail);
  return { error: error ?? null };
};

/** Strip anything that could break out of a header line into a new one. */
function singleLine(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function contactInboxConfig() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const to = process.env.CONTACT_INBOX_EMAIL?.trim();
  const from = process.env.CONTACT_FROM_EMAIL?.trim() || process.env.RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !to || !from) return null;
  return { apiKey, to, from };
}

export async function submitContactMessageCore(
  input: ContactInput,
  ctx: { ip: string; send?: ContactSender }
): Promise<ContactResult> {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "");
      // The honeypot has no visible field; a bot that trips it gets the generic failure.
      if (field && field !== "website" && !fieldErrors[field]) fieldErrors[field] = issue.message;
    }
    return {
      ok: false,
      message: Object.keys(fieldErrors).length
        ? "Please fix the highlighted fields."
        : "That submission didn't look right. Please try again.",
      fieldErrors,
    };
  }

  const { name, email, topic, message, elapsedMs } = parsed.data;
  if (elapsedMs < MIN_FILL_MS) {
    return { ok: false, message: "That was too quick — give it another moment and resend." };
  }

  const config = contactInboxConfig();
  if (!config) {
    return {
      ok: false,
      message: "The form isn't wired up right now. Please reach out via jasonpereira.live instead.",
    };
  }

  // In Postgres rather than instance memory, so a flood spread across Lambdas is still one
  // budget. Fails closed like every other limiter here: a limiter that cannot count must
  // not send on Orbit's key.
  try {
    await consumeBucket("contactForm", ctx.ip, RATE_LIMITS.contactForm);
  } catch (err) {
    if (isRateLimitedError(err)) {
      return {
        ok: false,
        message: "That's a few messages in a short window. Give it a little while before sending another.",
      };
    }
    console.error("[contact] rate limiter unavailable", err);
    return {
      ok: false,
      message: "Something went wrong sending that. Please try again, or reach out via jasonpereira.live.",
    };
  }

  const sender = singleLine(name);
  const senderEmail = singleLine(email);
  try {
    const { error } = await (ctx.send ?? resendSender)(config.apiKey, {
      from: config.from,
      to: config.to,
      // Replying in the mail client goes straight back to the visitor.
      replyTo: `${sender} <${senderEmail}>`,
      subject: `[Orbit] ${TOPIC_LABELS[topic]} — ${sender}`,
      // Plain text only: nothing here is authored by us.
      text: [`Topic:   ${TOPIC_LABELS[topic]}`, `From:    ${sender} <${senderEmail}>`, "", message].join("\n"),
    });
    if (error) {
      console.error("[contact] Resend rejected the message", error);
      return {
        ok: false,
        message: "The message couldn't be delivered. Please try again, or reach out via jasonpereira.live.",
      };
    }
  } catch (err) {
    console.error("[contact] Failed to send", err);
    return {
      ok: false,
      message: "Something went wrong sending that. Please try again, or reach out via jasonpereira.live.",
    };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Thin the actions**

Replace all of `src/actions/contact.ts` with:

```ts
"use server";

import { headers } from "next/headers";
import { clientIpFrom } from "@/lib/client-ip";
import { contactInboxConfig, submitContactMessageCore } from "@/lib/contact-message-submit";
import type { ContactInput, ContactResult } from "@/lib/contact-message";

/**
 * Whether the contact form can actually deliver. The page hides the form when this is
 * false rather than showing one that always fails.
 */
export async function isContactFormEnabled() {
  return contactInboxConfig() !== null;
}

/** The request-reading half; everything else is in `lib/contact-message-submit.ts`. */
export async function submitContactMessage(input: ContactInput): Promise<ContactResult> {
  return submitContactMessageCore(input, { ip: clientIpFrom(await headers()) });
}
```
In `src/actions/interest-list.ts`, add `import { clientIpFrom } from "@/lib/client-ip";` and replace lines 16-20 (the comment and the `const ip = …` expression) with `const ip = clientIpFrom(headerList);`.

- [ ] **Step 5: Pass, neighbours, typecheck, lint, commit**

Run: `npx tsx scripts/smoke-contact-form-limit.ts && npx tsx scripts/smoke-interest-list-join.ts && npx tsx scripts/smoke-clerk-free-site.ts && npm run typecheck && npm run lint`
Expected: all pass (the `(site)` group stays Clerk-free), clean. Then start `orbit-web`, open `/contact` and confirm the page renders (the form is hidden without `RESEND_API_KEY`, as before).

```bash
git add src/lib/rate-limit.ts src/lib/client-ip.ts src/lib/contact-message-submit.ts src/actions/contact.ts src/actions/interest-list.ts scripts/smoke-contact-form-limit.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Rate-limit the public contact form per IP in Postgres

The per-instance Map is replaced by a contactForm bucket; the submission moves to a
headers-free core, and both public forms share one client-IP helper.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 21: A number that replied STOP reads as opted out, not as a failed send (audit B14, item 15)

**Decision (item 15):** there is no inbound SMS webhook (`grep -rniE "reply stop|opt.?out|twilio" src` finds only the footer in `src/lib/outreach-send.ts:75` and settings UI; `src/app/api/webhooks/` holds only `clerk`, `outbound`, `resend`, `stripe`). Twilio handles STOP itself: with its default opt-out handling (Advanced Opt-Out on a Messaging Service), a STOP reply blocks every later message from that sender and Twilio rejects them with error **21610** ("Attempt to send to unsubscribed recipient"). So the "Reply STOP to opt out." footer is truthful **provided opt-out handling is on for the sending number** — keep the footer, and confirm the setting (Manual steps). What is missing in code is the aftermath: a later send to that number throws Twilio's raw error, which reads as "That didn’t send — try again?" and invites retries to someone who opted out.

**Files:**
- Create: `src/lib/twilio-errors.ts` (import-free)
- Modify: `src/lib/outreach-send.ts:1-13` (imports), `:128-135` (`client.messages.create`)
- Create: `scripts/smoke-twilio-opt-out.ts`; Modify: `scripts/run-smoke.ts` (pure section)

**Interfaces:**
- Produces: `TWILIO_OPTED_OUT = 21610`, `SMS_OPTED_OUT_MESSAGE = "That number replied STOP, so Orbit can’t text it again"`, `isTwilioOptOut(err: unknown): boolean`. `sendOutreachMessage` throws `UserFacingError(SMS_OPTED_OUT_MESSAGE)` for that case; every other Twilio error is rethrown unchanged.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-twilio-opt-out.ts`:

```ts
/**
 * Twilio enforces STOP by rejecting later sends with 21610. That must read as "opted out",
 * never as a transient failure worth retrying.
 * Run: npx tsx scripts/smoke-twilio-opt-out.ts
 */
import { SMS_OPTED_OUT_MESSAGE, TWILIO_OPTED_OUT, isTwilioOptOut } from "../src/lib/twilio-errors";

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

const restException = Object.assign(new Error("Attempt to send to unsubscribed recipient"), { code: 21610, status: 400 });
check("Twilio's 21610 is an opt-out", isTwilioOptOut(restException));
check("the constant is 21610", TWILIO_OPTED_OUT === 21610);
check("another Twilio error is not", !isTwilioOptOut(Object.assign(new Error("Invalid 'To' Phone Number"), { code: 21211 })));
check("a string code is not", !isTwilioOptOut({ code: "21610" }));
check("junk is not", !isTwilioOptOut(null) && !isTwilioOptOut("21610"));
check("house voice", !SMS_OPTED_OUT_MESSAGE.includes("'") && !SMS_OPTED_OUT_MESSAGE.endsWith(".") && !/failed/i.test(SMS_OPTED_OUT_MESSAGE));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```
Add `  "smoke-twilio-opt-out": "pure",` to `MANIFEST` after `"smoke-timeline-vocabulary": "pure",`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-twilio-opt-out.ts` — Expected: `Cannot find module '../src/lib/twilio-errors'`.

- [ ] **Step 3: Implement**

Create `src/lib/twilio-errors.ts`:

```ts
/**
 * Twilio's "Attempt to send to unsubscribed recipient". The person replied STOP; Twilio's
 * opt-out handling now blocks every message from this sender to them, and Orbit has no
 * inbound webhook of its own — this rejection is how Orbit learns it.
 */
export const TWILIO_OPTED_OUT = 21610;

export const SMS_OPTED_OUT_MESSAGE = "That number replied STOP, so Orbit can’t text it again";

export function isTwilioOptOut(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === TWILIO_OPTED_OUT
  );
}
```

In `src/lib/outreach-send.ts`, add `import { UserFacingError } from "@/lib/errors";` and `import { SMS_OPTED_OUT_MESSAGE, isTwilioOptOut } from "@/lib/twilio-errors";`, and replace

```ts
  const message = await client.messages.create({
    from: config.twilioFromNumber,
    to: input.toPhone,
    body,
  });
```
with

```ts
  let message;
  try {
    message = await client.messages.create({
      from: config.twilioFromNumber,
      to: input.toPhone,
      body,
    });
  } catch (err) {
    // The footer's promise, kept by Twilio: a STOP'd number is final, not "try again".
    if (isTwilioOptOut(err)) throw new UserFacingError(SMS_OPTED_OUT_MESSAGE);
    throw err;
  }
```

- [ ] **Step 4: Pass, typecheck, lint, copy, commit**

Run: `npx tsx scripts/smoke-twilio-opt-out.ts && npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts` — Expected: all pass, clean.

```bash
git add src/lib/twilio-errors.ts src/lib/outreach-send.ts scripts/smoke-twilio-opt-out.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Report a STOP'd SMS recipient as opted out

Twilio rejects sends to opted-out numbers with 21610; that now surfaces as a plain
opted-out message instead of a retryable failure. The STOP footer stays: Twilio's
opt-out handling enforces it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 22: Outreach mail on a user's own Resend key sends from their verified domain (deferred from Phase 0, audit A11)

With a personal Resend key, `sendOutreachMessage` (`src/lib/outreach-send.ts:99-120` at `33a213c`) still sends `from: RESEND_FROM_EMAIL` — Orbit's domain, which is not verified in the user's Resend account — so Resend rejects every send. No schema column: the sender is derived from the user's own Resend account. Verified in `node_modules/resend` 6.17.2 (`dist/index.d.mts:1752`): `resend.domains.list()` returns `{ data: { data: Domain[] } | null, error }` with `Domain.status: 'pending' | 'verified' | 'failed' | 'not_started' | 'partially_verified' | 'partially_failed'`.

**Files:**
- Create: `src/lib/outreach-sender.ts` (no `@/db`; imports only `resend`, `node:crypto`, `@/lib/errors`)
- Modify: `src/lib/outreach-send.ts:1-13` (imports), `:15-43` (`getOutreachSendConfig` return), the email branch of `sendOutreachMessage` (`:99-120`)
- Create: `scripts/smoke-outreach-sender.ts`; Modify: `scripts/run-smoke.ts` (pure section)

**Interfaces:**
- Consumes: `UserFacingError` from `src/lib/errors.ts`; Phase 0's `replyTo` on the send (kept as is).
- Produces (`src/lib/outreach-sender.ts`): `NO_VERIFIED_DOMAIN_MESSAGE`, `OUTREACH_LOCAL_PART = "outreach"`, `SENDER_CACHE_TTL_MS = 600_000`, `type ResendDomain = { name: string; status: string }`, `type ListResendDomains = (apiKey: string) => Promise<ResendDomain[]>`, `listResendDomainsWithSdk: ListResendDomains`, `outreachFromAddress(input: { userId: string; apiKey: string; resendKeyIsPersonal: boolean; firstName: string | null; hostedFrom: string; listDomains?: ListResendDomains; now?: () => number }): Promise<string>`, `__clearSenderCacheForTests(): void`. `getOutreachSendConfig` gains `resendKeyIsPersonal: boolean` and `firstName: string | null`.
- Behaviour: hosted key → `hostedFrom` unchanged, no lookup. Personal key → first `verified` domain, `outreach@<domain>`, display name = the user's first name when present; cached in memory per user AND key for 10 minutes (successes only). No verified domain, or the lookup errors → `UserFacingError(NO_VERIFIED_DOMAIN_MESSAGE)`; never Orbit's domain on a user's key. Known limit: a Resend key restricted to *sending access* cannot list domains and gets the same message — the Resend key help text in Settings should say "full access" (see Manual steps).

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-outreach-sender.ts`:

```ts
/**
 * Who outreach mail is FROM. Orbit's key sends from Orbit's domain; a user's own Resend key
 * must send from a domain verified in THEIR account, or not at all — never from Orbit's.
 * The Resend domains lookup is injected; no network.
 * Run: npx tsx scripts/smoke-outreach-sender.ts
 */
import { UserFacingError } from "../src/lib/errors";
import {
  NO_VERIFIED_DOMAIN_MESSAGE,
  SENDER_CACHE_TTL_MS,
  __clearSenderCacheForTests,
  outreachFromAddress,
  type ListResendDomains,
} from "../src/lib/outreach-sender";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const HOSTED_FROM = "Orbit <outreach@orbit.example>";
function lookup(result: Awaited<ReturnType<ListResendDomains>> | Error) {
  let calls = 0;
  const fn: ListResendDomains = async () => {
    calls++;
    if (result instanceof Error) throw result;
    return result;
  };
  return { fn, calls: () => calls };
}
async function refused(p: Promise<string>) {
  try {
    return { from: await p, error: null as unknown };
  } catch (error) {
    return { from: null, error };
  }
}

async function main() {
  const base = { userId: "u1", apiKey: "re_user_1", resendKeyIsPersonal: true, firstName: "Ada", hostedFrom: HOSTED_FROM };

  console.log("a verified domain is used, with the user's first name");
  __clearSenderCacheForTests();
  let t = 1_000;
  const found = lookup([{ name: "pending.acme.com", status: "pending" }, { name: "acme.com", status: "verified" }]);
  const from = await outreachFromAddress({ ...base, listDomains: found.fn, now: () => t });
  check("sends as the user from their verified domain", from === "Ada <outreach@acme.com>", from);
  await outreachFromAddress({ ...base, listDomains: found.fn, now: () => t });
  check("cached for the next send", found.calls() === 1, String(found.calls()));
  t += SENDER_CACHE_TTL_MS + 1;
  await outreachFromAddress({ ...base, listDomains: found.fn, now: () => t });
  check("looked up again after ten minutes", found.calls() === 2, String(found.calls()));
  const nameless = await outreachFromAddress({ ...base, userId: "u2", firstName: null, listDomains: found.fn, now: () => t });
  check("no first name, bare address", nameless === "outreach@acme.com", nameless);
  const rekeyed = lookup([{ name: "other.dev", status: "verified" }]);
  const afterNewKey = await outreachFromAddress({ ...base, apiKey: "re_user_new", listDomains: rekeyed.fn, now: () => t });
  check("a new key is looked up, not served from the old key's cache", afterNewKey === "Ada <outreach@other.dev>" && rekeyed.calls() === 1, afterNewKey);

  console.log("no verified domain refuses the send");
  __clearSenderCacheForTests();
  const none = lookup([{ name: "acme.com", status: "pending" }, { name: "b.io", status: "failed" }]);
  const r1 = await refused(outreachFromAddress({ ...base, listDomains: none.fn }));
  check("refused with the house message", r1.error instanceof UserFacingError && (r1.error as Error).message === NO_VERIFIED_DOMAIN_MESSAGE, String(r1.error));
  const fixed = lookup([{ name: "acme.com", status: "verified" }]);
  const r2 = await outreachFromAddress({ ...base, listDomains: fixed.fn });
  check("a refusal is not cached — verifying then retrying works", r2 === "Ada <outreach@acme.com>", r2);

  console.log("a lookup error refuses too, never falling back to Orbit's domain");
  __clearSenderCacheForTests();
  const broken = lookup(new Error("Resend domains lookup: restricted_api_key"));
  const r3 = await refused(outreachFromAddress({ ...base, listDomains: broken.fn }));
  check("same message", r3.error instanceof UserFacingError && (r3.error as Error).message === NO_VERIFIED_DOMAIN_MESSAGE, String(r3.error));
  check("no from address at all", r3.from === null);

  console.log("hosted sending is unchanged");
  const never = lookup(new Error("must not be called"));
  const hosted = await outreachFromAddress({ ...base, resendKeyIsPersonal: false, apiKey: "re_orbit", listDomains: never.fn });
  check("Orbit's key keeps Orbit's from", hosted === HOSTED_FROM && never.calls() === 0, hosted);

  check("house voice", !NO_VERIFIED_DOMAIN_MESSAGE.includes("'") && !NO_VERIFIED_DOMAIN_MESSAGE.endsWith(".") && !/failed/i.test(NO_VERIFIED_DOMAIN_MESSAGE));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => { console.error(err); process.exit(1); });
```
Add `  "smoke-outreach-sender": "pure",` to `MANIFEST` after `"smoke-ops-alerts": "pure",`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx scripts/smoke-outreach-sender.ts` — Expected: `Cannot find module '../src/lib/outreach-sender'`, exit 1.

- [ ] **Step 3: Implement the resolver**

Create `src/lib/outreach-sender.ts`:

```ts
/**
 * The From address for outreach mail.
 *
 * On Orbit's hosted Resend key, mail goes from Orbit's own verified domain. On a user's OWN
 * key that address is wrong: Resend only sends from domains verified in the account the key
 * belongs to, so every send was rejected. Here the domain comes from the user's Resend
 * account itself — no settings column — and a key with no verified domain refuses the send
 * rather than falling back to Orbit's domain, which could never work on that key.
 *
 * No `@/db`: the lookup is injectable, so `scripts/smoke-outreach-sender.ts` runs pure.
 */
import { createHash } from "node:crypto";
import { Resend } from "resend";
import { UserFacingError } from "@/lib/errors";

export const NO_VERIFIED_DOMAIN_MESSAGE =
  "Your Resend account has no verified domain yet — verify one at resend.com/domains, then send again";

/** The mailbox name on the user's domain. Replies go to Phase 0's `replyTo`, not here. */
export const OUTREACH_LOCAL_PART = "outreach";

export const SENDER_CACHE_TTL_MS = 10 * 60 * 1000;

export type ResendDomain = { name: string; status: string };
export type ListResendDomains = (apiKey: string) => Promise<ResendDomain[]>;

/** Resend SDK 6.x: `domains.list()` → `{ data: { data: Domain[] } | null, error }`. */
export const listResendDomainsWithSdk: ListResendDomains = async (apiKey) => {
  const { data, error } = await new Resend(apiKey).domains.list();
  if (error || !data) throw new Error(`Resend domains lookup: ${error?.message ?? "no data"}`);
  return data.data.map((d) => ({ name: d.name, status: d.status }));
};

/**
 * Per user AND key, so replacing a key is a fresh lookup. Successes only: a user who has
 * just verified their domain must not wait ten minutes to be believed. Per instance, like
 * every other in-memory cache here — a cold instance simply looks up once.
 */
const senderDomains = new Map<string, { domain: string; expiresAt: number }>();

function cacheKey(userId: string, apiKey: string) {
  return `${userId}:${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
}

/** A display name that cannot break out of the header. */
function displayName(firstName: string | null): string | null {
  const clean = firstName?.replace(/[\r\n"<>,]/g, "").trim();
  return clean ? clean : null;
}

export async function outreachFromAddress(input: {
  userId: string;
  apiKey: string;
  resendKeyIsPersonal: boolean;
  firstName: string | null;
  hostedFrom: string;
  listDomains?: ListResendDomains;
  now?: () => number;
}): Promise<string> {
  if (!input.resendKeyIsPersonal) return input.hostedFrom;

  const now = (input.now ?? Date.now)();
  const key = cacheKey(input.userId, input.apiKey);
  let cached = senderDomains.get(key);
  if (!cached || cached.expiresAt <= now) {
    let domains: ResendDomain[];
    try {
      domains = await (input.listDomains ?? listResendDomainsWithSdk)(input.apiKey);
    } catch {
      // Same answer as "none verified": whatever went wrong, Orbit's domain is not an
      // option on this key, and the fix the person can make is in their Resend account.
      throw new UserFacingError(NO_VERIFIED_DOMAIN_MESSAGE);
    }
    const verified = domains.find((d) => d.status === "verified");
    if (!verified) throw new UserFacingError(NO_VERIFIED_DOMAIN_MESSAGE);
    cached = { domain: verified.name, expiresAt: now + SENDER_CACHE_TTL_MS };
    senderDomains.set(key, cached);
  }

  const address = `${OUTREACH_LOCAL_PART}@${cached.domain}`;
  const name = displayName(input.firstName);
  return name ? `${name} <${address}>` : address;
}

export function __clearSenderCacheForTests() {
  senderDomains.clear();
}
```

- [ ] **Step 4: Wire it into the send**

In `src/lib/outreach-send.ts` add `import { outreachFromAddress } from "@/lib/outreach-sender";`. In `getOutreachSendConfig`'s returned object add (after `fromEmail`):

```ts
    /** True when the Resend key is the user's own — its From must be their domain. */
    resendKeyIsPersonal: Boolean(decryptOrNull(settings?.resendApiKeyEncrypted)),
    firstName: settings?.firstName?.trim() || null,
```
In `sendOutreachMessage`'s email branch, directly after the `if (!config.resendApiKey) { throw … }` guard, add:

```ts
    const from = await outreachFromAddress({
      userId: input.userId,
      apiKey: config.resendApiKey,
      resendKeyIsPersonal: config.resendKeyIsPersonal,
      firstName: config.firstName,
      hostedFrom: config.fromEmail,
    });
```
and in the `resend.emails.send({ … })` call change `from: config.fromEmail,` to `from,`. Leave every other field — including Phase 0's `replyTo` — exactly as it is. (If Phase 0 already added a per-user `from` override, stop and reconcile: this task replaces it only for personal keys.)

- [ ] **Step 5: Pass, typecheck, lint, copy, commit**

Run: `npx tsx scripts/smoke-outreach-sender.ts && npm run typecheck && npm run lint && npx tsx scripts/smoke-toast-copy.ts`
Expected: `ALL PASS`, clean.

```bash
git add src/lib/outreach-sender.ts src/lib/outreach-send.ts scripts/smoke-outreach-sender.ts scripts/run-smoke.ts
git commit -m "$(cat <<'MSG'
Send BYOK Resend outreach from the user's verified domain

A personal Resend key now sends as outreach@<first verified domain in that account>,
named with the user's first name and cached per user and key for ten minutes. With
no verified domain, or a failed lookup, the send is refused in plain words; it never
falls back to Orbit's domain. Hosted sending is unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 23: Branch-wide verification

**Files:** none (verification only; commit only if a fix was needed, as its own commit naming the task it belongs to).

- [ ] **Step 1: Full suite and structure**

Run: `npx tsx scripts/run-smoke.ts --check && npm test`
Expected: `structure ok.` and every script `ok` (rerun any `smoke-admin-render` / `smoke-instrumentation` timeout alone before suspecting code — machine-load flakes).

- [ ] **Step 2: Typecheck, lint, build**

Stop any `orbit-web` server in this worktree first (a build and a dev server sharing `.next` wedge each other). Run: `npm run typecheck && npm run lint && npx next build`
Expected: 0 type errors, 0 lint errors, build succeeds (no `node:fs` chunk error — no client component imports `@/db`).

- [ ] **Step 3: Schema version re-scan**

Run the scan from Global Constraints. Expected: its maximum equals the `SCHEMA_VERSION` Task 12 set. If another branch has since claimed it or higher, bump again (new changelog line), `npx tsx scripts/smoke-schema-ddl.ts --update`, commit "Re-number embedding_failures schema version".

- [ ] **Step 4: Hand off**

Push and open the PR only when Jason asks. The PR body lists the Manual steps below and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Moved out of this plan

- **Item 13 — Gemini SDK `retryOptions: { attempts: 2 }`: not implemented, on evidence.** In the installed `@google/genai` 2.12.0, `ApiClient.apiCall` (`node_modules/@google/genai/dist/node/index.mjs:13944-13965`) calls plain `fetch` unless `httpOptions.retryOptions` is set — the SDK does **not** retry by default (`DEFAULT_RETRY_ATTEMPTS = 5` applies only once `retryOptions` exists). Setting it would *enable* retries and, worse, route errors through `p-retry`: a non-retryable response becomes `Error("Non-retryable exception Bad Request sending request")` and an exhausted 429 becomes `Error("Retryable HTTP Error: Too Many Requests")`, bypassing `throwErrorIfNotOK` (line 14107) and discarding the JSON body. `classifyAiError` would then lose `API_KEY_INVALID` (auth → other), `RESOURCE_EXHAUSTED` (rate limit/quota → other) — undoing Phase 0's key copy and Task 4. The premise ("SDK retries 5× by default") does not hold for this version; nothing to change.

## Handoff to 3b

Ops conditions this plan's data makes possible. 3b owns `ops-alerts.ts`/`ops-sweep.ts`; each needs one snapshot field.

| Condition | Snapshot field (suggested query) | Why |
|---|---|---|
| `embedding.unembeddable` (warn) | `embeddingFailures24h`: `SELECT count(*) FROM embedding_failures WHERE failed_at > now() - interval '24 hours'` | A spike means a provider started refusing a content shape, not one odd row (Tasks 12–14). |
| `embedding.backlog` (warn) | `embeddingBacklogUsers`: `SELECT count(DISTINCT user_id) FROM contacts WHERE embedding_stale_at < now() - interval '6 hours'` | Stale flags older than a few backfill passes mean a key-level failure is holding everyone's search back (the A9 signal). |
| `calendar.disarmed` (info) | `calendarDisarmed`: `SELECT count(*) FROM gmail_connections WHERE status = 'active' AND next_sync_at IS NULL AND sync_error IS NOT NULL AND scopes LIKE '%calendar.readonly%'` | Many at once = a Google-side change, not user churn (Tasks 2, 6, 8). |
| `ai.quota_failures` (info) | `aiQuotaFailures24h`: `SELECT count(DISTINCT user_id) FROM usage_events WHERE error_kind = 'quota' AND created_at > now() - interval '24 hours'` | Users stranded by empty balances; the bell already tells each one, this tells Jason (Task 4). |
| `avatar.source_exhausted` (info) | `avatarSourcesExhausted`: `SELECT bucket FROM rate_limit_buckets WHERE bucket LIKE 'avatarSource.shared:%' AND count > 25 AND window_started_at > now() - interval '1 day'` | Daily photo allowance gone before noon means the budget or plan needs raising (Task 18). |
| `apollo.hosted_cap_hits` (info) | `apolloCapHits`: `SELECT count(*) FROM rate_limit_buckets WHERE bucket LIKE 'apollo.%' AND ((bucket LIKE 'apollo.search:%' AND count > 20) OR (bucket LIKE 'apollo.enrich:%' AND count > 50)) AND window_started_at > now() - interval '1 day'` | Hosted enrichment demand vs the Apollo plan (Task 19). |

## Manual steps (not code)

1. **Twilio opt-out (item 15).** Twilio Console → Messaging → Services → the service that owns `TWILIO_FROM_NUMBER` → *Opt-Out Management* → confirm Default/Advanced Opt-Out is **enabled** (STOP, UNSUBSCRIBE, CANCEL, END, QUIT). If the number is not in a Messaging Service, open Phone Numbers → Manage → Active numbers → the number and confirm it sends through one. If opt-out handling cannot be enabled, remove the footer instead: in `src/lib/outreach-send.ts` `appendComplianceFooter`, delete the `sms` branch's `Reply STOP to opt out.` and stop offering hosted SMS until an inbound webhook exists.
2. **Budgets to confirm (items 14a/14b).** `RATE_LIMITS.avatarSourceShared` (25/day), `avatarSourceUser` (5/day), `apolloSearch` (20/day), `apolloEnrich` (50/day), `contactForm` (3 per 10 min) are starting values. If `MICROLINK_API_KEY` is a paid plan, Microlink skips the shared budget automatically; check the Apollo plan's credit allowance (audit B12) and scale `apolloEnrich` to it.
3. **Chat abort on Vercel (item 9).** After deploy, on production: ask a long question in `/chat`, close the tab within two seconds, then in `/admin` (or Neon SQL) check the newest `usage_events` row with `operation = 'chat.answer'` for your user has `error_kind = 'cancelled'`. The Node server behaviour is verified in Next's source; Vercel's function runtime is not.
4. **BYOK Resend keys (Task 22).** Tell BYOK users (Settings copy or docs, a follow-up) that the Resend key must be *Full access*: a *Sending access* key cannot list domains, so Orbit cannot find the verified one and refuses the send.
5. **Eventbrite redirect.** Nothing to change in the Eventbrite app; after deploy, cancel a consent once and confirm the "connection cancelled" toast on `/events`.

## Self-review

**Audit item → task**

| # | Item | Task(s) |
|---|---|---|
| 1 | Refresh must not reset sync state; `ReauthRequiredError` reaches the scheduler | 2 |
| 2 | Connection status truth: actions, cards, `connection.google_calendar` alert | 6, 7, 8 |
| 3 | Eventbrite outcome feedback; cookie consumed on deny | 9 |
| 4 | `interaction_required` / `consent_required` / `login_required` / `invalid_rapt` | 1 |
| 5 | People/profile/Calendar through the retry wrapper; 401 in `fetchGmailHeaders`; scan token valid for its budget | 3, 2 (`minValidityMs`), 5 |
| 6 | `quota` kind and copy | 4 |
| 7 | Recruiter scan aborts on auth/quota/model and 5 straight failures; no watermark advance | 5 |
| 8 | Meeting chunk 422 for key problems; queue terminal | 10 |
| 9 | `request.signal` into `streamText`; usage `cancelled` | 11 |
| 10 | Backfill bisect, unembeddable mark, token cap; chat "keywords only" line | 12, 13, 14, 15 |
| 11 | Per-provider key clear | 16 |
| 12 | Wispr rejected key: error event + Settings notice; nulls not successes | 17 |
| 13 | Gemini `retryOptions` | Moved out (see above) |
| 14 | Avatar source budgets; Apollo daily buckets; contact-form per-IP + shared IP helper | 18, 19, 20 |
| 15 | Twilio STOP | 21 + Manual step 1 |
| — | BYOK Resend sends from the user's verified domain (deferred from Phase 0, A11) | 22 |

**Deliberate deviations from the item text**
- Item 5's "re-mint the token per page" is met by minting once with `minValidityMs = TIME_BUDGET_MS + 60s` (Task 5): the same guarantee — no token expires inside an invocation — with one read instead of one per page.
- Item 12's "null results → `empty_response`": a 401/403 is recorded as `auth` instead, because `OUR_ERROR_KINDS` counts `empty_response` as Orbit's fault and a rejected key is the user's. Every other null is `empty_response`. The "one-time notice" is one notice per rejected key, shown until the key is replaced or cleared, not a toast per capture.
- Item 14b's buckets live in `src/lib/apollo.ts` rather than only in `searchProspects`/`enrichPeopleFromLinkedIn`, so every caller of the hosted key is covered and own keys are never counted.
- Task 22's local part is fixed as `outreach` (the item left it open); the user's first name is the display name, and replies still go to Phase 0's `replyTo`.
- Item 10 needed one schema change (Task 12, `embedding_failures`): meetings have no flag column, so there was nowhere else to put the mark.

**Consistency checks done on this plan**
- Names used across tasks match their definitions: `storeRefreshedGmailToken`/`storeRefreshedOutlookToken` (2), `googleFetchWithRetry` (3), `isQuotaExhaustion` + `"quota"` (4, used in 5/10/14), `ScanDeps`/`SCAN_KEY_PROBLEM_COPY`/`SCAN_CONSECUTIVE_FAILURES_COPY`/`MAX_CONSECUTIVE_SENDER_FAILURES` (5), `deriveConnectionHealth`/`connectionSummary`/`SESSION_EXPIRED_LINE`/`CALENDAR_PAUSED_SHORT`/`calendarPauseLine` (6, used in 7/8), `readOAuthReturn` (9), `chunkFailureResponse` (10), `withUsage(…, { cancelSignal })` (11), `embeddingFailures` (12, used in 14), `planEmbeddingBatches`/`embedWithBisect` (13, used in 14), `embeddingFailureNotice`/`KEYWORD_ONLY_SEARCH_NOTICE` (15), `clearApiKey` → `{ ok, embeddingReset }` (16), `transcribeWithWisprOutcome`/`recordWisprKeyRejected`/`wisprKeyWasRejected` (17), `claimAvatarSourceLookup` (18), `APOLLO_DAILY_LIMIT_MESSAGE` (19), `clientIpFrom`/`submitContactMessageCore` (20), `isTwilioOptOut`/`SMS_OPTED_OUT_MESSAGE` (21), `outreachFromAddress`/`NO_VERIFIED_DOMAIN_MESSAGE`/`listResendDomainsWithSdk` (22). Task 23 is verification only.
- Every new smoke script is registered in `MANIFEST` in the task that creates it: pure — `smoke-oauth-refresh-rejection`, `smoke-google-fetch`, `smoke-connection-status`, `smoke-oauth-return`, `smoke-meeting-chunk-errors`, `smoke-embedding-batches`, `smoke-chat-search-notice`, `smoke-twilio-opt-out`, `smoke-outreach-sender`; pglite — `smoke-token-refresh`, `smoke-gmail-scan-abort`, `smoke-clear-api-key`, `smoke-wispr-key-rejection`, `smoke-avatar-source-budget`, `smoke-apollo-hosted-budget`, `smoke-contact-form-limit`.
- No task edits `ops-alerts.ts`, `ops-sweep.ts`, `.github/workflows/ops.yml` or reconcile code; Task 12 touches only the `DDL` template and `SCHEMA_VERSION` in `src/db/index.ts`, with the version computed at execution time.
- No new dependency. No client component imports a module that reaches `@/db`: `connection-status.ts`, `oauth-return.ts`, `chat-search-notice.ts`, `client-ip.ts`, `twilio-errors.ts`, `google-fetch.ts`, `embedding-batches.ts` and `outreach-sender.ts` import nothing from the database.

**Not verifiable from code (checked at execution or by Jason)**
- Twilio's default opt-out behaviour and error code 21610 are from Twilio's documented behaviour, not this repo — Manual step 1 confirms the setting.
- Gemini's `embedContent` per-request item limit is not pinned anywhere in the repo; if it is below 200, `embedWithBisect` recovers (the first 200-item call fails as `other` and is halved), at the cost of one wasted call per pass — watch `usage_events` after Task 14.
- Task 22: a Resend key restricted to sending access cannot call `domains.list()`, so it gets the no-verified-domain message even when the account has one. Resend's API is not callable from here to confirm the restricted-key error shape; the smoke covers the behaviour with an injected error.
- `request.signal` aborting on client disconnect is verified in Next 16.2.10's Node adapter; Vercel's runtime is Manual step 3.
- Line numbers are from `33a213c`; Phases 0–2 move them, so every edit names its anchor text.
