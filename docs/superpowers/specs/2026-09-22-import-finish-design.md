# The import finish — design

**Status:** design approved in conversation, Sep 22 2026. Not built.
**Builds on:** the `/imports` redesign (PR #238) — drop hero, sequential queue, import history + detail sheet.
**Comes from:** an Impeccable critique of `/imports` (27/40), `.impeccable/critique/2026-09-22T02-55-56Z__src-app-clerk-app-main-imports-page-tsx.md`. Its finding: 3,000 connections land and the reward is a toast plus a count line, at the exact moment the person is asking "did that work, and what happened to my people?"

## What it is

When an import finishes, the queue card becomes a **done card**: a canvas swarm of the new people settling into orbit, one honest sentence of arithmetic, one strong next step, and a quiet way to undo. Undo removes the people the import created — but only the ones nobody has touched since.

## Settled decisions

| Question | Decision |
|---|---|
| Where the celebration lives | **In place on `/imports`**, in the card the queue already occupies. Not a takeover, not a new route: the page is where people wait, and one card covers a multi-file run. |
| What the scene shows | **Everyone, as a swarm.** Dots stream in and settle into orbit; the nearest dozen resolve into profile photos. Bounded at ~300 dots however many arrived. |
| What undo removes | **Only people the import created, and only if untouched.** Merged people are left alone. |
| How long it lasts | **The card persists until dismissed** (rebuilt from the import row, so a refresh keeps it). **Undo is offered for 7 days** in the history sheet. |
| Next steps | **One button, the strongest.** Not a trio; no dead links. |

## 1. The done card

Replaces the `phase === "done"` state of `import-queue-card.tsx`.

- **The scene** at the top: ~180px tall on desktop, ~120px on a phone (§2).
- **One sentence** of arithmetic in the display face: "You added 19 people. 6 were already in your orbit." It is built from the same numbers as `summarizeImport`, so the card, the history chips and the People list cannot disagree — the defect fixed in `ca20eeb7` (the engine writes every merged person to both `contactsUpdated` and `duplicatesFound`) must not come back in a third place.
- **One button.** *Meet your 19 new people* → `/contacts?importId=<id>`. When the import created nobody (a calendar file; or everyone was already known) the button is *See what changed* and opens the history detail sheet instead. The button is never rendered pointing at an empty list.
- **A quiet line:** "Imported from Connections.csv · Undo", where Undo opens the same confirmation the history sheet uses (§3).
- **A multi-file run is one card.** Counts sum across steps; a small line names the sources ("From Connections.csv and messages.csv"). If any step didn't finish, the card leads with that step's existing friendly error line instead of celebrating, and the scene is not drawn.
- **Persistence.** Today the done state is client-only and dies on refresh. `/imports` will pass the most recent finished import (id, counts, source label, finished-at) from the server; the card renders from that when the client queue is empty. Dismiss is remembered per import id in `localStorage` (read in a try/catch, absent = show), so dismissal survives a refresh without new server state. A newer import replaces it.
- **Announcement.** The sentence is announced once via a polite live region when the phase becomes done — today only the toast says anything.

## 2. The swarm — `src/components/imports/import-finish-scene.tsx`

One `<canvas>`, one rAF loop, Orbit's teal with gold accents, drawn at device pixel ratio.

- **Motion:** dots enter from the card's edge, settle onto two or three ellipses around a small planet over ~2s, then slow to a drift. The drift never stops entirely, but costs one cheap frame.
- **Faces:** the nearest ~12 dots resolve into profile photos, drawn into the canvas from the avatar URLs the server provides. A person with no photo stays a dot — the common case right after an import, since the avatar backfill runs later.
- **Scale:** `min(people, 300)` dots. 3,000 people is 300 dots and a sentence that says 3,000; 12 people is 12 dots.
- **Cost control:** the loop is stopped when the card leaves the viewport (`IntersectionObserver`) or the tab is hidden (`visibilitychange`), and on unmount.
- **Reduced motion:** the settled frame, painted once, no loop. Decided by `matchMedia` at render, never by a hook that reports the wrong value on its first render ([[orbit-reduced-motion-hook-lag]]).
- **Accessibility:** `aria-hidden` on the canvas; the sentence beneath carries the meaning.
- **Geometry is pure.** Ring radii, dot placement, the dot cap, and the settle easing live in `src/lib/imports/finish-scene-geometry.ts` so a pure smoke can assert them without a DOM.

## 3. Undo

### Whose people
- **Going forward:** when the engine marks a row done it records whether that contact was **created** or **merged**, and for a created one a **fingerprint** — a hash of the identifying fields it wrote (name, company, title, email, LinkedIn URL). Both ride `import_job_rows.payload` (jsonb) — no DDL, `SCHEMA_VERSION` stays 73.
- **For older imports:** fall back to the rule `import-people.ts` already uses — the contact was created at or after the import's `created_at`. Those rows have no fingerprint, so the field test below is skipped for them and the spec's limitation applies.

### Untouched
`contacts.updated_at` is **not** the test, and this is the trap worth naming: `avatar-backfill.ts:231` and `contact-brief.ts:430` both bump `updated_at` on their own system writes, minutes after an import, so that column reads "touched" for nearly every imported person. Orbit also keeps no per-contact edit trail — there is no audit table to consult. So untouched is defined as **no user-authored trace, plus the fields are still what the import wrote**:

- no rows in `contact_tags`
- `contacts.notes` is empty
- no `reminders`
- no `interactions` beyond those carrying this import's own external ids
- not the winner of a later `contact_merges` row
- the fingerprint still matches — the identifying fields hold exactly what the import wrote

**Limitation, stated plainly:** for an import that ran before the fingerprint shipped, a person edited by hand but carrying no tags, notes, reminders or interactions is indistinguishable from an untouched one and would be removed. The confirmation for a pre-fingerprint import says which people it cannot vouch for, and offers the same 7-day window with that caveat visible.

### What it does
- Deletes the untouched created people via `deleteContactForUser` (`src/lib/contact-delete.ts`), which already handles the non-cascading references and the stored photos.
- Never touches merged people, and never reverses field changes on them — the old values are not stored. The confirmation says so.
- Is idempotent: a second undo removes nothing and reports that.

### What the person sees
- Confirmation counts first and names the exceptions: "Remove 17 people? 2 of the 19 have notes or tags now, so they'll stay."
- Offered in the done card and, for 7 days, in the history detail sheet. After that the sheet says the window has closed.
- Recorded as an import-level fact in `imports.stats` (undone-at, how many removed, how many kept), so the history row reads "Undone · 17 people removed" instead of silently changing its numbers.

## 4. Code shape

| File | Status | Responsibility |
|---|---|---|
| `src/lib/imports/finish-scene-geometry.ts` | create | Pure: rings, dot cap, placement, settle easing |
| `src/components/imports/import-finish-scene.tsx` | create | The canvas, its loop and its lifecycle |
| `src/lib/imports/import-finish.ts` | create | Pure: the sentence, the button's label and target, the multi-file summary |
| `src/lib/imports/import-undo.ts` | create | Candidates, the untouched rule, the preview, the removal (userId-scoped, no auth) |
| `src/actions/imports.ts` | modify | `previewImportUndo`, `undoImport`, and the finished-import summary the page passes down (async exports only) |
| `src/components/imports/import-queue-card.tsx` | modify | The done state becomes the done card |
| `src/components/imports/import-history.tsx` | modify | Undo in the detail sheet; "Undone" on the row |
| `src/app/(clerk)/(app)/(main)/imports/page.tsx` | modify | Pass the most recent finished import |
| `src/app/(clerk)/(app)/(main)/contacts/page.tsx` | modify | `importId` param, filtered through the People-list query |
| `src/lib/import-engine.ts` | modify | Record created-or-merged, and a fingerprint of the fields written, per row |

## 5. Testing

- **Pure:** scene geometry and the dot cap; the sentence and button for each case (new people, nobody new, several files, a step that didn't finish); the undo decision table; the fingerprint (same fields → same hash, a changed name → a different one).
- **PGlite:** untouched people are removed; a tagged person, a person with notes, a person with a later interaction and a merged person and a person whose name was edited all survive; a second undo is a no-op; another user's import is untouchable; an import whose rows predate the provenance stamp still resolves through the fallback, with its caveat surfaced.
- **Live:** desktop and phone width, reduced motion, and the card surviving a refresh.
- **Voice:** every new string through `smoke-toast-copy`.

## 6. Rollout

Lands on `claude/imports-page-redesign-decdb0` (PR #238), which must merge `origin/main` first: the orbit scene it borrows from (`chat-orbit.tsx`, its geometry module and the `.chat-orbit-*` CSS) arrived on main after this branch was cut, and main has moved on by ~11 commits. The Drive branch (PR #247) merges it afterwards, as it did the count and tab-order fixes.

## Out of scope

No undo for merged people's field changes; no sound; no re-import button in history; no swarm on history rows; no "waiting on LinkedIn" state, coverage checklist or stale-import nudge (also from the critique, deliberately separate work).
