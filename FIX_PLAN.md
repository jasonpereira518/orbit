# Orbit fix plan

Companion to `SECURITY_AUDIT.md` (same date, same commit). Nothing here has been implemented; this is the proposal to approve, amend or reject before any application code changes.

Effort: **S** = under half a day, **M** = one to two days, **L** = three days or more. Regression risk is the chance the change breaks existing behaviour, not the risk of leaving it. Every fix names the regression test to add; new tests go under `scripts/smoke-*.ts` (so `npm test` and CI run them) unless stated, and the `stress-tests/` proofs double as the acceptance check (a `BUG` line must turn `ok`).

---

## Phase 1 — Critical and high security issues

**Status (2026-10-17): implemented on `claude/trusting-wozniak-ebsks3` with the recommended options** — `options` removed from the contact actions (1.1), aborted managed streams settle at the hold estimate (1.2), recurrence bounded with a 1,000 `INTERVAL` ceiling and a fixed-period jump (1.3), `imports.claim_token`/`lease_until` lease at schema version 171 (1.4), `note_batches` status `saving`/`saved`/`failed` with a resumable save (1.5), scope-less MCP OAuth tokens read-only (1.6), `PRODUCTION_DB_HOST` required in preview with test-key assertions (1.7). Each ships with the regression test named below; the matching `stress-tests/` proofs now print `ok`. Two dashboard steps remain yours: set `PRODUCTION_DB_HOST` on every Vercel environment before the next preview build (it now fails without it), and define the `orbit:read`/`orbit:write` scopes in Clerk before setting `MCP_OAUTH_REQUIRE_SCOPES=1`.

Ship these first, in this order. Each is independent except where noted.

### 1.1 H-01 Stop accepting `options` from clients on contact actions
- **Approach:** in `src/actions/contacts.ts`, drop the `options` parameter from `createContact`, `createContactDetailed`, `createContactsBulk` and `updateContact` (or reduce it to a server-defined allowlist of the two flags the UI actually needs, e.g. `{ mergeFactLists }`), and build `ContactWriteOptions` inside the action. `createContactsBulk` also takes a `CompanyResolver` function, which cannot cross the wire; make it a lib-only function. Then sweep every other action whose signature includes an `options`/`opts` object that is forwarded to a `*ForUser` function and apply the same rule (scan with the parser-based script from the audit, kept under `scripts/`).
- **Files:** `src/actions/contacts.ts`, `src/lib/contact-writes.ts` (narrow the exported option type for action callers), any action found by the sweep.
- **Effort:** S · **Regression risk:** Low (the UI passes no options today; `contact-form.tsx` calls `createContact(payload)`).
- **Verify:** `stress-tests/input-extremes.ts` AZ-OPT-1 turns `ok`.
- **Regression test:** extend `scripts/smoke-action-user-scope.ts` to also flag any exported action parameter typed as `ContactWriteOptions`/containing `entitlements`/`headroom`; a unit check that `createContact` with a forged second argument still enforces the cap.

### 1.2 H-02 Charge aborted managed streams
- **Approach:** in `settleManagedUsage` (`src/lib/credits/ledger.ts:469-481`) settle a `cancelled`/`timeout` failure with no reported tokens at the hold estimate (`holdEstimateMicros(tier)`) rather than 0; better, count prompt tokens before the call (the SDKs expose `countTokens`, or use the prompt length / 4 as a floor) and settle at least that plus streamed output so far. Apply the same rule to research steps that time out.
- **Files:** `src/lib/credits/ledger.ts`, `src/lib/usage-events.ts` (carry a `streamedChars`/`promptChars` field on the failure record), `src/lib/ai.ts` stream reporters (report partial output length on abort).
- **Effort:** M · **Regression risk:** Medium (legitimate network drops now cost the user something; keep it at the estimate, never above real cost).
- **Verify:** `smoke-ai-access` style test: abort a mocked stream after N chunks, assert the grant decreased by the estimate and the hold was released.
- **Regression test:** new `scripts/smoke-credits-abort.ts`.

### 1.3 H-03 Bound recurrence expansion
- **Approach:** in `src/lib/recurrence.ts` cap `INTERVAL` at parse time (e.g. ≤ 1000; RFC 5545 has no upper bound but no real calendar exceeds a few hundred), replace the `while (nextMo > 12)` loop in `stepMonths` with arithmetic (`y += Math.floor((mo - 1 + interval) / 12)`), count every generator yield toward `MAX_CANDIDATE_ITERATIONS` (move `++iterations` above the `continue`s), and bail when a candidate year exceeds `window.to`'s year + 1. Wrap `expandIcsEvents` in a wall-clock budget so one feed can never consume the connection's 60 s.
- **Files:** `src/lib/recurrence.ts`, `src/lib/calendar-sync.ts`, `src/lib/connectors/apple-calendar.ts`.
- **Effort:** S · **Regression risk:** Low (the existing recurrence smoke pins the supported subset).
- **Verify:** `stress-tests/recurrence-edge.ts` REC-3 turns `ok`.
- **Regression test:** add the `INTERVAL=1000000000`, `INTERVAL=0`, `COUNT=-5` and 100-year DAILY cases to `scripts/smoke-recurrence*.ts` with a 2 s deadline.

### 1.4 H-04 Lease the import job
- **Approach:** add `claim_token`/`lease_until` to `imports` (the same shape `capture_jobs` already uses: `src/lib/capture-jobs.ts:603-666`); `runImportJob` claims `UPDATE imports SET claim_token=$t, lease_until=now()+interval '5 min' WHERE id=$1 AND (lease_until IS NULL OR lease_until < now()) RETURNING id`, refuses to run without it, heartbeats per chunk, and settles only while it still holds the token. The stall backstop and admin retry then simply fail to claim while a runner is live. Make the counters `SET contacts_created = contacts_created + $delta` rather than absolute. Re-load the duplicate index per chunk, or at least re-check name-only rows against the DB before insert.
- **Files:** `src/lib/import-engine.ts`, `src/lib/import-stall.ts`, `src/lib/import-job-dispatch.ts`, `src/db/index.ts` (DDL + `SCHEMA_VERSION` bump), `src/lib/admin-operations.ts` (retry).
- **Effort:** M · **Regression risk:** Medium (touches the engine's claim loop; the existing `smoke-import-engine`, `smoke-import-stall`, `smoke-import-resumption-auth` suites cover the happy paths).
- **Verify:** `resilience-repros.ts` DI-IMPORT-DOUBLE turns `ok`.
- **Regression test:** add the two-runner scenario to `scripts/smoke-import-engine.ts`.

### 1.5 H-05 Make capture saves all-or-nothing, or honest
- **Approach:** insert the `note_batches` row as `status: "saving"` and flip it to `saved` only after the participant loop completes; on a throw mark it `failed` with the partial result and the error. In `capture-job-runner.ts` treat only `saved` as resumable success; a `failed` batch resumes by retrying the unsaved participants (they are idempotent per `notes:<hash>:<contactId>`) or surfaces the error on the job. Validate every participant (`parsed.name || mergeContactId`) **before** the first write so the common failure is caught up front.
- **Files:** `src/lib/note-batch-save.ts`, `src/lib/capture-job-runner.ts`, any reader that filters `status = 'saved'` (`capture-history.ts`, dashboards).
- **Effort:** M · **Regression risk:** Medium (status semantics change; grep every `noteBatches.status` reader).
- **Verify:** DI-CAPTURE-PARTIAL turns `ok`.
- **Regression test:** extend `scripts/smoke-capture-job*.ts` with the "bad second participant then resume" case.

### 1.6 M-17 Finish the MCP scope rollout (Dashboard + S)
- **Approach:** define `orbit:read` and `orbit:write` in Clerk → confirm new connections carry them → set `MCP_OAUTH_REQUIRE_SCOPES=1` → add it to `EXPECTED_IN_PRODUCTION` (warning) and, once stable, `REQUIRED_IN_PRODUCTION`. Until the flag is on, change the default grant for scope-less tokens to `["read"]`.
- **Files:** `src/lib/mcp/oauth.ts:58-70`, `src/lib/env.ts`, `.env.example`.
- **Effort:** S · **Regression risk:** Medium (existing connectors that never asked for scopes lose write until they reconnect; announce it).
- **Verify / test:** `smoke-ai-guardrails` already covers `oauthGrantFor`; add the new default.

### 1.7 M-06 Arm the preview/production guard (Dashboard + S)
- **Approach:** set `PRODUCTION_DB_HOST` on all Vercel environments now; move it to `REQUIRED_IN_PREVIEW`; add preview assertions that Clerk keys are `pk_test_`/`sk_test_` and that `STRIPE_SECRET_KEY` is `sk_test_`; fail the preview build when `DEMO_ACCOUNT_USER_ID` is set together with a production database host.
- **Files:** `src/lib/env.ts`, `scripts/check-env.ts`.
- **Effort:** S · **Regression risk:** Low (previews that are misconfigured stop building, which is the point).
- **Verify / test:** `scripts/smoke-env*.ts` cases for each new rule.

---

## Phase 2 — Data integrity and resilience

**Status (2026-10-17): 2.1–2.9 implemented on `claude/trusting-wozniak-ebsks3`; 2.10 deferred to decision 12.** Choices made where the plan left one open, each easy to reverse:
- **Text caps (decision 5):** over-long text is **truncated, never rejected**, on both the strict and lenient paths, so no import row fails for length. Caps live in `src/lib/input/text.ts` and `FREE_TEXT_CAPS` in `contact-input.ts` (notes 100k, AI summary 10k, how-met 2k, reminder title 500, description 10k, list items 500 × 100, tags 60 × 50). NUL and other C0 controls are stripped and text is NFC-normalised.
- **Truncated model output (decision 6):** **no retry**. `withUsage` records one token count per call, so a retry inside it would bill only the second attempt. A JSON answer the provider reports as cut off (`finish_reason=length`, `stop_reason=max_tokens`, `MAX_TOKENS`, Responses `incomplete`) now throws `TruncatedOutputError` with the existing "got cut off — try again" copy, unless it already parses as complete JSON. Page transcription keeps its repair.
- **Webhook drain (2.5):** rows are claimed in the database (`claimed_by`/`claimed_until`, schema 172), at most 5 per endpoint per pass, interleaved. The ops workflow is unchanged; overlapping drains are now harmless.
- **Referral tier (2.9):** at-least with a `referral_tier_mailed` claim (schema 173). A friend who leaves and rejoins no longer re-sends a tier mail.
- **Chat disconnect (2.9, L-25):** a dropped connection (closed tab, network blip) now keeps the person's question in the thread; only an explicit Stop discards it. The client mints a turn id per question, and Stop calls `stopChatTurn`, which marks the thread (`chat_threads.stopped_turn_id`, schema 174) and deletes the question if it is already saved. The route reads the mark after saving the question, so either arrival order converges. Asking the same question again replaces the kept unanswered copy. Regenerate and edit turns still discard on any abort. The partial answer is not persisted. Credits for aborted streams were already settled in Phase 1.
- **2.10:** the graph scan already omits notes and avatars. Capping or paginating the drawn set is decision 12 and is left for you.

Tests added or extended: `smoke-input-helpers`, `smoke-contact-create-race`, `smoke-cloud-files-bomb`, `smoke-contacts-search-paging`, `smoke-webhook-delivery`, `smoke-ai-request-options`, `smoke-import-revert`, `smoke-credits`, `smoke-waitlist-position`, `smoke-import-engine`. Stress proofs DI-DUP-CREATE, DI-PAGE-NULL, DI-WEBHOOK-DOUBLE, RACE-CAP-1, EC-DATE-*, EC-LEN-* and INJ-DOCX-BOMB now print `ok`.

### 2.1 M-04 + L-11 Validate dates and ids at the edge
- **Approach:** a shared `parseIsoDate(input): Date | null` (and `requireUuid`) in `src/lib/input/`; every `new Date(input.*)` in `src/actions/**` and `src/lib/*-writes.ts` goes through it and returns a `UserFacingError` on `null`; add uuid regexes to `api/avatars/[contactId]`, `api/feedback/screenshots/[shotId]`, `api/v1/webhook-endpoints/[id]`; zod-validate `files[]` in `api/scan/[token]/pages`; validate cursor fields (`id` uuid, `u`/`lt` parseable) in `contacts-page-cursor.ts` and `reminders-page-query.ts`, returning `null` (first page) on garbage.
- **Files:** the 12 call sites listed in the audit (M-04, L-11).
- **Effort:** S–M · **Regression risk:** Low.
- **Verify:** EC-DATE-1/2 turn `ok`. **Test:** `scripts/smoke-input-dates.ts` (pure) over every action with a date field.

### 2.2 M-05 Cap free text and strip NUL
- **Approach:** one `cleanText(value, max)` helper that strips `\u0000` and other C0 controls (keep `\n`/`\t`), NFC-normalises, and truncates; apply it in `contact-input.ts` for `notes` (50k), `howMet` (2k), `keyFacts[]` (50 × 500), `tagNames[]` (50 × 60), in `reminder-writes.ts` (title 500, description 10k), in `logInteractionForUser` (`rawNotes` 100k = capture's own cap, `aiSummary` 5k, `topics`/`actionItems` 100 × 200), and in chat/meeting writes. Lenient importers keep their narrowing path but still get NUL stripping (a NUL row is a `failedRows` entry otherwise, which is fine, but the stripped version is better data).
- **Files:** `src/lib/contact-input.ts`, `src/lib/reminder-writes.ts`, `src/lib/contact-writes.ts`, `src/lib/note-batch-save.ts`, `src/lib/chat-persist.ts`.
- **Effort:** M · **Regression risk:** Low–Medium (a cap below something real users already have would truncate on next edit; pick caps from the current max in production first: `select max(length(notes)) from contacts`).
- **Verify:** EC-LEN-1/2/3, EC-NUL-1/2/3 turn `ok`. **Test:** `scripts/smoke-text-limits.ts`.

### 2.3 M-12 Fix the closeness cursor
- **Approach:** two-phase cursor exactly like `last_touch` (`contacts-page-cursor.ts:99-112`): order `closeness desc nulls last, id desc`; phase one `(closeness, id) < (c, id) or closeness is null`, phase two `closeness is null and id < id`. Carry `c: number | null`.
- **Files:** `src/lib/contacts-page-cursor.ts`, the matching index in `src/db/index.ts` if the order changes.
- **Effort:** S · **Regression risk:** Low. **Verify:** DI-PAGE-NULL turns `ok`. **Test:** add NULL rows to `scripts/smoke-contacts-search-paging.ts`.

### 2.4 M-13 Close the create/cap races
- **Approach:** (a) `createContactForUser` acts on a lost identity claim by returning the winner (or throwing a typed `DuplicateContactError` the capture path handles); (b) enforce the free cap in SQL: `INSERT … SELECT … WHERE (SELECT count(*) FROM contacts WHERE user_id=$1 AND source <> 'tour-example') < $limit` inside `runAtomicWrite` after touching a per-user lock row (the `credit_accounts` pattern); (c) `keyFacts`/tags merge as a single `UPDATE … SET key_facts = (SELECT array_agg(DISTINCT x) …)` or an `array_cat` with dedupe in SQL.
- **Files:** `src/lib/contact-writes.ts`, `src/lib/contact-identity.ts`, `src/lib/note-batch-save.ts`.
- **Effort:** M · **Regression risk:** Medium (b changes the insert shape; keep the JS pre-check for the friendly error and add the SQL guard as the backstop).
- **Verify:** DI-DUP-CREATE and RACE-CAP-1 turn `ok`. **Test:** `scripts/smoke-contact-create-race.ts`.

### 2.5 M-03 Claim webhook deliveries and make the drain fair
- **Approach:** add `claimed_by`/`claimed_until` to `outbound_webhook_deliveries` and claim with `UPDATE … WHERE status='pending' AND (claimed_until IS NULL OR claimed_until < now()) … RETURNING` (copy `src/lib/connectors/outbox.ts:12-61`); select with `DISTINCT ON (endpoint_id)` or round-robin by `user_id` per pass; skip endpoints whose last attempt timed out in the last N minutes; read error bodies with `readBodyCapped(res, 4096)`; put the drain's `workflow_dispatch` run in the same concurrency group as the schedule.
- **Files:** `src/lib/webhooks/dispatch.ts`, `src/db/index.ts`, `.github/workflows/ops.yml`.
- **Effort:** M · **Regression risk:** Low–Medium. **Verify:** DI-WEBHOOK-DOUBLE with a stubbed resolver. **Test:** extend `scripts/smoke-webhook-delivery.ts` with the overlap case.

### 2.6 M-02 + L-15 Cap inflation and model input sizes
- **Approach:** `readBodyCapped(res, MAX_ONEDRIVE_BYTES)` in `readFileText`; check `zip.file("word/document.xml")?._data?.uncompressedSize` (or stream with a byte counter) before `.async("string")` and throw `DriveFileTooLargeError` past `DRIVE_EXPORT_MAX_CHARS × 4`; a per-import total inflated-bytes budget in `linkedin-export-store.ts`; truncate extension page blobs to ~40k chars before fencing; check `raw.length` after reading MCP bodies.
- **Files:** `src/lib/cloud-files.ts`, `src/lib/linkedin-export-store.ts`, `src/lib/extension/parse-profile.ts`, `src/lib/conversation-starters.ts`, `src/lib/mcp/handle.ts`.
- **Effort:** S · **Regression risk:** Low. **Verify:** INJ-DOCX-BOMB turns `ok`. **Test:** `scripts/smoke-cloud-files-bomb.ts` (pure, builds the zip with jszip as the stress test does).

### 2.7 M-14 Timeouts everywhere a fetch leaves the building
- **Approach:** `AbortSignal.timeout(30_000)` on `drive.ts:70-78` (or route through `googleFetchWithRetry`), 15 s on the OpenRouter exchange, 20 s on the two Blob proxy routes; add an ESLint rule or a smoke that greps `src/lib` and `src/app/api` for `fetch(` without `signal`/`guardedFetch`/`internalFetch` and allowlists the vendor SDK calls.
- **Effort:** S · **Regression risk:** Low. **Test:** `scripts/smoke-fetch-timeouts.ts` (pure, parser-based).

### 2.8 M-15 Detect truncated model output
- **Approach:** surface `finish_reason`/`stop_reason` from each provider adapter through `completeJson`; when it is `length`/`max_tokens`, retry once with a larger budget or a "continue" turn for array outputs, else fail the call with a typed `TruncatedOutputError` rather than repairing; keep `repairTruncatedJson` only for transcription where the comment already documents the trade-off, and record an `ai.truncated` usage flag.
- **Files:** `src/lib/ai.ts` (`parseAiJson`, `completeJson`, adapters), `src/lib/capture-parse.ts`, `src/lib/ai-batch-apply.ts`.
- **Effort:** M · **Regression risk:** Medium (captures that silently worked will now error or retry; cost goes up slightly). **Test:** mocked completion with `finish_reason: "length"` in `scripts/smoke-ai-request-options.ts`.

### 2.9 L-25, L-26, L-20 Smaller integrity items
- Persist the partial answer on an involuntary disconnect (keep the `Stop` semantics only for an explicit stop signal), or at least keep the user's question; settle the hold on `request.signal.aborted`.
- `releaseHold` deletes one hold (oldest for the operation), not all; settle on timeout paths.
- Import revert: `UPDATE imports SET reverted_at = now() WHERE id=$1 AND reverted_at IS NULL RETURNING` as the claim; referral tier: `>=` with a "highest tier mailed" column.
- **Effort:** S each · **Risk:** Low.

### 2.10 SCALE-GRAPH Bound the constellation payload
- **Approach:** page or pre-aggregate `loadGraphData` (`graph-data.ts:69`): cap at the eligible set (`constellation-eligibility.ts` already decides who is drawn), select only the columns the renderer uses, and move tag joins to a second query over the kept ids. Same review for the other unbounded `findMany` sites the audit lists (`import-engine.ts:574`, `ingest/events.ts:282`, `capture-parse.ts:248`, `reminders.ts:407`).
- **Effort:** M–L · **Risk:** Medium (rendering changes). **Verify:** `stress-tests/scale-20k.ts` SCALE-GRAPH under 5 s on PGlite. **Test:** raise `scripts/smoke-page-budgets.ts` to 20k with a time budget.

---

## Phase 3 — Hardening and standardisation

**Status (2026-10-19): implemented on `claude/trusting-wozniak-ebsks3`, except the CSP work in 3.4.** Schema 176 (rate-limit index) and 177 (account audit log, hashed waitlist and credit-unsubscribe tokens, Clerk update dedupe). Choices made where the plan left a decision open:
- **3.1:** every `src/actions` export is `defineAction` (gate, then zod parse, then handler); `smoke-action-schemas` enforces it. Enforcement is on immediately, not log-first. Schemas mirror what each handler already accepted; the visible change is that malformed ids now get a plain error instead of a 500. L-02 and L-04 done; L-03 (bidi) and the URL schemes were done just before, in `cleanText` and `contact-input.ts`.
- **3.2:** shared `routeError` for browser-facing routes; `/api/v1` and `/api/extension` keep their envelopes. Model text is scrubbed from error logs and Sentry.
- **3.3:** new limits are **enforced**; `ORBIT_NEW_LIMITS=log` turns only the new ones into log-and-allow. Numbers: draft 30/10 min, brief 20/10 min, compose 20/10 min, prep 20/10 min, duplicate hints 30/10 min, dictation tokens 12/5 min, chats 200/day, reminders 500/day, imports 50/day, 10 active API keys. Bulk drafting (including a campaign's follow-ups) is charged one unit per ten drafts. Same-origin checks on the 14 cookie-authenticated mutating routes, with a commented allowlist for webhooks, one-click unsubscribes, the extension, bearer APIs, the phone scan link and cron.
- **3.4:** `Cross-Origin-Resource-Policy: same-origin` on the media routes. **Not done:** flipping `CSP_ENFORCE` and the nonce migration (decision 9; needs a report window).
- **3.5 (decision 8):** retention windows as planned for logs and telemetry, all in `RETENTION` (`src/lib/retention.ts`). **Meeting transcripts and sent-email bodies are off (null) by default**, because they are user content and transcript search reads them; set a number there to enable. Account deletion (decision 7): the Stripe customer is marked deleted, not deleted; `billing_events` kept but anonymised; credit grants and the matching waitlist row deleted. The privacy page was updated, so existing users see the policy-update notice once.
- **3.6:** `v2:` ciphertext with `ENCRYPTION_SECRET_PREVIOUS` fallback and lazy re-encrypt; HKDF sub-keys with legacy fallbacks for anything already issued; Vercel environments without `ENCRYPTION_SECRET` now fail fast. `/api/mcp/[token]` announces a sunset of 2027-01-17 (`src/lib/mcp/path-token-sunset.ts`). Not done: per-IP limits on one-click unsubscribes (mail providers share IPs) and provider-side token revoke for Microsoft, Eventbrite and Luma.
- **3.7 (decision 11):** chat `update_contact` proposals no longer carry email; old stored ones never apply it.
- **3.8:** only two routes lacked a needed `loading.tsx` in the current tree (scan and meeting detail). Server-rendered dates use the viewer's zone; a brand-new browser sees UTC on its first page.
- **L-25 residual:** a dropped connection now also keeps the partial answer (schema 175), marked interrupted.

### 3.1 Central validation layer
- **Approach:** a `src/lib/input/` module with zod schemas per action input (dates via `parseIsoDate`, ids via `uuid`, text via `cleanText` with per-field caps, URLs via `safeHttpUrl`), and a `defineAction(schema, handler)` wrapper used by every `"use server"` export so that `requireUserId` and `schema.parse` run before any handler code. Convert the highest-traffic modules first (contacts, reminders, events, settings, outreach, recruiters), then the rest. Add `website`/`url` scheme checks to `contact-input.ts` strict **and** lenient modes, return `null` from `normalizeLinkedinUrl` on parse failure, refuse `createEvent` when canonicalisation fails (L-02), strip bidi/zero-width characters on manual fields too (L-03), and use `escapeLike` at the three unescaped sites (L-04).
- **Effort:** L (incremental; S per module) · **Risk:** Medium (strict schemas reject inputs that were silently tolerated; ship behind logging first: parse, log failures, then enforce).
- **Test:** `scripts/smoke-action-schemas.ts` asserting every export in `src/actions` is wrapped; `smoke-url-schemes.ts`.

### 3.2 Shared error handling
- **Approach:** one `toActionResult`/`routeError` helper that maps `UserFacingError`/zod → 400, `RateLimitedError` → 429 with `Retry-After`, `PaywallError` → 403, `Unauthorized` → 401, everything else → 500 with a digest only; route handlers stop hand-rolling the switch. Scrub model/provider text out of `error_events.message` and `reportError` extras (L-14) with `scrubText` from `sentry-scrub.ts`.
- **Effort:** M · **Risk:** Low. **Test:** `scripts/smoke-route-errors.ts` over the API routes with malformed input.

### 3.3 Rate limiting and caps
- **Approach:** add `draft` (30 / 10 min), `brief` (20 / 10 min), `compose` and `prep` buckets to the six unmetered AI actions (M-07); per-user caps on API keys (10), webhook endpoints (done), chat threads/day, reminders and imports per day (L-22); server-side speech session accounting (count `MAX_SESSION_MS` per minted token, lower by the beacon) and a lower mint rate (M-18); per-step holds for research (L-15); make `rate_limit_buckets.window_started_at` indexed before the prune becomes a seq-scan problem; an `assertSameOrigin(request)` helper on every cookie-authenticated non-GET handler and a `Content-Type` check (L-01).
- **Effort:** M · **Risk:** Low–Medium (new limits can hit real users; log-only for a week, then enforce). **Test:** extend `scripts/smoke-rate-limit.ts`; `smoke-origin-checks.ts` (parser-based: every cookie-auth POST route calls the helper).

### 3.4 Security headers
- **Approach:** flip `CSP_ENFORCE=1` after the report window; plan the nonce migration (`proxy.ts` sets a per-request nonce, Clerk and next-themes get it) to drop `'unsafe-inline'`; consider `img-src` tightened to the Blob host, LinkedIn CDN, unavatar, Gravatar and Clerk; add `Cross-Origin-Resource-Policy: same-origin` on the proxied media routes (L-09).
- **Effort:** S (flip) + L (nonces) · **Risk:** High for the nonce work (sign-in and checkout break on a wrong origin; stage on preview).

### 3.5 Logging with PII redaction and retention
- **Approach:** TTLs in the process-stalled sweep: `cron_runs` 90 d, `webhook_deliveries` 90 d with `detail.recipients` dropped after 30 d, `outbound_webhook_deliveries` payloads 30 d after delivery, `feedback_screenshots` + Blob 90 d after `closed`, `meeting_transcript_segments` after digest, `email_sends.body_*` 90 d, `gate_events`/`extension_usage`/`speech_usage` 180 d (M-08). Deletion residue (M-09): `stripe.customers.del` (or `update({ metadata: { deleted } })`), delete `credit_grants` and `billing_events` rows for the user id (or nullify ids), drop the waitlist row when the account email matches, document Sentry and Vercel log retention in `/privacy`. Audit rows for API-key create/revoke, self-deletion, export, OAuth connect/disconnect and plan changes (L-23). Dedupe Clerk `user.updated` by `svix-id` or `updated_at` (L-07). Delete event covers with their event; stop printing the health JSON in the public ops log and fix the stale `backup.yml` references (L-08, L-13).
- **Effort:** M · **Risk:** Low. **Test:** extend `scripts/smoke-housekeeping-sweeps.ts` and `smoke-purge*.ts`.

### 3.6 Secrets management
- **Approach:** versioned ciphertext (`v2:` prefix), `ENCRYPTION_SECRET_PREVIOUS` fallback on decrypt with lazy re-encrypt on read, HKDF sub-keys (`info: "rate-limit-salt"`, `"log-tag"`, `"unsubscribe"`, …) instead of reusing the raw secret, and non-prod fallbacks that throw when `VERCEL` is set (L-06); a rotate action for webhook endpoint secrets (L-19); make the credit-email unsubscribe token hash-bound like Radar's and hash the interest-list tokens (L-05); retire `/api/mcp/[token]` once existing connectors have moved to OAuth; shorten admin sign-in links to hours (L-16).
- **Effort:** M · **Risk:** Medium (rotation code must be tested against real ciphertext shapes; keep both formats readable forever). **Test:** `scripts/smoke-crypto-rotation.ts`.

### 3.7 AI hardening residuals
- **Approach:** remove `email` from chat `update_contact` proposals or route a changed email through recipient confirmation on the next send (M-10); run outreach and recruiter drafts through `guardModelOutput` + zod `{subject, body}` and fence `previousBody`/`templateSeed`/recruiter fields (M-11); fence capture hints, event-roster inputs, digest reduce partials and retrieval prompts and guard the stored `ai_note` (M-16); pass `signal` into `withTimeout` races; `isEvalSupported: false` for pdfjs.
- **Effort:** M · **Risk:** Low (fences are additive; goldens regenerate). **Test:** extend `scripts/smoke-ai-guardrails.ts` and the draft-prompt goldens.

### 3.8 UX failure states
- **Approach:** `error.tsx` for `scan/[token]`; `loading.tsx` for the six routes that lack one; pass the viewer's zone (the `orbit-tz` cookie via `resolveTimeZone`) to every server-side `toLocaleString`/`toLocaleDateString` (L-17); keep the question on stream disconnect (2.9).
- **Effort:** S · **Risk:** Low.

---

## Phase 4 — Test coverage and CI gates

**Status (2026-10-19): items 1–4 and 6 implemented on `claude/audit-phase4-ci-gates`; item 5 and GitHub's own secret scanning are repository settings for the owner.**
- **4.1:** `scripts/smoke-stress-*.ts` run the five stress proofs under `STRESS_STRICT`, where a `BUG` fails the run. `scale-20k.ts` stays manual. The harness now throws on failure: `run()` ends with `process.exit(0)`, which had been overwriting `process.exitCode`, so a harness failure exited 0.
- **4.2:** `scripts/smoke-security-lint.ts` uses the TypeScript compiler API rather than a new ESLint plugin. Its rules: server-side `fetch` passes a `signal`; no server action builds a `Date` from its own parameters; `Papa.unparse` appears only in `csv-export.ts`; and every non-literal `sql.raw` is on a reviewed allowlist with its reason (25 sites). It caught one unbounded fetch and one unvalidated restore date, both fixed. Origin checks stay in `smoke-origin-checks`.
- **4.3:** a `security` job runs `scripts/audit-deps.mjs`. It fails on any high or critical production advisory that isn't allowlisted. Each allowlisted advisory is pinned to the one package it may arrive through, checked against `package-lock.json`; today's entries are `braces` and `image-size` via `@clerk/ui`. `brace-expansion` was bumped to 5.0.12, which fixes two high advisories reached through `@sentry/nextjs`.
- **4.4:** `scripts/scan-secrets.mjs` scans tracked files for unambiguous live-credential formats and runs in the same job. gitleaks was not added: it is a third-party action (decision 10) and its commit hash could not be verified here. **Owner:** turn on GitHub secret scanning and push protection (Settings → Code security).
- **4.5:** `paths-ignore` is gone, so every job runs on every ready PR. **Owner:** in Settings → Branches → `main`, require `check`, `smoke suite (PGlite) 1/3`, `2/3`, `3/3`, `security` and `browser flows (Playwright)`.
- **4.6:** `scripts/prove-audit-regressions.ts` checks out the pre-audit commit `eb5d69d` in a throwaway worktree. It asserts every stress proof fails there with each finding it exists to prove, then passes on the current commit. Verified: 17 findings across four scripts.

1. **Promote the stress tests.** Move each `stress-tests/*.ts` scenario into `scripts/smoke-*.ts` once its fix lands (so the suite runs in CI's three shards), keeping `stress-tests/` as the audit record. Effort S per file.
2. **Security linting.** Add `eslint-plugin-security` (or the handful of custom rules the audit used as scripts): no `new Date(` on action inputs, no `fetch(` without a signal outside the vendor allowlist, no cookie-auth POST without `assertSameOrigin`, no `Papa.unparse` without `escapeFormulae`, no `sql.raw` outside a closed-union helper. Effort M.
3. **Dependency scanning.** Keep Dependabot; add an `npm audit --omit=dev --audit-level=high` job that allowlists the `@clerk/ui → @solana/*` chain by advisory id and fails on anything new; run the extension lockfile's audit too; `npm audit fix --force` stays forbidden in the README. Effort S.
4. **Secret scanning.** Enable GitHub secret scanning + push protection on the repo (Dashboard); add `gitleaks` (pinned by SHA) on `pull_request` with the fixture allowlist from `scripts/`. Effort S.
5. **Required checks.** Make `check`, the three `smoke` shards and `e2e` required on `main` and drop `paths-ignore` (the CI comment already explains why). Dashboard.
6. **Regression tests named above**, one per finding, each asserted to fail on the pre-fix commit (mutation-tested the way the September suites were).

---

## Dependencies and ordering

- 1.1, 1.3, 1.6, 1.7, 2.1, 2.3, 2.6, 2.7 are independent and can ship in any order the same day.
- 1.2 (abort charging) should land before 3.3's new buckets so the two cost controls are tuned together.
- 1.4 (import lease) and 1.5 (capture status) both change job-state semantics; ship each with its own `SCHEMA_VERSION` bump and run `smoke-import-*`/`smoke-capture-*` before and after.
- 2.2 (text caps) must be preceded by a production query for current maxima so no existing row is truncated on edit; 3.1 (central validation) builds on 2.1 + 2.2 and should absorb their helpers rather than duplicate them.
- 2.4(b) (SQL cap) depends on the lock-row pattern already used by credits; reuse `runAtomicWrite`.
- 2.5 and the ops workflow change ship together.
- 3.4's nonce work is the only item that needs a preview soak; do the `CSP_ENFORCE` flip only after a quiet report week.
- 3.6's key rotation must ship **before** any secret incident forces a rotation; it is the one item with a hard external deadline you cannot predict.
- Phase 4 items 2–4 can start immediately; item 1 trails each fix.

## Decisions needed from you

1. **H-01 shape:** remove `options` from the client-facing actions entirely (recommended; the UI does not use it) or keep a tiny allowlisted subset.
2. **H-02 charging policy:** settle aborted streams at the hold estimate (simple, slightly over-charges short answers) or at measured prompt tokens plus streamed output (accurate, more code).
3. **M-17:** flip `MCP_OAUTH_REQUIRE_SCOPES` now (existing scope-less connectors must reconnect) or default scope-less tokens to read-only first and announce a date.
4. **M-06:** make `PRODUCTION_DB_HOST` required in preview (breaks misconfigured previews on purpose).
5. **M-05 caps:** the numbers (notes 50k? reminder title 500?) and whether the lenient importers truncate or fail a row.
6. **M-15:** on `finish_reason=length`, retry with a bigger budget (costs more) or fail the capture with a clear error.
7. **M-09:** delete the Stripe customer on account deletion (loses the Stripe-side audit trail) or only tag it; delete `billing_events` rows or keep them anonymised for finance.
8. **M-08:** the retention windows, especially `email_sends` bodies and meeting transcripts, which users may expect to keep.
9. **L-09:** whether to invest in the nonce-based CSP now (High regression risk, several days) or only flip enforcement with `'unsafe-inline'` kept.
10. **New dependencies / services:** `eslint-plugin-security` and `gitleaks` in CI; GitHub secret scanning + push protection; a Neon branch per preview (removes M-06 structurally). None are required for Phases 1–2.
11. **Breaking behaviour to confirm:** `createContactsBulk` stops being a server action (becomes lib-only); chat proposals lose `email`; scope-less MCP tokens lose write; the deprecated `/api/mcp/[token]` route gets a retirement date.
12. **Scale:** whether the constellation should cap the drawn set at a fixed number (e.g. 5,000 most relevant) or paginate, which is a product decision more than an engineering one.
