# Local credential rotation — 2026-11

Finding **SEC-17** of the 2026-11 audit: the developer `.env.local` held live
credentials and was readable by every process on the machine. This document is the
rotation and cleanup runbook for that finding. Code fixes for the other findings
shipped in PR #529.

Nothing here needs a code change to start: each step is a provider dashboard action
plus a Vercel environment-variable update. Every step that changes a *serving*
credential does need a new deployment before it takes effect — see
[Build window](#build-window) before scheduling one.

## What was actually exposed

`.env.local` is ignored (`.gitignore:34`) and has never been tracked
(`git log --all -- .env.local` is empty), so this is a **local** exposure, not a
repository leak. `extension/.env.production` **is** tracked, but intentionally and it
contains only public values (publishable key, app URL, public extension key).

The file held:

| Key | Kind | Notes |
| --- | --- | --- |
| `DATABASE_URL` | **Production** Neon branch | `br-winter-flower-aud7dsc2` (the project's default branch), endpoint `ep-wispy-brook-aup2w57s` |
| `STRIPE_SECRET_KEY` | **Live** (`sk_live_…`) | not test mode |
| `STRIPE_WEBHOOK_SECRET` | **Live** (`whsec_…`) | |
| `VERCEL_API_TOKEN` | Account token | also stored in Vercel env |
| `NEON_API_KEY` | Project-scoped (`napi_…`) | |
| `BLOB_READ_WRITE_TOKEN` | Store token (`vercel_blob_…`) | |
| `RESEND_API_KEY` | `re_…` | |
| `OPENAI_API_KEY` | `sk-proj-…` | local-only; production uses `ORBIT_MANAGED_OPENAI_API_KEY` |
| `ANTHROPIC_API_KEY` | `sk-ant-…` | local-only; production uses `ORBIT_MANAGED_ANTHROPIC_API_KEY` |
| `GEMINI_API_KEY` | `AIza…` | also in 12 worktree copies |
| `DEEPGRAM_API_KEY` | | |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret | also in 12 worktree copies |
| `MICROSOFT_CLIENT_SECRET` | OAuth client secret | |
| `CLERK_SECRET_KEY` | **Test** instance (`sk_test_…`) | low risk |
| `ENCRYPTION_SECRET` | Dev placeholder | value is `orbit-dev-secret-change-me-in-prod`, which is committed in `src/lib/connectors/oauth.ts` — not a secret |
| `TYPESAFE_API_KEY` / `ORBIT_EVAL_TYPESAFE_KEY` | Eval key | identical values; one is redundant |

Fourteen stale `.claude/worktrees/*/.env.local` copies also existed. They do **not**
share the production database or the live Stripe keys, but 12 of them do carry the
same `GEMINI_API_KEY` and `GOOGLE_CLIENT_SECRET`.

## Already done (2026-11-07 → 11-08)

- `.env.local` is now mode `0600`.
- All 14 stale `.claude/worktrees/*/.env.local` copies removed (nothing under
  `.claude/worktrees` had changed since 2026-11-01). Only `.env.example` files remain
  in the worktrees.
- `extension/dist/` deleted (13 MB, 206 source maps). It is gitignored and
  rebuildable: `cd extension && npm run build` (or `npm run zip`).
- **Local development no longer points at production.** A Neon branch `dev`
  (`br-broad-morning-ausulm0j`, endpoint `ep-sparkling-paper-au160m2g`) was branched from
  `production`, and `.env.local` now uses its pooled URL. The production branch's
  credential is no longer on disk; rotating that credential (P0 #1) is still outstanding.

## Build window

A Vercel environment-variable change is inert until the next deployment: the running
deployment keeps the values it was built with. That matters here because rolling a
credential revokes the old one before the new one is live, so the order is always
**update Vercel → deploy → confirm → revoke**, not the other way round.

On 2026-11-08 the project hit Vercel's deployment rate limit ("retry in 24 hours",
first reported 08:08Z), so no new production build — and therefore no credential
rotation that production depends on — could be validated until roughly 08:08Z on
2026-11-09. Do the P0 rotations as one window after that: each rotation should cost
at most one deploy, not one deploy per key.

The same window also carries **SEC-15**: `CSP_ENFORCE=1` is now set for Production
and Preview, and the first successful build after it is what switches the policy from
`Content-Security-Policy-Report-Only` to `Content-Security-Policy`. Verify the header
on that deployment before treating SEC-15 as closed.

## Rotation, in order

Do the cheap, independent keys first, then the ones that can interrupt production.
Deploy (or redeploy) after the Vercel variables change.

### P0 — production data and money

1. **Neon database role.** *Local half done 2026-11-08:* development runs on the `dev`
   branch, so the production password is no longer in `.env.local`. What remains is the
   rotation itself.
   - Rotate the password of the role used by production `DATABASE_URL`.
   - Update Vercel: `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (Production), plus the
     `PG*` / `POSTGRES_*` preview variables that mirror them.
   - Keep local development on the `dev` branch; never point it back at production.
   - Verify: `npm run dev` boots and `/api/health` is 200; a Vercel production
     redeploy succeeds; the post-deploy workflow goes green.
   - Do this last in the P0 group: the app is down between the password roll and the
     Vercel update + redeploy.

2. **Stripe live secret key.**
   - Dashboard → Developers → API keys → roll the live secret key. Read Stripe's
     rollover notice first: if the old key is disabled immediately, every Stripe call
     fails between the roll and the deploy that carries the new value. Keep that gap to
     one deploy.
   - Update Vercel `STRIPE_SECRET_KEY` (Production and Preview) and `.env.local`.
   - Use **test** keys (`sk_test_…`) locally from now on; live mode should not be in
     a dev file at all.

3. **Stripe webhook signing secret.**
   - Roll the endpoint's signing secret in the dashboard, put the new value in Vercel
     `STRIPE_WEBHOOK_SECRET`, deploy, and confirm a test event is accepted before
     deleting the old secret. Stripe's exact overlap window is per-endpoint — do not
     assume one.
   - Update `.env.local` too.

### P1 — billable or account-takeover

For each: create the replacement, update Vercel (and local), confirm the feature, then
revoke the old key. Revoking before the replacement is live is what causes outages.

| Provider | Where | Vercel variables | Check |
| --- | --- | --- | --- |
| Vercel | Account → Tokens | `VERCEL_API_TOKEN` (also in Vercel env) | ops scripts still run |
| Neon | Project → API keys | `NEON_API_KEY` | branches/endpoints API returns 200 |
| Vercel Blob | Project → Stores → Tokens | `BLOB_READ_WRITE_TOKEN` | upload an attachment |
| Resend | API keys | `RESEND_API_KEY` | send a test email |
| OpenAI | API keys | `ORBIT_MANAGED_OPENAI_API_KEY` (prod), local `OPENAI_API_KEY` | managed AI run |
| Anthropic | API keys | `ORBIT_MANAGED_ANTHROPIC_API_KEY` (prod), local `ANTHROPIC_API_KEY` | managed AI run |
| Google Cloud | OAuth client → reset secret | `GOOGLE_CLIENT_SECRET` | connect Google |
| Entra / Azure | App registration → certificates & secrets | `MICROSOFT_CLIENT_SECRET` | connect Microsoft |
| Google AI | API keys | `GEMINI_API_KEY` | any Gemini path still enabled |
| Deepgram | API keys | `DEEPGRAM_API_KEY` | transcription / audio path |

### P2 — low risk

- **Clerk test secret** (`sk_test_…`): rotate from the test instance if you want the
  clean slate; no production impact.
- **`TYPESAFE_API_KEY` / `ORBIT_EVAL_TYPESAFE_KEY`**: same value twice — keep one,
  drop the other, rotate in the TypeSafe dashboard.
- **`ENCRYPTION_SECRET`**: local value is the committed dev default. That is fine for
  local dev; confirm that the **Vercel** production value is a real 32-byte secret and
  not the placeholder. Rotating the production value requires re-encrypting stored
  credentials, so treat that as its own migration, not part of this cleanup.

## Cleanup that is not rotation

- Worktree env files are gone. If a worktree needs one again, render a branch-scoped
  copy with a development role — do not copy the root `.env.local`.
- Drop the stale `NEXT_PUBLIC_APP_URL` from `.env.local`: nothing in `src/`, `scripts/`,
  `e2e/` or the extension reads it, and Vercel does not define it (`APP_BASE_URL` is
  the server-side one).
- Keep `.env.local` at `0600` and out of backups that sync to a shared location.

## Prevention

- **Never point local development at the production Neon branch.** Use a branch. The
  SEC-01 guard (`checkMigrationTarget` in `src/lib/env.ts`) only fails closed on
  Vercel builds; locally it returns `allowed` before it ever compares hosts.
- Set `PRODUCTION_DB_HOST=ep-wispy-brook-aup2w57s.c-10.us-east-1.aws.neon.tech` in
  `.env.local`. Optional follow-up: make `checkMigrationTarget` refuse a local
  `db:migrate` when `DATABASE_URL` matches `PRODUCTION_DB_HOST`. That would also block
  a local `npm run dev` if schema reconciliation refuses, so decide deliberately.
- Keep one source of truth (password manager / Doppler) and render `.env.local`;
  worktrees should render their own branch-scoped copy rather than inherit the root
  file.
- CI already scans for committed secrets (`audit · dependency review · secret scan`).

## Verification after all rotations

- `npm run dev` boots; `curl -s localhost:3000/api/health` → 200.
- Sign-in works; Settings → Integrations can connect Google and Microsoft.
- Stripe: a test-mode checkout completes and the webhook is accepted.
- A managed AI run (import or brief) succeeds.
- Vercel: new production deployment `success`, post-deploy workflow green, health
  endpoint reachable on the deployment URL.
- Re-run `npm run test:e2e` or at least `01`, `02`, `06` if the DB role changed.
