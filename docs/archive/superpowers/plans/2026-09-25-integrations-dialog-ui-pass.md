# Integrations dialog UI pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five pages of the Settings → Integrations dialog become usable by someone who does not know what an API key is — three provider cards with logos and a cheapest/balanced/most-accurate model choice, trimmed copy, an activity-first usage card, one-click calendar subscribe, and LinkedIn timeline events that just happen.

**Architecture:** Additive where possible. The model tiers are a `tier` tag on the existing `PROVIDER_MODELS` entries rather than a second table, so there is nothing to drift. `ai-settings.tsx` splits into a `ProviderCard` plus a thin composer. Everything else is copy, layout and one deletion.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript (strict), Tailwind v4, Base UI, `tsx` smoke scripts, the TypeScript compiler API for source-level guards.

**Spec:** `docs/superpowers/specs/2026-09-25-integrations-dialog-ui-pass-design.md`

**Branch:** `claude/integrations-ui-pass`, cut from `29af8e65` on `claude/integrations-p3-ai` (PR #299), which is itself stacked on `claude/settings-popup-redesign-0ed30d` (PR #257).

## Two things discovered after the spec was written

**1. The branch is not current with `main`, and that matters.** `main` merged into PR #257 at `9b803f7f` (schema 103). Among what it brought, `#238` rewrote `src/components/imports/linkedin-messages-import.tsx` — one of this pass's targets — removing 29 lines and adding 11. Task 1 brings the stack current before any UI work, so nothing here is written against a stale file.

**2. The AI page now mounts a *second* usage card.** Deepgram (`#274`) added `SpeechUsageCard` (`src/components/settings/speech-usage-card.tsx`, 71 lines), and after the merge the AI panel renders `AiSettings`, `DecisionModelSettings`, `SpeechUsageCard`, `AiUsageCard`. The spec predates it.

**Ruling: the two cards stay separate, and both get the high-level treatment.** Merging them would conflate whose money is being spent — Deepgram runs on Orbit's key under a metered allowance, while AI runs on the person's own key. One card showing both would make "what am I paying for" unanswerable. They are stacked, AI usage first, with the speech card visually subordinate. Task 6 covers both.

## Global Constraints

- **Copy:** curly apostrophes (`’`) in every user-facing string — never a straight `'`. Toasts carry no trailing period, never say "failed", never surface `err.message` — use `friendlyError`. `scripts/smoke-toast-copy.ts` scans repo-wide.
- **Section ids are operator hide-list surface keys.** Never rename one; labels only.
- **No Tailwind class names inside comments** — this repo's Tailwind scans comments, and a class written in one compiles into the build.
- **OpenRouter stays out of the interface.** It has `selectable: false` on its `AI_PROVIDERS` entry and `scripts/smoke-ai-providers.ts` pins the selectable list to exactly `["gemini","openai","anthropic"]`. Render from `SELECTABLE_AI_PROVIDERS`, never `AI_PROVIDERS`.
- **One owner of the OAuth return params.** Exactly one component per page reads and strips `?google=` / `?outlook=`; read the "Why one owner" block at the top of `src/components/settings/use-provider-connection.ts` before touching anything near them.
- `npx tsc --noEmit` exits 0. `npx eslint src scripts` — 0 errors, no new warnings (baseline 46, none in touched files).
- **Never pipe a test run through `tail`/`head` when you need its exit code** — the pipe's status is what the shell reports, and that has already hidden real failures in this repo. Redirect to a file and grep the file.
- `npx tsx scripts/run-smoke.ts --ci` passes. Never set `SMOKE_ALLOW_REMOTE`. PGlite is single-writer — no dev server while db smokes run.
- This is a worktree: never `cd` out of it, never use bare `git stash`.
- `AGENTS.md`: this repo's Next.js is not the one you remember. Read `node_modules/next/dist/docs/` before reaching for a Next API.

---

### Task 1: Bring the stack current with `main`

**Files:** no source changes of your own — this is a merge.

**Interfaces:**
- Consumes: nothing.
- Produces: a tree containing `main` at schema 103, so every later task edits the real current file.

- [ ] **Step 1: Merge the updated P2b branch into P3**

`claude/settings-popup-redesign-0ed30d` already carries `main` (merge commit `9b803f7f`). Bring it into P3:

```bash
git checkout claude/integrations-p3-ai
git merge claude/settings-popup-redesign-0ed30d --no-edit
```

- [ ] **Step 2: Resolve, keeping both sides**

If it conflicts, the rule is the same one that governed `9b803f7f`: **keep both sides' intent, never resolve by deleting one side's feature.** P3's changes are the OpenRouter provider, the deny-routing helper, the cost column and the OAuth flow; the other side is P1+P2 plus all of `main`.

`scripts/run-smoke.ts` conflicts resolve as the **union** of both manifests — an unregistered smoke is invisible to the suite and a duplicate breaks `--check`.

`SCHEMA_VERSION`: P3 holds 105, the other side holds 103. **105 wins** — it is the higher number and P3's two DDL changes are real. Confirm with `npx tsx scripts/smoke-schema-ddl.ts`.

- [ ] **Step 3: Verify P3**

```bash
npx tsc --noEmit
npx tsx scripts/run-smoke.ts --ci > /tmp/p3-suite.log 2>&1; echo "EXIT:$?"
grep -E "passed in|^FAIL" /tmp/p3-suite.log
```
Expected: tsc exit 0, suite green. If a script fails, check whether it fails on `claude/settings-popup-redesign-0ed30d` too before assuming it is yours.

- [ ] **Step 4: Bring P3 into this branch**

```bash
git checkout claude/integrations-ui-pass
git merge claude/integrations-p3-ai --no-edit
```
Resolve on the same rule. This branch holds only the spec commit, so conflicts should be minimal or none.

- [ ] **Step 5: Verify and record**

Re-run Step 3's commands on this branch. Record the final `SCHEMA_VERSION` and the suite's pass line in your report — later tasks depend on knowing the tree is current.

- [ ] **Step 6: Commit**

Merges commit themselves with `--no-edit`. Do not push.

---

### Task 2: Model tiers, and the dead-preset fix

**Files:**
- Modify: `src/lib/ai-providers.ts` (`PROVIDER_MODELS`, `DEFAULT_MODELS`, the entry type)
- Test: `scripts/smoke-ai-providers.ts` (extend; already registered)

**Interfaces:**
- Consumes: `SELECTABLE_AI_PROVIDERS`, `isSelectableAiProvider` (from P3).
- Produces: `ModelTier = "cheapest" | "balanced" | "best"`; each `PROVIDER_MODELS` entry may carry `tier?: ModelTier`; `tieredModels(provider)` returning the three in tier order.

- [ ] **Step 1: Verify the model ids before tagging anything**

The current Gemini list offers `gemini-2.5-pro`. `ai-providers.ts`'s own comment says Google answers 404 *"no longer available to new users"* for 2.5 models on any key issued since, and `LEGACY_MODEL_MAP` remaps the other two 2.5 entries for that reason but not this one. It cannot be a tier.

Check what each vendor actually serves:

```bash
curl -s --max-time 25 "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_KEY" | head -c 400
```

Google's and Anthropic's model lists need a key too. **If you do not have keys, do not guess** — report the candidate ids you propose for each tier and ask the controller to confirm them against Jason's keys. An id that cannot be verified is not tagged. Shipping two tiers for a provider beats shipping a button that 404s.

Record in your report, per provider: the three ids, and how each was confirmed.

- [ ] **Step 2: Write the failing checks**

Add to `scripts/smoke-ai-providers.ts`, in the file's existing `check(...)` style:

```ts
for (const p of SELECTABLE_AI_PROVIDERS) {
  const tiers = PROVIDER_MODELS[p.id].filter((m) => m.tier);
  check(`${p.id} tags exactly three models`, tiers.length === 3);
  check(
    `${p.id} tags one of each tier`,
    new Set(tiers.map((m) => m.tier)).size === 3
  );
  const balanced = PROVIDER_MODELS[p.id].find((m) => m.tier === "balanced");
  check(
    `${p.id}'s default is its balanced tier`,
    balanced !== undefined && DEFAULT_MODELS[p.id] === balanced.value
  );
}
check(
  "no tier points at a Gemini 2.5 model — Google 404s those for keys issued since",
  !PROVIDER_MODELS.gemini.some((m) => m.tier && m.value.startsWith("gemini-2.5"))
);
check(
  "tieredModels returns cheapest, balanced, best in that order",
  tieredModels("gemini").map((m) => m.tier).join(",") === "cheapest,balanced,best"
);
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx tsx scripts/smoke-ai-providers.ts`
Expected: FAIL to compile — `tier` is not a property, `tieredModels` is not exported.

- [ ] **Step 4: Add the tag and the accessor**

In `src/lib/ai-providers.ts`:

```ts
export type ModelTier = "cheapest" | "balanced" | "best";

const TIER_ORDER: readonly ModelTier[] = ["cheapest", "balanced", "best"];

/**
 * The three a person actually chooses between, in the order they are shown.
 *
 * Tagged on the preset entries rather than kept in a second table: two tables drift, and
 * the guard against that drift is more work than the tag. Untagged entries stay reachable
 * from Advanced's custom-model field, so nobody already on one loses it.
 */
export function tieredModels(provider: AiProvider) {
  return TIER_ORDER.map((tier) =>
    PROVIDER_MODELS[provider].find((m) => m.tier === tier)
  ).filter((m): m is NonNullable<typeof m> => m !== undefined);
}
```

Widen the `PROVIDER_MODELS` entry type to `{ value: string; label: string; tier?: ModelTier }`, tag the three ids you verified in Step 1 for each of gemini, openai and anthropic, and set `DEFAULT_MODELS[p]` to each provider's `balanced` id.

Replace `gemini-2.5-pro` with whatever Step 1 confirmed as Google's current top model, and add a `LEGACY_MODEL_MAP` entry pointing `gemini-2.5-pro` at it — a stored `2.5-pro` is a broken account today and the map is how this repo repairs those on read.

- [ ] **Step 5: Run the checks to verify they pass**

Run: `npx tsx scripts/smoke-ai-providers.ts`
Expected: all ok, including the pre-existing selectable-list checks from P3.

- [ ] **Step 6: Run the wider guards**

```bash
npx tsc --noEmit
npx tsx scripts/smoke-ai-request-options.ts
npx tsx scripts/smoke-fast-model.ts
```
Expected: all pass. `smoke-ai-request-options` matters because P3 made the family rules slug-aware and a changed model id can land on a different branch there.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai-providers.ts scripts/smoke-ai-providers.ts
git commit -m "Give each provider three models worth choosing between, and drop the dead one"
```

---

### Task 3: The marks

**Files:**
- Modify: `src/components/settings/provider-marks.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `GeminiMark`, `OpenAiMark`, `AnthropicMark`, `ClaudeMark`, `ChatGptMark` — each `({ className }: MarkProps) => JSX.Element`, matching the existing `GoogleMark` / `MicrosoftMark` / `LinkedInMark` signature.

- [ ] **Step 1: Read the existing marks first**

`src/components/settings/provider-marks.tsx` is 55 lines and holds three marks as inline SVG with a `className` prop. Follow that shape exactly — same prop, same file, no new dependency, no icon package.

- [ ] **Step 2: Add the five marks**

Draw each from the vendor's published brand asset rather than approximating. P2b's review caught Orbit's Google mark being an icons8 approximation and replaced it with Google's own values for exactly this reason — the same standard applies here.

Use the **Gemini spark** for the Gemini card, not the Google "G". The Google mark already means "your Google account" elsewhere in this dialog, and reusing it would make two different things look identical.

`ClaudeMark` and `ChatGptMark` are for the assistants page (Task 7); the other three are for the AI cards (Task 4).

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npx eslint src/components/settings/provider-marks.tsx
```
Expected: both exit 0. There is no visual test here; Task 10's in-app pass is where these are actually looked at.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/provider-marks.tsx
git commit -m "Add the marks the AI and assistants pages need"
```

---

### Task 4: `ProviderCard` and the AI page

**Files:**
- Create: `src/components/settings/provider-card.tsx`
- Modify: `src/components/settings/ai-settings.tsx`

**Interfaces:**
- Consumes: `tieredModels`, `ModelTier` (Task 2); the marks (Task 3); `SELECTABLE_AI_PROVIDERS`, `isSelectableAiProvider` (P3); `saveAiSettings`, `clearApiKey` (existing).
- Produces: `<ProviderCard provider={…} status={…} active={…} onSave={…} onClear={…} />`.

- [ ] **Step 1: Read what you are replacing**

`src/components/settings/ai-settings.tsx` is 379 lines. Before changing anything, find and understand these, because they are the things a rewrite silently deletes:

- `onLocalDevKeys`, `onLifetime`, `managedRuns` and the status prose they feed. Distinct copy for a dev server running on `.env.local`, for Lifetime's included AI, for a managed model differing from the chosen one, and for the allowance meter. **None of it is visible in demo mode**, so nothing fails if you drop it.
- The Anthropic-has-no-embeddings notice.
- The `aiModelMigratedFrom` one-time notice.
- The saved-keys list, already filtered by P3 to `isSelectableAiProvider(p.id) || p.hasPersonalKey`.

All of it moves into Advanced **intact**. Move the JSX; do not re-derive the conditions.

- [ ] **Step 2: Write `ProviderCard`**

One card: the provider's mark, its name, a state line, and then either a key field (no key) or the tier chooser plus Clear (key saved). The active provider's card is visually distinct — exactly one provider is active at a time, because that is what `aiProvider` means.

The tier chooser shows three options labelled **Cheapest**, **Balanced**, **Most accurate**, with `m.label` as small print beneath each. Choosing one calls `onSave({ provider, model: m.value })` — it stores the model id, per the spec's decision 1.

Saving a key goes through the existing `saveAiSettings`, which already verifies the key and already returns `{ ok: false, error }` as data rather than throwing (a thrown message becomes a digest in production).

- [ ] **Step 3: Rewrite `ai-settings.tsx` as a composer**

Three `<ProviderCard>`s rendered from `SELECTABLE_AI_PROVIDERS`, then a collapsed **Advanced** holding the custom model ID field, the saved-keys list, and every block from Step 1.

Use the disclosure shape already in `src/components/settings/integrations-overview.tsx` — a `<button aria-expanded aria-controls>` plus a panel that stays mounted with `hidden`. A panel that unmounts leaves `aria-controls` pointing at nothing, which is the defect P2b's Task 7 fixed in this same dialog.

The provider `<Select>` disappears: picking a card is picking the provider.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
npx eslint src/components/settings/provider-card.tsx src/components/settings/ai-settings.tsx
npx tsx scripts/smoke-toast-copy.ts
npx tsx scripts/smoke-ai-providers.ts
npx tsx scripts/smoke-tap-targets.ts
```
Expected: all pass. `smoke-ai-providers` includes P3's source check that neither picker file maps over `AI_PROVIDERS` — if you render from the wrong list it fails there.

Then grep your own diff for straight apostrophes in JSX text and string literals and fix any you introduced.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/provider-card.tsx src/components/settings/ai-settings.tsx
git commit -m "Three cards with logos, and everything technical behind Advanced"
```

---

### Task 5: The decision-model card

**Files:**
- Modify: `src/components/settings/decision-model-settings.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing other tasks read.

- [ ] **Step 1: Cut the description**

The `SettingsSection` description is currently ~90 words listing every step Jev handles. Cut it to one or two sentences: what Jev is, that it is optional, that nothing changes without a key. The status line and the TypeSafe key field stay exactly as they are — the key is the point of the card.

- [ ] **Step 2: Collapse "What Jev reads" rather than deleting it**

That row is a ~150-word data disclosure — which fields of a contact, a note, a calendar event a third-party model sees. **Keep it, behind a disclosure.** Removing a privacy statement to save vertical space is a bad trade even when the statement is long; collapsed it costs one line.

Use the same disclosure shape as Task 4 Step 3 (`hidden` panel, not unmount).

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npx eslint src/components/settings/decision-model-settings.tsx
npx tsx scripts/smoke-toast-copy.ts
```
Expected: all pass. Grep your diff for straight apostrophes.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/decision-model-settings.tsx
git commit -m "Say what the decision model is in two sentences, and fold the rest away"
```

---

### Task 6: AI usage, and the speech card beside it

**Files:**
- Modify: `src/lib/usage-summary-types.ts`, `src/lib/usage-summary.ts`
- Modify: `src/components/settings/ai-usage-card.tsx`
- Modify: `src/components/settings/speech-usage-card.tsx`
- Test: `scripts/smoke-usage-summary.ts`

**Interfaces:**
- Consumes: `usage_events.cost_source` (added by P3, currently read by nothing).
- Produces: `UsageSummary.costIsEstimated: boolean`.

- [ ] **Step 1: Write the failing checks**

`usage_events.cost_source` is `'estimated' | 'reported'`. P3 added it so a provider-reported figure and an `ai-pricing.ts` estimate stop being indistinguishable, and P3's final review noted nothing consumes it. This task is its first reader.

Add to `scripts/smoke-usage-summary.ts`, in its existing style:

```ts
check(
  "a window with any estimated row reports the cost as an estimate",
  summaryFor([{ costSource: "estimated" }, { costSource: "reported" }]).costIsEstimated === true
);
check(
  "a window of only reported rows does not call the cost an estimate",
  summaryFor([{ costSource: "reported" }, { costSource: "reported" }]).costIsEstimated === false
);
check(
  "an empty window is not claimed as exact",
  summaryFor([]).costIsEstimated === true
);
```

If `summaryFor` does not exist, write it as a thin wrapper over the real row-mapping function so the check tests shipped code rather than a copy.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/smoke-usage-summary.ts`
Expected: FAIL — `costIsEstimated` is not a field.

- [ ] **Step 3: Carry the source through**

Add `costIsEstimated: boolean` to `UsageSummary` in `src/lib/usage-summary-types.ts`. In `src/lib/usage-summary.ts`, compute it alongside the existing aggregates — true when any row in the window is `'estimated'`, and true for an empty window (an empty window is not evidence of exactness).

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx scripts/smoke-usage-summary.ts` — all ok.

- [ ] **Step 5: Rewrite the AI usage card**

Headline becomes what Orbit did: the call count over the window, in a sentence. Beneath it, a short plain-English list of where the calls went, using the `label` the summary already produces, top few only.

Delete the token columns entirely. Delete the per-row failure counts; if the failure rate is worth surfacing it is one line, not a column.

Cost becomes a single approximate figure. When `costIsEstimated` is true it is explicitly marked an estimate and names the provider's own dashboard as the real number. When false, it is stated plainly.

This honesty is not decoration: Orbit's pricing table is known to run roughly 5× low, so a figure presented as exact would understate what someone is spending by a large multiple.

- [ ] **Step 6: Give the speech card the same treatment**

`src/components/settings/speech-usage-card.tsx` (71 lines) meters Deepgram, which runs on **Orbit's** key under an allowance — different money from the AI card above it. Apply the same high-level treatment (activity first, no raw token or second counts) but **keep it a separate card**, visually subordinate, directly beneath AI usage. Do not merge the two: one card showing both would make "whose money is this" unanswerable.

- [ ] **Step 7: Verify**

```bash
npx tsc --noEmit
npx eslint src/lib/usage-summary.ts src/lib/usage-summary-types.ts src/components/settings/ai-usage-card.tsx src/components/settings/speech-usage-card.tsx
npx tsx scripts/smoke-usage-summary.ts
npx tsx scripts/smoke-toast-copy.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/lib/usage-summary.ts src/lib/usage-summary-types.ts src/components/settings/ai-usage-card.tsx src/components/settings/speech-usage-card.tsx scripts/smoke-usage-summary.ts
git commit -m "Say what Orbit did, then roughly what it cost — and say when that is a guess"
```

---

### Task 7: Logos on the Claude and ChatGPT page

**Files:**
- Modify: `src/components/settings/assistants-settings.tsx`

**Interfaces:**
- Consumes: `ClaudeMark`, `ChatGptMark` (Task 3).

- [ ] **Step 1: Place the marks**

The page walks through setup for each assistant as a numbered list. Put each assistant's mark beside its heading, at the same size the dialog's other marks use. No structural change — logos are what was asked for.

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit
npx eslint src/components/settings/assistants-settings.tsx
npx tsx scripts/smoke-settings-layout.ts
```
Expected: all pass. `smoke-settings-layout` asserts every page id still has a `Panel` case, so it catches an accidental structural break.

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/assistants-settings.tsx
git commit -m "Put the logos on the Claude and ChatGPT page"
```

---

### Task 8: Reminders — three destinations, URL behind Advanced

**Files:**
- Modify: `src/components/settings/calendar-feed-settings.tsx`
- Modify: `src/actions/calendar-feed.ts` (add the Outlook URLs)

**Interfaces:**
- Consumes: the existing `webcalUrl` and `googleAddUrl`.
- Produces: `outlookLiveAddUrl` and `outlookOfficeAddUrl` on the feed status.

- [ ] **Step 1: Understand the constraint before designing around it**

`src/actions/calendar-feed.ts:30` builds `webcalUrl` **only when a fresh token exists**. The token is hashed at rest, so Orbit genuinely cannot reconstruct the URL afterwards.

So destination buttons can exist only in the response that generates the feed. On a later visit the page can say the feed is on, but cannot offer a working button — only Regenerate, which invalidates the existing subscription. **Say this in the copy rather than working around it.** The alternative (encrypting the token so it can be rebuilt) was considered and rejected: it turns a credential that survives a database compromise into one that does not, for a page most people touch once.

- [ ] **Step 2: Add the Outlook URLs**

Microsoft has two hosts and nothing in the status says which someone has:

```ts
const encoded = webcalUrl ? encodeURIComponent(webcalUrl) : null;
// Two hosts, because Microsoft has two and nothing here says which this person uses.
// Guessing wrong fails silently, so both are offered rather than one picked.
outlookLiveAddUrl: encoded
  ? `https://outlook.live.com/calendar/0/addfromweb?url=${encoded}&name=Orbit%20reminders`
  : null,
outlookOfficeAddUrl: encoded
  ? `https://outlook.office.com/calendar/0/addfromweb?url=${encoded}&name=Orbit%20reminders`
  : null,
```

Add both to the status type beside `webcalUrl` and `googleAddUrl`.

- [ ] **Step 3: Rebuild the page**

One line saying what this does. Then, when a fresh URL exists: **Google Calendar** and **Apple Calendar** as one button each, and **Outlook** as two small links labelled work and personal.

When no fresh URL exists: a line saying reminders are in the calendar, and Regenerate — with copy that says plainly it replaces the current link and any existing subscription stops updating.

Collapsed **Advanced** holds the raw URL with its reveal and copy controls, and Regenerate. Use the same disclosure shape as Task 4.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
npx eslint src/components/settings/calendar-feed-settings.tsx src/actions/calendar-feed.ts
npx tsx scripts/smoke-toast-copy.ts
npx tsx scripts/smoke-tap-targets.ts
```
Expected: all pass. Grep your diff for straight apostrophes.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/calendar-feed-settings.tsx src/actions/calendar-feed.ts
git commit -m "Send reminders straight to the calendar someone actually uses"
```

---

### Task 9: LinkedIn timeline events become automatic

**Files:**
- Modify: `src/components/imports/linkedin-messages-import.tsx`
- Delete: `src/components/imports/timeline-backfill-toggle.tsx`
- Modify: `src/lib/linkedin-timeline-backfill.ts` (or wherever `timelineBackfillEnabled` is read at run time)
- Test: `scripts/smoke-purge-selective.ts` or the nearest existing settings smoke

**Interfaces:**
- Consumes: nothing.
- Produces: timeline derivation no longer gated by a user-facing control.

- [ ] **Step 1: Remove the control**

`TimelineBackfillToggle` is rendered at `src/components/imports/linkedin-messages-import.tsx:171` (the line number is from `main`'s rewritten version — Task 1 brought that in, so read the file rather than trusting the number). Remove the render and the import, then delete `timeline-backfill-toggle.tsx`. Remove `setTimelineBackfillEnabled` if nothing else calls it — grep first.

- [ ] **Step 2: Default the column on, and keep it as a kill switch**

`user_settings.timeline_backfill_enabled` is `integer NOT NULL DEFAULT 0`. It stays in the schema as an **operator kill switch with no UI**. Change the default to 1 and flip existing rows on.

That is a `SCHEMA_VERSION` bump and a data change. Run the all-refs scan before picking a number — other branches bump this constantly:

```bash
git fetch --all --prune -q
for r in $(git for-each-ref --format='%(refname)' refs/heads refs/remotes); do
  git show "${r}:src/db/index.ts" 2>/dev/null | grep -hoE 'SCHEMA_VERSION = [0-9]+'
done | grep -oE '[0-9]+' | sort -n | uniq | tail -5
```

**Run that under `bash -c`, not zsh** — the `${r}:path` form fires zsh's history modifiers and prints "bad substitution" for every ref while looking like it worked.

Take the next free integer above everything printed. Declare the change in the CREATE TABLE default, in `alters`, and in its own changelog entry. `npx tsx scripts/smoke-schema-ddl.ts` is the authority.

- [ ] **Step 3: Record what this does to existing accounts**

Flipping the column on starts spending each person's own AI budget — one call per conversation, under the existing daily cap — without asking them. That is the owner's decision, made after being told the audit made it opt-in for exactly that reason. Put a comment at the column saying so, so the next reader does not "fix" it back.

The column cannot distinguish "never touched" from "explicitly declined", so honouring a past decline is not possible without a schema change.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
npx eslint src scripts
npx tsx scripts/smoke-schema-ddl.ts
npx tsx scripts/run-smoke.ts --check
```
Expected: all pass. `--check` must still cover every registered script — deleting a component does not deregister a smoke, but check nothing referenced the deleted file.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Derive timeline events without asking, and keep the switch for operators"
```

---

### Task 10: Verify in the app, then hand over

**Files:** none — verification only.

- [ ] **Step 1: Static checks**

```bash
npx tsc --noEmit
npx eslint src scripts
npx tsx scripts/run-smoke.ts --check
npx tsx scripts/run-smoke.ts --ci > /tmp/ui-suite.log 2>&1; echo "EXIT:$?"
grep -E "passed in|^FAIL" /tmp/ui-suite.log
```
Expected: tsc silent, eslint 0 errors, suite green. Re-run `smoke-admin-render` or `smoke-instrumentation` alone if either times out — this suite has a known load flake.

- [ ] **Step 2: Re-resolve the schema version**

Re-run Task 9 Step 2's scan. Other branches move this constantly and a stale number passes locally but fails on Vercel, which builds the PR merged with its base.

- [ ] **Step 3: In-app, at 1280×860 and 375×812**

Unlike P3, all of this is reachable in demo mode. Start the demo preview from `.claude/launch.json`.

**Front the Browser pane and confirm `__reactFiber` is on a button before trusting any probe.** A hidden pane never hydrates, every click is inert, and every check passes vacuously. This has cost this project real time twice. `preview_start` with the URL re-opens the pane.

Walk: each provider card with and without a key · the tier chooser changing the stored model · Advanced holding the custom field, the saved keys and the Lifetime/dev prose · the decision-model card collapsed and expanded · the usage card's activity headline and its estimate wording · the speech card beneath it · the assistants marks · reminders from off → on → destination buttons → reload → the no-URL state · the LinkedIn messages panel with no toggle.

- [ ] **Step 4: Write the handover**

Report what passed, what could not be checked, and the one thing only Jason can close: **whether each refreshed model id actually answers for a real key.** That is the single failure that would make a tier button dead, and no local check can reach it.

- [ ] **Step 5: Push and open the PR — ask first**

```bash
git push -u origin claude/integrations-ui-pass
```

Open a PR targeting `claude/integrations-p3-ai`, not `main` — this is stacked, and basing on `main` would show every commit from #257 and #299. **Ask Jason before pushing.**

---

## Self-review

**Spec coverage.** §1 the AI page → Tasks 3, 4. §2 tiers and marks → Tasks 2, 3. §3 decision-model card → Task 5. §4 AI usage → Task 6. §5 reminders → Task 8. §6 assistants → Task 7. §7 LinkedIn → Task 9. Verification → the test step in every task, plus Task 10. The "live bug" section (`gemini-2.5-pro`) → Task 2 Steps 1 and 4.

**Not in the spec, added here:** Task 1 (the stack is not current with `main`, and `#238` rewrote a file this pass edits) and Task 6 Step 6 (`SpeechUsageCard` did not exist when the spec was written).

**Type consistency.** `ModelTier` and `tieredModels` are defined in Task 2 and used in Task 4. The five marks are defined in Task 3 and used in Tasks 4 and 7. `costIsEstimated` is defined in Task 6 and used only there. `outlookLiveAddUrl` / `outlookOfficeAddUrl` are defined and used in Task 8.

**Known gap, deliberate.** Correcting `ai-pricing.ts`'s ~5×-low table is out of scope; Task 6 makes the estimate honest rather than accurate.
