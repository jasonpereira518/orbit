# Codebase cleanup log, 2026-10-09

Branch `chore/codebase-cleanup-2026-10-09`, cut from main `32f4eea3`. No behavior changes, no DB/schema/migration touches. **Not merged; waiting on Jason.** This file may be deleted before merge.

## 1. Before / after

| | Before | After |
|---|---|---|
| Tracked files | 2594 | 2593 |
| Lines (`git ls-files` content) | 651,195 | 649,449 |
| Source deleted | | 78 lines in 7 files + 1 PNG (664 KB) |
| Dependencies (deps / dev) | 41 / 17 | 41 / 17 (none removed, see §6) |
| Build time | 89 s | 35 s (warm cache; not comparable) |

## 2. Baseline vs final

| Check | Baseline (main) | Final | |
|---|---|---|---|
| `npm run typecheck` | pass | pass | same |
| `npm run lint` | 0 errors, 50 warnings | 0 errors, 50 warnings | same (all pre-existing) |
| `npm run build` | pass | pass | same |
| `npm test` (smoke, 503 suites) | pass | pass | same |
| `npx playwright test` | 10 passed, 2 skipped | 10 passed, 2 skipped | same |

No pre-existing failures on main. The only non-green thing is the **backup workflow** (§7).

## 3. Deleted

| Path | Why safe | Verified by | Commit |
|---|---|---|---|
| `docs/screenshots/landing.png` | Not referenced by README (which lists dashboard, capture, graph, chat), any doc, or code | `git grep -F landing.png`, basename + path | `456f9e4d` |
| `sameTarget` in `src/components/reminders/reminder-rail.tsx` | Exported helper, zero references anywhere, not used in-file | knip + `git grep -w` (0 hits outside definition) | `19071721` |
| `skyBitmapWorkerAvailable` in `src/components/graph/sky-bitmap-client.ts` | same | same | `19071721` |
| `NotesLibraryUploadFallback` (+ now-unused `Skeleton` import) in `src/components/capture/notes-library-upload.tsx` | same | same | `19071721` |
| `pendingBatchJobsFor` in `src/lib/ai-batch.ts` | same | same | `19071721` |
| `listContactOpportunities` (+ unused import) in `src/actions/opportunities.ts` | same; server action nothing calls | same | `19071721` |
| `SuggestionPills` in `src/components/chat/suggestion-cards.tsx` | same | same | `19071721` |
| `ScanChip` (+ unused `ScanLine` import) in `src/components/scan/scan-controls.tsx` | same | same | `19071721` |

None of these files is owned by an open PR (checked against `gh pr diff --name-only` for all 50 open PRs).

## 4. Needs your call (left alone)

| Path | Why I hesitated | Recommendation | Owner |
|---|---|---|---|
| `src/actions/apple.ts` | No UI caller, but `smoke-apple-actions.ts` and `smoke-action-user-scope.ts` parse it by path; iCloud calendar feature | Keep, or delete file + both smokes together | none |
| `src/actions/openrouter.ts` | No caller; `/api/openrouter/callback` and UI still reference OpenRouter | Ask: is the one-click connect abandoned? | none |
| `src/components/imports/import-revert-button.tsx` | Orphaned; the server side (`revertImportAction`, `import-revert.ts`) is live | Wire up or delete; `actions/imports.ts` is owned by an open PR | open PR |
| `src/components/layout/route-progress.tsx` | Component unmounted; `lib/route-progress.ts`, CSS and a smoke still exist | Delete all four together if abandoned | none |
| `src/components/ui/relative-time.tsx` | Unused; hydration-safe fix with a long comment. Admin uses a different `admin/relative-time.tsx` | Keep as a reference or delete | none |
| `src/lib/outreach-readiness-server.ts`, `components/outreach/outreach-readiness-strip.tsx` | Outreach, gated | Keep | #183 / #186 |
| `src/app/bench/**` (5 files) | Only built when `ORBIT_BENCH=1` (knip can't see) | Keep | none |
| `linkedom` (devDep) | Not imported by root app; added for extension LinkedIn fixtures. `package.json` is touched by many open PRs | Ask #251 owner | #251 |
| About 34 unreferenced exports (e.g. `MAX_IMPORT_PAYLOAD_BYTES`, `scatterFieldFactor`, `getSyncProgress`, `loadLastRun`, `DUE_BUCKETS`, `isRecruiterStage`, `FEED_STALE_DAYS`, `MATCHED_FIELD_LABELS`, `setScanWindowMonths`, `saveMeetingDetails`, `listAgentDrafts`) | Zero references but several carry design notes, sit in gated/billing/events/MCP domains, or were merged days ago | Delete in a follow-up if you want them gone | none |
| ~60 unreferenced exported types; ~100 exports in files owned by open PRs (`db/schema.ts` relations/types, `plans/plan-config.ts`, `connectors/connections.ts`, etc.) | Harmless; owned files not edited | Leave | various |
| One-off ops scripts with no references: `scripts/backfill-billing-events.ts`, `reprice-usage.ts`, `report-pricing-v2-accounts.ts`, `migrate-provider-and-upgrade-events.ts`, `optimize-landing-assets.ts`, `generate-waitlist-starfield.ts`, `seed-admin-demo.ts`, `seed-constellation-preview.ts`, `seed-timeline-fixture.ts`, `dev-seed-capture-job.ts`, `dev/scan-waitlist-leaks.mjs`, `dev/seed-agent-draft.ts` | Manual tools, documented in their headers. `migrate-provider-and-upgrade-events.ts` looks superseded by the migration gate | Keep; consider archiving the migrate one | none |
| `docs/orbit_networking_tracker_spec.md` | Original spec, likely outdated | Archive or keep | none |
| Merged-but-undeleted remote branches (97), local merged (198) | Report only, as instructed | Prune when ready | n/a |

## 5. Kept despite looking unused

| Path | Reason |
|---|---|
| `public/landing/planets/*`, `public/waitlist/tour/*` | Built from name lists (`tier-art.tsx`, `hero-solar-system.tsx`); used by waitlist, invite emails |
| `tw-animate-css`, `shadcn`, `tailwindcss` (knip said unused) | `@import`ed in `src/app/globals.css` |
| `@clerk/shared` (knip said unused) | `next.config.ts` aliases its subpaths for Turbopack |
| `public/favicon.png` = `orbit-logo.png` = `waitlist/logo.png`; `(marketing)` vs `(site)` layout/error/loading duplicates | Referenced separately; (site) is the Clerk-free tree on purpose |
| All of `drizzle/`, schema, `.github/workflows/*`, legal/security docs, extension, Events/Outreach/Leads/teams/HubSpot, stealth + waitlist, API/webhook/cron routes, MCP | Protected |

## 6. Dependencies removed

None. Every knip hit was a false positive or blocked: `tw-animate-css`, `shadcn`, `tailwindcss`, `@clerk/shared` are used (§5); `linkedom` is in §4 because `package.json` and the lockfile are owned by most open PRs.

## 7. Noticed, not acted on

- **`backup` workflow is failing daily** (Oct 7, 8 and 9 runs all red). The log shows `SLACK_OPS_CRITICAL_WEBHOOK_URL` is empty (the alert step skips), but I did not find the root failure.
- No `console.log`, `debugger`, TODO/FIXME or commented-out code found in `src/`; all `.env.example` vars are read somewhere.
- `extension/.env.production` holds a `pk_live_` Clerk key. It is a publishable key, documented as intentional.
- knip needs a custom config to run here (`drizzle.config.ts` fails to load because it imports an `@/` alias), so there is no committed knip setup.

## 8. Revert

In order: `456f9e4d`, `19071721` (`git revert 19071721 456f9e4d`). The log commit is last.
