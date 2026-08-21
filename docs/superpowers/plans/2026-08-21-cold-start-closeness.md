# Cold-Start Closeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Orbit's closeness scoring discriminate on day one, by teaching the score how much it actually knows about each contact instead of treating absent data as a measurement.

**Architecture:** A derived per-contact `evidence` value in `[0,1]` blends a deliberately compressed weak-signal `prior` against today's behaviour-driven score: `raw = (1 - evidence) * prior + evidence * evidencedScore`. At full evidence this is exactly current behaviour, so established orbits are unaffected. Contacts below an evidence floor are barred from the top two constellation rings, and the cohort ranking distribution is built only from evidenced contacts so that source coverage cannot masquerade as closeness.

**Tech Stack:** TypeScript, Next.js (App Router), Drizzle ORM, PostgreSQL (Neon in prod, PGlite locally), `tsx` smoke-script harnesses.

**Spec:** `docs/superpowers/specs/2026-08-21-cold-start-closeness-design.md`

## Global Constraints

- **Never run `npm run db:push`.** Drizzle push drops the runtime-managed `embedding_vector` column on `contact_embeddings`. All DDL is applied through an idempotent `tsx` script following the `scripts/migrate-contacts-columns.ts` pattern.
- **Tests are `tsx` smoke scripts**, not a test framework. The harness is `scripts/smoke-closeness.ts`, run with `npx tsx scripts/smoke-closeness.ts`. It throws on the first failed `check()`. There is no `npm test`; do not add one.
- **`getClosenessCohort` in `src/lib/closeness-cohort.ts` is the single per-request chokepoint.** All five display surfaces (contacts list, contact detail, graph, reminders, network stats) must keep reading one identical ranking. Never score a contact outside it.
- **Warm-orbit behaviour must not change.** The blend is designed to be a no-op at full evidence. Task 6 encodes this as an assertion and it must stay green through every later task.
- **Every numeric constant in this plan is a starting value**, chosen to be tuned against the harness. Export them as named constants, never inline literals.
- Existing assertions in `scripts/smoke-closeness.ts` (sections 1–9) must continue to pass unchanged unless a task explicitly authorises a change. The only authorised exceptions are Task 2 (distribution shifts from the recency fix), Task 5 (adds fields to the `person()` fixture) and Task 6 (`buildClosenessCohort` signature change breaks three call sites in section 3).
- Run `npm run lint` before each commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/closeness-evidence.ts` | **New.** Evidence and prior computation. Pure functions, no DB, no imports from `closeness.ts` — this file is the new concept and stays independently testable. |
| `src/lib/closeness.ts` | Existing scoring formula. Gains the blend, the ring ceiling, and a corrected `recencyComponent`. Does not compute evidence itself; receives it. |
| `src/lib/closeness-cohort.ts` | Per-request orchestration. Loads the extra columns, computes orbit-relative concentration, calls into evidence, builds the evidenced-only distribution. |
| `src/db/schema.ts` | `contacts.stated_closeness` column. |
| `scripts/migrate-stated-closeness.ts` | **New.** Idempotent DDL + backfill. |
| `scripts/smoke-closeness.ts` | The assertion harness. Extended, never rewritten. |

The split matters: `closeness-evidence.ts` is deliberately separate from `closeness.ts` so that evidence can be unit-asserted without constructing a cohort, and so the existing formula file does not grow a second responsibility.

---

### Task 1: Add `stated_closeness` column and migration

Separates "the user rated this person a 2" from "nobody ever rated this person, so it defaulted to 2." Every later task depends on this distinction.

**Files:**
- Modify: `src/db/schema.ts:107` (contacts table, beside `relationshipScore`)
- Create: `scripts/migrate-stated-closeness.ts`
- Modify: `scripts/setup-db.ts` (expected-schema list)

**Interfaces:**
- Consumes: nothing.
- Produces: `contacts.statedCloseness: number | null` on the Drizzle `Contact` type.

- [ ] **Step 1: Add the column to the schema**

In `src/db/schema.ts`, directly after the `relationshipScore` line in the `contacts` table:

```ts
    relationshipScore: integer("relationship_score").default(2).notNull(),
    /**
     * Closeness the user actually asserted, 1–5. NULL means never rated —
     * which `relationshipScore` cannot express, because its default of 2 is
     * indistinguishable from a deliberate 2. Evidence weighting depends on
     * telling those apart. Kept in sync with `relationshipScore` on write.
     */
    statedCloseness: integer("stated_closeness"),
```

- [ ] **Step 2: Write the migration script**

Create `scripts/migrate-stated-closeness.ts`. It must run against both PGlite (local) and Neon (prod), so it goes through `getDb()` rather than PGlite directly — unlike the older `migrate-contacts-columns.ts`, which is local-only:

```ts
/**
 * Adds contacts.stated_closeness and backfills it from relationship_score.
 *
 * Idempotent — safe to re-run. Never use `npm run db:push` for this: drizzle
 * push drops the runtime-managed embedding_vector column.
 *
 * Run: npx tsx scripts/migrate-stated-closeness.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  await db.execute(
    sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS stated_closeness integer`
  );
  console.log("column stated_closeness ready");

  // A value other than the default of 2 is the only evidence we have that a
  // human moved the slider. Contacts sitting at exactly 2 are treated as
  // unrated; a user who deliberately rated someone a 2 simply sees them
  // become triage-eligible, which is a benign failure.
  const result = await db.execute(
    sql`UPDATE contacts
        SET stated_closeness = relationship_score
        WHERE stated_closeness IS NULL AND relationship_score <> 2`
  );
  console.log("backfilled rows:", result.rowCount ?? 0);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
```

- [ ] **Step 3: Register the column in the schema check**

In `scripts/setup-db.ts`, find the expected-columns verification for `contacts` and add `stated_closeness` to it. If that file only verifies table names (`EXPECTED_TABLES`), add a short column assertion for `contacts.stated_closeness` in the same style as the existing table loop, so a fresh environment fails loudly rather than silently scoring everyone as unrated.

- [ ] **Step 4: Run the migration**

```bash
npx tsx scripts/migrate-stated-closeness.ts
```

Expected: `column stated_closeness ready` then a backfill count. Run it a second time — it must print the same first line and backfill `0`.

- [ ] **Step 5: Verify the schema check passes**

```bash
npx tsx scripts/setup-db.ts
```

Expected: no missing-column errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts scripts/migrate-stated-closeness.ts scripts/setup-db.ts
git commit -m "Separate stated closeness from the import default"
```

---

### Task 2: Stop treating creation time as a conversation

The highest-leverage line in the change. `recencyComponent` falls back to `createdAt`, so every freshly imported contact scores ~1.0 on a 30%-weighted term — the app currently believes you just spoke to all two thousand of them.

**Files:**
- Modify: `src/lib/closeness.ts:99-108` (`recencyComponent`)
- Test: `scripts/smoke-closeness.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `recencyComponent(lastInteractionAt?: Date | string | null): number` — **the `createdAt` second parameter is removed.** Callers in `computeRawCloseness` and `closeness-cohort.ts` must drop the argument.

- [ ] **Step 1: Write the failing assertions**

Append a new section to `scripts/smoke-closeness.ts`, before the final `console.log("\nAll closeness smoke checks passed.\n")`:

```ts
console.log("\n10. Creation time is not a conversation");
{
  const justImported = person({
    lastInteractionAt: null,
    createdAt: new Date(),
  });
  const r = recencyComponent(justImported.lastInteractionAt);
  check(
    "  a never-contacted import does not score as fresh",
    r < 0.2,
    String(r)
  );

  // Two contacts imported in the same batch, one of whom you have actually
  // spoken to. The spoken-to one must win decisively.
  const spoken = computeRawCloseness(
    person({ lastInteractionAt: daysAgoDate(10), createdAt: new Date() }),
    [],
    3
  ).raw;
  const silent = computeRawCloseness(
    person({ lastInteractionAt: null, createdAt: new Date() }),
    [],
    0
  ).raw;
  check("  a real touch beats a fresh import", spoken > silent, `${spoken} vs ${silent}`);
  check("  and by a visible margin", spoken - silent > 0.2, String(spoken - silent));
}
```

Add `recencyComponent` to the import list at the top of the file.

- [ ] **Step 2: Run to verify it fails**

```bash
npx tsx scripts/smoke-closeness.ts
```

Expected: FAIL on `a never-contacted import does not score as fresh` — the current fallback returns ~1.0.

- [ ] **Step 3: Fix `recencyComponent`**

In `src/lib/closeness.ts`, replace the function:

```ts
/**
 * Time decay on the last real touch.
 *
 * There is deliberately no `createdAt` fallback: a contact you have never
 * spoken to has *unknown* recency, not perfect recency. Falling back to
 * creation time meant a fresh two-thousand-row import scored as though every
 * one of those people had been contacted today, then decayed in lockstep —
 * which is what made cold orbits both flat and wrong. Unknown recency returns
 * the same low constant as a missing reference and lets the evidence layer
 * decide how much to trust the rest of the score.
 */
export function recencyComponent(lastInteractionAt?: Date | string | null) {
  if (!lastInteractionAt) return NO_INTERACTION_RECENCY;
  const days = daysAgo(lastInteractionAt);
  if (!Number.isFinite(days)) return 0;
  if (days <= 0) return 1;
  return 1 / (1 + days / RECENCY_HALFLIFE_DAYS);
}
```

Add near the other constants:

```ts
/** Recency for a contact with no logged interaction. Low, not zero. */
export const NO_INTERACTION_RECENCY = 0.15;
```

Update the call site inside `computeRawCloseness`:

```ts
  const recency = recencyComponent(contact.lastInteractionAt);
```

- [ ] **Step 4: Fix the other caller**

`ClosenessContact.createdAt` is now unused by the formula, but `closeness-cohort.ts` still selects it and `ClosenessCohortRow` still requires it. Leave both — Task 4's prior uses `createdAt` as a last-resort relationship-age floor. Confirm nothing else passes a second argument:

```bash
grep -rn "recencyComponent(" src scripts
```

Expected: only single-argument calls.

- [ ] **Step 5: Run the full harness**

```bash
npx tsx scripts/smoke-closeness.ts && npm run lint
```

Expected: section 10 passes. **Sections 4, 5 and 8 will shift** — they build fixtures with explicit `lastInteractionAt`, so they should still pass; if section 5's spread assertion now fails, that is a real signal the distribution changed and must be investigated, not retuned away.

- [ ] **Step 6: Commit**

```bash
git add src/lib/closeness.ts scripts/smoke-closeness.ts
git commit -m "Stop scoring creation time as a recent conversation"
```

---

### Task 3: Evidence computation

**Files:**
- Create: `src/lib/closeness-evidence.ts`
- Test: `scripts/smoke-closeness.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks except the `statedCloseness` field name from Task 1.
- Produces:
  - `type EvidenceInput = { statedCloseness?: number | null; touchCount?: number | null; hasLoggedInteraction?: boolean; coveredByConnectedSource?: boolean }`
  - `computeEvidence(input: EvidenceInput): number` → `[0,1]`
  - `EVIDENCE_FLOOR: number`
  - `EVIDENCE_WEIGHTS: { stated: number; interactions: number; coverage: number }`

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/smoke-closeness.ts`:

```ts
console.log("\n11. Evidence reflects what we actually know");
{
  const none = computeEvidence({});
  check("  a bare import has no evidence", none === 0, String(none));

  const rated = computeEvidence({ statedCloseness: 4 });
  check(
    "  a user rating clears the floor on its own",
    rated >= EVIDENCE_FLOOR,
    String(rated)
  );

  const oneTouch = computeEvidence({ touchCount: 1, hasLoggedInteraction: true });
  const manyTouches = computeEvidence({ touchCount: 20, hasLoggedInteraction: true });
  check("  interactions accumulate evidence", manyTouches > oneTouch);
  check(
    "  interaction evidence saturates below 1",
    manyTouches < 1,
    String(manyTouches)
  );

  const coverageOnly = computeEvidence({ coveredByConnectedSource: true });
  check(
    "  mere source coverage does not clear the floor",
    coverageOnly < EVIDENCE_FLOOR,
    String(coverageOnly)
  );

  const everything = computeEvidence({
    statedCloseness: 5,
    touchCount: 30,
    hasLoggedInteraction: true,
    coveredByConnectedSource: true,
  });
  check("  full evidence reaches 1", Math.abs(everything - 1) < 1e-9, String(everything));

  check(
    "  evidence is monotonic in touches",
    [0, 1, 3, 8, 20].every((n, i, arr) =>
      i === 0
        ? true
        : computeEvidence({ touchCount: n, hasLoggedInteraction: true }) >=
          computeEvidence({ touchCount: arr[i - 1], hasLoggedInteraction: true })
    )
  );
}
```

Add to the imports at the top of the harness:

```ts
import {
  computeEvidence,
  EVIDENCE_FLOOR,
} from "../src/lib/closeness-evidence";
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx tsx scripts/smoke-closeness.ts
```

Expected: FAIL — `Cannot find module '../src/lib/closeness-evidence'`.

- [ ] **Step 3: Implement**

Create `src/lib/closeness-evidence.ts`:

```ts
/**
 * How much Orbit actually knows about a contact, separate from how close they
 * are.
 *
 * The distinction exists because absent data is not a measurement. A fresh
 * LinkedIn import has no interactions, so every behavioural term reads the
 * same for everybody — and ranking people against each other on that produces
 * confident-looking noise. Worse, once one source is connected, whoever that
 * source happens to cover looks close purely by virtue of being covered.
 *
 * Evidence is derived on every request, never stored: it must move the instant
 * an interaction lands or a rating is set.
 */

/** Contributions, summed then capped at 1. Starting values — tune against scripts/smoke-closeness.ts. */
export const EVIDENCE_WEIGHTS = {
  /** The user told us directly. The only signal that is about closeness rather than about our own reach. */
  stated: 0.6,
  /** Observed behaviour, saturating — the 20th logged touch teaches us little the 5th did not. */
  interactions: 0.4,
  /** A connected source could plausibly have seen this person. Weak by construction: being reachable is not being close. */
  coverage: 0.15,
} as const;

/** Below this a contact is barred from the top two rings — Inner and Core must be earned. */
export const EVIDENCE_FLOOR = 0.25;

/** Touch count at which interaction evidence is effectively saturated. */
const INTERACTION_SATURATION = 12;

export type EvidenceInput = {
  /** 1–5 if the user has rated this contact; null/undefined means never rated. */
  statedCloseness?: number | null;
  /** Interactions in the trailing cadence window. */
  touchCount?: number | null;
  /** Any logged interaction ever, including outside the cadence window. */
  hasLoggedInteraction?: boolean;
  /** e.g. contact has an email address and Gmail is connected. */
  coveredByConnectedSource?: boolean;
};

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

export function computeEvidence(input: EvidenceInput): number {
  let evidence = 0;

  if (input.statedCloseness != null) {
    evidence += EVIDENCE_WEIGHTS.stated;
  }

  const touches = Math.max(0, Math.floor(input.touchCount ?? 0));
  if (touches > 0 || input.hasLoggedInteraction) {
    // Same log shape as cadenceComponent, so evidence and cadence agree about
    // what "a lot of contact" means.
    const saturation =
      Math.log1p(Math.max(touches, 1)) / Math.log1p(INTERACTION_SATURATION);
    evidence += EVIDENCE_WEIGHTS.interactions * Math.min(1, saturation);
  }

  if (input.coveredByConnectedSource) {
    evidence += EVIDENCE_WEIGHTS.coverage;
  }

  return clamp01(evidence);
}

/** Contacts below the floor may not be placed above this ring, whatever their percentile. */
export const MAX_RING_WITHOUT_EVIDENCE = 3;
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx tsx scripts/smoke-closeness.ts && npm run lint
```

Expected: section 11 passes, sections 1–10 unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/closeness-evidence.ts scripts/smoke-closeness.ts
git commit -m "Add evidence weighting for closeness"
```

---

### Task 4: The compressed prior

A plausible placement for contacts we know nothing behavioural about — deliberately squeezed toward the middle so it can order people without ever manufacturing a top placement.

**Files:**
- Modify: `src/lib/closeness-evidence.ts`
- Test: `scripts/smoke-closeness.ts`

**Interfaces:**
- Consumes: `clamp01` (module-local, Task 3).
- Produces:
  - `type PriorInput = { firstInteractionAt?: Date | string | null; dateMet?: Date | string | null; createdAt?: Date | string | null; emailDomainMatchesUser?: boolean; companyConcentration?: number; schoolConcentration?: number; goalRelevance?: number }`
  - `computePrior(input: PriorInput): number` → `[PRIOR_MIN, PRIOR_MAX]`
  - `PRIOR_MIN`, `PRIOR_MAX`
  - `publicEmailDomain(domain: string): boolean`

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/smoke-closeness.ts`:

```ts
console.log("\n12. The prior orders without over-claiming");
{
  const bare = computePrior({});
  check(
    "  a bare contact sits inside the compressed band",
    bare >= PRIOR_MIN && bare <= PRIOR_MAX,
    String(bare)
  );

  const best = computePrior({
    firstInteractionAt: daysAgoDate(3000),
    emailDomainMatchesUser: true,
    companyConcentration: 1,
    schoolConcentration: 1,
    goalRelevance: 1,
  });
  check(
    "  even a maximal prior cannot exceed the band",
    best <= PRIOR_MAX,
    String(best)
  );
  check("  a maximal prior still beats a bare one", best > bare);

  const colleague = computePrior({ emailDomainMatchesUser: true });
  check("  a shared work domain is affinity", colleague > bare);

  const older = computePrior({ firstInteractionAt: daysAgoDate(2000) });
  const newer = computePrior({ firstInteractionAt: daysAgoDate(30) });
  check("  a longstanding connection outranks a brand-new one", older > newer);

  check("  gmail.com is not a shared workplace", publicEmailDomain("gmail.com"));
  check("  a company domain is", !publicEmailDomain("acme.io"));
}
```

Extend the harness import from `closeness-evidence` to include `computePrior`, `PRIOR_MIN`, `PRIOR_MAX`, `publicEmailDomain`.

- [ ] **Step 2: Run to verify it fails**

```bash
npx tsx scripts/smoke-closeness.ts
```

Expected: FAIL — `computePrior is not a function`.

- [ ] **Step 3: Implement**

Add the import at the **top** of `src/lib/closeness-evidence.ts` (not with the appended block):

```ts
import { daysAgo } from "@/lib/duplicates";
```

Then append the rest to the end of the file:

```ts
/**
 * The prior is clamped into a narrow mid band on purpose. It exists to order
 * the long tail, not to make claims about it — a guess must never be able to
 * produce a Core-orbit placement, and a compressed range is what guarantees
 * that no matter how the weights are later tuned.
 */
export const PRIOR_MIN = 0.3;
export const PRIOR_MAX = 0.6;

/** Contributions to the prior, normalised against their own total. */
const PRIOR_WEIGHTS = {
  age: 0.3,
  emailDomain: 0.3,
  companyConcentration: 0.2,
  schoolConcentration: 0.1,
  goalRelevance: 0.1,
} as const;

/** Connection age at which the age term is effectively maxed, in days (~5 years). */
const AGE_SATURATION_DAYS = 1825;

const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "fastmail.com",
]);

/** True for consumer mailbox providers, where a shared domain means nothing. */
export function publicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain.trim().toLowerCase());
}

export type PriorInput = {
  firstInteractionAt?: Date | string | null;
  dateMet?: Date | string | null;
  createdAt?: Date | string | null;
  /** Contact's email domain equals the user's, and neither is a public provider. */
  emailDomainMatchesUser?: boolean;
  /** Share of the user's orbit at this contact's company, 0–1. */
  companyConcentration?: number;
  /** Share of the user's orbit at this contact's school, 0–1. */
  schoolConcentration?: number;
  /** Reuse of the existing goal-relevance component, 0–1. */
  goalRelevance?: number;
};

/**
 * How long you have known someone, as a 0–1 term.
 *
 * A LinkedIn connection from 2014 that never became a conversation still means
 * more than one made last Tuesday — it survived. `firstInteractionAt` is
 * preferred, `dateMet` is the LinkedIn "Connected On" date, and `createdAt` is
 * a last resort that only orders import batches against each other.
 */
function ageComponent(input: PriorInput): number {
  const ref = input.firstInteractionAt || input.dateMet || input.createdAt;
  if (!ref) return 0;
  const days = daysAgo(ref);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.min(1, days / AGE_SATURATION_DAYS);
}

export function computePrior(input: PriorInput): number {
  const terms =
    PRIOR_WEIGHTS.age * ageComponent(input) +
    PRIOR_WEIGHTS.emailDomain * (input.emailDomainMatchesUser ? 1 : 0) +
    PRIOR_WEIGHTS.companyConcentration * clamp01(input.companyConcentration ?? 0) +
    PRIOR_WEIGHTS.schoolConcentration * clamp01(input.schoolConcentration ?? 0) +
    PRIOR_WEIGHTS.goalRelevance * clamp01(input.goalRelevance ?? 0);

  const totalWeight =
    PRIOR_WEIGHTS.age +
    PRIOR_WEIGHTS.emailDomain +
    PRIOR_WEIGHTS.companyConcentration +
    PRIOR_WEIGHTS.schoolConcentration +
    PRIOR_WEIGHTS.goalRelevance;

  const normalised = clamp01(terms / totalWeight);
  return PRIOR_MIN + normalised * (PRIOR_MAX - PRIOR_MIN);
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx tsx scripts/smoke-closeness.ts && npm run lint
```

Expected: section 12 passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/closeness-evidence.ts scripts/smoke-closeness.ts
git commit -m "Add a compressed prior for contacts with no behavioural signal"
```

---

### Task 5: Blend prior and evidence in the scoring formula

**Files:**
- Modify: `src/lib/closeness.ts` (`computeRawCloseness`, `applyClosenessCohort`, `computeClosenessForAll`)
- Test: `scripts/smoke-closeness.ts`

**Interfaces:**
- Consumes: `computeEvidence`, `computePrior`, `EVIDENCE_FLOOR`, `MAX_RING_WITHOUT_EVIDENCE` (Tasks 3–4).
- Produces:
  - `RawClosenessBreakdown` gains `evidence: number`, `prior: number`, `evidenced: number`.
  - `computeRawCloseness(contact, activeGoals?, touchCount?)` — signature unchanged. Evidence and prior are derived from the fields on `contact`, which is why the cohort builder supplies the affinity fields rather than passing a separate context object.
  - `ClosenessContact` gains `statedCloseness?: number | null`, `firstInteractionAt?`, `dateMet?`, `emailDomainMatchesUser?`, `companyConcentration?`, `schoolConcentration?`, `coveredByConnectedSource?`.

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/smoke-closeness.ts`:

```ts
console.log("\n13. The blend decays toward real evidence");
{
  // Warm-orbit regression: at full evidence the blend must be a no-op.
  const warm = person({
    statedCloseness: 5,
    relationshipScore: 5,
    lastInteractionAt: daysAgoDate(2),
  });
  const blended = computeRawCloseness(warm, [], 30);
  check(
    "  full evidence reproduces the evidenced score exactly",
    Math.abs(blended.raw - blended.evidenced) < 1e-9,
    `${blended.raw} vs ${blended.evidenced}`
  );
  check("  and evidence really is 1", Math.abs(blended.evidence - 1) < 1e-9);

  // Cold contact: the prior should dominate.
  const cold = computeRawCloseness(
    person({ statedCloseness: null, lastInteractionAt: null }),
    [],
    0
  );
  check("  a bare contact has no evidence", cold.evidence === 0, String(cold.evidence));
  check(
    "  so its score is exactly its prior",
    Math.abs(cold.raw - cold.prior) < 1e-9,
    `${cold.raw} vs ${cold.prior}`
  );

  // Monotone decay: as touches accumulate, the prior's influence shrinks.
  const priorShare = (touches: number) => {
    const b = computeRawCloseness(
      person({ statedCloseness: null, lastInteractionAt: daysAgoDate(20) }),
      [],
      touches
    );
    return 1 - b.evidence;
  };
  const shares = [0, 1, 3, 8, 20].map(priorShare);
  check(
    "  the prior's weight falls monotonically as evidence arrives",
    shares.every((s, i) => i === 0 || s <= shares[i - 1]),
    shares.map((s) => s.toFixed(3)).join(" → ")
  );
}

console.log("\n14. Guesses cannot reach the inner rings");
{
  // 2000 contacts, nothing known about any of them.
  const coldOrbit = Array.from({ length: 2000 }, (_, i) =>
    person({
      id: `x${i}`,
      statedCloseness: null,
      relationshipScore: 2,
      lastInteractionAt: null,
      createdAt: daysAgoDate(1),
      dateMet: daysAgoDate((i * 37) % 2500),
    })
  );
  const scored = computeClosenessForAll(coldOrbit, []);
  const rings = [0, 0, 0, 0, 0, 0];
  for (const b of scored.values()) rings[b.orbitScore] += 1;

  check(
    "  a pure cold import places nobody in Core or Inner",
    rings[5] === 0 && rings[4] === 0,
    `ring5=${rings[5]} ring4=${rings[4]}`
  );
  check(
    "  but the orbit is not one undifferentiated blob",
    rings.slice(1, 4).filter((c) => c > 0).length >= 2,
    rings.join(",")
  );
}

console.log("\n15. Coverage does not masquerade as closeness");
{
  // 200 contacts with real Gmail-style history, 1800 with nothing.
  const covered = Array.from({ length: 200 }, (_, i) =>
    person({
      id: `k${i}`,
      statedCloseness: null,
      lastInteractionAt: daysAgoDate((i * 3) % 200),
      dateMet: daysAgoDate(800),
      coveredByConnectedSource: true,
    })
  );
  const uncovered = Array.from({ length: 1800 }, (_, i) =>
    person({
      id: `u${i}`,
      statedCloseness: null,
      lastInteractionAt: null,
      dateMet: daysAgoDate((i * 29) % 2500),
    })
  );
  const touches = new Map<string, number>([
    ...covered.map((c, i) => [c.id, 1 + (i % 6)] as [string, number]),
    ...uncovered.map((c) => [c.id, 0] as [string, number]),
  ]);
  const scored = computeClosenessForAll([...covered, ...uncovered], [], touches);

  const uncoveredScores = uncovered.map((c) => scored.get(c.id)!.closeness);
  const spread = Math.max(...uncoveredScores) - Math.min(...uncoveredScores);
  check(
    "  the uncovered 1800 are not all identical",
    spread > 0.01,
    `spread ${spread.toFixed(4)}`
  );

  const coveredRings = covered.map((c) => scored.get(c.id)!.orbitScore);
  check(
    "  covered contacts can earn inner rings",
    coveredRings.some((r) => r >= 4),
    `max ring ${Math.max(...coveredRings)}`
  );
}
```

Extend `person()` in the harness so the new optional fields are settable — add `statedCloseness: 3`, `dateMet: null`, `firstInteractionAt: null`, `coveredByConnectedSource: false` to its defaults object. **Note:** the existing sections 1–9 rely on `person()` defaults; setting `statedCloseness: 3` there keeps them at full stated evidence, which is what preserves their current expected values.

- [ ] **Step 2: Run to verify it fails**

```bash
npx tsx scripts/smoke-closeness.ts
```

Expected: FAIL in section 13 — `blended.evidenced` is `undefined`.

- [ ] **Step 3: Extend the types**

In `src/lib/closeness.ts`:

```ts
export type ClosenessContact = {
  relationshipScore?: number | null;
  /** 1–5 if the user rated them; null means never rated. See closeness-evidence.ts. */
  statedCloseness?: number | null;
  lastInteractionAt?: Date | string | null;
  firstInteractionAt?: Date | string | null;
  dateMet?: Date | string | null;
  createdAt?: Date | string | null;
  /** Orbit-relative affinity signals, supplied by the cohort builder. */
  emailDomainMatchesUser?: boolean;
  companyConcentration?: number;
  schoolConcentration?: number;
  coveredByConnectedSource?: boolean;
  company?: string | null;
  title?: string | null;
  industry?: string | null;
  howMet?: string | null;
  notes?: string | null;
  aiSummary?: string | null;
  keyFacts?: string[] | null;
  sharedInterests?: string[] | null;
  tags?: string[] | null;
};

export type RawClosenessBreakdown = {
  raw: number;
  strength: number;
  recency: number;
  cadence: number;
  goalRelevance: number;
  /** How much we know, 0–1. See closeness-evidence.ts. */
  evidence: number;
  /** The compressed weak-signal estimate. */
  prior: number;
  /** The behaviour-driven score, before blending. Equals `raw` at full evidence. */
  evidenced: number;
};
```

- [ ] **Step 4: Rewrite `strengthComponent` and `computeRawCloseness`**

```ts
/**
 * Stated closeness, 1–5, as a 0–1 term.
 *
 * Falls back to `relationshipScore` for contacts written before
 * `stated_closeness` existed. An unrated contact returns the neutral midpoint
 * rather than the old default of 2/5 — asserting "somewhat distant" about
 * someone nobody has assessed is exactly the bias this change removes. The
 * evidence layer is what stops that neutral value from carrying weight.
 */
export function strengthComponent(
  statedCloseness?: number | null,
  relationshipScore?: number | null
) {
  const stated = statedCloseness ?? relationshipScore;
  if (stated == null) return 0.5;
  return Math.min(5, Math.max(1, stated)) / 5;
}

export function computeRawCloseness(
  contact: ClosenessContact,
  activeGoals: string[] = [],
  touchCount?: number | null
): RawClosenessBreakdown {
  const goals = activeGoals.map((g) => g.trim()).filter(Boolean);
  const hasGoals = goals.length > 0;

  const strength = strengthComponent(
    contact.statedCloseness,
    contact.relationshipScore
  );
  const recency = recencyComponent(contact.lastInteractionAt);
  const cadence = cadenceComponent(touchCount);
  const goalRelevance = hasGoals ? goalRelevanceComponent(contact, goals) : 0;

  const weighted =
    WEIGHTS.strength * strength +
    WEIGHTS.recency * recency +
    WEIGHTS.cadence * cadence +
    (hasGoals ? WEIGHTS.goalRelevance * goalRelevance : 0);

  const totalWeight =
    WEIGHTS.strength +
    WEIGHTS.recency +
    WEIGHTS.cadence +
    (hasGoals ? WEIGHTS.goalRelevance : 0);

  const evidenced = clamp01(weighted / totalWeight);

  const evidence = computeEvidence({
    statedCloseness: contact.statedCloseness,
    touchCount,
    hasLoggedInteraction: !!contact.lastInteractionAt,
    coveredByConnectedSource: contact.coveredByConnectedSource,
  });

  const prior = computePrior({
    firstInteractionAt: contact.firstInteractionAt,
    dateMet: contact.dateMet,
    createdAt: contact.createdAt,
    emailDomainMatchesUser: contact.emailDomainMatchesUser,
    companyConcentration: contact.companyConcentration,
    schoolConcentration: contact.schoolConcentration,
    goalRelevance,
  });

  // The whole design in one line: what we measured, weighted by how much we
  // actually measured, against a deliberately timid guess for the rest.
  const raw = clamp01((1 - evidence) * prior + evidence * evidenced);

  return { raw, strength, recency, cadence, goalRelevance, evidence, prior, evidenced };
}
```

Add the import at the top of `src/lib/closeness.ts`:

```ts
import {
  computeEvidence,
  computePrior,
  EVIDENCE_FLOOR,
  MAX_RING_WITHOUT_EVIDENCE,
} from "@/lib/closeness-evidence";
```

- [ ] **Step 5: Apply the ring ceiling**

In `applyClosenessCohort`, clamp the assigned ring for low-evidence contacts:

```ts
export function applyClosenessCohort(
  raw: RawClosenessBreakdown,
  cohort?: ClosenessCohort
): ClosenessBreakdown {
  const percentile = cohort ? cohortPercentile(raw.raw, cohort) : raw.raw;
  const w = cohort ? cohort.relativeWeight : 0;
  const closeness = clamp01((1 - w) * raw.raw + w * percentile);
  const useQuota = !!cohort && cohort.n >= QUOTA_MIN_N;

  const assignedRing = useQuota
    ? orbitScoreFromPercentile(percentile)
    : closenessToOrbitScore(closeness);

  // Quotas always fill, so without this a cold orbit would hand out a Core ring
  // to whoever happened to sort highest among equally unknown people. Inner and
  // Core are claims about the relationship, and they have to be earned.
  const orbitScore =
    raw.evidence < EVIDENCE_FLOOR
      ? Math.min(assignedRing, MAX_RING_WITHOUT_EVIDENCE)
      : assignedRing;

  const assignedTier = useQuota
    ? tierFromPercentile(percentile)
    : closenessTier(closeness);
  const tier =
    raw.evidence < EVIDENCE_FLOOR && assignedTier === "inner"
      ? "mid"
      : assignedTier;

  return { ...raw, closeness, percentile, orbitScore, tier };
}
```

- [ ] **Step 6: Run to verify it passes**

```bash
npx tsx scripts/smoke-closeness.ts && npm run lint
```

Expected: sections 13–15 pass. Section 4 (ring quotas) uses `person()` defaults which now carry `statedCloseness: 3`, so those contacts clear the evidence floor and quotas still apply — if section 4 fails, the fixture lost its stated value.

- [ ] **Step 7: Commit**

```bash
git add src/lib/closeness.ts scripts/smoke-closeness.ts
git commit -m "Blend the closeness prior against evidence"
```

---

### Task 6: Rank only against contacts we actually know

`relativeWeight` currently fades in on contact *count*, so a 2,000-row import with 12 known people gets full relative ranking over noise. Rebase it onto coverage, and build the ranking distribution from evidenced contacts only.

**Files:**
- Modify: `src/lib/closeness.ts` (`buildClosenessCohort`, `ClosenessCohort`)
- Test: `scripts/smoke-closeness.ts`

**Interfaces:**
- Consumes: `RawClosenessBreakdown.evidence` (Task 5).
- Produces: `buildClosenessCohort(raws: RawClosenessBreakdown[]): ClosenessCohort` — **the signature changes from `number[]` to `RawClosenessBreakdown[]`.** `ClosenessCohort` gains `evidencedN: number` and `coverage: number`.

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/smoke-closeness.ts`:

```ts
console.log("\n16. Ranking uses the people we actually know");
{
  const known = Array.from({ length: 12 }, (_, i) =>
    computeRawCloseness(
      person({ id: `k${i}`, statedCloseness: (i % 5) + 1, lastInteractionAt: daysAgoDate(i * 4) }),
      [],
      3
    )
  );
  const unknown = Array.from({ length: 1988 }, () =>
    computeRawCloseness(
      person({ statedCloseness: null, lastInteractionAt: null }),
      [],
      0
    )
  );

  const cohort = buildClosenessCohort([...known, ...unknown]);
  check(
    "  the distribution holds only evidenced contacts",
    cohort.sortedRaw.length === 12,
    String(cohort.sortedRaw.length)
  );
  check(
    "  low coverage suppresses relative weighting",
    cohort.relativeWeight < 0.1,
    String(cohort.relativeWeight)
  );

  const allKnown = Array.from({ length: 60 }, (_, i) =>
    computeRawCloseness(
      person({ id: `a${i}`, statedCloseness: (i % 5) + 1, lastInteractionAt: daysAgoDate(i * 3) }),
      [],
      4
    )
  );
  const warmCohort = buildClosenessCohort(allKnown);
  check(
    "  full coverage restores relative weighting",
    Math.abs(warmCohort.relativeWeight - 0.5) < 1e-9,
    String(warmCohort.relativeWeight)
  );
  check("  and coverage reports as 1", Math.abs(warmCohort.coverage - 1) < 1e-9);
}
```

Section 3's existing assertions call `buildClosenessCohort` with `number[]` and `new Array(24).fill(0.5)`. **Update those three call sites** to pass `RawClosenessBreakdown[]` — replace `buildClosenessCohort(five.map((c) => computeRawCloseness(c, [], 0).raw))` with `buildClosenessCohort(five.map((c) => computeRawCloseness(c, [], 0)))`, and replace the `new Array(24).fill(0.5)` fixture with 24 evidenced contacts built through `computeRawCloseness`.

- [ ] **Step 2: Run to verify it fails**

```bash
npx tsx scripts/smoke-closeness.ts
```

Expected: FAIL in section 16 — `sortedRaw.length` is 2000, not 12.

- [ ] **Step 3: Implement**

In `src/lib/closeness.ts`:

```ts
export type ClosenessCohort = {
  /** Total contacts scored. */
  n: number;
  /** Contacts whose evidence clears the floor — the ones the distribution is built from. */
  evidencedN: number;
  /** evidencedN / n. The axis relative weighting fades in on. */
  coverage: number;
  /** ascending, evidenced contacts only */
  sortedRaw: number[];
  relativeWeight: number;
};

/** Coverage below this makes rank meaningless; above RELATIVE_FULL_COVERAGE it is fully trusted. */
const RELATIVE_MIN_COVERAGE = 0.1;
const RELATIVE_FULL_COVERAGE = 0.6;

/**
 * Build the distribution contacts are ranked against.
 *
 * Only evidenced contacts contribute. Ranking someone against a tied mass of
 * people we know nothing about tells us nothing — and worse, it lets a large
 * import of strangers push a genuinely close friend down the percentile scale
 * purely by arriving.
 *
 * The fade is on coverage rather than headcount for the same reason: 2,000
 * contacts of whom 12 are known is a *less* reliable ranking than 30 contacts
 * of whom 25 are known, though the old count-based fade rated it higher.
 */
export function buildClosenessCohort(
  raws: RawClosenessBreakdown[]
): ClosenessCohort {
  const n = raws.length;
  const evidenced = raws.filter((r) => r.evidence >= EVIDENCE_FLOOR);
  const sortedRaw = evidenced.map((r) => r.raw).sort((a, b) => a - b);
  const evidencedN = sortedRaw.length;
  const coverage = n === 0 ? 0 : evidencedN / n;

  // Rank still needs a floor of absolute headcount: five known people do not
  // make a distribution however complete their coverage.
  const countGate = clamp01(
    (evidencedN - RELATIVE_MIN_N) / (RELATIVE_FULL_N - RELATIVE_MIN_N)
  );
  const coverageGate = clamp01(
    (coverage - RELATIVE_MIN_COVERAGE) /
      (RELATIVE_FULL_COVERAGE - RELATIVE_MIN_COVERAGE)
  );

  return {
    n,
    evidencedN,
    coverage,
    sortedRaw,
    relativeWeight: RELATIVE_MAX_WEIGHT * Math.min(countGate, coverageGate),
  };
}
```

Update `cohortPercentile` to guard the now-possibly-empty distribution:

```ts
export function cohortPercentile(raw: number, cohort: ClosenessCohort) {
  if (cohort.sortedRaw.length === 0) return 0.5;
  const below = lowerBound(cohort.sortedRaw, raw);
  const equal = upperBound(cohort.sortedRaw, raw) - below;
  return (below + 0.5 * equal) / cohort.sortedRaw.length;
}
```

Update the quota gate in `applyClosenessCohort` to key off evidenced count:

```ts
  const useQuota = !!cohort && cohort.evidencedN >= QUOTA_MIN_N;
```

Update `computeClosenessForAll` to pass full breakdowns:

```ts
  const cohort = buildClosenessCohort(raws);
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx tsx scripts/smoke-closeness.ts && npm run lint
```

Expected: all sections 1–16 pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/closeness.ts scripts/smoke-closeness.ts
git commit -m "Rank closeness only against contacts we have evidence about"
```

---

### Task 7: Wire evidence and affinity through the cohort builder

The pure functions are correct; now the real per-request path has to supply their inputs.

**Files:**
- Modify: `src/lib/closeness-cohort.ts`
- Modify: `src/actions/contacts.ts`, `src/actions/graph.ts`, `src/lib/reminders.ts` (the `preloadedRows` donors — their `columns` selections must gain the new fields or `ClosenessCohortRow` will not typecheck)

**Interfaces:**
- Consumes: everything from Tasks 3–6.
- Produces: `ClosenessCohortResult` gains `coverage: number`.

- [ ] **Step 1: Widen `ClosenessCohortRow`**

```ts
export type ClosenessCohortRow = {
  id: string;
  relationshipScore: number | null;
  statedCloseness: number | null;
  lastInteractionAt: Date | string | null;
  firstInteractionAt: Date | string | null;
  dateMet: Date | string | null;
  createdAt: Date | string;
  email: string | null;
  company: string | null;
  school: string | null;
  title: string | null;
  industry: string | null;
  howMet: string | null;
  aiSummary: string | null;
  keyFacts: string[] | null;
  sharedInterests: string[] | null;
  contactTags: Array<{ tag: { name: string } }>;
};
```

- [ ] **Step 2: Extend the query and compute orbit-relative affinity**

In `buildCohortResult`, add the new columns to the `findMany` selection (`statedCloseness`, `firstInteractionAt`, `dateMet`, `email`, `school`), and add a fourth query to the existing `Promise.all` so it still runs in parallel:

```ts
  const [rows, goalRows, touchRows, settings] = await Promise.all([
    // ...the three existing queries, unchanged...
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
      columns: { email: true },
    }),
    // Whether a mail source is genuinely connected. NOT `userSettings.email`,
    // which is set for every account and would mark the entire orbit as
    // covered — inflating evidence for people we have never actually observed.
    db.query.gmailConnections.findFirst({
      where: eq(gmailConnections.userId, userId),
      columns: { id: true },
    }),
  ]);
```

Destructure that fourth result as `mailConnection`. Import `userSettings` and `gmailConnections` from `@/db/schema`, and `publicEmailDomain` from `@/lib/closeness-evidence`. Then, before scoring:

```ts
  // Orbit-relative affinity. Orbit stores no company or school for the user
  // themselves, so "where has this person overlapped with me" is inferred from
  // the shape of the orbit: an employer holding a large share of your contacts
  // is somewhere you have been. Computed from the rows already in hand — no
  // extra query.
  const companyCounts = new Map<string, number>();
  const schoolCounts = new Map<string, number>();
  for (const c of rows) {
    const co = c.company?.trim().toLowerCase();
    if (co) companyCounts.set(co, (companyCounts.get(co) ?? 0) + 1);
    const sc = c.school?.trim().toLowerCase();
    if (sc) schoolCounts.set(sc, (schoolCounts.get(sc) ?? 0) + 1);
  }
  const maxCompany = Math.max(1, ...companyCounts.values());
  const maxSchool = Math.max(1, ...schoolCounts.values());

  const userDomain = (() => {
    const email = settings?.email?.trim().toLowerCase();
    const domain = email?.split("@")[1];
    if (!domain || publicEmailDomain(domain)) return null;
    return domain;
  })();

  const mailConnected = !!mailConnection;
```

Then in the scoring map:

```ts
  const raws = rows.map((c) => {
    const contactDomain = c.email?.trim().toLowerCase().split("@")[1] ?? null;
    return computeRawCloseness(
      {
        ...c,
        notes: null,
        tags: c.contactTags.map((ct) => ct.tag.name),
        emailDomainMatchesUser:
          !!userDomain && !!contactDomain && contactDomain === userDomain,
        companyConcentration: c.company
          ? (companyCounts.get(c.company.trim().toLowerCase()) ?? 0) / maxCompany
          : 0,
        schoolConcentration: c.school
          ? (schoolCounts.get(c.school.trim().toLowerCase()) ?? 0) / maxSchool
          : 0,
        coveredByConnectedSource: mailConnected && !!c.email,
      },
      goals,
      touchCounts.get(c.id) ?? 0
    );
  });

  const cohort = buildClosenessCohort(raws);
```

Return `coverage: cohort.coverage` in the result object.

- [ ] **Step 3: Update the three `preloadedRows` donors**

Each of `src/actions/contacts.ts:113`, `src/actions/graph.ts:83`, and `src/lib/reminders.ts:362` donates rows. Add the same five columns (`statedCloseness`, `firstInteractionAt`, `dateMet`, `email`, `school`) to each donor's `columns` selection. The `ClosenessCohortRow` type makes a missed one a compile error, which is the point of that type.

- [ ] **Step 4: Verify it compiles and the app runs**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no errors. A missing column in any donor surfaces here.

- [ ] **Step 5: Verify against real data**

Start the worktree preview (demo mode, port 3005 — do not disturb the user's server on 3000) and confirm `/contacts`, `/graph` and the dashboard all render and agree on rings for the same contact.

- [ ] **Step 6: Commit**

```bash
git add src/lib/closeness-cohort.ts src/actions/contacts.ts src/actions/graph.ts src/lib/reminders.ts
git commit -m "Feed evidence and orbit-relative affinity into closeness scoring"
```

---

### Task 8: Preserve relationship age through the LinkedIn import

`Connected On` is parsed and written to `dateMet` but the importer also hardcodes `relationshipScore: 2`, which now means "rated a 2" under Task 1's semantics.

**Files:**
- Modify: `src/lib/import-job-processor.ts:165-177`
- Modify: `src/actions/imports.ts:395-410` (the non-job import path, same fix)

**Interfaces:**
- Consumes: `contacts.statedCloseness` (Task 1).
- Produces: imported contacts with `firstInteractionAt` set from `Connected On` and `statedCloseness` left null.

- [ ] **Step 1: Stop asserting a rating on import**

In `src/lib/import-job-processor.ts`, in the `toCreate.push({ ... })` block, remove the `relationshipScore: 2` line and add:

```ts
              // No statedCloseness: nobody has rated these people, and saying
              // "2 out of 5" about two thousand strangers is exactly the
              // assumption this change removes. The column default keeps
              // relationshipScore at 2 for legacy readers.
              firstInteractionAt: connectedOn ?? undefined,
```

- [ ] **Step 2: Apply the same change to the direct import path**

`src/actions/imports.ts:403` has a parallel `dateMet: connectedOn` creation block. Add `firstInteractionAt: connectedOn ?? undefined` there and drop any hardcoded `relationshipScore`.

- [ ] **Step 3: Verify `ContactInput` accepts the field**

```bash
grep -n "firstInteractionAt" src/lib/contact-writes.ts
```

If `ContactInput` does not include `firstInteractionAt`, add it as `firstInteractionAt?: Date | null` and pass it through to the insert.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit && npm run lint
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/import-job-processor.ts src/actions/imports.ts src/lib/contact-writes.ts
git commit -m "Preserve LinkedIn connection age as relationship age on import"
```

---

### Task 9: Keep `statedCloseness` in sync when the user rates someone

**Files:**
- Modify: `src/actions/contacts.ts` (the update path that writes `relationshipScore`)
- Modify: `src/lib/contact-writes.ts` (`updateContact`)

**Interfaces:**
- Consumes: `contacts.statedCloseness` (Task 1).
- Produces: any write of `relationshipScore` also writes `statedCloseness`.

- [ ] **Step 1: Find every write**

```bash
grep -rn "relationshipScore" src/actions src/lib --include="*.ts" | grep -v closeness
```

- [ ] **Step 2: Mirror the value in `updateContact`**

In `src/lib/contact-writes.ts`, wherever `relationshipScore` is applied to the update payload:

```ts
  // A user moving this slider is the strongest closeness signal we ever get,
  // and it is what lifts the contact above the evidence floor. Mirror it so
  // both readers agree; relationshipScore stays for legacy consumers.
  if (input.relationshipScore != null) {
    payload.relationshipScore = input.relationshipScore;
    payload.statedCloseness = input.relationshipScore;
  }
```

- [ ] **Step 3: Verify the round trip**

Start the preview, open a contact, change its relationship score, and confirm in the DB:

```bash
npx tsx -e "import('./src/db').then(async ({getDb})=>{const db=await getDb();const {sql}=await import('drizzle-orm');const r=await db.execute(sql\`SELECT full_name, relationship_score, stated_closeness FROM contacts WHERE stated_closeness IS NOT NULL LIMIT 5\`);console.log(r.rows);})"
```

Expected: the edited contact appears with matching values.

- [ ] **Step 4: Commit**

```bash
git add src/actions/contacts.ts src/lib/contact-writes.ts
git commit -m "Mirror user closeness ratings into stated_closeness"
```

---

### Task 10: Deepen the one-time calendar backfill

Ongoing sync keeps its 180-day window; the initial connect does a deeper historical pass, because a first-run user's whole problem is that Orbit has no past.

**Files:**
- Modify: `src/actions/imports.ts:888-900` (the windowing filter)

**Interfaces:**
- Consumes: nothing.
- Produces: `CALENDAR_BACKFILL_DAYS` and `CALENDAR_SYNC_DAYS` exported constants.

- [ ] **Step 1: Replace the hardcoded window**

```ts
/** Ongoing sync: recent past plus near future. */
export const CALENDAR_SYNC_DAYS = 180;
/**
 * First connect: reach much further back. A new user's orbit is cold precisely
 * because Orbit has no history, and a year of past meetings is the cheapest
 * real evidence available.
 */
export const CALENDAR_BACKFILL_DAYS = 730;
```

Thread a `backfill?: boolean` option through the function that owns the `// Focus on past 180 days through next 14 days` filter, and use `backfill ? CALENDAR_BACKFILL_DAYS : CALENDAR_SYNC_DAYS` in the cutoff. Pass `backfill: true` from the initial-connect call site only.

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit && npm run lint
```

- [ ] **Step 3: Commit**

```bash
git add src/actions/imports.ts
git commit -m "Reach further back on the first calendar import"
```

---

### Task 11: Promote the LinkedIn messages import into the wizard

The messages import already works end to end and writes real dated interactions — it is the strongest cold-start signal available and needs no OAuth. It is simply buried where a first-run user never finds it.

**Files:**
- Modify: `src/components/onboarding/wizard/wizard-import.tsx`

**Interfaces:**
- Consumes: the existing `LinkedInMessagesImport` component.
- Produces: no new exports.

- [ ] **Step 1: Read what the wizard import step currently offers**

```bash
cat src/components/onboarding/wizard/wizard-import.tsx
```

- [ ] **Step 2: Add the messages import beside the connections import**

Present it as a recommended second step rather than an alternative, with copy that states the actual reason plainly — for example: *"Connections tell Orbit who you know. Messages tell it who you actually talk to."* Reuse `LinkedInMessagesImport` from `src/components/imports/linkedin-messages-import.tsx`; do not duplicate its logic. Follow the existing card/step styling in the file rather than inventing a new treatment.

- [ ] **Step 3: Verify in the preview**

Start the worktree preview on port 3005, walk the wizard to the import step, and confirm both imports render and the messages upload completes.

- [ ] **Step 4: Commit**

```bash
git add src/components/onboarding/wizard/wizard-import.tsx
git commit -m "Offer the LinkedIn messages import during setup"
```

---

### Task 12: Shortlist triage step

The user teaches Orbit directly. Candidate selection deliberately does **not** rank by current closeness — that would re-surface whoever a connected source happened to cover and learn nothing.

**Files:**
- Create: `src/lib/triage-candidates.ts`
- Create: `src/components/onboarding/wizard/wizard-triage.tsx`
- Modify: `src/components/onboarding/wizard/setup-wizard.tsx:15-62` (the `WizardStep` union, `STEP_TITLES`, `isValidStep`, and the render switch)
- Modify: `src/actions/contacts.ts` (bulk rating action)
- Test: `scripts/smoke-closeness.ts`

**Interfaces:**
- Consumes: `ClosenessBreakdown.evidence`, `EVIDENCE_FLOOR`.
- Produces:
  - `selectTriageCandidates(contacts: TriageCandidate[], limit?: number): TriageCandidate[]`
  - `type TriageCandidate = { id: string; fullName: string; company: string | null; evidence: number; prior: number; statedCloseness: number | null }`
  - Server action `rateContacts(ratings: Array<{ contactId: string; closeness: number }>): Promise<{ updated: number }>`

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/smoke-closeness.ts`:

```ts
console.log("\n17. Triage asks about the people we cannot guess");
{
  const candidate = (
    id: string,
    evidence: number,
    prior: number,
    stated: number | null = null,
    company: string | null = "Acme"
  ) => ({ id, fullName: id, company, evidence, prior, statedCloseness: stated });

  const pool = [
    ...Array.from({ length: 20 }, (_, i) => candidate(`known${i}`, 0.9, 0.4)),
    ...Array.from({ length: 20 }, (_, i) => candidate(`strong${i}`, 0, 0.58)),
    ...Array.from({ length: 200 }, (_, i) => candidate(`weak${i}`, 0, 0.31)),
    ...Array.from({ length: 20 }, (_, i) => candidate(`rated${i}`, 0.9, 0.4, 4)),
  ];

  const picked = selectTriageCandidates(pool, 40);
  check("  the shortlist is capped", picked.length === 40, String(picked.length));
  check(
    "  already-rated contacts are never asked about again",
    picked.every((c) => c.statedCloseness == null)
  );
  check(
    "  high-prior unknowns are represented",
    picked.some((c) => c.id.startsWith("strong"))
  );
  check(
    "  high-evidence unrated contacts are represented",
    picked.some((c) => c.id.startsWith("known"))
  );
  check(
    "  the shortlist is not purely whoever we already know",
    picked.filter((c) => c.evidence >= EVIDENCE_FLOOR).length < picked.length,
    `${picked.filter((c) => c.evidence >= EVIDENCE_FLOOR).length}/${picked.length}`
  );
  check("  no duplicates", new Set(picked.map((c) => c.id)).size === picked.length);
}
```

Import `selectTriageCandidates` from `../src/lib/triage-candidates`.

- [ ] **Step 2: Run to verify it fails**

```bash
npx tsx scripts/smoke-closeness.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement candidate selection**

Create `src/lib/triage-candidates.ts`:

```ts
import { EVIDENCE_FLOOR } from "@/lib/closeness-evidence";

export type TriageCandidate = {
  id: string;
  fullName: string;
  company: string | null;
  evidence: number;
  prior: number;
  statedCloseness: number | null;
};

/** Roughly five screens of eight. */
export const TRIAGE_LIMIT = 40;

/** Shares of the shortlist drawn from each pool. */
const POOL_SHARES = { highEvidence: 0.35, highPrior: 0.45, diversity: 0.2 } as const;

/**
 * Choose who to ask about.
 *
 * Deliberately NOT "the current top 40 by closeness". That list is dominated by
 * whoever a connected source happened to cover, so asking about them confirms
 * what Orbit already knows and learns nothing. The shortlist is built for
 * information gain instead:
 *
 *   1. High evidence, unrated — calibrates the scale against people whose
 *      behaviour we can already see.
 *   2. High prior, no evidence — maximum uncertainty. These are the ones the
 *      system genuinely cannot guess, so an answer moves them furthest.
 *   3. A diversity sample across employers, so the shortlist does not collapse
 *      onto whichever company dominates the orbit.
 */
export function selectTriageCandidates(
  contacts: TriageCandidate[],
  limit: number = TRIAGE_LIMIT
): TriageCandidate[] {
  // Asking twice wastes the user's only scarce resource here: patience.
  const eligible = contacts.filter((c) => c.statedCloseness == null);

  const picked: TriageCandidate[] = [];
  const taken = new Set<string>();

  const take = (pool: TriageCandidate[], count: number) => {
    for (const c of pool) {
      if (picked.length >= limit || count <= 0) break;
      if (taken.has(c.id)) continue;
      taken.add(c.id);
      picked.push(c);
      count--;
    }
  };

  const highEvidence = eligible
    .filter((c) => c.evidence >= EVIDENCE_FLOOR)
    .sort((a, b) => b.evidence - a.evidence);

  const highPrior = eligible
    .filter((c) => c.evidence < EVIDENCE_FLOOR)
    .sort((a, b) => b.prior - a.prior);

  take(highEvidence, Math.round(limit * POOL_SHARES.highEvidence));
  take(highPrior, Math.round(limit * POOL_SHARES.highPrior));

  // Diversity: one pass taking the best remaining candidate per company before
  // any company gets a second slot.
  const byCompany = new Map<string, TriageCandidate[]>();
  for (const c of eligible) {
    if (taken.has(c.id)) continue;
    const key = c.company?.trim().toLowerCase() || "__none__";
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key)!.push(c);
  }
  for (const list of byCompany.values()) {
    list.sort((a, b) => b.prior - a.prior);
  }
  const roundRobin: TriageCandidate[] = [];
  let depth = 0;
  let added = true;
  while (added && roundRobin.length < limit) {
    added = false;
    for (const list of byCompany.values()) {
      if (list[depth]) {
        roundRobin.push(list[depth]);
        added = true;
      }
    }
    depth++;
  }
  take(roundRobin, limit - picked.length);

  // Backfill if a pool ran dry, so a small orbit still gets a full shortlist.
  take([...highPrior, ...highEvidence], limit - picked.length);

  return picked.slice(0, limit);
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx tsx scripts/smoke-closeness.ts && npm run lint
```

- [ ] **Step 5: Commit the selection logic**

```bash
git add src/lib/triage-candidates.ts scripts/smoke-closeness.ts
git commit -m "Select triage candidates by information gain"
```

- [ ] **Step 6: Add the bulk rating server action**

In `src/actions/contacts.ts`:

```ts
export async function rateContacts(
  ratings: Array<{ contactId: string; closeness: number }>
): Promise<{ updated: number }> {
  const userId = await requireUserId();
  const db = await getDb();
  let updated = 0;

  for (const { contactId, closeness } of ratings) {
    const value = Math.min(5, Math.max(1, Math.round(closeness)));
    const res = await db
      .update(contacts)
      .set({
        statedCloseness: value,
        relationshipScore: value,
        updatedAt: new Date(),
      })
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
    if (res.rowCount) updated++;
  }

  revalidatePath("/contacts");
  revalidatePath("/graph");
  revalidatePath("/dashboard");
  return { updated };
}
```

Match the existing auth helper and revalidation conventions in that file rather than the names above if they differ.

- [ ] **Step 7: Build the triage step UI**

Create `src/components/onboarding/wizard/wizard-triage.tsx`. Requirements:

- Loads candidates via `selectTriageCandidates` over the user's contacts.
- Presents them **eight at a time**, each with name, company, title and avatar, and a 1–5 closeness control matching the existing contact-detail control's visual language.
- A "skip this person" affordance — leaving someone unrated must be as easy as rating them, or the ratings become noise.
- Progress indication across screens.
- Calls `rateContacts` per screen, not once at the end, so a user who abandons halfway keeps what they gave.
- Skippable entirely, and resumable via the existing `wizardStep` persistence.

Follow the styling of `wizard-review.tsx`; do not introduce new design tokens.

- [ ] **Step 8: Register the step**

In `setup-wizard.tsx`, add `"triage"` to the `WizardStep` union, `STEP_TITLES`, `isValidStep`, and the render switch. Place it after `import` and before `review`, so the user rates people they have just imported.

- [ ] **Step 9: Verify end to end**

Start the preview, run the wizard from `intro` through `triage`, rate a screen, and confirm the constellation on `/graph` visibly reorganises — rated contacts should now be able to occupy rings 4–5 where before nothing could.

- [ ] **Step 10: Commit**

```bash
git add src/components/onboarding/wizard/wizard-triage.tsx src/components/onboarding/wizard/setup-wizard.tsx src/actions/contacts.ts
git commit -m "Add shortlist triage to the setup wizard"
```

---

### Task 13: Full-harness verification and tuning pass

Every constant so far is a starting value. This task is where they get earned.

**Files:**
- Modify: `src/lib/closeness-evidence.ts` (constants only)
- Modify: `scripts/smoke-closeness.ts`

- [ ] **Step 1: Run the whole harness**

```bash
npx tsx scripts/smoke-closeness.ts
```

Expected: sections 1–17 all pass.

- [ ] **Step 2: Add a cold-orbit histogram**

Section 5 already prints a distribution histogram. Add the same treatment for a pure cold import (the section 14 fixture), so the shape of a day-one orbit is inspectable rather than merely asserted. Reuse the existing `histogram` helper by lifting it to module scope.

- [ ] **Step 3: Inspect and tune**

Look at the printed cold-orbit histogram. It should show a spread across rings 1–3 with no pile-up in a single bin. If it is degenerate, adjust `PRIOR_WEIGHTS` in `closeness-evidence.ts` — not the assertions. Re-run after each change.

- [ ] **Step 4: Confirm the warm-orbit no-op still holds**

The section 13 assertion `full evidence reproduces the evidenced score exactly` is the load-bearing claim of the entire design. Confirm it passes. If any tuning broke it, the tuning is wrong, not the assertion.

- [ ] **Step 5: Verify in the running app**

Seed a cold fixture and confirm on `/graph` that the constellation has visible structure, no contact sits in Core, and the dashboard's inner-tie count reads zero rather than an invented number.

- [ ] **Step 6: Commit**

```bash
git add src/lib/closeness-evidence.ts scripts/smoke-closeness.ts
git commit -m "Tune cold-start closeness constants against the harness"
```

---

## Self-Review Notes

**Spec coverage:** Layer 1 → Tasks 2, 8, 10, 11. Layer 2 → Tasks 1, 9. Layer 3 → Tasks 3, 4, 5. Layer 4 → Tasks 6, 7. Layer 5 → Task 12. Testing section → assertions distributed across Tasks 2–6 and 12, consolidated in Task 13.

**Known signature changes** that ripple and must be handled where they appear:
- `recencyComponent` loses its second parameter (Task 2).
- `strengthComponent` gains a first parameter and shifts `relationshipScore` to second (Task 5).
- `buildClosenessCohort` takes `RawClosenessBreakdown[]` instead of `number[]` (Task 6) — this breaks three existing call sites in section 3 of the harness, called out explicitly in that task.
- `ClosenessCohort.n` still means total contacts; `evidencedN` is the new distribution size. Anything reading `cohort.n` for distribution length must move to `evidencedN`.
