# LinkedIn deep read, PR 3: closeness from LinkedIn evidence. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For deep-read users, closeness counts what a LinkedIn export proves about a relationship: both sides writing, how many years you have been in touch, a recommendation either way, and real overlap with your own jobs and schools.

**Architecture:**
- A new pure module turns those signals into two inputs: a 0–1 `depth`, and a work/school `historyOverlap`.
- `computeRawCloseness` uses `depth` as one more measured component, only for contacts with logged behaviour. `historyOverlap` replaces the orbit-relative company/school guess in the prior.
- The cohort builder and the single-contact rescore compute both from the same SQL aggregates and the same pure helper, gated by `deepReadOn`. The rescore reads the gate from the stored cohort snapshot, so a write path never pays for it.
- With deep read off, or with the inputs absent, every score is unchanged.

**Tech Stack:** TypeScript, Drizzle + Postgres (neon-http / PGlite), tsx smoke scripts (`npm test`).

**Spec:** `docs/superpowers/specs/2026-11-15-linkedin-deep-read-design.md`, section "PR 3: Closeness from LinkedIn evidence" and "Checked against a real export". This branch is stacked on PR 2 (#709, branch `claude/linkedin-deep-read-pr2`).

## Global Constraints

- No DDL. The cohort snapshot (`closeness_cohorts.snapshot`, jsonb) gains an optional key; nothing else is stored.
- Deep read off ⇒ identical scores: `smoke-closeness`, `smoke-closeness-materialized`, `smoke-contact-closeness` and `smoke-merge-closeness` pass with no edits to their existing expectations.
- A stated rating moves a score more than depth can: `WEIGHTS.strength` (0.3) > the depth weight (0.2).
- Ring quotas, `EVIDENCE_FLOOR` and `MAX_RING_WITHOUT_EVIDENCE` keep their meaning; this PR does not touch evidence.
- AI output (the relationship kind, the origin) is never a closeness input.
- Endorsements are NOT read: Jason's export has none (spec, "Checked against a real export"). The spec line saying PR 3 reads them is updated in Task 4.
- The cohort and the single-contact rescore must give one contact the same raw score (the drift `closeness-evidence.ts` warns about).
- Starting weights below are tunable. They are checked against the smokes only, because Jason's production data is not reachable from here.
- PGlite smokes must not run while `next dev` runs. Commit after each task; do not push or open a PR until Jason says so.

## Review Focus

1. A contact with no logged interaction at all (a bare LinkedIn connection): deep read must not lower or raise them. Their raw score stays exactly the prior plus overlap. (Task 2)
2. An old friend messaged both ways for five years but not in the last year, against a one-off recent message: the friend must score higher with deep read on. (Task 2)
3. A user who never imported their own history (no `career_profile.positions`/`education`, no schools): the prior keeps today's company/school concentration terms, not zeros. (Task 2)
4. One contact rescored on its own (a contact edit) right after a full recalibration: the same raw score as the cohort gave it. (Task 3)
5. Turning deep read off (or a cohort snapshot written before this PR): the single rescore falls back to today's formula, never to a half-deep one. (Task 3)

## File Structure

- Create `src/lib/closeness-depth.ts`: `DepthSignals`, `depthComponent`, `overlapAffinity`. Pure.
- Modify `src/lib/closeness.ts`: `ClosenessContact` gains `depth?` and `historyOverlap?`; `computeRawCloseness` uses them.
- Modify `src/lib/closeness-evidence.ts`: `PriorInput` gains `historyOverlap?`; `computePrior` uses it.
- Modify `src/lib/closeness-cohort.ts` (`buildCohortResult`, `recalibrateCloseness`), `src/lib/closeness-materialize.ts` (`rescoreContact`, snapshot build) and `src/db/schema.ts` (`ClosenessCohortSnapshot.deepRead?`).
- Tests: extend `scripts/smoke-closeness.ts` (pure) and `scripts/smoke-contact-closeness.ts` (PGlite). No new smoke files.

---

### Task 1: Depth and overlap as numbers

**Files:** Create `src/lib/closeness-depth.ts`. Test: `scripts/smoke-closeness.ts`.

**Interfaces (produced):**

```ts
/** Per contact, all time, from rows that count as a touch (`countsAsTouch`). */
export type DepthSignals = {
  inbound: number;          // EXCHANGE_TYPES rows with direction 'in'
  outbound: number;         // … direction 'out'
  exchangeYears: number;    // distinct calendar years with an EXCHANGE_TYPES row
  recommendations: number;  // rows whose external_id starts 'li-export:recommendation'
};
export const DEPTH_WEIGHTS = { reciprocal: 0.35, span: 0.35, recommendation: 0.3 } as const;
/** 0–1. reciprocal when inbound>0 && outbound>0; span = min(1, (exchangeYears - 1) / 3); recommendation when > 0. */
export function depthComponent(s: DepthSignals): number;
/** together → 1, same place without shared years → 0.5, none → 0; the best per kind. */
export function overlapAffinity(overlaps: readonly HistoryOverlap[]): { work: number; school: number };
```

- [ ] **Step 1: Failing checks** in `smoke-closeness.ts`:

```ts
const none = { inbound: 0, outbound: 0, exchangeYears: 0, recommendations: 0 };
check("depth: nothing is 0", depthComponent(none) === 0);
check("depth: one-way messages are not reciprocal", depthComponent({ ...none, inbound: 9, exchangeYears: 1 }) === 0);
check("depth: both sides wrote", Math.abs(depthComponent({ ...none, inbound: 1, outbound: 1, exchangeYears: 1 }) - 0.35) < 1e-9);
check("depth: four years of exchange saturates the span", Math.abs(depthComponent({ inbound: 1, outbound: 1, exchangeYears: 4, recommendations: 0 }) - 0.7) < 1e-9);
check("depth: ten years is no more than four", depthComponent({ inbound: 1, outbound: 1, exchangeYears: 10, recommendations: 0 }) === depthComponent({ inbound: 1, outbound: 1, exchangeYears: 4, recommendations: 0 }));
check("depth: everything is 1", Math.abs(depthComponent({ inbound: 3, outbound: 3, exchangeYears: 6, recommendations: 1 }) - 1) < 1e-9);
check("overlap: together beats same place", overlapAffinity([{ kind: "work", organization: "Acme", together: false, fromYear: null, toYear: null }, { kind: "work", organization: "Beta", together: true, fromYear: 2021, toYear: 2022 }]).work === 1);
check("overlap: same school, no shared years, is half", overlapAffinity([{ kind: "school", organization: "State", together: false, fromYear: null, toYear: null }]).school === 0.5);
check("overlap: none is zero", overlapAffinity([]).work === 0 && overlapAffinity([]).school === 0);
```

- [ ] **Step 2: Run** `npx tsx scripts/smoke-closeness.ts`. Expected: fails (module missing).
- [ ] **Step 3: Implement.** Pure; imports only the `HistoryOverlap` type from `@/lib/history-overlap`.
- [ ] **Step 4: Run.** Expected: every line `ok`, existing checks untouched.
- [ ] **Step 5: Commit** `feat(deep-read): depth and overlap as closeness numbers`.

### Task 2: Use them in the score

**Files:** `src/lib/closeness.ts`, `src/lib/closeness-evidence.ts`. Test: `scripts/smoke-closeness.ts`.

**Interfaces:**
- `ClosenessContact` gains:
  - `depth?: number | null` (0–1; absent = not measured);
  - `historyOverlap?: { work: number; school: number } | null` (absent = the user has no own history).
- `PriorInput` gains `historyOverlap?: { work: number; school: number } | null`.

Rules:
- **Depth.** Depth counts only when `depth != null` AND the contact `knowsBehaviour` (the same flag recency and cadence use). It then adds `WEIGHT_DEPTH = 0.2` to both `knownWeight` and `applicableWeight`, and `0.2 * depth` to `knownWeighted`. Otherwise the formula is exactly today's.
- **Overlap in the prior.** With `historyOverlap` given, the prior's `companyConcentration` and `schoolConcentration` terms (weights 0.08 / 0.04) are replaced by `historyOverlap.work` and `.school`, at weights 0.2 / 0.1, in both the sum and the normalising total. Without it, today's prior.

- [ ] **Step 1: Failing checks** in `smoke-closeness.ts`. `daysBack(n)` is an ISO date n days ago; build contacts the way the file's existing checks do.

```ts
const base = { statedCloseness: null, relationshipScore: 2, hasLoggedInteraction: true, firstInteractionAt: daysBack(2000) };
const oldFriend = { ...base, lastInteractionAt: daysBack(400), depth: 1 };
const oneOff = { ...base, lastInteractionAt: daysBack(30), depth: 0 };
check("deep: an old two-way friend outranks a recent one-off", computeRawCloseness(oldFriend, [], 0).raw > computeRawCloseness(oneOff, [], 1).raw);
check("deep off: the same contacts score as today", computeRawCloseness({ ...oldFriend, depth: undefined }, [], 0).raw === computeRawCloseness({ ...base, lastInteractionAt: daysBack(400) }, [], 0).raw);
const cold = { ...base, hasLoggedInteraction: false, lastInteractionAt: null };
check("deep: no logged behaviour means depth is ignored", computeRawCloseness({ ...cold, depth: 1 }, [], 0).raw === computeRawCloseness(cold, [], 0).raw);
const rated = (s: number, depth: number) => computeRawCloseness({ ...base, lastInteractionAt: daysBack(60), statedCloseness: s, depth }, [], 2).raw;
check("a stated rating moves a score more than depth can", rated(5, 0) - rated(1, 0) > rated(3, 1) - rated(3, 0));
const prior = (o?: { work: number; school: number }, company = 0) => computePrior({ firstInteractionAt: daysBack(400), companyConcentration: company, historyOverlap: o });
check("overlap: a real shared employer lifts the prior", prior({ work: 1, school: 0 }) > prior({ work: 0, school: 0 }));
check("overlap: known history replaces the orbit-relative guess", prior({ work: 0, school: 0 }, 1) === prior({ work: 0, school: 0 }, 0));
check("overlap: no own history keeps today's prior", prior(undefined, 1) > prior(undefined, 0));
check("overlap: the prior stays in its band", prior({ work: 1, school: 1 }) <= PRIOR_MAX && prior({ work: 0, school: 0 }) >= PRIOR_MIN);
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** per the rules. `computeRawCloseness` passes `contact.historyOverlap` into `computePrior`.
- [ ] **Step 4: Run** `npx tsx scripts/smoke-closeness.ts` and `npx tsx scripts/smoke-closeness-materialized.ts`. Expected: all pass, existing expectations untouched.
- [ ] **Step 5: Commit** `feat(deep-read): closeness counts depth and real overlap`.

### Task 3: Feed them from the database, both paths

**Files:** `src/lib/closeness-cohort.ts`, `src/lib/closeness-materialize.ts`, `src/db/schema.ts`. Test: `scripts/smoke-contact-closeness.ts` (PGlite).

**Interfaces:**
- `closeness-cohort.ts`: `export const depthAggregates`. SQL over the same `interactions` scan the cohort already runs (`countsAsTouch()`):
  - `exchangeYears`: `count(distinct extract(year from interaction_date))` filtered to `EXCHANGE_TYPES`;
  - `recommendations`: `count(*)` filtered to `external_id like 'li-export:recommendation%'`.

  Inbound/outbound come from the existing `messageInbound` / `messageOutbound`.
- `export async function deepClosenessInputs(userId, contactIds: string[] | "all", signals: Map<string, DepthSignals>): Promise<Map<string, { depth: number; historyOverlap: { work: number; school: number } | null }>>`. It loads the user's own history once (`loadYouCurrent`). It loads the contacts' `contact_experiences` (kind, organization, years, current), falling back to each contact's `company` / `school` with no years, exactly as PR 2's runner does. Then it runs `historyOverlaps` and `overlapAffinity`. `historyOverlap` is null when the user has no positions, education or schools.
- `recalibrateCloseness(userId, opts?: { deepRead?: boolean })` / `buildCohortResult(…, opts)`: `deepRead = opts.deepRead ?? await deepReadOn(userId)`. With it on, every contact's `computeRawCloseness` input gets `depth` and `historyOverlap`.
- `ClosenessCohortSnapshot` gains `deepRead?: boolean` (optional, like `calendarConnected`), written by the snapshot build.
- `rescoreContact` reads `snapshot.deepRead ?? false`. With it on, it adds the two aggregates to its existing touch query, calls `deepClosenessInputs(userId, [contactId], …)`, and passes `depth` / `historyOverlap`. It never calls `deepReadOn`.

- [ ] **Step 1: Failing checks** in `smoke-contact-closeness.ts`, in a new section. The user's `career_profile.positions` holds "Acme" 2021–2023.
  - **Seeds.** Three contacts:
    - Friend: `linkedin_message` rows both directions in 2019, 2020, 2021 and 2022, plus a `li-export:recommendation_received:…` note row.
    - One-off: one inbound message 20 days ago.
    - Colleague: no interactions, company "Acme".
  - **Checks:**
    - with `recalibrateCloseness(USER, { deepRead: true })`, Friend's raw score exceeds One-off's;
    - with `{ deepRead: false }`, the stored raw scores equal what today's formula gives (run the off pass first and keep the numbers);
    - after the deep recalibration, `rescoreContact(USER, friendId)` leaves Friend's stored raw score unchanged (to 1e-9);
    - the stored snapshot has `deepRead === true`;
    - after a deep-off recalibration, `rescoreContact` gives the off score again;
    - Colleague's prior is higher with deep read on than off.
- [ ] **Step 2: Run** `npx tsx scripts/smoke-contact-closeness.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** One pure step builds the deep fields for both paths, so the cohort and the rescore cannot drift: `depthComponent` from the aggregates, `overlapAffinity` from the overlaps. Keep the extra queries behind `deepRead`, so the flag-off path issues exactly today's queries.
- [ ] **Step 4: Run** the smoke, `smoke-closeness`, `smoke-closeness-materialized`, `smoke-merge-closeness`, `smoke-constellation-signals`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(deep-read): cohort and single rescore read depth and overlap the same way`.

### Task 4: Spec line, then whole-branch checks

- [ ] In the spec's "PR 3" section, replace the endorsement paragraph with one line: endorsements are not read (Jason's export has none, Nov 16), recommendations carry that weight instead. Commit `docs(deep-read): PR 3 drops endorsements`.
- [ ] `tsc` (0 errors outside `.next`), `npm run lint` (0 errors), `npm run db:check`, `npm run check:sources`.
- [ ] Stop any `next dev`, then `npm test`. Expected: all pass.
- [ ] Report to Jason: the starting weights, what each check showed, and that the weights are untested on his real data. Nothing pushed.

## Not in this PR

- Showing depth, overlap or "closest people" anywhere: PR 4 and B.
- Endorsements, Events.csv, the AI relationship kind as an input.
- Retuning `EVIDENCE_WEIGHTS`, ring quotas or the cohort blend.
