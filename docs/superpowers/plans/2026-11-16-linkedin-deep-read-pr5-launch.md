# LinkedIn deep read, PR 5: launch. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the deep read needs to go live for everyone is merged and dark: /privacy says what it does, MCP clients get the relationship block, existing users are caught up automatically, and the fixes launch makes live are in. Turning it on is one last commit that Jason triggers after his eval.

**Architecture:**
- **Catch-up is driven by queries, not flags.** Three things are owed to an existing user, each found by its own predicate and each self-clearing: your history (a `career_profile.historyCheckedAt` marker), the origin pass (the value `"origin-checked"` in `relationship_digests.sources`), and closeness (`closeness_cohorts.snapshot.deepRead` not true). No DDL.
- **The origin pass** is a second, smaller reader beside the relationship runner. It claims digests that have a watermark, no origin and no check; builds a window from the opening of the thread plus the LinkedIn signals; sends the **same prompt the eval measures** (`buildDigestPrompt` with `deepRead: true`); and applies only origin, kind and events. It never writes the watermark, summary, facts, reminders or attempts. Batch API only, under a new operation id `relationship.origin` so the batch sweep routes its answers and usage shows its real cost.
- **Who runs it.** `/api/relationships/run` runs the origin pass after the normal pass, in the time left. The hourly `process-stalled` cron does the cheap parts inline (history, cohort marking) and kicks that route for users with origin work. No new route, no new `maxDuration`.
- **Before the flip** every catch-up path is scoped to admins (`adminUserIds()`), because `deepReadOn` is already true for them. That is how Jason measures on his own data. After the flip the scope is everyone.

**Tech Stack:** TypeScript, Next.js App Router, Drizzle + Postgres (neon-http / PGlite), provider Batch APIs through `submitAiBatch`, tsx smokes (`npm test`), node:test (`npm run test:unit`).

**Spec:** `docs/superpowers/specs/2026-11-15-linkedin-deep-read-design.md`, "PR 5: Launch" and "Constraints". Builds on PR 1 (#707), PR 2 (#709), PR 3 (#710), PR 4. Jason's five decisions for this PR (Nov 16) are binding and are reflected below.

## Global Constraints

- **Tasks 1 to 9 are safe to merge with the flag dark.** For a non-admin, nothing in them changes what Orbit reads, sends or writes until Task 10. Every new path asks `deepReadOn(userId)` or the admin scope.
- **Task 10 is not done by an agent on its own.** It runs only after Jason says go, having run `npx tsx scripts/eval-ai.ts --task relationship --runs 2` on his paid key and looked at `originAccuracy`, `kindAccuracy`, `eventAccuracy`.
- No DDL (schema stays 247). If a task turns out to need one: re-scan remote refs for the next free number above 247, add it through `reconcileSchema`, update `scripts/schema-ddl.lock.json`, and tell Jason before going on.
- No new route, no new `maxDuration` value (Vercel function cap is full). AI only through `ai-access.ts` (`submitAiBatch`).
- The origin pass must never write `watermark_at`, `watermark_interaction_id`, `message_count`, `attempts`, `updated_at`, `summary`, `topics`, `open_threads`, key facts, action items or reminders.
- `TERMS_VERSION` and `LEGAL_LAST_UPDATED` move once, in Task 8, with both pages and the lock.
- New smokes are registered in `scripts/run-smoke.ts` (tier `pglite`) and `npm run check:sources` is run. PGlite smokes must not run while `next dev` runs.
- Commit after each task; nothing pushed until Jason says so.

## Review Focus

1. The origin pass on a contact with unread newer messages: the watermark, message count and `updated_at` are byte-identical after it, and the contact is still pending for the normal pass. (Task 5)
2. Two route invocations for one user at once: a contact is claimed by one of them only, and a batch that never answers hands its contacts back. (Tasks 4, 5)
3. A user who pressed "Remove imported details", or whose current role did not come from their export: the catch-up never writes their history, now or on a later tick. (Task 6)
4. A relationship kind removed while a pass is mid-apply, or on the losing side of a merge: still removed afterwards. (Task 1)
5. Every sentence added to /privacy: true of the code with the flag off and with it on. No "Undo" (there is no button for it, see Not in this PR). (Task 8)

## File Structure

- Create `src/lib/relationship-engine/origin-pass.ts`: marker, window, claim, run, batch apply/release, estimate.
- Create `src/lib/deep-read-catch-up.ts`: history and signals from the kept export, cohort marking, the cron stage's one entry point.
- Create `scripts/smoke-relationship-origin-pass.ts`, `scripts/smoke-deep-read-catch-up.ts` (PGlite), `scripts/measure-origin-pass.ts` (read-only tool, not a smoke).
- Modify: `src/lib/relationship-engine/apply.ts`, `runner.ts` (export `overlapContext`), `pending.ts`; `src/lib/deep-read.ts`; `src/lib/ai-operations.ts`; `src/lib/ai-batch-apply.ts`; `src/app/api/relationships/run/route.ts`; `src/app/api/imports/process-stalled/route.ts`; `src/lib/contact-merge.ts`; `src/actions/contacts.ts`; `src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx`; `src/lib/radar/why-prompt.ts`, `src/lib/radar/run.ts`; `src/lib/tools/definitions.ts`, `definitions-features.ts`, `tools.snapshot.json`; `src/lib/career-profile-server.ts`, `src/db/schema.ts` (type only); `src/lib/linkedin-export-apply.ts`; `src/app/(site)/(docs)/privacy/page.tsx`, `terms/page.tsx`, `src/lib/legal.ts`, `scripts/smoke-legal-pages.ts`, `scripts/legal-pages.lock.json`; `src/lib/imports/linkedin-export-files.ts`; last, `src/lib/surfaces.ts` and `scripts/smoke-surface-visibility.ts`.

---

### Task 1: A removed relationship kind stays removed

**Files:** `src/lib/relationship-engine/apply.ts`, `src/lib/contact-merge.ts`, `src/actions/contacts.ts`. Tests: `scripts/smoke-relationship-apply.ts`, `scripts/smoke-relationship-merge.ts`.

- `applyDigestPlan` step 4: `values.relationship` is built from a digest read earlier, so a "Not right?" landing in between is overwritten. Move the final upsert into `export async function saveDigest(values: typeof relationshipDigests.$inferInsert): Promise<void>` (same file, called from step 4), and in its `onConflictDoUpdate` `set` replace `relationship` with
  `sql\`CASE WHEN ${relationshipDigests.relationship}->>'removed' = 'true' THEN ${relationshipDigests.relationship} ELSE excluded.relationship END\``.
- `contact-merge.ts`, beside the existing `UPDATE relationship_digests SET watermark_at = NULL …` and before the loser is deleted: one statement that copies a loser's removed kind to the winner when the winner's is not removed.
  `INSERT INTO relationship_digests (contact_id, user_id, relationship) SELECT winnerId, user_id, relationship FROM relationship_digests WHERE contact_id = loserId AND user_id = userId AND relationship->>'removed' = 'true' ON CONFLICT (contact_id) DO UPDATE SET relationship = excluded.relationship WHERE coalesce(relationship_digests.relationship->>'removed','') <> 'true'`. Not archived for unmerge (same rule as the watermark reset beside it).
- `removeContactRelationshipKind`: replace `/^[0-9a-f-]{36}$/i` with `isUuid` from `@/lib/ids`.

- [ ] **Step 1: Failing checks.**
  - `smoke-relationship-apply.ts`: the race cannot be timed in a test, so the final upsert becomes a seam, `saveDigest(values)`. Seed a digest row with `relationship: { kind: "friend", excerpt: "x", interactionId, removed: true }`, then call `saveDigest({ ...row, relationship: { kind: "coworker", excerpt: "y", interactionId } })` (what a pass that read the row before the removal would write). Expect `relationship.kind === "friend"` and `relationship.removed === true`. Same call over a row that is not removed → `kind === "coworker"`.
  - `smoke-relationship-merge.ts`: loser digest `{ kind: "recruiter", removed: true }`, winner has no digest; after `mergeContacts`, the winner's digest has `relationship.removed === true`. Second case: winner `{ kind: "friend" }` (not removed), loser removed → winner `removed === true`, `kind === "recruiter"`. Third: neither removed → winner's `kind === "friend"` unchanged.
  - `isUuid("------------------------------------") === false` and `isUuid("00000000-0000-0000-0000-00000000000g") === false` (both pass today's regex or its length check loosely; the first is the one the old regex accepts), and the action source no longer contains `[0-9a-f-]{36}`.
- [ ] **Step 2: Run** `npx tsx scripts/smoke-relationship-apply.ts` and `npx tsx scripts/smoke-relationship-merge.ts`. Expected: FAIL on the new lines only.
- [ ] **Step 3: Implement** the three changes above.
- [ ] **Step 4: Run** both, plus `smoke-contact-merge`, `smoke-merge-coverage`, `smoke-relationship-context`. Expected: pass.
- [ ] **Step 5: Commit** `fix(deep-read): a removed relationship kind survives a concurrent pass and a merge`.

### Task 2: The contact page loads in parallel; Radar's note key knows the relationship

**Files:** `src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx`, `src/lib/radar/why-prompt.ts`, `src/lib/radar/run.ts`. Test: `scripts/smoke-radar-score.ts`.

- Page: start `const relationshipPromise = userIdPromise.then((u) => loadRelationshipContexts(u, [id])).catch(() => new Map<string, RelationshipContext>())` beside `healthPromise` (before the first `await`), and replace the sequential await near line 272 with `(await relationshipPromise).get(id) ?? null`.
- `radarNoteKey(rec)`: `rec` gains `relationship?: readonly string[]`. Added to the hashed object **only when non-empty** (`...(rec.relationship?.length ? { relationship: [...rec.relationship] } : {})`), so every existing key is unchanged.
- `radar/run.ts`: where `inputsHash` is computed, pass `relationship: relationshipFactLines(ctx)` from one `loadRelationshipContexts(userId, picks.map((p) => p.contactId))` call for the batch (empty map when deep read is off, so nothing changes for dark users).

- [ ] **Step 1: Failing checks** in `smoke-radar-score.ts`: `radarNoteKey({ ...base, relationship: [] }) === radarNoteKey(base)`; `radarNoteKey({ ...base, relationship: ["How you met: Met at HackNC (Sep 2022)"] }) !== radarNoteKey(base)`; the same list twice gives the same key.
- [ ] **Step 2: Run** `npx tsx scripts/smoke-radar-score.ts`. Expected: FAIL (the key ignores `relationship`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `smoke-radar-score` and the pure `smoke-radar-*`; `tsc`. Expected: pass.
- [ ] **Step 5: Commit** `fix(deep-read): contact page loads the relationship with its other reads; Radar notes refresh when it changes`.

### Task 3: MCP clients get the relationship block

**Files:** `src/lib/tools/definitions.ts`, `src/lib/tools/definitions-features.ts`, `src/lib/tools/tools.snapshot.json`. Tests: `scripts/smoke-chat-feature-tools.ts`, `src/lib/tools/definitions.test.ts`.

- `get_contact`: drop the `if (!wide) return {};` line and its "Chat (and Cosmo) only" comment; the block is returned on both surfaces. `noteCap` (2000) and `entryCap` (500) for MCP are untouched. The block is already at most six lines of 240 characters (`renderRelationshipBlock`).
- `get_dossier`: remove `if (ctx?.surface !== "chat") return dossier;`; `fields.mcp` becomes `["contact", "brief", "goals", "stale", "relationship"]`; fix the comment.
- Still gated: `loadRelationshipContexts` returns an empty map when `deepReadOn` is false, so a dark user's MCP result has no `relationship` key.

- [ ] **Step 1: Failing checks** in `smoke-chat-feature-tools.ts`: flip the two existing MCP assertions. With deep read on and a digest whose origin is "Met at HackNC" (month precision, 2022-09-01): `get_dossier` over MCP has `relationship` containing `"How you met: Met at HackNC (Sep 2022)"`; `get_contact` over MCP has the same line and its `notes` is still at most 2000 characters for a 5,000-character note. With deep read off: no `relationship` key on either tool, either surface (existing checks stay).
- [ ] **Step 2: Run** `npx tsx scripts/smoke-chat-feature-tools.ts` and `node --import tsx --test src/lib/tools/definitions.test.ts`. Expected: FAIL (MCP has no key; snapshot unchanged yet).
- [ ] **Step 3: Implement**, then `UPDATE_SNAPSHOT=1 node --import tsx --test src/lib/tools/definitions.test.ts`. The only snapshot diff must be `get_dossier` `fields.mcp` gaining `"relationship"`.
- [ ] **Step 4: Run** both again plus `smoke-tool-registry`, `smoke-tenant-isolation`. Expected: pass.
- [ ] **Step 5: Commit** `feat(deep-read): connected assistants get the relationship block (get_contact, get_dossier)`.

### Task 4: The origin pass: what is owed, and what it reads

**Files:** Create `src/lib/relationship-engine/origin-pass.ts`. Modify `apply.ts`, `pending.ts`. Test: create `scripts/smoke-relationship-origin-pass.ts`.

**Interfaces (produced):**

```ts
/** A value in relationship_digests.sources: this contact's opening and signals were read for origin. */
export const ORIGIN_CHECKED = "origin-checked";
export const ORIGIN_WINDOW_CHARS = 6_000;   // opening messages
export const ORIGIN_SIGNAL_LIMIT = 10;      // invitation notes, recommendations, your LinkedIn notes
export const ORIGIN_SIGNAL_CHARS = 1_000;   // per signal
/** Signals first (each clipped), then the oldest messages until ORIGIN_WINDOW_CHARS, all in date order. Null when empty. truncatedBefore is always null. */
export function buildOriginWindow(contactId: string, opening: WindowMessage[], signals: WindowMessage[]): MessageWindow | null;
/** Opening = MESSAGE_INTERACTION_SQL rows at or before the watermark, oldest first, LIMIT 60. Signals = SIGNAL_ROW_SQL rows, oldest first. */
export async function loadOriginWindows(userId: string, contactIds: string[]): Promise<Map<string, MessageWindow>>;
/** Atomically marks up to `limit` owed digests in flight (batch_job_id = claimId, batch_pending_until = now + BATCH_STALE_HOURS) and returns their contact ids. */
export async function claimOriginContacts(userId: string, limit: number, claimId: string, now?: Date): Promise<string[]>;
export async function originPendingCount(userId: string, now?: Date): Promise<number>;
/** Users with owed digests and the engine on. `onlyUsers` null = everyone. */
export async function usersWithOriginWork(limit: number, onlyUsers: string[] | null, now?: Date): Promise<string[]>;
```

Decisions:
- **"Owed"** (one SQL fragment shared by claim, count and the user list): `d.watermark_at IS NOT NULL AND d.origin IS NULL AND NOT (d.sources @> '["origin-checked"]'::jsonb) AND (d.batch_pending_until IS NULL OR d.batch_pending_until < now)`. The in-flight marker is the one the runner uses, so a claimed contact is also out of the normal pending set until its batch lands.
- **The marker is also set by any deep first pass.** In `applyDigestPlan` and `advanceWatermarkOnly`, when `deepRead` and the digest had no watermark, add `ORIGIN_CHECKED` to `sources`. Otherwise every contact first read after launch would be read twice.
- `pending.ts` exports `SIGNAL_ROW_SQL` (`m.source = 'linkedin_export' AND <CONTEXT_SIGNALS_SQL> AND btrim(coalesce(m.raw_notes,'')) <> ''`).
- Claim order: `d.message_count DESC, d.contact_id` (longest threads first; no extra join).

- [ ] **Step 1: Failing checks** (new smoke; pure first, then PGlite).
  - Pure: 100 messages of 200 characters dated 2022-09-17 onward, one invitation dated 2022-09-01, one recommendation dated 2025-01-01 → `window.text.length <= 6_000 + 2 * 1_000 + 64`; first line starts `[2022-09-01 Me]`; last line starts `[2025-01-01`; `window.messages` includes message 0 and not message 99; `truncatedBefore === null`.
  - Pure: a 5,000-character recommendation is kept as exactly 1,000 characters; 12 signals keep 10; no rows → `null`.
  - PGlite: contact A has a digest (`watermarkAt = T`, `origin: null`, `sources: ["linkedin"]`), three `linkedin_message` rows at or before `T` (the first: "Great meeting you at HackNC!"), one after `T`, and one `li-export:invitation_sent:a` row. `claimOriginContacts(USER, 100, C1)` returns `[A]`; a second call with `C2` returns `[]`; A's `batchJobId === C1`.
  - Never claimed: B (origin set), C (`sources` has `"origin-checked"`), D (digest without a watermark), E (another user's).
  - A's window contains "HackNC" and the invitation text, and not the message after `T`.
  - `applyDigestPlan` with `deepRead: true` on a contact with no digest → `sources` includes `"origin-checked"`; the same with `deepRead: false` → it does not. `advanceWatermarkOnly(…, { deepRead: true })` on a new contact → it does.
- [ ] **Step 2: Run** `npx tsx scripts/smoke-relationship-origin-pass.ts`. Expected: fails (module missing).
- [ ] **Step 3: Implement.** Register the smoke; `npm run check:sources`.
- [ ] **Step 4: Run** it plus `smoke-relationship-apply`, `smoke-relationship-pending`, `smoke-relationship-runner`, `smoke-relationship-schema`. Expected: pass.
- [ ] **Step 5: Commit** `feat(deep-read): find the contacts owed an origin check and build their window`.

### Task 5: The origin pass: run it, apply it, schedule it

**Files:** `origin-pass.ts`, `apply.ts`, `runner.ts`, `src/lib/ai-operations.ts`, `src/lib/ai-batch-apply.ts`, `src/app/api/relationships/run/route.ts`. Test: `scripts/smoke-relationship-origin-pass.ts`, `scripts/smoke-relationship-extract.ts`.

**Interfaces (produced):**

```ts
// apply.ts — the 3b block of applyDigestPlan, moved out unchanged and called from both places.
export async function writeOriginAndKind(input: { userId: string; contactId: string; runId: string; validated: Pick<ValidatedDigest, "origin" | "relationship">; previous: { origin: RelationshipOrigin | null; relationship: RelationshipKindRecord | null }; now: Date }): Promise<{ origin: RelationshipOrigin | null; relationship: RelationshipKindRecord | null }>;
/** Origin, kind (never over a removed one), events and the first reach-out; marks the contact checked and clears the in-flight marker. One UPDATE of origin, relationship, sources, batch_job_id, batch_pending_until; nothing else. */
export async function applyOriginOnly(input: { userId: string; runId: string; contactId: string; validated: ValidatedDigest | null; now?: Date }): Promise<void>;

// origin-pass.ts
export type OriginBatchPayload = { runId: string; items: Array<{ customId: string; contactId: string }> };
export type OriginPassResult = { claimed: number; trivial: number; submitted: number; remaining: number };
export async function runOriginPass(userId: string, opts?: { budgetMs?: number; limit?: number; now?: Date; submit?: typeof submitAiBatch; deepRead?: boolean }): Promise<OriginPassResult>;   // limit: at most this many contacts in all (Task 7's sample)
export async function applyOriginBatch(job: Pick<AiBatchJobRow, "id" | "userId" | "payload">, outcomes: BatchOutcome[]): Promise<void>;
export async function releaseOriginBatch(job: Pick<AiBatchJobRow, "id" | "userId">): Promise<void>;
```

Decisions:
- **Prompt:** `buildDigestPrompt({ contactName, window, previous: null, deepRead: true, context })`, with `context` from the runner's `overlapContext` (export it). Same prompt and `DIGEST_MAX_OUTPUT_TOKENS` the eval measures, so Jason's eval gate covers this pass. Everything in the answer except origin, relationship and events is discarded.
  `// ponytail: reuses the full digest prompt and throws most of the answer away. A three-key prompt would cut output tokens; write it (and an eval variant) if Task 7's number says it matters.`
- **Operation:** add `"relationship.origin": { label: "Relationship analysis (how you met, one-time)", tier: "fast", thinking: "minimal", background: true }` to `AI_OPERATIONS`, and an `APPLIERS` entry (`apply: applyOriginBatch`, `release: releaseOriginBatch`). Background, so on Orbit's accounts it pauses with the other background work when credits run low.
- **Batch only.** `submit` returning null (no key, credits low, OpenRouter) releases the claim and returns; the next hourly kick tries again. No inline fallback: a catch-up is not worth full price.
- **One attempt per contact.** An answer that fails to parse or validate still marks the contact checked. A batch that never answers (`release`) clears the marker without marking, so those contacts are retried.
- **Trivial windows** (`isTrivialWindow(window, { deepRead: true })`) and contacts with no window are marked checked with no model call.
- **Run row:** one `relationship_runs` row per submitted batch, inserted after a successful submit with a pre-generated id, `status: "done"`, `finishedAt: now`. It gives `origin.runId` something real, so `undoRelationshipRun` takes those origins back like any other run's.
- **Apply:** for each payload item whose digest still has `batch_job_id = job.id`, rebuild the window with `loadOriginWindows`, `parseDigestAnswer`, `validateDigest(answer, window, new Set(), { deepRead: true })`, `applyOriginOnly`. `writeDeepReadTimeline(userId, contactId, events, true)`: this is these contacts' first deep pass, and the reach-out id matches the old reader's, so nobody gets a second one.
- **Loop:** claim up to `MAX_BATCH_REQUESTS` (100), submit, repeat while `budgetMs` allows and the last claim was full.
- **Route:** after `runRelationshipPass`, when `deepReadOn(userId)` and at least 30 s of the 270 s budget is left, `runOriginPass(userId, { budgetMs: left })`. Re-kick also when `origin.remaining > 0 && origin.submitted + origin.trivial > 0`.

- [ ] **Step 1: Failing checks** (PGlite, same smoke; `submit` stubbed).
  - `runOriginPass(USER, { deepRead: true, submit: stub→JOB })`: stub called once with operation `"relationship.origin"` and 1 request whose `user` contains "HackNC"; result `{ claimed: 1, trivial: 0, submitted: 1, remaining: 0 }`; A's `batchJobId === JOB`; a `relationship_runs` row with `status === "done"` exists.
  - `applyOriginBatch` with the answer `{"summary":"IGNORED","facts":[{"text":"IGNORED FACT","excerpt":"Great meeting you at HackNC!"}],"origin":{"text":"Met at HackNC","date":"2022-09-17","context":"event","excerpt":"Great meeting you at HackNC!"},"relationship":{"kind":"classmate","excerpt":"Great meeting you at HackNC!"},"events":[]}`:
    `origin.text === "Met at HackNC"`, `origin.precision === "day"`, `relationship.kind === "classmate"`, `sources` includes `"origin-checked"`, `batchJobId === null`; and unchanged from before the pass: `watermarkAt.getTime() === T`, `watermarkInteractionId`, `messageCount`, `attempts === 0`, `updatedAt`, `summary === "old summary"`; the contact's `keyFacts` has no "IGNORED FACT"; `howMet === "Met at HackNC"` (was "LinkedIn connection"); `pendingRelationshipContactCount(USER)` is still 1 (the message after `T`).
  - A contact whose `howMet` the user typed (`field_sources.met.s === "user"`): `howMet` unchanged, digest `origin.replaced === null`.
  - A digest with `relationship.removed` → still removed after an answer naming a kind.
  - Outcome text `"not json"` → `sources` includes `"origin-checked"`, `origin === null`, `attempts === 0`.
  - `releaseOriginBatch` → `batchJobId === null`, no marker, and `claimOriginContacts` returns the contact again.
  - `submit` stub returning `null` → result `submitted === 0`; `batchJobId === null`; no marker; no `relationship_runs` row added.
  - A thread that is only "Thanks for connecting!" → `trivial === 1`, stub not called, marker set.
  - `deepRead: false` → `{ claimed: 0, trivial: 0, submitted: 0, remaining: 0 }` and no query claims anything.
  - `undoRelationshipRun(USER, originRunId)` puts `howMet` back to "LinkedIn connection" and nulls the digest's origin; the marker stays (it is not re-read).
  - `smoke-relationship-extract.ts`: `AI_OPERATIONS["relationship.origin"]` has `tier === "fast"` and `background === true`.
- [ ] **Step 2: Run** the smoke. Expected: FAIL (`runOriginPass` missing).
- [ ] **Step 3: Implement.** Moving 3b into `writeOriginAndKind` must not change `applyDigestPlan`'s behaviour.
- [ ] **Step 4: Run** it plus `smoke-relationship-apply`, `smoke-relationship-runner`, `smoke-ai-batch`, `smoke-relationship-extract`. Expected: pass, with no edits to existing expectations.
- [ ] **Step 5: Commit** `feat(deep-read): one-time origin pass over conversations already read (batch only, watermark untouched)`.

### Task 6: Catch up existing users from the cron

**Files:** Create `src/lib/deep-read-catch-up.ts`. Modify `src/lib/deep-read.ts`, `src/lib/career-profile-server.ts`, `src/db/schema.ts` (`CareerProfile.historyCheckedAt?: string`), `src/lib/linkedin-export-apply.ts`, `src/lib/relationship-engine/pending.ts`, `src/app/api/imports/process-stalled/route.ts`. Test: create `scripts/smoke-deep-read-catch-up.ts`; extend `scripts/smoke-linkedin-you-db.ts`.

**Interfaces (produced):**

```ts
// deep-read.ts — for jobs: no user, no cookie. True once the surface is neither coming-soon nor hidden.
export async function deepReadLaunched(): Promise<boolean>;   // getComingSoonKeys() + getHiddenSurfaceKeys()

// deep-read-catch-up.ts
/** Users with a kept Positions.csv or Education.csv, no career_profile.positions/education, and no historyCheckedAt. */
export async function usersNeedingHistory(limit: number, onlyUsers: string[] | null): Promise<string[]>;
/** Writes positions[] / education[] from the newest kept export when the user already applied that file; always stamps historyCheckedAt. */
export async function catchUpHistory(userId: string, now?: Date): Promise<{ positions: number; education: number }>;
/** Stages the kept export's per-person notes when the user has none yet. Returns rows staged. */
export async function restageExportSignals(userId: string): Promise<number>;
/** dirty_at = coalesce(dirty_at, now()) for cohorts whose snapshot.deepRead is not true. Returns rows marked. */
export async function markCohortsForDeepRead(onlyUsers: string[] | null): Promise<number>;
export type CatchUpStats = { deepHistoryCaughtUp: number; deepSignalsRestaged: number; deepCohortsMarked: number; deepOriginKicks: number };
export async function runDeepReadCatchUp(opts?: { limit?: number; kick?: (userId: string) => Promise<void> }): Promise<CatchUpStats>;
```

Decisions:
- **Scope:** `const scope = (await deepReadLaunched()) ? null : adminUserIds()`; an empty admin list returns zeros at once.
- **"Already applied their own details"** (history is then written with no new review, per the spec): for Positions, `career_profile.role` equals what `parseLinkedInPositionsCsv` reads from the kept file (title and company, case-insensitive); for Education, every school `parseLinkedInEducationCsv` reads is in `user_settings.schools`. Otherwise nothing is written. `role` alone is not proof: onboarding can set it from a web lookup.
- **Only the two files are read** (the `applyShareTopics` query shape with `lower(path) IN ('positions.csv','education.csv')` or `LIKE '%/…'`, newest `created_at`, `gunzipExportFile`). `readExportTexts` would unzip Messages.csv for nothing.
- **Written with** `saveCareerPatch(userId, { career: { positions?, education?, historyCheckedAt }, senderBio: null, schools: null, message: "" })`, then `markCohortDirty(userId)` when anything was written (overlap feeds closeness).
- **"Remove imported details" must stick:** `clearCareerProfile` keeps `historyCheckedAt` (add it to its `jsonb_build_object`).
- **Signals:** only for a user with zero interactions whose `external_id LIKE 'li-export:%'` and a kept export (those are exports uploaded Oct 15 to Nov 12, before `applyExportExtras` existed). Split `applyExportExtras` so the staging half is `stageExportSignals(userId, importId, texts): Promise<number>`; `restageExportSignals` calls it with `rowIndex` starting after the import's current maximum, sets the import to `processing` with `totalRows` raised, and runs `runImportJobById`. Target companies, role keywords and background are **not** re-applied: that would bring back targets the person removed and overwrite their background.
- **Closeness:** `markCohortsForDeepRead(scope)` is one UPDATE and needs no marker: a cohort recalibrated with deep read on stores `snapshot.deepRead = true` and stops matching. The existing `recalibrate` stage, which runs later in the same route, does the work.
- **Kicks:** for each user in `usersWithOriginWork(limit, scope)`: `catchUpHistory` first (a no-op once stamped, and it puts the overlap in the origin prompt), then `kick(userId)` (default `kickRelationshipRun`).
- **Signal-only contacts:** `usersWithPendingRelationshipWork(limit, now, opts?: { deepRead?: boolean })` passes `messageRowSql({ deepRead, signals: "trigger" })` to `pendingFrom`. The existing `relationship-kicks` stage calls it with `{ deepRead: await deepReadLaunched() }`, so after launch a contact with only an invitation note or a recommendation is picked up by the backstop.
- **Route:** one new stage `deep-read-catch-up` placed **before** `recalibrate`: `Object.assign(stats, await runDeepReadCatchUp())`, with the four counters added to `stats`. Same try/catch/`status = "partial"` shape as its neighbours.

- [ ] **Step 1: Failing checks** (PGlite, new smoke).
  - `deepReadLaunched()` is `false`; after inserting the `live:feature.linkedin-deep-read` row and `invalidateHiddenSurfaceKeys()`, `true`.
  - U1: `career_profile.role = { title: "Engineer", company: "Acme" }`, kept Positions.csv with "Engineer at Acme" (no end) and "Intern at Beta" (2019 to 2020) → `catchUpHistory(U1)` returns `{ positions: 2, education: 0 }`; `career_profile.positions.length === 2`; `historyCheckedAt` is set; `role` unchanged; `closeness_cohorts.dirty_at` is not null.
  - U2: same file, `role = { title: "Founder", company: "Other" }` → `{ positions: 0, education: 0 }`, no `positions` key, `historyCheckedAt` set, and `usersNeedingHistory(25, null)` no longer lists U2.
  - U3: `schools = ["UNC Chapel Hill"]`, kept Education.csv with that one school → `education.length === 1`.
  - `clearCareerProfile(U1)` → no `positions`; `historyCheckedAt` still set; `usersNeedingHistory` does not list U1 (also asserted in `smoke-linkedin-you-db.ts`).
  - `usersNeedingHistory(25, ["u3"])` lists only U3 while U1 was still owed.
  - `restageExportSignals(U1)` with a kept Invitations.csv naming one existing contact and no `li-export:` rows → returns 1; `target_companies` count unchanged. With one `li-export:` row already present → returns 0 and the import's status is untouched.
  - `markCohortsForDeepRead(null)`: a cohort with `snapshot.deepRead === true` keeps `dirtyAt === null`; one without gets a `dirtyAt`; a second call returns the same row with the **same** `dirtyAt`. `markCohortsForDeepRead(["u1"])` touches only U1's.
  - `runDeepReadCatchUp({ kick: spy })` with no `live:` row and `ADMIN_USER_IDS` unset → all four counters 0, spy never called. With `ADMIN_USER_IDS = U1` and U1 owing one origin check → `deepOriginKicks === 1`, spy called with U1 only.
  - `usersWithPendingRelationshipWork(25, now, { deepRead: true })` lists a user whose only pending contact has just an invitation row; with `{ deepRead: false }` it does not.
- [ ] **Step 2: Run** `npx tsx scripts/smoke-deep-read-catch-up.ts`. Expected: fails (module missing).
- [ ] **Step 3: Implement.** Before writing `restageExportSignals`, read `runImportJob`'s finish step and confirm a second run of a completed `linkedin_export` import only attaches the new rows. If it does anything else a person would see (a notification, a second Undo entry), stop and report instead of working around it. Register the smoke; `npm run check:sources`.
- [ ] **Step 4: Run** it plus `smoke-linkedin-you-db`, `smoke-linkedin-export-extras`, `smoke-relationship-pending`, `smoke-closeness-materialized`, `smoke-surface-visibility`. Expected: pass.
- [ ] **Step 5: Commit** `feat(deep-read): catch up existing users from the hourly sweep (history, signals, closeness, origin kicks)`.

### Task 7: Measure the cost before launch

**Files:** `origin-pass.ts`, create `scripts/measure-origin-pass.ts`. Test: `scripts/smoke-relationship-origin-pass.ts`.

```ts
export const ORIGIN_TYPICAL_OUTPUT_TOKENS = 400;
/** No model call. Input tokens = characters / 4, as estimateBatchMicros counts them; batch price. */
export function originPassEstimate(prompts: Array<{ system: string; user: string }>, model: string): {
  contacts: number; inputTokensPer1000: number; outputTokensPer1000: number; microsPer1000: number | null; microsPer1000Max: number | null;
};
```

`scripts/measure-origin-pass.ts --user <id>` (read-only; `process.exit` at the end): lists the user's owed contacts with the Task 4 predicate **without claiming**, builds each window and prompt exactly as `runOriginPass` does, drops trivial ones, and prints: owed, trivial (free), sent, tokens and cost per 1,000 conversations (typical and worst case at `DIGEST_MAX_OUTPUT_TOKENS`), the projected total for this user, and the model (`getAiConfig(userId, "relationship.digest").model`). It prints the same for a first read of contacts that become pending only because of signals (`pendingRelationshipContactCount` with and without `deepRead`).

- [ ] **Step 1: Failing check:** two prompts totalling 8,000 characters, model `M` (any priced model the pricing smoke already uses) → `contacts === 2`, `inputTokensPer1000 === 1_000_000`, `outputTokensPer1000 === 400_000`, `microsPer1000 === estimateCostMicros({ model: M, inputTokens: 1_000_000, outputTokens: 400_000, batch: true })`, `microsPer1000Max === estimateCostMicros({ model: M, inputTokens: 1_000_000, outputTokens: 2_000_000, batch: true })`; an empty list → `contacts === 0` and both costs `0`.
- [ ] **Step 2: Run** the smoke. Expected: FAIL.
- [ ] **Step 3: Implement** the function and the script.
- [ ] **Step 4: Run** the smoke; `npx tsx scripts/measure-origin-pass.ts --user <a seeded PGlite user>` prints a table and exits 0.
- [ ] **Step 5: Hand to Jason** (these touch his real data, so he runs them):
  - The number: `npx tsx scripts/measure-origin-pass.ts --user <his user id>`.
  - A real 10-contact sample: `npx tsx scripts/measure-origin-pass.ts --user <his user id> --run 10`, which calls `runOriginPass` capped at 10 contacts (one half-price batch; answers land with the next hourly sweep). Real tokens and cost then show under Settings → Integrations → AI provider as "Relationship analysis (how you met, one-time)".
- [ ] **Step 6: Commit** `chore(deep-read): estimate the origin pass's cost per 1,000 conversations without a model call`. The PR body states the per-1,000 number and Jason's projected total.

### Task 8: /privacy, /terms, the version, the file list

**Files:** `src/app/(site)/(docs)/privacy/page.tsx`, `src/app/(site)/(docs)/terms/page.tsx`, `src/lib/legal.ts`, `scripts/smoke-legal-pages.ts`, `scripts/legal-pages.lock.json`, `src/lib/imports/linkedin-export-files.ts`. Test: `scripts/smoke-legal-pages.ts`, `scripts/smoke-import-files.ts`.

The copy is written to be true on both sides of the flip: before it, it describes more than a non-admin account does yet, never less. Use `&rsquo;` / `&ldquo;` as the page does.

**1. Privacy, the card near line 30.** Replace "a few, like deriving LinkedIn timeline events, run automatically in the background" with:

> a few, like reading the LinkedIn messages you import, run automatically in the background

**2. Privacy, the AI section's background paragraph (near lines 597 to 605).** Replace from "Importing LinkedIn messages writes a short summary" through "simple keyword matching instead." with:

> Reading the LinkedIn messages you import also runs in the background; the next paragraphs say what it reads and keeps.

Remove the now-unused `TIMELINE_DAILY_CONTACT_CAP` import. Then add, directly after that paragraph:

> **Your LinkedIn export: what Orbit reads.** When you import LinkedIn messages or a whole LinkedIn export, Orbit reads it with the AI provider and key described above. For each person, it reads your conversation with them, the notes on connection requests either of you sent, recommendations either of you wrote, and any notes you kept about them on LinkedIn. A thread with nothing in it to understand, such as a lone "thanks for connecting", gets no AI call. From the export Orbit also keeps your own work and school history: every role and school, with dates. It uses that as context about you in chat and Cosmo, and to work out where your path and a contact's crossed.

> **What it keeps about each person.** A short summary of where things stand, what they do and are working on, the topics you talk about, follow-ups still open, memorable details, and reminders for some of the things either of you said you would do. It also keeps how you first met, with a date when a message gives one; the kind of relationship, such as classmate, coworker or recruiter; and dated things that happened between you, such as a call or a meeting, which are added to that person's timeline. How you met, the kind and each event are kept only with a quote copied from one of your messages. What the AI cannot quote is dropped. Where your history and theirs overlap is worked out each time it is shown and is not stored.

> **What it changes on a contact.** How you met, the date and the setting are written onto a contact only when that field is empty or holds an import's own label, such as "LinkedIn connection". What you typed stays: once you set how you met yourself, Orbit does not replace it, and you can edit it at any time. A date is written only when a message gives the exact day. "September 2022" is shown as that and is never turned into a day. A relationship kind has a "Not right?" button on the contact's page. Press it and the kind is removed and is not set again.

> **How it affects closeness.** Whether you both wrote, how many years you have been in touch, whether one of you recommended the other, and whether you worked or studied at the same place count toward how close Orbit ranks a person. The AI's reading of the relationship does not.

> **Where it is used.** In Orbit's chat and Cosmo, in drafts Orbit writes for you, in Radar's notes, in a contact's brief and meeting talking points, and on the contact's page. If you have connected an outside assistant, it receives the same short description when it asks about that person; see Assistants you connect yourself. "Remove imported details" in Settings removes your own history.

> **If you imported before this was added.** Orbit catches up once, in the background: it adds your full history from the export you already uploaded if you had already imported your role or schools from it, and it re-reads the opening of each conversation it has already summarised to find how you met. That second read does not create reminders or change a summary.

**3. Privacy, "Assistants you connect yourself."** After the sentence ending "and when you are free, if you ask it to look." add:

> For a person it asks about, that also includes Orbit's short description of the relationship: how you met, the kind of relationship, what you talk about, what is still open, and where your histories overlap.

**4. Terms (near lines 270 to 275).** Replace "deriving timeline events from the imported conversations, without you turning anything on first. The cap of {TIMELINE_DAILY_CONTACT_CAP} conversations a day only counts the conversations that reach the model; a thread with a single message gets a rule-based note instead, with no AI call." with:

> reading the imported conversations, without you turning anything on first. A thread with nothing in it to understand gets no AI call.

Remove the unused import there too.

**5. `legal.ts`:** `TERMS_VERSION = "2026-11-16"`, `LEGAL_LAST_UPDATED = "November 16, 2026"`, with a changelog comment in the file's style (deep read: what is read, kept, written, where it goes including connected assistants, the one-time catch-up; the timeline cap sentence retired). First `git fetch --all` and `git grep -n "TERMS_VERSION = " $(git for-each-ref --format='%(refname)' refs/remotes) -- src/lib/legal.ts | sort -u`: if any ref already uses `2026-11-16`, take the next free suffix (`.2`), as earlier bumps did.

**6. `smoke-legal-pages.ts`:** replace the two "the timeline cap is quoted from code" checks with: `!privacy.includes("up to 40 of")`; `!privacy.includes("TIMELINE_DAILY_CONTACT_CAP") && !terms.includes("TIMELINE_DAILY_CONTACT_CAP")`; `privacy.includes("Your LinkedIn export: what Orbit reads")`; `privacy.includes("Not right?")`; `privacy.includes("how you met, the kind of relationship")` (the assistants sentence); `!/LinkedIn[^.]*\bUndo\b/.test(privacy)`.

**7. `PARSED`:** every file the deep read reads is already listed (positions, education, invitations, notes, both recommendations files). The one file Orbit reads that is listed as merely stored is `shares.csv` (Radar's hashtags, `linkedin-shares.ts`): add `"shares.csv"`.

- [ ] **Step 1: Failing checks:** the smoke edits in 6, and in `smoke-import-files.ts`: `linkedInExportRole("Shares.csv") === "parsed"`, `linkedInExportRole("Events.csv") === "stored"`.
- [ ] **Step 2: Run** `npx tsx scripts/smoke-legal-pages.ts` and `npx tsx scripts/smoke-import-files.ts`. Expected: FAIL on the new checks.
- [ ] **Step 3: Implement** 1 to 5 and 7, then `npx tsx scripts/smoke-legal-pages.ts --update`.
- [ ] **Step 4: Run** both smokes, `npm run lint`, `npm run css:site` (commit if it changes). Read the rendered /privacy section once in the preview at desktop and 375px. Expected: pass; the lock shows the new version and fingerprint.
- [ ] **Step 5: Commit** `docs(legal): /privacy and /terms describe the LinkedIn deep read; terms 2026-11-16`.

### Task 9: Whole-branch checks and the PR

- [ ] `tsc` (0 errors outside `.next`), `npm run lint`, `npm run db:check`, `npm run check:sources`, `npm run check:cycles`, `npm run test:unit`.
- [ ] Stop `next dev`, then `npm test`. Expected: all pass.
- [ ] Re-check `origin/main` for a rival TERMS_VERSION or schema bump since Task 8; fix and re-run the legal smoke if so.
- [ ] Open the PR (when Jason says). Its body states: the origin pass's tokens and cost per 1,000 conversations and Jason's projected total (Task 7); that the flag is still dark; that existing users are re-asked to accept the terms once; what the catch-up does and does not re-apply; and the Task 10 checklist.

### Task 10: Turn it on (only on Jason's go, after his eval)

**Gate:** Jason has run `npx tsx scripts/eval-ai.ts --task relationship --runs 2` on his paid key, the origin, kind and event scores look right to him, the 10-contact sample (Task 7) looks right on his own contacts, and he has said go. This is its own commit, last on the branch, or its own follow-up PR if PR 5 has already merged.

**Files:** `src/lib/surfaces.ts`, `scripts/smoke-surface-visibility.ts`. Nothing else.

- [ ] **Step 1:** In `smoke-surface-visibility.ts`, change the check near line 492 to expect `getSurface(LINKEDIN_DEEP_READ_SURFACE_KEY)?.comingSoon !== true`, and the check near line 192 ("deep read is off for an ordinary user while the surface is coming soon") to expect `true` under a new label; drop the `live:` row insert below it, which is no longer what turns it on. Run it. Expected: FAIL.
- [ ] **Step 2:** In `surfaces.ts`, remove `comingSoon: true` and the "Until /privacy describes it" comment from the `LINKEDIN_DEEP_READ_SURFACE_KEY` entry.
- [ ] **Step 3:** Run `smoke-surface-visibility`, `smoke-deep-read-catch-up`, `smoke-relationship-origin-pass`, then `npm test`. Expected: pass.
- [ ] **Step 4: Commit** `feat(deep-read): release the LinkedIn deep read`.
- [ ] **Step 5: After deploy (Jason):** the next `process-stalled` run (:30) should show non-zero `deepCohortsMarked` and `deepOriginKicks` in `cron_runs.stats`; `ai_batch_jobs` should gain `relationship.origin` rows. To stop the catch-up, re-add `comingSoon: true`: batches already out still apply, nothing new is claimed.

## Not in this PR

- **An Undo button for a run.** `undoRelationshipRun` exists and takes origins back, but nothing in the app calls it, so /privacy does not promise Undo. A person corrects how-met by editing the contact, and a kind with "Not right?".
- **Removing a wrong origin from prompts.** After a person types their own how-met, the digest's origin still shows as a second line and still feeds chat and drafts. Needs a product call (hide it, or a second "Not right?").
- **Offering the history to people who never applied their own details** (the spec's "offered in Settings"). They get it the next time they apply Positions or Education from Imports, where it is already a pre-ticked item.
- **Re-applying target companies, role keywords and background** from the kept export: it would undo removals.
- **The origin pass for OpenRouter keys** (no batch adapter): those contacts stay owed and are read when one exists.
- **A three-key origin prompt** and its eval variant: only if the measured cost says so.
- Deleting the old timeline reader, its cap and its batch applier: the follow-up the spec already names, one release after launch.
- B (circles, closest people): its own design once this is live.
