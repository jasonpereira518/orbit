# Sprint B — First Run Without a Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new Free account can use AI from its first minute: 25 starter credits, then 10 credits a month. Every "AI can't run" moment says the same thing, with the refill date. Onboarding goes people first. The tour and a localhost seed speak to students and new grads.

**Architecture:**
- **B1 (credits).** Free joins the existing credit ledger instead of a parallel path. `PLAN_CONFIG.free` gets `monthlyCredits: 10` and `hostedAi: true`, so `managedEligibility` returns `"plan"` and the allowance, hold and settle machinery used by Pro and Max applies unchanged. A new `credit_grants.kind = "starter"` row, created once per account inside `ensureAllowance`, sits second in the spend order.
- **B2 (one notice).** The plan-aware shared notice is `AiKeyNotice`, fed through the `ViewerPlan` context: plan, the settings-level AI denial and the credit reset date. It replaces each surface's own copy.
- **B3 to B5.** Onboarding, persona and capture changes are local edits behind their own pure helpers, and each helper is pinned by a smoke.

**Tech Stack:** Next.js 16 App Router, React 19 Server Actions, Drizzle on PGlite (smokes and local) or Neon, Tailwind v4. Tests are `scripts/smoke-*.ts`, run by `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-10-08-sprint-b-first-run-design.md`

## Global Constraints

- **Tests.** Every test is a `scripts/smoke-*.ts` file registered in the `MANIFEST` in `scripts/run-smoke.ts` (`pure` or `pglite`). DB smokes start with `import "./smoke/_env";`. Run one with `npx tsx scripts/<name>.ts`.
- **Shared suite DB.** The pglite tier shares ONE PGlite across the suite. A smoke that changes shared state (surface flags, plan rows, env vars, grants for a shared user) restores it in its `cleanup()`.
- **One key path.** `src/lib/ai-access.ts` stays the only path to a provider key (`smoke-ai-access` source guard).
- **Pricing.** Every managed model call stays priced in `ai-pricing.ts`.
- **No schema change and no `SCHEMA_VERSION` bump.** The new grant kind and plan value are type-level (`credit_grants.kind` and `.plan` are plain text with no CHECK).
- **Copy rules.** New copy has no trailing period, uses curly apostrophes (’) and contains at most one " — ".
- **Tailwind.** No Tailwind class names inside code comments. Device switches are `md:` classes, never `useIsMobile`.
- **Terms version.** `TERMS_VERSION` bumps exactly once, in Task 4, and `LEGAL_LAST_UPDATED` changes in the same commit.
- **Server-action files.** A `"use server"` file exports only async functions.
- **Gate commands.** `npx tsc --noEmit` and `npx eslint src scripts` must pass after every task. `smoke-radar-run` is red on `main` and is excluded from the bar.
- **Commits.** Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Working directory.** All work happens in `/Users/jasonpereira/Projects/claude-worktrees/orbit/sprint-b-first-run` on branch `claude/sprint-b-first-run`. Never run `npm run db:push`.

## Review Focus

These five conditions are what the spec implies but no happy-path test hits. Each one has its pinning test in the task named.

1. **A Free account that already has a saved key** keeps running on its own key: no credits are spent and no starter grant is spent. The completion is `personal` and the balance is unchanged after the call (Task 2).
2. **A Free account downgraded from Pro with unspent pack credits.** Its calls run on Free's allowance and starter, and the pack balance stays frozen and untouched (Task 2).
3. **Free account at exactly zero.** It is refused with the Free-specific out-of-credits message, which `aiDenialFromMessage` reads as `managed_limit`, and nothing is sent to a provider (Task 2).
4. **Allowance spent, starter left.** The "80% used" in-app alert must NOT fire while starter credits remain. Firing would show "0 credits left this cycle" to someone with 25 left (Task 3).
5. **A stored `onboarding_step` of `linkedin`, `ai-key` or a tour-path `import`** resumes on the path's first main-line step after welcome, never on a retired screen and never on welcome (Task 8).

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/lib/plans/plan-config.ts` | Free gets 10 monthly credits, `hostedAi`, and `FREE_STARTER_CREDITS` | 1 |
| `src/db/schema.ts` | Type-only widening of `creditGrants.kind` and `.plan` | 1 |
| `src/lib/credits/ledger.ts` | Starter grant, spend order, `starterRemaining` in the balance | 1 |
| `src/lib/ai-access-copy.ts` | Free out-of-credits refusal and notice copy | 2, 3, 5, 9 |
| `src/lib/ai-access.ts` | Free refusal message; `aiDenialFromSettings` | 2, 5 |
| `src/lib/credits/notices.ts` | No credit emails to Free | 3 |
| `src/lib/account-health.ts`, `src/lib/account-alerts.ts` | Starter-aware credit alerts; Free copy | 3 |
| `src/actions/credits.ts`, `src/components/credits/credits-card.tsx` | Free credits card, low-credit line, `getFreeCreditsLeft` | 3 |
| Legal, pricing and plan-copy files | Free includes AI | 4 |
| `src/components/viewer-plan.tsx`, `src/app/(clerk)/(app)/layout.tsx` | `aiReason` and `creditsResetAt` in context | 5 |
| `src/components/ai-key-notice.tsx` | Free out-of-credits state, `draft` feature | 5 |
| Radar, dashboard, ask bar, draft sheets, brief and constellation refresh | Use the shared notice and shared copy | 5–7 |
| `src/lib/onboarding-steps.ts`, `src/components/onboarding/*`, `src/actions/onboarding.ts` | People-first paths; retired-step resume | 8, 9 |
| `src/components/linkedin/*` (new), `src/lib/linkedin-export-card.ts` (new) | Start-your-export card on dashboard and /imports | 10 |
| `src/lib/onboarding-examples/cast.ts`, `src/lib/tour/tour-stops.ts` | Early-career tour cast | 11 |
| `src/lib/demo-data/student.ts` (new), `seed.ts`, `ensure.ts`, `scripts/seed-showcase.ts` | Student persona | 12 |
| `src/lib/capture/review-reducer.ts`, `src/components/capture/capture-flow.tsx`, `capture-summary.tsx` | Save pending and the follow-up "why" line | 13 |

---

### Task 1: Ledger — Free allowance, starter grant, spend order

**Files:**
- Modify: `src/lib/plans/plan-config.ts` (the `PLAN_CONFIG.free` block; the `hostedAi` line in the `FEATURE_KEYS` doc comment)
- Modify: `src/db/schema.ts:4721` (`kind`) and `:4724` (`plan`). These are type-only changes, plus the `creditGrants` doc comment above them (~4700-4714).
- Modify: `src/lib/credits/ledger.ts` (`ensureAllowance`, `spendableSql`, `settleCredits`, `CreditBalance`, `getCreditBalance`, header comment)
- Modify: `scripts/smoke-credits.ts` (the "Free and Lifetime get no allowance" check, ~110-113)
- Modify: `scripts/smoke-entitlements.ts:84`

**Interfaces:**
- Produces:
  - `FREE_STARTER_CREDITS = 25`, exported from `plan-config.ts`.
  - `PLAN_CONFIG.free.monthlyCredits === 10` and `PLAN_CONFIG.free.features.hostedAi === true`.
  - `ensureStarterGrant(userId: string): Promise<void>`, exported from `ledger.ts`. Callers normally reach it via `ensureAllowance`.
  - `CreditBalance.starterRemaining: number`, in micros.
  - `creditGrants.kind` type `"allowance" | "starter" | "pack" | "adjustment"`; `creditGrants.plan` type `"free" | "orbit" | "max"`.

- [ ] **Step 1: Write the failing test.** In `scripts/smoke-credits.ts`, replace the two lines `await ledger.ensureAllowance(USER, "free", cycle1); await ledger.ensureAllowance(USER, "lifetime", cycle1);` and the check after them with:

```ts
  await ledger.ensureAllowance(USER, "lifetime", cycle1);
  check("Lifetime gets no allowance", (await db.select().from(creditGrants).where(eq(creditGrants.userId, USER))).length === 1);

  console.log("\nFree: 10 a month plus 25 to start");
  await reset();
  const month = ledger.creditPeriodFor(null);
  await ledger.ensureAllowance(USER, "free", month);
  await ledger.ensureAllowance(USER, "free", month);
  grants = await db.select().from(creditGrants).where(eq(creditGrants.userId, USER));
  const freeAllowance = grants.filter((g) => g.kind === "allowance");
  const starter = grants.filter((g) => g.kind === "starter");
  check("Free gets one 10-credit allowance on the calendar month",
    freeAllowance.length === 1 && freeAllowance[0].microsGranted === 10 * 10_000 && freeAllowance[0].plan === "free" &&
      freeAllowance[0].periodStart?.getTime() === month.start.getTime(), freeAllowance);
  check("…and exactly one 25-credit starter grant, with no period",
    starter.length === 1 && starter[0].microsGranted === 25 * 10_000 && starter[0].grantKey === `starter:${USER}` &&
      starter[0].periodStart === null && starter[0].periodEnd === null, starter);
  let fbal = await ledger.getCreditBalance(USER, "free", null);
  check("the balance shows 35 spendable, 25 of them starter",
    fbal.spendable === 35 * 10_000 && fbal.starterRemaining === 25 * 10_000 && fbal.allowance?.granted === 10 * 10_000, fbal);

  await ledger.settleCredits({ userId: USER, operation: "x", micros: 12 * 10_000 });
  grants = await db.select().from(creditGrants).where(eq(creditGrants.userId, USER));
  check("spending takes the monthly allowance first, then starter",
    grants.find((g) => g.kind === "allowance")?.microsRemaining === 0 &&
      grants.find((g) => g.kind === "starter")?.microsRemaining === 23 * 10_000, grants.map((g) => [g.kind, g.microsRemaining]));
  await db.insert(creditGrants).values({ userId: USER, kind: "adjustment", grantKey: `adj:smoke:${USER}`, microsGranted: 5 * 10_000, microsRemaining: 5 * 10_000 });
  await ledger.settleCredits({ userId: USER, operation: "x", micros: 24 * 10_000 });
  grants = await db.select().from(creditGrants).where(eq(creditGrants.userId, USER));
  check("…then adjustments once the starter is gone",
    grants.find((g) => g.kind === "starter")?.microsRemaining === 0 &&
      grants.find((g) => g.kind === "adjustment")?.microsRemaining === 4 * 10_000, grants.map((g) => [g.kind, g.microsRemaining]));

  const nextMonth = { start: month.end, end: new Date(Date.UTC(month.end.getUTCFullYear(), month.end.getUTCMonth() + 1, 1)) };
  const inNext = new Date(month.end.getTime() + DAY);
  await ledger.ensureAllowance(USER, "free", nextMonth, inNext);
  grants = await db.select().from(creditGrants).where(eq(creditGrants.userId, USER));
  check("next month brings a fresh 10 and never a second starter",
    grants.filter((g) => g.kind === "starter").length === 1 &&
      grants.some((g) => g.kind === "allowance" && g.periodStart?.getTime() === nextMonth.start.getTime() && g.microsRemaining === 10 * 10_000));

  console.log("\nPaid plans never get a starter; a downgrade keeps one");
  await reset();
  await ledger.ensureAllowance(USER, "orbit", cycle1);
  check("Pro gets no starter", (await db.select().from(creditGrants).where(eq(creditGrants.userId, USER))).every((g) => g.kind !== "starter"));
  await reset();
  await ledger.ensureAllowance(USER, "free", ledger.creditPeriodFor(null));
  fbal = await ledger.getCreditBalance(USER, "orbit", null, new Date(), { ensure: false });
  check("an account that had a starter keeps spending it on another plan", fbal.starterRemaining === 25 * 10_000 && fbal.spendable >= 25 * 10_000, fbal);
```
`grants` is declared earlier in the file with `let` (it is reassigned in the "Pro → Max" block). If it is not in scope here, declare it with `let grants = …` at its first use in this block.

In `scripts/smoke-entitlements.ts:84`, change the free row's `credits: null` to `credits: 10` and `hostedAi: false` to `hostedAi: true`. Leave `packs: false`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx scripts/smoke-credits.ts; npx tsx scripts/smoke-entitlements.ts`
Expected: FAIL on "Free gets one 10-credit allowance…" and on the free "monthly credits" and "managed AI" rows.

- [ ] **Step 3: Implement**

`src/lib/plans/plan-config.ts`:
- Under `FREE_CONTACT_LIMIT`, add:

```ts
/** A Free account's one-time AI grant, spent after each month's allowance. Never renews. */
export const FREE_STARTER_CREDITS = 25;
```
- In `PLAN_CONFIG.free`, set `monthlyCredits: 10` and `hostedAi: true`. Keep `creditPacks: false`.
- In the `FEATURE_KEYS` doc comment, the `hostedAi` line becomes `` - `hostedAi`: AI on Orbit's provider keys, metered in credits (Free, Pro and Max; not Lifetime). ``

`src/db/schema.ts`:
- `kind` becomes `.$type<"allowance" | "starter" | "pack" | "adjustment">()`.
- `plan` becomes `.$type<"free" | "orbit" | "max">()`.
- In the table's doc comment:
  - Add the bullet ` *  - starter: always (a Free account's one-time grant, \`starter:<user>\`).`
  - The spend-order sentence becomes "Consumption spends allowance first, then starter, then adjustments, then packs oldest-first."

`src/lib/credits/ledger.ts`:
1. Change the import to `import { FREE_STARTER_CREDITS, PLAN_CONFIG, type Plan } from "@/lib/plans/plan-config";`.
2. In the header comment:
   - Add the bullet `- the starter grant always;`.
   - The spend sentence becomes "Spending takes allowance first, then starter, then adjustments, then packs oldest-first."
3. Above `ensureAllowance`, add:

```ts
/**
 * A Free account's one-time starter grant. `starter:<user>` is unique, so this is idempotent,
 * and a deleted account's anonymised row keeps the key, so the same user id never gets two.
 */
export async function ensureStarterGrant(userId: string): Promise<void> {
  const micros = creditsToMicros(FREE_STARTER_CREDITS);
  const db = await getDb();
  await db
    .insert(creditGrants)
    .values({ userId, kind: "starter", grantKey: `starter:${userId}`, microsGranted: micros, microsRemaining: micros })
    .onConflictDoNothing({ target: creditGrants.grantKey });
}
```
4. In `ensureAllowance`, replace the first two body lines with:

```ts
  const credits = PLAN_CONFIG[plan].monthlyCredits;
  if (!credits || plan === "lifetime") return;
  if (plan === "free") await ensureStarterGrant(userId);
```
5. In `spendableSql`, replace `OR g.kind = 'adjustment'` with `OR g.kind IN ('adjustment', 'starter')`.
6. In `settleCredits`:
   - The window becomes `ORDER BY CASE g.kind WHEN 'allowance' THEN 0 WHEN 'starter' THEN 1 WHEN 'adjustment' THEN 2 ELSE 3 END, g.created_at, g.id`.
   - The filter becomes `OR g.kind IN ('starter', 'adjustment', 'pack')`.
   - The doc reads "allowance first, then starter, then adjustments, then packs oldest-first".
7. In `CreditBalance`:
   - After `allowance`, add:

```ts
  /** A Free account's one-time starter credits still unused, in micros (0 when none). */
  starterRemaining: number;
```
   - The `spendable` doc becomes `/** What the next call can draw on: allowance + starter + adjustments + usable packs − held. */`.
8. In `getCreditBalance`:
   - After `adjustments`, add `const starterRemaining = grants.filter((g) => g.kind === "starter").reduce((sum, g) => sum + g.microsRemaining, 0);`.
   - Return `starterRemaining`.
   - `spendable` becomes `Math.max(0, allowanceRemaining + starterRemaining + adjustments + (usable ? packRemaining : 0) - held)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-credits.ts && npx tsx scripts/smoke-entitlements.ts && npx tsx scripts/smoke-admin-credits.ts && npx tsc --noEmit`
Expected: PASS.
- `tsc` may flag literals typed as `CreditBalance`; add `starterRemaining: 0` to them.
- `smoke-ai-access` is expected to fail until Task 2, so do not run it here.

- [ ] **Step 5: Commit**

```bash
git add src/lib/plans/plan-config.ts src/db/schema.ts src/lib/credits/ledger.ts scripts/smoke-credits.ts scripts/smoke-entitlements.ts
git commit -m "Credits: Free gets 10 a month and a one-time 25-credit starter grant

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The AI gate for Free — refusal copy and `smoke-ai-access`

**Files:**
- Modify: `src/lib/ai-access-copy.ts`
- Modify: `src/lib/ai-access.ts` (`holdCredits`, ~586-600)
- Modify: `src/lib/managed-ai-policy.ts`, comments only (the header "THE RULE" and the `AiAccessDenial` doc)
- Modify: `scripts/smoke-ai-access.ts`, the Free expectations at ~330-341, 363, 528-531, 556-565, 592-594, 709-718 and 765-830

**Interfaces:**
- Consumes: the Task 1 ledger.
- Produces:
  - `FREE_LIMIT_MESSAGE: string` in `ai-access-copy.ts`.
  - `aiDenialFromMessage(FREE_LIMIT_MESSAGE) === "managed_limit"`.
  - `FREE_LIMIT_MESSAGE` is a member of `AI_ACCESS_MESSAGES`.

- [ ] **Step 1: Rewrite the Free expectations in `scripts/smoke-ai-access.ts`.** Each change below is a test that fails now.

1. **`purePolicy` (~330-341).** Replace the "Free and Lifetime never are" check and the four `Free + …` checks with:

```ts
  check("Free is eligible for its small allowance; Lifetime never is",
    managedEligibility("free", false) === "plan" && managedEligibility("lifetime", false) === null);
  check("a (localhost) demo account is 'demo'", managedEligibility("free", true) === "demo");
  // `facts({})` has eligibility null: Lifetime's case now.
  check("no eligibility + own key → their key", pick(facts({ personal: own })) === "personal:gemini:gemini-3.5-flash");
  check("no eligibility + no key → refused, never Orbit's key", pick(facts({ managed: { gemini: true, openai: true, anthropic: true, openrouter: true } })) === "refused:key_required");
```
   At ~363, relabel "Anthropic-only on Free → refused" as "Anthropic-only with no eligibility → refused". The expression is unchanged.

2. **`realGate` (~528-531).** Replace the two `U.freeNone` refusal checks with:

```ts
  r = await lastSent(() => json(U.freeNone));
  check("Free + no key: Orbit's managed key went on the wire", r.req?.key === MANAGED, r.req?.key ?? r.err);
  check("…at the managed model", (r.req?.url ?? "").includes(`models/${MANAGED_DEFAULT_MODELS.gemini}:`), r.req?.url);
  await settle();
  const freeBal = await getCreditBalance(U.freeNone, "free", null);
  check("…metered: the starter is granted and the allowance is charged first",
    freeBal.starterRemaining === 25 * 10_000 && (freeBal.allowance?.remaining ?? 0) < 10 * 10_000, freeBal);
  const freeOwnBefore = await getCreditBalance(U.freeOwn, "free", null);
  r = await lastSent(() => json(U.freeOwn));
  await settle();
  const freeOwnAfter = await getCreditBalance(U.freeOwn, "free", null);
  check("Free + own key spends nothing",
    r.req?.key === USER_KEY && freeOwnAfter.spendable === freeOwnBefore.spendable, [freeOwnBefore.spendable, freeOwnAfter.spendable]);
```
   Import `getCreditBalance` from `../src/lib/credits/ledger` if it is not already imported. For the `U.freeNone` embedding (~556-557) and transcription (~561-565) checks, expect `r.req?.key === MANAGED` instead of a refusal, and relabel them.

3. **Status (~592-594).** Replace the "Free + no key → add a key" check with:

```ts
  check("Free + no key → ready on Orbit's, with 10 monthly credits",
    (await status(U.freeNone)) === "true:null:managed" && (await getAiAccessStatus(U.freeNone)).credits?.monthlyCredits === 10);
```
   Then add a new block:

```ts
  console.log("\nFree at zero");
  await db.update(creditGrants).set({ microsRemaining: 0 }).where(eq(creditGrants.userId, U.freeNone));
  r = await lastSent(() => json(U.freeNone, "chat.answer"));
  check("refused with the Free out-of-credits copy, nothing sent",
    isAiAccessError(r.err) && (r.err as AiAccessError).reason === "managed_limit" &&
      (r.err as Error).message === FREE_LIMIT_MESSAGE && r.count === 0, r.err);
  check("…which the client reads back as managed_limit", aiDenialFromMessage(FREE_LIMIT_MESSAGE) === "managed_limit");
  check("…and the status agrees", (await status(U.freeNone)) === "false:managed_limit:managed");
```
   Import `FREE_LIMIT_MESSAGE` and `aiDenialFromMessage` from `../src/lib/ai-access-copy`.

4. **Downgrade freeze (~709-718).** Replace `check("on Free the pack cannot be spent", …)`, the old `const frozen` line and its "nothing was deleted or zeroed" check with:

```ts
  check("on Free the call runs on Free's own allowance", r.req?.key === MANAGED, r.err);
  await settle();
  const frozen = await remaining(U.capped);
  check("…and the pack is frozen, untouched",
    frozen.pack === afterPack.pack && frozen.grants.some((g) => g.kind === "pack" && g.status === "active"), frozen);
```

5. **`localDevAndByok` (~765-830).**
   - Change `keyless` to `[U.lifetimeNone, U.compNone]`.
   - Relabel the section "Lifetime and a comped Lifetime stay bring-your-own-key".
   - Leave `byokUsers` as `[...keyless, U.lifetimeOwn, U.freeOwn]`.
   - After the `keyless` loop, add:

```ts
    for (const u of [U.freeNone, U.demoNone]) {
      const r = await lastSent(() => json(u));
      check(`${u}: a deployed Free account runs metered on Orbit's managed key`, r.req?.key === MANAGED, r.req?.key ?? r.err);
    }
```
   - Rewrite the function's doc comment: Free, including a deployed showcase on Free, is metered on Orbit's key; Lifetime stays BYOK; `next dev` still runs on `.env.local`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-ai-access.ts`
Expected: FAIL. It may fail to compile (no `FREE_LIMIT_MESSAGE`), or fail on "refused with the Free out-of-credits copy".

- [ ] **Step 3: Implement**

`src/lib/ai-access-copy.ts`, after `MANAGED_PROVIDER_FAILURE_MESSAGE`:

```ts
/**
 * A Free account at zero. Keeps "API key" so `isMissingAiApiKeyError` flips every notice, and
 * `aiDenialFromMessage` maps it to `managed_limit` by exact match.
 */
export const FREE_LIMIT_MESSAGE = "You’ve used this month’s AI credits — add your own API key in Settings for no limit";
```
- Add it to `AI_ACCESS_MESSAGES`.
- In `aiDenialFromMessage`, after the `MANAGED_PROVIDER_FAILURE_MESSAGE` line, add `if (message === FREE_LIMIT_MESSAGE) return "managed_limit";`.

`src/lib/ai-access.ts`:
- Import `FREE_LIMIT_MESSAGE`.
- In `holdCredits`, change the refusal to:

```ts
    if (!hold) throw this.refusal("managed_limit", this.plan === "free" ? FREE_LIMIT_MESSAGE : undefined);
```

`src/lib/managed-ai-policy.ts`, comments only:
- THE RULE: Free gets a small monthly allowance plus a one-time starter on Orbit's keys; Pro and Max include more; Lifetime is own-key only.
- `key_required`: "Lifetime (or an account whose included AI is paused)…".
- `managed_unavailable` and `managed_limit`: say "Free, Pro or Max".

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-ai-access.ts && npx tsx scripts/smoke-credits.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-access-copy.ts src/lib/ai-access.ts src/lib/managed-ai-policy.ts scripts/smoke-ai-access.ts
git commit -m "AI gate: Free runs metered on Orbit's key, with its own out-of-credits refusal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Credits UI and notices for Free

**Files:**
- Modify: `src/lib/credits/notices.ts` (~285, the `canUseHostedAi` skip)
- Modify: `src/lib/account-health.ts` (`creditFacts`, ~425-458)
- Modify: `src/lib/account-alerts.ts` (the `credits` input type ~187-196, the credit findings ~416-437, the credit alert copy ~798-822, and the `ai.no_key` body ~604)
- Modify: `src/lib/ai-access-copy.ts` (add `FREE_LOW_CREDITS`)
- Modify: `src/actions/credits.ts` (add `getFreeCreditsLeft`)
- Modify: `src/components/credits/credits-card.tsx`
- Test: `scripts/smoke-credits.ts` (the 80%/100% section), `scripts/smoke-credit-notices.ts`

**Interfaces:**
- Consumes: `CreditBalance.starterRemaining` (Task 1).
- Produces:
  - `HealthInput["credits"]` gains `starterRemaining?: number`.
  - `getFreeCreditsLeft(): Promise<number | null>`, which returns whole credits for a Free account on included AI and null otherwise.
  - `FREE_LOW_CREDITS = 3`.

- [ ] **Step 1: Write the failing tests**

In `scripts/smoke-credits.ts`'s "The 80% and 100% notices" section:
- Extend the `c` helper to `(allowanceRemaining: number, packRemaining = 0, starterRemaining = 0)` and include `starterRemaining` in the object.
- Add a `healthFree` wrapper, identical to `health` but with `plan: "free", planSource: "free", subscriptionStatus: null`, that returns the full `toAccountAlerts(evaluateAccountHealth(…))` result instead of the codes.
- Then add:

```ts
  check("an allowance spent with starter credits left is NOT 'near'",
    !health({ ...c(0, 0, 250_000), allowanceGranted: 100_000, spendable: 250_000 }).includes("plan.credits_near"));
  check("…nor 'out'", !health({ ...c(0, 0, 250_000), allowanceGranted: 100_000, spendable: 250_000 }).includes("plan.credits_out"));
  const outAlert = healthFree({ allowanceGranted: 100_000, allowanceRemaining: 0, packRemaining: 0, starterRemaining: 0, spendable: 0, resetsAt: "2026-11-01T00:00:00.000Z" })
    .find((a) => a.title === "You’re out of AI credits");
  check("Free's out-of-credits alert offers a key, never a pack",
    Boolean(outAlert) && !/pack/i.test(outAlert!.body) && /own key/.test(outAlert!.body), outAlert);
```
Follow `toAccountAlerts`' real signature as the file already uses it.

In `scripts/smoke-credit-notices.ts`, mirror the existing Pro account that crosses 80%:
- Add a Free account `smoke-cn-free`: a `userSettings` row with no plan columns and an allowance grant for the current calendar month at 90% used.
- Assert that no email was delivered to it, using whatever capture the file already inspects.
- Delete that user in the file's cleanup.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx scripts/smoke-credits.ts; npx tsx scripts/smoke-credit-notices.ts`
Expected: FAIL on "NOT 'near'", "offers a key, never a pack" and the Free email check.

- [ ] **Step 3: Implement**

1. **`notices.ts`.** Change `if (!ent.canUseHostedAi) {` to `if (!ent.canUseHostedAi || ent.plan === "free") {`. The comment becomes "Only Pro and Max hear about credits by email; Free sees the in-app notice."

2. **`account-health.ts` (`creditFacts`).** Return `starterRemaining: balance.starterRemaining`. Change the early return to `if (!balance.allowance && balance.packRemaining === 0 && balance.starterRemaining === 0) return null;`.

3. **`account-alerts.ts`.**
   - In the `credits?:` type, add `starterRemaining?: number;`.
   - In the findings, add `free: input.plan === "free"` to the `data` of `plan.credits_out` and `plan.credits_near`.
   - Prefix the `credits_near` condition with `(c.starterRemaining ?? 0) <= 0 &&`.
   - In the alert copy, `credits_out` body becomes:

```ts
            f.code === "plan.credits_out"
              ? f.data.free
                ? `Orbit’s AI refills${when ? ` on ${when}` : " next month"}. Add your own key for no limit`
                : `Included AI is paused${when ? ` until ${when}` : ""}. Nothing is charged automatically — add a $5 pack, or use your own key.`
```
   - The `credits_near` title ends "this month" when `f.data.free`, else "this cycle".
   - The `ai.no_key` body (~604) becomes `"Capture, chat, suggestions and search stay switched off until Orbit has a key. Add your own key in Settings to keep AI running"`.

4. **`ai-access-copy.ts`.** Add:

```ts
/** At or below this many credits, a Free account sees "N AI credits left this month". */
export const FREE_LOW_CREDITS = 3;
```

5. **`src/actions/credits.ts`.** Add:

```ts
/**
 * Whole credits a Free account can still spend, for the ask bar's low-credit line. Null for
 * any other plan, or when the account runs on its own key (credits are not what it spends).
 */
export async function getFreeCreditsLeft(): Promise<number | null> {
  const userId = await requireUserId();
  const { plan } = await getEntitlements(userId);
  if (plan !== "free") return null;
  const db = await getDb();
  const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
  const ownKey = Boolean(row?.geminiApiKeyEncrypted || row?.openaiApiKeyEncrypted || row?.anthropicApiKeyEncrypted || row?.openrouterApiKeyEncrypted);
  if (ownKey && row?.aiKeyPreference !== "included") return null;
  const balance = await getCreditBalance(userId, plan, row, new Date(), { ensure: false });
  return Math.floor(balance.spendable / 10_000);
}
```

6. **`credits-card.tsx`.**
   - After `const { balance, monthlyCredits, plan } = overview;`, add:

```ts
  const packsSold = plan === "orbit" || plan === "max";
  const starterLeft = credits(balance.starterRemaining);
  const spendableLeft = credits(balance.spendable);
```
   - After the allowance block, add:

```tsx
      {starterLeft > 0 && (
        <p className="text-sm text-muted-foreground">
          <strong className="font-medium text-ink">{fmt(starterLeft)}</strong> starter credits left, used after your monthly credits
        </p>
      )}
```
   - The pack paragraph's condition becomes `(packsSold || balance.packsFrozen) && (packLeft > 0 || monthlyCredits > 0)`.
   - Replace the `out ? … : line && …` block with:

```tsx
      {out ? (
        <p role="status" className="rounded-lg border border-warning-border bg-warning-surface p-3 text-sm text-foreground">
          {packsSold ? (
            <>
              You’ve used your credits, so Orbit’s AI is paused until {allowance ? formatAllowanceReset(allowance.periodEnd) : "your plan renews"}.
              Nothing is charged automatically — add a pack to keep going{plan === "orbit" ? ", or move to Max for 500 credits a month" : ""}.
            </>
          ) : (
            <>You’ve used this month’s AI credits. They refill on {allowance ? formatAllowanceReset(allowance.periodEnd) : "the 1st"}. Add your own key below for no limit</>
          )}
        </p>
      ) : plan === "free" && spendableLeft <= FREE_LOW_CREDITS ? (
        <p className="text-sm text-foreground">{spendableLeft} AI {spendableLeft === 1 ? "credit" : "credits"} left this month</p>
      ) : (
        line && <p className="text-sm text-muted-foreground">{line}</p>
      )}
```
   - The buttons row and the `CreditEmailToggle` condition become `monthlyCredits > 0 && packsSold`.
   - For Free, render `{plan === "free" && <Link href="/pricing" className="text-sm font-medium text-primary underline-offset-2 hover:underline">Compare plans</Link>}`.
   - Import `Link` and `FREE_LOW_CREDITS`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-credits.ts && npx tsx scripts/smoke-credit-notices.ts && npx tsc --noEmit && npx eslint src scripts`
Also run any smoke whose name contains `account-alerts` (`ls scripts | grep account-alerts`).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/credits/notices.ts src/lib/account-health.ts src/lib/account-alerts.ts src/lib/ai-access-copy.ts src/actions/credits.ts src/components/credits/credits-card.tsx scripts/smoke-credits.ts scripts/smoke-credit-notices.ts
git commit -m "Credits: Free sees its monthly and starter credits in-app, never by email

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Legal, pricing and plan copy

**Files:**
- Modify: `src/lib/legal.ts:12-13`
- Modify: `src/app/(site)/(docs)/privacy/page.tsx` (67, 240-242, 334-346, 370-373)
- Modify: `src/app/(site)/(docs)/terms/page.tsx` (247-251, 255-266, 305-315, 353-356)
- Modify: `scripts/legal-pages.lock.json` (regenerated)
- Modify: `src/lib/plan-copy.ts:55, 86-97`
- Modify: `src/app/(clerk)/(marketing)/pricing/page.tsx:99-101`
- Modify: `src/components/pricing/pricing-faq.tsx:22-23`
- Modify: `src/components/pricing/plan-comparison.tsx:50`
- Modify: `src/lib/entitlements.ts:237`
- Create: `scripts/smoke-free-ai-copy.ts` (pure)

**Interfaces:**
- Consumes: `PLAN_CONFIG.free.monthlyCredits` and `FREE_STARTER_CREDITS` (Task 1).

- [ ] **Step 1: Write the failing test.** Create `scripts/smoke-free-ai-copy.ts`:

```ts
/**
 * Free includes a small AI allowance (Sprint B). Pins that no plan or pricing copy still says
 * Free needs its own key, and that the Free card names the numbers from PLAN_CONFIG.
 *
 * Run: npx tsx scripts/smoke-free-ai-copy.ts
 */
import { readFileSync } from "node:fs";
import { FREE_STARTER_CREDITS, PLAN_CONFIG } from "../src/lib/plans/plan-config";
import { AI_POSITIONING, PLAN_COPY } from "../src/lib/plan-copy";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const free = PLAN_COPY.find((p) => p.id === "free")!;
const line = `${PLAN_CONFIG.free.monthlyCredits} AI credits a month + ${FREE_STARTER_CREDITS} to start`;
check("the Free card lists the allowance and the starter", free.features.some((f) => f.includes(line)), free.features);
check("the Free card no longer says 'on your own AI key'", !free.features.some((f) => /own AI key/i.test(f)), free.features);
check("positioning no longer says Free is bring-your-own-key", !/Free: bring your own/i.test(AI_POSITIONING), AI_POSITIONING);

const sources = [
  "src/components/pricing/pricing-faq.tsx",
  "src/components/pricing/plan-comparison.tsx",
  "src/app/(clerk)/(marketing)/pricing/page.tsx",
  "src/lib/entitlements.ts",
  "src/app/(site)/(docs)/privacy/page.tsx",
  "src/app/(site)/(docs)/terms/page.tsx",
];
for (const file of sources) {
  const src = readFileSync(file, "utf8").replace(/\s+/g, " ");
  check(`${file}: no "Free … own key" promise`,
    !/On the Free Plan(,| and Orbit Lifetime,)? (yes|every call runs on|AI runs on|add your own)/i.test(src) &&
      !/Bring your own AI key on the Free Plan/i.test(src) && !/AI on it runs on a key you supply/i.test(src));
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nfree-ai-copy: ok");
process.exit(0);
```
Register it as `"smoke-free-ai-copy": "pure",` in `MANIFEST`. If the plan-copy array is not called `PLAN_COPY`, use its real exported name.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-free-ai-copy.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. **`plan-copy.ts`.**
   - `AI_POSITIONING = "Free: a small AI allowance to start. Pro and Max: AI included."`.
   - The Free feature line becomes `` `Capture notes, chat with your network, and summaries: ${free.monthlyCredits} AI credits a month + ${FREE_STARTER_CREDITS} to start` ``.
   - `caveat: "Add your own AI key any time for no limit."` keeps the existing caveats' period style.
   - Import `FREE_STARTER_CREDITS`.

2. **Pricing hero (`pricing/page.tsx:99-101`).** "Free includes a small AI allowance to get you started. Orbit Pro and Orbit Max keep every contact, follow-up and warm intro in one place, with more AI included."

3. **`pricing-faq.tsx:23`.** Bind `const free = PLAN_CONFIG.free;` and import `FREE_STARTER_CREDITS`. The answer becomes:

```ts
`No. The Free Plan includes ${free.monthlyCredits} AI credits a month, plus ${FREE_STARTER_CREDITS} to start, on Orbit’s own AI accounts. Orbit Pro and Orbit Max include ${pro.monthlyCredits} and ${max.monthlyCredits} credits a month. You can add your own key on any plan and choose which one runs first; calls on your own key never use credits.`
```

4. **`plan-comparison.tsx:50`.** `` return credits ? `Included: ${credits} credits a month${plan === "free" ? ` + ${FREE_STARTER_CREDITS} to start` : ""}` : "Your own key"; ``

5. **`entitlements.ts:237`.** `` hostedAi: `AI on Orbit's keys is included on ${availableOn("hostedAi")}. On Orbit Lifetime, AI runs on your own key.`, ``

6. **Privacy page.**
   - **Line 67:** "…On the provider you choose in Settings: on your own key, or (for the Free Plan’s allowance and included AI on Orbit Pro and Orbit Max) on Orbit's account with that provider."
   - **240-242:** "or on Pro and Max on Orbit&rsquo;s account" becomes "or, when you have no key of your own, on Orbit&rsquo;s account".
   - **334-346:** the plan sentences become: "On Orbit Lifetime, every call runs on an API key you supply, so the request lands on your own account with that provider and is governed by the retention settings you have agreed with them. On the Free Plan, Orbit includes a small monthly AI allowance and a one-time starter grant, and on Orbit Pro and Orbit Max AI is included: those calls run on Orbit&rsquo;s own accounts with those providers, under Orbit&rsquo;s agreements with them, which do not allow your content to be used to train their models. Providers may keep requests for a limited period for abuse monitoring under those agreements. If you add your own key and choose it, those calls run on your account instead."
   - **370-373:** "on your own AI key" becomes "on the AI provider and key described above".

7. **Terms page.**
   - **247-251:** "Included AI on Orbit Pro and Orbit Max" becomes "Included AI (the Free Plan’s allowance, and Orbit Pro and Orbit Max)".
   - **260-266:** "On Orbit Lifetime, AI runs on an API key you supply, and that provider bills you directly. On the Free Plan, Orbit includes a small monthly AI allowance and a one-time starter grant; on Orbit Pro and Orbit Max, AI is included. Included AI runs on Orbit&apos;s own provider accounts and uses your plan&apos;s credits. If you add a key of your own and choose it in Settings, those calls run on your key instead, your provider bills you, and no credits are used."
   - **307-308:** "costs nothing; AI on it runs on a key you supply." becomes "costs nothing, and includes a small AI allowance each month plus a one-time starter grant."
   - **353-356:** "Included AI on Pro and Max is covered by your plan&apos;s credits." becomes "Included AI on every plan except Lifetime is covered by your plan&apos;s credits."

8. **`legal.ts`.** `TERMS_VERSION = "2026-10-09"` and `LEGAL_LAST_UPDATED = "October 9, 2026"`. If it ships later, use the ship date in both.

9. **Lock file.** Run `npx tsx scripts/smoke-legal-pages.ts --update`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-free-ai-copy.ts && npx tsx scripts/smoke-legal-pages.ts && npx tsx scripts/smoke-plan-card-copy.ts && npx tsx scripts/run-smoke.ts --check && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/legal.ts "src/app/(site)/(docs)/privacy/page.tsx" "src/app/(site)/(docs)/terms/page.tsx" scripts/legal-pages.lock.json src/lib/plan-copy.ts "src/app/(clerk)/(marketing)/pricing/page.tsx" src/components/pricing/pricing-faq.tsx src/components/pricing/plan-comparison.tsx src/lib/entitlements.ts scripts/smoke-free-ai-copy.ts scripts/run-smoke.ts
git commit -m "Legal + pricing: Free includes a small AI allowance; terms re-consent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: One AI-access state — context, `AiKeyNotice`, Radar and dashboard

**Files:**
- Modify: `src/lib/ai-access.ts` (`aiReadyFromSettings`, ~777-804)
- Modify: `src/lib/ai-access-copy.ts`
- Modify: `src/components/viewer-plan.tsx`
- Modify: `src/app/(clerk)/(app)/layout.tsx` (~141-181)
- Modify: `src/components/ai-key-notice.tsx`
- Modify: `src/components/radar/recommendation-card.tsx` (~86-118, 245-259)
- Modify: `src/components/radar/radar-view.tsx` (where the Today deck renders)
- Modify: `src/actions/radar.ts:150`
- Modify: `src/components/dashboard/dashboard-sections.tsx:128-135`
- Create: `scripts/smoke-ai-notice-copy.ts` (pure)
- Test: `scripts/smoke-ai-access.ts`

**Interfaces:**
- Consumes: `FREE_LIMIT_MESSAGE` (Task 2), `creditPeriodFor` and `formatAllowanceReset`.
- Produces:
  - `aiDenialFromSettings(userId, row): AiAccessDenial | null`; `aiReadyFromSettings` is `=== null` of it.
  - `ViewerPlan = { plan; includedAiAvailable; aiReason: AiAccessDenial | null; creditsResetAt: string | null }`.
  - `AiKeyNotice` `feature` gains `"draft"`.
  - `noticeCopyFor(reason: AiAccessDenial | null, plan: Plan, resetsAt: string | null): NoticeCopy`, which is pure.
  - `NoticeCopy = { title: (verb: string) => string; body: string; offer: "upgrade" | "credits" | "plans" | null; linkToKeys: boolean }`.

- [ ] **Step 1: Write the failing tests.** Create `scripts/smoke-ai-notice-copy.ts` and register it as `pure`:

```ts
/**
 * One AI-access state: which words each refusal gets, per plan (Sprint B, B2).
 *
 * Run: npx tsx scripts/smoke-ai-notice-copy.ts
 */
import { noticeCopyFor } from "../src/lib/ai-access-copy";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const reset = "2026-11-01T00:00:00.000Z";
const freeOut = noticeCopyFor("managed_limit", "free", reset);
check("Free out of credits names the refill date", freeOut.title("x") === "You’ve used this month’s AI credits" && freeOut.body.includes("November 1"), freeOut.body);
check("…offers a key and plans, never a pack", freeOut.offer === "plans" && !/pack/i.test(freeOut.body));
check("…obeys the copy rules", !/\.$/.test(freeOut.body) && (freeOut.body.match(/ — /g) ?? []).length <= 1 && !freeOut.body.includes("'"));
check("Pro out of credits keeps the pack offer", noticeCopyFor("managed_limit", "orbit", reset).offer === "credits");
check("key_required no longer says 'On the Free Plan'", !/Free Plan/.test(noticeCopyFor("key_required", "lifetime", null).body));
check("paused reads the same on every plan", noticeCopyFor("managed_unavailable", "free", reset).title("x") === "Orbit’s AI isn’t available right now");
check("null reason falls back to key_required", noticeCopyFor(null, "lifetime", null).title("chat") === "Add an AI API key to chat");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nai-notice-copy: ok");
process.exit(0);
```
In `scripts/smoke-ai-access.ts`, inside the loop "the notification alert agrees with the gate", add:

```ts
    const st = await getAiAccessStatus(u);
    check(`aiDenialFromSettings agrees with the status, short of credits (${u})`,
      aiDenialFromSettings(u, row ?? null) === (st.reason === "managed_limit" ? null : st.reason));
```
Import `aiDenialFromSettings`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx scripts/smoke-ai-notice-copy.ts; npx tsx scripts/smoke-ai-access.ts`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement**

**`ai-access-copy.ts`.**
- `AI_NOTICE_COPY.key_required.body` becomes `"AI runs on your own Gemini, OpenAI, or Anthropic key."`.
- Widen the `offer` type to `"upgrade" | "credits" | "plans" | null`.
- Add `import type { Plan } from "@/lib/plans/plan-config";`. It is type-only, so the file stays client-safe.
- After `formatAllowanceReset`, add:

```ts
export type NoticeCopy = { title: (verb: string) => string; body: string; offer: "upgrade" | "credits" | "plans" | null; linkToKeys: boolean };

/**
 * The notice's words for this refusal on this plan. Free at zero gets its own state, with
 * the refill date; everything else is `AI_NOTICE_COPY`.
 */
export function noticeCopyFor(reason: AiAccessDenial | null, plan: Plan, resetsAt: string | null): NoticeCopy {
  if (reason === "managed_limit" && plan === "free") {
    return {
      title: () => "You’ve used this month’s AI credits",
      body: `They refill on ${resetsAt ? formatAllowanceReset(resetsAt) : "the 1st"}. Add your own key for no limit`,
      offer: "plans",
      linkToKeys: true,
    };
  }
  return AI_NOTICE_COPY[reason ?? "key_required"];
}
```
`formatAllowanceReset` is defined below `AI_NOTICE_COPY` in the same file. Function hoisting makes the call order fine.

**`ai-access.ts`.**
- Pull the row type of `aiReadyFromSettings` into `type AiSettingsRow = …`.
- Move its body into:

```ts
/**
 * The settings-level denial: presence only, no credits and no admin pause (like the alert it
 * feeds). Null = AI would run.
 */
export function aiDenialFromSettings(userId: string, row: AiSettingsRow | null): AiAccessDenial | null {
  // …the existing body, building the same KeyFacts as `facts`…
  const choice = chooseCompletionKey(facts);
  return choice.ok ? null : choice.reason;
}

export function aiReadyFromSettings(userId: string, row: AiSettingsRow | null): boolean {
  return aiDenialFromSettings(userId, row) === null;
}
```
Import `chooseCompletionKey` from `managed-ai-policy` if it is not already imported.

**`viewer-plan.tsx`:**

```ts
import type { AiAccessDenial } from "@/lib/managed-ai-policy";

export type ViewerPlan = {
  plan: Plan;
  includedAiAvailable: boolean;
  /** Why AI cannot run, from settings alone (no credits); null = it would run. */
  aiReason: AiAccessDenial | null;
  /** When this account's monthly credits refill (ISO), or null when the plan has none. */
  creditsResetAt: string | null;
};

const ViewerPlanContext = createContext<ViewerPlan>({ plan: "free", includedAiAvailable: false, aiReason: null, creditsResetAt: null });
```
Extend the doc comment to say it also carries the settings-level AI denial and the refill date.

**`layout.tsx`.**
- After `includedAiAvailable`, add:

```ts
  const aiReason = aiDenialFromSettings(userId, settings);
  const creditsResetAt = PLAN_CONFIG[plan].monthlyCredits ? creditPeriodFor(settings).end.toISOString() : null;
```
- Pass `value={{ plan, includedAiAvailable, aiReason, creditsResetAt }}`.
- Change ~181 to `hasApiKey: aiReason === null`.
- Import `aiDenialFromSettings`, `creditPeriodFor` (`@/lib/credits/ledger`) and `PLAN_CONFIG`. Drop `aiReadyFromSettings` if it is unused.

**`ai-key-notice.tsx`.**
- `feature` gains `"draft"`, with the verb `"write a follow-up"`.
- Replace the `useViewerPlan()` line and the `AI_NOTICE_COPY` lookup with:

```tsx
  const { plan, includedAiAvailable, creditsResetAt } = useViewerPlan();
  const copy = noticeCopyFor(reason ?? null, plan, creditsResetAt);
```
- The lead-in ternary becomes `offerCredits ? "Or use your own key under " : copy.offer === "upgrade" || copy.offer === "plans" ? "Add one under " : "Keys live under "`.
- After the `offerUpgrade` span, add:

```tsx
            {copy.offer === "plans" ? (
              <span className={extra}>
                , or{" "}
                <Link href="/pricing" className={link}>
                  compare plans
                </Link>
              </span>
            ) : null}
```
- Swap the `AI_NOTICE_COPY` import for `noticeCopyFor`.
- Update the doc comment's bullets: on Free, out of credits says when they refill, offering a key or plans.

**Radar.**
- `src/actions/radar.ts:150`: the literal becomes `AI_ACCESS_COPY.key_required`, imported from `@/lib/ai-access-copy`.
- `recommendation-card.tsx`:
  - Add `const [denial, setDenial] = useState<AiAccessDenial | null>(null);`.
  - In `writeWhy`, `if (!result.ok) { toast.error(result.message); return; }` becomes:

```ts
          if (!result.ok) {
            const d = aiDenialFromMessage(result.message);
            if (d) setDenial(d);
            else toast.error(result.message);
            return;
          }
```
  - In the JSX (245-259), the `showAiPrompt ? (aiAvailable ? … : <p>…Add an AI key…</p>) : null` branch becomes:

```tsx
                ) : showAiPrompt ? (
                  denial ? (
                    <div className="mt-2">
                      <AiKeyNotice feature="draft" reason={denial} compact />
                    </div>
                  ) : aiAvailable ? (
                    <button type="button" onClick={writeWhy} disabled={pending} className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50">
                      <Sparkles className="size-3" aria-hidden />
                      Write a one-line why and an opener
                    </button>
                  ) : null
                ) : null}
```
  - Import `AiKeyNotice`, `aiDenialFromMessage` and `type AiAccessDenial`. Remove `integrationHref` and `Link` if they become unused.
- `radar-view.tsx`: in the client component that renders the Today deck (check the `"use client"` line; move one level down if the file is server), add `const { aiReason } = useViewerPlan();`. Directly above the deck, render:

```tsx
      {!aiAvailable && <AiKeyNotice feature="draft" reason={aiReason ?? "key_required"} compact />}
```

**Dashboard (`dashboard-sections.tsx:128-135`):**

```ts
  const aiDenial = aiDenialFromSettings(userId, settings);
  if (aiDenial) {
    items.push({
      id: "ai-key",
      label: aiDenial === "key_required" ? "Add your AI key" : "Add your own AI key",
      detail:
        aiDenial === "key_required"
          ? "Capture from notes, Chat and profile briefs run on it."
          : "Orbit’s AI isn’t available right now, so capture, Chat and briefs need a key of your own",
      href: integrationHref("ai"),
    });
  }
```
Import `aiDenialFromSettings`, and drop `aiReadyFromSettings` from the import if it is unused.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-ai-notice-copy.ts && npx tsx scripts/smoke-ai-access.ts && npx tsx scripts/run-smoke.ts --check && npx tsc --noEmit && npx eslint src scripts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai-access.ts src/lib/ai-access-copy.ts src/components/viewer-plan.tsx "src/app/(clerk)/(app)/layout.tsx" src/components/ai-key-notice.tsx src/components/radar src/actions/radar.ts src/components/dashboard/dashboard-sections.tsx scripts/smoke-ai-notice-copy.ts scripts/smoke-ai-access.ts scripts/run-smoke.ts
git commit -m "AI notice: one plan-aware state with the refill date; Radar and dashboard use it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The ask bar and both follow-up draft flows

**Files:**
- Modify: `src/lib/follow-up-drafts.ts` (add `draftFollowUpResult` next to `generateContactFollowUpDraft`)
- Modify: `src/actions/contacts.ts:1412-1425` (`draftContactFollowUp`)
- Modify: `src/components/follow-up/follow-up-draft-sheet.tsx` (~80-122)
- Modify: `src/components/contacts/contact-follow-up-section.tsx` (~179-195, and the draft render near ~390)
- Modify: `src/components/layout/floating-ask-bar.tsx` (header ~560-609, `onError` ~451-456, the footer under the input, `clearThread`)
- Create: `scripts/smoke-draft-follow-up-result.ts` (pglite)

**Interfaces:**
- Consumes: `AiKeyNotice` `"draft"`, `useViewerPlan().aiReason` (Task 5), and `getFreeCreditsLeft`, `FREE_LOW_CREDITS` (Task 3).
- Produces:
  - `draftFollowUpResult(...args: Parameters<typeof generateContactFollowUpDraft>): Promise<({ ok: true } & Awaited<ReturnType<typeof generateContactFollowUpDraft>>) | { ok: false; error: string }>`.
  - `draftContactFollowUp` returns the same union. Only AI-gate refusals become `{ ok: false }`.

- [ ] **Step 1: Write the failing test.** Create `scripts/smoke-draft-follow-up-result.ts` and register it as `pglite`:

```ts
/**
 * A follow-up draft that AI cannot run for returns the refusal as data, so the sheet can show
 * the shared notice; thrown, production digests it into a generic failure.
 *
 * Run: npx tsx scripts/smoke-draft-follow-up-result.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

const USER = "smoke-draft-result";
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

run(async () => {
  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const { contacts, userSettings } = await import("../src/db/schema");
  const { draftFollowUpResult } = await import("../src/lib/follow-up-drafts");
  const db = await getDb();
  const clean = async () => {
    await db.delete(contacts).where(eq(contacts.userId, USER));
    await db.delete(userSettings).where(eq(userSettings.userId, USER));
  };
  await clean();
  // Lifetime with no key: refused as key_required whatever keys the environment holds.
  await db.insert(userSettings).values({ userId: USER, lifetimePurchasedAt: new Date("2026-01-01T00:00:00Z") });
  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Ada Draft", firstName: "Ada", lastName: "Draft" }).returning();
  try {
    const res = await draftFollowUpResult(USER, c.id, [], {});
    check("an AI refusal comes back as { ok: false } with the shared copy", res.ok === false && /API key/.test(res.error), res);
  } finally {
    await clean();
  }
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\ndraft-follow-up-result: ok");
  process.exit(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-draft-follow-up-result.ts`
Expected: FAIL (`draftFollowUpResult` is not exported).

- [ ] **Step 3: Implement**

**`follow-up-drafts.ts`:**

```ts
/**
 * `generateContactFollowUpDraft`, with an AI-gate refusal returned as data. Thrown, it is
 * digested in production and the person only sees a generic failure.
 */
export async function draftFollowUpResult(
  ...args: Parameters<typeof generateContactFollowUpDraft>
): Promise<({ ok: true } & Awaited<ReturnType<typeof generateContactFollowUpDraft>>) | { ok: false; error: string }> {
  try {
    return { ok: true, ...(await generateContactFollowUpDraft(...args)) };
  } catch (err) {
    if (isAiAccessError(err)) return { ok: false, error: err.message };
    throw err;
  }
}
```
Import `isAiAccessError` from `@/lib/ai-access`.

If the smoke shows `ok: true` with a template body, `generateContactFollowUpDraft` is swallowing the refusal. In that case, rethrow inside its catch when `isAiAccessError(err)`: a missing key must not produce a draft that looks AI-written.

**`actions/contacts.ts`.** In `draftContactFollowUp`, `return draftFollowUpResult(userId, contactId, goals, { ...options, writingInstructions });`.

**`follow-up-draft-sheet.tsx`.**
- Add `const [aiError, setAiError] = useState<string | null>(null);`, and reset it where the sheet resets its draft on open.
- On the open path, the success handler becomes:

```ts
              (result) => {
                if (session !== sessionRef.current) return;
                if (!result.ok) return setAiError(result.error);
                setAiError(null);
                setDraft(result.body);
              },
```
- Regenerate:

```ts
          const result = await draftContactFollowUp(contactId, { intent });
          if (!result.ok) {
            setAiError(result.error);
            return;
          }
          setAiError(null);
          setDraft(result.body);
          toast.success("Draft ready");
```
- Above the draft textarea: `{aiError && <AiKeyNotice feature="draft" reason={aiDenialFromMessage(aiError)} compact />}`.

**`contact-follow-up-section.tsx` (`draftFor`).** Same pattern: `if (!result.ok) { setAiError(result.error); return; }`, then `setAiError(null)` before `setDraft(result.body)`. Render the same notice above the draft output.

**`floating-ask-bar.tsx`.**
1. Import `useViewerPlan`, `AiKeyNotice`, `aiDenialFromMessage`, `FREE_LOW_CREDITS`, `getFreeCreditsLeft` and `type AiAccessDenial`.
2. In the component:

```tsx
  const { aiReason } = useViewerPlan();
  const [askDenial, setAskDenial] = useState<AiAccessDenial | null>(null);
  const [creditsLeft, setCreditsLeft] = useState<number | null>(null);
  const denial = askDenial ?? aiReason;

  useEffect(() => {
    if (!open) return;
    let live = true;
    getFreeCreditsLeft().then((n) => {
      if (live) setCreditsLeft(n);
    }, () => {});
    return () => {
      live = false;
    };
  }, [open]);
```
   `open` is the panel's state, the one `setOpen` drives.
3. In `onError`, replace `toast.error(message);` with:

```tsx
                const d = aiDenialFromMessage(message);
                if (d) setAskDenial(d);
                else toast.error(message);
```
   Keep the message removal and `setQuery(q)`.
4. Right after the header `<div>` (~609): `{denial && <div className="px-3 pb-2"><AiKeyNotice feature="chat" reason={denial} compact /></div>}`.
5. Under the input: `{creditsLeft !== null && creditsLeft > 0 && creditsLeft <= FREE_LOW_CREDITS && <p className="px-4 pb-2 text-xs text-muted-foreground">{creditsLeft} AI {creditsLeft === 1 ? "credit" : "credits"} left this month</p>}`.
6. In `clearThread`, add `setAskDenial(null);`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-draft-follow-up-result.ts && npx tsx scripts/run-smoke.ts --check && npx tsc --noEmit && npx eslint src scripts`
Expected: PASS. `tsc` flags any other `draftContactFollowUp` caller that reads `.body` without narrowing; there are none today.

- [ ] **Step 5: Commit**

```bash
git add src/lib/follow-up-drafts.ts src/actions/contacts.ts src/components/follow-up/follow-up-draft-sheet.tsx src/components/contacts/contact-follow-up-section.tsx src/components/layout/floating-ask-bar.tsx scripts/smoke-draft-follow-up-result.ts scripts/run-smoke.ts
git commit -m "AI notice: ask bar, Radar draft sheet and contact drafts show the shared state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Brief refresh and Constellation refresh stop reporting false success

**Files:**
- Modify: `src/lib/contact-brief.ts` (`generateAndStoreContactBrief`: return type at line 296, the catch ~567-588, every non-null return)
- Modify: `src/app/api/knowledge/refresh/route.ts:56-58`
- Modify: `src/actions/contacts.ts:966-975` (`regenerateContactSummary`)
- Modify: `src/components/graph/contact-inspect-panel.tsx:605-618`
- Modify: `src/actions/graph.ts` (`refreshConstellationBatch`, ~110-176)
- Modify: `src/components/graph/network-graph.tsx` (~715-762)
- Create: `scripts/smoke-brief-ai-refusal.ts` (pglite)

**Interfaces:**
- Produces:
  - `generateAndStoreContactBrief(...)` returns `{ summary; standing; nextStep?; aiError: string | null } | null`.
  - `regenerateContactSummary(id)` returns `{ summary: string | null; aiError: string | null }`.
  - `refreshConstellationBatch(...)` adds `aiError: string | null`.

- [ ] **Step 1: Write the failing test.** Create `scripts/smoke-brief-ai-refusal.ts` and register it as `pglite`:

```ts
/**
 * A brief refresh with no usable AI still stores the plain-language brief, and now SAYS the
 * AI was refused (Sprint B, B2) instead of reading as a fresh AI summary.
 *
 * Run: npx tsx scripts/smoke-brief-ai-refusal.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

const USER = "smoke-brief-refusal";
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

run(async () => {
  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("../src/db");
  const { contacts, userSettings } = await import("../src/db/schema");
  const { generateAndStoreContactBrief } = await import("../src/lib/contact-brief");
  const db = await getDb();
  const clean = async () => {
    await db.delete(contacts).where(eq(contacts.userId, USER));
    await db.delete(userSettings).where(eq(userSettings.userId, USER));
  };
  await clean();
  await db.insert(userSettings).values({ userId: USER, lifetimePurchasedAt: new Date("2026-01-01T00:00:00Z") });
  const [c] = await db.insert(contacts).values({ userId: USER, fullName: "Bo Brief", firstName: "Bo", lastName: "Brief", notes: "Met at a fair" }).returning();
  try {
    const out = await generateAndStoreContactBrief(USER, c.id, { force: true });
    check("the plain-language brief is still stored", Boolean(out?.summary));
    check("…and the refusal is reported", typeof out?.aiError === "string" && /API key/.test(out!.aiError!), out);
  } finally {
    await clean();
  }
  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nbrief-ai-refusal: ok");
  process.exit(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-brief-ai-refusal.ts`
Expected: FAIL on "the refusal is reported".

- [ ] **Step 3: Implement**

**`contact-brief.ts`.**
- Widen the return type (line 296) to `{ summary: string | null; standing: string | null; nextStep?: string | null; aiError: string | null } | null`.
- Add `let aiError: string | null = null;` next to `let model`.
- In the catch, first line: `if (isAiAccessError(err)) aiError = err.message;`. Import `isAiAccessError` from `@/lib/ai-access`.
- Add `aiError` to every non-null `return {` in the function (grep it), including `return { summary: contact.aiSummary, standing: null, aiError };`.

**`route.ts`:**

```ts
  const out = await generateAndStoreContactBrief(userId, contactId, { force: body?.force === true }).catch(() => null);
  if (!out) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // A forced refresh the AI gate refused stored the plain-language brief; say why, so the
  // click does not read as a fresh AI summary. Background refreshes stay quiet.
  if (out.aiError && body?.force === true) return NextResponse.json({ error: out.aiError }, { status: 409 });
  return NextResponse.json({ ok: true });
```
`dossier-refresh.tsx:79` already toasts `outcome.error` on a forced click.

**`regenerateContactSummary`.** `return { summary: out?.summary ?? null, aiError: out?.aiError ?? null };`.

**`contact-inspect-panel.tsx`:**

```tsx
                      const res = await regenerateContactSummary(id);
                      if (res.aiError) {
                        toast.error(res.aiError);
                      } else if (res.summary) {
                        setSummaryText(res.summary);
                        onContactPatch?.(id, { aiSummary: res.summary });
                        toast.success("Summary updated");
                      } else {
                        toast.error(TOAST_COPY.summaryFailed);
                      }
```

**`refreshConstellationBatch`.**
- Add `let aiError: string | null = null;`.
- In the per-row catch: `if (!aiError && isAiAccessError(err)) aiError = err.message;`.
- In the result: `/** Set when the AI gate refused embeddings: the refresh cannot succeed until that changes. */ aiError,`.
- Import `isAiAccessError`.

**`network-graph.tsx`.**
- Before the loop, add `let anyFailed = false;`.
- After `done = result.done;`, add:

```tsx
        anyFailed ||= result.failed > 0;
        if (result.aiError) {
          finishBackgroundJob(jobId, { status: "failed", error: result.aiError });
          return;
        }
```
- The completion message becomes `resultMessage: anyFailed ? "Constellation refreshed, with some people skipped" : "Constellation refreshed"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-brief-ai-refusal.ts && npx tsx scripts/smoke-behavior-golden.ts && npx tsx scripts/run-smoke.ts --check && npx tsc --noEmit && npx eslint src scripts`
Expected: PASS. If behavior-golden snapshots the brief's return value and the only diff is the new `aiError: null` key, update the golden for that key alone.

- [ ] **Step 5: Commit**

```bash
git add src/lib/contact-brief.ts src/app/api/knowledge/refresh/route.ts src/actions/contacts.ts src/components/graph/contact-inspect-panel.tsx src/actions/graph.ts src/components/graph/network-graph.tsx scripts/smoke-brief-ai-refusal.ts scripts/run-smoke.ts
git commit -m "Knowledge + Constellation: a refused AI refresh says so instead of reporting success

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Onboarding paths — people first, retired steps resume onward

**Files:**
- Modify: `src/lib/onboarding-steps.ts`
- Modify: `scripts/smoke-onboarding-steps.ts`
- Modify: `src/actions/onboarding.ts:28-47` (`startOnboardingPath`)
- Modify: `src/components/onboarding/onboarding-flow.tsx`. The edits are:
  - the `facts` memo (~129-131)
  - the resume `useState` (~111-114)
  - `choosePath` (~227-236)
  - `switchToTour` (~261-267)
  - the `stage` computation (~269-274)
  - the `linkedin`, `import` and `ai-key` renders (~337-380)
  - `importFrom`
- Delete: `src/components/onboarding/steps/ai-key-step.tsx`, if `grep -rn "ai-key-step" src` shows no other importer
- Keep: `src/components/onboarding/steps/linkedin-step.tsx` for now; Task 10 extracts its instructions and deletes it

**Interfaces:**
- Produces:
  - `PATH_STAGES = { tour: ["welcome", "connect", "launch"], quick: ["welcome", "people", "connect", "overview"] }`.
  - `OnboardingStage = "welcome" | "people" | "connect" | "overview" | "launch"`.
  - `StepFacts = { connectConfigured: boolean }`.
  - `RETIRED_STEPS`.
  - `firstStep(path, facts): OnboardingStage`.
  - `resumeStep(value, path, facts?)`.
  - `startOnboardingPath(path: string, first: string)`.

- [ ] **Step 1: Rewrite the failing tests** in `scripts/smoke-onboarding-steps.ts`:
- **Fixtures (31-33).** `const ALL = { connectConfigured: true }; const BARE = { connectConfigured: false };`. Delete `KEYED`.
- **The per-step loop (39-46).** After the `isOnboardingStep` check, add `if (RETIRED_STEPS.includes(step)) continue;`.
- **Lines 69-83.** Replace with:

```ts
  check("import lights people", stageOf("import", "quick") === "people");
  check("quick goes people first", mainLine("quick", ALL).join(">") === "welcome>people>connect>overview");
  check("the tour is welcome, connect, launch", mainLine("tour", ALL).join(">") === "welcome>connect>launch");
  check("no configured provider skips connect", !mainLine("tour", BARE).includes("connect") && !mainLine("quick", BARE).includes("connect"));
  check("quick starts on people", firstStep("quick", ALL) === "people");
  check("the tour starts on connect, or launch without providers", firstStep("tour", ALL) === "connect" && firstStep("tour", BARE) === "launch");
  check("quick: people → connect → overview", nextStep("people", "quick", ALL) === "connect" && nextStep("connect", "quick", ALL) === "overview");
  check("quick, bare: people goes straight to the overview", nextStep("people", "quick", BARE) === "overview");
  check("tour: after connect comes the launch", nextStep("connect", "tour", ALL) === "launch");
  check("the last step has no next", nextStep("launch", "tour", ALL) === null && nextStep("overview", "quick", ALL) === null);
  check("welcome has no previous", prevStep("welcome", "tour", ALL) === null);
  check("a branch step's neighbours are its node's", nextStep("capture", "quick", ALL) === "connect" && prevStep("triage", "quick", ALL) === "welcome");
  for (const retired of RETIRED_STEPS) {
    check(`a stored "${retired}" resumes on quick's first step`, resumeStep(retired, "quick", ALL) === "people");
    check(`a stored "${retired}" resumes on the tour's first step`, resumeStep(retired, "tour", ALL) === "connect");
    check(`a stored "${retired}" resumes on launch when nothing is configured`, resumeStep(retired, "tour", BARE) === "launch");
  }
  check("a stored tour import resumes on the tour's first step", resumeStep("import", "tour", ALL) === "connect");
  check("a stored quick import still resumes as itself", resumeStep("import", "quick", ALL) === "import");
  check("STAGE_LABELS covers exactly the stages", Object.keys(STAGE_LABELS).sort().join(",") === "connect,launch,overview,people,welcome");
```
- Import `RETIRED_STEPS` and `firstStep`.
- The existing `resumeStep("overview", "tour") === "welcome"` and `resumeStep("launch", "quick") === "welcome"` checks still hold, so keep them.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-onboarding-steps.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

**`onboarding-steps.ts`.** Replace `PATH_STAGES`, `STAGE_LABELS`, `stageOf`, `stepAllowedOnPath`, `StepFacts`, `mainLine` and `resumeStep` with the code below. Keep `nextStep`, `prevStep` and `stepDirection`.

```ts
/**
 * The two main lines. Quick setup goes straight to the person's own people; the tour shows
 * them around. `linkedin` and `ai-key` left both lines (Sprint B): the LinkedIn export is a
 * dashboard card now, and Free includes AI. Their ids stay in ONBOARDING_STEPS so a stored
 * step still parses, and `resumeStep` moves it onto the path's first step.
 */
export const PATH_STAGES = {
  tour: ["welcome", "connect", "launch"],
  quick: ["welcome", "people", "connect", "overview"],
} as const satisfies Record<OnboardingPath, readonly OnboardingStep[]>;

export type OnboardingStage = (typeof PATH_STAGES)[OnboardingPath][number];

export const RETIRED_STEPS: readonly OnboardingStep[] = ["linkedin", "ai-key"];

export const STAGE_LABELS: Record<OnboardingStage, string> = {
  welcome: "Welcome",
  people: "Your people",
  connect: "Your accounts",
  overview: "What Orbit does",
  launch: "The tour",
};

export function stageOf(step: OnboardingStep, path: OnboardingPath): OnboardingStage {
  void path;
  switch (step) {
    case "welcome":
    case "connect":
    case "overview":
    case "launch":
      return step;
    case "people":
    case "capture":
    case "manual":
    case "triage":
    case "import":
      return "people";
    case "linkedin":
    case "ai-key":
      // Retired: `resumeStep` never lands here. Welcome is the harmless answer.
      return "welcome";
  }
}

export function stepAllowedOnPath(step: OnboardingStep, path: OnboardingPath): boolean {
  if (RETIRED_STEPS.includes(step)) return false;
  if (step === "welcome" || step === "connect") return true;
  return path === "quick" ? step !== "launch" : step === "launch";
}

export type StepFacts = { connectConfigured: boolean };

export function mainLine(path: OnboardingPath, facts: StepFacts): OnboardingStage[] {
  return (PATH_STAGES[path] as readonly OnboardingStage[]).filter((step) => step !== "connect" || facts.connectConfigured);
}

/** The first step after welcome on this path's main line. */
export function firstStep(path: OnboardingPath, facts: StepFacts): OnboardingStage {
  return nextStep("welcome", path, facts) ?? "welcome";
}

export function resumeStep(
  value: string | null | undefined,
  path: string | null | undefined,
  facts: StepFacts = { connectConfigured: true },
): OnboardingStep {
  if (!isOnboardingStep(value) || value === "welcome") return "welcome";
  if (!isOnboardingPath(path)) return "welcome";
  if (stepAllowedOnPath(value, path)) return value;
  // A step this path no longer has (a stored LinkedIn or AI-key screen, or the tour's old
  // import branch) moves on, never back to the start.
  return RETIRED_STEPS.includes(value) || value === "import" ? firstStep(path, facts) : "welcome";
}
```
- Drop `void path;` if `stageOf`'s `path` param is unused and lint prefers removing it. Removing it means updating every call site, so prefer keeping the signature with an `_path` name if the lint config allows.
- Update the header comment (lines 8-12) with the new order.
- Delete the `mainLine` comment about `ai-key` (124-126).

**`src/actions/onboarding.ts`:**

```ts
export async function startOnboardingPath(path: string, first: string) {
  if (!isOnboardingPath(path)) return { ok: false as const };
  const step = isOnboardingStep(first) && stepAllowedOnPath(first, path) ? first : "welcome";
  // …unchanged…
      onboardingPath: path,
      onboardingStep: step,
```
Import `isOnboardingStep` and `stepAllowedOnPath`. The doc becomes "Both paths open on their first main-line step."

**`onboarding-flow.tsx`.**
1. `const facts = useMemo<StepFacts>(() => ({ connectConfigured: connectConfigured(connect) }), [connect]);`.
2. The resume initializer becomes `resumeStep(initialStepId, initialPath, { connectConfigured: connectConfigured(connect) })`. `connect` comes from props or state above it; if it is declared later, move this `useState` below it.
3. `choosePath`:

```tsx
  const choosePath = (chosen: OnboardingPath) =>
    start(async () => {
      if (!termsDone) {
        await acceptTerms();
        setTermsDone(true);
      }
      const first = firstStep(chosen, facts);
      await startOnboardingPath(chosen, first);
      setPath(chosen);
      pushStepEntry(first);
      setPosition(() => [first, 1]);
    });
```
4. In `switchToTour`, `await startOnboardingPath("tour", "launch");`.
5. `const stage = path ? stageOf(step, path) : null;`.
6. Delete the `step === "linkedin"` and `step === "ai-key"` render blocks, plus their imports.
7. Remove the `importFrom` state:
   - The import step's back becomes `onBack={() => backTo("people")}`.
   - Its `onContinue` becomes `(started) => (started ? afterPeople() : goTo("people"))`.
   - `PeopleStep`'s `onChoose` drops the `setImportFrom` call.
8. Keep the `apiKey` state (CaptureStep and the overview read it) and `requested`. Remove `setRequested` if it is now unused.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-onboarding-steps.ts && npx tsc --noEmit && npx eslint src scripts`
Expected: PASS. Also `grep -rn "hasApiKey: \(true\|false\), connectConfigured" scripts src`, and update any other `StepFacts` literal.

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/onboarding-steps.ts scripts/smoke-onboarding-steps.ts src/actions/onboarding.ts src/components/onboarding
git commit -m "Onboarding: people first; LinkedIn and AI-key steps retire and resume onward

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: People step, highlight tags, Settings explainer

**Files:**
- Modify: `src/components/onboarding/steps/people-step.tsx` (14-33, 50-51, 82-90)
- Modify: `src/components/onboarding/steps/highlights-step.tsx:28-32, 339-353`
- Modify: `src/components/onboarding/highlights/chapters.ts:120`
- Modify: `src/components/onboarding/onboarding-flow.tsx:437` (overview facts)
- Modify: `src/components/settings/ai-settings.tsx:142-148`
- Modify: `src/lib/ai-access-copy.ts` (add `FREE_AI_EXPLAINER`)
- Create: `scripts/smoke-onboarding-copy.ts` (pure)

**Interfaces:**
- Consumes: `FREE_STARTER_CREDITS` and `PLAN_CONFIG` (Task 1).
- Produces: `FREE_AI_EXPLAINER`.

- [ ] **Step 1: Write the failing test.** Create `scripts/smoke-onboarding-copy.ts` (pure), and register it. The components are client `.tsx` files, so the smoke reads their source.

```ts
/**
 * Sprint B onboarding copy: capture is the recommended way to add people, "later" is a real
 * button, highlights say "Uses AI credits", and Settings explains Free's allowance.
 *
 * Run: npx tsx scripts/smoke-onboarding-copy.ts
 */
import { readFileSync } from "node:fs";
import { FREE_AI_EXPLAINER } from "../src/lib/ai-access-copy";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

const people = readFileSync("src/components/onboarding/steps/people-step.tsx", "utf8");
check("capture is marked recommended", /id: "capture",[\s\S]{0,300}recommended: true/.test(people));
check("'later' is a Button, not a text link", /<Button[^>]*onClick=\{onLater\}/.test(people));
check("the step no longer calls itself the last step", !/eyebrow="Last step"/.test(people));
const highlights = readFileSync("src/components/onboarding/steps/highlights-step.tsx", "utf8");
check("the highlight tag says Uses AI credits", highlights.includes("Uses AI credits") && !highlights.includes("Needs AI key"));
const chapters = readFileSync("src/components/onboarding/highlights/chapters.ts", "utf8");
check("the ask chapter no longer says it runs on your key", !chapters.includes("Runs on the AI key you bring"));
check("the Settings explainer names both numbers",
  FREE_AI_EXPLAINER === "Free includes 10 AI credits a month and 25 to start. Add your own key to use AI with no limit", FREE_AI_EXPLAINER);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nonboarding-copy: ok");
process.exit(0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-onboarding-copy.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. **`ai-access-copy.ts`.** Import `{ FREE_STARTER_CREDITS, PLAN_CONFIG }` from `@/lib/plans/plan-config` as values, which is client-safe by that module's contract, and add:

```ts
/** Settings → AI provider, top line, Free only. */
export const FREE_AI_EXPLAINER = `Free includes ${PLAN_CONFIG.free.monthlyCredits} AI credits a month and ${FREE_STARTER_CREDITS} to start. Add your own key to use AI with no limit`;
```
   If Task 5 imported `type Plan` from the same module, merge the two imports.

2. **`people-step.tsx`.**
   - Add `recommended?: boolean` to the item type and set `recommended: true` on `capture`.
   - In the card, after the title, render:

```tsx
{path.recommended && (
  <span className="ml-2 inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-px text-[11px] font-medium text-primary">
    Recommended
  </span>
)}
```
   - The eyebrow changes from "Last step" to "Your people".
   - Replace the "later" `<button>` with:

```tsx
        <Button type="button" variant="outline" onClick={onLater}>
          I’ll add people later
        </Button>
```
     Import `Button` from `@/components/ui/button`.

3. **`highlights-step.tsx`.**
   - `NeedTag`'s AI branch becomes `if (chapter.needs === "ai") return <span className={base}>Uses AI credits</span>;`. It is a plain span: no link, because nothing needs doing.
   - Remove `hasApiKey` from `OverviewFacts`, and in `onboarding-flow.tsx:437` pass `facts={{ linkedinPending: requested && !linkedinImported }}`.
   - Remove the `integrationHref` and `Link` imports if they become unused.

4. **`chapters.ts:120`.** `{ label: "Answers from your own notes" }`.

5. **`ai-settings.tsx` description:**

```tsx
      description={
        onIncluded && ai.plan === "free"
          ? FREE_AI_EXPLAINER
          : onIncluded
            ? "Orbit uses AI to turn your notes into contacts and answer questions about your network. Your plan includes AI on Orbit’s keys, metered in credits — or bring your own key, which never uses credits."
            : ai.plan === "lifetime"
              ? "…unchanged…"
              : "…unchanged…"
      }
```
   Keep the two existing strings verbatim where marked unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-onboarding-copy.ts && npx tsx scripts/run-smoke.ts --check && npx tsc --noEmit && npx eslint src scripts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/onboarding src/components/settings/ai-settings.tsx src/lib/ai-access-copy.ts scripts/smoke-onboarding-copy.ts scripts/run-smoke.ts
git commit -m "Onboarding: capture is recommended, later is a button, highlights say Uses AI credits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: LinkedIn export card on the dashboard and /imports

**Files:**
- Create: `src/lib/linkedin-export-card.ts` (pure)
- Create: `src/components/linkedin/linkedin-export-instructions.tsx` (moved from `linkedin-step.tsx:75-92`, plus `NumberChip` if it is local there)
- Create: `src/components/linkedin/linkedin-export-card.tsx`
- Delete: `src/components/onboarding/steps/linkedin-step.tsx` (after `grep -rn "linkedin-step" src` is empty)
- Modify: `src/components/dashboard/dashboard-sections.tsx` (`LinkedInExportNudgeSection` ~101-106; the checklist's `linkedin-request` and `linkedin` items ~136-150)
- Modify: `src/app/(clerk)/(app)/(main)/imports/page.tsx` (data ~31-40; render between the header `</div>` ~86 and `<ImportHub` ~88)
- Create: `scripts/smoke-linkedin-export-card.ts` (pure)

**Interfaces:**
- Consumes:
  - `markLinkedInExportRequested(): Promise<{ requestedAt: string }>` (`src/actions/linkedin-export.ts:14`).
  - `hasLinkedInImport(userId)` and `getLinkedInNudgeVisible(userId, settings)` (`src/lib/linkedin-reminder.ts`).
  - `LINKEDIN_DATA_URL` (`src/lib/linkedin-export.ts:14`).
  - The existing `LinkedInExportNudge`.
- Produces:
  - `linkedinCardState({ imported, requestedAt, onboardingDone }): LinkedInCardState`.
  - `<LinkedInExportCard requestedAt where />`.

Dismissal is per-viewer, kept in localStorage (`orbit-linkedin-card-dismissed-v1`), the pattern `setup-checklist-card.tsx` uses. `user_settings` has no jsonb UI-flag column to reuse, and the spec rules out a schema change. The requested time is the existing `linkedin_export_requested_at` column.

- [ ] **Step 1: Write the failing test.** Create `scripts/smoke-linkedin-export-card.ts` (pure) and register it:

```ts
/**
 * When the LinkedIn export card shows, and what it says (Sprint B, B3).
 *
 * Run: npx tsx scripts/smoke-linkedin-export-card.ts
 */
import { linkedinCardState } from "../src/lib/linkedin-export-card";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? "" : `\n       ${JSON.stringify(detail)}`}`);
  }
}

check("hidden during onboarding", linkedinCardState({ imported: false, requestedAt: null, onboardingDone: false }).show === false);
check("hidden once anything from LinkedIn is imported", linkedinCardState({ imported: true, requestedAt: null, onboardingDone: true }).show === false);
const start = linkedinCardState({ imported: false, requestedAt: null, onboardingDone: true });
check("the start card when nothing was requested", start.show && start.mode === "start", start);
const req = linkedinCardState({ imported: false, requestedAt: "2026-10-08T10:00:00Z", onboardingDone: true });
check("after a request, when the export should be ready (a day later)",
  req.show && req.mode === "requested" && req.readyIso === "2026-10-09T10:00:00.000Z", req);
check("a Date and a string read the same",
  JSON.stringify(linkedinCardState({ imported: false, requestedAt: new Date("2026-10-08T10:00:00Z"), onboardingDone: true })) === JSON.stringify(req));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nlinkedin-export-card: ok");
process.exit(0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-linkedin-export-card.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

**`src/lib/linkedin-export-card.ts`:**

```ts
/** LinkedIn takes about a day to package an export. */
const READY_AFTER_MS = 24 * 60 * 60 * 1000;

export type LinkedInCardState =
  | { show: false }
  | { show: true; mode: "start" }
  | { show: true; mode: "requested"; readyIso: string };

/**
 * The dashboard and /imports card that replaced onboarding's LinkedIn step: start the export,
 * then "should be ready about …" until something from LinkedIn is imported. Pure, so both
 * pages and the smoke agree.
 */
export function linkedinCardState(input: {
  imported: boolean;
  requestedAt: Date | string | null;
  onboardingDone: boolean;
}): LinkedInCardState {
  if (!input.onboardingDone || input.imported) return { show: false };
  if (!input.requestedAt) return { show: true, mode: "start" };
  const at = new Date(input.requestedAt).getTime();
  return { show: true, mode: "requested", readyIso: new Date(at + READY_AFTER_MS).toISOString() };
}
```

**`linkedin-export-instructions.tsx`.** Move the `<Stagger as="ol" …>…</Stagger>` block from `linkedin-step.tsx:75-92` into `export function LinkedInExportInstructions()`, unchanged. It keeps its imports: `Stagger` and `StaggerItem` from where `linkedin-step.tsx` imports them, `LINKEDIN_ARCHIVE_EMAIL_SUBJECT` and `LINKEDIN_ARCHIVE_LINK_HOURS`, and `NumberChip`, which you move too if it is local.

**`linkedin-export-card.tsx`:**

```tsx
"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, useTransition } from "react";
import { X } from "lucide-react";
import { markLinkedInExportRequested } from "@/actions/linkedin-export";
import { Button } from "@/components/ui/button";
import { LinkedInExportInstructions } from "@/components/linkedin/linkedin-export-instructions";
import { LINKEDIN_DATA_URL } from "@/lib/linkedin-export";
import { linkedinCardState } from "@/lib/linkedin-export-card";

const DISMISS_KEY = "orbit-linkedin-card-dismissed-v1";
const listeners = new Set<() => void>();
function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Start your LinkedIn export, then "should be ready about {date}". Dismissal is per browser. */
export function LinkedInExportCard({ requestedAt: initial, where }: { requestedAt: string | null; where: "dashboard" | "imports" }) {
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => true);
  const [requestedAt, setRequestedAt] = useState(initial);
  const [pending, start] = useTransition();
  const state = linkedinCardState({ imported: false, requestedAt, onboardingDone: true });
  if (dismissed || !state.show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {}
    listeners.forEach((fn) => fn());
  };
  const link = "font-medium text-primary underline-offset-2 hover:underline";

  return (
    <section aria-labelledby="linkedin-card-title" className="relative rounded-xl border border-border/70 p-4">
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="absolute top-3 right-3 text-muted-foreground hover:text-foreground">
        <X className="size-4" />
      </button>
      <h2 id="linkedin-card-title" className="font-heading text-base text-ink">
        Start your LinkedIn export
      </h2>
      {state.mode === "start" ? (
        <div className="mt-3 space-y-4">
          <LinkedInExportInstructions />
          <div className="flex flex-wrap items-center gap-3">
            <a href={LINKEDIN_DATA_URL} target="_blank" rel="noreferrer" className={link}>
              Open LinkedIn’s export page
            </a>
            <Button
              type="button"
              disabled={pending}
              onClick={() => start(async () => setRequestedAt((await markLinkedInExportRequested()).requestedAt))}
            >
              I’ve requested it
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          Your export should be ready about{" "}
          {new Date(state.readyIso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} —{" "}
          {where === "imports" ? (
            "drop the ZIP below when the email arrives"
          ) : (
            <>
              drop the ZIP on{" "}
              <Link href="/imports" className={link}>
                Imports
              </Link>{" "}
              when the email arrives
            </>
          )}
        </p>
      )}
    </section>
  );
}
```

**Dashboard.** Rewrite `LinkedInExportNudgeSection`:

```tsx
export async function LinkedInExportNudgeSection() {
  const userId = await requireUserId();
  const settings = await ensureUserSettings(userId);
  if (await getLinkedInNudgeVisible(userId, settings)) return <LinkedInExportNudge email={settings.email ?? null} />;
  const state = linkedinCardState({
    imported: await hasLinkedInImport(userId),
    requestedAt: settings.linkedinExportRequestedAt ?? null,
    onboardingDone: Boolean(settings.onboardingCompletedAt),
  });
  if (!state.show) return null;
  return <LinkedInExportCard where="dashboard" requestedAt={settings.linkedinExportRequestedAt?.toISOString() ?? null} />;
}
```
- Update the dashboard page's comment above `<LinkedInExportNudgeSection />` to "Renders the LinkedIn export card or the arrival nudge, or nothing once a LinkedIn import exists."
- Delete the checklist's `linkedin-request` and `linkedin` items, which the card supersedes, and fix the order comment above them.

**/imports.**
- Add `ensureUserSettings(userId)` and `hasLinkedInImport(userId)` to the page's `Promise.all` if they are not already loaded.
- Between the header `</div>` and `<ImportHub`, render:

```tsx
      {linkedinCardState({
        imported: linkedinImported,
        requestedAt: settings.linkedinExportRequestedAt ?? null,
        onboardingDone: Boolean(settings.onboardingCompletedAt),
      }).show && <LinkedInExportCard where="imports" requestedAt={settings.linkedinExportRequestedAt?.toISOString() ?? null} />}
```

Delete `linkedin-step.tsx`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-linkedin-export-card.ts && npx tsx scripts/run-smoke.ts --check && npx tsc --noEmit && npx eslint src scripts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/linkedin-export-card.ts src/components/linkedin src/components/onboarding/steps src/components/dashboard/dashboard-sections.tsx "src/app/(clerk)/(app)/(main)/dashboard/page.tsx" "src/app/(clerk)/(app)/(main)/imports/page.tsx" scripts/smoke-linkedin-export-card.ts scripts/run-smoke.ts
git commit -m "LinkedIn export: a dashboard and Imports card replaces the onboarding step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Early-career tour cast

**Files:**
- Modify: `src/lib/onboarding-examples/cast.ts` (lines 19-20 and 57-263; the types, `EXAMPLE_FULL_NAMES`, `EXAMPLE_COMPANY_NAMES` and `examplePerson` stay)
- Modify: `src/lib/tour/tour-stops.ts` (117-118, and every `maya`/`daniel` use: 127, 141, 157-161, 187, 237)
- Modify: `src/components/tour/tour-runtime.tsx:33` (and its use at 312)
- Modify: `src/components/contacts/contacts-list.tsx:619` (and its use at 645)
- Modify: `scripts/smoke-onboarding-examples.ts` (103-138)
- Test: `scripts/smoke-onboarding-examples-cast.ts` must pass **unchanged**

**Interfaces:**
- Produces:
  - Cast keys `priya`, `marcus`, `elena`, `grace`, `jordan` and `sam`.
  - `EXAMPLE_COMPANY` stays "Lumen Labs"; `EXAMPLE_COMPANY_SECOND = "Northwind Robotics"`.
  - The tour lead is `examplePerson("priya")`.

- [ ] **Step 1: Update the failing tests** in `scripts/smoke-onboarding-examples.ts`:
- **103-105:** find by `startsWith("Priya")`, `"Marcus"` and `"Sam"`, into `priya`, `marcus` and `sam`. Rename every later `maya` to `priya`, `daniel` to `marcus` and `sofia` to `sam`, and update the labels to match.
- **112:** the twin becomes `fullName: "Priya Natarajan", firstName: "Priya", lastName: "Natarajan"`.
- **131:** `["Ada Real", "Bea Winner", "Sam Okafor"]`.
- **138:** `rem.includes("Email Marcus after you apply")`. Sam has no reminder in the new cast, so only Marcus's reminder is adopted through the merge. Relabel it "the reminder adopted through a merge stays with its real owner".

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-onboarding-examples.ts`
Expected: FAIL (no "Priya").

- [ ] **Step 3: Implement.** In `cast.ts`:
- Change the header comment's audience wording to "an early-career network".
- Replace lines 19-20, the `EXAMPLE_PEOPLE` array and `TOUR_EXAMPLE_NOTE` with:

```ts
export const EXAMPLE_COMPANY = "Lumen Labs";
export const EXAMPLE_COMPANY_SECOND = "Northwind Robotics";
const EXAMPLE_SCHOOL = "Redwood University";

export const EXAMPLE_PEOPLE: ExamplePerson[] = [
  {
    key: "priya",
    fullName: "Priya Natarajan",
    firstName: "Priya",
    lastName: "Natarajan",
    title: "Software Engineer",
    company: EXAMPLE_COMPANY,
    school: EXAMPLE_SCHOOL,
    location: "Seattle",
    email: "priya.natarajan@example.com",
    linkedinSlug: "orbit-example-priya-natarajan",
    closeness: 4,
    howMet: "An alumni mixer, then a coffee chat the week after",
    metContext: "Alumni mixer",
    metDaysAgo: 50,
    keyFacts: ["Redwood alum, two years ahead", "On Lumen Labs’ platform team"],
    notes: "Generous with time. Offered to refer you once your resume is ready.",
    standing: "Warm; she offered a referral and is waiting on your resume.",
    touches: [
      {
        type: "note",
        at: 4,
        notes:
          "Coffee chat about Lumen Labs’ new-grad loop. She’ll refer me once my resume leads with the internship. Asked me to send it by Friday.",
        topics: ["referral", "new-grad loop", "resume"],
        actionItems: ["Send Priya your updated resume"],
      },
      {
        type: "meeting",
        at: 30,
        notes: "Follow-up call after the mixer. Walked through how her team interviews: one system design, two coding rounds.",
        topics: ["interviews"],
      },
    ],
    followUpInDays: -3,
    reminder: {
      title: "Send Priya your updated resume",
      description: "She offered a referral over coffee; it starts when she has the resume.",
      inDays: -3,
    },
  },
  {
    key: "marcus",
    fullName: "Marcus Bell",
    firstName: "Marcus",
    lastName: "Bell",
    title: "University Recruiter",
    company: EXAMPLE_COMPANY,
    school: null,
    location: "Seattle",
    email: "marcus.bell@example.com",
    linkedinSlug: "orbit-example-marcus-bell",
    closeness: 2,
    howMet: "The Lumen Labs booth at the fall career fair",
    metContext: "Fall career fair",
    metDaysAgo: 21,
    keyFacts: ["Runs Lumen Labs’ new-grad hiring", "Said applications open this month"],
    notes: "Asked you to email him once you apply so he can flag it.",
    standing: "A fresh contact; email him after you apply.",
    touches: [
      {
        type: "in_person",
        at: 21,
        notes: "Career fair booth. New-grad applications open this month; email him after applying and he’ll flag it for the team.",
        topics: ["new-grad hiring"],
        actionItems: ["Email Marcus after you apply"],
      },
    ],
    followUpInDays: null,
    reminder: { title: "Email Marcus after you apply", description: "He’ll flag your application for the team.", inDays: 0 },
  },
  {
    key: "elena",
    fullName: "Elena Vasquez",
    firstName: "Elena",
    lastName: "Vasquez",
    title: "Engineering Manager",
    company: EXAMPLE_COMPANY,
    school: null,
    location: "Seattle",
    email: "elena.vasquez@example.com",
    linkedinSlug: "orbit-example-elena-vasquez",
    closeness: 4,
    howMet: "Your manager during last summer’s internship",
    metContext: "Summer internship",
    metDaysAgo: 58,
    keyFacts: ["Managed your internship", "Writes the return-offer recommendations"],
    notes: "Strong supporter. Wants to hear how the fall goes.",
    standing: "Close; check in before return offers are decided.",
    touches: [
      {
        type: "call",
        at: 25,
        notes: "Post-internship check-in. Return offers are decided next month; she’ll put in a word with the new-grad team.",
        topics: ["return offer"],
      },
    ],
    followUpInDays: 9,
    reminder: null,
  },
  {
    key: "grace",
    fullName: "Grace Holloway",
    firstName: "Grace",
    lastName: "Holloway",
    title: "Professor of Computer Science",
    company: null,
    school: EXAMPLE_SCHOOL,
    location: "Portland",
    email: "grace.holloway@example.com",
    linkedinSlug: "orbit-example-grace-holloway",
    closeness: 3,
    howMet: "You took her Algorithms course",
    metContext: "Algorithms course",
    metDaysAgo: 60,
    keyFacts: ["Taught your Algorithms course", "Happy to write recommendation letters"],
    notes: "Wants a short summary of your projects before she writes a letter.",
    standing: "Supportive; she’ll write a letter once you send a project summary.",
    touches: [
      {
        type: "in_person",
        at: 14,
        notes: "Office hours. She’ll write a recommendation letter and asked for a one-page summary of my projects first.",
        topics: ["recommendation letter"],
      },
    ],
    followUpInDays: null,
    reminder: {
      title: "Send Professor Holloway your project summary",
      description: "She’ll write the letter once she has it.",
      inDays: 5,
    },
  },
  {
    key: "jordan",
    fullName: "Jordan Kim",
    firstName: "Jordan",
    lastName: "Kim",
    title: "Computer Science student",
    company: null,
    school: EXAMPLE_SCHOOL,
    location: "Portland",
    email: "jordan.kim@example.com",
    linkedinSlug: "orbit-example-jordan-kim",
    closeness: 5,
    howMet: "Lab partner in Operating Systems",
    metContext: "Operating Systems lab",
    metDaysAgo: 59,
    keyFacts: ["Your lab partner", "Also applying for new-grad roles"],
    notes: "Mock interview swaps every week.",
    standing: "Close; you trade mock interviews every week.",
    touches: [{ type: "message", at: 3, notes: "Set up Thursday’s mock interview swap. Jordan takes system design this time.", topics: ["mock interviews"] }],
    followUpInDays: null,
    reminder: null,
  },
  {
    key: "sam",
    fullName: "Sam Okafor",
    firstName: "Sam",
    lastName: "Okafor",
    title: "Founder",
    company: EXAMPLE_COMPANY_SECOND,
    school: null,
    location: "Portland",
    email: "sam.okafor@example.com",
    linkedinSlug: "orbit-example-sam-okafor",
    closeness: 2,
    howMet: "The startup row at the fall career fair",
    metContext: "Fall career fair",
    metDaysAgo: 21,
    keyFacts: ["Six-person robotics startup", "Hiring a first new-grad engineer"],
    notes: "Liked the drone project. Asked for your GitHub.",
    standing: "Interested; send your GitHub while you’re fresh in mind.",
    touches: [
      {
        type: "in_person",
        at: 20,
        notes: "Career fair startup row. Northwind Robotics is hiring its first new-grad engineer; he asked for my GitHub and the drone project.",
        topics: ["startups", "robotics"],
        actionItems: ["Send Sam your GitHub"],
      },
    ],
    followUpInDays: null,
    reminder: null,
  },
];

/** What the tour pre-fills on the Capture stop, so the extraction lands on an example person. */
export const TOUR_EXAMPLE_NOTE =
  "Coffee chat with Priya Natarajan from Lumen Labs about the new-grad loop. She’ll refer me once my resume leads with the internship. Send her the updated resume by Friday.";
```

Checked against the unchanged cast smoke:
- 6 unique keys, names, emails and slugs, all on example.com and all slugs `orbit-example-`.
- Every touch is 1-60 days ago and at or after `metDaysAgo`.
- 3 people at Lumen Labs.
- Reminders: one overdue (Priya, -3), one today (Marcus, 0) and one upcoming (Grace, 5).
- Someone overdue for follow-up (Priya, -3).
- The note names Priya and Lumen Labs.
- Both companies are on the removal list.

Checked against `smoke-onboarding-examples`:
- Reminders = 3.
- Removing 6 examples, minus Marcus (merged into Bea) and Sam (made real), plus the twin, gives 5.

**`tour-stops.ts`.**
- Lines 117-118 become `const priya = examplePerson("priya");` and `const marcus = examplePerson("marcus");`.
- Rename `maya` to `priya` and `daniel` to `marcus` throughout.
- Line 187, the capture body, becomes `` `Paste anything after a coffee chat or a career fair and Orbit works out who you met and what to do next. A note about ${priya.firstName} is already in the box.` ``.
- Line 237, the reminders body, becomes `` `Today holds what’s due and anything overdue: ${priya.firstName}’s resume is late and emailing ${marcus.firstName} is due today. Upcoming, Anytime and Done are one click away.` ``.
- The `missingHint` "Clear the search to find her." stays. Priya is she/her in the cast's own copy.

**`tour-runtime.tsx:33` and `contacts-list.tsx:619`.** `TOUR_MAYA_NAME` becomes `TOUR_LEAD_NAME = examplePerson("priya").fullName`, and every use of the constant is renamed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-onboarding-examples-cast.ts && npx tsx scripts/smoke-onboarding-examples.ts && npx tsc --noEmit && npx eslint src scripts`
Expected: PASS. `grep -rn "maya\|daniel\|Okonkwo-Reyes" src/lib/tour src/components/tour src/components/contacts/contacts-list.tsx src/lib/onboarding-examples` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/onboarding-examples/cast.ts src/lib/tour/tour-stops.ts src/components/tour/tour-runtime.tsx src/components/contacts/contacts-list.tsx scripts/smoke-onboarding-examples.ts
git commit -m "Tour: the example network is an alum, a recruiter, a manager, a professor, a classmate and a founder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Student seed persona on localhost

**Files:**
- Create: `src/lib/demo-data/student.ts`
- Modify: `src/lib/demo-data/seed.ts`: `DemoSeedOptions` (56-65), `seedDemoWorkspace` (76-120), `seedNetwork` (125-131), `seedReminders` (347-376 plus its inline founder rows ~377-441), `seedEvents` (810ff) and `seedGoals` (1010-1013)
- Modify: `src/lib/demo-data/ensure.ts:39`
- Modify: `scripts/seed-showcase.ts` (args ~56-58, seed call ~114, usage text)
- Modify: `.env.example` and `docs/DEVELOPMENT.md` (one line each, next to `ORBIT_DEMO_DATA`)
- Test: `scripts/smoke-demo-data.ts` (a new student section) and `scripts/smoke-behavior-golden.ts` (must pass unchanged)

**Interfaces:**
- Produces:
  - `type DemoPersona = "founder" | "student"`.
  - `DemoSeedOptions.persona?: DemoPersona`.
  - From `student.ts`: `STUDENT_PEOPLE: DemoPerson[]`, `STUDENT_GOALS: string[]`, `STUDENT_LISTS: readonly string[]` and `studentEvents(ago, ahead)`.

- [ ] **Step 1: Write the failing test.** In `scripts/smoke-demo-data.ts`:
- Add `const STUDENT = "smoke-demo-student";` to the users its cleanup deletes (lines 83-94).
- After the founder assertions, add the block below, importing `reminderLists`, `events`, `userGoals` and `outreachCampaigns` from the schema if they are not already imported:

```ts
  console.log("\nthe student persona");
  process.env.ORBIT_DEMO_PERSONA = "student";
  try {
    await ensureLocalDemoData(STUDENT);
  } finally {
    delete process.env.ORBIT_DEMO_PERSONA;
  }
  const { STUDENT_PEOPLE, STUDENT_GOALS, STUDENT_LISTS } = await import("../src/lib/demo-data/student");
  check("seeds the student network", (await contactCount(STUDENT)) === STUDENT_PEOPLE.length, await contactCount(STUDENT));
  check("about thirty people", STUDENT_PEOPLE.length >= 28 && STUDENT_PEOPLE.length <= 32, STUDENT_PEOPLE.length);
  const lists = (await db.select({ name: reminderLists.name }).from(reminderLists).where(eq(reminderLists.userId, STUDENT))).map((l) => l.name);
  check("Recruiters, Alumni and Referrals lists", STUDENT_LISTS.every((n) => lists.includes(n)), lists);
  const goals = (await db.select({ text: userGoals.text }).from(userGoals).where(eq(userGoals.userId, STUDENT))).map((g) => g.text);
  check("student goals, nothing about fundraising", goals.length === STUDENT_GOALS.length && !goals.some((g) => /fundrais|investor/i.test(g)), goals);
  const studentEvents = await db.select({ title: events.title }).from(events).where(eq(events.userId, STUDENT));
  check("a career fair is on the calendar", studentEvents.some((e) => /career fair/i.test(e.title)), studentEvents);
  check("no outreach campaign", (await db.select({ id: outreachCampaigns.id }).from(outreachCampaigns).where(eq(outreachCampaigns.userId, STUDENT))).length === 0);
  check("every student email is on a reserved example domain", STUDENT_PEOPLE.every((p) => !p.email || /@([a-z0-9-]+\.)*example(\.[a-z]+)?$/.test(p.email)));
  check("names are unique", new Set(STUDENT_PEOPLE.map((p) => p.fullName)).size === STUDENT_PEOPLE.length);
  check("the founder persona is still the default", (await contactCount(FRESH)) === people.length);
```
`run-smoke` runs scripts sequentially, and the `finally` restores the env var, so no other smoke sees it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-demo-data.ts`
Expected: FAIL (the `student` module is missing).

- [ ] **Step 3: Implement**

**`src/lib/demo-data/student.ts`:**

```ts
import type { DemoPerson } from "@/lib/demo-data/network";

/**
 * The student / new-grad localhost workspace (`ORBIT_DEMO_PERSONA=student`): about thirty
 * people (alumni, recruiters, professors, classmates, internship colleagues), a career fair,
 * and the reminder lists a job search uses. Nothing about fundraising or outreach campaigns.
 * Emails are on example.com, like the founder seed.
 */

const SCHOOL = "UNC Chapel Hill";

const CORE: DemoPerson[] = [
  {
    fullName: "Priya Shah", firstName: "Priya", lastName: "Shah", title: "Software Engineer", company: "Google", school: SCHOOL,
    location: "Mountain View, CA", email: "priya.shah@example.com", closeness: 4, howMet: "UNC alumni mixer", metContext: "Alumni mixer",
    metDaysAgo: 120, tags: ["Alumni"], standing: "Warm; she offered a referral once your resume is ready.",
    touches: [
      { at: 6, type: "call", notes: "Coffee chat about Google’s new-grad loop. She’ll refer me once my resume is tight.", actionItems: ["Send Priya my updated resume"] },
      { at: 40, type: "linkedin_message", direction: "in", notes: "Replied to my alumni message and suggested a call." },
    ],
    followUpInDays: -2, reminder: { title: "Send Priya my updated resume", inDays: -2, list: "Referrals" },
  },
  {
    fullName: "Marcus Bell", firstName: "Marcus", lastName: "Bell", title: "University Recruiter", company: "Datadog",
    location: "New York, NY", email: "marcus.bell@example.com", closeness: 3, howMet: "Fall career fair", metContext: "Career fair",
    metDaysAgo: 21, tags: ["Recruiter"], standing: "Fresh; email him after you apply.",
    touches: [{ at: 21, type: "event", notes: "Datadog booth. New-grad applications open next week; email him after applying." }],
    followUpInDays: 0, reminder: { title: "Email Marcus after applying to Datadog", inDays: 0, list: "Recruiters" },
  },
  {
    fullName: "Grace Holloway", firstName: "Grace", lastName: "Holloway", title: "Associate Professor of Computer Science", school: SCHOOL,
    location: "Chapel Hill, NC", email: "grace.holloway@example.com", closeness: 4, howMet: "Took her Algorithms course",
    metDaysAgo: 400, tags: ["Professor"], standing: "Supportive; she’ll write a letter once she has your statement.",
    touches: [{ at: 14, type: "in_person", notes: "Office hours. Happy to write a recommendation letter; wants a draft statement by November." }],
    reminder: { title: "Send Professor Holloway my statement draft", inDays: 9 },
  },
  {
    fullName: "Elena Vasquez", firstName: "Elena", lastName: "Vasquez", title: "Engineering Manager", company: "Microsoft",
    location: "Redmond, WA", email: "elena.vasquez@example.com", closeness: 5, howMet: "My summer internship manager",
    metContext: "Summer internship", metDaysAgo: 160, tags: ["Internship"], standing: "Close; return offers are decided in October.",
    touches: [
      { at: 30, type: "call", notes: "Check-in after the internship. Return offer decision comes in October; she’ll flag me to the new-grad team." },
      { at: 90, type: "meeting", notes: "Final internship review. Strong on ownership; keep working on design docs." },
    ],
    followUpInDays: 12,
  },
  {
    fullName: "Jordan Kim", firstName: "Jordan", lastName: "Kim", title: "Computer Science student", school: SCHOOL,
    location: "Chapel Hill, NC", email: "jordan.kim@example.com", closeness: 5, howMet: "Lab partner in Systems", metDaysAgo: 500,
    tags: ["Classmate"], standing: "Close; weekly mock interview swaps.",
    touches: [{ at: 3, type: "message", notes: "Mock interview swap planned for Thursday." }],
  },
  {
    fullName: "Sam Okafor", firstName: "Sam", lastName: "Okafor", title: "Founder", company: "Loop Robotics",
    location: "Durham, NC", email: "sam.okafor@example.com", closeness: 2, howMet: "Career fair startup row", metContext: "Career fair",
    metDaysAgo: 21, tags: ["Founder"], standing: "Interested; send your GitHub.",
    touches: [{ at: 21, type: "event", notes: "Six-person robotics startup hiring a first new-grad engineer. Asked for my GitHub." }],
    reminder: { title: "Send Sam my GitHub and the drone project", inDays: 3, list: "Recruiters" },
  },
  {
    fullName: "Aaliyah Brooks", firstName: "Aaliyah", lastName: "Brooks", title: "Product Designer", company: "Figma", school: SCHOOL,
    location: "San Francisco, CA", email: "aaliyah.brooks@example.com", closeness: 3, howMet: "Alumni panel on design careers",
    metDaysAgo: 75, tags: ["Alumni"], standing: "Friendly; offered to look at your portfolio.",
    touches: [{ at: 45, type: "email", notes: "Shared her portfolio tips and offered to look at mine." }],
  },
  {
    fullName: "Ben Carter", firstName: "Ben", lastName: "Carter", title: "Software Engineer II", company: "Microsoft",
    location: "Redmond, WA", email: "ben.carter@example.com", closeness: 4, howMet: "Intern cohort at Microsoft", metDaysAgo: 160,
    tags: ["Internship"], standing: "Close; his team has a new-grad opening.",
    touches: [{ at: 10, type: "message", notes: "His team has a new-grad opening and he can refer me." }],
    reminder: { title: "Ask Ben for the referral link", inDays: 1, list: "Referrals" },
  },
  {
    fullName: "Nora Lindqvist", firstName: "Nora", lastName: "Lindqvist", title: "Technical Recruiter", company: "Spotify",
    location: "New York, NY", email: "nora.lindqvist@example.com", closeness: 2, howMet: "Reached out on LinkedIn", metDaysAgo: 12,
    tags: ["Recruiter"], standing: "Inbound; asked if you’re open to a backend role.",
    touches: [{ at: 12, type: "linkedin_message", direction: "in", notes: "Asked whether I’m open to a backend new-grad role in New York." }],
    followUpInDays: 4,
  },
  {
    fullName: "David Mensah", firstName: "David", lastName: "Mensah", title: "PhD candidate", school: SCHOOL,
    location: "Chapel Hill, NC", email: "david.mensah@example.com", closeness: 3, howMet: "TA for my Systems course", metDaysAgo: 300,
    tags: ["Professor"], standing: "A mentor; suggested a summer research program.",
    touches: [{ at: 25, type: "in_person", notes: "Talked about research vs industry. Suggested the summer REU program." }],
  },
  {
    fullName: "Hannah Wright", firstName: "Hannah", lastName: "Wright", title: "Career Coach", company: "UNC Career Services",
    location: "Chapel Hill, NC", email: "hannah.wright@example.com", closeness: 3, howMet: "Resume review appointment", metDaysAgo: 50,
    standing: "Helpful; your resume is down to one page.",
    touches: [{ at: 8, type: "meeting", notes: "Resume review. Cut to one page; lead with the internship impact numbers." }],
  },
  {
    fullName: "Leo Martins", firstName: "Leo", lastName: "Martins", title: "Software Engineer", company: "Stripe", school: SCHOOL,
    location: "Seattle, WA", email: "leo.martins@example.com", closeness: 2, howMet: "Alumni Slack", metDaysAgo: 35,
    tags: ["Alumni"], standing: "Cold; no reply to your first message yet.",
    touches: [{ at: 35, type: "linkedin_message", direction: "out", notes: "Asked about Stripe’s new-grad team matching. No reply yet." }],
    followUpInDays: -6,
  },
];

/** [fullName, title, company, school, closeness, howMet, tag] — the lighter long tail. */
const TAIL: Array<[string, string, string | null, string | null, number, string, string]> = [
  ["Chloe Nguyen", "Computer Science student", null, SCHOOL, 4, "Hackathon teammate", "Classmate"],
  ["Ethan Park", "Mathematics student", null, SCHOOL, 3, "Discrete Math study group", "Classmate"],
  ["Maya Robinson", "Data Science student", null, SCHOOL, 3, "ACM club officers", "Classmate"],
  ["Isaac Feld", "Computer Science student", null, "Duke University", 2, "HackNC", "Classmate"],
  ["Olivia Chen", "Software Engineer", "Google", SCHOOL, 2, "Alumni mixer", "Alumni"],
  ["Ravi Patel", "Data Engineer", "Capital One", SCHOOL, 2, "Alumni panel", "Alumni"],
  ["Sophie Martin", "Product Manager", "Microsoft", SCHOOL, 2, "Alumni Slack", "Alumni"],
  ["Tyler Brooks", "Software Engineer", "Epic Games", SCHOOL, 3, "ACM alumni night", "Alumni"],
  ["Grace Liu", "University Recruiter", "Capital One", null, 2, "Fall career fair", "Recruiter"],
  ["Kevin Doyle", "Campus Recruiter", "IBM", null, 1, "Fall career fair", "Recruiter"],
  ["Amara Okeke", "Talent Acquisition Partner", "Red Hat", null, 2, "Info session", "Recruiter"],
  ["Julia Reyes", "Senior Software Engineer", "Microsoft", null, 3, "Internship team", "Internship"],
  ["Marco Rossi", "Software Engineer Intern", "Microsoft", "Georgia Tech", 3, "Intern cohort", "Internship"],
  ["Fatima Zahra", "Program Manager", "Microsoft", null, 2, "Intern events", "Internship"],
  ["Daniel Cho", "Assistant Professor of Statistics", null, SCHOOL, 2, "Probability course", "Professor"],
  ["Lauren Hayes", "Lab Manager", null, SCHOOL, 2, "Robotics lab", "Professor"],
  ["Noah Williams", "Co-founder", "Tarheel Labs", null, 1, "Startup weekend", "Founder"],
  ["Zoe Adams", "Developer Advocate", "GitHub", null, 2, "Campus workshop", "Industry"],
];

function tailPerson([fullName, title, company, school, closeness, howMet, tag]: (typeof TAIL)[number], i: number): DemoPerson {
  const [firstName, ...rest] = fullName.split(" ");
  const lastName = rest.join(" ");
  return {
    fullName,
    firstName,
    lastName,
    title,
    ...(company ? { company } : {}),
    ...(school ? { school } : {}),
    email: `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, "") + "@example.com",
    closeness,
    howMet,
    // Touches (15 + 2i) always fall after the meeting (60 + 5i).
    metDaysAgo: 60 + i * 5,
    tags: [tag],
    standing: `Light touch so far; you met through ${howMet.toLowerCase()}.`,
    touches: [{ at: 15 + i * 2, type: i % 2 ? "message" : "event", notes: `${howMet}. Swapped LinkedIn and said to stay in touch.` }],
  };
}

export const STUDENT_PEOPLE: DemoPerson[] = [...CORE, ...TAIL.map(tailPerson)];

export const STUDENT_GOALS: string[] = [
  "Land a new-grad software engineering offer by spring",
  "Get two referrals at target companies",
  "Keep in touch with my internship team",
];

export const STUDENT_LISTS: readonly string[] = ["Recruiters", "Alumni", "Referrals"];

/** A career fair (past) and an alumni night (upcoming), in the shape `seedEvents` takes. */
export function studentEvents(ago: (d: number) => Date, ahead: (d: number) => Date) {
  return [
    {
      values: {
        title: "UNC Fall Career Fair",
        startsAt: ago(21),
        endsAt: new Date(ago(21).getTime() + 4 * 3600_000),
        venue: "Dean E. Smith Center",
        city: "Chapel Hill, NC",
        description: "Engineering and tech employers, plus a startup row.",
      },
      attendees: [
        { name: "Marcus Bell", company: "Datadog", title: "University Recruiter", contact: true },
        { name: "Sam Okafor", company: "Loop Robotics", title: "Founder", contact: true },
        { name: "Grace Liu", company: "Capital One", title: "University Recruiter", contact: true },
        { name: "Kevin Doyle", company: "IBM", title: "Campus Recruiter", contact: true },
      ],
    },
    {
      values: {
        title: "Computer Science alumni night",
        startsAt: ahead(6),
        endsAt: new Date(ahead(6).getTime() + 2 * 3600_000),
        venue: "Sitterson Hall",
        city: "Chapel Hill, NC",
        description: "Alumni from Google, Microsoft and Stripe talk new-grad recruiting.",
      },
      attendees: [
        { name: "Olivia Chen", company: "Google", title: "Software Engineer", contact: true },
        { name: "Leo Martins", company: "Stripe", title: "Software Engineer", contact: true },
      ],
    },
  ];
}
```
If `DemoPerson` field names differ from the founder seed's (`network.ts:41-72`), follow `network.ts`. If the events cast rows in `seedEvents` need more fields, add them to both student events in the same shape the founder rows use.

**`seed.ts`.**
1. Add `export type DemoPersona = "founder" | "student";`, and add `/** Which workspace: the founder (default) or a student / new grad. */ persona?: DemoPersona;` to `DemoSeedOptions`.
2. `seedNetwork(userId, ago, ahead, summary, extended, people: DemoPerson[])` replaces `const people = extended?.people ?? DEMO_PEOPLE;` with the parameter.
3. `seedReminders(userId, contactIdByName, ahead, summary, people: DemoPerson[], lists: readonly string[], founderExtras: boolean)`:
   - Create one `reminderLists` row per name in `lists`, at positions 1..n, the way "Fundraising" is created now. Collect them into a `Map<string, string>`, and have `listFor(name)` return `map.get(name) ?? inboxId`.
   - Iterate `people` instead of `DEMO_PEOPLE`.
   - Wrap the four inline founder reminders and the two suggested reminders in `if (founderExtras) { … }`.
4. `seedEvents(userId, contactIdByName, ago, ahead, summary, cast)`: move the inline founder array into a module-level `function founderEvents(ago, ahead) { return [...] }` and type `cast` as `ReturnType<typeof founderEvents>`. Then `studentEvents` must be assignable: give attendee objects the same optional fields.
5. `seedGoals(userId, summary, goals: readonly string[])`.
6. `seedDemoWorkspace`:

```ts
  const student = opts.persona === "student";
  const extended = !student && opts.extended ? buildExtendedCast() : null;
  const people = student ? STUDENT_PEOPLE : (extended?.people ?? DEMO_PEOPLE);
  const contactIdByName = await seedNetwork(userId, ago, ahead, summary, extended, people);

  const surfaces: Array<[string, () => Promise<void>]> = student
    ? [
        ["reminders", () => seedReminders(userId, contactIdByName, ahead, summary, people, STUDENT_LISTS, false)],
        ["events", () => seedEvents(userId, contactIdByName, ago, ahead, summary, studentEvents(ago, ahead))],
        ["goals", () => seedGoals(userId, summary, STUDENT_GOALS)],
      ]
    : [
        ["reminders", () => seedReminders(userId, contactIdByName, ahead, summary, people, ["Fundraising"], true)],
        ["outreach", () => seedOutreach(userId, contactIdByName, ago, summary)],
        ["recruiters", () => seedRecruiters(userId, contactIdByName, ago, summary)],
        ["events", () => seedEvents(userId, contactIdByName, ago, ahead, summary, founderEvents(ago, ahead))],
        ["chat", () => seedChat(userId, contactIdByName, ago, summary)],
        ["imports", () => seedImports(userId, ago, summary)],
        ["goals", () => seedGoals(userId, summary, DEMO_GOALS)],
      ];
```
   Import `STUDENT_PEOPLE`, `STUDENT_LISTS`, `STUDENT_GOALS` and `studentEvents`.

   The founder reminders today iterate `DEMO_PEOPLE`, not the extended people. Keep that byte-identical: in the founder branch pass `DEMO_PEOPLE` to `seedReminders`, not `people`. `smoke-behavior-golden` and `smoke-demo-data` pin it.

**`ensure.ts:39`:**

```ts
    const persona = process.env.ORBIT_DEMO_PERSONA === "student" ? "student" : undefined;
    const summary = await seedDemoWorkspace(userId, persona ? { persona } : { extended: true });
```
Add to the doc comment: "`ORBIT_DEMO_PERSONA=student` seeds the student / new-grad workspace instead."

**`seed-showcase.ts`.**
- After `const RESET = flag("reset");`, add:

```ts
const PERSONA = value("persona") ?? "founder";
if (PERSONA !== "founder" && PERSONA !== "student") {
  console.error(`--persona must be founder or student (got "${PERSONA}")`);
  process.exit(1);
}
```
- The seed call becomes `seedDemoWorkspace(userId, PERSONA === "student" ? { persona: "student" } : {})`.
- Add `[--persona founder|student]` to the usage comment at the top.

**Docs.** In both `.env.example` and `docs/DEVELOPMENT.md`, next to `ORBIT_DEMO_DATA`, add: `ORBIT_DEMO_PERSONA=student seeds a student / new-grad workspace instead of the founder one (localhost only)`. Match each file's comment style.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-demo-data.ts && npx tsx scripts/smoke-behavior-golden.ts && npx tsc --noEmit && npx eslint src scripts`
Expected: PASS. If behavior-golden fails, the founder seed changed: fix the refactor, and never regenerate the fixture in this task.

- [ ] **Step 5: Commit**

```bash
git add src/lib/demo-data scripts/seed-showcase.ts scripts/smoke-demo-data.ts .env.example docs/DEVELOPMENT.md
git commit -m "Demo data: ORBIT_DEMO_PERSONA=student seeds a new-grad workspace

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Capture — Save is pending from the click; each follow-up says why

**Files:**
- Modify: `src/lib/note-batches.ts:257` (export `planNameKey`)
- Modify: `src/lib/capture/review-reducer.ts` (add `followUpReasons` after `plannedCaptureReminders`, ~313)
- Modify: `src/components/capture/capture-summary.tsx` (~113 and ~209-213)
- Modify: `src/components/capture/capture-flow.tsx` (`save` ~386-393, the `SummaryStep` prop ~611, `SummaryStep` ~701-735)
- Test: `scripts/smoke-capture-review-reducer.ts`

**Interfaces:**
- Consumes: `reminderFactsFor`, `acceptedPeople`, `plannedCaptureReminders`, `PlannedReminder` and `FOLLOW_UP_DAYS_BY_CLOSENESS`.
- Produces:
  - `followUpReasons(result, decisions, planned): Array<{ name: string; line: string }>`.
  - `SummaryStep`'s `onSave: () => Promise<boolean>`.

- [ ] **Step 1: Write the failing test.** In `scripts/smoke-capture-review-reducer.ts`, use the file's existing builders for a result item and an accepted decision (search the file for `parsed:` and `relationshipScore`). Build three accepted people:
- **Ana:** relationship score 4, `follow_up_recommendation: null`, `follow_up_days: null`, `action_items: []`.
- **Ben:** relationship score 2, `follow_up_recommendation: "Check in about the offer"`, `action_items: []`.
- **Cy:** relationship score 4, `action_items: ["Send the deck"]`.

Then add:

```ts
  const planned = plannedCaptureReminders(result, decisions, []);
  const why = followUpReasons(result, decisions, planned);
  check("a close contact's follow-up says it came from closeness, with its days",
    why.some((w) => w.name === "Ana" && w.line === `You marked this a real conversation, so Orbit set a follow-up in ${FOLLOW_UP_DAYS_BY_CLOSENESS[4]} days`), why);
  check("a model-recommended follow-up says the notes asked for it",
    why.some((w) => w.name === "Ben" && w.line === "Your notes asked for a follow-up"), why);
  check("someone whose action item became the reminder gets no follow-up line", !why.some((w) => w.name === "Cy"), why);
```
Import `followUpReasons` and `plannedCaptureReminders` from `../src/lib/capture/review-reducer`, and `FOLLOW_UP_DAYS_BY_CLOSENESS` from `../src/lib/note-batches`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx scripts/smoke-capture-review-reducer.ts`
Expected: FAIL (`followUpReasons` is not exported).

- [ ] **Step 3: Implement**

`note-batches.ts:257`: `function planNameKey` becomes `export function planNameKey`.

`review-reducer.ts`, after `plannedCaptureReminders`:

```ts
/**
 * Why each automatic follow-up exists, for the summary: the notes asked for one, or the
 * person is close enough that Orbit keeps in touch. Only people whose planned reminder IS
 * the follow-up (no action item or dated commitment took its place).
 */
export function followUpReasons(
  result: Pick<CaptureJobResult, "items" | "anchorIso">,
  decisions: CaptureDecisions | null | undefined,
  planned: readonly PlannedReminder[]
): Array<{ name: string; line: string }> {
  const followUps = new Set(planned.filter((p) => p.kind === "follow_up").map((p) => p.contactKey));
  return acceptedPeople(result.items, decisions).flatMap(({ item, decision }) => {
    const facts = reminderFactsFor(item, decision);
    const key = planNameKey(facts.name);
    if (!facts.createReminder || !facts.name || !key || !followUps.has(key)) return [];
    const line = item.parsed.follow_up_recommendation
      ? "Your notes asked for a follow-up"
      : `You marked this a real conversation, so Orbit set a follow-up in ${facts.followUpDays} days`;
    return [{ name: facts.name, line }];
  });
}
```
Import `planNameKey` and `type PlannedReminder` from `@/lib/note-batches`.

`capture-summary.tsx`:
- After `actionItemCount`, add `const followUpWhy = useMemo(() => followUpReasons(result, decisions, planned), [result, decisions, planned]);`.
- After the action-items `<p>` (~213), add:

```tsx
        {followUpWhy.length > 0 && (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {followUpWhy.map((w) => (
              <li key={w.name}>
                <span className="font-medium text-foreground">{w.name}</span>: {w.line}
              </li>
            ))}
          </ul>
        )}
```

`capture-flow.tsx`:
1. Make `save` return its outcome:

```tsx
  const save = useCallback(async (jobId: string): Promise<boolean> => {
    const res = await saveCaptureJob(jobId);
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    seedCaptureJob(res.job, { force: true });
    return true;
  }, []);
```
   The prop at ~611 becomes `onSave={() => save(job.id)}`, and `SummaryStep`'s prop type becomes `onSave: () => Promise<boolean>`.
2. In `SummaryStep`:

```tsx
  // The job status when Save was pressed. Busy until the server moves the job on, so the
  // button reads "Saving…" from the click; a refused save, or a later status, releases it.
  const [pressedAt, setPressedAt] = useState<string | null>(null);
  const busy = saving || pressedAt === job.status;
```
   - `saveNow` starts with `setPressedAt(job.status);`.
   - Its last line `onSave();` becomes `if (!(await onSave())) setPressedAt(null);`.
   - Pass `saving={busy}` to `CaptureSummary`.
   - Import `useState` if it is missing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx scripts/smoke-capture-review-reducer.ts && npx tsx scripts/smoke-follow-up-cadence.ts && npx tsc --noEmit && npx eslint src scripts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/note-batches.ts src/lib/capture/review-reducer.ts src/components/capture/capture-flow.tsx src/components/capture/capture-summary.tsx scripts/smoke-capture-review-reducer.ts
git commit -m "Capture: Save shows Saving… from the click; each follow-up says why it was booked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Whole-branch verification and the acceptance run

**Files:** none new.

- [ ] **Step 1: Run the full gates**

Run: `npx tsx scripts/run-smoke.ts --check && npx tsc --noEmit && npx eslint src scripts && npm test`
Expected: all pass except `smoke-radar-run`, which is red on `main`. If `admin-render` or `instrumentation` times out under suite load, rerun it alone before calling it red.

- [ ] **Step 2: The acceptance walk on localhost.** Stop any dev server on this worktree's `.data/pglite` first.

- **Environment.** Find the demo-managed switch's real name: `grep -n "ORBIT_DEMO_MANAGED_AI\|function demoCountsAsManaged" -A6 src/lib/ai-access.ts`. Then start the dev server with `ORBIT_DEMO_DATA=off`, that switch set to off, and a managed `GEMINI_API_KEY` in `.env.local`.
- **Fresh account.**
  - Quick onboarding walks welcome → people → connect → overview.
  - Capture from notes extracts people with no saved key.
  - A chat question is answered.
  - A follow-up draft is generated from a contact.
  - Settings → AI provider shows the explainer, "of 10 monthly credits" and "25 starter credits left".
- **Out of credits.** Zero the account's grants with a short tsx script against local PGlite (`UPDATE credit_grants SET micros_remaining = 0 WHERE user_id = '<id>'`). Then check that each of these shows the Free out-of-credits notice with the refill date:
  - the ask bar
  - the contact draft
  - Knowledge refresh
  - the Settings card
  - the Radar draft, if Radar is released locally
- **Resume.** On a second account, set `onboarding_path = 'quick'`, `onboarding_step = 'linkedin'` and `onboarding_completed_at = null`. Then `/onboarding` opens on the people step.
- **LinkedIn card.** After onboarding, the dashboard shows "Start your LinkedIn export". "I’ve requested it" turns it into "should be ready about …", and dismissing it hides it.
- **Student persona.** Start with `ORBIT_DEMO_PERSONA=student` against a cleared account. It seeds about 30 people, the Recruiters/Alumni/Referrals lists and the career fair.

- [ ] **Step 3: Record the results.** Add them to the branch progress notes, with the output of any failure. Do not push or open a PR unless asked.

---

## Self-review notes

**Spec coverage:**

| Spec section | Task |
|---|---|
| B1 plan config, starter, spend order, balance | 1 |
| B1 gate | 2 |
| B1 emails, alerts, card | 3 |
| B1 legal, pricing, `TERMS_VERSION` | 4 |
| B2 notice states | 5 |
| B2 Radar card and action | 5 |
| B2 dashboard | 5 |
| B2 ask bar | 6 |
| B2 draft sheet and contact draft | 6 |
| B2 Knowledge and Constellation refresh | 7 |
| B2 low-credit line | 3 (card) and 6 (ask bar) |
| B3 paths and resume | 8 |
| B3 people step and highlights | 9 |
| B3 Settings explainer | 9 |
| B3 LinkedIn nudge | 10 |
| B4 tour cast | 11 |
| B4 student seed and `--persona` | 12 |
| B5 | 13 |
| Acceptance | 14 |

**Deliberate deviations from the spec:**
- **The LinkedIn card's dismissal** is per-browser localStorage, the setup checklist's pattern. `user_settings` has no jsonb UI-flag column to reuse, and the spec rules out a schema change. "Requested at" uses the existing `linkedin_export_requested_at` column.
- **A Free account on a deployment with no managed key configured** reads `managed_unavailable` ("Orbit’s AI isn’t available right now"), not `key_required`. `nothingUsable` already maps every plan-eligible account that way, and the words fit.
- **The dashboard's AI row** stays a setup-checklist row with plan-aware copy instead of an embedded notice. It only appears when included AI cannot run at all.
- **A deployed showcase account on Free** now runs metered on Orbit's key, like any Free account.
