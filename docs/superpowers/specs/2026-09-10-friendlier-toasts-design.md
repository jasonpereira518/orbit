# Friendlier toasts: errors that say something true, Undo where it's real

**Date:** 2026-09-10
**Status:** Design — phases land as separate commits on this PR
**Predecessor:** PR #145, "Redesign the toast: variant accents, real cursor behaviour, a notification center"

## Problem

Verified against `main` at `c847b8a` before any of it was written.

PR #145 made the toast *legible* — variant accents, cursor behaviour, a notification
center, a 3-line description expander. It did not make it *kind*, and the gap turns out
not to be mainly visual.

- **Errors don't say anything useful in production.** 97 of 153 `toast.error` sites do
  `err instanceof Error ? err.message : "fallback"`. Next.js strips thrown Server Action
  messages in production and substitutes a digest, so `err.message` is *not* the nice
  string — it is `"An error occurred in the Server Components render. The specific
  message is omitted in production builds…"`. In dev the same line leaks the other way:
  `Google Calendar 403: {"error":…`, `Failed to parse AI JSON: {"peo…`,
  `ensureUserSettings: no row for user_2abc…`. The repo already documents this trap in
  three places: `src/actions/imports.ts:92`, `src/actions/feedback.ts:29`,
  `src/actions/api-keys.ts:66`. The fallback string at every one of those 97 sites is
  effectively dead code — non-`Error` throws almost never happen.
- **Rewriting error copy without fixing that changes nothing that ships.** Errors are
  half of all toasts, and the ~69 genuinely useful validation strings in `src/actions/*`
  — `"Title is required"`, `"Cannot delete Inbox"`, `"Connect Gmail before sending."` —
  never reach a production user at all.
- **Almost nothing is recoverable.** 3 of ~300 toasts offer an action. One-click buttons
  in the notifications panel dismiss suggestions and complete reminders with no confirm
  and no way back.

## Goal

A toast that speaks like a person, softens where it is currently harsh, and lets you take
back the things that can be taken back — without ever offering an Undo that quietly
under-restores. Saying "Undone" when it isn't is worse than offering nothing.

**Settled with the user:** warm voice with a light touch of Orbit's own vocabulary; full
sweep of call sites; softer look and motion; more forgiving.

No schema migration is required. Every reversible operation below is a status flip on a
column that already exists.

---

## Phase 1 — Make errors say something true

The prerequisite. Nothing in Phase 4 reaches production users without it.

**New: `friendlyError(err, fallback)` in `src/lib/errors.ts`.** The existing
`toUserFacingError` is the wrong shape to build on — it *preserves* `err.message` whenever
it is non-empty and non-digest, which is exactly the leak. It is also barely used on the
client: 3 of 153 `toast.error` sites. Reuse its digest-detection regexes; invert its
default:

- Recognise the Next digest wrapper → `fallback`.
- Recognise the raw-provider shapes the audit catalogued — `^\w+ \d{3}:`,
  `Failed to parse AI JSON`, `Token (exchange|refresh) failed`, `ensureUserSettings:` →
  `fallback`.
- Recognise the small allowlist of messages that are *deliberately* user-facing —
  `MISSING_AI_API_KEY_MESSAGE`, and the rate-limit / timeout branches already in
  `aiProviderErrorMessage` — and pass those through.
- Otherwise → `fallback`. Never the raw message.

Also cap `aiProviderErrorMessage`'s catch-all, which today returns up to 237 characters of
whatever the provider said.

**Sweep every `err.message` site** to `friendlyError(err, "<good copy>")`. The fallback
stops being dead code and becomes the message, so each needs copy worth reading — which is
where this phase meets Phase 4. They should land per-file together.

**Convert the actions whose validation text is worth showing** to return
`{ ok: false, error }` instead of throwing, following the pattern already in
`src/actions/imports.ts`, `feedback.ts` and `api-keys.ts`. Scope this to form validation
the user can act on — roughly a dozen actions, not all ninety. Everything else keeps
throwing and gets a good client-side fallback.

The full conversion of every action to return-as-data is the correct end state, but it is
a separate and much larger review, and the helper captures nearly all of the
user-visible benefit.

---

## Phase 2 — Recoverability

Undo only where the inverse is real. Seven, in dependency order.

**Free or trivial:**

- **Webhook Retry** — `src/components/settings/webhook-settings.tsx:99` already tells the
  user *"Retry once it is reachable"* and gives them no button, while
  `retryWebhookEndpoint` exists and is already wired for the other path.
- **Move a reminder between lists** — `src/components/reminders/reminder-card.tsx:261`.
  The prior `listId` is on the card.

**Status flips, each needing one small new inverse action:**

- **Discard a suggested reminder** → `restoreSuggestedReminder`. The row is deliberately
  preserved (`status: "discarded"`, `resolvedAt`), so the inverse is one UPDATE. Ship
  first.
- **Dismiss an AI suggestion** → `restoreSuggestion`. Single table, no cascades.
- **Mark a reminder done** → new `reopenReminder`. Must reverse **both**
  `reminders.status` and the `action_items` rows that `completeReminder` closed, or the
  contact profile is left with orphaned completed items. `updateReminder` deliberately
  refuses `status`, so this cannot be folded into it.

**Needs a signature change first:**

- **Snooze** — `snoozeReminderAction` (`src/actions/reminders.ts:714`) wraps
  `snoozeReminder`, which overwrites `dueDate` and mirrors `contacts.nextFollowUpAt` /
  `followUpStatus`, then discards the old values. The action returns nothing at all. Make
  it return `{ previousDueDate, previousFollowUpStatus }`; without that,
  `src/components/reminders/reminder-done-snooze.tsx` cannot reconstruct the prior state.

**Soft-delete the one table that allows it:**

- **Delete a goal** — `user_goals` (`src/db/schema.ts:436`) has no inbound foreign keys
  *and* an unused `active` column. Flip `active` instead of hard-deleting, and Undo
  becomes a flip rather than a re-insert under a new uuid.

### Deliberately not offered

| Operation | Why not |
|---|---|
| `deleteContact` | Hard delete cascading ~12 tables — interactions, briefs, paid embeddings. The confirm dialog's "This cannot be undone" is accurate. |
| `deleteInteraction` | Hard delete, then recomputes `lastInteractionAt`, re-embeds, regenerates the brief. |
| `deleteAllData` | ~30 deletes, and a smoke test asserts nothing survives. The right affordance is a pre-flight "Export first?", not a post-hoc Undo. |
| `deleteChatThread`, `deleteWebhookEndpoint` | Hard deletes; the webhook's receiver already holds a secret bound to a dead id. |
| Outreach sends | The email has left. |
| **`clearContactFollowUp`** | **The trap.** It looks like a status flip, but it completes an unbounded set of the contact's pending reminders and their action items. Since this design was drafted, `main` changed it to return `{ ok: true, remindersClosed }` — a *count*, so the toast can finally say how many it closed. That fixes the honesty problem but not the Undo one: to reopen them you need their *ids*. Revisit only if the action starts returning `closedReminderIds`. |

Where Undo is impossible and the action is destructive, the answer is a confirm step, not a
toast affordance. Most already have one.

**Shared plumbing.** The same try/toast/refresh helper exists three times:
`runAction` in `src/components/notifications/notifications-panel.tsx:133`, `run` in
`src/components/reminders/suggested-reminders-panel.tsx:84`, and a bare pair in
`reminder-done-snooze.tsx`. Extend one shared helper to take an optional `undo` and use it
in all three, rather than three copies of the pattern.

---

## Phase 3 — Softer look and motion

Errors carry the harshest treatment the toast has: full-chroma `--destructive` on the rail,
the icon and the chip at once. Calm that first, and ease everything slightly.

- **Warm the error accent.** A dedicated toast-error accent a step down in chroma from
  `--destructive`, rather than reusing the destructive-button token, so the toast can
  soften without weakening destructive buttons elsewhere. Must keep 4.5:1 on `--popover`
  in both themes.
- **Lighten the chip.** `--toast-chip-strength` is 12% light / 18% dark and reads hottest
  on an error. Give error its own slightly lower value.
- **Settle rather than snap.** Keep the `translateX(2rem)` entrance distance, but move it
  to a gentler decelerating curve. Leave the exit brisk — leaving fast reads as
  responsive; arriving fast reads as urgent.
- **Breathing room.** `p-3` with `gap-3` is tight for a two-line title over a description.
  A small bump, and a touch more space between title and description.
- **Keep:** the rail (it is what makes a collapsed stack readable), the 10-second error
  duration (reading a failure takes longer than reading a confirmation), and the
  reduced-motion behaviour.

All of this lives in the `classNames` in `src/components/ui/sonner.tsx` and the toast block
of `src/app/globals.css`. No new mechanism. New tokens must also be mirrored into the
extension — see *Verification*.

---

## Phase 4 — The voice

Derived from what Orbit already sounds like, not invented. The landing page and onboarding
are warm; admin and legal are flat. **`src/components/error-fallback.tsx` is the existing
error voice** and the template to generalise: *"Orbit hit a snag"*, then a plain sentence
of consequence and next step, with diagnostics demoted to small grey text. The other line
already at the right temperature is `src/actions/feedback.ts`'s *"You've sent a few already
— give it a minute."*

**Rules:**

- Say what happened, then what to do: `"That didn't save — try again?"`, not
  `"Save failed"`.
- Blame the system, never the user.
- Contractions. `"Couldn't"` everywhere — retiring `"Could not X"` (63 uses) and
  `"X failed"` / `"Failed to X"` (37), so one construction survives.
- Name what the user got back where it is cheap: `"Sarah Chen is in your orbit"` beats
  `"Contact created"`.
- Celestial vocabulary on success only — orbit, constellation. **Never on an error.**
- No trailing period on a single-clause toast. `admin/` and `feedback/` currently disagree
  with the rest of the app, split along a directory line rather than a semantic one.
- Curly apostrophes throughout — currently mixed.
- ` — ` as the one outcome/detail connector, retiring the competing `:` and `·`.
- Fix the pluralisation bugs found in passing, e.g. `` `${days} days` `` rendering
  "1 days" at `src/components/follow-up/easy-follow-up.tsx:84`.

**Consolidate the duplicates** into shared constants so one outcome reads one way:
`"Import failed"` ×6, `"OAuth failed"` ×5, `"Copied to clipboard"` ×5, and four different
wordings of a single save failure (`"Save failed"`, `"Failed to save"`, `"Could not
save"`, `"Couldn't save that."`).

Do this file-by-file alongside the Phase 1 fallback sweep — the two edits touch the same
lines.

---

## Non-goals

- **Fewer toasts.** Redundant ones exist — the `Found N people` that fires as the review
  card renders, the two back-to-back from `import-job-watcher` — but reducing interruption
  was explicitly not the chosen direction. Worth a follow-up.
- **The four files importing `toast` straight from `sonner`** (`network-graph`,
  `constellation-pin-button`, `broadcast-composer`, `health-actions`). Still out of scope
  from #145 — though they leak the same way and should at least get `friendlyError`.
- **A user-facing import retry.** `import_job_rows` has the per-row state to make it
  resumable, but exposing that is a feature, not a toast change.

---

## Verification

**Per phase:**

- **Phase 1** — a Node harness in the style of the ones #145 used: `friendlyError` returns
  the fallback for the digest string, for each catalogued provider shape, and for a raw
  `Error`, and passes the allowlisted messages through. Then a grep asserting no
  `toast.error` site still reads `err.message` directly.
- **Phase 2** — per Undo, a smoke round-trip against a temp PGlite: perform, undo, assert
  the row is back in its prior state *and* that dependent rows came with it. The
  `action_items` case in `reopenReminder` is the one that will catch a partial inverse.
- **Phase 3** — measure the computed accent, chip alpha and contrast against `--popover` in
  both themes; confirm 4.5:1 holds.
- **Phase 4** — a lint-style script asserting the copy rules across call sites: no
  `"Could not"`, no `"Failed to"`, no trailing period on a single-clause string, no
  straight apostrophes.

**Traps, all hit during #145:**

- **The extension mirrors the app's tokens.** `extension/scripts/tokens.mjs` copies
  `globals.css`'s token blocks and `check:tokens` fails CI on drift. Any new token in
  Phase 3 needs `npm --prefix extension run tokens:sync`. It mirrors only the **first**
  `:root` block, so a token the extension needs must go there.
- **The Browser pane can report a 0×0 viewport,** which collapses the app's `h-full` chain
  to nothing. Force a size with `resize_window` and check `innerWidth` before concluding
  anything is broken.
- **`viewTransition` is enabled,** so a pane that never paints leaves the page as an inert
  view-transition snapshot with no React handlers attached — clicks silently do nothing.
- **Sonner injects its stylesheet unlayered,** so it beats every Tailwind utility
  regardless of specificity. Anything it declares on the toast element can only be
  overridden from CSS.

Settings' **"Send test notification"** cycles all five variants and is the fastest way to
eyeball Phase 3.

Then `npm run typecheck` and `npm run lint`; the baseline is 0 errors, so any error is ours.

## Landing order

Phases 1 and 4 together, per file, since they edit the same lines. Phase 2 as one commit
per Undo, so each inverse is reviewable on its own. Phase 3 as a single visual commit.
