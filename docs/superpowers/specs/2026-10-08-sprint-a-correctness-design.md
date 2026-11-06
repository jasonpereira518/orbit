# Sprint A — correctness fixes from the Oct 8 audit

**Date:** 2026-10-08 · **Source:** `docs/audits/2026-10-08-app-e2e-audit.md` §1, §3, §4, §8 · **Base:** `main` @ `ea6ea73a`

## Goal

Fix every defect in the audit's Sprint A list that silently loses or corrupts a person's data, lets an unreleased surface act, or blocks a core screen. No new features. Each fix is the smallest change at the shared function every caller routes through, with a smoke check that fails before and passes after.

Every item below was re-verified against the code on Oct 8 by a dedicated read-only trace; where the trace refined the audit's proposed fix, the refinement is what this spec adopts.

## Scope

| ID | Defect | Decision |
|----|--------|----------|
| R1 | Marking a contact's follow-up reminder done leaves the contact "due" on the dashboard, the bell and `/contacts?followUp=due`. | `completeReminder` clears the contact's clock when the reminder **is** the follow-up: same contact, same due instant. The completion snapshot records the old clock so Undo restores it, but only while the clock is still cleared. No "only pending reminder" fallback. |
| R2 | A day preset books a `manual` reminder and the contact clock at the same instant; once due the bell and dashboard list the person twice and the badge double-counts. | Dedupe treats a reminder as the follow-up when it is `generated` **or** (same instant **and** title is exactly `Follow up with <preferredName‖fullName>`). A hand-written reminder that shares the instant stays listed. |
| R3 | The bell's "Mark done" on a follow-up row closes every pending reminder for the contact in one click with no way back. | Keep the behaviour (it is pinned by `smoke-follow-up-actions`), add **Undo**: `clearContactFollowUpForUser` returns a snapshot (old clock + each completion); a new undo action restores both behind their own staleness guards. |
| R8a | The contact page's date picker renames a hand-written reminder to "Follow up with …" and resets its type. | `scheduleContactFollowUpAt` changes only `dueDate` and `listId` on an existing reminder, matching `scheduleContactFollowUpForUser`. |
| C1 | In the interaction sheet, stepping Newer/Older while editing saves interaction A's fields onto B. | `editing` becomes derived from `editingId === interactionId`; Save writes only to `editingId`; chevrons disabled while editing. |
| C2 | Saving a note into an existing contact overwrites a hand-set closeness with the model's guess (profile log sheet, Drive import, untouched capture card, bulk notes panel). | New optional `closenessChosen` flag, set only when a person touches a closeness control. The merge branch writes `relationshipScore` only when it is true. Creates are unchanged. |
| E1 | Radar, Events and Outreach server actions run while their pages are "coming soon". | Add `requireReleasedSurface` (body identical to commit `bb7e79a3a` on the leads stack, so the branches merge) and `requireUserForReleasedSurface`; use them in `actions/radar.ts`, `actions/events.ts` (incl. four `requireSyncUser` connect actions) and `requireOutreachUser`. `requireVisibleSurface` is **not** changed globally: Capture, Knowledge and Chat use it and must keep working if an operator flags them. |
| E2 | Outreach bulk send re-sends delivered messages; Copy/Open walks a sent message back to "copied". | Server refuses a single send of a delivered message with `UserFacingError(ALREADY_SENT_MESSAGE)`, bulk send skips delivered silently, `markMessageAction` no-ops on delivered. Client `bulkRows` uses `isDeliveredMessage`. "Delivered" = existing `isDeliveredMessage` (sent/opened, any outcome, or `sentAt`). |
| I1 | A drop while the import queue is previewing or running replaces it, and the running loop imports the new drop unasked. | `acceptsNewDrop(phase)` is false for `previewing` and `running`; checked synchronously at the top of `stageDrop` and in `handleFiles`; dropzone disabled. `review`, `idle`, `done` stay replaceable (re-dropping is the only way out of review). Window drop/paste hooks are not disabled (they also carry LinkedIn-link text). No id nonce. |
| I3 | "Clear key" can delete the whole search index in one click. | Two-step `ClearKeyButton` using `useConfirmFocus`; the confirm line says search will re-index when `clearMovesEmbeddings` predicts a backend change. The prediction is the same function the action uses. |
| I7 | Social links are stored exactly as typed and rendered as links. | `normalizeSocialLinks` stores https links or returns `{ok:false,error}` naming the field; `safeProfileUrl` (http(s), no credentials, dotted host) also guards render for values stored before. |
| K1 | An edited reminder title in the capture summary is dropped at save. | Optional `title` override, trimmed, capped at 200, through `choicesFromSuggestions` → stored choices → runner. Reload shows the edit. |
| K2 | A failed extraction leaves an empty box after reload; Dismiss deletes the notes. | `prefillJobFor` refills the box from a failed job with no result; "Try again" re-queues the same row with the text; Dismiss on an extraction failure discards the job but keeps the notes. Save failures unchanged. |
| H1/H2/H5 | Switching or deleting a chat mid-stream drops or misplaces the answer; Stop leaves an unanswered question persisted. | `disabled={busy}` on every history row (active included), phone history item and delete control; `removeThread` aborts first when deleting the open thread; `onDone` sets the header title only for the open thread but always updates the history list; the route discards the unanswered question before the client-gone return. |
| U1 | From `md` to ~1500px the floating bell/feedback rail covers right-aligned header actions. | App-shell content padding reserves `max(5rem, 2.5rem + rail gutter)` from `md`. Remove the now-redundant per-page opt-ins. |
| U2 | Phone contact rows truncate names to a few characters. | Below `md`, hide the row's LinkedIn / follow-up / delete buttons (CSS only); they remain on the contact page. |

## Out of scope

Everything else in the audit: R4–R7, R9–R10, C3–C13, the remaining K/H/I/E items, onboarding order, no-key experience, audience features, integrations. Also: `reopenDoneReminderAction` (Done view reopen) will not restore a clock cleared by R1. That matches today's behaviour after `clearContactFollowUp` and is noted, not fixed.

## Constraints

- Tests are `scripts/smoke-*.ts`, run by `npx tsx`; every new script is registered in `scripts/run-smoke.ts` `MANIFEST`; database scripts start with `import "./smoke/_env";`; pure scripts never import `../src/db`.
- `scripts/smoke-provider-exhaustive.ts` allowlists `src/actions/settings.ts:121/123/125/277/279/281` and `src/components/settings/ai-settings.tsx:289` by line number. No edit may shift those lines except where the plan says to update the allowlist.
- No class names in code comments (Tailwind compiles them).
- Server Action failures shown to users go through `UserFacingError` or a returned `{ok:false,error}`; thrown plain errors are digested in production.
- Copy follows house voice: no trailing period, curly apostrophes, at most one em dash.
- No schema change and no `SCHEMA_VERSION` bump: every new field lives in existing jsonb or is derived.

## Behaviour changes users will notice

- In the demo workspace, marking "Send Sarah the retrieval write-up" done also clears Sarah's follow-up, because the seed books both at the same instant.
- While Events is coming soon, the contact page's "Events together" card disappears (its action now refuses).
- Logging a note from a profile no longer changes the contact's closeness.
- From `md` up to ~1500px wide, every app page is 40px narrower on the right.
- Phones lose per-row follow-up, LinkedIn and delete buttons in the contacts list.

## Acceptance

`npm test` (smoke suite, `--ci`), `npx tsx scripts/run-smoke.ts --check`, `npx tsc --noEmit` and `npx eslint` all pass. A headless Chrome check at 1440×900 and 390×844 shows no overlap between the bell/feedback rail and header actions on `/contacts`, `/contacts?sort=closeness`, `/recruiters` and `/outreach`, and contact names at least 150px wide on phone.
