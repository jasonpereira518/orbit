# Cold-start closeness

**Date:** 2026-08-21
**Status:** Approved design, ready for planning

## Problem

On first run Orbit cannot tell anyone apart, and the ranking layer converts
that failure into confident-looking output.

Reading `src/lib/closeness.ts` against a fresh LinkedIn import:

- **Strength is a constant.** `relationshipScore` defaults to `2` in the schema
  and the LinkedIn importer hardcodes `relationshipScore: 2`
  (`src/lib/import-job-processor.ts:170`). A 30%-weighted term with one value.
- **Recency is a constant, and wrong.** `recencyComponent` falls back to
  `createdAt` when `lastInteractionAt` is null. Every imported contact
  therefore scores ~1.0 on another 30%-weighted term, as though you had just
  spoken to all two thousand of them, then decays in lockstep.
- **Cadence is zero.** No interaction rows exist.
- Only `goalRelevance` differentiates, and only if goals are set — 15% weight.

So raw scores are near-identical. `buildClosenessCohort` then ranks contacts
against each other, and `cohortPercentile`'s midrank puts a large tied mass at
~0.5. Ring quotas (`RING_PERCENTILE_CUTOFFS`) assign a Core orbit regardless,
because quotas always fill.

The failure is not "closeness reads zero." It is **closeness cannot
discriminate, and the system reports a ranking anyway.**

### Signal we already hold and discard

- LinkedIn `Connected On` is parsed and written to `dateMet`
  (`src/lib/import-job-processor.ts:153,171`) but never reaches
  `firstInteractionAt`, so it is invisible to scoring.
- The LinkedIn messages CSV import is **already built and correct**
  (`src/actions/imports.ts:690-735` writes dated `interactions` rows with
  `source: "linkedin_messages_import"` and folds them into
  `firstInteractionAt`/`lastInteractionAt`). It is the single strongest
  cold-start signal available and needs no OAuth — but it is an optional import
  buried in the hub that a first-run user never discovers. The gap is
  discovery, not capability.
- Calendar sync windows to the past 180 days (`src/actions/imports.ts:890`).
- Gmail's `syncGmail` path scopes to recruiter-keyword queries over 90 days
  (`src/lib/gmail.ts:407-419`), not general correspondence volume.

### The trap that shapes the design

Mining imports harder does not fix flatness on its own — it converts flatness
into a **two-class orbit**. If Gmail covers 200 of 2,000 contacts, those 200
get real recency and cadence and the remaining 1,800 sit at a hard floor.
Coverage becomes closeness. The cohort layer then hardens that artifact into
ring assignments.

Therefore: the score must know **how much it knows** about each contact, even
though that number is never shown to the user.

## Goals

1. A brand-new orbit has real internal shape on day one — the constellation
   differentiates without inventing certainty.
2. The user can teach Orbit who matters in one bounded pass.
3. Connecting a data source improves accuracy without letting source coverage
   masquerade as closeness.
4. Cold-start distribution behaviour is covered by an assertable harness, not
   eyeballed.

## Non-goals

- No visible "we're not sure yet" hedging UI. The app should be right, not
  apologetic. (Explicitly rejected during brainstorming.)
- Not designing for the small-manual-orbit case; the design targets bulk
  imports (LinkedIn CSV, Gmail/Calendar OAuth, LinkedIn messages CSV).
- No re-tuning of the existing weights (`WEIGHTS`) beyond what cold start
  requires. Warm-orbit scoring behaviour should be preserved.

## Architecture

Five layers, ordered by dependency and sequenced so that each lands as a
shippable, independently verifiable slice.

### Layer 1 — Signal mining (fix the inputs)

Purely additive work on existing import paths. Valuable on its own and lands
first.

- **Delete the `createdAt` fallback** in `recencyComponent`. A contact with no
  logged interaction has *unknown* recency, not perfect recency. It returns the
  existing no-reference constant (`0.15`) instead. This is a standalone bug fix
  and it is the single highest-leverage line in the change.
- **LinkedIn `Connected On` → `firstInteractionAt`.** The connection event is a
  real, dated interaction. It does not set `lastInteractionAt` — connecting is
  not talking — but it establishes relationship age, which the prior consumes.
- **Promote the LinkedIn messages import into the wizard.** No new import code
  — the path already works end to end. It becomes a first-class, recommended
  step alongside the connections CSV, because a connections export alone is the
  worst-case cold start while connections + messages is close to the best.
- **Extend calendar lookback** beyond 180 days for the initial backfill only.
  Ongoing sync keeps its current window; a one-time deeper historical pass runs
  at connect time.
- **Gmail correspondence volume.** Separate from the recruiter-keyword query:
  a general per-correspondent thread count over the backfill window, feeding
  cadence.

### Layer 2 — Schema: separate stated closeness from the import default

`relationshipScore` currently means two different things: "the user says this
is a 2" and "nobody has ever rated this person, so it defaults to 2." Evidence
cannot be computed while those are indistinguishable, so this precedes the
scoring work.

- Add `contacts.stated_closeness` — nullable integer, 1–5, `null` meaning never
  rated.
- `strengthComponent` reads `statedCloseness` when present. When null it
  contributes to the prior rather than asserting a 2/5.
- `relationshipScore` remains for back-compat and existing UI writes; the two
  are kept in sync on write so nothing downstream breaks in this change.
- **Backfill:** `stated_closeness = relationship_score` wherever
  `relationship_score <> 2`. A value other than the default is evidence that a
  human moved it. Contacts sitting at exactly 2 are treated as unrated. This
  heuristic misdirects only for users who deliberately rated someone a 2, whose
  contact then becomes triage-eligible — an acceptable failure.

**DDL is applied manually.** `npm run db:push` must not be used: drizzle push
drops the runtime-managed `embedding_vector` column. Follow the existing
pattern in `scripts/migrate-contacts-columns.ts` — an idempotent
`columnExists` guard plus `ALTER TABLE` — as a new
`scripts/migrate-stated-closeness.ts`, and add the column to the expected-schema
list in `scripts/setup-db.ts`.

### Layer 3 — Evidence-weighted scoring

The core change to `src/lib/closeness.ts`.

**Evidence** is a per-contact value in `[0,1]` describing how much the system
actually knows. It is derived, never stored:

| Source | Contribution |
|---|---|
| User stated a closeness (triage or manual edit) | 0.6 |
| Logged interactions | up to 0.4, saturating (log-shaped, same curve family as `cadenceComponent`) |
| Contact plausibly covered by a connected source (has an email and Gmail is connected, etc.) | 0.15 |

Capped at 1.0. Starting values, to be tuned against the harness (see Testing).

**Prior** is a deliberately compressed estimate built only from signals that
exist for everyone. Note that Orbit stores no company or school for the *user*
— `userSettings` holds only `email` and `socialLinks` — so overlap is derived
rather than compared directly:

- **Relationship age** from `firstInteractionAt` / `dateMet`.
- **Email-domain affinity** — the contact's email domain matches the domain of
  `userSettings.email`, excluding public providers (gmail, outlook, yahoo,
  icloud, proton, hotmail). A same-domain contact is a colleague.
- **Company and school concentration** — orbit-relative. A company or school
  holding a large share of the user's contacts is somewhere the user has been,
  so membership in it is weak affinity evidence. Computed from the cohort scan
  already in flight, not a new query.
- The existing **`goalRelevance`**.
It is squashed into a narrow band around the middle — starting range
`[0.30, 0.60]` — so it can produce gentle ordering but can never manufacture a
top placement out of nothing.

**Blend:**

```
raw = (1 - evidence) * prior + evidence * evidencedScore
```

where `evidencedScore` is today's `computeRawCloseness` output. At full
evidence this is exactly current behaviour, so warm orbits are unaffected. As
evidence arrives the prior's weight shrinks — guesses are transitional
scaffolding, not permanent facts.

**Hard ceiling on guesses:** a contact whose evidence is below a floor
(starting value `0.25`) can never be assigned above ring 3, regardless of
percentile. Rings 4 and 5 — Inner and Core — must be earned with evidence.
This is the rule that keeps the compressed prior honest even though quotas
always fill.

### Layer 4 — Cohort gating rebased onto coverage

`buildClosenessCohort` currently fades `relativeWeight` in on **contact count**
(`RELATIVE_MIN_N = 8`, `RELATIVE_FULL_N = 40`). That is the wrong axis: a
2,000-contact import with 12 known people gets full relative ranking over
noise.

- Rebase the fade onto **coverage** — the share of the orbit carrying evidence
  above the floor — rather than raw `n`.
- Build the ranking distribution (`sortedRaw`) from **evidenced contacts only**.
  Ranking a person against a tied mass of unknowns is meaningless; ranking them
  against the people you demonstrably know is not.
- Unevidenced contacts are mapped onto that scale by their prior and then
  clamped by the Layer 3 ring ceiling. They receive a placement without
  distorting the distribution everyone else is measured against.

`getClosenessCohort` in `src/lib/closeness-cohort.ts` stays the single
per-request chokepoint — all five display surfaces continue to read one
identical ranking. Evidence is computed inside `buildCohortResult`, which means
`ClosenessCohortRow` gains the columns the prior and evidence read
(`firstInteractionAt`, `dateMet`, `school`, `email`, `statedCloseness`). The
type is deliberately shaped so a caller dropping a column is a compile error.

### Layer 5 — Shortlist triage

A new `triage` step in the setup wizard (`src/components/onboarding/wizard/`,
joining the existing `intro | add-people | manual | capture | import | review`
union in `setup-wizard.tsx`), reachable after import and re-enterable later
from settings.

**Candidate selection is the interesting part.** Ranking by current closeness
would surface exactly whoever Gmail happened to cover — re-confirming what the
system already knows and learning nothing. The shortlist (~40, presented in
screens of 5–8) is composed from three pools:

1. **High evidence, unrated** — people you demonstrably interact with but have
   never rated. Confirms and calibrates the evidenced distribution.
2. **High prior, no evidence** — strong company/school/goal overlap, no logged
   contact. Maximum information gain: these are the ones the system genuinely
   cannot guess.
3. **A diversity sample** across companies and connection eras, to avoid the
   shortlist collapsing onto one employer.

Rating writes `statedCloseness`, which lifts that contact's evidence above the
floor immediately — so the constellation visibly reorganises as the user works,
which is the point.

The step is skippable and resumable; skipping leaves the orbit in the Layer 1–3
state, which is already a large improvement over today.

## Testing

`scripts/smoke-closeness.ts` is a real, DB-free assertion harness (it already
keeps a `legacyCloseness` implementation to compare distributions against). It
is extended rather than replaced — cold-start behaviour is a distribution
property and cannot be verified by eye.

New fixtures and assertions:

- **Pure cold import** — 2,000 contacts, no interactions, no ratings. Assert no
  contact reaches ring 4 or 5; assert the ring histogram is not degenerate
  (the prior produces ordering); assert no crash at scale.
- **Coverage asymmetry** — 2,000 contacts, 200 with Gmail history. Assert the
  200 do not occupy 100% of rings 4–5 purely by virtue of coverage; assert the
  1,800 are not all identical.
- **Post-triage** — 40 stated ratings. Assert rated contacts dominate the top
  rings; assert ratings outrank mere coverage.
- **Evidence decay** — as interactions accumulate for one contact, assert the
  prior's contribution monotonically decreases toward zero.
- **Warm-orbit regression** — with full evidence, assert output matches current
  `computeRawCloseness` behaviour within tolerance, so this change is a no-op
  for established users.
- Existing monotonicity and cohort assertions must continue to pass unchanged.

## Files touched

| File | Change |
|---|---|
| `src/lib/closeness.ts` | Evidence, prior, blend, ring ceiling; remove `createdAt` recency fallback |
| `src/lib/closeness-cohort.ts` | Compute evidence; coverage-based fade; evidenced-only distribution; widen `ClosenessCohortRow` |
| `src/db/schema.ts` | `contacts.stated_closeness` |
| `scripts/migrate-stated-closeness.ts` | New — idempotent DDL + backfill |
| `scripts/setup-db.ts` | Expected-schema entry |
| `src/lib/import-job-processor.ts` | `Connected On` → `firstInteractionAt`; stop hardcoding strength |
| `src/actions/imports.ts` | Deeper one-time calendar backfill (messages import already correct — untouched) |
| `src/lib/gmail.ts` | Correspondence-volume query |
| `src/components/onboarding/wizard/` | New `triage` step + step union |
| `src/actions/onboarding-wizard.ts` | Persist triage progress |
| `src/actions/contacts.ts` | Write `statedCloseness` alongside `relationshipScore` |
| `scripts/smoke-closeness.ts` | Cold-start distribution assertions |

## Risks

- **Tuning.** Every constant above is a starting value. The harness makes them
  falsifiable, but landing good numbers will take iteration against a realistic
  fixture.
- **Warm-orbit regression.** The blend is designed to be a no-op at full
  evidence; the regression assertion is what enforces that, and it should be
  written before the blend lands.
- **`relationshipScore` dual-write** is deliberate interim duplication. Whether
  `relationshipScore` eventually collapses into `statedCloseness` is a
  follow-up, not part of this change.
- **Backfill heuristic** (`<> 2` means rated) is a guess about user intent.
  Documented above; failure mode is benign.
