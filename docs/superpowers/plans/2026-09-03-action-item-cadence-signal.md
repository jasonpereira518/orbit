# Action-Item Cadence Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make follow-up cadence read action-item completion — an aging open commitment should raise urgency, and a recent completion should suggest circling back — instead of relying on relationship score and idle time alone.

**Architecture:** One new batched-query module (`src/lib/action-item-signals.ts`, following the exact two-query batching shape `listContactMentionsBatch` already established) computes a per-contact `ActionItemSignal`. Two existing functions in `src/lib/reminders.ts` — `followUpCandidateScore`/`generateDueFollowUps` (the manual "Generate follow-ups" ranking) and `buildOutreachSuggestions` (passive dashboard suggestions) — consume it. No schema changes; no new UI. Dashboard rendering of suggestions is generic over `title`/`description`/`confidenceScore` already, so the two new suggestion types need no separate rendering work.

**Tech Stack:** Next.js App Router, Drizzle ORM, PGlite (local)/Neon (prod), `npx tsx` smoke scripts (no test framework in this repo).

**Spec:** `docs/superpowers/specs/2026-09-03-action-item-cadence-signal-design.md`

## Global Constraints

- No test framework — verification is hand-rolled `scripts/smoke-*.ts` run via `npx tsx`, with a local throwing `check()` helper and an explicit `process.exit(0)` at the end.
- PGlite is single-writer per worktree. Before any smoke run, confirm no other process has this worktree (`follow-up-cadence-signals-e91a2c`) as its cwd: `lsof -iTCP -sTCP:LISTEN` to list PIDs, then `lsof -a -p <pid> -d cwd` per PID individually (never as a loop — the sandbox rejects multi-line/looping bash as "too complex to verify").
- This worktree's `.env.local` has a real Clerk key pair and a real Neon `DATABASE_URL` — never start `next dev` against it. Verify via smoke scripts (which force PGlite via the dotenv-clearing header) and static tracing only.
- No DDL/schema changes in this feature. `scripts/schema-ddl.lock.json` must not change; if `npm run db:check` complains, something touched `schema.ts`/`db/index.ts` that shouldn't have.
- `"use server"` files export only async functions — not touched by this plan, but keep in mind if a later task adds one.
- Never use `git stash`. Never run `db:push`.
- Match existing code style: no explanatory comments unless documenting a genuinely non-obvious constraint (see the `.returning()` vs `.returning({ id })` note already in this codebase, referenced in Task 2).
- Bare `db...returning()` (no field selector) when inserting/updating rows in this file's style — an explicit field selector defeats Drizzle's overload resolution against the union `Db` type in this codebase (see `src/lib/action-items.ts`'s note on this).

---

### Task 1: Batched action-item signal query

**Files:**
- Create: `src/lib/action-item-signals.ts`
- Test: `scripts/smoke-action-item-signals.ts`

**Interfaces:**
- Produces (consumed by Tasks 2 and 3):
  - `export const OPEN_ITEM_ELIGIBLE_DAYS = 14`
  - `export const CLOSE_LOOP_WINDOW_DAYS = 10`
  - `export const CLOSE_LOOP_SCORE_BOOST = 3`
  - `export type ActionItemSignal = { openCount: number; oldestOpenText: string; oldestOpenAgeDays: number; recentCompletionText?: string; recentCompletionAgeDays?: number }`
  - `export async function getActionItemSignalsBatch(userId: string, contactIds: string[]): Promise<Map<string, ActionItemSignal>>`

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/smoke-action-item-signals.ts`:

```ts
/**
 * getActionItemSignalsBatch: batched open/completion signals used to make follow-up
 * cadence smarter. Exercises the self-silencing rule (a completion superseded by a
 * later interaction must not count) and the "oldest open item wins" selection, against
 * a real (small) PGlite dataset. Writes to local PGlite. Stop this worktree's dev server first.
 * Run: npx tsx scripts/smoke-action-item-signals.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-action-item-signals";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-action-item-signals";
delete process.env.DATABASE_URL;

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { actionItems, contacts, interactions } from "../src/db/schema";
import { actionItemHash } from "../src/lib/action-items";
import { getActionItemSignalsBatch } from "../src/lib/action-item-signals";

const USER = "smoke-action-item-signals-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function daysAgoDate(n: number) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const [oldOpen] = await db.insert(contacts).values({ userId: USER, fullName: "Old Open" }).returning();
  const [multiOpen] = await db.insert(contacts).values({ userId: USER, fullName: "Multi Open" }).returning();
  const [freshClose] = await db.insert(contacts).values({ userId: USER, fullName: "Fresh Close", lastInteractionAt: daysAgoDate(15) }).returning();
  const [alreadyFollowedUp] = await db.insert(contacts).values({ userId: USER, fullName: "Already Followed Up", lastInteractionAt: daysAgoDate(3) }).returning();
  const [noSignal] = await db.insert(contacts).values({ userId: USER, fullName: "No Signal" }).returning();
  const [outsideWindow] = await db.insert(contacts).values({ userId: USER, fullName: "Outside Window", lastInteractionAt: daysAgoDate(50) }).returning();

  const [oldOpenInteraction] = await db.insert(interactions).values({ userId: USER, contactId: oldOpen.id, rawNotes: "x", interactionDate: daysAgoDate(20) }).returning();
  const [multiOpenInteraction] = await db.insert(interactions).values({ userId: USER, contactId: multiOpen.id, rawNotes: "x", interactionDate: daysAgoDate(20) }).returning();
  const [freshCloseInteraction] = await db.insert(interactions).values({ userId: USER, contactId: freshClose.id, rawNotes: "x", interactionDate: daysAgoDate(15) }).returning();
  const [alreadyFollowedUpInteraction] = await db.insert(interactions).values({ userId: USER, contactId: alreadyFollowedUp.id, rawNotes: "x", interactionDate: daysAgoDate(20) }).returning();
  const [outsideWindowInteraction] = await db.insert(interactions).values({ userId: USER, contactId: outsideWindow.id, rawNotes: "x", interactionDate: daysAgoDate(50) }).returning();

  // oldOpen: one open item, 20 days old.
  await db.insert(actionItems).values({
    userId: USER, contactId: oldOpen.id, interactionId: oldOpenInteraction.id,
    text: "Send the intro doc", status: "open",
    itemHash: actionItemHash(oldOpenInteraction.id, "Send the intro doc"),
    createdAt: daysAgoDate(20),
  });

  // multiOpen: two open items, 5 and 20 days old — the OLDER one should win.
  await db.insert(actionItems).values({
    userId: USER, contactId: multiOpen.id, interactionId: multiOpenInteraction.id,
    text: "Recent ask", status: "open",
    itemHash: actionItemHash(multiOpenInteraction.id, "Recent ask"),
    createdAt: daysAgoDate(5),
  });
  await db.insert(actionItems).values({
    userId: USER, contactId: multiOpen.id, interactionId: multiOpenInteraction.id,
    text: "Older ask", status: "open",
    itemHash: actionItemHash(multiOpenInteraction.id, "Older ask"),
    createdAt: daysAgoDate(20),
  });

  // freshClose: completed 5 days ago, AFTER lastInteractionAt (15 days ago) — must count.
  await db.insert(actionItems).values({
    userId: USER, contactId: freshClose.id, interactionId: freshCloseInteraction.id,
    text: "Send the deck", status: "done", completedAt: daysAgoDate(5),
    itemHash: actionItemHash(freshCloseInteraction.id, "Send the deck"),
  });

  // alreadyFollowedUp: completed 20 days ago, BEFORE lastInteractionAt (3 days ago) — a
  // later interaction already closed the loop, so this must be self-silenced.
  await db.insert(actionItems).values({
    userId: USER, contactId: alreadyFollowedUp.id, interactionId: alreadyFollowedUpInteraction.id,
    text: "Send the deck", status: "done", completedAt: daysAgoDate(20),
    itemHash: actionItemHash(alreadyFollowedUpInteraction.id, "Send the deck"),
  });

  // outsideWindow: completed 45 days ago — outside the 30-day query window entirely.
  await db.insert(actionItems).values({
    userId: USER, contactId: outsideWindow.id, interactionId: outsideWindowInteraction.id,
    text: "Old task", status: "done", completedAt: daysAgoDate(45),
    itemHash: actionItemHash(outsideWindowInteraction.id, "Old task"),
  });

  const result = await getActionItemSignalsBatch(USER, [
    oldOpen.id, multiOpen.id, freshClose.id, alreadyFollowedUp.id, noSignal.id, outsideWindow.id,
  ]);

  const oldOpenSignal = result.get(oldOpen.id);
  check(
    "oldOpen has openCount 1 and ~20 days old",
    oldOpenSignal?.openCount === 1 && (oldOpenSignal?.oldestOpenAgeDays ?? 0) >= 19 && (oldOpenSignal?.oldestOpenAgeDays ?? 0) <= 21,
    JSON.stringify(oldOpenSignal)
  );

  const multiOpenSignal = result.get(multiOpen.id);
  check(
    "multiOpen has openCount 2 and picks the OLDER item as oldestOpenText",
    multiOpenSignal?.openCount === 2 && multiOpenSignal?.oldestOpenText === "Older ask",
    JSON.stringify(multiOpenSignal)
  );

  const freshCloseSignal = result.get(freshClose.id);
  check(
    "freshClose has a recent completion, ~5 days old",
    freshCloseSignal?.recentCompletionText === "Send the deck" && (freshCloseSignal?.recentCompletionAgeDays ?? -1) >= 4 && (freshCloseSignal?.recentCompletionAgeDays ?? -1) <= 6,
    JSON.stringify(freshCloseSignal)
  );

  check(
    "alreadyFollowedUp is absent entirely — its only completion is self-silenced by a later interaction",
    result.get(alreadyFollowedUp.id) === undefined,
    JSON.stringify(result.get(alreadyFollowedUp.id))
  );

  check("noSignal is absent from the Map entirely", result.get(noSignal.id) === undefined);
  check("outsideWindow's 45-day-old completion falls outside the query window, absent from the Map", result.get(outsideWindow.id) === undefined);

  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log("\nsmoke-action-item-signals: all checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Before running, verify PGlite is free: `lsof -iTCP -sTCP:LISTEN`, then `lsof -a -p <pid> -d cwd` for each listed PID — none should show this worktree's path as cwd.

Run: `npx tsx scripts/smoke-action-item-signals.ts`
Expected: fails to import `getActionItemSignalsBatch` from a module that doesn't exist yet (module-not-found error), exit code 1.

- [ ] **Step 3: Write the implementation**

Create `src/lib/action-item-signals.ts`:

```ts
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { actionItems, contacts } from "@/db/schema";
import { daysAgo } from "@/lib/duplicates";

export const OPEN_ITEM_ELIGIBLE_DAYS = 14;
export const CLOSE_LOOP_WINDOW_DAYS = 10;
export const CLOSE_LOOP_SCORE_BOOST = 3;

const RECENT_COMPLETION_QUERY_WINDOW_DAYS = 30;

export type ActionItemSignal = {
  openCount: number;
  oldestOpenText: string;
  oldestOpenAgeDays: number;
  recentCompletionText?: string;
  recentCompletionAgeDays?: number;
};

export async function getActionItemSignalsBatch(
  userId: string,
  contactIds: string[]
): Promise<Map<string, ActionItemSignal>> {
  const result = new Map<string, ActionItemSignal>();
  if (!contactIds.length) return result;
  const db = await getDb();

  const openRows = await db
    .select({ contactId: actionItems.contactId, text: actionItems.text, createdAt: actionItems.createdAt })
    .from(actionItems)
    .where(and(eq(actionItems.userId, userId), eq(actionItems.status, "open"), inArray(actionItems.contactId, contactIds)))
    .orderBy(actionItems.createdAt);

  for (const row of openRows) {
    const existing = result.get(row.contactId);
    if (!existing) {
      result.set(row.contactId, {
        openCount: 1,
        oldestOpenText: row.text,
        oldestOpenAgeDays: daysAgo(row.createdAt),
      });
    } else {
      existing.openCount += 1;
    }
  }

  const cutoff = new Date(Date.now() - RECENT_COMPLETION_QUERY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const doneRows = await db
    .select({
      contactId: actionItems.contactId,
      text: actionItems.text,
      completedAt: actionItems.completedAt,
      lastInteractionAt: contacts.lastInteractionAt,
    })
    .from(actionItems)
    .innerJoin(contacts, eq(contacts.id, actionItems.contactId))
    .where(
      and(
        eq(actionItems.userId, userId),
        eq(actionItems.status, "done"),
        gte(actionItems.completedAt, cutoff),
        inArray(actionItems.contactId, contactIds)
      )
    )
    .orderBy(desc(actionItems.completedAt));

  const decidedRecentCompletion = new Set<string>();
  for (const row of doneRows) {
    if (decidedRecentCompletion.has(row.contactId)) continue;
    if (!row.completedAt) continue;
    // Self-silencing: a completion already superseded by a later interaction must not
    // keep nudging — once the user actually follows up, lastInteractionAt moves past it.
    if (row.lastInteractionAt && row.lastInteractionAt >= row.completedAt) continue;
    decidedRecentCompletion.add(row.contactId);
    const existing = result.get(row.contactId);
    const signal: ActionItemSignal = existing ?? { openCount: 0, oldestOpenText: "", oldestOpenAgeDays: Infinity };
    signal.recentCompletionText = row.text;
    signal.recentCompletionAgeDays = daysAgo(row.completedAt);
    result.set(row.contactId, signal);
  }

  return result;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx tsx scripts/smoke-action-item-signals.ts`
Expected: all 7 `check(...)` lines print `ok`, then `smoke-action-item-signals: all checks passed`, exit code 0.

Also run:
- `npx tsc --noEmit` — expect clean.
- `npx eslint src/lib/action-item-signals.ts scripts/smoke-action-item-signals.ts` — expect clean.
- `npm run db:check` — expect unchanged (no schema touched); confirms this task didn't accidentally drift DDL.

- [ ] **Step 5: Commit**

```bash
git add src/lib/action-item-signals.ts scripts/smoke-action-item-signals.ts
git commit -m "feat(reminders): batch action-item open/completion signals"
```

---

### Task 2: Feed the signal into `followUpCandidateScore` / `generateDueFollowUps`

**Files:**
- Modify: `src/lib/reminders.ts:1-20` (imports), `src/lib/reminders.ts:228-242` (`followUpCandidateScore`), `src/lib/reminders.ts:248-333` (`generateDueFollowUps`)
- Test: `scripts/smoke-followup-cadence-scoring.ts` (new)

**Interfaces:**
- Consumes (from Task 1): `getActionItemSignalsBatch`, `ActionItemSignal`, `OPEN_ITEM_ELIGIBLE_DAYS`, `CLOSE_LOOP_WINDOW_DAYS`, `CLOSE_LOOP_SCORE_BOOST` from `@/lib/action-item-signals`.
- Produces: `followUpCandidateScore` gains a second, optional `signal?: ActionItemSignal` parameter (internal helper, not exported — Task 3 does not call it, so no cross-task interface beyond this file).

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/smoke-followup-cadence-scoring.ts`:

```ts
/**
 * generateDueFollowUps: contacts with an aging open action item or a recent, un-followed-up
 * completion must become candidates even when idle time/priority/relationship score alone
 * would not select them — and a more urgent open item must outrank a less urgent one.
 * Writes to local PGlite. Stop this worktree's dev server first.
 * Run: npx tsx scripts/smoke-followup-cadence-scoring.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-cadence-scoring";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-cadence-scoring";
delete process.env.DATABASE_URL;

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { actionItems, contacts, interactions, reminders } from "../src/db/schema";
import { actionItemHash } from "../src/lib/action-items";
import { generateDueFollowUps } from "../src/lib/reminders";

const USER = "smoke-cadence-scoring-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function daysAgoDate(n: number) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));

  // Low priority/relationship/idle for all four — only the new signal should distinguish them.
  const base = { userId: USER, priorityLevel: 0, relationshipScore: 2 } as const;

  const [oldItemHigh] = await db.insert(contacts).values({ ...base, fullName: "Old Item High", lastInteractionAt: daysAgoDate(5) }).returning();
  const [oldItemLow] = await db.insert(contacts).values({ ...base, fullName: "Old Item Low", lastInteractionAt: daysAgoDate(5) }).returning();
  const [completionOnly] = await db.insert(contacts).values({ ...base, fullName: "Completion Only", lastInteractionAt: daysAgoDate(12) }).returning();
  const [control] = await db.insert(contacts).values({ ...base, fullName: "Control", lastInteractionAt: daysAgoDate(5) }).returning();

  const [oldItemHighInteraction] = await db.insert(interactions).values({ userId: USER, contactId: oldItemHigh.id, rawNotes: "x", interactionDate: daysAgoDate(40) }).returning();
  const [oldItemLowInteraction] = await db.insert(interactions).values({ userId: USER, contactId: oldItemLow.id, rawNotes: "x", interactionDate: daysAgoDate(15) }).returning();
  const [completionOnlyInteraction] = await db.insert(interactions).values({ userId: USER, contactId: completionOnly.id, rawNotes: "x", interactionDate: daysAgoDate(12) }).returning();

  // oldItemHigh: open item 40 days old — should rank ahead of a 15-day-old one.
  await db.insert(actionItems).values({
    userId: USER, contactId: oldItemHigh.id, interactionId: oldItemHighInteraction.id,
    text: "Big ask", status: "open",
    itemHash: actionItemHash(oldItemHighInteraction.id, "Big ask"),
    createdAt: daysAgoDate(40),
  });

  // oldItemLow: open item 15 days old — just above the 14-day eligibility threshold.
  await db.insert(actionItems).values({
    userId: USER, contactId: oldItemLow.id, interactionId: oldItemLowInteraction.id,
    text: "Small ask", status: "open",
    itemHash: actionItemHash(oldItemLowInteraction.id, "Small ask"),
    createdAt: daysAgoDate(15),
  });

  // completionOnly: completed 5 days ago, after lastInteractionAt (12 days ago) — a
  // fresh, un-followed-up completion, with idle (12d) below the 14-day idle threshold.
  await db.insert(actionItems).values({
    userId: USER, contactId: completionOnly.id, interactionId: completionOnlyInteraction.id,
    text: "Sent the deck", status: "done", completedAt: daysAgoDate(5),
    itemHash: actionItemHash(completionOnlyInteraction.id, "Sent the deck"),
  });

  // control: no action items, idle only 5 days — must not qualify.

  const result = await generateDueFollowUps(USER, 10);

  check("oldItemHigh is a candidate", result.contactIds.includes(oldItemHigh.id));
  check("oldItemLow is a candidate", result.contactIds.includes(oldItemLow.id));
  check("completionOnly is a candidate", result.contactIds.includes(completionOnly.id));
  check("control is NOT a candidate — no idle/priority/relationship/action-item signal qualifies it", !result.contactIds.includes(control.id));
  check(
    "a 40-day-old open item outranks a 15-day-old one",
    result.contactIds.indexOf(oldItemHigh.id) < result.contactIds.indexOf(oldItemLow.id),
    JSON.stringify(result.contactIds)
  );

  const generatedReminders = await db
    .select({ contactId: reminders.contactId, status: reminders.status })
    .from(reminders)
    .where(and(eq(reminders.userId, USER), eq(reminders.reminderType, "generated")));
  const reminderContactIds = new Set(generatedReminders.map((r) => r.contactId));
  check("a pending reminder row exists for oldItemHigh", reminderContactIds.has(oldItemHigh.id));
  check("a pending reminder row exists for completionOnly", reminderContactIds.has(completionOnly.id));
  check("no reminder row exists for control", !reminderContactIds.has(control.id));

  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log("\nsmoke-followup-cadence-scoring: all checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Verify PGlite is free first (per Global Constraints).

Run: `npx tsx scripts/smoke-followup-cadence-scoring.ts`
Expected: fails — `control` currently has none of the pre-existing eligibility conditions but neither do the "signal" contacts (idle time is deliberately kept below today's thresholds for all four), so none of `oldItemHigh`/`oldItemLow`/`completionOnly` are candidates yet. The `check(...)` calls for those contacts throw. Exit code 1.

- [ ] **Step 3: Write the implementation**

In `src/lib/reminders.ts`, extend the import block (after the existing `contact-avatar-url` import, line 20):

```ts
import { clientContactAvatarUrl } from "@/lib/contact-avatar-url";
import {
  ActionItemSignal,
  CLOSE_LOOP_SCORE_BOOST,
  CLOSE_LOOP_WINDOW_DAYS,
  OPEN_ITEM_ELIGIBLE_DAYS,
  getActionItemSignalsBatch,
} from "@/lib/action-item-signals";
```

Replace `followUpCandidateScore` (lines 228-242):

```ts
function followUpCandidateScore(
  contact: {
    priorityLevel: number;
    relationshipScore: number;
    lastInteractionAt: Date | string | null;
    nextFollowUpAt: Date | string | null;
  },
  signal?: ActionItemSignal
) {
  const idleDays = Math.min(daysAgo(contact.lastInteractionAt), 365);
  const idleScore = Number.isFinite(idleDays) ? idleDays / 30 : 2;
  const openItemUrgency = signal?.openCount ? 1 + signal.oldestOpenAgeDays / 14 : 0;
  const closeTheLoopBoost =
    signal?.recentCompletionAgeDays !== undefined && signal.recentCompletionAgeDays <= CLOSE_LOOP_WINDOW_DAYS
      ? CLOSE_LOOP_SCORE_BOOST
      : 0;
  return (
    (contact.priorityLevel || 0) * 4 +
    (contact.relationshipScore || 0) * 2 +
    idleScore +
    openItemUrgency +
    closeTheLoopBoost -
    (contact.nextFollowUpAt ? 1 : 0)
  );
}
```

In `generateDueFollowUps`, fetch the signal batch right after `all` is loaded (lines 251-253 stay, insert after):

```ts
  const all = await db.query.contacts.findMany({
    where: eq(contacts.userId, userId),
  });
  const signals = await getActionItemSignalsBatch(userId, all.map((c) => c.id));
```

Replace the candidates block (lines 261-279) to thread `signals` through the eligibility filter and the sort:

```ts
  const candidates = all
    .filter((c) => !alreadyDueIds.has(c.id))
    .filter((c) => {
      // Skip people with a future follow-up still more than a day away
      if (c.nextFollowUpAt && new Date(c.nextFollowUpAt) > now) {
        const ms = new Date(c.nextFollowUpAt).getTime() - now.getTime();
        if (ms > 24 * 60 * 60 * 1000) return false;
      }
      // Prefer people who have gone quiet, have no follow-up yet, or have an
      // action-item signal (an aging open commitment, or a recent un-followed-up completion).
      const idle = daysAgo(c.lastInteractionAt);
      const signal = signals.get(c.id);
      return (
        !c.nextFollowUpAt ||
        idle >= 14 ||
        (c.priorityLevel || 0) >= 2 ||
        (c.relationshipScore || 0) >= 4 ||
        (!!signal?.openCount && signal.oldestOpenAgeDays >= OPEN_ITEM_ELIGIBLE_DAYS) ||
        (signal?.recentCompletionAgeDays !== undefined && signal.recentCompletionAgeDays <= CLOSE_LOOP_WINDOW_DAYS)
      );
    })
    .sort((a, b) => followUpCandidateScore(b, signals.get(b.id)) - followUpCandidateScore(a, signals.get(a.id)))
    .slice(0, Math.max(1, Math.min(24, limit)));
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx tsx scripts/smoke-followup-cadence-scoring.ts`
Expected: all `check(...)` lines print `ok`, exit code 0.

Also run:
- `npx tsx scripts/smoke-action-item-signals.ts` — must still pass (regression check on Task 1's own test).
- `npx tsc --noEmit` — expect clean.
- `npx eslint src/lib/reminders.ts scripts/smoke-followup-cadence-scoring.ts` — expect clean.
- `npm run db:check` — expect unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reminders.ts scripts/smoke-followup-cadence-scoring.ts
git commit -m "feat(reminders): factor action-item signals into follow-up scoring"
```

---

### Task 3: Two new discovery-suggestion heuristics

**Files:**
- Modify: `src/lib/reminders.ts:22-44` (`AUTO_SUGGESTION_TYPES`, `AUTO_TYPE_PRIORITY`), `src/lib/reminders.ts:90-226` (`buildOutreachSuggestions`)
- Test: `scripts/smoke-followup-cadence-suggestions.ts` (new)

**Interfaces:**
- Consumes (from Task 1): same `getActionItemSignalsBatch`/`OPEN_ITEM_ELIGIBLE_DAYS` import Task 2 already added to this file.
- Produces: two new `aiSuggestions.suggestionType` values, `"open_commitment"` and `"closed_the_loop"`, alongside the existing three. No other module reads `AUTO_SUGGESTION_TYPES`/`AUTO_TYPE_PRIORITY` directly (confirmed: `getDashboardData`'s suggestion handling, `src/lib/reminders.ts:627-639`, is generic over `title`/`description`/`confidenceScore`/`relatedContactIds` — no per-type branching to update).

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/smoke-followup-cadence-suggestions.ts`:

```ts
/**
 * buildOutreachSuggestions (via refreshOutreachSuggestions): a contact with no scheduled
 * follow-up but an aging open commitment, or a recent un-followed-up completion, must get
 * a discovery suggestion — and a contact who already has a scheduled follow-up must not,
 * since they've left the discovery population.
 * Writes to local PGlite. Stop this worktree's dev server first.
 * Run: npx tsx scripts/smoke-followup-cadence-suggestions.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-cadence-suggestions";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-cadence-suggestions";
delete process.env.DATABASE_URL;

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { actionItems, aiSuggestions, contacts, interactions } from "../src/db/schema";
import { actionItemHash } from "../src/lib/action-items";
import { refreshOutreachSuggestions } from "../src/lib/reminders";

const USER = "smoke-cadence-suggestions-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function daysAgoDate(n: number) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const base = { userId: USER, priorityLevel: 0, relationshipScore: 2 } as const;

  const [openCommit] = await db.insert(contacts).values({ ...base, fullName: "Open Commit", lastInteractionAt: daysAgoDate(5) }).returning();
  const [closedLoop] = await db.insert(contacts).values({ ...base, fullName: "Closed Loop", lastInteractionAt: daysAgoDate(12) }).returning();
  const [control] = await db.insert(contacts).values({ ...base, fullName: "Control", lastInteractionAt: daysAgoDate(5) }).returning();
  // alreadyDue has an old open item too, but a nextFollowUpAt already scheduled —
  // it must NOT get an open_commitment suggestion, since it's left the discovery population.
  const [alreadyDue] = await db.insert(contacts).values({ ...base, fullName: "Already Due", lastInteractionAt: daysAgoDate(5), nextFollowUpAt: daysAgoDate(-3) }).returning();

  const [openCommitInteraction] = await db.insert(interactions).values({ userId: USER, contactId: openCommit.id, rawNotes: "x", interactionDate: daysAgoDate(40) }).returning();
  const [closedLoopInteraction] = await db.insert(interactions).values({ userId: USER, contactId: closedLoop.id, rawNotes: "x", interactionDate: daysAgoDate(12) }).returning();
  const [alreadyDueInteraction] = await db.insert(interactions).values({ userId: USER, contactId: alreadyDue.id, rawNotes: "x", interactionDate: daysAgoDate(40) }).returning();

  await db.insert(actionItems).values({
    userId: USER, contactId: openCommit.id, interactionId: openCommitInteraction.id,
    text: "Intro to Sam", status: "open",
    itemHash: actionItemHash(openCommitInteraction.id, "Intro to Sam"),
    createdAt: daysAgoDate(20),
  });

  await db.insert(actionItems).values({
    userId: USER, contactId: closedLoop.id, interactionId: closedLoopInteraction.id,
    text: "Sent the deck", status: "done", completedAt: daysAgoDate(5),
    itemHash: actionItemHash(closedLoopInteraction.id, "Sent the deck"),
  });

  await db.insert(actionItems).values({
    userId: USER, contactId: alreadyDue.id, interactionId: alreadyDueInteraction.id,
    text: "Old ask", status: "open",
    itemHash: actionItemHash(alreadyDueInteraction.id, "Old ask"),
    createdAt: daysAgoDate(20),
  });

  await refreshOutreachSuggestions(USER);

  const rows = await db
    .select({ contactId: aiSuggestions.relatedContactIds, suggestionType: aiSuggestions.suggestionType, description: aiSuggestions.description })
    .from(aiSuggestions)
    .where(eq(aiSuggestions.userId, USER));

  const byContact = new Map<string, { suggestionType: string; description: string }[]>();
  for (const r of rows) {
    const id = (r.contactId as string[] | null)?.[0];
    if (!id) continue;
    const list = byContact.get(id) ?? [];
    list.push({ suggestionType: r.suggestionType, description: r.description });
    byContact.set(id, list);
  }

  const openCommitSuggestions = byContact.get(openCommit.id) ?? [];
  check(
    "openCommit gets an open_commitment suggestion quoting the item text",
    openCommitSuggestions.some((s) => s.suggestionType === "open_commitment" && s.description.includes("Intro to Sam")),
    JSON.stringify(openCommitSuggestions)
  );

  const closedLoopSuggestions = byContact.get(closedLoop.id) ?? [];
  check(
    "closedLoop gets a closed_the_loop suggestion quoting the item text",
    closedLoopSuggestions.some((s) => s.suggestionType === "closed_the_loop" && s.description.includes("Sent the deck")),
    JSON.stringify(closedLoopSuggestions)
  );

  check("control gets no suggestion at all", !byContact.has(control.id));
  check(
    "alreadyDue gets no open_commitment suggestion — it already has a scheduled follow-up",
    !(byContact.get(alreadyDue.id) ?? []).some((s) => s.suggestionType === "open_commitment"),
    JSON.stringify(byContact.get(alreadyDue.id))
  );

  await db.delete(contacts).where(eq(contacts.userId, USER));
  console.log("\nsmoke-followup-cadence-suggestions: all checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Verify PGlite is free first.

Run: `npx tsx scripts/smoke-followup-cadence-suggestions.ts`
Expected: fails — `openCommit` and `closedLoop` get no suggestions yet (the two new heuristics don't exist). Exit code 1.

- [ ] **Step 3: Write the implementation**

In `src/lib/reminders.ts`, extend `AUTO_SUGGESTION_TYPES` (lines 22-26) and `AUTO_TYPE_PRIORITY` (lines 40-44):

```ts
const AUTO_SUGGESTION_TYPES = [
  "dormant_high_value",
  "post_event",
  "linkedin_thread_quiet",
  "open_commitment",
  "closed_the_loop",
] as const;

const MAX_AUTO_SUGGESTIONS = 12;

const AUTO_TYPE_PRIORITY: Record<(typeof AUTO_SUGGESTION_TYPES)[number], number> = {
  closed_the_loop: 5,
  open_commitment: 4,
  post_event: 3,
  linkedin_thread_quiet: 2,
  dormant_high_value: 1,
};
```

(`closed_the_loop`/`open_commitment` rank above the existing three: a concrete, specific commitment signal is more actionable than a generic idle-time heuristic, so when a contact matches more than one, the action-item signal wins the single suggestion slot.)

In `buildOutreachSuggestions`, after the `dormantHighValue` loop (ends line 152) and before the LinkedIn-history query (line 154), insert the signal fetch and two new loops:

```ts
  const discoveryEligibleIds = all.filter(isDiscoveryEligible).map((c) => c.id);
  const signals = await getActionItemSignalsBatch(userId, discoveryEligibleIds);

  const openCommitment = all.filter(
    (c) =>
      isDiscoveryEligible(c) &&
      !!signals.get(c.id)?.openCount &&
      (signals.get(c.id)?.oldestOpenAgeDays ?? 0) >= OPEN_ITEM_ELIGIBLE_DAYS
  );
  for (const c of openCommitment) {
    const signal = signals.get(c.id)!;
    upsertCandidate(c.id, {
      suggestionType: "open_commitment",
      title: `Reach out to ${contactDisplayName(c)}`,
      description: `You noted "${signal.oldestOpenText}" ${signal.oldestOpenAgeDays} day${signal.oldestOpenAgeDays === 1 ? "" : "s"} ago — still open`,
      relatedContactIds: [c.id],
      confidenceScore: 82,
    });
  }

  const closedTheLoop = all.filter(
    (c) => isDiscoveryEligible(c) && signals.get(c.id)?.recentCompletionAgeDays !== undefined
  );
  for (const c of closedTheLoop) {
    const signal = signals.get(c.id)!;
    upsertCandidate(c.id, {
      suggestionType: "closed_the_loop",
      title: `Reach out to ${contactDisplayName(c)}`,
      description: `You finished "${signal.recentCompletionText}" ${signal.recentCompletionAgeDays} day${signal.recentCompletionAgeDays === 1 ? "" : "s"} ago — good moment to follow up`,
      relatedContactIds: [c.id],
      confidenceScore: 88,
    });
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx tsx scripts/smoke-followup-cadence-suggestions.ts`
Expected: all `check(...)` lines print `ok`, exit code 0.

Also run, as a full regression pass:
- `npx tsx scripts/smoke-action-item-signals.ts`
- `npx tsx scripts/smoke-followup-cadence-scoring.ts`
- `npx tsc --noEmit`
- `npx eslint src/lib/reminders.ts scripts/smoke-followup-cadence-suggestions.ts`
- `npm run db:check`
- `npx next build`

All must be clean before committing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reminders.ts scripts/smoke-followup-cadence-suggestions.ts
git commit -m "feat(reminders): surface open-commitment and closed-the-loop suggestions"
```
