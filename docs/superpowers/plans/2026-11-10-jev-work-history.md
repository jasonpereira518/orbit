# Jev Work-History Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Orbit's work-history web searches with two Jev gates paid on Orbit's TypeSafe key: skip a sweep re-check when nothing suggests a job change, and veto the second "verify" search when the candidate is clearly someone else.

**Architecture:** Both gates are new entries in the existing skip-gate machinery (`SKIP_GATES` / `gateSkips` in `src/lib/decisions/`), shipped with thresholds `null` (never asked). `ai-access.ts` gains an Orbit-paid TypeSafe key scoped to those two operations, counted in the Anthropic pool, and taken out of service for 2 h on a quota/auth failure. `work-history-research.ts` asks gate 1 before the sweep's re-check and gate 2 inside `searchOnceThenVerify`, with a per-contact marker so neither gate fires twice in a row.

**Tech Stack:** Next.js / TypeScript, Drizzle + PGlite (local) / Neon (prod), tsx smoke scripts, TypeSafe Jev `jev-1.13.0`.

**Spec:** `docs/superpowers/specs/2026-11-10-jev-work-history-design.md`

## Global Constraints

- Jev may only ever cause a search **not** to run. It never causes a write.
- Any Jev failure, timeout, unsure answer, missing key, or out-of-service window → exactly today's behaviour (the search runs).
- `force` (the profile's research button) bypasses both gates. Gate 1 runs **only** in the periodic sweep.
- Never two Jev skips/vetoes in a row for one contact.
- A skip or veto never updates `contact_profiles.capturedAt`, never spends web-search allowance, never increments `workHistoryMisses`.
- Orbit's TypeSafe key grants **only** `contact.work_history.recheck.gate` and `contact.work_history.verify.gate`. An account's own TypeSafe key keeps working for every decision, as today.
- Orbit-paid TypeSafe spend counts toward `MANAGED_AI_POOLS.anthropic` ($190/month). Not charged to user credits (already true: `settleManagedUsage` skips `provider === "typesafe"`).
- Gate 1 state may include interaction `ai_summary` and relationship-digest text (Jason, Nov 10). Never `raw_notes`, email addresses or phone numbers.
- Every gate threshold ships `null`. Thresholds are set only in Task 9, which ships with or after Task 8 (privacy + `TERMS_VERSION`), never before.
- Schema version: **220**, or the next number above the highest claimed on `origin/main`, every open PR, and `git worktree list` at merge time (memory: schema-migration-gate; merged DDL needs a NEW version).
- New Orbit env var: `ORBIT_MANAGED_TYPESAFE_API_KEY`, read only in `src/lib/ai-access.ts` (`smoke-ai-access` enforces).
- No new API routes (Vercel Hobby is at its 12-function cap).

## Review Focus

1. **Orbit's key is out of service but the account has its own TypeSafe key** → the account's own key still answers every decision. Test in Task 2.
2. **A Jev failure on a dev server (`VERCEL` unset)** → no `error_events` row is written to the shared DB (a dry dev key must not pull Orbit's TypeSafe out of prod). Test in Task 2.
3. **Contact has a stored web history with no current role** → gate 1 is not asked; the full search runs as today. Test in Task 4.
4. **Interaction summaries are long or contain instruction-like text** → state is trimmed to the limits and never includes `raw_notes`. Test in Task 4.
5. **The cheap re-check found a new employer, then the full search is unsure** → the veto state carries the new employer, so a true move isn't vetoed for a stale company. Test in Task 5.

---

### Task 1: Gate questions and operation ids

**Files:**
- Modify: `src/lib/ai-operations.ts` (beside `"import.enrich.gate"`, ~line 170)
- Modify: `src/lib/decisions/catalog.ts` (`SKIP_GATES` ~351, `SKIP_GATE_TUNING.skipAtOrBelow`)
- Modify: `src/lib/decisions/gates.ts` (`OPERATION` map)
- Test: `scripts/smoke-decisions-gates.ts`

**Interfaces:**
- Produces: op ids `"contact.work_history.recheck.gate"`, `"contact.work_history.verify.gate"` (tier `"decision"`, `background: true`); `GateName` gains `"workHistoryRecheck"` and `"workHistoryVerify"`; `SKIP_GATE_TUNING.skipAtOrBelow.workHistoryRecheck === null`, `.workHistoryVerify === null`.

- [ ] **Step 1: Write the failing test** — in `smoke-decisions-gates.ts`, add:
  - `gateSkips(scripted(0.01), "workHistoryRecheck", {})` → `false`, and the decider's `asked === 0` (off gate is never asked).
  - Same for `"workHistoryVerify"`.
  - `gateProbability(scripted(0.2), "workHistoryRecheck", {})` → `0.2` (the eval can still measure an off gate), and `last.operation === "contact.work_history.recheck.gate"`.
  - Same for verify with `"contact.work_history.verify.gate"`.
- [ ] **Step 2: Run** `npx tsx scripts/smoke-decisions-gates.ts` — expect a type error or FAIL on the unknown gate names.
- [ ] **Step 3: Implement.**
  - Two `AI_OPERATIONS` entries. Labels: `"Work history: re-check needed? (decision model)"` and `"Work history: same person? (decision model)"`.
  - `SKIP_GATES.workHistoryRecheck = noul("Has the person in \`contact\` changed employer or role since \`last_checked\`?", { true: …, false: … })`. Gloss for `true`: a new employer, a new role, or leaving a job, as stated or strongly implied in `since_last_check`, or a long tenure that makes a move likely. Gloss for `false`: nothing in `since_last_check` points to a move, and the current role is recent or consistent with everything seen.
  - `SKIP_GATES.workHistoryVerify = noul("Is the person described in \`first_answer\` the same person as \`contact\`?", { … })`. Glosses follow `samePersonQuestion`, plus: if `moved_to` is present, a match at `moved_to` is the same person.
  - Both thresholds are `null`, each with a comment: `null until the eval shows 0 wrong skips (recheck) / 0 vetoes of a true match (verify) — spec 2026-11-10`.
  - `OPERATION` map entries.
- [ ] **Step 4: Run the smoke** — expect PASS. Also run `npx tsc --noEmit` and expect 0 errors.
- [ ] **Step 5: Commit** — `feat(jev): work-history gate questions, off by default`.

### Task 2: Orbit-paid TypeSafe key — scope, pool, out-of-service

**Files:**
- Modify: `src/lib/ai-access.ts` (`AiAccess.open` ~615–665, `decision()` ~837, `managedPoolState` ~233, `PoolState`, `managedPoolSpentMicros` ~195, `managedPoolsSpent` ~214)
- Modify: `src/lib/managed-ai-policy.ts` (beside `MANAGED_AI_POOLS`)
- Modify: `src/lib/decisions/jev.ts` (`callJev` catch ~237, `openDecider` ~281)
- Test: `scripts/smoke-ai-access.ts`

**Interfaces:**
- Produces:
  - `export const ORBIT_PAID_DECISIONS: ReadonlySet<string>` in `ai-access.ts`, holding the two Task 1 ids.
  - `AiAccess.hasDecisionModel(): boolean`.
  - `export async function noteDecisionFailure(grant: DecisionGrant, err: unknown): Promise<void>`. Never throws.
  - `PoolState.typesafeOut: boolean`.
  - `export const POOL_ALSO_COUNTS: Partial<Record<AiProvider, readonly string[]>> = { anthropic: ["typesafe"] }` in `managed-ai-policy.ts`.

- [ ] **Step 1: Write the failing tests** in `smoke-ai-access.ts`, with `ORBIT_MANAGED_TYPESAFE_API_KEY` set and `VERCEL=1` for the run:
  - **Scope.** A plan-eligible account with no own TypeSafe key: `access.decision("contact.work_history.recheck.gate")` is non-null with `keyOwner === "orbit"`. `access.decision("chat.rerank.decide")` is `null`. `access.hasDecisionModel()` is `true`.
  - **Own key wins.** The same account with its own TypeSafe key saved: `decision("chat.rerank.decide")` is non-null with `keyOwner === "user"`.
  - **Stopped.** `ORBIT_JEV=off`, `ORBIT_MANAGED_AI=off`, or the admin pause → `decision("contact.work_history.recheck.gate") === null`.
  - **Pool.** A `usage_events` row with `provider "typesafe"`, `key_owner "orbit"` and 1,000,000 micros raises `managedPoolsSpent().anthropic` by 1,000,000. An anthropic pool at its cap → the work-history op grant is `null`.
  - **Out of service.** `noteDecisionFailure(orbitGrant, new TypeSafeApiError(402, "TypeSafe 402: payment required"))` → one `error_events` row (source `ERROR_SOURCES.managedAi`, `context.provider === "typesafe"`). After `forgetManagedAiPause()`, a fresh `AiAccess.open` gives `decision("contact.work_history.recheck.gate") === null`.
  - **Out of service doesn't block own keys** (Review Focus 1). With that row present, an account with its own TypeSafe key still gets a non-null `decision("chat.rerank.decide")`.
  - **Dev servers write nothing** (Review Focus 2). With `VERCEL` unset, `noteDecisionFailure(...)` writes no `error_events` row.
  - **Personal grants write nothing.** `noteDecisionFailure` on a personal grant writes no row.
  - **Alert.** `loadManagedAiOpsFacts` (`src/lib/managed-ai-ops.ts`) lists `"typesafe"` among failing providers after the row above.
- [ ] **Step 2: Run** `npx tsx scripts/smoke-ai-access.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
  - In `open()`, the decision key chain becomes: own key → dev key (unchanged) → the Orbit key. Use the Orbit key only when `eligibility === "plan"`, `!pools.paused`, `!pools.spent.has("anthropic")`, `!pools.typesafeOut`, `!managedAiSwitchedOff()`, and the env var is set. Mark it `orbitPaid: true`.
  - `decision(op)` returns `null` for an `orbitPaid` key when `!ORBIT_PAID_DECISIONS.has(op)`.
  - `managedPoolState` adds one column to its existing statement: `typesafe_out = EXISTS(error_events in the last 2 h, source managedAi, context->>'provider' = 'typesafe', kind IN ('quota','auth'))`. Keep `"typesafe"` out of `spent`.
  - `managedPoolsSpent` and `managedPoolSpentMicros` filter `provider IN (p, ...POOL_ALSO_COUNTS[p])`.
  - `noteDecisionFailure` mirrors `runOnGrant`. It returns early unless `grant.keyOwner === "orbit"`, `process.env.VERCEL` is set, and `classifyAiError(err)` is `"quota"` or `"auth"` (TypeSafe 401 → auth, 402 → quota already). Then it sets `pauseCache.typesafeOut = true` and writes `recordErrorEvent`, throttled by `shouldRecordThrottled("ai.managed:typesafe:" + kind)`.
  - `callJev`'s catch calls `await noteDecisionFailure(grant, err).catch(() => {})`.
  - `openDecider` probes `resolved.hasDecisionModel()` instead of `decision("chat.rerank.decide")`.
- [ ] **Step 4: Run** `npx tsx scripts/smoke-ai-access.ts`, `npx tsx scripts/smoke-decision-engine.ts` and `npx tsx scripts/smoke-credits.ts` — expect all PASS.
- [ ] **Step 5: Commit** — `feat(jev): Orbit-paid TypeSafe key scoped to work-history gates, pooled and out-of-service on quota`.

### Task 3: Skip marker and new outcomes (no gates yet)

**Files:**
- Modify: `src/db/schema.ts` (`contacts`, beside `workHistoryMissSlug` ~802)
- Modify: `src/db/index.ts` (`contacts` CREATE TABLE ~210, `ensureColumn` beside ~4429, changelog comment, `SCHEMA_VERSION`)
- Modify: `scripts/schema-ddl.lock.json` via `npx tsx scripts/smoke-schema-ddl.ts --update`
- Modify: `src/lib/work-history-research.ts` (`WorkHistoryOutcome` ~76, reschedule block in `researchContactWorkHistory` ~337)
- Test: `scripts/smoke-work-history-research.ts`

**Interfaces:**
- Produces:
  - Column `contacts.work_history_jev_skipped_at timestamptz NULL` (Drizzle `workHistoryJevSkippedAt`).
  - `WorkHistoryOutcome` gains `"jev_skipped"` and `"jev_vetoed"`.
  - Marker rule: `jev_skipped` / `jev_vetoed` → marker = `now`. `saved` / `unchanged` / `not_found` / `unsure` → marker = `null`. Any other outcome → untouched. Neither new outcome changes `workHistoryMisses`.

- [ ] **Step 1: Write the failing test.** Export a tiny pure helper `jevMarkerUpdate(outcome, now): Date | null | undefined` (`undefined` = leave alone) from `work-history-research.ts`, and assert its table:
  - `jevMarkerUpdate("jev_skipped", t) === t` and `jevMarkerUpdate("jev_vetoed", t) === t`
  - `jevMarkerUpdate("unchanged", t) === null`
  - `jevMarkerUpdate("fresh", t) === undefined` and `jevMarkerUpdate("rate_limited", t) === undefined`
- [ ] **Step 2: Run** `npx tsx scripts/smoke-work-history-research.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
  - Add the column to the schema and the DDL (CREATE TABLE and `ensureColumn`).
  - Bump `SCHEMA_VERSION`, and add a changelog line naming this spec. Run `smoke-schema-ddl --update`.
  - Add the two outcomes. The reschedule `update` sets `workHistoryJevSkippedAt` from `jevMarkerUpdate`, and the misses branch ignores the new outcomes. `nextWorkHistoryDue`'s default branch already gives one normal interval from `now`.
- [ ] **Step 4: Run** `npx tsx scripts/smoke-work-history-research.ts`, `npx tsx scripts/smoke-schema-ddl.ts` and `npx tsc --noEmit` — expect PASS and 0 errors. Fix any exhaustive switch over `WorkHistoryOutcome` that tsc flags (`src/actions/contact-profile.ts` maps outcomes to copy; forced runs never produce the new ones, so map them to the `not_found` copy).
- [ ] **Step 5: Commit** — `feat(work-history): Jev skip marker column and outcomes`.

### Task 4: Gate 1 — sweep re-check gate

**Files:**
- Create: `src/lib/work-history-gates.ts`
- Modify: `src/lib/work-history-research.ts` (`researchContactWorkHistory` options, `researchOnce` ~386–480)
- Modify: `src/lib/work-history-sweep.ts` (~205–245)
- Test: `scripts/smoke-work-history-research.ts`, `scripts/smoke-work-history-sweep.ts`

**Interfaces:**
- Consumes: Task 1 `"workHistoryRecheck"`; Task 3 outcomes and marker; `gateSkips`, `Engines`, `openEngines` from `src/lib/decisions/`; `loadJobBaseline` from `src/lib/job-changes.ts`.
- Produces:
  - `export const WORK_HISTORY_GATE_LIMITS = { interactions: 10, summaryChars: 300, digestChars: 300, firstAnswerChars: 2000 } as const`
  - `export async function recheckGateState(userId: string, contactId: string, args: { lastCheckedAt: Date; roles: JobBaseline["roles"]; closenessTier: string | null; now: Date }): Promise<Record<string, unknown>>`. Its keys are `contact` (current roles with start year/month and tenure in months, title, company), `last_checked` (ISO date and days ago), and `since_last_check` (interactions after `lastCheckedAt`, newest first and capped: type, date, `ai_summary` trimmed; plus the digest's `what_they_do` / `working_on` trimmed).
  - `researchContactWorkHistory` option `gates?: Engines`. Present means gate 1 may be asked; only the sweep passes it.

- [ ] **Step 1: Write the failing tests** in `smoke-work-history-research.ts`, using a scripted `Engines` (copy `scripted(p)` from `smoke-decisions-gates.ts`). Temporarily set `SKIP_GATE_TUNING.skipAtOrBelow.workHistoryRecheck = 0.2` in the test, and restore it after. Seed a contact with a stored web history and a current role, older than `WORK_HISTORY_REFRESH_DAYS`.
  - **p = 0.1 with `gates`** → outcome `"jev_skipped"`. The checker is never called. `capturedAt` is unchanged. No `work-history` rate-limit bucket row. `workHistoryMisses` unchanged. Marker set. `workHistoryDueAt` lands one interval out.
  - **Run again with p = 0.1** (marker set) → the gate is not asked (`asked === 0`), the checker runs, and the marker is cleared.
  - **p = 0.9** → the checker runs.
  - **Engines that answer null** → the checker runs.
  - **No `gates` option** (user-triggered refresh) → the gate is not asked.
  - **`force: true` with `gates`** → the gate is not asked.
  - **Review Focus 3:** a stored web history with no current role → the gate is not asked, and the full researcher runs.
  - **Review Focus 4:** `recheckGateState` over a 1,000-char `ai_summary` and a `raw_notes` value of `"RAW-SECRET"` gives `since_last_check` summaries ≤ 300 chars, `JSON.stringify(state)` has no `"RAW-SECRET"`, and at most 10 interactions appear, all dated after `lastCheckedAt`.
- [ ] **Step 2: Write the failing sweep test.** In `smoke-work-history-sweep.ts`, the sweep calls `openEngines` once per user, not per contact. Inject it through the existing deps object as `deps.openEngines?: (userId: string) => Promise<Engines>`, and count the calls: 2 users × 3 due contacts → 2 calls.
- [ ] **Step 3: Run both smokes** — expect FAIL.
- [ ] **Step 4: Implement.**
  - `recheckGateState` reads `interactions` (columns `interactionType`, `interactionDate`, `aiSummary` only) and `relationshipDigests` (`whatTheyDo`, `workingOn`).
  - In `researchOnce`, add `workHistoryJevSkippedAt` to the contact columns. Right after the `userCanUseAi` check and **before** `options.spend` and the first `consumeBucket`: if `options.gates && !options.force && stored?.source === "web" && !marker`, load the baseline roles. If any role is current, build the state with `lastCheckedAt = stored.capturedAt`. If `gateSkips(options.gates, "workHistoryRecheck", state)`, return `{ outcome: "jev_skipped", cadence }`. Reuse the loaded roles in the existing re-check branch rather than loading twice.
  - In the sweep, open engines per user group (`deps.openEngines ?? openEngines`) and pass `gates`.
- [ ] **Step 5: Run both smokes** — expect PASS.
- [ ] **Step 6: Commit** — `feat(work-history): Jev re-check gate in the sweep, off until calibrated`.

### Task 5: Gate 2 — verify-search veto

**Files:**
- Modify: `src/lib/web-research.ts` (`searchOnceThenVerify` ~74)
- Modify: `src/lib/work-history-research.ts` (`WorkHistoryAnswer`, `WorkHistoryResearcher`, `researchWithWebSearch` ~211, `researchOnce`)
- Modify: `src/lib/work-history-gates.ts`
- Test: `scripts/smoke-work-history-research.ts`

**Interfaces:**
- Consumes: Task 1 `"workHistoryVerify"`; Task 3 `"jev_vetoed"` and marker; Task 4 `WORK_HISTORY_GATE_LIMITS`.
- Produces:
  - `searchOnceThenVerify(call, prompt, opts?: { vetoVerify?: (firstJson: string) => Promise<boolean> }): Promise<{ json: string; sources: WebSource[]; vetoed?: true }>`. The other caller (`web-research.ts` ~319) passes no opts.
  - `WorkHistoryResearcher = (userId, subject, opts?: { vetoVerify?: (firstJson: string) => Promise<boolean> }) => Promise<WorkHistoryAnswer>`, and `WorkHistoryAnswer.vetoed?: true`.
  - `export function verifyGateState(subject: WorkHistorySubject, firstAnswerJson: string, movedTo: { organization: string; title: string | null } | null): Record<string, unknown>` in `work-history-gates.ts`. Keys: `contact` (name, title, company, location, school, LinkedIn URL), `first_answer` (fenced with `fenceUntrusted`, ≤ 2,000 chars), `moved_to` (only when non-null).

- [ ] **Step 1: Write the failing tests.**
  - `searchOnceThenVerify`, with a fake `call` whose first answer is `{"match":"unsure"}`:
    - `vetoVerify → true` → one call, `vetoed: true`.
    - `vetoVerify → false` → two calls, no `vetoed`.
    - No opts → two calls.
    - First answer `confident` → `vetoVerify` is never invoked.
  - `researchContactWorkHistory`, with a fake researcher that calls `opts.vetoVerify?.("{\"match\":\"unsure\"}")` and returns `{ confident: false, experiences: [], headline: null, sources: [], vetoed: true }` when it returns true. Threshold temporarily `0.2`, scripted p = 0.1:
    - Outcome `"jev_vetoed"`. No profile written, no `public_work_history` row, `workHistoryMisses` unchanged, marker set.
    - **Next run** (marker set) → `opts.vetoVerify` is `undefined`.
    - **`force: true`** → `opts.vetoVerify` is `undefined`.
    - **First-time research without `gates`** (a `kickWorkHistoryResearch` path) → `vetoVerify` is defined. Gate 2 isn't sweep-only; engines open lazily.
  - **Review Focus 5:** on the moved path (the checker returns a confident new employer different from the stored one), the state the scripted decider receives has `moved_to.organization` equal to the checker's organization.
- [ ] **Step 2: Run the smoke** — expect FAIL.
- [ ] **Step 3: Implement.**
  - `searchOnceThenVerify` calls `vetoVerify` only when the first answer is `"unsure"`. When it returns true, return the first result with `vetoed: true`.
  - `researchWithWebSearch` passes `opts` through (not on the `legacyWebSearch()` path). When vetoed, return an empty unconfident answer with `vetoed: true`.
  - `researchOnce` builds `vetoVerify` unless `force` or the marker is set: `(firstJson) => gateSkips(options.gates ?? await openEngines(userId), "workHistoryVerify", verifyGateState(subject, firstJson, movedTo))`. `movedTo` is the checker's `current` on the moved path, else `null`. Right after `research(...)`, add `if (answer.vetoed) return { outcome: "jev_vetoed", cadence }`.
- [ ] **Step 4: Run** `npx tsx scripts/smoke-work-history-research.ts` and `npx tsx scripts/smoke-work-history-sweep.ts` — expect PASS. Also run `npx tsc --noEmit` and `npx eslint src/lib/work-history-*.ts src/lib/web-research.ts` — expect 0 errors.
- [ ] **Step 5: Commit** — `feat(work-history): Jev verify-search veto, off until calibrated`.

### Task 6: Eval fixtures for both gates

**Files:**
- Modify: `scripts/eval-fixtures/ai-skip-gates-eval.json`
- Modify: `scripts/lib/eval-ai-fixtures.ts` (only if `SkipGatesEvalFixture.gate` needs widening)
- Test: `scripts/smoke-eval-ai-score.ts`

**Interfaces:**
- Consumes: Task 1 gate names, Task 4/5 state shapes (cases are written in exactly the `recheckGateState` / `verifyGateState` key layout).

- [ ] **Step 1: Write the cases.**
  - **Recheck: ≥ 24 cases**, ≥ 10 with `"skip": false` (a move is visible or likely). Include:
    - an `ai_summary` saying they started somewhere new;
    - a digest `working_on` naming a new company;
    - a 7-year tenure with silence;
    - a near miss: a summary mentioning a *friend's* new job, `"skip": true`;
    - "great meeting you at SaaStr" style small talk, `"skip": true`.
  - **Verify: ≥ 20 cases**, ≥ 10 `"skip": false` (same person). Include:
    - a `moved_to` case where the candidate works at the new employer, `"skip": false`;
    - two same-name people in different cities and industries, `"skip": true`.
  - Every case gets a `why` where it's subtle.
- [ ] **Step 2: Run** `npx tsx scripts/smoke-eval-ai-score.ts` — expect PASS (the fixture loads and its gate names validate).
- [ ] **Step 3: Commit** — `test(eval): work-history gate fixtures`.

### Task 7: Private labels from own-account history

**Files:**
- Modify: `scripts/export-decision-labels.ts`

**Interfaces:**
- Consumes: `recheckGateState` (Task 4).
- Produces: `~/.orbit-private-labels/work-history-recheck.json`, in the same case shape as Task 6. Never written inside the repo; the script already refuses.

- [ ] **Step 1: Implement a `work-history-recheck` section.**
  - For each contact with a web profile, label each past check: a `contact_career_moves` row with source `web` → `"skip": false`, dated at that move. A web profile with no move since the previous check → `"skip": true`, dated at `capturedAt`.
  - Build the state with `recheckGateState` as of that date (interactions strictly before it).
  - Use the existing SELECT-only raw client.
- [ ] **Step 2: Run** `npx tsx scripts/export-decision-labels.ts --user <your own id> --database-url <PGlite or a Neon branch>` against the local demo DB — expect the file written outside the repo, with case counts printed.
- [ ] **Step 3: Commit** — `feat(eval): export work-history recheck labels`.

### Task 8: Privacy page, terms and re-consent

**Files:**
- Modify: `src/app/(site)/(docs)/privacy/page.tsx` (TypeSafe row ~71, the "If you also add a TypeSafe key" paragraph ~446)
- Modify: `src/lib/legal.ts` (`TERMS_VERSION`, `LEGAL_LAST_UPDATED` → ship date)
- Modify: `scripts/legal-pages.lock.json` via `npx tsx scripts/smoke-legal-pages.ts --update`
- Test: `scripts/smoke-legal-pages.ts`, `scripts/smoke-terms-acceptance.ts`

- [ ] **Step 1: Rewrite the TypeSafe row.** Badge stays. The body adds: on Orbit's account, for every account, Jev decides when a contact's work-history check can be skipped and whether a web search found the right person. For that it reads the contact's stored job history and short summaries of the user's notes and messages about them since the last check, never raw notes, email addresses or phone numbers. Keep the existing BYOK sentence for everything else.
- [ ] **Step 2: Update the paragraph at ~446** the same way. Also update the Google/OpenAI/Anthropic row's work-history sentence if it now reads as the only provider involved.
- [ ] **Step 3: Bump `TERMS_VERSION` and `LEGAL_LAST_UPDATED`**, then run `smoke-legal-pages --update`.
- [ ] **Step 4: Run** `npx tsx scripts/smoke-legal-pages.ts`, `npx tsx scripts/smoke-terms-acceptance.ts` and `npx tsx scripts/smoke-toast-copy.ts` — expect all PASS.
- [ ] **Step 5: Commit** — `docs(privacy): TypeSafe on Orbit's account for work-history checks; bump TERMS_VERSION`.

### Task 9: Calibrate and switch on (separate PR; ships with or after Task 8)

Needs: `ORBIT_MANAGED_TYPESAFE_API_KEY` (or Jason's own TypeSafe key) in `.env.local`, and Task 7's labels.

- [ ] **Step 1: Run** `npx tsx scripts/eval-ai.ts --decisions jev --tasks skip-gates --runs 2 --label jev-work-history` — record each gate's printed ceiling (the lowest p on a must-not-skip case).
- [ ] **Step 2: Set the thresholds.** `skipAtOrBelow.workHistoryRecheck` and `.workHistoryVerify` go mid-gap, below the ceiling by more than the observed run-to-run drift. Each gets a comment with the date, n, model and ceiling (the Sep 22 style). The gate stays `null` if the eval shows any wrong skip or any vetoed true match.
- [ ] **Step 3: Run the eval again** — expect `wrongSkips === 0` for both gates. Save the run under `docs/ai-evals/2026-11-xx-jev-work-history/`.
- [ ] **Step 4: Run the full smoke suite** (`npm run smoke`) — expect it green, or failures that also fail on clean main (memory: rerun flakes alone).
- [ ] **Step 5: Commit** — `feat(jev): switch on work-history gates at calibrated thresholds`.
- [ ] **Step 6 (Jason):** set `ORBIT_MANAGED_TYPESAFE_API_KEY` in Vercel production. After deploy, compare `contact.work_history` spend on `/admin/billing/costs` against the Nov 10 baseline of $5.69 per 30 days.
