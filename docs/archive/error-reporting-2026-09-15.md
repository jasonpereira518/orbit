# Swallowed errors: inventory and fix

**Date:** 2026-09-15 · **Branch:** `claude/launch-p0` · **Prompted by:** the Stripe checkout bug, where a Server Action caught Stripe's error, returned "Could not start checkout. Please try again." as a 200, and left the only trace in a local `console.error`.

## What production looked like before this change

- **Sentry received nothing.** `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` are not set in any Vercel environment (checked with `vercel env ls`; the production client bundles contain no DSN). The CSP allowlists Sentry's ingest host, which is why it looked wired.
- **The no-Sentry fallback was off too.** Uncaught errors fall back to a Slack message, and `SLACK_OPS_WEBHOOK_URL` is not set either. So an uncaught production error reached nobody; Vercel Hobby keeps runtime logs for about an hour.
- **Caught errors never reached Sentry even with a DSN.** Only uncaught errors go through `onRequestError`. Every `catch` that turned a failure into `{ ok: false, error }`, a status row or a count was invisible by construction.

## The inventory

A TypeScript-parser pass over every `catch` clause and `.catch(handler)` in `src/app/api`, `src/actions` and `src/lib` (519 sites before, 494 after — some were merged into helpers):

| Area | Rethrows | Reported | Only `console.*` | Silent (fallback value) | Silent (empty) |
|---|---|---|---|---|---|
| Routes, before | 4 | 9 | 3 | 35 | 29 |
| Routes, after | 4 | **28** | 2 | 18 | 19 |
| Actions, before | 13 | 3 | 3 | 41 | 29 |
| Actions, after | 13 | **37** | 0 | 10 | 29 |
| Background jobs and lib, before | 39 | 12 | 6 | 150 | 143 |
| Background jobs and lib, after | 38 | **39** | 6 | 135 | 116 |

"Reported" before this change mostly meant an `error_events` row, a cron ledger row or a status column — useful, but nothing anyone was paged about and nothing searchable by the reference a person could quote.

## The fix

One set of helpers, used everywhere instead of hand-rolled catch blocks:

- `reportError(err, { where, userId, extra, level })` in `src/lib/report-error.ts` sends the error to Sentry (tags: `where`; user: the Clerk id; extra: sanitised context — any key naming a key, token, secret, password or cookie is dropped), writes one greppable log line `[orbit:<where>] ref=<ref> user=<id>`, and returns an 8-character reference. With a DSN the reference is the Sentry event id prefix; without one it is random but still in the log line. It never throws. `warning` level is throttled to one line per minute per `where`, for best-effort paths with a backstop.
- `reportedFailure(err, fallback, ctx)` is the message a catch block returns as data. A `UserFacingError` (Orbit's own words) and a failure the person fixes themselves — no AI key, a refused key, a provider rate limit, offline — pass through unreported. Everything else is reported and the copy carries the reference: `Couldn’t start checkout — try again (ref 71fa5521)`.
- `actionFailure(err, fallback, where)` / `reportActionError` in `src/lib/action-failure.ts` do the same for Server Actions, re-reading the (request-cached) user id because most actions resolve it inside the `try`.
- `reportAndContinue(ctx, fallback)` replaces `.catch(() => null)` on follow-on work: report (throttled), then resolve to the same fallback.
- `reportUnlessQuiet(err, ctx)` for background AI calls with a fallback: reported unless the cause is the person's own key setup.
- **Thrown errors in production** are digested by Next.js. `friendlyError` now appends the digest as the reference (`… (ref 517068523)`), and `reportRequestError` tags the Sentry event with the same digest, so a quoted reference finds the event.

## Every site changed

Server Actions — returned a generic string as data, with nothing recorded:

| File | Sites (`where` tag) |
|---|---|
| `src/actions/billing.ts` | `action.billing.checkout` — both checkouts; also keeps the `error_events` row the ops sweep reads, now with the reference |
| `src/actions/capture-jobs.ts` | get, queue, record decision, record choices, save, discard (6) |
| `src/actions/capture.ts` | `ingest-capture-media`, `parse-bulk-capture-notes` |
| `src/actions/meetings.ts` | create, resume, end, save details, load transcript, analyze (×2), analyze digest, discard (9) |
| `src/actions/scan.ts` | mint, watch, finish, cancel (4) |
| `src/actions/ignored-people.ts` | list, add as contact, forget (3) |
| `src/actions/chat.ts` | `ask-network` |
| `src/actions/events.ts` | `preview-resync`, `connect-feed`, `connect-luma` — **bug:** every Luma failure, including an outage, said "Luma didn’t accept that key"; now only a 401/403 does |
| `src/actions/imports.ts` | LinkedIn connections and messages previews, contacts-file preview — **bug:** a parser fault was reported to the person as "is it the right export?" |
| `src/actions/calendar.ts` | `first-sync` |
| `src/actions/outreach.ts` | `bulk-send`, per message |
| `src/actions/recruiter-messages.ts` | `send`, per draft |
| `src/actions/contact.ts` | `contact.send` — public form, was `console.error` only; Resend's rejection object is wrapped so the report is readable |
| `src/actions/graph.ts` | `rebuild-embeddings` — was a `console.error` per contact; now one report per batch next to the existing `error_events` row |
| `src/actions/recruiters.ts` | `rating-resweep` — was `console.error` in `after()` |

Route handlers:

| File | Sites |
|---|---|
| `src/app/api/chat/route.ts` | `route.chat.prepare` (JSON 400 now carries `ref`), `route.chat.stream` (the mid-stream error event) |
| `src/app/api/capture/jobs/route.ts` | `route.capture-jobs.ingest`, and the job-failure write |
| `src/app/api/capture/meetings/[id]/chunks/route.ts` | `route.meeting-chunk` (non-terminal failures; a missing or refused key stays a quiet 422) |
| `src/app/api/scan/[token]/pages/route.ts` | `route.scan-pages`, and the handoff-error write |
| `src/app/api/plan-upgrades/claim/route.ts` | `route.plan-upgrades.claim` — was `console.error` |
| `src/app/api/imports/process-stalled/route.ts` | each of seven sub-steps that set `status = "partial"` and dropped the error, per-user recalibration and embedding, and the outer failure |
| `src/app/api/sync/run/route.ts`, `src/app/api/webhooks/outbound/drain/route.ts`, `src/app/api/ops/sweep/route.ts` | the outer failure (sweep failures were invisible because the sweep is what sends alerts), continuation kicks, follow-up emission, idempotency purge |
| `src/app/api/embeddings/backfill/route.ts`, `src/app/api/linkedin/timeline-events/backfill/route.ts` | `catch {}` around the whole backfill |
| `src/app/api/capture/jobs/[id]/run/route.ts`, `src/app/api/imports/[id]/continue/route.ts` | `.catch(() => {})` on the job run in `after()` |

Background jobs (`src/lib`):

| File | Sites |
|---|---|
| `capture-job-runner.ts` | parse and save failures (stored friendly copy, discarded the error), five follow-on steps after a save |
| `import-engine.ts` | `failImport` (stored message now carries the reference), continuation kick, three finalize steps |
| `gmail-scan-processor.ts` | per-sender classification failure, continuation kick |
| `sync-scheduler.ts` | Google Calendar sync and discovery, ICS claim and per-feed sync, event connections, event enrichment, person-key backfill, result writes |
| `ops-sweep.ts` | Slack delivery failures (open, remind, recover) and the heartbeat |
| `cron-runs.ts` | ledger start and finish |
| `webhooks/dispatch.ts` | enqueue failure (an integration silently missed an event), follow-up emission |
| `calendar-sync.ts`, `contact-brief.ts`, `message-enrichment.ts`, `events/enrich-queue.ts`, `events/sync.ts`, `note-batch-save.ts`, `ingest/events.ts`, `import-stall.ts`, `capture-jobs.ts`, `embedding-backfill.ts`, `linkedin-timeline-backfill.ts` | per-item and best-effort failures, throttled at warning level |

## Found while doing this

- **A Stripe error told buyers to add an AI key.** `isMissingAiApiKeyError` was `/api key/i`, so Stripe's "Invalid API Key provided" — and Apollo's and Resend's key errors — became "Add your AI API key in Settings to use this". It now matches only Orbit's own no-key messages; refused AI keys get their own copy (Phase 0 Task 10, pulled forward). The plan's refused-key pattern also listed "invalid api key", which is Stripe's wording; that alternative was dropped.
- **`STRIPE_SECRET_KEY` is not set in any Vercel environment.** Production cannot create a checkout session; the upgrade page shows its not-on-sale state. The generic "Could not start checkout" you saw must have come from a local run with test keys.
- **`STRIPE_MCP_KEY` is set as plain config in production and Preview, and no code reads it.** If it is a Stripe secret or restricted key, it is readable by anyone with dashboard access to the project. Remove it or mark it sensitive.

## Deliberately left as is

- **Auth and paywall refusals** in routes (401/403 with an explanation) and **malformed request bodies** (400): the status is already the truth and nothing failed on Orbit's side.
- **Validation copy returned as data**: net-guard's webhook URL messages, `LinkedInExportError`, `ContactsFileError`, `EventPageError`, `IcsFeedGoneError`. These describe the person's input.
- **Parse-and-fallback helpers** (JSON bodies, URLs, cursors, dates) that return null or a default: the absence is the answer, and reporting them would bury real faults.
- **Client-side catches** (`capture/job-store.ts`, `use-capture-ingest.ts`, `meeting-upload-queue.ts`, `import-job-runner.ts`): these run in the browser, retry or back off by design, and report through client Sentry once `NEXT_PUBLIC_SENTRY_DSN` is set. `report-error.ts` is server-only.
- **Telemetry that must never fail its caller** (`webhook-deliveries.ts`, `rate_limit` bookkeeping): reporting a failed telemetry write about a failure would double every incident.

## How it was verified

- `scripts/smoke-report-error.ts` (new, in the suite): a fault is reported with a reference and the raw provider text never reaches the copy; `UserFacingError` and person-fixable failures stay quiet; secret-named fields never reach the log; warnings throttle; reporting odd values never throws; digests become references.
- `scripts/smoke-friendly-error.ts`: refused keys from Gemini, OpenAI and Anthropic are not "missing"; Stripe, Apollo and Resend key errors are neither missing nor refused AI keys.
- End to end on `next dev`, with `SENTRY_DSN` pointed at a local recorder standing in for Sentry's ingest API: `/upgrade` → **Get Orbit Lifetime** with an invalid Stripe test key showed "Couldn’t start checkout — try again (ref 71fa5521)", and the recorder received event `71fa5521…` tagged `where: action.billing.checkout`, user `demo-user`, extra `{ plan: "lifetime", stripeCode: "StripeAuthenticationError" }`, exception "Invalid API Key provided: sk_test_…" (Stripe masks the key).

## To turn it on in production

Create a Sentry project (free tier), then in Vercel set `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` (same value) for Production and Preview, and `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` for readable stack traces. Redeploy — `NEXT_PUBLIC_*` is inlined at build time. Add an alert rule on `level:error` and route it to the channel you read.
