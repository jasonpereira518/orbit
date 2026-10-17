# Orbit code health audit

**Audited:** `eb5d69d` (main, 2026-10-16) · **Scope:** `src/`, `scripts/`, `e2e/`, root config, `.github/`, `docs/`, `extension/` (lightly) · **Mode:** read-only. Nothing in the app was changed.

The companion [CODE_HEALTH_PLAN.md](CODE_HEALTH_PLAN.md) orders the fixes and has drafts of the missing docs.

---

## How this was measured

| Check | Result |
|---|---|
| `npm ci` | **Fails on Node 22 / npm 10** ("Missing: utf-8-validate@5.0.10 from lock file"). It passes on Node 24 / npm 11, which `.nvmrc` and `engines` pin. |
| `npm run typecheck` | Pass (69 s) |
| `npm run lint` | 0 errors, 49 warnings: `set-state-in-effect` 32, `refs` 11, `exhaustive-deps` 4, `no-img-element` 1, one unused directive |
| Typed lint (scratch config, not committed) | 17 floating promises, 9 misused promises, 23 non-exhaustive switches, 1 `await` of a non-promise, 359 removable casts |
| madge `--circular` | 126 cycles reported. 121 go through an `import type`; **5 are real value-import cycles** |
| knip (custom config, every hit checked with `git grep -w`) | 7 dead files, 54 dead value exports, 1 unused dependency, 1 undeclared runtime dependency |
| `npm audit` | 38 advisories (22 high, 16 moderate). **None reaches the shipped bundle** (§D2) |
| `npm outdated` | Almost every dependency is behind the newest version its own range allows. 5 majors pending |
| TS compiler API scan | 275 functions are 150 lines or longer; the longest is 1,631 lines |
| Env scan | ~101 variables read by `src/` and root configs, ~60 more by scripts, e2e and the extension. 225 `process.env` reads in 75 `src/` files |

**Caveats.** The clone is shallow (history starts 2026-09-09), so file ages and churn are lower bounds. Vercel, Neon, Clerk, Stripe and GitHub dashboard settings can't be seen from the repo; findings that depend on them are marked **(unverified)**.

### Size

| Area | Files | Lines |
|---|---:|---:|
| `src/lib` (539 flat files + 292 in 29 subfolders) | 831 | 182.8k |
| `src/components` | 588 | 125.1k |
| `src/app` (85 `route.ts`) | 252 | 23.3k |
| `src/actions` (all `"use server"`) | 66 | 18.5k |
| `src/db` (`schema.ts`, `index.ts`) | 2 | 11.6k |
| `scripts/` (542 smoke tests) | 612 | 132.6k |
| `extension/` (separate Vite project) | 42 | 5.9k |

One maintainer authored about 93% of commits, and AI agents work in parallel branches. That makes **mechanical enforcement** (lint, CI gates, generated code) worth more here than conventions written in comments, because nobody reads every diff.

---

## What is already in good shape

These are strengths to keep, and they set the scope of the fixes below:

- **Type hygiene is excellent.** There is 1 `any` in `src/` (`src/lib/imports/google-picker.ts:36`), no `@ts-ignore` or `@ts-expect-error`, no `console.log`, `strict` is on, and every file name is kebab-case.
- **The external API boundaries are validated.** REST v1 (`lib/api/http.ts` `apiHandler` + zod), the extension API (`lib/extension/http.ts` `extensionRoute`), MCP tools (zod) and webhooks (Stripe, Clerk and Resend signatures) all check their input.
- **Tenancy is tested mechanically.** `scripts/smoke-action-user-scope.ts` checks that no action takes a caller-supplied user id, and lib write functions take `userId` explicitly.
- **Error reporting goes through one layer.** `report-error.ts`, `errors.ts` and `action-failure.ts` handle it; Sentry is called from 3 places only, and no raw error message reaches a client.
- **No client bundle reaches the database or a server SDK.** An import-graph search from all 532 `"use client"` files along value edges never reaches `db/`, `node:*`, Stripe, Resend, Twilio or Drizzle. This holds by discipline; nothing enforces it (§B3).
- **AI SDK imports are confined** to `lib/ai*.ts` and checked by `smoke-ai-access.ts`. One tool registry (`lib/tools/`) serves both chat and MCP.
- **Deploys are gated on env and schema checks.** `check:env && db:migrate && next build` fails on a missing production variable or a failed DDL statement. `schema-ddl.lock.json` plus `smoke-schema-ddl.ts` catch DDL changes made without a version bump.
- **Operations are documented.** `docs/RUNBOOK.md` is thorough: alerts, kill switches, restore, and secret rotation.

---

## Findings ranked by maintenance risk

Risk is roughly **how likely the problem bites × how much it breaks × how hard it is to notice**. Each finding lists evidence (file:line) and points to the plan step that fixes it.

| # | Finding | Risk | Plan |
|---|---|---|---|
| A1 | The deploy pipeline isn't gated, and the migration writes to prod before the build | **High** | P0.1, P10 |
| A2 | Schema columns are hand-maintained in four places | **High** | P9 |
| A3 | 474 server actions are public endpoints, and their inputs aren't checked at runtime | **High** | P1.2, P5 |
| A4 | The test suite can't protect refactors | **High** | P0.3–P0.5 |
| A5 | Some failures never reach Sentry, and silent fallbacks look like intended ones | **High** | P2 |
| A6 | Copied identity normalizers have drifted (duplicate-contact risk) | **High** | P4.3 |
| B1 | The toolchain is fragile and dependencies are drifting | **Medium-high** | P0.2, P11 |
| B2 | Configuration is read ad hoc, with validation gaps and stale docs | **Medium-high** | P10 |
| B3 | Nothing enforces the client/server and layer boundaries | **Medium-high** | P3.3, P6 |
| B4 | Server actions are used as library code, and whole domains live in action files | **Medium** | P6 |
| B5 | Oversized files and functions | **Medium** | P8 |
| B6 | `src/lib` is a flat folder of 539 files, with misleading names | **Medium** | P7 |
| B7 | Duplicated utilities | **Medium** | P4 |
| B8 | Conventions are inconsistent and warn-only lint is drifting | **Medium** | P3 |
| B9 | Stale flags, two of which are open security items | **Medium** | P1.5, decisions |
| C1 | Documentation gaps and stale statements | **Medium** (onboarding) | P0.6 |
| D1 | Dead code, files, scripts and docs | **Low** | P1 |
| D2 | Advisories: 38, none shipped | **Low** | P11 |
| D3 | Circular dependencies: mostly type-only noise | **Low** | P6.4 |

---

### A1. The deploy pipeline isn't gated, and the migration writes to prod before the build (High)

- **CI doesn't block a deploy.** `ci.yml:22-26` says `main` has no required status checks. Vercel's Git integration builds every push to `main` at the same time CI runs, so a red CI still ships. RUNBOOK's "CI must be green" describes what's intended, not what's enforced. (Branch protection and the Vercel check settings are **unverified**.)
- **`db:migrate` runs before `next build`, and it writes data.** `vercel.json` sets the build command to `check:env && db:migrate && next build`. `scripts/migrate.ts` reconciles the schema to `SCHEMA_VERSION`, then runs a bounded `contact_identities` backfill and `mergeConfidentDuplicates`. If `next build` then fails, production stays on the old code against a new schema whose backfills have already run.
- **Rollback is less safe than RUNBOOK says.** RUNBOOK → Roll back calls schema changes "additive", but the sweep drops a table (`DROP TABLE IF EXISTS guest_profiles`, v170) and several columns (`src/db/index.ts:4604,4714,4720,2841,2875`). Promoting an old enough deployment breaks queries on those tables.
  - Vercel also freezes env values per deployment, so a rollback restores any secret rotated since that deployment.
- **Previews run the same migration.** The only guard that stops a preview migrating production is `PRODUCTION_DB_HOST` (`src/lib/env.ts:311`), which only warns when unset. Whether it is set is **unverified**.
- **Preview background jobs call production.** `internalFetch` → `getAppBaseUrl()` (`src/lib/app-url.ts:14`) falls back to `VERCEL_PROJECT_PRODUCTION_URL`, so import, capture and sync continuations started on a preview are sent to the production domain.
- **The scheduler is GitHub Actions.** `vercel.json` has no crons. `ops.yml` (10 schedules, ~14 internal routes) is the only scheduler, and GitHub disables schedules on public repos after 60 days without a commit. RUNBOOK covers this, and the Better Stack heartbeat detects it.
- **Backups have never been restored.** Backups moved to a private repo (`77d28a7`). RUNBOOK's restore drill log reads "not yet run". `ci.yml` still lists the removed `backup.yml` in `paths-ignore`.

### A2. Schema columns are hand-maintained in four places (High)

- **The real migrator is hand-written SQL.** There is no `drizzle/` folder; the migrator is the SQL in `src/db/index.ts` (5,285 lines). A new column goes into:
  1. `schema.ts`
  2. the `DDL` template (`index.ts:41-2000`)
  3. the Neon `alters` list (`:4083-4738`)
  4. the PGlite `ensureColumn` calls (`:3488-3920`, 163 calls)

  Then the author bumps `SCHEMA_VERSION` (170, `:2723`), adds a changelog comment and updates `scripts/schema-ddl.lock.json`.
- **`index.ts` is mostly strings and comments.** About 720 of its lines are a version changelog, and another 2,400 are DDL strings.
- **What's already guarded.** `smoke-schema-ddl.ts` checks that every `schema.ts` column is created somewhere, and that the fingerprint changed only with a version bump. The lock file makes parallel version bumps collide in git. That fixed the silent `SCHEMA_VERSION` merges that the changelog records (`index.ts:2160-2175`).
- **What's still unguarded:**
  - A column added to `alters` but not to `ensureColumn`, or the reverse, so PGlite and Neon drift apart.
  - Hand-written type changes that don't match `schema.ts`.
  - Columns managed only outside `schema.ts`: `embedding_vector`, the HNSW index, `search_tsv` and `linkedin_slug`.
- **Tenancy is enforced by convention only (inferred).** 86 tables carry `user_id text` with no FK and no `users` table, and no row-level security was observed. Account deletion depends on a hand-kept table list in `lib/user-data.ts` (1,073 lines), so a new table the author forgets to add survives deletion. `connectors/registry.ts:11-17` admits this list is still hand-kept. The smokes mitigate the risk but don't remove it.
- **`schema.ts` imports lib types.** It imports JSONB column types from seven lib modules (`schema.ts:15-111`), including `CaptureParseHints` from `lib/ai` (`:110`). That is the root of 80 of the 126 madge cycles.

### A3. 474 server actions are public endpoints, and their inputs aren't checked at runtime (High)

Every exported function in a `"use server"` file can be called with any JSON by anyone signed in.

- **Few actions check their arguments.** 200 of the 474 actions take object or array arguments. **1 of 66 action files uses zod** (`actions/calendar-prep.ts`), and about 38 object-taking actions have no guard in their own body.
- **Internal write flags are reachable from the browser.** `createContact` and `updateContact` (`src/actions/contacts.ts:685,743`) accept `ContactWriteOptions`, so a browser can set `skipEmbedding`, `skipCloseness`, `skipRevalidate` and `mergeFactLists` (defined at `lib/contact-writes.ts:62-83`).
- **Dead endpoints are still exposed.** `createContactsBulk` (`contacts.ts:730`) takes a function argument and has no callers. `askNetwork` (`actions/chat.ts:362`) copies the `/api/chat` flow and is used only for its type (`chat-panel.tsx:125`, `floating-ask-bar.tsx:74`). Eight more actions have no callers (§D1).
- **Other unvalidated inputs:**
  - `actions/chat-imports.ts:60` (`rows: unknown[]`), `meetings.ts:66`, `capture-jobs.ts:319`, and `opportunities.ts:186`, which takes a whole `ContactOpportunity` object from the client.
  - The token-authenticated phone route `api/scan/[token]/pages/route.ts:49` trusts the array elements, so a malformed one causes a 500.
- **External data is trusted through casts:**
  - 46 `(await res.json()) as T` casts on third-party responses (Gmail, Graph, Apollo, connectors).
  - `parseAiJson<T>` (`lib/ai.ts:494`) is an unchecked cast, and about 14 of its 24 call sites don't validate afterwards.

### A4. The test suite can't protect refactors (High)

- **There is no test framework.** `scripts/run-smoke.ts` (754 lines) runs **542 smoke scripts** (~117k lines) one after another, each as a separate `tsx` process, and judges each by its exit code. 524 of them define their own `check()` or `assert`.
  - That means no shared assertions, no isolation, no watch mode, no coverage and no parallelism inside a shard. CI splits the run into 3 shards to stay under about 10 minutes.
- **About 73 smokes read source files by path** (`readFileSync("src/lib/ai.ts")`) and match regexes against them.
  - Every file move in plan steps P6–P8 breaks them.
  - They also keep dead code alive: `actions/apple.ts`, `lib/route-progress.ts` and `outreach-readiness-server.ts` survive only because a smoke reads them.
  - About 42 of them are lint rules in disguise.
- **The riskiest server code has no unit seams.** The functions most worth refactoring can only be tested end to end:
  - `runImportJob`, 905 lines (`lib/import-engine.ts:500`)
  - `prepareChatContext`, 545 (`lib/chat-context.ts:712`)
  - `decideStripeEvent`, 526 (`lib/billing-stripe.ts:572`)
  - `evaluateOpsConditions`, 491 (`lib/ops-alerts.ts:219`)
  - `saveNoteBatch`, 486 (`lib/note-batch-save.ts:184`)
  - `getDashboardData`, 483 (`lib/reminders.ts:882`)
- **E2E coverage is thin.** There are 7 Playwright specs (onboarding, capture, contact profile, delete data, upgrade, tour, plan colours). **None covers chat, the graph, imports or reminders**, which are the components marked for splitting in P8.

### A5. Some failures never reach Sentry, and silent fallbacks look like intended ones (High)

These sites call `console.error` with no `reportError`. Vercel keeps those logs for about an hour (per the `report-error.ts` header).

- **Every Stripe subscription failure:** lookup, update, plan switch and lifetime cancel (`src/lib/subscription-management.ts:146,181,244,276,302`).
- **Every extension 500** (`src/lib/extension/http.ts:247`).
- **Account deletion failing to cancel the subscription or delete the login** (`src/lib/account-deletion.ts:81,93`).
- Also the Clerk webhook (`api/webhooks/clerk/route.ts:53`), `billing-stripe.ts:295`, `billing-portal.ts`, `site-invites.ts`, `interest-list-*.ts`, and `db/index.ts` (7 sites): **35 files in total**.

Separately, there are about **367 `catch` blocks in `src/lib` that return a default** (`null`, `[]`, `0`) without reporting. Most are deliberate best-effort paths, but nothing tells deliberate apart from forgotten.

- Example: `lib/account-health.ts:431,470,504` returns `0`, so an admin health metric reads as zero when its query fails.
- Six empty catches have no comment at all, e.g. `components/theme-provider.tsx:45`.

### A6. Copied identity normalizers have drifted (High: duplicate-contact risk)

These helpers feed duplicate detection and matching, so disagreements between copies quietly create duplicates or missed matches.

- **`isLinkedInProfileUrl` exists twice and the copies disagree.** The private copy at `src/actions/contacts.ts:1236` requires the host to be exactly `linkedin.com`, so it **rejects `uk.linkedin.com`**. The lib copy at `src/lib/contact-input.ts:66` accepts regional subdomains on purpose, because real Connections.csv exports contain them.
- **`normalizeEmail` exists three times with different semantics:**
  - `lib/email-activity.ts:80` returns null unless the value contains `@`.
  - `lib/recruiters.ts:34` has no `@` check.
  - `lib/contact-avatar-connectors.ts:29` never returns null.
- **Seven LinkedIn URL helpers implement one concept:** `duplicates.ts:83`, `recruiters.ts:56`, `linkedin-paste.ts:75`, `outreach-channels.ts:23`, `events/platforms/next-data.ts:152`, `contact-input.ts:66`, and a SQL version at `db/index.ts:2742`.
- **Normalization is also inlined 248 times** as `.trim().toLowerCase()`.
- **`isDemoProspect` has two definitions that check different things** (`lib/outreach-channels.ts:56` vs `lib/outreach-quality.ts:4`). This matters because sending to demo prospects was a launch blocker in the 09-15 audit.

### B1. The toolchain is fragile and dependencies are drifting (Medium-high)

- **The npm version isn't pinned.** `npm ci` works only with npm 11, and there is no `packageManager` field or `engines.npm`. A contributor on Node 22 hits a confusing lockfile error.
- **`@types/node` is `^20`, but the runtime is Node 24**, so Node 22/24 APIs are untyped.
- **`sharp` is used in production but not declared.** Three files import it dynamically (`lib/avatar-encode.ts:24`, `capture-photos.ts:70`, `org-brand-learn.ts:81`). It resolves only because Next ships it as an optional dependency.
- **The lockfile is drifting:**
  - next 16.3.8 (in-range latest 16.4.2), Clerk 7.5 (7.9), lucide 1.24 (1.58).
  - Grouped Dependabot PRs #403, #408 and #417 were closed without merging; #433 (34 updates) is open.
  - Each week the batch grows and gets harder to merge.
- **Major upgrades pending:**

  | Package | From → to | Risk |
  |---|---|---|
  | `stripe` | 22 → 23 | **High.** `apiVersion` is deliberately unpinned (`src/lib/stripe.ts:27`), so the SDK bump silently changes the API version on every call. The webhook payload version is pinned separately in the dashboard. |
  | `motion` | 12 → 14 | 86 files import it |
  | `openai` | 6 → 7 | AI call layer |
  | `@anthropic-ai/sdk` | 0.112 → 0.135 | Pre-1.0, so each minor can break; 23 minors to cross |
  | `@sentry/nextjs` | 10 → 11 | Small API surface |

- **Packages with weak justification:**
  - `@samasante/liquid-glass@0.1.1` has a single maintainer. Its two versions were published 80 minutes apart in June, with nothing since. It is pinned exactly and used in one file (`layout/nav-lens.tsx`).
  - `three` (26 MB) serves only the landing-page globe.
  - `twilio` serves only the gated Outreach feature.
- **The extension and the app use different `lucide-react` majors** (`^0.563` vs `1.x`).

### B2. Configuration is read ad hoc, with validation gaps and stale docs (Medium-high)

- **There is no typed accessor.** 225 `process.env` reads are spread across 75 `src/` files. `src/lib/env.ts` only validates; it returns nothing typed.
- **Variables production needs that the build doesn't check:**
  - `GOOGLE_REDIRECT_URI` and `MICROSOFT_REDIRECT_URI` only warn when missing, then throw when a user connects (`lib/gmail.ts:84`, `lib/outlook.ts:70`). `.env.example` ships them uncommented with localhost values.
  - The Sentry upload variables (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`): stack traces go unreadable with no warning.
  - `EXTENSION_ORIGIN` and `CONTACT_INBOX_EMAIL`.
  - The managed-AI key warning fires only when `STRIPE_SECRET_KEY` is set.
  - Nothing checks that Vercel's `CRON_SECRET` and `APP_BASE_URL` match the GitHub secrets.
- **Preview builds get no shape checks.** `validateEnv` applies the format rules only when `VERCEL_ENV=production`. A preview can therefore run live Stripe, live Clerk or the placeholder `ENCRYPTION_SECRET`.
- **Some secrets are never shape-checked anywhere:**
  - webhook secrets (`whsec_`) and `RESEND_API_KEY` (`re_`);
  - `HEALTH_TOKEN`, which has no minimum length and travels in `?token=`;
  - `ADMIN_USER_IDS`, which has no `user_` check, so a typo silently means no admins.
- **Two defaults are dangerous:**
  - A never-set `site_settings.managed_ai_paused` reads as **paused** in production, so a fresh or restored database silently turns off included AI.
  - `GEMINI_API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` count as Orbit-paid managed keys whenever `VERCEL` is unset (`lib/ai-access.ts:273`). That covers `next start` and tsx scripts too, not only `next dev` as `.env.example` says.
  - Separately, `scripts/migrate.ts:19` and every backfill load `.env.local` with no remote-host fence.
- **Stale or contradictory docs:**
  - `.env.example:45-50` says managed AI is off in code, but `managed-ai-policy.ts:35` has `MANAGED_AI_ENABLED = true`.
  - `.env.example:30-42` still lists the four `STRIPE_*_PRICE_ID` variables as needed; pricing v2 ignores them.
  - `.env.example` and `internal-auth.ts` mention Vercel Cron, which isn't used.
  - `DEVELOPMENT.md` says "on Vercel every user brings a key".
  - RUNBOOK calls schema changes additive.
- **Variables missing from `.env.example`:** `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET`, `ORBIT_BENCH`, `SMOKE_ALLOW_REMOTE`, `OPENROUTER_API_KEY`. `smoke-env-documented.ts` only sees literal `process.env.X` reads in `src/`, so it misses dynamic reads, root configs and scripts.

### B3. Nothing enforces the client/server and layer boundaries (Medium-high)

- **`server-only` isn't used anywhere**; the string appears only in comments. It can't simply be added, because its default export throws under plain Node, which would break the 285 smoke scripts that run under tsx (`lib/stripe.ts:13` explains this).
- **There is no import-boundary lint rule.** 250 lib files that use the database sit in the same flat folder as 37 `"use client"` lib files.
- **Lib depends on components and on Next request APIs:**
  - `lib/account-alerts.ts` → `components/settings/sections.ts`
  - `lib/surfaces.ts` → `components/settings/sections.ts`
  - `lib/surface-visibility.ts` → `components/layout/app-nav.ts`
  - `lib/toast.tsx` → `components/ui/expandable-text.tsx`
  - 4 lib files import `next/cache` and 2 import `next/headers`.

### B4. Server actions are used as library code, and whole domains live in action files (Medium)

- **Lib code calls actions:**
  - `lib/chat-context.ts:63` calls the action `loadRecruitersForChat` (`actions/recruiters.ts:302`). That action reads the signed-in Clerk session rather than the `userId` it was handed, so `prepareChatContext(userId, …)` silently depends on ambient auth.
  - 13 action-to-action and 19 lib-to-action value imports. `actions/outreach.ts:14` calls the `createContact` and `logInteraction` actions instead of `lib/contact-writes`.
- **Route handlers import actions:** `api/contacts/avatar-backfill`, the Gmail, Outlook and Eventbrite callbacks, and `api/meetings/candidates`.
- **Whole domains live in action files.** `actions/outreach.ts` (1,601 lines, 32 direct DB calls) holds the entire outreach domain: campaign CRUD, sequencing and sending. MCP, v1 and cron can't reuse any of it. Smaller versions: `actions/contacts.ts` (19 DB ops), `actions/reminders.ts` (17), `actions/admin-yc.ts` (12), `actions/settings.ts` (10).
- **Logic is duplicated across paths:**
  - Four or more contact-search implementations with different ranking. `api/extension/contacts/route.ts:30-75` has its own `ilike` search, while `lib/hybrid-search.ts`, `lib/keyword-search.ts`, `contacts.ts:128` `searchContactsForPicker` and `lib/inbox-search.ts` each rank differently.
  - Three HTTP wrapper stacks: `lib/api/http.ts`, `lib/extension/http.ts`, and ad hoc routes. 13 routes hand-write the rate-limit-to-429 handling.
  - 18 route handlers and 3 pages query the database directly.
- **Integration code exists in two generations.** Legacy `lib/gmail.ts`, `outlook.ts`, `apple.ts` and `calendar-sync.ts` sit beside `lib/connectors/*`, and `sync-scheduler.ts` dispatches both.

### B5. Oversized files and functions (Medium)

| File | Lines | Note |
|---|---:|---|
| `src/db/schema.ts` | 6,318 | 119 tables, 42% comments; changed in 52 commits since the shallow start, the most-changed file |
| `src/db/index.ts` | 5,285 | DDL strings, changelog, migrator, client (§A2) |
| `src/lib/ai.ts` | 2,909 | Transport, parsing, transcription, embeddings, chat, web search |
| `src/components/chat/chat-panel.tsx` | 2,410 | `ChatPanel` is 1,631 lines with 37 `useState` |
| `src/components/graph/graph-canvas-flow.tsx` | 2,261 | `GraphCanvasInner` 1,518 |
| `src/actions/contacts.ts` / `imports.ts` | 2,062 / 1,981 | 33 and 27 actions |
| `src/components/chat/bulk-notes-panel.tsx` | 1,761 | `BulkNotesPanel` 1,276, 26 `useState` |
| `src/lib/reminders.ts` | 1,697 | Mixes reminders, outreach suggestions and the **dashboard read model** (`getDashboardData`) |

There are 35 files over 1,000 lines and 275 functions over 150 lines. The change hotspots overlap with these files: `schema.ts`, `db/index.ts`, `user-data.ts`, `ai.ts`, `actions/contacts.ts`, `rate-limit.ts` and `chat-panel.tsx` each changed in 30–52 commits within the shallow window. Size and churn together are where merge conflicts and regressions concentrate.

### B6. `src/lib` is a flat folder of 539 files, with misleading names (Medium)

- **The prefix clusters show the hidden domains:** `chat-` 38, `contact-` 21, `admin-` 21, `ai-` 16, `use-` 13 (React hooks in lib), `meeting-` 13, `linkedin-` 13, `outreach-` 12, `import-` 11, `capture-` 10.
- **Several domains are half-migrated**, with both a folder and flat siblings: `capture/` + 10 flat files, `imports/` + `import-adapters/` + 11 flat files, `email/`, `plans/` (1 file) + 5 flat `plan-*` files, and `connectors/` beside legacy providers.
- **Misleading names:**
  - `lib/background-jobs.ts` is a browser widget store, while `lib/jobs/` holds *job postings*. Neither is the server job system.
  - `generateDueFollowUps` exists in both `lib/reminders.ts:404` and `actions/outreach.ts:1115`, with different meanings.
  - "event" means both an interaction (`NetworkEvent`) and a conference (`events` table); see `schema.ts:5414`.

### B7. Duplicated utilities (Medium)

| Cluster | Copies | Proposed home |
|---|---|---|
| `sleep` + jittered backoff (byte-identical) | `apollo.ts:26`, `eventbrite.ts:36`, `luma.ts:34`, `guarded-fetch.ts:148`; plus near-identical `graph-fetch.ts` / `google-fetch.ts` retry loops | `lib/http/retry.ts` |
| `withTimeout` | 9 | `lib/async.ts` (with `settle`, which exists in `lib/settled.ts` but is redefined 3×) |
| Admin row coercion `num` / `toDate` | 10 / 9; `admin-trends.ts:150` drifted (no NaN guard) | the existing exports in `lib/admin-metrics.ts` |
| Keyset cursors | 5 formats; `escapeLike` ×3 | `lib/cursor.ts` |
| `timingSafeEqual` + length guard; `sha256` | 9 sites; 34 inline `createHash` | `lib/crypto.ts` (`safeEqual`, `sha256Hex`, `signToken`) |
| Signed unsubscribe tokens | byte-identical in `credits/notices.ts:45-66`, `radar/digest.ts:121-142`; 3 unsubscribe routes repeat `page()` and `tokenOf()` | `lib/crypto.ts` + shared route helper |
| OAuth refresh, scope checks, `classifyOAuthFailure` | 3 each | `lib/connectors/oauth.ts` |
| Client external-store boilerplate | 7 stores; `subscribe` ×23; `readDismissed` ×4 although `createDismissStore` exists | `lib/create-external-store.ts` |
| Relative time | 2 components (`ui/relative-time.tsx` dead, `admin/relative-time.tsx`) + 5 helpers + 19 hand-built `"Nd ago"` strings; `addDays`, `startOfDay`, `daysBetween` ×3 each, although `date-fns` is installed | one `<RelativeTime>` + `lib/dates.ts` |
| Small format helpers | `plural` ×14 (5 signatures), `clamp` ×5, `isUuid` ×4 + 20 UUID regex literals, HTML tag strip ×8 | `lib/format.ts`, `lib/ids.ts`, `lib/html-text.ts` |
| Route rate-limit → 429 | 13 routes | `lib/route-http.ts` |

Already consolidated, and worth leaving alone: the AI provider clients, LLM JSON repair (`parseAiJson` exists once), rate limiting (`consumeBucket`), CSV parsing (papaparse everywhere), and the auth gates.

### B8. Conventions are inconsistent and warn-only lint is drifting (Medium)

- **Action results come in 7 incompatible shapes,** although `ActionResult<T>` exists in `lib/errors.ts:361` (used by 17 of 66 files). Alongside the canonical shape there are 64 one-off `…Result` types:

  | Failure shape | Example |
  |---|---|
  | `{ ok:false, error }` (canonical) | 26 files |
  | `{ ok:false, message }` | `radar.ts:82` |
  | `{ ok:false, reason }` | `chat-actions.ts:32` |
  | `{ ok:false, reason, message }` | `chat-send.ts:54` |
  | `{ ok:boolean, error? }` | `events.ts:235` |
  | `{ url } \| { error }` (no `ok`) | `billing.ts:43` |
  | `{ kind:"error" }` | `admin.ts:1085` |

- **Verb drift.** Exported functions start with `get` 175 times, `list` 84, `load` 78, `find` 35, `fetch` 34 and `read` 31, with different verbs for the same operation. For example, `actions/imports.ts:554 getImportPeople` wraps `listImportPeople`.
- **The `…Action` suffix is applied unevenly.** 19% of actions have it, 8 files mix both styles, and 7 unsuffixed actions shadow a lib function of the same name.
- **Warn-only rules creep up.** `set-state-in-effect` was baselined at 25 in `eslint.config.mjs` (2026-09-02) and is now 32. A warning that nothing counts only ever grows.
- **There is no formatter.** Prettier, `.editorconfig` and a format check in CI are all absent. Code is consistent by habit (double quotes, semicolons, 2-space indent), but 7,471 lines exceed 100 columns. Prettier at width 100 would rewrite 6.4% of lines in about 80% of files.
- **Route paths are string literals.** `revalidatePath` is called 342 times with literal paths.
- **Boolean DB columns are stored two ways:** 21 `boolean()` columns against about 12 integer 0/1 flags (e.g. `schema.ts:1132 isInbox: integer`).

### B9. Stale flags, two of which are open security items (Medium)

| Flag | State | Issue |
|---|---|---|
| `CSP_ENFORCE` | report-only since at least 09-09 | Its own comment says to enforce after a quiet week. Whether it is set in Vercel is **unverified** |
| `MCP_OAUTH_REQUIRE_SCOPES` | unset by default | A scope-less MCP OAuth token gets read and write (`lib/mcp/oauth.ts:69`). Open item from the 09-26 security audit. **Unverified** |
| `MANAGED_AI_ENABLED` | hard-coded `true` (`managed-ai-policy.ts:35`) | Its `false` branches are dead code, and the docs still say it is off |
| `RADAR_RERANK_ENABLED` | hard-coded `true` | Waits on analytics for a surface that is still coming soon |
| 9 `comingSoon` surfaces (`lib/surfaces.ts`) | Radar, Events, Find, Outreach, compose, Outlook send, reply inbox, chat imports, cloud notes | Gated code keeps growing. Events is still "coming soon" while most recent commits are events work |
| `EXTENSION_PUBLISHED` (from `NEXT_PUBLIC_EXTENSION_URL`) | false | The extension is at 1.1.0 |
| `APOLLO_API_KEY` | read, but `hostedEnrichment` is false on every plan | Dead config |
| `SITE_STEALTH` | env default | Overridden by the database switch once an admin sets it |

The `ORBIT_*=off` kill switches are legitimate and documented. Keep them.

### C1. Documentation gaps and stale statements (Medium, for onboarding)

| Doc | State |
|---|---|
| `README.md` | Product and marketing only. No setup, no stack, no links to developer docs |
| `docs/DEVELOPMENT.md` | Good quick start and local modes. Has stale lines: "every Vercel user brings a key", and `db:generate` "under `drizzle/`" (the folder doesn't exist) |
| Architecture overview + diagram | **Missing** |
| Data model | **Missing.** `schema.ts` comments are the only source (119 tables) |
| `docs/ENVIRONMENT.md` | **Missing.** `.env.example` (364 lines) is the only reference, and parts of it are stale (§B2) |
| `docs/DEPLOYMENT.md` | **Missing.** Pieces are spread across RUNBOOK, `vercel.json`, `ops.yml` and comments |
| API reference | Partial: `/api/v1/openapi.json` is served, but nothing in `docs/` links to it. MCP tools are documented only in code |
| Decision records | **Missing.** Many non-obvious choices are explained only in code comments: the hand-rolled DDL, GitHub Actions as the cron, `after()` self-continuation, `runAtomicWrite` (Neon HTTP has no transactions), no FK tenancy, smokes instead of a test framework, unpinned Stripe `apiVersion`, `proxy.ts`, backups in a private repo |
| Contributing / conventions | **Missing.** No "where does new code go", action rules, or schema-change checklist outside the comment above `SCHEMA_VERSION` |
| `docs/RUNBOOK.md` | Good. Needs rollback caveats (§A1) and a first restore drill |

The dead weight in `docs/` makes finding the current docs harder (§D1).

### D1. Dead code, files, scripts and docs (Low)

None of the "needs your call" items from the 2026-10-09 cleanup has been resolved, and the count of dead exports grew from about 34 to 54.

- **Dead files (7):**
  - `src/actions/apple.ts`: no UI can connect iCloud, but `lib/apple.ts` is still read by the sync path.
  - `src/actions/openrouter.ts`: the connect flow can't be started, yet `/api/openrouter/callback` is still a live route.
  - `components/imports/import-revert-button.tsx`, together with its now-orphaned `revertImportAction`.
  - `components/layout/route-progress.tsx`, with `lib/route-progress.ts`.
  - `components/ui/relative-time.tsx`.
  - `lib/outreach-readiness-server.ts` and `components/outreach/outreach-readiness-strip.tsx` (gated).
- **Dead value exports: 54.** Of those, 8 are server actions, which means live public endpoints:
  - `saveMeetingDetails`, `renameReminderList`, `setSpokeTo`, `listAgentDrafts`, `getSendCapabilityAction`, `previewEditDiscard`, `addManualInterestListSignupAction`, `revertImportAction`.
  - Plus `createContactsBulk` and `askNetwork` from §A3.
- **Dependencies:**
  - `linkedom` (dev) is imported nowhere; `src/lib/events/parse-page.ts:14` says so itself.
  - `drizzle-kit` is vestigial: there is no `drizzle/` folder, and `db:generate` and `db:push:DANGEROUS` are unused. It accounts for 4 advisories and is the file that breaks knip.
- **Scripts:**
  - Superseded or spent: `migrate-provider-and-upgrade-events.ts` (breaks the archive README's rule), `report-pricing-v2-accounts.ts`, `reprice-usage.ts`.
  - Four backfills look spent.
  - The 11 `scripts/archive/migrations` are still type-checked.
  - Nothing records whether a backfill has run. `backfill-encrypt-ics-urls` (10-13) matters most: secret calendar URLs stay in plaintext until it runs in production.
- **Docs:**
  - `docs/superpowers` holds 4.5 MB: 71 agent plans and specs. Their 2,636 checkboxes are never ticked, and about 10% of the paths they cite no longer exist.
  - `orbit_networking_tracker_spec.md` (1,090 lines) is the stale original spec.
  - Seven dated audit snapshots, and superseded `ai-evals` JSON.
  - The cleanup log says "may be deleted before merge" but was merged.
  - The vendored agent skills include `write-swift` and `animate-expo`, which don't apply to this repo.

### D2. Advisories: 38, none shipped (Low)

| Source | Count | Shipped? |
|---|---:|---|
| `@clerk/ui` → Solana wallet adapters → react-native / metro (~90 MB in `node_modules`) | 23 | No. Orbit imports only `@clerk/ui/themes`; the Solana code is in lazy chunks that are never loaded |
| `shadcn` CLI (only its CSS is used) | 7 | No (dev) |
| eslint / `eslint-config-next` | 4 | No (dev) |
| `drizzle-kit` | 4 | No (dev) |

**Do not run `npm audit fix --force`.** Its "fixes" are downgrades (shadcn 1.0.0, drizzle-kit 0.18.1, eslint-config-next 14.2.35).

### D3. Circular dependencies: mostly type-only noise (Low)

madge's 126 cycles collapse to **5 value-import cycles** once type-only imports are skipped:

1. `lib/entitlements → lib/user-settings → lib/plan-upgrade-events → entitlements`
2. `lib/contact-writes → lib/contact-brief → lib/job-changes → contact-writes`
3. `lib/auth → lib/site-access → lib/admin → auth` (the last edge is a dynamic import)
4. `components/capture/meeting-session ↔ meeting-engine`
5. `components/graph/constellation-modules → network-graph → use-sky-renderer`

Three cheap cuts fix most of it:
- Move the 7 JSONB column types that `schema.ts` imports into a leaf `db/column-types.ts`. That removes 80 of the 126 reported cycles and the 49-file strongly connected component.
- Move `resolvePlan` and `BillingColumns` into a dependency-free module (fixes cycle 1).
- Have the caller of `contact-writes` refresh the brief, instead of `contact-writes` importing `contact-brief` (fixes cycle 2).

---

## Proposed lint and format rules

These are measured against today's code; the numbers are current violation counts. The full config snippet and staged rollout are in the plan (P3).

| Rule | Count | Stage |
|---|---:|---|
| `@typescript-eslint/consistent-type-imports` | 20 | autofix, then error |
| `@typescript-eslint/no-unnecessary-type-assertion` (typed) | 359 | autofix, then error |
| `@typescript-eslint/await-thenable` (typed) | 1 | error |
| `linterOptions.reportUnusedDisableDirectives` | 1 | error |
| `no-console` (allow `warn` / `error`) | 2 | error; later drop the allowlist (104) in favour of `reportError` |
| `@typescript-eslint/no-floating-promises` (typed) | 17 | warn, fix, then error |
| `@typescript-eslint/no-misused-promises` (typed, `checksVoidReturn.attributes: false`) | 9 | warn, fix, then error |
| `@typescript-eslint/switch-exhaustiveness-check` (typed) | 23 | warn, fix, then error |
| `no-restricted-imports`: `@/db`, `node:*` and server-only libs from `src/components/**` and `lib/**/use-*` | 0 | error now |
| `no-restricted-imports`: AI SDKs outside `lib/ai*.ts` (replaces `smoke-ai-access`'s regex) | 0 | error now |
| `no-restricted-imports`: `@/components/*` from `src/lib/**`; `@/actions/*` from `src/lib/**` (non-client) and `src/app/api/**` | ~30 | warn + ratchet |
| `no-restricted-syntax`: `process.env` outside `lib/env.ts` and a few owners | 225 | warn + ratchet |
| `no-restricted-syntax`: `return { ok: false, message }` in actions | ~10 | warn + ratchet |
| madge `--circular` with `skipTypeImports` in CI (~12 s), instead of the slow `import/no-cycle` | 5 | fail if the count grows; target 0 |
| ESLint warning ratchet (`--max-warnings` = current count, may only go down) | 49 | now |
| Prettier (`printWidth: 100`, `trailingComma: "es5"`) | 6.4% of lines | **decision:** one mechanical commit listed in `.git-blame-ignore-revs`, or skip it |

Typed linting roughly doubles lint time (1m17s → 2m33s). CI already runs lint in parallel with `tsc`, so the job gets about 75 s longer. The two `src/app/.well-known/**` route files must be added to `tsconfig` `include` first, because the `**/*.ts` glob skips dot-directories.

---

## Appendix: environment variables

The full inventory, with purpose, required or optional status, default, environments, validation and where each is read, is in the `docs/ENVIRONMENT.md` draft in [CODE_HEALTH_PLAN.md](CODE_HEALTH_PLAN.md#draft-docsenvironmentmd).

These are flagged as missing a startup validation check:

| Variable | Gap |
|---|---|
| `GOOGLE_REDIRECT_URI`, `MICROSOFT_REDIRECT_URI` | Should be required when the matching client id is set, https in production, and on the `APP_BASE_URL` host |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | No warning when missing on a production build |
| `ORBIT_MANAGED_*_API_KEY` | The warning is tied to `STRIPE_SECRET_KEY`; it should be unconditional now that every plan includes AI |
| `site_settings.managed_ai_paused` | A null value silently reads as paused. It should be checked at boot or by the sweep |
| `EXTENSION_ORIGIN` | No `chrome-extension://` shape check |
| `CONTACT_INBOX_EMAIL` | The contact form is silently hidden when unset |
| `CLERK_WEBHOOK_SIGNING_SECRET`, `STRIPE_WEBHOOK_SECRET`, `RESEND_WEBHOOK_SECRET` | No `whsec_` prefix check |
| `RESEND_API_KEY` | No `re_` prefix check |
| `HEALTH_TOKEN` | No minimum length |
| `ADMIN_USER_IDS` | No `user_` shape check |
| `ENCRYPTION_SECRET`; the Clerk and Stripe key modes | Shape checks run only for `VERCEL_ENV=production`. Previews should at least refuse the placeholder secret and live keys |
| `CRON_SECRET` and `APP_BASE_URL` vs the GitHub `CRON_SECRET` and `APP_URL` | No cross-system check. The ops workflow could compare a hash at `/api/health` |
| `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Treated as managed keys whenever `VERCEL` is unset; should require `NODE_ENV=development` |
| `HUBSPOT_*`, `ORBIT_BENCH`, `SMOKE_ALLOW_REMOTE`, `OPENROUTER_API_KEY` | Not in `.env.example`; `smoke-env-documented.ts` can't see dynamic reads, root configs or scripts |
