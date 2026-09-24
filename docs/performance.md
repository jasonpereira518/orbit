# Performance notes

How Orbit stays fast, what guards it, and how to measure before guessing.

## What is guarded

| Guard | Runs | Catches |
|---|---|---|
| `npm run perf:pages` (`scripts/smoke-page-budgets.ts`) | CI (`npm test`) | The dashboard, graph and notification-panel scans pulling `notes` or base64 avatars again, or their statement counts creeping up. 3,000-contact fixture. |
| `scripts/smoke-write-path.ts` | CI | An embedding-provider call sneaking back onto the request path of a contact save. |
| `scripts/smoke-import-perf.ts` | by hand (`npm run test:smoke`) | Per-row statements in the import engine (wall-clock budgets, so not in CI). |
| `scripts/smoke-behavior-golden.ts` | CI | ANY change in what the MCP server (`tools/list` + every tool), the extension API, `/api/v1`, the page loaders, the contact/settings actions return, or in what their writes leave in the database. A characterization snapshot (`scripts/fixtures/behavior-golden.json`) for behavior-preserving work: re-record with `--update` only on code you trust, ideally in a worktree at the commit before your change. |
| `scripts/smoke-due-follow-ups-parity.ts` | CI | `loadDueFollowUps` (MCP, `/api/v1/followups`, the `followup.due` webhook) drifting from the dashboard's due list. |
| `perf.slow` rows in `error_events` | production | Any traced call (`src/lib/perf-trace.ts`) over 10 s, by account. The ops sweep alerts on a burst. |
| Vercel Speed Insights | production | Core Web Vitals per route, in the Vercel dashboard. |

## `maxDuration` policy

Set in route segment configs, not `vercel.json`. Hobby's ceiling with Fluid Compute is 300 s.

| Where | Value | Why |
|---|---|---|
| pages (default) | Vercel default | Nothing user-facing should need more. |
| `(app)/(main)/layout.tsx` | 60 | Every signed-in page unless it overrides. It was 300 as a stopgap; the dashboard payload is bounded now. |
| `capture/page.tsx`, `imports/page.tsx` | 300 | Their server actions summarise a meeting (several model calls) or start a large import. |
| `chat/page.tsx`, `/api/chat` | 60 | A full model completion on the user's own key. |
| `/api/imports/process-stalled`, `/api/embeddings/backfill`, `/api/linkedin/timeline-events/backfill`, `/api/imports/[id]/continue`, `/api/sync/run`, `/api/capture/jobs`, `/api/capture/jobs/[id]/run`, `/api/scan/[token]/pages`, `/api/export` | 300 | Batch work that self-continues past the ceiling, or streams a whole account's export. |
| `/api/capture/meetings/[id]/chunks` | 120 | One chunk's transcription, which can fall through Wispr's 60 s deadline before Whisper starts. |
| `/api/ops/sweep`, `/api/webhooks/outbound/drain`, `/api/mcp`, `/api/mcp/[token]`, `/api/scan/[token]/finish` | 60 | Bounded reads, or network work inside its own 40 s budget. |
| `/api/extension/parse`, `/api/extension/starters` | 30 | One small completion for the extension panel. |
| `/api/health` | 10 | Every check inside is capped at 4 s. |

## Rules that keep the hot paths fast

- **Never select `notes` or `profile_image_url` in a scan.** Compute the browser-safe avatar URL in SQL with `clientAvatarUrlSql` (`src/lib/contact-avatar-sql.ts`). The page-budget smoke fails otherwise.
- **Nothing external on a write path.** Embedding rebuilds are deferred via `deferEmbeddingRebuild` in `src/lib/contact-writes.ts`; the row is marked `embedding_stale_at` and the hourly backfill is the backstop.
- **Loops that await the network per item get a deadline** (`src/lib/time-budget.ts`); unattempted items are pending for the next tick, never a longer function.
- **One poll per tab.** Anything periodic joins the app pulse (`src/lib/app-pulse.ts`) rather than adding a timer.
- **Wrap anything that can take seconds in `traced()`** so a slow account leaves a row you can find later.
- **Make the likely next click land on prefetched data.** A navigation that shows a `loading.tsx` skeleton cannot finish in under ~300 ms, because React holds a revealed fallback that long; most routes render in 25–200 ms, so the skeleton was the wait. A `<Link>`'s default prefetch stops at `loading.tsx` on dynamic routes. Use `IntentLink` (`src/components/ui/intent-link.tsx`) for links to profiles and other dynamic pages, and `useIntentPrefetchHandlers` / `useFullPrefetch` (`src/lib/intent-prefetch.ts`) where a click is a `router.push`: they upgrade to a full prefetch on hover or focus, never for every link in view (each is a real server render).
- **Nothing a user opens should wait in the Server Action queue.** Next sends actions one at a time per tab, so ambient work done through an action (the avatar backfill loop, anything polled) delays every sheet or draft the person opens after it. Ambient or background work goes through a route handler (`/api/contacts/avatar-backfill`); reads that open a panel prefer being passed from the server page.
- **Warm lazy sheets before the click.** Every `*-lazy.tsx` sheet exports a `preload…()`; call it on hover/focus of the trigger (and on idle for the most common ones), so opening never waits on a chunk with nothing on screen.
- **Heavy SDKs load on first use.** The AI SDKs (inside `ai-access.ts`'s client builders and `ai-key-check.ts`), `@vercel/blob` (`blob-lazy.ts`), Resend and Twilio are imported where a request actually uses them; a static import of any of them lands on nearly every route's cold start.

## Measuring

- Statement shape and count: `DEBUG_QUERIES=1 npx tsx scripts/smoke-page-budgets.ts` lists every statement a page issues.
- Real plans: enable Drizzle's `logger: true` locally, paste the SQL into Neon's SQL editor with `EXPLAIN (ANALYZE, BUFFERS)`, and read `shared read` — that is the cold-storage cost.
- Bundles: `npm run analyze` (`next experimental-analyze`, Turbopack-native). For numbers per route, `node scripts/dev/bundle-report.mjs` after a build: first-load client JS (raw and gzip), preloaded fonts, and the server JS each route's function traces (what a cold start evaluates), API routes included.
- What opening things feels like: `node scripts/dev/open-timing.mjs <url> --latency=40` against a demo-mode production build (run the server with `ORBIT_SIM_DB_LATENCY_MS=20`). It clicks the way a person does — pointer rests `--dwell` ms, then presses — through sidebar navigation, profile opens (from the list, the dashboard, Back), the detail and follow-up sheets, the first ⌘K and a chat thread, and reports time to first feedback, to content, and to settled. A local production build needs two measurement-only edits (`isLocalhost()` → `true`, skip the proxy's production 503); never commit them.
- Round trips, row width and CPU for the hot read paths (dashboard, graph, contacts, every MCP tool, the extension): `scripts/dev/efficiency-bench.ts` seeds a 3,000-contact account once, then reports statements, sequential depth (wall time under `ORBIT_SIM_DB_LATENCY_MS` ÷ that latency), payload and CPU. Run it at two commits against copies of the same seeded directory to compare.
- `cache()` only deduplicates inside a React render. In route handlers (MCP, extension, `/api/v1`) and Server Actions it is a pass-through, so a helper that is "request-cached" on a page runs again on every call there — pass the row you already hold instead (`entitlementsFromSettings`, `resolveApolloKey(userId, row)`).
- Lighthouse on `/`, `/pricing`, `/dashboard` in the in-app browser before and after a change to the marketing tree or the shell.
- Real-user Core Web Vitals: weekly, or after any change touching `/graph`, `/`, or `/capture` — the three heaviest client trees (the sky-atlas graph, the landing page's three.js globe, capture's lazy-loaded form) — check Speed Insights in the Vercel dashboard, filtered to Production, for LCP/INP/CLS regressions on those routes specifically. Complements the Lighthouse check above with real traffic instead of a synthetic run.
