# Branch review — 19 Aug 2026

Baseline: **`origin/main` @ `284bf87`** — *"Apply the load timeout to feed mutations"* (PR #25, 18 Aug).

> **Read this first.** Your local `main` is **15 commits behind** `origin/main`, so "unmerged" measured against it is misleading — several branches look like they carry work that has in fact already shipped. Everything below is measured against `origin/main`, and each branch is split into **shipped** (file already byte-identical to main), **modified**, and **new**. Only the last two columns are review surface.
>
> Run `git checkout main && git pull` before doing anything else.

## Summary

| Branch | Ahead | Shipped | Modified | New | Verdict |
|---|---|---|---|---|---|
| `chrome-extension` | 49 | 100 | 18 | 84 | **Review — the main event** |
| `optimize/perf-ux-audit` | 34 | 101 | 10 | 7 | Review 17 files — rest already shipped |
| `claude/onboarding-process-improvement-24acae` | 2 | 23 | 11 | 0 | Review 11 files |
| `claude/connection-upload-performance-e7a9b9` | 3 | 8 | 16 | 0 | Review 16 files |
| `cursor/refine-onboarding-flow-52af` | 1 | 0 | 17 | 2 | Review — open draft PR #6 |
| `claude/marketing-landing-redesign-5e3273` | 24 | 4 | 9 | 4 | Review one of the pair |
| `claude/marketing-landing-page-sections-997bf9` | 20 | 4 | 9 | 4 | Near-duplicate of the above |
| `cursor/capture-review-swipe-ui-246b` | 5 | 0 | 2 | 3 | Review — open draft PR #8 |
| `claude/readme-revision-planning-860942` | 2 | 1 | 6 | 0 | Review — docs only |
| `claude/duplicate-onboarding-step-column-8b1e49` | 1 | 0 | 1 | 0 | Review — 1 file |
| `claude/job-bar-position` | 1 | 2 | 0 | 0 | **Fully shipped — delete** |
| `feat/chrome-extension` | 38 | — | 0 | 0 | **Fully merged — delete** |

Sixteen further branches are entirely contained in `origin/main` and can be deleted (listed at the bottom).

---

## 1. `chrome-extension` — browser extension + extension API
**49 commits · 84 new files · 18 modified · not on GitHub as a PR**

The largest and only substantially unreviewed body of work. Neither `src/app/api/extension/` nor `extension/` exists in `main`.

**Server-side (Next app)**
- `contact-writes.ts` — contact write paths extracted to take `userId` explicitly *(note: this one file already shipped to main via `feat/chrome-extension`)*
- Schema: `contacts.x_handle`, LinkedIn/X resolve indexes, `extension_usage` rate-limit table, plus a 0.97-confidence "Same X handle" dedupe tier
- Six endpoints under `/api/extension/`: `me`, `resolve`, `parse`, `starters`, `contacts` (create/merge + keyword search), `interactions`, `follow-ups`
- Wire contract split into types-only + zod schemas, with compile-time drift guards
- Auth seam (`requireExtensionUserId`) isolating Clerk from every route
- Conversation starters: deterministic heuristic ladder first, AI layer second, degrading to heuristics on every failure
- `parse-profile.ts` — reads page text into contact fields with a model

**Extension (`extension/`, its own Vite project)**
- Chrome side panel (MV3), replacing an earlier popup
- Four site adapters — LinkedIn (deep), X, Gmail, generic — plus URL canonicalisation kept byte-identical to `src/lib/duplicates.ts`
- Capture flow: editable record with per-field provenance and confidence
- Known-contact view: profile-diff ledger, open loops, knowledge chips, starters
- Runtime site-permission flow, tab-following with an unsaved-work guard
- `dev/preview.html` design harness rendering every state against fixtures

**Review focus:** the permission model (`activeTab` does not survive the move to a side panel — the panel asks for host access at runtime instead), and the Chrome Web Store surface (`manifest.config.ts`).

**Caveat:** this branch descends from `optimize/perf-ux-audit`, so it also carries that branch's landing/perf work. Reviewing it covers `optimize/perf-ux-audit` entirely.

## 2. `optimize/perf-ux-audit` — perf/UX audit + landing narrative
**34 commits · but 101 of 118 files already identical to main**

Most of this shipped via PRs #19 and #22. **Only 17 files still carry unshipped changes:**

```
NEW       src/actions/stats.ts
NEW       src/app/(marketing)/template.tsx
NEW       src/components/landing/{landing-features,landing-footer,landing-proof,landing-waitlist}.tsx
NEW       src/components/layout/page-transition.tsx
modified  src/actions/contacts.ts, src/actions/reminders.ts
modified  src/app/(app)/(main)/reminders/page.tsx
modified  src/components/chat/bulk-notes-panel.tsx
modified  src/components/imports/import-hub.tsx
modified  src/components/reminders/reminders-header.tsx
modified  src/db/index.ts, src/db/schema.ts, src/proxy.ts
.env.example
```

Themes across the branch: View Transitions for route navigation, streamed dashboard/contact/reminders with staged reveals, motion tokens and reduced-motion consolidation, contact-row FLIP + `content-visibility` virtualization, avatar storage moved from inline base64 to Vercel Blob, a persistent background-job status bar, and the scroll-scrubbed landing narrative (starfield, comet, constellation, clusters).

**Recommendation:** don't review this separately — it is contained in `chrome-extension`. Verify the 17 files there instead.

## 3. `claude/onboarding-process-improvement-24acae`
**2 commits · 11 modified files (23 already shipped)**

Guided setup wizard (`src/components/onboarding/wizard/`), hardened imports, and Google/Outlook contacts import. Touches `src/actions`, `src/db`, `src/components/imports`.

## 4. `claude/connection-upload-performance-e7a9b9`
**3 commits · 16 modified files**

Speeds up large LinkedIn imports and adds persistent background-job progress UI; also fixes the cron schedule for the Vercel Hobby plan (`vercel.json`). Overlaps the job status bar on `optimize/perf-ux-audit` — check for conflict before merging both.

## 5. `cursor/refine-onboarding-flow-52af` — open draft PR #6
**1 commit · 17 modified, 2 new · 31 commits behind main**

Refreshes the onboarding tour to match current product UI (`src/components/onboarding/previews/`). Very stale — the app has changed a lot since 24 Jul; may be easier to redo than to rebase.

## 6–7. The two landing-redesign branches
`claude/marketing-landing-redesign-5e3273` (24 commits) and `claude/marketing-landing-page-sections-997bf9` (20 commits) are **near-identical** — same 17 files, 2488 vs 2481 insertions. `5e3273` has four extra commits which add a scroll-lock hero experiment and then revert it.

Contents: hi-fi landing design tokens, upgraded starfield, per-card feature visuals, scroll-rotating orbit map, founder-note social proof, Clerk-backed waitlist replacing the pricing CTA, and Terms/Contact stub pages.

**Review `5e3273` only, and delete the other.** Both are 20 commits behind main and largely superseded by the landing work already in `main` — confirm before spending time.

## 8. `cursor/capture-review-swipe-ui-246b` — open draft PR #8
**5 commits · 3 new, 2 modified · 30 commits behind main**

Swipeable capture review cards with parse progress, check/trash stamps on swipe, capture-paste draft persisted across sessions, and capture parsing tuned for day→person→conversation notes.

## 9. `claude/readme-revision-planning-860942`
**2 commits · 6 modified files** — README rewrite with screenshots and full feature list, MIT `LICENSE`, light-mode screenshots. Docs only, low risk.

## 10. `claude/duplicate-onboarding-step-column-8b1e49`
**1 commit · 1 file** (`src/db/index.ts`) — fixes a race causing a duplicate `onboarding_step` column error. A variant of this shipped as PR #17; confirm whether this version is still needed.

---

## Safe to delete

**Fully merged, zero unique content:**
`feat/chrome-extension` · `claude/job-bar-position`

**Entirely contained in `origin/main`:**
`claude/app-improvements-609991` · `claude/backend-audit-plan-50987a` · `claude/dead-code-removal-527653` · `claude/marketing-landing-page-copy-305186` · `claude/marketing-landing-redesign-79068f` · `claude/onboarding-workflow-revision-b05099` · `claude/orbit-ui-animations-d2ebad` · `claude/privacy-contacts-page-revision-9b5b7b` · `claude/project-overview-f3adb5` · `claude/repository-overview-c3eca9` · `claude/unmerged-branches-review-0276a0` · `cursor/capture-capability-upgrade-246b` · `cursor/cloud-agent-1784561905384-6p4vt` · `deploy/orbit-production` · `revisions`

```sh
# after confirming, from the repo root
git branch -d feat/chrome-extension claude/job-bar-position \
  claude/app-improvements-609991 claude/backend-audit-plan-50987a \
  claude/dead-code-removal-527653 claude/marketing-landing-page-copy-305186 \
  claude/marketing-landing-redesign-79068f claude/onboarding-workflow-revision-b05099 \
  claude/orbit-ui-animations-d2ebad claude/privacy-contacts-page-revision-9b5b7b \
  claude/project-overview-f3adb5 claude/repository-overview-c3eca9 \
  claude/unmerged-branches-review-0276a0 cursor/capture-capability-upgrade-246b \
  cursor/cloud-agent-1784561905384-6p4vt deploy/orbit-production revisions
```

Several of these back git worktrees under `.claude/worktrees/`; run `git worktree list` and `git worktree remove` first, or `git branch -d` will refuse.

## Suggested order

1. `git checkout main && git pull` — your local `main` is 15 commits stale.
2. **`chrome-extension`** — the only large unreviewed body of work; also clears `optimize/perf-ux-audit`.
3. `claude/onboarding-process-improvement-24acae` and `claude/connection-upload-performance-e7a9b9` — real features, small review surface, but check them against each other for job-UI conflicts.
4. Decide on the two landing branches (keep `5e3273`, delete the twin).
5. Close or refresh the two stale draft PRs (#6, #8) — both are 30+ commits behind.
6. Delete the 17 dead branches.

---
*Generated 19 Aug 2026 against `origin/main` @ `284bf87`. "Shipped" = file byte-identical to main; only "modified" and "new" need reading.*
