# Testing

How Orbit is tested, how to run each layer, and what CI gates a merge on. The short version:
`npm test` before you push, and CI runs everything below on every ready PR.

## The layers

| Layer | Where | Runs against | Run it |
|---|---|---|---|
| Unit (pure logic, validators, transforms) | `scripts/smoke-*.ts`, `pure` tier | nothing — no database, no network | `npm test` |
| Integration (lib write paths, route handlers, server-side gates) | `scripts/smoke-*.ts`, `pglite` tier | a throwaway PGlite database per run, full DDL bootstrapped fresh | `npm test` |
| Contract (third-party APIs) | `scripts/smoke-contract-*.ts` and others | the real client code, with HTTP mocked | `npm test` |
| Known bugs | `scripts/smoke-bug-*.ts`, `bug` tier | as above | `npm run test:bugs` |
| End-to-end (critical journeys) | `e2e/*.spec.ts` | `next dev` in demo mode, throwaway PGlite, a local Gemini stub | `npm run test:e2e` |
| Post-deploy | `scripts/post-deploy-smoke.ts` | the live production domain, anonymously | `BASE_URL=… npx tsx scripts/post-deploy-smoke.ts` |

Every smoke script is an executable spec: prose output, its own exit code. `scripts/run-smoke.ts`
runs them as a suite, and its manifest assigns every script a tier — `npm run test:check` fails
when a script on disk has none, so nothing is silently skipped.

### Hermetic by construction

- **No real database.** `pglite`-tier scripts start with `import "./smoke/_env"`, which deletes
  `DATABASE_URL` and points PGlite at a temp directory. The runner refuses a database script
  without that line.
- **No real provider keys.** The same preamble strips every billable key (`PROVIDER_KEY_ENV`).
- **No real network.** The runner preloads `scripts/smoke/hermetic.mjs`: DNS is answered locally
  (the SSRF guard resolves hosts even under a stubbed fetch) and the real `fetch` refuses every
  host but loopback, naming the URL. A missed stub fails at once instead of calling a live API.
- **No real people.** `scripts/smoke/factories.ts` builds deterministic fake contacts, emails
  and calendar events on reserved domains (`example.com`, `.test`) and the 555-01xx phone block.

### Writing a test

```ts
import "./smoke/_env";               // pglite tier only, and always the first line
import { run } from "./smoke/_env";
import { getDb } from "../src/db";
import { checker } from "./smoke/check";
import { fakeUserId, insertContact, purgeUsers } from "./smoke/factories";
import { mockFetch, route, json, status } from "./smoke/http-mock";

const t = checker();
run(async () => {
  const db = await getDb();
  const owner = fakeUserId("owner");
  const contact = await insertContact(db, owner, 0);
  const http = mockFetch([route("GET", /graph\.microsoft\.com/, () => status(429, {}, { "retry-after": "1" }))]);
  try {
    t.check("…", /* condition */ true);
    await t.rejects("…", () => somethingThatShouldThrow());
  } finally {
    http.restore();
    await purgeUsers(db, [owner]);
  }
  t.done("my feature");   // exits; a script that never reaches done() fails
});
```

Then add it to the manifest in `scripts/run-smoke.ts` with its tier.

## Known bugs

A defect found while testing is documented by a test, not fixed in passing. It gets its own
`scripts/smoke-bug-<name>.ts` in the `bug` tier:

```ts
t.knownBug("BUG: merge deletes the loser's opportunities", opportunitiesSurvived, detail);
```

`knownBug` asserts the **correct** behaviour, so the script genuinely fails while the bug is
there (exit code 3; an ordinary failed check is exit 1). The bug tier is not part of
`npm test`; `npm run test:bugs` runs it with the verdict inverted:

| Bug script exits | `test:bugs` says | Meaning |
|---|---|---|
| 3 | ok — known bug still reproduces | as documented |
| 0 | **FAIL — FIXED** | the fix landed: move the script to `pure`/`pglite` and drop the `bug` wording |
| anything else | **FAIL** | something else broke in that script |

So the CI `known-bugs` job is green while the documented bugs stay exactly as documented, and
goes red the moment one is fixed — which is when the test should be promoted, so it then guards
against a regression.

The current list, with severity and file references, is in each script's header and is summarised
in the table below.

| Script | Severity | Defect |
|---|---|---|
| `smoke-bug-merge-drops-children` | high | Merging contacts cascade-deletes the loser's opportunities and job matches and unlinks its pending send drafts; unmerge cannot restore them (`src/lib/contact-merge.ts` REPOINTED_TABLES). Reached by the automatic duplicate sweep too. |
| `smoke-bug-gmail-401-swallowed` | high | The Gmail recruiter scan treats a revoked token (401) as "no messages": every sender is rejected, the watermark advances, and no reconnect prompt appears (`src/lib/gmail.ts` fetchGmailMessages). |
| `smoke-bug-linkedin-slug` | medium | Two different people given the same non-profile LinkedIn URL (a company page) auto-merge at 0.98: `linkedinSlug()` disagrees with the `linkedin_slug` column (`src/lib/duplicates.ts:83`). |
| `smoke-bug-stripe-revocation-regrant` | medium | After a full refund drops an account to Free, a delayed older `subscription.updated` or a newer `subscription.deleted` puts it back on a paid plan (`src/lib/stripe-fulfilment.ts`, no `eventAt` on revocation). |
| `smoke-bug-admin-export-formula` | medium | The admin CSV export writes user-typed `=`/`@` text (waitlist names, referrer, feedback) as live spreadsheet formulas (`src/app/api/admin/export/route.ts`, no `escapeFormulae`). |
| `smoke-bug-relationship-trivial-excerpt` | medium | The relationship engine accepts a two-letter excerpt ("ok", matching inside "Looking") as evidence, so an invented fact or commitment is written to the contact (`src/lib/relationship-engine/validate.ts`). |
| `smoke-bug-llm-truncated-json-accepted` | medium | A truncated model answer is repaired and accepted as success, e.g. a captured person named "Gra" (`src/lib/ai.ts` parseAiJson / completeJson ignore the providers' max-tokens signal). |
| `smoke-bug-graph-nextlink-token-leak` | medium | Microsoft calendar, contacts and mail follow `nextLink`/`deltaLink`/`skipToken` to any host with the user's Graph bearer token; `cloud-files.ts` already guards this with `assertGraphUrl`. Defence in depth. |
| `smoke-bug-graph-sync-resilience` | medium | Graph calendar fetches have no timeout, and calendar/contacts sync treat 429/503 as failures (six of them disable the connection) instead of retrying. |
| `smoke-bug-cloud-notes-dead-cursor` | medium | Cloud notes replays a dead OneDrive (410 resyncRequired) or Drive (invalid page token) cursor forever, so the drive is never scanned again. |
| `smoke-bug-merge-email-sends` | medium | Merging does not rewrite `email_sends.contact_ids`: a queued or failed send to the loser vanishes from the winner and its interaction is never logged. |
| `smoke-bug-contact-delete-ghost-suggestion` | medium | The notifications panel keeps AI suggestions about a deleted contact, linking to a 404 (`src/lib/notification-panel.ts`). |
| `smoke-bug-stripe-deleted-account-resurrect` | low | Deleting an account cancels its subscription, and Stripe's resulting webhook re-creates the deleted user's `user_settings` row (removed by the orphan sweep a week later). |
| `smoke-bug-credit-period-overflow` | low | With no recorded period start, a credit period ending on the 29th–31st can start after now, so the monthly allowance reads as 0 spendable for up to ~4 days (`src/lib/credits/ledger.ts` minusOneMonth). |

## Coverage

On every push to `main` (and from "Run workflow"), CI runs the smoke suite a second time under
[c8](https://github.com/bcoe/c8) (config in `.c8rc.json`), merges the shards
(`scripts/coverage-merge.ts`) and writes a per-area table — auth, billing, connectors, AI,
contacts, exports, actions, routes — to the run summary, with the merged lcov as an artifact.
Locally: `npm run test:coverage`, then `npm run coverage:merge -- coverage`.

It is a separate run, never the PR gate: instrumentation slows scripts several-fold, which
breaks the wall-clock budgets in `smoke-constellation-match` (80s instrumented against ~13s).

It reports and does not gate yet. The intended ratchet, once a few runs on `main` show the numbers
are stable: fail the `coverage` job when line coverage in **auth & access**, **billing** or
**connectors & sync** drops below the last `main` value minus one point.

Baseline, measured when this was set up (2026-10-17, smoke suite, V8 coverage via c8):

| Area | Branches before | after | Functions before | after |
|---|---|---|---|---|
| auth & access | 70.9% | 74.8% | 79.5% | 82.5% |
| billing | 84.8% | 87.4% | 89.2% | 89.6% |
| connectors & sync | 78.0% | 82.4% | 88.3% | 91.9% |
| AI | 83.1% | 84.0% | 90.3% | 90.7% |
| contacts | 82.6% | 82.9% | 87.9% | 88.4% |
| API routes | 68.2% | 69.7% | 71.9% | 75.2% |
| all of `src/` | 79.6% | 80.0% | 74.4% | 74.7% |

Line coverage of all of `src/` moved only from 52.7% to 52.9%: most of `src/lib` was already
executed, and what the new tests add is mostly failure paths (401s, malformed bodies, foreign
ids), which show up as branches. Fourteen cron and token routes went from never loaded to
exercised, and `src/lib/extension/auth.ts` from 46% to 94% of branches.

Coverage counts the smoke suite only. React components are exercised by the Playwright flows,
which are not instrumented, so the "UI components" row reads low by construction.

## Flakiness

The policy is "fail, then fix the cause", never "retry until green":

- Playwright keeps one retry on CI so the report can label a failure *flaky* vs *broken*, with a
  trace of both attempts, but `failOnFlakyTests` fails the run either way.
- The smoke runner has no retries at all.
- Every smoke script is offline and gets a fresh database, so the usual sources (network, shared
  state, ordering) are designed out. A script that stalls on a promise that never settles fails
  instead of exiting 0 (`checker()` guards this).

Known flakiness risks, none observed failing on CI in the last 60 runs:

- `smoke-constellation-match` asserts wall-clock frame budgets. It passes on an idle runner and
  fails under CPU contention or instrumentation (80s under c8). If it ever fails on CI, make its
  budget relative to a calibration loop rather than absolute.
- Before the hermetic preload, four scripts depended on the runner's public DNS and one called
  Vercel's Blob API for real; all five failed offline. Fixed.
- The Playwright logs carry recurring `ECONNRESET` noise from `next dev` around the plan-colors
  and tour specs. It fails nothing today, but it is the likeliest source of a future flaky flow.

## CI

`.github/workflows/ci.yml` runs on every ready PR and every push to `main`:

| Job | What | Gate |
|---|---|---|
| `check` | typecheck, lint, `next build` | yes |
| `smoke` ×3 | the smoke suite, sharded | yes |
| `coverage-shard` ×3, `coverage` | the suite again under c8, merged into the run summary (`main` and on demand only) | report only |
| `known-bugs` | `npm run test:bugs` | yes (red = a bug was fixed, promote its test) |
| `security` | `npm audit` of production deps (critical), dependency review of the PR (high), gitleaks over the new commits | yes |
| `e2e` | Playwright journeys, failing on flaky tests | yes |

`.github/workflows/post-deploy.yml` runs `scripts/post-deploy-smoke.ts` against the production
domain after every successful production deployment (and on demand from the Actions tab). If it
fails, the deploy is live and broken: promote the previous production deployment in Vercel, then
investigate.

### Recommended branch protection (Settings → Branches → `main`)

None of this is enforced yet: `main` only blocks deletion and force-pushes. To make the checks
above a real gate:

1. **Require a pull request before merging**, with at least 1 approval, and dismiss stale approvals
   on new commits.
2. **Require status checks to pass**, with "require branches to be up to date": `typecheck · lint ·
   build`, `smoke suite (PGlite) 1/3`, `2/3`, `3/3`, `known bugs (expected failures)`,
   `audit · dependency review · secret scan`, `browser flows (Playwright)`.
3. **Drop `paths-ignore` from `ci.yml` at the same time**, or a docs-only PR waits forever on
   checks that never start (the comment at the top of `ci.yml` explains).
4. Keep **block force-pushes and deletion** (already on). Not linear history: PRs merge with
   merge commits here.
5. Turn on **secret scanning with push protection** and **Dependabot security updates** under
   Settings → Code security; gitleaks in CI is the second line, not the first.

### Open security backlog

- `npm audit --omit=dev`: 0 critical, 15 high, 11 moderate, all transitive (brace-expansion, braces,
  image-size, stream-json, uuid, and @clerk/ui's Solana wallet adapters), all fixable with
  `npm audit fix`. Once fixed, tighten the CI gate to `--audit-level=high`.
- gitleaks over the full history reports 33 matches, most of them identifiers that look like keys
  (`linkedinSlug`, a placeholder in a test). Two kinds need a human look: a `sk_test_…`-shaped
  string in `scripts/smoke-demo-signin-message.ts` (and the plan doc it was copied from) and
  `curl -u` credentials in `docs/superpowers/plans/2026-09-22-calendar-connections.md`. If
  either is a real credential, rotate it; then add the false positives to a `.gitleaksignore`.
