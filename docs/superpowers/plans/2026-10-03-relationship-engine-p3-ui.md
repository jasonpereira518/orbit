# Relationship Engine P3 — Run Summary, Profile Surfaces, Engine Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make what the relationship engine writes visible and controllable: a run summary (with Undo all and one-click flags) in `/imports` and the bell, the digest on the contact profile (what they do, summary, topics, source line, open threads with Remind me / Dismiss, You owe / They owe badges), WhatsApp / iMessage timeline icons, the Settings → AI switch — and close the engine's run-lifecycle gaps that P1 and P2 deferred.

**Architecture:**
- **Engine first (Tasks 1–2).** Runs learn which import started them, finish when idle, stop re-spending on a missing key, refuse Undo while live, and can't fork their note batch. Everything the UI reads is then trustworthy.
- **One read model per surface.** `summary.ts` builds a `RunSummary` (run + its reminders + flags with names + truncation/failure counts) — the import sheet, the `/imports` card and the bell all read it. `digest-view.ts` builds a `DigestView` for the profile. Both are plain data; components are presentational and render-smoked without a router.
- **Every new write goes through the run's note batch** (`ensureRunNoteBatch`), so Undo all also removes reminders made by one-click flag/thread promotion.
- **No schema change.** Every lookup uses existing columns and indexes (`relationship_runs (user_id, status)`, `relationship_digests` PK). `SCHEMA_VERSION` stays 148.

**Tech Stack:** Next.js App Router (read the relevant guide in `node_modules/next/dist/docs/` before touching actions/routes, per AGENTS.md), React 19 client components, Drizzle (neon-http in prod, PGlite locally), lucide-react, date-fns, `tsx` smoke scripts registered in `scripts/run-smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-09-30-relationship-engine-design.md` — §6 Run summary and Profile, §5 Runner / Keys, §3 Housekeeping. Earlier plans for context: `docs/superpowers/plans/2026-09-30-relationship-engine-p1-core.md`, `docs/superpowers/plans/2026-10-01-relationship-engine-p2-chat-imports.md`.

**Branch:** stack on P2. Create `claude/relationship-engine-p3-ui` from `claude/relationship-engine-p2-chat-imports` (PR #402, head `72046068` or later). The PR targets that branch until #402 merges, then retarget (`gh pr edit <n> --base main` once #398 and #402 are in; the repo does not auto-retarget).

## Global Constraints

- Every smoke script starts with `import "./smoke/_env";`, is registered in `MANIFEST` in `scripts/run-smoke.ts` (`"pure"` or `"pglite"`), uses its own user id, deletes its own rows first, and ends with `process.exit(0)`. `npx tsx scripts/run-smoke.ts --check` must pass.
- **No DDL.** `SCHEMA_VERSION` stays **148**; `npm run db:check` must pass unchanged.
- **Engine writes stay idempotent** (no transactions on neon-http): every new insert is keyed (`reminders.item_hash` is unique per user) or compare-and-set.
- **Reminders made from the run summary or the profile carry `noteBatchId` = the run's batch** (`ensureRunNoteBatch(userId, runId)`) and are appended to that batch's `result.reminders`, so the run's Undo all reaches them.
- **Undo all refuses a run whose status is `queued`, `running` or `waiting_key`** (copy: `Analysis is still running — undo it once it finishes`).
- Server actions: `"use server"` files export only async functions. Client-facing refusals are **returned** as `{ error: string }` (the `refusal()` pattern in `src/actions/imports.ts`), never thrown — a thrown message is digested in production. Every action derives `userId` from the session (`requireUserId()` or the codebase's equivalent) and scopes every query by it (the action user-scope smoke parses `src/actions/**`).
- Toast and refusal copy: no trailing period (`smoke-toast-copy`); caught errors through `friendlyError(err, TOAST_COPY.…)`.
- Presentational components take plain props and use no `next/navigation` hooks, so they render in a `renderToStaticMarkup` smoke. Containers (router, transitions, actions) wrap them. Client components never import a module that imports `@/db`.
- Statement budgets: the notification panel budget in `scripts/smoke-page-budgets.ts` may rise by **exactly one** statement, and only when the caller opts in (`relationship: true`). The desktop poll never pays it.
- The engine is live (LinkedIn messages are already disclosed); chat sources stay dark behind `feature.chat-imports`. Nothing in P3 changes that gate.
- Copy voice: sentence case, no exclamation marks, numbers as digits, "people" not "contacts" in summaries.
- Commit after each task; message trailer `Co-Authored-By: <your model> <noreply@anthropic.com>`.

## Decisions made while planning (flag at handoff)

1. **No schema change.** Lookups by `import_id` filter the user's few runs (the `(user_id, status)` index narrows by user) rather than adding an `import_id` index; the note-batch race is fixed with compare-and-set rather than a unique index.
2. **A run belongs to the import that STARTED it.** One active run per user means several uploads can fold into one run; a later import's detail sheet shows the latest run marked "Analyzed together with an earlier upload".
3. **`waiting_key` retry lease.** A key-paused run keeps `lease_until = now + 24h` so the hourly backstop stops re-spending on it; saving a key (Settings or OpenRouter) or switching the engine back on clears that lease and kicks. No new column.
4. **The bell shows one info row, not a due item.** A finished run is a sibling summary of `items` (like Radar), so it never becomes an OS notification or a badge count. It shows while the run is active and for 3 days after it finishes.
5. **One-click reminders are due tomorrow at 09:00 UTC** (flag and thread alike) — a flag's date has passed, and a thread had no date.
6. **Open-thread Dismiss is permanent for that thread key.** It removes the thread from `open_threads`; a later message that reopens the topic produces a new key.
7. **Deferred, not in P3:** cutting the ~24 statements per contact in the batch applier (background, half-price path; not user-visible); listing "overflow past the caps" in the summary (the engine records no overflow count — it needs a run counter, i.e. DDL); cross-run flag dedupe beyond "same key within this run"; LinkedIn-keyed readers (closeness cohort, Radar) reading chat rows; capture writing `owed_by`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/relationship-engine/runner.ts` | (modify) `kickRelationshipRun(userId, importId?)`, `resumeKeyPausedRun`, `KEY_RETRY_MS`, import id on reused runs, `releaseRun` never resurrects `undone`, `loadOwnerName` |
| `src/lib/relationship-engine/pending.ts` | (modify) backstop rotates order and skips live leases; `usersWithIdleActiveRuns` |
| `src/app/api/relationships/run/route.ts` | (modify) read `importId` from the body |
| `src/app/api/imports/process-stalled/route.ts` | (modify) also kick idle active runs |
| `src/lib/import-engine.ts` | (modify) `finalize(userId, contactIds, importId)` |
| `src/lib/import-adapters/chat.ts`, `linkedin-messages.ts` | (modify) pass `importId` to the kick |
| `src/actions/settings.ts`, `src/app/api/openrouter/callback/route.ts` | (modify) resume + kick on key save; engine switch |
| `src/lib/relationship-engine/apply.ts` | (modify) undo refuses active runs; CAS note batch; flags dedupe + cap |
| `src/lib/relationship-engine/extract.ts` | (modify) owner name in the prompt |
| `src/lib/contact-merge.ts` | (modify) reset the winner digest's counters and markers |
| `src/lib/relationship-engine/summary.ts` | (new) `RunSummary`, loaders, `latestRunNotice` |
| `src/lib/relationship-engine/summary-copy.ts` | (new, db-free) `RunSummary` types + `runSummaryCopy` |
| `src/lib/relationship-engine/promote.ts` | (new) flag and thread → reminder / dismiss |
| `src/lib/relationship-engine/digest-view.ts` | (new) `loadDigestView` |
| `src/lib/relationship-engine/digest-copy.ts` | (new, db-free) `DigestView`, `digestSourceLine`, `topicLine` |
| `src/actions/relationships.ts` | (new) user actions for runs, flags and threads |
| `src/actions/imports.ts` | (modify) `ImportDetail.relationshipRun` |
| `src/components/imports/relationship-run-summary.tsx` | (new) `RunSummaryView` (pure) + `RelationshipRunCard` (container) |
| `src/components/imports/import-history.tsx`, `import-hub.tsx` | (modify) render the summary |
| `src/lib/notification-panel.ts`, `src/components/notifications/notifications-panel.tsx` | (modify) the analysis row |
| `src/components/settings/ai-settings.tsx` | (modify) "Relationship analysis" switch |
| `src/lib/action-items.ts`, `src/components/contacts/contact-next-steps.tsx` | (modify) `owedBy` + badge |
| `src/components/contacts/contact-digest.tsx` | (new) `DigestSection` (pure) |
| `src/components/contacts/contact-open-threads.tsx` | (new) `OpenThreadsList` (pure) + `ContactOpenThreads` (container) |
| `src/components/contacts/contact-brief-card.tsx`, `contacts/[id]/page.tsx` | (modify) wire digest + threads |
| `src/components/icons/chat-source-icons.tsx` | (new) WhatsApp / iMessage glyphs |
| `src/components/contacts/contact-timeline.tsx`, `src/actions/contacts.ts` | (modify) carry `source`, pick the icon |
| `scripts/smoke-relationship-*.ts` | tests (new: `-summary`, `-ui`, `-settings`) |

---

### Task 1: Run lifecycle — import id, idle finish, key-pause lease, backstop order

**Files:**
- Modify: `src/lib/relationship-engine/runner.ts:80-120` (kick, `claimRun`, `releaseRun`), `:200-206` (key pause)
- Modify: `src/app/api/relationships/run/route.ts`
- Modify: `src/lib/import-engine.ts:170` (finalize type) and `:1234-1237` (call)
- Modify: `src/lib/import-adapters/chat.ts:82-85`, `src/lib/import-adapters/linkedin-messages.ts:162-166`
- Modify: `src/lib/relationship-engine/pending.ts:92-102`
- Modify: `src/app/api/imports/process-stalled/route.ts:410-417`
- Modify: `src/actions/settings.ts:228`, `src/app/api/openrouter/callback/route.ts:88-99`
- Test: `scripts/smoke-relationship-runner.ts` (extend), `scripts/smoke-relationship-pending.ts` (extend)

**Interfaces:**
- Produces:
  - `KEY_RETRY_MS = 24 * 3_600_000` (exported from `runner.ts`)
  - `kickRelationshipRun(userId: string, importId?: string | null): Promise<void>` — body `{ userId, importId }`
  - `resumeKeyPausedRun(userId: string): Promise<void>` — clears `lease_until` on the user's unclaimed `waiting_key` run
  - `usersWithIdleActiveRuns(limit: number, now?: Date): Promise<string[]>` (`pending.ts`) — users with a `queued|running` run whose lease is null or expired, with no pending contacts and no batch in flight for that run
  - `ImportAdapter.finalize?(userId: string, contactIds: string[], importId: string): Promise<void>`

- [ ] **Step 1: Write the failing tests** — append to `scripts/smoke-relationship-runner.ts` inside its `main()`, before the final cleanup. Reuse the file's own helpers for resetting the user, seeding a contact with N message interactions, and its stubbed `extract`; the names below (`resetUser`, `seedMessages`, `stubExtract`, `NOW`, `USER`, `db`) stand for whatever the file calls them — use the file's names.

```ts
  // P3: a new run remembers the import that started it.
  await resetUser();
  await seedMessages("Ivy Import", 3);
  const imp = crypto.randomUUID();
  await runRelationshipPass(USER, { extract: stubExtract, importId: imp, now: NOW });
  let runRow = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.userId, USER), orderBy: desc(relationshipRuns.createdAt) });
  check("run: import id recorded", runRow?.importId === imp, String(runRow?.importId));

  // P3: a key-paused run holds a retry lease; the backstop skips it; resume clears it.
  await resetUser();
  await seedMessages("Kay Key", 3);
  const keyless = await runRelationshipPass(USER, { extract: async () => { throw new Error("Missing API key"); }, now: NOW });
  check("key pause: status", keyless.status === "waiting_key", keyless.status);
  runRow = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.userId, USER) });
  check("key pause: retry lease ~24h", !!runRow?.leaseUntil && runRow.leaseUntil.getTime() >= NOW.getTime() + KEY_RETRY_MS - 1_000, String(runRow?.leaseUntil));
  check("key pause: backstop skips it", !(await usersWithPendingRelationshipWork(100, NOW)).includes(USER));
  const busy = await runRelationshipPass(USER, { extract: stubExtract, now: NOW });
  check("key pause: a pass inside the lease is busy", busy.status === "busy", busy.status);
  await resumeKeyPausedRun(USER);
  const resumed = await runRelationshipPass(USER, { extract: stubExtract, now: NOW });
  check("key pause: resume lets the next pass run", resumed.status === "done" && resumed.processed === 1, JSON.stringify(resumed));

  // P3: an active run with nothing pending is found by the idle sweep and finishes on the next pass.
  await resetUser();
  const [idle] = await db.insert(relationshipRuns).values({ userId: USER, status: "running" }).returning();
  check("idle: listed", (await usersWithIdleActiveRuns(100, NOW)).includes(USER));
  const idlePass = await runRelationshipPass(USER, { extract: stubExtract, now: NOW });
  const idleAfter = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, idle.id) });
  check("idle: finished", idlePass.status === "done" && idleAfter?.status === "done", `${idlePass.status} ${idleAfter?.status}`);
  check("idle: no longer listed", !(await usersWithIdleActiveRuns(100, NOW)).includes(USER));
```

If the stubbed `extract` makes the "Missing API key" message classify as something other than key-level, throw whatever the file's existing `waiting_key` case throws instead. Add imports: `desc` from `drizzle-orm`, `crypto` from `node:crypto`, `KEY_RETRY_MS, resumeKeyPausedRun` from `../src/lib/relationship-engine/runner`, `usersWithIdleActiveRuns, usersWithPendingRelationshipWork` from `../src/lib/relationship-engine/pending`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-relationship-runner.ts`
Expected: FAIL — a missing export, or `run: import id recorded failed`.

- [ ] **Step 3: Implement the runner changes** in `src/lib/relationship-engine/runner.ts`

```ts
/** A key-paused run is not retried by the backstop for this long; saving a key resumes it at once. */
export const KEY_RETRY_MS = 24 * 3_600_000;

export async function kickRelationshipRun(userId: string, importId: string | null = null): Promise<void> {
  try {
    await internalFetch("/api/relationships/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, importId }),
    });
  } catch (err) {
    reportError(err, { where: "job.relationships.kick", userId, level: "warning" });
  }
}

/** A new key (or the switch turned back on) may fix what paused the run: drop the retry lease. */
export async function resumeKeyPausedRun(userId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(relationshipRuns)
    .set({ leaseUntil: null })
    .where(and(eq(relationshipRuns.userId, userId), eq(relationshipRuns.status, "waiting_key"), isNull(relationshipRuns.claimToken)));
}
```

In `claimRun`, after the existing-run lookup (before the claim UPDATE), adopt the import id when a reused run has none:

```ts
  if (importId && !run.importId) {
    await db.update(relationshipRuns).set({ importId }).where(and(eq(relationshipRuns.id, run.id), isNull(relationshipRuns.importId)));
  }
```

Change `releaseRun` so a patch may set `leaseUntil`, and so a pass can never overwrite an Undo:

```ts
async function releaseRun(runId: string, token: string, patch: Partial<RelationshipRunRow>) {
  const db = await getDb();
  await db
    .update(relationshipRuns)
    .set({ claimToken: null, leaseUntil: null, ...patch })
    .where(and(eq(relationshipRuns.id, runId), eq(relationshipRuns.claimToken, token), ne(relationshipRuns.status, "undone")));
}
```

In `attemptInline`'s key-level branch, park with the retry lease:

```ts
        await releaseRun(run.id, token, {
          status: "waiting_key",
          inlineUsed,
          leaseUntil: new Date(now.getTime() + KEY_RETRY_MS),
          lastError: String((err as Error)?.message ?? err).slice(0, 500),
        });
```

Add `ne` to the `drizzle-orm` import.

- [ ] **Step 4: Backstop queries** in `src/lib/relationship-engine/pending.ts` — replace `usersWithPendingRelationshipWork` and add `usersWithIdleActiveRuns`:

```ts
/**
 * Users with pending work and the engine switched on — the cron backstop's input. A user
 * whose active run holds a live lease (running now, or key-paused with its retry lease) is
 * skipped, and the order rotates hourly so the same users cannot hold every slot.
 */
export async function usersWithPendingRelationshipWork(limit: number, now: Date = new Date()): Promise<string[]> {
  const db = await getDb();
  const hour = now.toISOString().slice(0, 13);
  const result = await db.execute(sql`
    SELECT c.user_id ${pendingFrom(now)}
      AND EXISTS (
        SELECT 1 FROM user_settings us
         WHERE us.user_id = c.user_id AND us.relationship_engine_enabled = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM relationship_runs r
         WHERE r.user_id = c.user_id
           AND r.status IN ('queued', 'running', 'waiting_key')
           AND r.lease_until > ${now.toISOString()}::timestamptz
      )
    GROUP BY c.user_id
    ORDER BY md5(c.user_id || ${hour})
    LIMIT ${limit}
  `);
  return rowsOf<{ user_id: string }>(result).map((r) => r.user_id);
}

/** Active runs nobody is working on and with nothing left to read: one more pass closes them. */
export async function usersWithIdleActiveRuns(limit: number, now: Date = new Date()): Promise<string[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT r.user_id FROM relationship_runs r
     WHERE r.status IN ('queued', 'running')
       AND (r.lease_until IS NULL OR r.lease_until < ${now.toISOString()}::timestamptz)
       AND NOT EXISTS (SELECT 1 ${pendingFrom(now)} AND c.user_id = r.user_id)
       AND NOT EXISTS (
         SELECT 1 FROM relationship_digests d
          WHERE d.user_id = r.user_id AND d.run_id = r.id
            AND d.batch_pending_until > ${now.toISOString()}::timestamptz
       )
     ORDER BY r.created_at
     LIMIT ${limit}
  `);
  return rowsOf<{ user_id: string }>(result).map((r) => r.user_id);
}
```

`pendingFrom` aliases `contacts c` / `relationship_digests d`; inside the idle query's subquery the outer alias is `r`, so there is no clash. If PGlite rejects the nested `d` alias, rename the outer digest alias to `dd`.

- [ ] **Step 5: Plumb the import id and the kicks**
  - `src/lib/import-engine.ts:170`: `finalize?(userId: string, contactIds: string[], importId: string): Promise<void>;` — and at the call site (`:1235`) pass `importRow.id` as the third argument. Mention the import id in the hook's doc comment.
  - `src/lib/import-adapters/chat.ts`: `async finalize(userId, contactIds, importId) { if (contactIds.length === 0) return; await kickRelationshipRun(userId, importId); }`
  - `src/lib/import-adapters/linkedin-messages.ts:162-166`: pass `importId` the same way (keep its timeline backfill kick).
  - `src/app/api/relationships/run/route.ts`: parse `{ userId?: string; importId?: string | null }` and call `runRelationshipPass(userId, { importId: typeof body?.importId === "string" ? body.importId : null })`. The self-continue kick stays `kickRelationshipRun(userId)`.
  - `src/app/api/imports/process-stalled/route.ts:410-417`: after the existing pending sweep, add
    ```ts
    for (const userId of await usersWithIdleActiveRuns(TIMELINE_BACKFILL_USERS, now)) await kickRelationshipRun(userId);
    ```
    (use the route's existing `now`, or `new Date()` if it has none).
  - `src/actions/settings.ts:228`: `if (newKey) after(async () => { await resumeKeyPausedRun(userId); await kickRelationshipRun(userId); });`
  - `src/app/api/openrouter/callback/route.ts`: after `applyAiKeyChange(...)` succeeds, `after(async () => { await resumeKeyPausedRun(<route's user id>); await kickRelationshipRun(<route's user id>); });` (import `after` from `next/server`).

- [ ] **Step 6: Run the tests**

Run: `npx tsx scripts/smoke-relationship-runner.ts && npx tsx scripts/smoke-relationship-pending.ts && npx tsx scripts/smoke-chat-import-engine.ts && npx tsx scripts/smoke-import-engine.ts && npx tsx scripts/smoke-ai-batch.ts && npm run typecheck`
Expected: all PASS. If `smoke-relationship-pending` asserted the old unordered output of `usersWithPendingRelationshipWork`, change that assertion to compare sets.

- [ ] **Step 7: Commit**

```bash
git add src/lib/relationship-engine/runner.ts src/lib/relationship-engine/pending.ts src/app/api/relationships/run/route.ts src/app/api/imports/process-stalled/route.ts src/lib/import-engine.ts src/lib/import-adapters/chat.ts src/lib/import-adapters/linkedin-messages.ts src/actions/settings.ts src/app/api/openrouter/callback/route.ts scripts/smoke-relationship-runner.ts scripts/smoke-relationship-pending.ts
git commit -m "fix(relationships): runs know their import, finish when idle, and stop re-spending on a missing key"
```

---

### Task 2: Run write safety — undo guard, note-batch CAS, flag dedupe, merge reset, owner name

**Files:**
- Modify: `src/lib/relationship-engine/apply.ts:57-95` (`ensureRunNoteBatch`), `:366-377` (flags), `:422-446` (`undoRelationshipRun`)
- Modify: `src/lib/relationship-engine/extract.ts:156-185` (`buildDigestPrompt`)
- Modify: `src/lib/relationship-engine/runner.ts:159-166` (`promptFor`), `:174-180` (settings read), `applyRelationshipBatch`
- Modify: `src/lib/contact-merge.ts:418-430`
- Modify: `scripts/lib/eval-ai-tasks.ts` (prompt call)
- Test: `scripts/smoke-relationship-apply.ts`, `scripts/smoke-relationship-extract.ts`, `scripts/smoke-relationship-merge.ts` (extend each)

**Interfaces:**
- Produces:
  - `RunStillActiveError` (class extending `Error`, exported from `apply.ts`), thrown by `undoRelationshipRun` for `queued|running|waiting_key`
  - `MAX_RUN_FLAGS = 50` (exported from `apply.ts`)
  - `buildDigestPrompt(input: { contactName: string; ownerName: string | null; window: MessageWindow; previous: PreviousDigest | null }): { system: string; user: string }`
  - `loadOwnerName(userId: string): Promise<string | null>` (exported from `runner.ts`)

- [ ] **Step 1: Write the failing tests**

Append to `scripts/smoke-relationship-apply.ts` (reuse its `USER`, `db`, `check`):

```ts
  // P3: Undo refuses a live run.
  const [live] = await db.insert(relationshipRuns).values({ userId: USER, status: "running" }).returning();
  let refused = false;
  try { await undoRelationshipRun(USER, live.id); } catch (e) { refused = e instanceof RunStillActiveError; }
  check("undo: refuses a running run", refused);
  check("undo: run untouched", (await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, live.id) }))?.status === "running");
  await db.update(relationshipRuns).set({ status: "done" }).where(eq(relationshipRuns.id, live.id));

  // P3: two concurrent creators settle on ONE batch, and the run points at it.
  const [r2] = await db.insert(relationshipRuns).values({ userId: USER, status: "done" }).returning();
  const [b1, b2] = await Promise.all([ensureRunNoteBatch(USER, r2.id), ensureRunNoteBatch(USER, r2.id)]);
  const pointed = (await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, r2.id) }))?.noteBatchId;
  check("note batch: both callers get the run's batch", b1 === pointed && b2 === pointed, `${b1} ${b2} ${pointed}`);
```

Then a flag-dedupe case: apply two plans for one contact through two DIFFERENT windows (not a replay — the second window's last message is later), each plan carrying a flag with `key: "k1"`. Use the file's existing plan/window builders; if it has none, build the `DigestWritePlan` from the first existing case in the file and set `flags: [{ key: "k1", contactId, title: "Send the deck", dueDateIso: "2026-09-25", sourceExcerpt: "I'll send the deck Friday", interactionId }]`. Then:

```ts
  const flagRun = (await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, runId) }))!;
  check("flags: one per key", flagRun.flags.filter((f) => f.key === "k1").length === 1, JSON.stringify(flagRun.flags));
```

Append to `scripts/smoke-relationship-extract.ts` (use the file's existing window fixture for `sampleWindow`):

```ts
const named = buildDigestPrompt({ contactName: "Maya", ownerName: "Jason Pereira", window: sampleWindow, previous: null });
const beforeFence = named.user.split("CONTACT, PREVIOUS UNDERSTANDING")[0];
check("prompt: owner named before the fenced blocks", beforeFence.includes('The user ("Me") is Jason Pereira'), named.user.slice(0, 200));
const unnamed = buildDigestPrompt({ contactName: "Maya", ownerName: null, window: sampleWindow, previous: null });
check("prompt: no owner line without a name", !unnamed.user.includes('The user ("Me") is'));
```

Append to `scripts/smoke-relationship-merge.ts`: before its merge, update the WINNER's digest to `messageCount: 40, sources: ["linkedin"], historyTruncatedBefore: new Date("2024-01-01"), batchPendingUntil: new Date(Date.now() + 3_600_000), batchJobId: crypto.randomUUID()`; after the merge, re-read it as `winnerDigest` and:

```ts
check("merge: winner message count reset", winnerDigest?.messageCount === 0, String(winnerDigest?.messageCount));
check("merge: winner sources reset", Array.isArray(winnerDigest?.sources) && winnerDigest!.sources.length === 0);
check("merge: winner batch markers cleared", winnerDigest?.batchPendingUntil === null && winnerDigest?.batchJobId === null);
check("merge: winner truncation cleared", winnerDigest?.historyTruncatedBefore === null);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx scripts/smoke-relationship-apply.ts; npx tsx scripts/smoke-relationship-extract.ts; npx tsx scripts/smoke-relationship-merge.ts`
Expected: each FAILS on its first new check (or on a missing export).

- [ ] **Step 3: Implement in `apply.ts`**

```ts
export const MAX_RUN_FLAGS = 50;

/** Undo is for a finished run: a live pass would keep writing into a fresh batch after it. */
export class RunStillActiveError extends Error {
  constructor() {
    super("Analysis is still running — undo it once it finishes");
    this.name = "RunStillActiveError";
  }
}
```

In `undoRelationshipRun`, right after `if (!run) throw new Error("Run not found");`:

```ts
  if (run.status === "queued" || run.status === "running" || run.status === "waiting_key") throw new RunStillActiveError();
```

In `ensureRunNoteBatch`, replace the final unconditional `update(...)` + `return batchId` with compare-and-set, adopting the winner on a lost race:

```ts
  const [won] = await db
    .update(relationshipRuns)
    .set({ noteBatchId: batchId })
    .where(and(
      eq(relationshipRuns.id, runId),
      run?.noteBatchId ? eq(relationshipRuns.noteBatchId, run.noteBatchId) : isNull(relationshipRuns.noteBatchId),
    ))
    .returning();
  if (won) return batchId;
  // Another caller replaced the batch first: use theirs, and retire ours if this call created it.
  const winner = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, runId), columns: { noteBatchId: true } });
  if (!existing && winner?.noteBatchId && winner.noteBatchId !== batchId) {
    await db.delete(noteBatches).where(and(eq(noteBatches.id, batchId), eq(noteBatches.userId, userId)));
  }
  return winner?.noteBatchId ?? batchId;
```

(add `isNull` to the `drizzle-orm` import). The `existing` lookup above it is already race-safe when it finds the other caller's batch.

Replace the `flags:` expression in step 5 of `applyDigestPlan` with a key-deduped, capped merge (first occurrence of a key wins, original order kept):

```ts
      flags: plan.flags.length
        ? sql`(
            SELECT coalesce(jsonb_agg(f ORDER BY ord), '[]'::jsonb) FROM (
              SELECT DISTINCT ON (f->>'key') f, ord
                FROM jsonb_array_elements(${relationshipRuns.flags} || ${JSON.stringify(plan.flags)}::jsonb) WITH ORDINALITY AS t(f, ord)
               ORDER BY f->>'key', ord
            ) kept
            WHERE ord <= ${MAX_RUN_FLAGS}
          )`
        : relationshipRuns.flags,
```

- [ ] **Step 4: Owner name**

In `extract.ts`, add `ownerName: string | null` to `buildDigestPrompt`'s input and prepend a line OUTSIDE the fences (it is the account owner's own saved name, not message text):

```ts
  const ownerLine = input.ownerName
    ? `The user ("Me") is ${input.ownerName.replace(/\s+/g, " ").trim().slice(0, 120)}; lines from that name are the user too.`
    : null;
  return {
    system: SYSTEM,
    user: [
      ...(ownerLine ? [ownerLine] : []),
      `CONTACT, PREVIOUS UNDERSTANDING AND OPEN ITEMS:`,
      previousBlock,
      `NEW MESSAGES (oldest first):`,
      fenceUntrusted("MESSAGES", input.window.text),
    ].join("\n\n"),
  };
```

In `runner.ts`, add:

```ts
/** The account owner's name for the prompt: saved first + last name, else the first saved chat self name. */
export async function loadOwnerName(userId: string): Promise<string | null> {
  const db = await getDb();
  const s = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
    columns: { firstName: true, lastName: true, chatSelfNames: true },
  });
  return ownerNameOf(s);
}

function ownerNameOf(s: { firstName: string | null; lastName: string | null; chatSelfNames: string[] | null } | undefined): string | null {
  const full = [s?.firstName, s?.lastName].map((v) => v?.trim()).filter(Boolean).join(" ");
  return full || s?.chatSelfNames?.[0]?.trim() || null;
}
```

In `runRelationshipPass`, extend the existing settings `findFirst` columns with `firstName`, `lastName`, `chatSelfNames` and compute `const ownerName = ownerNameOf(settings)` (no second query). In `applyRelationshipBatch`, call `loadOwnerName(userId)` once per batch. Thread `ownerName` into `promptFor(userId, contactId, window, ownerName)` → `buildDigestPrompt({ ..., ownerName })`. Fix every other caller the compiler reports (`scripts/lib/eval-ai-tasks.ts` passes `ownerName: null`).

- [ ] **Step 5: Merge reset** — in `src/lib/contact-merge.ts:418-430`, replace the UPDATE's SET with:

```sql
        UPDATE relationship_digests
           SET watermark_at = NULL, watermark_interaction_id = NULL, attempts = 0,
               message_count = 0, sources = '[]'::jsonb,
               history_truncated_before = NULL, batch_job_id = NULL, batch_pending_until = NULL
         WHERE user_id = ${userId} AND contact_id = ${winnerId}::uuid
```

and extend its comment: the full re-read recounts messages and sources, and a batch answer for the pre-merge window must not land on the merged contact.

- [ ] **Step 6: Run the tests**

Run: `for s in relationship-apply relationship-extract relationship-merge relationship-runner relationship-rules eval-ai-score ai-batch purge; do npx tsx scripts/smoke-$s.ts >/dev/null 2>&1 && echo "PASS $s" || echo "FAIL $s"; done; npm run typecheck`
Expected: all PASS (`ls scripts | grep -E "merge|purge"` if a name differs; rerun a failure alone to see its output).

- [ ] **Step 7: Commit**

```bash
git add src/lib/relationship-engine/apply.ts src/lib/relationship-engine/extract.ts src/lib/relationship-engine/runner.ts src/lib/contact-merge.ts scripts/lib/eval-ai-tasks.ts scripts/smoke-relationship-apply.ts scripts/smoke-relationship-extract.ts scripts/smoke-relationship-merge.ts
git commit -m "fix(relationships): undo waits for the run, one note batch per run, flags deduped, merge recounts, owner named"
```

---

### Task 3: Run summary read model, promotion writes, and actions

**Files:**
- Create: `src/lib/relationship-engine/summary-copy.ts` (db-free)
- Create: `src/lib/relationship-engine/summary.ts`
- Create: `src/lib/relationship-engine/promote.ts`
- Create: `src/actions/relationships.ts`
- Modify: `src/actions/imports.ts:347-480` (`ImportDetail`, `getImportDetail`)
- Modify: `scripts/smoke-import-history-render.ts` (fixtures gain the new fields)
- Test: `scripts/smoke-relationship-summary.ts` (new, `pglite`)

**Interfaces:**
- Consumes: `ensureRunNoteBatch`, `undoRelationshipRun`, `RunStillActiveError` (Task 2); `pendingRelationshipContactCount` (`pending.ts`); `getInboxListId` (`@/lib/reminder-lists`); `buildSuggestionItemHash`, `isoDay` (`@/lib/suggested-reminder-utils`)
- Produces:

```ts
// summary-copy.ts (no @/db import — client components import from here)
export type RunSummaryReminder = { id: string; title: string; dueIso: string | null; contactId: string | null; contactName: string | null; status: string };
export type RunSummaryFlag = RelationshipRunFlag & { contactName: string };
export type RunSummary = {
  id: string;
  importId: string | null;
  status: RelationshipRunStatus;
  processed: number; skipped: number; failed: number;
  remindersCreated: number; openThreadsAdded: number; factsAdded: number;
  remaining: number;               // pending contacts; 0 unless the run is active
  reminders: RunSummaryReminder[]; // the run batch's reminders, latest due first, max 20
  flags: RunSummaryFlag[];
  truncatedPeople: number;         // digests of this run with history_truncated_before set
  parkedPeople: Array<{ contactId: string; name: string }>; // attempts >= 3 since the run began, max 5
  createdAt: string; finishedAt: string | null;
  undoable: boolean;               // status done|failed and it has a note batch
};
export type RunSummaryCopy = { headline: string; progress: string | null; notes: string[] };
export function runSummaryCopy(s: RunSummary): RunSummaryCopy;

// summary.ts (re-exports everything from summary-copy.ts)
export async function loadRunSummary(userId: string, runId: string, now?: Date): Promise<RunSummary | null>;
export async function loadLatestRunSummary(userId: string, now?: Date): Promise<RunSummary | null>;
export async function loadImportRunSummary(userId: string, importId: string, now?: Date): Promise<RunSummary | null>;

// promote.ts
export async function promoteRunFlag(userId: string, runId: string, key: string, now?: Date): Promise<{ reminderId: string } | null>;
export async function dismissRunFlag(userId: string, runId: string, key: string): Promise<boolean>;
export async function promoteOpenThread(userId: string, contactId: string, key: string, now?: Date): Promise<{ reminderId: string } | null>;
export async function dismissOpenThread(userId: string, contactId: string, key: string): Promise<boolean>;

// src/actions/relationships.ts ("use server")
export async function getLatestRelationshipRun(): Promise<RunSummary | null>;
export async function undoRelationshipRunAction(runId: string): Promise<{ remindersDismissed: number; actionItemsRemoved: number } | { error: string }>;
export async function remindRunFlag(runId: string, key: string): Promise<{ ok: true } | { error: string }>;
export async function dismissRunFlagAction(runId: string, key: string): Promise<{ ok: true } | { error: string }>;
export async function remindOpenThread(contactId: string, key: string): Promise<{ ok: true } | { error: string }>;
export async function dismissOpenThreadAction(contactId: string, key: string): Promise<{ ok: true } | { error: string }>;

// imports.ts
// ImportDetail gains: relationshipRun: RunSummary | null; relationshipRunShared: boolean;
```

- [ ] **Step 1: Write the failing test** — `scripts/smoke-relationship-summary.ts`:

```ts
/**
 * Run summary read model + one-click promotion (pglite).
 * Run: npx tsx scripts/smoke-relationship-summary.ts
 */
import "./smoke/_env";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, noteBatches, relationshipDigests, relationshipRuns, reminders } from "../src/db/schema";
import { loadImportRunSummary, loadLatestRunSummary, loadRunSummary, runSummaryCopy, type RunSummary } from "../src/lib/relationship-engine/summary";
import { dismissOpenThread, dismissRunFlag, promoteOpenThread, promoteRunFlag } from "../src/lib/relationship-engine/promote";
import { ensureRunNoteBatch, undoRelationshipRun } from "../src/lib/relationship-engine/apply";

const USER = "smoke-relationship-summary";
const NOW = new Date("2026-10-03T12:00:00Z");

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(relationshipDigests).where(eq(relationshipDigests.userId, USER));
  await db.delete(relationshipRuns).where(eq(relationshipRuns.userId, USER));
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
}

async function main() {
  const db = await getDb();
  await reset();
  const [maya] = await db.insert(contacts).values({ userId: USER, fullName: "Maya Chen" }).returning();
  const [msg] = await db.insert(interactions).values({
    userId: USER, contactId: maya.id, interactionType: "linkedin_message",
    interactionDate: new Date("2026-09-24T10:00:00Z"), rawNotes: "I'll send the deck Friday",
  }).returning();
  const importId = crypto.randomUUID();
  const [run] = await db.insert(relationshipRuns).values({
    userId: USER, importId, status: "done", processed: 184, skipped: 12, failed: 1,
    remindersCreated: 9, openThreadsAdded: 31, factsAdded: 40, finishedAt: NOW,
    flags: [{ key: "k1", contactId: maya.id, title: "Check Maya sent the deck", dueDateIso: "2026-09-26", sourceExcerpt: "I'll send the deck Friday", interactionId: msg.id }],
  }).returning();
  await ensureRunNoteBatch(USER, run.id);
  await db.insert(relationshipDigests).values({
    contactId: maya.id, userId: USER, runId: run.id, historyTruncatedBefore: new Date("2023-01-01"),
    openThreads: [{ key: "t1", text: "Intro to Priya", owedBy: "me", sinceIso: "2026-05-01", interactionId: msg.id, excerpt: "can you intro me to Priya?" }],
  });

  // Read model
  const s = (await loadRunSummary(USER, run.id, NOW))!;
  check("summary: counters", s.processed === 184 && s.remindersCreated === 9 && s.openThreadsAdded === 31 && s.skipped === 12);
  check("summary: flag carries the name", s.flags.length === 1 && s.flags[0].contactName === "Maya Chen");
  check("summary: truncated people", s.truncatedPeople === 1, String(s.truncatedPeople));
  check("summary: undoable when done", s.undoable === true);
  check("summary: by import", (await loadImportRunSummary(USER, importId, NOW))?.id === run.id);
  check("summary: latest", (await loadLatestRunSummary(USER, NOW))?.id === run.id);
  check("summary: another user sees nothing", (await loadRunSummary("someone-else", run.id, NOW)) === null);

  // Copy (pure)
  const copy = runSummaryCopy(s);
  check("copy: headline", copy.headline === "Analyzed 184 people · 9 reminders · 31 open threads · 12 skipped (too short)", copy.headline);
  check("copy: older history note", copy.notes.includes("Older history not read for 1 person"), JSON.stringify(copy.notes));
  check("copy: failed note", copy.notes.includes("Couldn’t analyze 1 person"), JSON.stringify(copy.notes));
  const running: RunSummary = { ...s, status: "running", processed: 25, remaining: 159, finishedAt: null };
  check("copy: progress while running", runSummaryCopy(running).progress === "Analyzing 25 of 184 — the rest within a few hours", String(runSummaryCopy(running).progress));
  check("copy: key wait", runSummaryCopy({ ...running, status: "waiting_key" }).progress === "Add an AI key to analyze 159 more people");
  check("copy: no progress when done", copy.progress === null);

  // Flag → reminder, in the run's batch, idempotent; the flag leaves the run.
  const promoted = await promoteRunFlag(USER, run.id, "k1", NOW);
  check("flag: reminder made", !!promoted);
  const rem = await db.query.reminders.findFirst({ where: eq(reminders.id, promoted!.reminderId) });
  const batchId = (await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.id, run.id) }))!.noteBatchId;
  check("flag: reminder in the run batch", rem?.noteBatchId === batchId && rem?.contactId === maya.id && rem?.title === "Check Maya sent the deck", JSON.stringify(rem));
  check("flag: due tomorrow", rem?.dueDate?.toISOString().slice(0, 10) === "2026-10-04");
  check("flag: removed from the run", (await loadRunSummary(USER, run.id, NOW))!.flags.length === 0);
  check("flag: second promote is a no-op", (await promoteRunFlag(USER, run.id, "k1", NOW)) === null);
  check("flag: listed among the run's reminders", (await loadRunSummary(USER, run.id, NOW))!.reminders.some((r) => r.id === promoted!.reminderId));

  // Thread → reminder; dismiss removes without a reminder.
  const t = await promoteOpenThread(USER, maya.id, "t1", NOW);
  check("thread: reminder made", !!t);
  const tRem = await db.query.reminders.findFirst({ where: eq(reminders.id, t!.reminderId) });
  check("thread: implied, in the run batch", tRem?.origin === "implied" && tRem?.noteBatchId === batchId, JSON.stringify(tRem));
  const d = await db.query.relationshipDigests.findFirst({ where: eq(relationshipDigests.contactId, maya.id) });
  check("thread: removed from the digest", d?.openThreads.length === 0);
  await db.update(relationshipDigests)
    .set({ openThreads: [{ key: "t2", text: "Coffee in October", owedBy: null, sinceIso: "2026-04-01", interactionId: msg.id, excerpt: "coffee sometime?" }] })
    .where(eq(relationshipDigests.contactId, maya.id));
  check("thread: dismiss", (await dismissOpenThread(USER, maya.id, "t2")) === true);
  check("thread: dismiss unknown key is false", (await dismissOpenThread(USER, maya.id, "nope")) === false);
  check("thread: another user cannot dismiss", (await dismissOpenThread("someone-else", maya.id, "t2")) === false);
  check("flag: dismiss unknown key is false", (await dismissRunFlag(USER, run.id, "nope")) === false);

  // Undo all reaches the promoted reminders.
  await undoRelationshipRun(USER, run.id);
  const pending = await db.query.reminders.findMany({ where: and(eq(reminders.userId, USER), eq(reminders.status, "pending")) });
  check("undo: promoted reminders dismissed", pending.length === 0, String(pending.length));
  check("summary: not undoable once undone", (await loadRunSummary(USER, run.id, NOW))!.undoable === false);

  await reset();
  console.log("relationship summary OK");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

Register `"smoke-relationship-summary": "pglite",` in `MANIFEST` beside the other `smoke-relationship-*` entries.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-relationship-summary.ts`
Expected: FAIL — cannot resolve `../src/lib/relationship-engine/summary`.

- [ ] **Step 3: Implement `summary-copy.ts` and `summary.ts`**

`src/lib/relationship-engine/summary-copy.ts`:

```ts
/**
 * The run summary's shape and copy. No database import: client components render from it.
 */
import type { RelationshipRunFlag, RelationshipRunStatus } from "@/db/schema";

/* RunSummaryReminder, RunSummaryFlag, RunSummary, RunSummaryCopy — exactly as in the Interfaces block */

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function runSummaryCopy(s: RunSummary): RunSummaryCopy {
  const parts = [`Analyzed ${people(s.processed)}`, count(s.remindersCreated, "reminder"), count(s.openThreadsAdded, "open thread")];
  if (s.skipped) parts.push(`${s.skipped} skipped (too short)`);
  const total = s.processed + s.remaining;
  const progress =
    s.status === "waiting_key"
      ? `Add an AI key to analyze ${s.remaining} more ${s.remaining === 1 ? "person" : "people"}`
      : s.status === "queued" || s.status === "running"
        ? `Analyzing ${s.processed} of ${total} — the rest within a few hours`
        : null;
  const notes: string[] = [];
  if (s.failed) notes.push(`Couldn’t analyze ${people(s.failed)}`);
  if (s.truncatedPeople) notes.push(`Older history not read for ${people(s.truncatedPeople)}`);
  if (s.status === "undone") notes.push("Undone — its reminders were removed");
  return { headline: parts.join(" · "), progress, notes };
}
```

(`import type` from `@/db/schema` is erased at compile time, so no db code reaches the client bundle; if the build still pulls it in, copy the two type aliases here instead.)

`src/lib/relationship-engine/summary.ts`:

```ts
/**
 * What one relationship run did, for the import sheet, the /imports card and the bell.
 * User-scoped on every read: the run, its batch's reminders with names, flag names,
 * truncated and parked counts, and the pending count while the run is active.
 */
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, relationshipDigests, relationshipRuns, reminders, type RelationshipRunRow, type RelationshipRunStatus } from "@/db/schema";
import { pendingRelationshipContactCount } from "@/lib/relationship-engine/pending";
import { runSummaryCopy, type RunSummary } from "@/lib/relationship-engine/summary-copy";

// `export *` does not bring names into this module's scope: `runSummaryCopy` is imported above
// for `latestRunNotice` (Task 5); drop it from the import until then if lint flags it unused.
export * from "@/lib/relationship-engine/summary-copy";

const ACTIVE: RelationshipRunStatus[] = ["queued", "running", "waiting_key"];
const PARKED_ATTEMPTS = 3;

async function build(userId: string, run: RelationshipRunRow, now: Date): Promise<RunSummary> {
  const db = await getDb();
  const flagContactIds = [...new Set(run.flags.map((f) => f.contactId))];
  const [reminderRows, flagNames, truncated, parked, remaining] = await Promise.all([
    run.noteBatchId
      ? db
          .select({ id: reminders.id, title: reminders.title, dueDate: reminders.dueDate, contactId: reminders.contactId, contactName: contacts.fullName, status: reminders.status })
          .from(reminders)
          .leftJoin(contacts, eq(contacts.id, reminders.contactId))
          .where(and(eq(reminders.userId, userId), eq(reminders.noteBatchId, run.noteBatchId)))
          .orderBy(desc(reminders.dueDate))
          .limit(20)
      : Promise.resolve([]),
    flagContactIds.length
      ? db.select({ id: contacts.id, name: contacts.fullName }).from(contacts).where(and(eq(contacts.userId, userId), inArray(contacts.id, flagContactIds)))
      : Promise.resolve([]),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(relationshipDigests)
      .where(and(eq(relationshipDigests.userId, userId), eq(relationshipDigests.runId, run.id), isNotNull(relationshipDigests.historyTruncatedBefore))),
    db
      .select({ contactId: relationshipDigests.contactId, name: contacts.fullName })
      .from(relationshipDigests)
      .innerJoin(contacts, eq(contacts.id, relationshipDigests.contactId))
      .where(and(eq(relationshipDigests.userId, userId), gte(relationshipDigests.attempts, PARKED_ATTEMPTS), gte(relationshipDigests.updatedAt, run.createdAt)))
      .limit(5),
    ACTIVE.includes(run.status) ? pendingRelationshipContactCount(userId, now) : Promise.resolve(0),
  ]);
  const nameOf = new Map(flagNames.map((c) => [c.id, c.name]));
  return {
    id: run.id,
    importId: run.importId,
    status: run.status,
    processed: run.processed,
    skipped: run.skipped,
    failed: run.failed,
    remindersCreated: run.remindersCreated,
    openThreadsAdded: run.openThreadsAdded,
    factsAdded: run.factsAdded,
    remaining,
    reminders: reminderRows.map((r) => ({
      id: r.id, title: r.title, contactId: r.contactId, contactName: r.contactName, status: r.status,
      dueIso: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null,
    })),
    flags: run.flags.map((f) => ({ ...f, contactName: nameOf.get(f.contactId) ?? "Someone" })),
    truncatedPeople: Number(truncated[0]?.n ?? 0),
    parkedPeople: parked.map((p) => ({ contactId: p.contactId, name: p.name })),
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    undoable: (run.status === "done" || run.status === "failed") && !!run.noteBatchId,
  };
}

export async function loadRunSummary(userId: string, runId: string, now: Date = new Date()): Promise<RunSummary | null> {
  const db = await getDb();
  const run = await db.query.relationshipRuns.findFirst({ where: and(eq(relationshipRuns.id, runId), eq(relationshipRuns.userId, userId)) });
  return run ? build(userId, run, now) : null;
}

export async function loadLatestRunSummary(userId: string, now: Date = new Date()): Promise<RunSummary | null> {
  const db = await getDb();
  const run = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.userId, userId), orderBy: desc(relationshipRuns.createdAt) });
  return run ? build(userId, run, now) : null;
}

export async function loadImportRunSummary(userId: string, importId: string, now: Date = new Date()): Promise<RunSummary | null> {
  const db = await getDb();
  const run = await db.query.relationshipRuns.findFirst({
    where: and(eq(relationshipRuns.userId, userId), eq(relationshipRuns.importId, importId)),
    orderBy: desc(relationshipRuns.createdAt),
  });
  return run ? build(userId, run, now) : null;
}
```

Adjust only what the compiler requires (e.g. a nullable `updatedAt` or `contactName`), keeping the output shape.

- [ ] **Step 4: Implement `promote.ts`**

```ts
/**
 * One-click writes from the run summary and the profile. Each reminder lands in the run's
 * note batch (so Undo all reaches it) and is keyed by item_hash (a double click or a retry
 * writes nothing new). A flag or thread leaves its list once handled.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, relationshipDigests, relationshipRuns, reminders } from "@/db/schema";
import { ensureRunNoteBatch } from "@/lib/relationship-engine/apply";
import { getInboxListId } from "@/lib/reminder-lists";
import { buildSuggestionItemHash, isoDay } from "@/lib/suggested-reminder-utils";

/** Decision: one-click reminders are due tomorrow, 09:00 UTC. */
function tomorrow(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 9));
}

async function appendReminderToBatch(batchId: string, r: { id: string; contactId: string | null; title: string; dueDate: Date; sourceExcerpt: string | null }) {
  const db = await getDb();
  const entry = { id: r.id, contactId: r.contactId, title: r.title, dueIso: isoDay(r.dueDate), dateBasis: "window", rawDatePhrase: null, sourceExcerpt: r.sourceExcerpt };
  await db.execute(sql`
    UPDATE note_batches
       SET result = jsonb_set(result, '{reminders}', coalesce(result->'reminders', '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb)
     WHERE id = ${batchId}::uuid
  `);
}

async function insertReminder(
  userId: string,
  runId: string,
  input: { contactId: string; title: string; dueDate: Date; excerpt: string | null; interactionId: string | null; hashSeed: string; origin: "explicit" | "implied" }
): Promise<{ reminderId: string } | null> {
  const db = await getDb();
  const batchId = await ensureRunNoteBatch(userId, runId);
  const listId = await getInboxListId(userId);
  // Bare `.returning()` — a partial selector breaks on this repo's neon-http/PGlite split.
  const [row] = await db
    .insert(reminders)
    .values({
      userId,
      contactId: input.contactId,
      listId,
      title: input.title.slice(0, 300),
      description: null,
      dueDate: input.dueDate,
      status: "pending",
      reminderType: "ai_suggested",
      createdBy: "ai",
      noteBatchId: batchId,
      sourceInteractionId: input.interactionId,
      sourceExcerpt: input.excerpt?.slice(0, 500) ?? null,
      dateBasis: "window",
      origin: input.origin,
      itemHash: buildSuggestionItemHash(input.hashSeed, isoDay(input.dueDate), input.title),
    })
    .onConflictDoNothing({ target: [reminders.userId, reminders.itemHash] })
    .returning();
  if (!row) return null;
  await appendReminderToBatch(batchId, { id: row.id, contactId: row.contactId, title: row.title, dueDate: input.dueDate, sourceExcerpt: row.sourceExcerpt });
  return { reminderId: row.id };
}

async function removeFlag(userId: string, runId: string, key: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE relationship_runs
       SET flags = coalesce((SELECT jsonb_agg(f) FROM jsonb_array_elements(flags) f WHERE f->>'key' <> ${key}), '[]'::jsonb)
     WHERE id = ${runId}::uuid AND user_id = ${userId}
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(flags) f WHERE f->>'key' = ${key})
     RETURNING id
  `);
  return rowsOf(result).length > 0;
}

export async function promoteRunFlag(userId: string, runId: string, key: string, now: Date = new Date()) {
  const db = await getDb();
  const run = await db.query.relationshipRuns.findFirst({ where: and(eq(relationshipRuns.id, runId), eq(relationshipRuns.userId, userId)) });
  const flag = run?.flags.find((f) => f.key === key);
  if (!run || !flag || run.status === "undone") return null;
  const owned = await db.query.contacts.findFirst({ where: and(eq(contacts.id, flag.contactId), eq(contacts.userId, userId)), columns: { id: true } });
  if (!owned) return null;
  const made = await insertReminder(userId, runId, {
    contactId: flag.contactId, title: flag.title, dueDate: tomorrow(now), excerpt: flag.sourceExcerpt,
    interactionId: flag.interactionId, hashSeed: `relationship-flag:${flag.key}`, origin: "explicit",
  });
  await removeFlag(userId, runId, key);
  return made;
}

export async function dismissRunFlag(userId: string, runId: string, key: string): Promise<boolean> {
  return removeFlag(userId, runId, key);
}

async function removeThread(userId: string, contactId: string, key: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE relationship_digests
       SET open_threads = coalesce((SELECT jsonb_agg(t) FROM jsonb_array_elements(open_threads) t WHERE t->>'key' <> ${key}), '[]'::jsonb)
     WHERE contact_id = ${contactId}::uuid AND user_id = ${userId}
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(open_threads) t WHERE t->>'key' = ${key})
     RETURNING contact_id
  `);
  return rowsOf(result).length > 0;
}

export async function promoteOpenThread(userId: string, contactId: string, key: string, now: Date = new Date()) {
  const db = await getDb();
  const digest = await db.query.relationshipDigests.findFirst({ where: and(eq(relationshipDigests.contactId, contactId), eq(relationshipDigests.userId, userId)) });
  const thread = digest?.openThreads.find((t) => t.key === key);
  // A digest with no run (written before runs existed) has no batch to undo through: the
  // profile hides Remind me for it (`canRemind`).
  if (!digest || !thread || !digest.runId) return null;
  const made = await insertReminder(userId, digest.runId, {
    contactId, title: thread.text, dueDate: tomorrow(now), excerpt: thread.excerpt,
    interactionId: thread.interactionId, hashSeed: `relationship-thread:${contactId}:${key}`, origin: "implied",
  });
  await removeThread(userId, contactId, key);
  return made;
}

export async function dismissOpenThread(userId: string, contactId: string, key: string): Promise<boolean> {
  return removeThread(userId, contactId, key);
}
```

If `digest.runId` points at an UNDONE run, `ensureRunNoteBatch` recreates a live batch for it (existing behavior), so the new reminder is still undoable through that run. Match `reminders` column names to `src/db/schema.ts` (`reminderType` values, `dateBasis` type) if the compiler objects.

- [ ] **Step 5: Implement `src/actions/relationships.ts`**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { RunStillActiveError, undoRelationshipRun } from "@/lib/relationship-engine/apply";
import { dismissOpenThread, dismissRunFlag, promoteOpenThread, promoteRunFlag } from "@/lib/relationship-engine/promote";
import { loadLatestRunSummary, type RunSummary } from "@/lib/relationship-engine/summary";
import { revalidateReminderPaths } from "@/lib/reminder-paths";

type Refusal = { error: string };

/** Typed, so `"error" in res` narrows on the client — see `refusal` in actions/imports.ts. */
function refusal(message: string): Refusal {
  return { error: message };
}

export async function getLatestRelationshipRun(): Promise<RunSummary | null> {
  const userId = await requireUserId();
  return loadLatestRunSummary(userId);
}

export async function undoRelationshipRunAction(runId: string): Promise<{ remindersDismissed: number; actionItemsRemoved: number } | Refusal> {
  const userId = await requireUserId();
  try {
    const out = await undoRelationshipRun(userId, runId);
    revalidateReminderPaths();
    revalidatePath("/imports");
    return out;
  } catch (err) {
    if (err instanceof RunStillActiveError) return refusal(err.message);
    if (err instanceof Error && err.message === "Run not found") return refusal("That analysis is gone — refresh and try again");
    throw err;
  }
}

export async function remindRunFlag(runId: string, key: string): Promise<{ ok: true } | Refusal> {
  const userId = await requireUserId();
  const made = await promoteRunFlag(userId, runId, key);
  revalidateReminderPaths();
  return made ? { ok: true } : refusal("That reminder was already made");
}

export async function dismissRunFlagAction(runId: string, key: string): Promise<{ ok: true } | Refusal> {
  const userId = await requireUserId();
  await dismissRunFlag(userId, runId, key);
  return { ok: true };
}

export async function remindOpenThread(contactId: string, key: string): Promise<{ ok: true } | Refusal> {
  const userId = await requireUserId();
  const made = await promoteOpenThread(userId, contactId, key);
  revalidateReminderPaths();
  revalidatePath(`/contacts/${contactId}`);
  return made ? { ok: true } : refusal("That thread already has a reminder");
}

export async function dismissOpenThreadAction(contactId: string, key: string): Promise<{ ok: true } | Refusal> {
  const userId = await requireUserId();
  await dismissOpenThread(userId, contactId, key);
  revalidatePath(`/contacts/${contactId}`);
  return { ok: true };
}
```

Before writing, confirm the real names/paths: `grep -rn "export async function requireUserId" src/lib` and `grep -n "export function revalidateReminderPaths" src/lib/reminder-paths.ts`. Use whatever the other `src/actions/*.ts` files use for the session user id.

- [ ] **Step 6: Import detail** — in `src/actions/imports.ts`, extend `ImportDetail` with `relationshipRun: RunSummary | null; relationshipRunShared: boolean;`. In `getImportDetail`, for message imports only (the LinkedIn messages, WhatsApp chat and iMessage chat import types — use their existing constants), load:

```ts
  const ownRun = await loadImportRunSummary(userId, importId);
  const relationshipRun = ownRun ?? (isMessageImport ? await loadLatestRunSummary(userId) : null);
  const relationshipRunShared = !ownRun && !!relationshipRun && new Date(relationshipRun.createdAt) <= new Date(item.createdAt);
  // A latest run that started AFTER this import is unrelated to it: show nothing.
  const shownRun = ownRun ?? (relationshipRunShared ? relationshipRun : null);
```

and return `relationshipRun: shownRun, relationshipRunShared`. Other import types return `relationshipRun: null, relationshipRunShared: false` without querying. Update every `ImportDetail` fixture in `scripts/smoke-import-history-render.ts` with the two new fields (`null`, `false`).

- [ ] **Step 7: Run the tests**

Run: `npx tsx scripts/smoke-relationship-summary.ts && npx tsx scripts/smoke-import-history-render.ts && npx tsx scripts/run-smoke.ts --check && npm run typecheck`
Then the action user-scope smoke (`ls scripts | grep -i scope`, run it).
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/relationship-engine/summary-copy.ts src/lib/relationship-engine/summary.ts src/lib/relationship-engine/promote.ts src/actions/relationships.ts src/actions/imports.ts scripts/smoke-relationship-summary.ts scripts/smoke-import-history-render.ts scripts/run-smoke.ts
git commit -m "feat(relationships): run summary read model, one-click flag and thread reminders, undo action"
```

---

### Task 4: Run summary UI — import sheet and the /imports analysis card

**Files:**
- Create: `src/components/imports/relationship-run-summary.tsx`
- Modify: `src/components/imports/import-history.tsx:330-490` (`ImportDetailBody`)
- Modify: `src/components/imports/import-hub.tsx` (render the card above the history)
- Test: `scripts/smoke-relationship-ui.ts` (new, `pure`), `scripts/smoke-import-history-render.ts` (extend)

**Interfaces:**
- Consumes: `RunSummary`, `runSummaryCopy` from `summary-copy.ts` (Task 3); actions `undoRelationshipRunAction`, `remindRunFlag`, `dismissRunFlagAction`, `getLatestRelationshipRun` (Task 3)
- Produces:
  - `RunSummaryView(props: { summary: RunSummary; busyKey: string | null; onUndo?: () => void; onRemind?: (key: string) => void; onDismiss?: (key: string) => void; shared?: boolean })` — pure
  - `RelationshipRunCard(props: { initial: RunSummary | null; shared?: boolean; compact?: boolean })` — container; refreshes via `getLatestRelationshipRun` every 20 s while the run is active
  - element id `relationship-analysis` on the non-compact card (the bell links to `/imports#relationship-analysis`)

- [ ] **Step 1: Write the failing render test** — `scripts/smoke-relationship-ui.ts`:

```ts
/**
 * Relationship UI rendered to static markup (pure): run summary, digest, open threads, badges, icons.
 * Run: npx tsx scripts/smoke-relationship-ui.ts
 */
import "./smoke/_env";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSummaryView } from "../src/components/imports/relationship-run-summary";
import type { RunSummary } from "../src/lib/relationship-engine/summary-copy";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const base: RunSummary = {
  id: "r1", importId: "i1", status: "done", processed: 184, skipped: 12, failed: 0,
  remindersCreated: 9, openThreadsAdded: 31, factsAdded: 40, remaining: 0,
  reminders: [{ id: "m1", title: "Send Maya the deck", dueIso: "2026-10-09", contactId: "c1", contactName: "Maya Chen", status: "pending" }],
  flags: [{ key: "k1", contactId: "c1", contactName: "Maya Chen", title: "Check Maya sent the deck", dueDateIso: "2026-09-26", sourceExcerpt: "I'll send the deck Friday", interactionId: "x1" }],
  truncatedPeople: 2, parkedPeople: [], createdAt: "2026-10-03T10:00:00.000Z", finishedAt: "2026-10-03T10:20:00.000Z", undoable: true,
};

const done = textOf(renderToStaticMarkup(React.createElement(RunSummaryView, { summary: base, busyKey: null, onUndo: () => {}, onRemind: () => {}, onDismiss: () => {} })));
check("run: headline", done.includes("Analyzed 184 people · 9 reminders · 31 open threads · 12 skipped (too short)"), done);
check("run: reminder listed with its person", done.includes("Send Maya the deck") && done.includes("Maya Chen"));
check("run: undo all offered", done.includes("Undo all"));
check("run: flag with its quote and a one-click remind", done.includes("Check Maya sent the deck") && done.includes("I'll send the deck Friday") && done.includes("Remind me"), done);
check("run: older history note", done.includes("Older history not read for 2 people"));

const running = textOf(renderToStaticMarkup(React.createElement(RunSummaryView, { summary: { ...base, status: "running", processed: 25, remaining: 159, undoable: false }, busyKey: null, onUndo: () => {} })));
check("run: progress while running", running.includes("Analyzing 25 of 184 — the rest within a few hours"));
check("run: no undo while running", !running.includes("Undo all"));

const shared = textOf(renderToStaticMarkup(React.createElement(RunSummaryView, { summary: base, busyKey: null, shared: true })));
check("run: shared run says so", shared.includes("Analyzed together with an earlier upload"));

console.log("\nsmoke-relationship-ui: all checks passed");
process.exit(0);
```

Register `"smoke-relationship-ui": "pure",`. (Later tasks append checks above the final `console.log`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-relationship-ui.ts`
Expected: FAIL — cannot resolve `relationship-run-summary`.

- [ ] **Step 3: Implement `relationship-run-summary.tsx`**

```tsx
"use client";

import { useEffect, useState, useTransition } from "react";
import { format } from "date-fns";
import { BellPlus, Sparkles, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dismissRunFlagAction, getLatestRelationshipRun, remindRunFlag, undoRelationshipRunAction } from "@/actions/relationships";
import { runSummaryCopy, type RunSummary } from "@/lib/relationship-engine/summary-copy";
import { friendlyError } from "@/lib/friendly-error";
import { TOAST_COPY } from "@/lib/toast-copy";
import { toast } from "@/lib/toast";

const ACTIVE = new Set<RunSummary["status"]>(["queued", "running", "waiting_key"]);

export function RunSummaryView({ summary, busyKey, onUndo, onRemind, onDismiss, shared }: {
  summary: RunSummary;
  busyKey: string | null;
  onUndo?: () => void;
  onRemind?: (key: string) => void;
  onDismiss?: (key: string) => void;
  shared?: boolean;
}) {
  const copy = runSummaryCopy(summary);
  return (
    <section className="space-y-3" aria-label="Relationship analysis">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{copy.headline}</p>
          {copy.progress ? <p className="text-xs text-muted-foreground">{copy.progress}</p> : null}
          {shared ? <p className="text-xs text-muted-foreground">Analyzed together with an earlier upload</p> : null}
        </div>
        {summary.undoable && onUndo ? (
          <Button size="sm" variant="ghost" onClick={onUndo} disabled={busyKey === "undo"}>
            <Undo2 className="size-3.5" aria-hidden /> Undo all
          </Button>
        ) : null}
      </div>
      {summary.reminders.length ? (
        <ul className="space-y-1 text-sm">
          {summary.reminders.map((r) => (
            <li key={r.id} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">
                {r.title}
                {r.contactName ? <span className="text-muted-foreground"> · {r.contactName}</span> : null}
              </span>
              {r.dueIso ? <span className="shrink-0 text-xs text-muted-foreground">{format(new Date(`${r.dueIso}T12:00:00`), "MMM d")}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {summary.flags.length ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Dates that just passed</p>
          {summary.flags.map((f) => (
            <div key={f.key} className="rounded-md border p-2 text-sm">
              <p>
                {f.title} <span className="text-muted-foreground">· {f.contactName}</span>
              </p>
              <p className="text-xs italic text-muted-foreground">“{f.sourceExcerpt}”</p>
              {onRemind && onDismiss ? (
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busyKey === f.key} onClick={() => onRemind(f.key)}>
                    <BellPlus className="size-3.5" aria-hidden /> Remind me
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busyKey === f.key} onClick={() => onDismiss(f.key)}>
                    <X className="size-3.5" aria-hidden /> Dismiss
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {copy.notes.length || summary.parkedPeople.length ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {copy.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          {summary.parkedPeople.length ? <li>Couldn’t read: {summary.parkedPeople.map((p) => p.name).join(", ")}</li> : null}
        </ul>
      ) : null}
    </section>
  );
}

export function RelationshipRunCard({ initial, shared, compact }: { initial: RunSummary | null; shared?: boolean; compact?: boolean }) {
  const [summary, setSummary] = useState(initial);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [, start] = useTransition();

  useEffect(() => setSummary(initial), [initial]);
  useEffect(() => {
    if (!summary || !ACTIVE.has(summary.status)) return;
    const id = summary.id;
    const t = setInterval(() => {
      getLatestRelationshipRun()
        .then((s) => { if (s && s.id === id) setSummary(s); })
        .catch(() => {});
    }, 20_000);
    return () => clearInterval(t);
  }, [summary]);

  if (!summary) return null;

  const act = (key: string, run: () => Promise<{ error: string } | object>, ok: string) =>
    start(async () => {
      setBusyKey(key);
      try {
        const res = await run();
        if ("error" in res) {
          toast.error((res as { error: string }).error);
          return;
        }
        toast.success(ok);
        const next = await getLatestRelationshipRun();
        if (next && next.id === summary.id) setSummary(next);
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      } finally {
        setBusyKey(null);
      }
    });

  return (
    <div id={compact ? undefined : "relationship-analysis"} className={compact ? undefined : "rounded-xl border bg-card p-4"}>
      <RunSummaryView
        summary={summary}
        busyKey={busyKey}
        shared={shared}
        onUndo={() => act("undo", () => undoRelationshipRunAction(summary.id), "Analysis undone")}
        onRemind={(key) => act(key, () => remindRunFlag(summary.id, key), "Reminder added")}
        onDismiss={(key) => act(key, () => dismissRunFlagAction(summary.id, key), "Dismissed")}
      />
    </div>
  );
}
```

Before writing, open `src/components/imports/import-history.tsx` and copy ITS import lines for `Button`, `toast`, `friendlyError` and `TOAST_COPY` (paths and names may differ from the above), and use the same text/border color classes it uses for muted text and cards. Note `getLatestRelationshipRun` returns the user's latest run; when a NEWER run started after this card's run, polling stops updating it (by design — the card describes one run).

- [ ] **Step 4: Wire it in**
  - `import-history.tsx` `ImportDetailBody`: after the Undo block, when `detail.relationshipRun` is set, render a small "Relationship analysis" heading (match the sheet's other section headings) and `<RelationshipRunCard initial={detail.relationshipRun} shared={detail.relationshipRunShared} compact />`.
  - `import-hub.tsx`: on mount, `getLatestRelationshipRun().then(setLatest).catch(() => {})`; render `<RelationshipRunCard initial={latest} />` above the history list when `latest` is non-null and either active or finished/created within 7 days (`Date.now() - Date.parse(latest.finishedAt ?? latest.createdAt) < 7 * 86_400_000`) and not `undone`. After it renders, if `window.location.hash === "#relationship-analysis"`, call `document.getElementById("relationship-analysis")?.scrollIntoView({ block: "start" })`.
  - `scripts/smoke-import-history-render.ts`: add one `ImportDetailBody` render with `relationshipRun: <a done RunSummary literal like `base` in smoke-relationship-ui>` and assert the text includes "Relationship analysis" and "Undo all".

- [ ] **Step 5: Run the tests**

Run: `npx tsx scripts/smoke-relationship-ui.ts && npx tsx scripts/smoke-import-history-render.ts && npx tsx scripts/smoke-toast-copy.ts && npm run typecheck && npx eslint src/components/imports`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/imports/relationship-run-summary.tsx src/components/imports/import-history.tsx src/components/imports/import-hub.tsx scripts/smoke-relationship-ui.ts scripts/smoke-import-history-render.ts scripts/run-smoke.ts
git commit -m "feat(relationships): run summary with Undo all and one-click flags on /imports"
```

---

### Task 5: Bell row when a run finishes

**Files:**
- Modify: `src/lib/relationship-engine/summary.ts` (add `latestRunNotice`)
- Modify: `src/lib/notification-panel.ts:34-275`
- Modify: `src/components/notifications/notifications-panel.tsx` (render the row)
- Modify: the call site that loads the OPEN panel with `radar: true` (`grep -rn "radar: true" src`) — add `relationship: true` there only
- Test: `scripts/smoke-relationship-summary.ts` (extend), `scripts/smoke-page-budgets.ts:358-375` (extend)

**Interfaces:**
- Produces:
  - `latestRunNotice(userId: string, now?: Date): Promise<{ runId: string; headline: string; status: RelationshipRunStatus } | undefined>` in `summary.ts` — ONE statement (the latest run row); present while the run is active, or for 3 days after it finished; never for `undone`
  - `loadNotificationPanel(userId, now, opts: { withAlerts: boolean; radar?: boolean; relationship?: boolean } & …)` returns a sibling field `relationship?: { runId; headline; status }`

- [ ] **Step 1: Write the failing tests**
  - In `scripts/smoke-relationship-summary.ts`, before the undo block:
    ```ts
    const notice = await latestRunNotice(USER, NOW);
    check("notice: finished run shows", notice?.runId === run.id && notice.headline.startsWith("Analyzed 184 people"), JSON.stringify(notice));
    check("notice: gone after 3 days", (await latestRunNotice(USER, new Date(NOW.getTime() + 4 * 86_400_000))) === undefined);
    ```
    and after the undo:
    ```ts
    check("notice: undone run hidden", (await latestRunNotice(USER, NOW)) === undefined);
    ```
    (add `latestRunNotice` to the summary import).
  - In `scripts/smoke-page-budgets.ts`, after the existing panel check, add:
    ```ts
    startQueryCount();
    await loadNotificationPanel(USER, new Date(), { withAlerts: false, radar: true, relationship: true });
    const withRun = stopQueryCount();
    check("panel with the analysis row issues ≤ 10 statements", withRun <= 10, `got ${withRun}`);
    ```
    leaving the existing `≤ 9` assertion on the default call unchanged.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-relationship-summary.ts`
Expected: FAIL — `latestRunNotice` is not exported.

- [ ] **Step 3: Implement**
  - `summary.ts`:
    ```ts
    const NOTICE_DAYS = 3;

    /** The bell's one-line summary of the latest run. One statement: counters come off the row. */
    export async function latestRunNotice(userId: string, now: Date = new Date()) {
      const db = await getDb();
      const run = await db.query.relationshipRuns.findFirst({ where: eq(relationshipRuns.userId, userId), orderBy: desc(relationshipRuns.createdAt) });
      if (!run || run.status === "undone") return undefined;
      const active = ACTIVE.includes(run.status);
      if (!active && (!run.finishedAt || now.getTime() - run.finishedAt.getTime() > NOTICE_DAYS * 86_400_000)) return undefined;
      const { headline } = runSummaryCopy({
        id: run.id, importId: run.importId, status: run.status,
        processed: run.processed, skipped: run.skipped, failed: run.failed,
        remindersCreated: run.remindersCreated, openThreadsAdded: run.openThreadsAdded, factsAdded: run.factsAdded,
        remaining: 0, reminders: [], flags: [], truncatedPeople: 0, parkedPeople: [],
        createdAt: run.createdAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null, undoable: false,
      });
      return { runId: run.id, headline, status: run.status };
    }
    ```
  - `notification-panel.ts`: add `relationship?: boolean` to `opts`; add `opts.relationship ? latestRunNotice(userId, now) : Promise.resolve(undefined)` to the `Promise.all` (destructure it as `relationshipNotice`); return `relationship: relationshipNotice` beside `radar`, with a doc comment: a sibling of `items` like Radar, so a finished analysis never becomes a due item, an OS notification or a badge count; opt-in so the desktop poll never pays the statement.
  - The open-panel call site: pass `relationship: true` exactly where `radar: true` is passed.
  - `notifications-panel.tsx`: when `panel.relationship` is set, render one row in the same place and markup style as the Radar row — a `Sparkles` icon, the text (`headline` when finished, `"Analyzing your conversations"` while `queued|running`, `"Add an AI key to finish analyzing your conversations"` for `waiting_key`), linking to `/imports#relationship-analysis`.

- [ ] **Step 4: Run the tests**

Run: `npx tsx scripts/smoke-relationship-summary.ts && npx tsx scripts/smoke-page-budgets.ts && npm run typecheck && npx eslint src/components/notifications src/lib/notification-panel.ts`
Expected: PASS (`smoke-page-budgets` may be a `manual` tier — run it directly regardless).

- [ ] **Step 5: Commit**

```bash
git add src/lib/relationship-engine/summary.ts src/lib/notification-panel.ts src/components/notifications/notifications-panel.tsx scripts/smoke-relationship-summary.ts scripts/smoke-page-budgets.ts
git add -u src
git commit -m "feat(relationships): a bell row when a relationship analysis finishes"
```

---

### Task 6: Settings → AI "Relationship analysis" switch

**Files:**
- Modify: `src/actions/settings.ts:46-110` (`getSettings`), add `saveRelationshipEngineEnabled` beside `saveWorkHistoryAutoEnabled` (`:187-198`)
- Modify: `src/components/settings/ai-settings.tsx:203-245` (a second switch below "Keep work history current")
- Test: `scripts/smoke-relationship-settings.ts` (new, `pglite`)

**Interfaces:**
- Consumes: `resumeKeyPausedRun`, `kickRelationshipRun` (Task 1)
- Produces: `getSettings()` gains `relationshipEngineEnabled: boolean`; `saveRelationshipEngineEnabled(enabled: boolean): Promise<void>` in `src/actions/settings.ts`. Turning it on resumes a key-paused run and kicks the runner after the response.

- [ ] **Step 1: Write the failing test** — `scripts/smoke-relationship-settings.ts`, following `scripts/smoke-clear-api-key.ts`'s demo-mode setup exactly (copy its env lines and its `run(...)` usage; user `"demo-user"`):

```ts
import "./smoke/_env";
import { run } from "./smoke/_env";
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";
process.env.ORBIT_DEMO_DATA = "off";
process.env.VERCEL = "1";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { getSettings, saveRelationshipEngineEnabled } from "../src/actions/settings";

const USER = "demo-user";
function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();
  await db.update(userSettings).set({ relationshipEngineEnabled: 1 }).where(eq(userSettings.userId, USER));
  check("default on", (await getSettings()).relationshipEngineEnabled === true);
  await saveRelationshipEngineEnabled(false);
  const off = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("saved off", off?.relationshipEngineEnabled === 0);
  check("read off", (await getSettings()).relationshipEngineEnabled === false);
  await saveRelationshipEngineEnabled(true);
  check("read on (and turning on does not throw outside a request)", (await getSettings()).relationshipEngineEnabled === true);
});
```

Register `"smoke-relationship-settings": "pglite",`. Exit handling as in `smoke-clear-api-key.ts`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-relationship-settings.ts`
Expected: FAIL — `saveRelationshipEngineEnabled` is not exported.

- [ ] **Step 3: Implement**
  - `getSettings()`: add `relationshipEngineEnabled: (settings?.relationshipEngineEnabled ?? 1) !== 0,` beside `workHistoryAutoEnabled` (and to its declared return type if it has one).
  - `saveRelationshipEngineEnabled(enabled: boolean)`: mirror `saveWorkHistoryAutoEnabled` (upsert `relationshipEngineEnabled: enabled ? 1 : 0`, `updatedAt`). Then, when `enabled`:
    ```ts
    if (enabled) {
      const kick = async () => { await resumeKeyPausedRun(userId); await kickRelationshipRun(userId); };
      try {
        after(kick);
      } catch {
        // Outside a request (scripts) there is nothing to kick; the hourly backstop picks it up.
      }
    }
    ```
    Use the same `revalidate…` call `saveWorkHistoryAutoEnabled` uses, if any.
  - `ai-settings.tsx`: a second switch using the SAME markup and state pattern as "Keep work history current": label **Relationship analysis**; description **Reads your imported messages to keep each person’s summary, open threads and follow-up reminders current. Uses your AI key.**; optimistic toggle, rollback and `toast.error(friendlyError(err, TOAST_COPY.saveFailed))` on failure. Read the initial value from `initialSettings.relationshipEngineEnabled`.

- [ ] **Step 4: Run the tests**

Run: `npx tsx scripts/smoke-relationship-settings.ts && npx tsx scripts/smoke-clear-api-key.ts && npm run typecheck && npx eslint src/components/settings src/actions/settings.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/actions/settings.ts src/components/settings/ai-settings.tsx scripts/smoke-relationship-settings.ts scripts/run-smoke.ts
git commit -m "feat(settings): Relationship analysis switch in Settings → AI"
```

---

### Task 7: Profile — digest on the brief card

**Files:**
- Create: `src/lib/relationship-engine/digest-copy.ts` (db-free)
- Create: `src/lib/relationship-engine/digest-view.ts`
- Create: `src/components/contacts/contact-digest.tsx`
- Modify: `src/components/contacts/contact-brief-card.tsx` (optional `digest` prop)
- Modify: `src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx:92-110` (start the read with the other eager promises), `:241` (await), `:345-355` (pass it)
- Test: `scripts/smoke-relationship-ui.ts`, `scripts/smoke-relationship-summary.ts` (extend both)

**Interfaces:**
- Produces:

```ts
// digest-copy.ts (no @/db import)
export type DigestThread = RelationshipOpenThread & { canRemind: boolean }; // canRemind = the digest has a run
export type DigestView = {
  whatTheyDo: string | null;
  workingOn: string | null;
  summary: string | null;
  topics: RelationshipTopic[];   // max 8, most recently discussed first
  openThreads: DigestThread[];
  messageCount: number;
  sources: string[];
  updatedAt: string | null;
  historyTruncatedBefore: string | null;
};
export function digestSourceLine(d: Pick<DigestView, "messageCount" | "sources" | "updatedAt">): string | null;
export function topicLine(t: RelationshipTopic): string; // "Hiring · last discussed Sep 30"

// digest-view.ts (re-exports digest-copy)
export async function loadDigestView(userId: string, contactId: string): Promise<DigestView | null>; // null when no summary, no whatTheyDo and no threads

// contact-digest.tsx
export function DigestSection(props: { digest: DigestView }): React.JSX.Element; // pure
```

- [ ] **Step 1: Write the failing tests** — add to `scripts/smoke-relationship-ui.ts` (imports at the top, checks before the final log):

```ts
import { DigestSection } from "../src/components/contacts/contact-digest";
import { digestSourceLine, topicLine, type DigestView } from "../src/lib/relationship-engine/digest-copy";

const digest: DigestView = {
  whatTheyDo: "Runs growth at Ramp, hiring PMs", workingOn: "A self-serve onboarding revamp",
  summary: "You met at a fintech dinner and have traded hiring notes since.",
  topics: [{ label: "Hiring", lastDiscussedAt: "2026-09-30" }, { label: "Onboarding", lastDiscussedAt: "2026-08-12" }],
  openThreads: [], messageCount: 214, sources: ["whatsapp"], updatedAt: "2026-09-30T15:00:00.000Z", historyTruncatedBefore: null,
};
check("digest: source line, one source", digestSourceLine(digest) === "From 214 WhatsApp messages · updated Sep 30", String(digestSourceLine(digest)));
check("digest: source line, two sources", digestSourceLine({ ...digest, sources: ["linkedin", "imessage"] }) === "From 214 messages on LinkedIn and iMessage · updated Sep 30", String(digestSourceLine({ ...digest, sources: ["linkedin", "imessage"] })));
check("digest: source line, one message", digestSourceLine({ ...digest, messageCount: 1, sources: ["linkedin"] }) === "From 1 LinkedIn message · updated Sep 30");
check("digest: no source line without messages", digestSourceLine({ ...digest, messageCount: 0 }) === null);
check("digest: topic line", topicLine(digest.topics[0]) === "Hiring · last discussed Sep 30", topicLine(digest.topics[0]));
const dg = textOf(renderToStaticMarkup(React.createElement(DigestSection, { digest })));
check("digest: what they do", dg.includes("Runs growth at Ramp, hiring PMs"));
check("digest: working on", dg.includes("A self-serve onboarding revamp"));
check("digest: summary", dg.includes("You met at a fintech dinner"));
check("digest: topic chips", dg.includes("Hiring") && dg.includes("Onboarding"));
check("digest: source line rendered", dg.includes("From 214 WhatsApp messages"));
```

Add to `scripts/smoke-relationship-summary.ts`, right after the digest insert:

```ts
  const view = await loadDigestView(USER, maya.id);
  check("digest view: threads carry canRemind", view?.openThreads[0]?.canRemind === true, JSON.stringify(view?.openThreads));
  check("digest view: other user sees nothing", (await loadDigestView("someone-else", maya.id)) === null);
```

(import `loadDigestView` from `../src/lib/relationship-engine/digest-view`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-relationship-ui.ts`
Expected: FAIL — cannot resolve `contact-digest`.

- [ ] **Step 3: Implement `digest-copy.ts` and `digest-view.ts`**

`digest-copy.ts`:

```ts
/**
 * The profile digest's shape and copy. No database import: client components render from it.
 */
import { format } from "date-fns";
import type { RelationshipOpenThread, RelationshipTopic } from "@/db/schema";

/* DigestThread, DigestView — exactly as in the Interfaces block */

const SOURCE_LABEL: Record<string, string> = { linkedin: "LinkedIn", whatsapp: "WhatsApp", imessage: "iMessage" };

const day = (iso: string) => format(new Date(iso.length === 10 ? `${iso}T12:00:00` : iso), "MMM d");

export function digestSourceLine(d: Pick<DigestView, "messageCount" | "sources" | "updatedAt">): string | null {
  if (!d.messageCount) return null;
  const labels = d.sources.map((s) => SOURCE_LABEL[s] ?? s);
  const noun = d.messageCount === 1 ? "message" : "messages";
  const from =
    labels.length === 1
      ? `From ${d.messageCount} ${labels[0]} ${noun}`
      : labels.length > 1
        ? `From ${d.messageCount} ${noun} on ${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
        : `From ${d.messageCount} ${noun}`;
  return d.updatedAt ? `${from} · updated ${day(d.updatedAt)}` : from;
}

export function topicLine(t: RelationshipTopic): string {
  return `${t.label} · last discussed ${day(t.lastDiscussedAt)}`;
}
```

`digest-view.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { relationshipDigests } from "@/db/schema";
import type { DigestView } from "@/lib/relationship-engine/digest-copy";

export * from "@/lib/relationship-engine/digest-copy";

export async function loadDigestView(userId: string, contactId: string): Promise<DigestView | null> {
  const db = await getDb();
  const d = await db.query.relationshipDigests.findFirst({
    where: and(eq(relationshipDigests.contactId, contactId), eq(relationshipDigests.userId, userId)),
  });
  if (!d || (!d.summary && !d.whatTheyDo && d.openThreads.length === 0)) return null;
  return {
    whatTheyDo: d.whatTheyDo,
    workingOn: d.workingOn,
    summary: d.summary,
    topics: [...d.topics].sort((a, b) => b.lastDiscussedAt.localeCompare(a.lastDiscussedAt)).slice(0, 8),
    openThreads: d.openThreads.map((t) => ({ ...t, canRemind: d.runId != null })),
    messageCount: d.messageCount,
    sources: d.sources ?? [],
    updatedAt: d.updatedAt?.toISOString() ?? null,
    historyTruncatedBefore: d.historyTruncatedBefore?.toISOString() ?? null,
  };
}
```

(adjust null-handling to the column types the compiler reports).

- [ ] **Step 4: Implement `contact-digest.tsx`** (pure markup; no `"use client"` needed)

```tsx
import { digestSourceLine, topicLine, type DigestView } from "@/lib/relationship-engine/digest-copy";

export function DigestSection({ digest }: { digest: DigestView }) {
  const source = digestSourceLine(digest);
  return (
    <div className="space-y-2">
      {digest.whatTheyDo ? <p className="text-sm font-medium">{digest.whatTheyDo}</p> : null}
      {digest.workingOn ? <p className="text-sm text-muted-foreground">Working on: {digest.workingOn}</p> : null}
      {digest.summary ? <p className="text-sm leading-relaxed">{digest.summary}</p> : null}
      {digest.topics.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="What you talk about">
          {digest.topics.map((t) => (
            <li key={t.label} title={topicLine(t)} aria-label={topicLine(t)} className="rounded-full border px-2 py-0.5 text-xs">
              {t.label}
            </li>
          ))}
        </ul>
      ) : null}
      {source ? <p className="text-xs text-muted-foreground">{source}</p> : null}
    </div>
  );
}
```

Use the muted-text and border classes the brief card already uses.

- [ ] **Step 5: Wire the brief card and the page**
  - `contact-brief-card.tsx`: add `digest?: DigestView | null` (type imported from `digest-copy`) to props; when present, render `<DigestSection digest={digest} />` at the top of the left column, above the standing paragraph. If the card returns early when `standing` is null, keep rendering when a digest exists.
  - `page.tsx`: in the eager-promise block next to `nextStepsPromise`, add `const digestPromise = loadDigestView(userId, id).catch(() => null);` (match the neighbours' `.catch` style and the variable names the page uses for the user id and contact id); await it alongside `nextSteps`, and pass `digest={digest}` to `ContactBriefCard`.

- [ ] **Step 6: Run the tests**

Run: `npx tsx scripts/smoke-relationship-ui.ts && npx tsx scripts/smoke-relationship-summary.ts && npx tsx scripts/smoke-contact-profile-reads.ts && npm run typecheck && npx eslint src/components/contacts src/lib/relationship-engine`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/relationship-engine/digest-copy.ts src/lib/relationship-engine/digest-view.ts src/components/contacts/contact-digest.tsx src/components/contacts/contact-brief-card.tsx "src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx" scripts/smoke-relationship-ui.ts scripts/smoke-relationship-summary.ts
git commit -m "feat(contacts): what they do, summary, topics and source line from the relationship digest"
```

---

### Task 8: Profile — You owe / They owe badges and open threads

**Files:**
- Modify: `src/lib/action-items.ts:73-81` (`listOpenActionItems` selects `owedBy`)
- Modify: `src/components/contacts/contact-next-steps.tsx` (type, `owedLabel`, badge)
- Create: `src/components/contacts/contact-open-threads.tsx`
- Modify: `src/components/contacts/contact-brief-card.tsx` (threads under next steps), `page.tsx` (carry `owedBy`)
- Test: `scripts/smoke-relationship-ui.ts`, `scripts/smoke-action-items.ts` (extend)

**Interfaces:**
- Consumes: `DigestThread` (Task 7), `remindOpenThread`, `dismissOpenThreadAction` (Task 3)
- Produces:
  - `OpenActionItem` gains `owedBy: "me" | "them" | null`
  - `owedLabel(owedBy: "me" | "them" | null): "You owe" | "They owe" | null` — exported from `contact-next-steps.tsx`
  - `OpenThreadsList(props: { threads: DigestThread[]; busyKey: string | null; onRemind?: (key: string) => void; onDismiss?: (key: string) => void })` — pure; a `<details>` collapsed by default, summary "Open threads (N)"
  - `ContactOpenThreads(props: { contactId: string; threads: DigestThread[] })` — container

- [ ] **Step 1: Write the failing tests**
  - `scripts/smoke-action-items.ts`: after an item exists for a contact, `await db.update(actionItems).set({ owedBy: "them" }).where(eq(actionItems.id, <that id>))`, then `check("list: owedBy carried", (await listOpenActionItems(USER, <contactId>)).find((i) => i.id === <that id>)?.owedBy === "them")`.
  - `scripts/smoke-relationship-ui.ts`:
    ```ts
    import { owedLabel } from "../src/components/contacts/contact-next-steps";
    import { OpenThreadsList } from "../src/components/contacts/contact-open-threads";

    check("owed: me", owedLabel("me") === "You owe");
    check("owed: them", owedLabel("them") === "They owe");
    check("owed: none", owedLabel(null) === null);
    const threads = [
      { key: "t1", text: "Intro to Priya", owedBy: "me" as const, sinceIso: "2026-05-01", interactionId: "x", excerpt: "can you intro me to Priya?", canRemind: true },
      { key: "t2", text: "Coffee in October", owedBy: null, sinceIso: "2026-04-01", interactionId: "y", excerpt: "coffee sometime?", canRemind: false },
    ];
    const th = textOf(renderToStaticMarkup(React.createElement(OpenThreadsList, { threads, busyKey: null, onRemind: () => {}, onDismiss: () => {} })));
    check("threads: count in the summary", th.includes("Open threads (2)"), th);
    check("threads: quote and date", th.includes("can you intro me to Priya?") && th.includes("May 1"));
    check("threads: owed badge", th.includes("You owe"));
    check("threads: remind only where possible", (th.match(/Remind me/g) ?? []).length === 1, th);
    check("threads: dismiss on each", (th.match(/Dismiss/g) ?? []).length === 2);
    ```
    (`contact-next-steps.tsx` imports `useRouter`; importing the module in a script is fine as long as only `owedLabel` is called.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-relationship-ui.ts; npx tsx scripts/smoke-action-items.ts`
Expected: FAIL (missing exports; `owedBy` undefined).

- [ ] **Step 3: Implement**
  - `listOpenActionItems`: add `owedBy: actionItems.owedBy` to the select.
  - `contact-next-steps.tsx`: `owedBy: "me" | "them" | null` on `OpenActionItem`, and
    ```tsx
    export function owedLabel(owedBy: "me" | "them" | null): "You owe" | "They owe" | null {
      return owedBy === "me" ? "You owe" : owedBy === "them" ? "They owe" : null;
    }
    ```
    In the row, next to the "reminder set" badge: `{owedLabel(item.owedBy) ? <Badge variant={item.owedBy === "me" ? "secondary" : "outline"} className="text-[10px]">{owedLabel(item.owedBy)}</Badge> : null}`.
  - `page.tsx`: carry `owedBy` where `nextSteps` is mapped for the brief card (`:345-355`) and anywhere else the compiler flags.
  - `contact-open-threads.tsx`:
    ```tsx
    "use client";

    import { useState, useTransition } from "react";
    import { useRouter } from "next/navigation";
    import { format } from "date-fns";
    import { BellPlus, X } from "lucide-react";
    import { Badge } from "@/components/ui/badge";
    import { Button } from "@/components/ui/button";
    import { dismissOpenThreadAction, remindOpenThread } from "@/actions/relationships";
    import { owedLabel } from "@/components/contacts/contact-next-steps";
    import type { DigestThread } from "@/lib/relationship-engine/digest-copy";
    import { friendlyError } from "@/lib/friendly-error";
    import { TOAST_COPY } from "@/lib/toast-copy";
    import { toast } from "@/lib/toast";

    export function OpenThreadsList({ threads, busyKey, onRemind, onDismiss }: {
      threads: DigestThread[];
      busyKey: string | null;
      onRemind?: (key: string) => void;
      onDismiss?: (key: string) => void;
    }) {
      if (!threads.length) return null;
      return (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Open threads ({threads.length})</summary>
          <ul className="mt-2 space-y-2">
            {threads.map((t) => (
              <li key={t.key} className="rounded-md border p-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">{t.text}</span>
                  {owedLabel(t.owedBy) ? <Badge variant="outline" className="text-[10px]">{owedLabel(t.owedBy)}</Badge> : null}
                </div>
                <p className="text-xs italic text-muted-foreground">
                  “{t.excerpt}” · {format(new Date(`${t.sinceIso.slice(0, 10)}T12:00:00`), "MMM d")}
                </p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {t.canRemind && onRemind ? (
                    <Button size="sm" variant="outline" disabled={busyKey === t.key} onClick={() => onRemind(t.key)}>
                      <BellPlus className="size-3.5" aria-hidden /> Remind me
                    </Button>
                  ) : null}
                  {onDismiss ? (
                    <Button size="sm" variant="ghost" disabled={busyKey === t.key} onClick={() => onDismiss(t.key)}>
                      <X className="size-3.5" aria-hidden /> Dismiss
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </details>
      );
    }

    export function ContactOpenThreads({ contactId, threads }: { contactId: string; threads: DigestThread[] }) {
      const router = useRouter();
      const [hidden, setHidden] = useState<Set<string>>(new Set());
      const [busyKey, setBusyKey] = useState<string | null>(null);
      const [, start] = useTransition();
      const act = (key: string, run: () => Promise<{ ok: true } | { error: string }>, ok: string) =>
        start(async () => {
          setBusyKey(key);
          try {
            const res = await run();
            if ("error" in res) {
              toast.error(res.error);
              return;
            }
            setHidden((h) => new Set(h).add(key));
            toast.success(ok);
            router.refresh();
          } catch (err) {
            toast.error(friendlyError(err, TOAST_COPY.saveFailed));
          } finally {
            setBusyKey(null);
          }
        });
      return (
        <OpenThreadsList
          threads={threads.filter((t) => !hidden.has(t.key))}
          busyKey={busyKey}
          onRemind={(key) => act(key, () => remindOpenThread(contactId, key), "Reminder added")}
          onDismiss={(key) => act(key, () => dismissOpenThreadAction(contactId, key), "Thread dismissed")}
        />
      );
    }
    ```
    (match the import paths for `toast`, `friendlyError`, `TOAST_COPY` to `contact-next-steps.tsx`'s own.)
  - `contact-brief-card.tsx`: under `<ContactNextSteps … />`, render `{digest?.openThreads.length ? <ContactOpenThreads contactId={contactId} threads={digest.openThreads} /> : null}`.

- [ ] **Step 4: Run the tests**

Run: `npx tsx scripts/smoke-relationship-ui.ts && npx tsx scripts/smoke-action-items.ts && npx tsx scripts/smoke-toast-copy.ts && npx tsx scripts/smoke-tap-targets.ts && npm run typecheck && npx eslint src/components/contacts src/lib/action-items.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/action-items.ts src/components/contacts/contact-next-steps.tsx src/components/contacts/contact-open-threads.tsx src/components/contacts/contact-brief-card.tsx "src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx" scripts/smoke-relationship-ui.ts scripts/smoke-action-items.ts
git commit -m "feat(contacts): You owe / They owe badges and open threads with Remind me and Dismiss"
```

---

### Task 9: Timeline — WhatsApp and iMessage source icons

**Files:**
- Create: `src/components/icons/chat-source-icons.tsx`
- Modify: `src/components/contacts/contact-timeline.tsx:60-71` (type), `:815-830` (icon + label)
- Modify: `src/actions/contacts.ts:622+` (`listContactTimelineInteractions` keeps `source`), `src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx:406-413` (keep `source`)
- Test: `scripts/smoke-relationship-ui.ts` (extend)

**Interfaces:**
- Produces:
  - `TimelineInteraction` gains `source?: string | null`
  - `WhatsAppIcon`, `IMessageIcon` (`({ className }) => JSX.Element`, `aria-hidden`, `currentColor`)
  - `chatSourceIcon(source: string | null | undefined): ComponentType<{ className?: string }> | null`
  - `chatSourceLabel(source: string | null | undefined): "WhatsApp" | "iMessage" | null`

- [ ] **Step 1: Write the failing test** — add to `scripts/smoke-relationship-ui.ts`:

```ts
import { chatSourceIcon, chatSourceLabel, IMessageIcon, WhatsAppIcon } from "../src/components/icons/chat-source-icons";

check("icon: whatsapp", chatSourceIcon("whatsapp") === WhatsAppIcon && chatSourceLabel("whatsapp") === "WhatsApp");
check("icon: imessage", chatSourceIcon("imessage") === IMessageIcon && chatSourceLabel("imessage") === "iMessage");
check("icon: others fall back", chatSourceIcon("linkedin") === null && chatSourceIcon(null) === null && chatSourceLabel(undefined) === null);
const svg = renderToStaticMarkup(React.createElement(WhatsAppIcon, { className: "size-4" }));
check("icon: decorative svg in currentColor", svg.startsWith("<svg") && svg.includes('aria-hidden="true"') && svg.includes("currentColor"), svg.slice(0, 120));
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx scripts/smoke-relationship-ui.ts`
Expected: FAIL — cannot resolve `chat-source-icons`.

- [ ] **Step 3: Implement `chat-source-icons.tsx`** — single-color glyphs in `currentColor` so they take the timeline's `written` family color (no brand colors, no trademark artwork, no external assets):

```tsx
import type { ComponentType } from "react";

type IconProps = { className?: string };

/** A round speech bubble with a handset: reads as WhatsApp at 16px. */
export function WhatsAppIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.5 11.6a8.5 8.5 0 0 1-12.6 7.4L3.5 20.5l1.5-4.3A8.5 8.5 0 1 1 20.5 11.6Z" />
      <path d="M9 8.6c.2-.4.6-.5.9-.4l.8.2.6 1.6-.7.8a5.7 5.7 0 0 0 2.7 2.7l.8-.7 1.6.6.2.8c.1.3 0 .7-.4.9-.8.4-2.5.3-4.3-1.3S8.6 9.4 9 8.6Z" />
    </svg>
  );
}

/** A rounded bubble with a tail: the iMessage shape, single color. */
export function IMessageIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4c4.7 0 8.5 3 8.5 6.8s-3.8 6.8-8.5 6.8c-.9 0-1.8-.1-2.6-.3L5 19.5l1-3.4C4.4 14.9 3.5 13 3.5 10.8 3.5 7 7.3 4 12 4Z" />
    </svg>
  );
}

const ICONS: Record<string, ComponentType<IconProps>> = { whatsapp: WhatsAppIcon, imessage: IMessageIcon };
const LABELS: Record<string, "WhatsApp" | "iMessage"> = { whatsapp: "WhatsApp", imessage: "iMessage" };

export function chatSourceIcon(source: string | null | undefined): ComponentType<IconProps> | null {
  return (source && ICONS[source]) || null;
}

export function chatSourceLabel(source: string | null | undefined): "WhatsApp" | "iMessage" | null {
  return (source && LABELS[source]) || null;
}
```

- [ ] **Step 4: Wire the timeline**
  - `contact-timeline.tsx`: add `source?: string | null` to `TimelineInteraction`. Where the row's icon is chosen (`interactionTypeIcon(i.interactionType)` near `:821`), use `(i.interactionType === "message" && chatSourceIcon(i.source)) || interactionTypeIcon(i.interactionType)`; where the row's type label is shown, prefer `chatSourceLabel(i.source)` for `message` rows ("WhatsApp" instead of "Message"). The family (and so the color) is unchanged.
  - `page.tsx:406-413` and `listContactTimelineInteractions` (`src/actions/contacts.ts:622+`): include `source` in the mapped object (`timelineInteractionColumns` already selects it).
  - The transcript is the existing `InteractionDetailSheet` (rows already open it and it shows `rawNotes`). No change.

- [ ] **Step 5: Run the tests**

Run: `npx tsx scripts/smoke-relationship-ui.ts && npx tsx scripts/smoke-timeline-vocabulary.ts && npx tsx scripts/smoke-contact-profile-reads.ts && npm run typecheck && npx eslint src/components src/actions/contacts.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/icons/chat-source-icons.tsx src/components/contacts/contact-timeline.tsx src/actions/contacts.ts "src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx" scripts/smoke-relationship-ui.ts
git commit -m "feat(timeline): WhatsApp and iMessage source icons on chat sessions"
```

---

### Task 10: Full verification and browser pass

**Files:** none new (fix-ups are committed with the task they belong to).

- [ ] **Step 1: Whole suite**

Stop any dev server on this worktree first (PGlite is single-writer, and a build wedges a running `next dev`).
Run: `npm run typecheck && npx eslint . && npm run db:check && npm run test && npm run build`
Expected: typecheck clean; eslint 0 errors; db:check unchanged at v148; all smokes pass (rerun a known load flake — `admin-render`, `instrumentation`, `chat-versions` — alone before calling it a failure); build exit 0.

- [ ] **Step 2: Browser pass on the local demo workspace** (`preview_start` from `.claude/launch.json`; if the entry launches another worktree, add a temporary entry with `npm --prefix <this worktree> run dev`. The tab must be visible and hydrated — probe `main.scrollTop`, never `window.scrollY`.)
  1. Seed with a scratchpad tsx script (not committed): one finished `relationship_runs` row for the demo user with counters, one flag, `finishedAt = now` and its note batch (`ensureRunNoteBatch`); a digest for one demo contact with `whatTheyDo`, `summary`, two topics, two open threads and `runId` set; one action item on that contact with `owed_by = 'them'`; one `interactions` row `interaction_type 'message'`, `source 'whatsapp'` with a short transcript.
  2. `/imports`: the analysis card shows the headline and the flag with its quote; **Remind me** shows "Reminder added" and the flag disappears; **Undo all** shows "Analysis undone" and the reminder leaves `/reminders`.
  3. Bell: the analysis row shows; it links to `/imports#relationship-analysis`, which scrolls the card into view.
  4. The contact profile: what they do, summary, topic chips, source line; a "They owe" badge on the action item; "Open threads (2)" expands; Remind me and Dismiss each work and the list updates.
  5. The same contact's timeline: the WhatsApp row shows the glyph and the "WhatsApp" label; clicking it opens the transcript sheet.
  6. Settings → AI: the Relationship analysis switch toggles and survives a reload.
  7. Dark mode (`resize_window` `colorScheme: "dark"`) and 375 px width: no overflow in the card, the digest or the threads list. Reset with preset `desktop` afterwards.
  8. `read_console_messages` with `onlyErrors: true`: no new errors.

- [ ] **Step 3: Ship** — push `claude/relationship-engine-p3-ui` and open the PR against `claude/relationship-engine-p2-chat-imports`, listing the planning decisions above for review.

---

## Spec coverage

| Spec §6 / deferred item | Task |
|---|---|
| Run summary: headline, reminders, Undo all, one-click flags, failures / skips / "older history not read", progress while running | 3, 4 |
| Bell notice when the run finishes | 5 |
| Brief card: what they do, summary, topic chips with "last discussed", source line | 7 |
| Next steps: You owe / They owe | 8 |
| Open threads: collapsed, quote + date, Remind me (in the run's batch) / Dismiss | 3, 8 |
| Timeline: WhatsApp / iMessage icon, expandable to the transcript | 9 (transcript = existing detail sheet) |
| Settings → AI switch | 6 |
| Saving a key kicks the runner (§5), including OpenRouter | 1 |
| Undo refuses non-terminal runs | 2, 3 |
| Cron starvation / keyless churn, idle runs, `run.import_id`, merge digest, owner name, note-batch race, flags dedupe | 1, 2 |
| "Overflow past the caps" in the summary | Deferred (decision 7: needs a run counter, i.e. DDL) |
| ~24 statements per contact in batch apply | Deferred (decision 7) |
