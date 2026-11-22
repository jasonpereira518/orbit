# Jev on Orbit's key: fewer work-history searches

Date: 2026-11-10 · Status: draft for Jason's review

## Why

Orbit now pays for AI on every plan, from two pools (Anthropic $190/month, OpenAI $950
prepaid). Prod `/admin/billing/costs` on Nov 10, 30 days: Orbit-key AI cost **$3.83**, and
across every key **~97% of all AI spend ($5.69 of ~$5.83) was `contact.work_history`** —
web-search fees for keeping contacts' job history current. Chat, briefs, digests and every
decision Jev already answers round to pennies.

So the bill is search fees, and it grows with every user's network: each contact with a
stored history is re-checked every 30–180 days forever. Jev (TypeSafe's decision model,
already in Orbit since #256/#258 but BYOK-only) cannot search, but it can decide when a
search is not needed, for a fraction of a cent.

**Jason's decision (Nov 10): Orbit pays for Jev.** This reverses the Sep 21 "BYOK only" call.

## Goals

1. **Re-check gate.** Before the periodic one-search re-check, Jev judges whether anything
   suggests the person changed jobs. Low chance → no search; the contact is re-checked next
   cycle instead.
2. **Verify-search veto.** When the first search is unsure it found the right person, Jev may
   veto the second (verify) search by judging the candidate is clearly someone else.
3. Measurably fewer `contact.work_history` searches on `/admin/billing/costs`, with no wrong
   job ever written by this change.

## Non-goals

- Turning on Jev for every other decision (chat rerank, duplicates, mentions, calendar,
  capture, skip-gates) on Orbit's key. Those save pennies today and their thresholds were
  only fixture-tuned. A separate rollout, later.
- First-time research of newly added contacts (capture, LinkedIn drop, imports). Little to
  gain: they are people the user just chose to add, and cold imports are already skipped by
  the sweep.
- Any change to the `research.discover` / meeting-guest / Find people research paths, even
  though they share `searchOnceThenVerify`.
- Deepgram or chat-model cost.

## Anti-goals (a failure even if it "works")

- **Jev causing a wrong job to be written.** Jev may only ever cause a search *not* to run.
  It never says "save this".
- **A job change missed for more than one cycle.** Jason: "one cycle late is fine."
  Never two skips in a row for the same contact.
- **Other Jev decisions quietly switching on for every account** because an Orbit TypeSafe
  key now exists.
- **The "last checked" date lying.** A skipped re-check must not update
  `contact_profiles.capturedAt` (the provenance line reads it as "checked on").
- Jev calls eating users' AI credits. Jev is Orbit's cost-saver, invisible to the user.

## Where this sits in today's code

`src/lib/work-history-research.ts`, `researchOnce()`:

- Already frugal: closeness-tier cadence (`WORK_HISTORY_INTERVAL_DAYS` inner 30 / mid 60 /
  outer 120 / cold 180, ±20% jitter); a fresh window; a shared cross-account cache of
  confident public answers (`readPublicWorkHistory`); and a re-check asks the cheap
  "where do they work now?" (`checkCurrentRoleWithWebSearch`, 1 search) before the full
  history (`researchWithWebSearch`).
- **Gate 1 sits on the re-check path** (`!force && stored.source === "web" &&
  storedRoles.some(isCurrent)`), after the shared-cache read and the `userCanUseAi` check.
  It must run *before* `spend()` and the first `consumeBucket` — today those come before the
  re-check branch, so the gate's check moves earlier. A skipped re-check spends no allowance.
- **Gate 1 runs only in the periodic sweep** (`work-history-sweep.ts` passes an option down).
  Runs a person asked for — the profile's research button (`force`), "Refresh from
  LinkedIn", a capture or LinkedIn drop naming an existing contact (`kickWorkHistoryResearch`
  → `/api/work-history/research`), the contact form's LinkedIn field — are never gated.
  (My call: the goal is the periodic re-check, and silently skipping a refresh someone just
  asked for would read as broken.)
- **Gate 2 goes inside the verify step**: `searchOnceThenVerify` (`src/lib/web-research.ts`)
  runs a second search when the first answer's `match` is `"unsure"`. Work history calls it
  from `researchWithWebSearch`. The veto applies to the work-history caller only, on every
  non-forced full-history search: first-time research, a stored history with no current
  role, and a re-check whose cheap check found a new employer. (The non-goal below is about
  *whether* to research a new contact at all, not about this verify step.)
- `force` (the profile's own "research" button) bypasses both gates, always.

Existing Jev layer to build on (don't re-invent): `src/lib/decisions/` — `engine.ts`
(`decide`, `openEngines`, one deadline per chain, never throws), `gates.ts` (skip-gate
pattern: true only on a confident Jev answer; every failure runs the call), `catalog.ts`
(every question and threshold in one file, thresholds `null` = never asked),
`jev.ts` (`noul` questions, `openDecider`). Key grant: `DecisionGrant` in
`src/lib/ai-access.ts`. Pricing: `ai-pricing.ts` already has `"jev-"` at $0.042/MTok input,
output free. Eval: `scripts/eval-ai.ts --decisions jev`.

## The design

### Gate 1: re-check gate

- New op id, e.g. `contact.work_history.recheck.gate` (Jev ops need distinct ids: the
  `ai_result_cache` key omits provider/model).
- **State Jev reads** (all from Orbit's own tables, trimmed like `gateText`):
  - current stored role(s): organization, title, start year/month (`contact_experiences`,
    via `loadJobBaseline`), so tenure is visible;
  - days since the last check (`contact_profiles.capturedAt`) and the contact's cadence tier;
  - what Orbit saw *since the last check*: `interactions` rows (type, date, `ai_summary`,
    topics), and the contact's `relationship_digests.what_they_do` / `working_on`;
  - the contact's title/company fields.
- **Question** (`noul`): has this person likely changed employer or role since the last
  check? Skip when the probability is at or below a catalog threshold.
- **On skip:** no search, no allowance spent, no miss counted, `capturedAt` untouched. The
  contact is rescheduled one normal interval out (`nextWorkHistoryDue`). Record that this
  cycle was skipped.
- **Never two in a row:** if the previous cycle for this contact was a Jev skip, the gate is
  not asked; the search runs. Needs a small persisted marker per contact (e.g. a
  `contacts.work_history_skipped_at` timestamp or a skip counter cleared on any real
  search). A schema change, so it follows the schema migration gate rules (new version
  above whatever main is at when it merges).
- Jev unavailable / slow / unsure → today's behaviour exactly.

### Gate 2: verify-search veto

- New op id, e.g. `contact.work_history.verify.gate`.
- **State:** Orbit's facts about the contact (name, title, company, location, school,
  LinkedIn URL) and the first search's answer, fenced as untrusted text (it is read off public
  web pages).
- **Question** (`noul`): is the person in the first answer the same person as the contact?
- **On the moved path** (the cheap check confidently found a new employer), the state also
  carries that new employer and title, so Jev doesn't call the right person "someone else"
  just because Orbit's stored company is now out of date.
- **Only the safe direction:** at or below the threshold → stop, no second search, nothing
  written. Anything else → run the verify search exactly as today.
- **A veto is not a miss.** Two misses on one LinkedIn URL stop research for that contact
  for good (`notGivenUp`, `contactsNeedingWorkHistory`), so counting vetoes would turn "one
  cycle late" into "never". A veto gets its own outcome, leaves `workHistoryMisses` alone,
  and reschedules one normal interval out. The same never-two-in-a-row marker as Gate 1
  covers it: after a veto, the next run's verify search is not gated. (My call, following
  Jason's "one cycle late is fine".)
  Because Jev can only say "stop", a prompt injection in the web text can at worst cost one
  lookup, never write a wrong history.
- Can reuse the shape of `samePersonQuestion` in catalog.ts.

### Paying for Jev (Orbit's TypeSafe key)

- New managed key `ORBIT_MANAGED_TYPESAFE_API_KEY`, read only inside `ai-access.ts`
  (`smoke-ai-access` enforces this). The account's own TypeSafe key still wins when present.
- **Scoped:** the Orbit key grants only the two work-history gate operations. Every other
  decision keeps today's BYOK-only behaviour until a separate rollout. (My call; see
  anti-goals.)
- Every account that runs work-history research gets the gates, BYOK-AI users included:
  for them it lowers *their* search bill at a cost to Orbit of fractions of a cent.
  (My call.)
- Logged in `usage_events` with `provider = "typesafe"`, `key_owner = "orbit"`.
- **Not charged to user credits** — already true: `settleManagedUsage` in
  `src/lib/credits/ledger.ts` skips `provider === "typesafe"`. Keep a smoke on it.
- **Capped by the existing machinery:** stops when included AI is paused (admin switch /
  `ORBIT_MANAGED_AI=off`) and on `ORBIT_JEV=off`. Its spend counts toward the Anthropic
  pool's $190/month (Jason, Oct 19: the $190 covers everything Orbit pays for AI).
  Rough size: a ~2k-token state is ≈$0.00008 per call, so 10k gate calls ≈ $0.84.

### When Jev runs out, everything keeps going (Jason, Nov 10)

"If Jev runs out, the rest of the app can still automatically keep going." No person has to
notice or act for work-history research to continue.

- **Per call** (already the rule in `engine.ts` / `gates.ts`): any Jev failure, timeout or
  unsure answer → the search runs exactly as today.
- **Out of service:** an auth, quota or out-of-credit failure on Orbit's TypeSafe key takes
  TypeSafe out for 2 hours on every instance, the same way `runOnGrant` and
  `managedPoolState` already handle a dry managed provider (error event in
  `ERROR_SOURCES.managedAi`, read back across instances). While it is out, neither gate is
  asked — not even tried — so the sweep doesn't wait on a dead call per contact. It comes
  back on its own when the window lapses.
- **Stopped on purpose:** admin pause, `ORBIT_MANAGED_AI=off`, `ORBIT_JEV=off`, or the
  Anthropic pool spent → gates not asked, searches run.
- **The never-two-in-a-row marker** doesn't block anything while Jev is out: it only ever
  forces a search, never prevents one.
- **Ops:** the error event raises the existing managed-AI alert in Slack, so Jason hears
  about it. Search spend goes back to today's level until Jev is back, still bounded by the
  web-search caps (300/account/month, the Orbit-wide daily cap).
- An account's own TypeSafe key failing is handled per call as today, never taking out
  Orbit's key.
- Smoke: a quota failure on Orbit's key → the next contact's re-check runs its search with no
  Jev call attempted, and the alert event is recorded.

### Calibration and rollout

1. Build both gates with thresholds `null` in catalog.ts — shipped dark, never asked.
2. Eval tasks in `scripts/eval-ai.ts` for both gates, printing per-gate probabilities so the
   threshold sits mid-gap (the Sep 22 method). Fixtures: synthetic cases plus labels from
   Orbit's own history — past re-checks that ended "unchanged" vs a recorded move
   (`contact_career_moves` with source `web`), with the state reconstructed as of that check.
   Private labels go to `~/.orbit-private-labels` via `scripts/export-decision-labels.ts`,
   never committed.
3. Set thresholds only when the eval shows **0 wrong skips** for gate 1 on the cases that
   moved, and **0 vetoes of a true match** for gate 2.
4. After it ships, compare `contact.work_history` searches/30d on `/admin/billing/costs`.

**Known risk:** prod has 4 active accounts, so real "moved" labels are rare. The gate-1
threshold may end up tuned mostly on synthetic cases. The never-two-in-a-row rule bounds the
harm to one cycle late, which Jason accepted.

## Left to the builder

- Exact op ids, state field names, trims and the question wording.
- How the skip marker is stored (column shape), within the schema gate rules.
- How TypeSafe spend joins the Anthropic pool's total.
- Where the work-history caller passes engines into `searchOnceThenVerify` without changing
  its other callers.
- Smoke tests: gate skips only on a confident low answer; never two skips in a row; skip
  leaves `capturedAt` alone and spends no allowance; `force` bypasses both; veto writes
  nothing; Orbit key not granted to non-work-history operations; TypeSafe rows not charged
  to credits.

## Decided by Jason (Nov 10)

1. **Gate 1 reads what the user's notes say.** Interaction `ai_summary`s and relationship
   digests (`what_they_do`, `working_on`) go into Gate 1's state, trimmed. This is new:
   work history used to send only name, employer and profile link. Raw notes, email
   addresses and phone numbers still never go.
2. **Privacy and terms are part of this work, with a `TERMS_VERSION` bump.** The privacy
   page's TypeSafe row and the "If you also add a TypeSafe key" paragraph are rewritten:
   TypeSafe is now used on Orbit's account for every account, for deciding when a
   work-history check can be skipped, and it reads summaries of the user's notes and messages
   about that contact. Bump `TERMS_VERSION` (every user re-accepts) and update the legal
   lock. The build ships with thresholds `null` (sends nothing). The change that sets the
   thresholds ships together with, or after, the privacy and terms change, never before.
