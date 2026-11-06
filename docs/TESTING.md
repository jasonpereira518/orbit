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

There are no open known bugs. The first fourteen, found when this suite was set up, were all
fixed and their scripts promoted to ordinary regression smokes (the bug tier is empty, so
`test:bugs` passes trivially until the next one is filed):

| Regression smoke (was `smoke-bug-…`) | Was | Defect fixed |
|---|---|---|
| `smoke-merge-children` | high | Merge cascade-deleted the loser's opportunities and job matches and unlinked its send drafts; unmerge could not restore them. |
| `smoke-gmail-401-reauth` | high | The Gmail recruiter scan read a revoked token as "no messages" and advanced its watermark with no reconnect prompt. |
| `smoke-linkedin-slug` | medium | Two different people sharing a company-page LinkedIn URL auto-merged. |
| `smoke-stripe-revocation-regrant` | medium | After a full refund, a delayed older update or a newer delete re-granted the paid plan. |
| `smoke-admin-export-formula` | medium | The admin CSV export wrote user-typed `=`/`@` text as live formulas. |
| `smoke-relationship-trivial-excerpt` | medium | A two-letter excerpt was accepted as evidence for a fact or commitment. |
| `smoke-llm-truncated-json` | medium | A provider-truncated answer was repaired and accepted as success. |
| `smoke-graph-nextlink-guard` | medium | Graph page/delta links were followed to any host with the bearer token. |
| `smoke-graph-sync-resilience` | medium | Graph calendar had no timeout; calendar/contacts did not retry 429/503. |
| `smoke-cloud-notes-dead-cursor` | medium | A dead OneDrive/Drive change cursor was replayed forever. |
| `smoke-merge-email-sends` | medium | Merge left `email_sends.contact_ids` pointing at the loser. |
| `smoke-contact-delete-ghost-suggestion` | medium | Notifications kept AI suggestions about deleted contacts. |
| `smoke-stripe-deleted-account-resurrect` | low | Stripe's webhook after account deletion re-created the settings row. |
| `smoke-credit-period-overflow` | low | A credit period with no recorded start could begin after now. |

Follow-ups the fixes left: Gmail scans that completed under the 401 bug need a manual rescan
(they cannot be told apart); `contact_identities` rows holding a full LinkedIn URL as a slug are
inert and drop on the next identity sync; an opportunity re-extracted onto a merged winner can
duplicate rather than dedupe (its `item_hash` used the loser's id).

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
| `security` | `npm audit` of production deps (critical), dependency review of the PR (high; needs the Dependency graph and `DEPENDENCY_REVIEW=true`), gitleaks over the new commits | yes |
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
3. `ci.yml` has no `paths-ignore`, so every PR reports these checks — docs-only ones too —
   and requiring them cannot leave a PR waiting on checks that never start.
4. Keep **block force-pushes and deletion** (already on). Not linear history: PRs merge with
   merge commits here.
5. Turn on **Dependency graph**, then set the repository variable `DEPENDENCY_REVIEW=true` so
   the PR dependency-review step starts enforcing (it is skipped until then: the action fails
   outright when the graph is off).
6. Turn on **secret scanning with push protection** and **Dependabot security updates** under
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
