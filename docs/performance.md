# Performance notes

How Orbit stays fast, what guards it, and how to measure before guessing.

## What is guarded

| Guard | Runs | Catches |
|---|---|---|
| `npm run perf:pages` (`scripts/smoke-page-budgets.ts`) | CI (`npm test`) | The dashboard, graph and notification-panel scans pulling `notes` or base64 avatars again, or their statement counts creeping up. 3,000-contact fixture. |
| `scripts/smoke-write-path.ts` | CI | An embedding-provider call sneaking back onto the request path of a contact save. |
| `scripts/smoke-import-perf.ts` | by hand (`npm run test:smoke`) | Per-row statements in the import engine (wall-clock budgets, so not in CI). |
| `perf.slow` rows in `error_events` | production | Any traced call (`src/lib/perf-trace.ts`) over 10 s, by account. The ops sweep alerts on a burst. |
| Vercel Speed Insights | production | Core Web Vitals per route, in the Vercel dashboard. |

## `maxDuration` policy

Set in route segment configs, not `vercel.json`. Hobby's ceiling with Fluid Compute is 300 s.

| Where | Value | Why |
|---|---|---|
| pages (default) | Vercel default | Nothing user-facing should need more. |
| `(app)/(main)/layout.tsx` | 300 **(temporary)** | Stopgap for the heavy-account timeouts; revert to 60 once `perf.slow` stays quiet for a week. |
| `chat/page.tsx`, `/api/chat` | 60 | A full model completion on the user's own key. |
| `/api/imports/process-stalled`, `/api/embeddings/backfill`, `/api/linkedin/timeline-events/backfill`, `/api/imports/[id]/continue` | 300 | Batch work that self-continues past the ceiling. |
| `/api/ops/sweep` | 60 | Reads only. |
| `/api/health` | 10 | Every check inside is capped at 4 s. |

## Rules that keep the hot paths fast

- **Never select `notes` or `profile_image_url` in a scan.** Compute the browser-safe avatar URL in SQL with `clientAvatarUrlSql` (`src/lib/contact-avatar-sql.ts`). The page-budget smoke fails otherwise.
- **Nothing external on a write path.** Embedding rebuilds are deferred via `deferEmbeddingRebuild` in `src/lib/contact-writes.ts`; the row is marked `embedding_stale_at` and the hourly backfill is the backstop.
- **Loops that await the network per item get a deadline** (`src/lib/time-budget.ts`); unattempted items are pending for the next tick, never a longer function.
- **One poll per tab.** Anything periodic joins the app pulse (`src/lib/app-pulse.ts`) rather than adding a timer.
- **Wrap anything that can take seconds in `traced()`** so a slow account leaves a row you can find later.

## Measuring

- Statement shape and count: `DEBUG_QUERIES=1 npx tsx scripts/smoke-page-budgets.ts` lists every statement a page issues.
- Real plans: enable Drizzle's `logger: true` locally, paste the SQL into Neon's SQL editor with `EXPLAIN (ANALYZE, BUFFERS)`, and read `shared read` — that is the cold-storage cost.
- Bundles: `npm run analyze` (`next experimental-analyze`, Turbopack-native).
- Lighthouse on `/`, `/pricing`, `/dashboard` in the in-app browser before and after a change to the marketing tree or the shell.
