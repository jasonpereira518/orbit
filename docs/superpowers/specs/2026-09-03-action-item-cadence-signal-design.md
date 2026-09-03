# Smarter follow-up cadence: action-item completion as a signal

Branch: `claude/follow-up-cadence-signals-e91a2c`, forked from `claude/mention-review-chat-grounding-b47ed0` tip (`0fb25c8`), which is itself stacked on `claude/note-processing-overhaul-805833` ([PR #107](https://github.com/jasonpereira518/orbit/pull/107), open). This fork point is required, not incidental: `action_items.status`/`completedAt` — the field this whole feature reads — was introduced by the note-processing overhaul and does not exist on `origin/main` yet.

## Problem

Orbit decides "does this contact need a follow-up" two ways today, and neither reads whether the user actually did what they said they'd do:

- **`followUpCandidateScore`** (`src/lib/reminders.ts:228-242`) ranks contacts for the manual "Generate follow-ups" dashboard button, from `priorityLevel`, `relationshipScore`, and idle days only.
- **`buildOutreachSuggestions`** (`src/lib/reminders.ts:90-226`) generates passive dashboard suggestions for contacts with no `nextFollowUpAt` set, using three idle-time heuristics (`dormant_high_value`, `linkedin_thread_quiet`, `post_event`).

Meanwhile `action_items` (`src/db/schema.ts:695-715`) already tracks per-contact commitments with a real `status`/`completedAt`, populated from note capture (`src/lib/note-batch-save.ts`) and edited via `setActionItemStatus` (`src/actions/action-items.ts`). Nothing reads that status for cadence. A contact who was promised something two weeks ago and it's still sitting open looks identical, cadence-wise, to one where nothing was ever promised. And finishing a commitment ("sent the intro") produces no nudge to circle back and report the outcome — even though that is often the single best moment to reach out.

## Decisions taken

| Question | Decision |
|---|---|
| Which cadence path gets the new signal? | Both — `followUpCandidateScore` and `buildOutreachSuggestions`, via one shared batched-signal function and shared thresholds, not two independently-invented heuristics. |
| How do open (incomplete) action items affect cadence? | They raise urgency, growing with age — not gated behind a single staleness cliff. A brand-new open item contributes a small baseline; a two-week-old one contributes more. |
| Does completing an action item trigger anything on its own? | Yes — a recent completion (within a window) is a "close the loop" signal, boosting cadence independently of the open-item aging signal. |
| Where do the new thresholds/constants live? | A new file, `src/lib/action-item-signals.ts`, so both call sites import the same numbers instead of drifting apart. |
| Any schema changes? | None. Reads only `action_items.status`/`completedAt`/`createdAt`/`text`, all of which already exist. |
| Self-silencing mechanism (avoid nagging forever)? | No new state. The close-loop boost only counts a completion that happened *after* the contact's current `lastInteractionAt` — once the user actually logs the follow-up interaction, `lastInteractionAt` moves past `completedAt` and the boost turns off on its own. The open-commitment discovery reason stops firing the moment `nextFollowUpAt` gets set on the contact (generate/snooze/note-capture all do this already), since it only applies to the no-`nextFollowUpAt` discovery population. |

## Design

### New file: `src/lib/action-item-signals.ts`

```ts
export const OPEN_ITEM_ELIGIBLE_DAYS = 14;   // an open item this old is eligible to surface a discovery suggestion
export const CLOSE_LOOP_WINDOW_DAYS = 10;    // a completion this recent still counts as "circle back"
export const CLOSE_LOOP_SCORE_BOOST = 3;     // calibrated to match ~90 idle days (90/30) in followUpCandidateScore

export type ActionItemSignal = {
  openCount: number;
  oldestOpenText: string;
  oldestOpenAgeDays: number;
  recentCompletionText?: string;
  recentCompletionAgeDays?: number;
};

export async function getActionItemSignalsBatch(
  userId: string,
  contactIds: string[],
): Promise<Map<string, ActionItemSignal>>
```

Two queries total, regardless of `contactIds.length`, following the exact batching shape `listContactMentionsBatch` (`src/lib/contact-mentions.ts`) already established in this codebase:

1. **Open items**: `SELECT contactId, text, createdAt FROM action_items WHERE userId = ? AND status = 'open' AND contactId IN (...)`, ordered by `createdAt asc`. In-memory: first row per `contactId` seeds `oldestOpenText`/`oldestOpenAgeDays` (`daysAgo(createdAt)`); every row for that `contactId` increments `openCount`.
2. **Recent completions**: `SELECT contactId, text, completedAt, <the contact's current lastInteractionAt> FROM action_items JOIN contacts ... WHERE userId = ? AND status = 'done' AND completedAt >= now() - interval '30 days' AND contactId IN (...)`, ordered by `completedAt desc`. In-memory: first row per `contactId` where `completedAt > contact.lastInteractionAt` seeds `recentCompletionText`/`recentCompletionAgeDays` — rows whose completion is *older* than the contact's last logged interaction are skipped (the loop already got closed by that interaction). The 30-day window bounds the query; `CLOSE_LOOP_WINDOW_DAYS` (10) further narrows what actually contributes a signal, giving margin between "queried" and "counts."

A contact absent from both result sets is simply absent from the returned Map (never present with a zero-value entry) — same "absent or empty, never throws" convention as `listContactMentionsBatch`.

### Integration point 1 — `followUpCandidateScore` / `generateDueFollowUps`

`src/lib/reminders.ts:228-242, 248-333`. `generateDueFollowUps` currently fetches its candidate contact list, then scores each with a signal-free pure function. It now also batch-fetches `getActionItemSignalsBatch(userId, candidateContactIds)` once before scoring, and threads the per-contact signal into both the eligibility filter and the score:

**Eligibility filter** (lines 261-279) gains one more OR-branch, so a contact can qualify purely on this new signal even when idle time/priority/relationship score wouldn't otherwise select it:
```ts
|| (signal?.openCount && signal.oldestOpenAgeDays >= OPEN_ITEM_ELIGIBLE_DAYS)
|| (signal?.recentCompletionAgeDays !== undefined && signal.recentCompletionAgeDays <= CLOSE_LOOP_WINDOW_DAYS)
```

**Score**:
```ts
function followUpCandidateScore(contact, signal?: ActionItemSignal) {
  const idleDays = Math.min(daysAgo(contact.lastInteractionAt), 365);
  const idleScore = Number.isFinite(idleDays) ? idleDays / 30 : 2;
  const openItemUrgency = signal?.openCount ? 1 + signal.oldestOpenAgeDays / 14 : 0;
  const closeTheLoopBoost = signal?.recentCompletionAgeDays !== undefined
    && signal.recentCompletionAgeDays <= CLOSE_LOOP_WINDOW_DAYS
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
`openItemUrgency`'s `1 + age/14` shape gives every open item a baseline nudge (matching "raises urgency, especially as it ages" rather than a hard cliff), reaching 2.0 at 14 days, 3.0 at 28 days — comparable in magnitude to the idle-time term, never dominating it outright for a single fresh item.

### Integration point 2 — `buildOutreachSuggestions` (passive discovery)

`src/lib/reminders.ts:90-226`, restricted to contacts where `isDiscoveryEligible` (no `nextFollowUpAt`). Batch-fetch the same `getActionItemSignalsBatch` for the discovery-eligible contact set, then two new heuristic branches alongside the existing three:

- **`open_commitment`** — `signal.openCount > 0 && signal.oldestOpenAgeDays >= OPEN_ITEM_ELIGIBLE_DAYS`. Suggestion copy quotes `signal.oldestOpenText`, e.g. "You noted '<text>' N days ago — still open."
- **`closed_the_loop`** — `signal.recentCompletionAgeDays !== undefined && signal.recentCompletionAgeDays <= CLOSE_LOOP_WINDOW_DAYS`. Suggestion copy quotes `signal.recentCompletionText`, e.g. "You finished '<text>' N days ago — good moment to follow up."

These are additive to the existing three heuristics (a contact can match more than one); implementation should confirm during the plan whether `aiSuggestions.reason` is a free-text column or a constrained enum/union type, and extend it accordingly. Existing suggestion-copy rendering (wherever `dormant_high_value` etc. are turned into UI text — to be located during planning) gets two more `case` branches in the same style.

## Error handling / edge cases

- **No open or recent-completion data for a contact**: `getActionItemSignalsBatch` returns the contact absent from the Map; both call sites already default to `undefined`/0-contribution via optional chaining — no crash, no special-casing needed.
- **A contact with both an old open item and a recent completion**: both signals apply independently and add. This is intentional — it's a genuinely more engaged relationship (something got done, something else is still pending), not a contradiction to resolve.
- **Runaway re-suggestion**: covered by the self-silencing design above — no new dismissal/snooze state required. If the final review or implementation finds this insufficient in practice (e.g. a completion logged for a contact whose `lastInteractionAt` never updates because the completion isn't itself tied to an interaction), that's a risk to flag explicitly rather than silently patch — see Risks below.
- **`contactIds` empty**: both query functions return before touching the DB (matching `listContactMentionsBatch`'s existing guard).

## Testing

New `scripts/smoke-action-item-signals.ts`, following repo smoke conventions (dotenv header, fake Clerk keys, `delete process.env.DATABASE_URL`, local throwing `check()`, explicit `process.exit(0)`). Must assert, with real fixture data (not hardcoded no-op checks — this branch's own final review caught exactly that failure mode last time):
- Exactly 2 DB queries regardless of contact count.
- `oldestOpenAgeDays`/`oldestOpenText` pick the truly oldest open item, not just any open item, when a contact has several.
- A completion older than the contact's `lastInteractionAt` is correctly excluded (self-silencing works).
- A completion newer than `lastInteractionAt` and within `CLOSE_LOOP_WINDOW_DAYS` is correctly included; one outside the window is excluded.
- A contact with neither signal is absent from the Map, not present with a zero-valued entry.

Existing `followUpCandidateScore`/`generateDueFollowUps`/`buildOutreachSuggestions` coverage (to be located during planning — confirm whether smoke coverage already exists for `reminders.ts`) gets extended with cases proving: a low-idle/low-priority contact with an old open item now becomes an eligible candidate; a contact whose only qualifying signal is a recent completion also becomes eligible; the two new discovery reasons fire under the right conditions and don't fire when a `nextFollowUpAt` is already set.

## Risks

- **Suggestion-copy plumbing is unconfirmed.** This spec assumes `aiSuggestions` suggestion text is rendered from a `reason`-keyed switch somewhere in the UI layer; the exact file wasn't located during brainstorming (only the generation side, `buildOutreachSuggestions`, was explored). The implementation plan must locate and confirm this before writing the two new `case` branches.
- **Score-magnitude calibration is a judgment call, not a measured constant.** `CLOSE_LOOP_SCORE_BOOST = 3` and the `1 + age/14` open-item shape are chosen to be comparable to the existing idle-time term, not derived from data — flag as tunable, not sacred, if real usage suggests either signal is over- or under-weighted.
- **`generateDueFollowUps`/`buildOutreachSuggestions` may already have non-trivial internal structure** (e.g. batching, pagination, other filters) not fully surfaced during brainstorming exploration — the implementation plan should re-read both functions in full before patching them, not just the line ranges quoted here.

## Repo rules (carried forward from this session's established constraints)

No test framework — smoke scripts only, `npx tsx`, explicit `process.exit(0)`. PGlite is single-writer per worktree — check no other process has this worktree as cwd (`lsof -iTCP -sTCP:LISTEN`, then `lsof -a -p <pid> -d cwd` per PID individually, never in a bash loop) before running any smoke script. Never run `db:push`. `"use server"` files export only async functions. No DDL/schema changes in this feature, so `scripts/schema-ddl.lock.json` must not change — if `db:check` complains, back out whatever touched `schema.ts`/`db/index.ts`. Never use `git stash`. This worktree's `.env.local` has real Clerk keys and a real Neon `DATABASE_URL` — never run a live `next dev` against it; verify via smoke scripts and static tracing only.

## Verification steps (for the eventual implementation plan)

`npm run db:check`; `npx tsc --noEmit`; the new smoke script plus every existing `reminders.ts`-related smoke script; `npx eslint` on every touched file; `npx next build`.
