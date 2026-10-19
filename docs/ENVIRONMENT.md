# Environment variables

`.env.example` is the copy-paste template; this page is the reference. `src/lib/env.ts` is the
contract the Vercel build enforces (`npm run check:env`). Most variables are read lazily at their call
site (there is no typed accessor), so a missing one degrades quietly: that is what the validation below
is for. Items marked *(verify)* depend on dashboard settings that can't be checked from the repository.

## How validation works

| Where | When | Fails on |
|---|---|---|
| `scripts/check-env.ts` (first step of the Vercel build command) | every Vercel build | **Production:** anything in `REQUIRED_IN_PRODUCTION`, every shape rule, the conditional rules and `FORBIDDEN_IN_PRODUCTION`. **Preview:** only `DATABASE_URL`, the two Clerk keys and `ENCRYPTION_SECRET` (`REQUIRED_IN_PREVIEW`); the other production-required names and an unset `PRODUCTION_DB_HOST` warn, and no shape checks run. **Local / CI:** warnings only |
| `src/instrumentation.ts` | each cold start (Node runtime) | nothing: it logs `[env]` errors, and in production the names of unset optional variables |
| the ops sweep (`ops.yml`, every 10 minutes) | production | raises `config.missing` / `config.alerts_undeliverable` (`lib/ops-alerts.ts`) |
| `scripts/smoke-env-documented.ts` | CI (smoke suite) | a literal `process.env.X` in `src/` that `.env.example` doesn't mention (dynamic reads, scripts and root configs are invisible to it) |

Production shape rules: `DATABASE_URL` is `postgres://`; the Clerk keys are `pk_live_` / `sk_live_`;
`CLERK_JWT_KEY` is PEM; `ENCRYPTION_SECRET` is ≥32 characters and not the placeholder; `CRON_SECRET`
and `ANALYTICS_SALT` are ≥16; `APP_BASE_URL` is https; `STRIPE_SECRET_KEY` is `sk_live_` and needs
`STRIPE_WEBHOOK_SECRET`; `SLACK_BOT_TOKEN` is `xoxb-` and is set together with
`SLACK_ALERT_USER_ID`; `WAITLIST_HOST` needs `WAITLIST_FROM_EMAIL` (and `WAITLIST_REPLY_TO`, if set) on a domain unrelated to the app's, and `WAITLIST_BASE_URL` is https. Nothing checks webhook secrets (`whsec_`), `RESEND_API_KEY`, `HEALTH_TOKEN` length or the shape of `ADMIN_USER_IDS`.

`NEXT_PUBLIC_*` and `CSP_ENFORCE` are read **at build time** (inlined into the bundle or `next.config.ts`). On Vercel every value
is frozen per deployment, so **redeploy after changing any variable**.

**Legend.** *Required:* `prod` = the production build fails without it; `expected` = the build
warns; `cond` = required when a related variable is set; `optional`; `dev` = local only;
`forbidden` = the production build fails if it's set. *Envs:* L = local, CI, P = Vercel Preview,
Prod = Vercel Production, GH = GitHub Actions.

## Core and database

| Variable | Required | Default if unset | Envs | Validated |
|---|---|---|---|---|
| `APP_BASE_URL` | prod | `https://$VERCEL_PROJECT_PRODUCTION_URL`, else `$VERCEL_URL`, else `http://localhost:$PORT` | all | presence + https (prod) |
| `ENCRYPTION_SECRET` | prod (also preview) | dev placeholder; **throws** under `NODE_ENV=production` (`lib/crypto.ts`) | all | ≥32 characters, not the placeholder (prod only) |
| `DATABASE_URL` | prod, preview | **local PGlite** in `.data/pglite`; `db:migrate` refuses on Vercel | all | `postgres://` |
| `PRODUCTION_DB_HOST` | expected (**set on all environments**) | the guard that stops a preview migrating production is off | P, Prod | presence |
| `ORBIT_PGLITE_DIR` | dev | `.data/pglite` | L, CI | — |
| `ORBIT_SIM_DB_LATENCY_MS` | dev | 0 | L | — |
| `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_GIT_*`, `VERCEL_DEPLOYMENT_ID`, `NODE_ENV`, `NEXT_RUNTIME`, `NEXT_PHASE`, `PORT`, `CI`, `NEXT_PUBLIC_VERCEL_ENV` (browser Sentry environment; *(verify)* needs Vercel's "Automatically expose System Environment Variables") | set by the platform | — | — | — |
| `BUILD_TIME` | set by `next.config.ts` at build; shown in `/api/health` and the admin system panel | — | — | — |

## Auth and access

| Variable | Required | Default if unset | Envs | Validated |
|---|---|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | prod, preview | demo mode on `next dev` (every caller is `demo-user`) | all (inlined at build) | `pk_live_` (prod) |
| `CLERK_SECRET_KEY` | prod, preview | demo mode | all | `sk_live_` (prod) |
| `CLERK_WEBHOOK_SIGNING_SECRET` | prod | the Clerk webhook rejects | P, Prod | presence |
| `CLERK_JWT_KEY` | optional | JWKS fetched per cold instance | P, Prod | PEM (prod) |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `…_SIGN_UP_URL`, `…_AFTER_SIGN_IN_URL`, `…_AFTER_SIGN_UP_URL` | optional | Clerk defaults | all | — |
| `ADMIN_USER_IDS` | prod | `/admin` returns 404 for everyone | Prod | presence |
| `EXTENSION_ORIGIN` | needed for the extension (**Production scope only**; on Preview it locks out preview sign-ins) | Clerk's default origin check | Prod | — |
| `MCP_OAUTH_REQUIRE_SCOPES` | optional (security; set to `1`) | a scope-less MCP OAuth token gets read + write. Whether it is set in production is *(verify)* | Prod | — |
| `EXTENSION_DEV_SECRET`, `EXTENSION_DEV_USER_ID` | dev; the secret is **forbidden** in prod | off (ignored unless `NODE_ENV=development`); `demo-user` | L | forbidden in prod |
| `DEMO_ACCOUNT_USER_ID` | **forbidden** in prod | off | P, L | forbidden in prod |

## AI and speech

| Variable | Required | Default if unset | Envs | Validated |
|---|---|---|---|---|
| `ORBIT_MANAGED_ANTHROPIC_API_KEY`, `ORBIT_MANAGED_OPENAI_API_KEY`, `ORBIT_MANAGED_GEMINI_API_KEY` | needed for included AI on every plan | included AI refused (`managed_unavailable`); ops alert | P, Prod | presence warning, only when Stripe is configured |
| `ORBIT_MANAGED_AI` | kill switch (`off`) | on. Managed AI is always on in code (`lib/managed-ai-policy.ts`); there is no flag for it | P, Prod | — |
| `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` | dev | none. **The first three are honoured as Orbit-paid managed keys wherever `VERCEL` is unset** (`next dev`, `next start`, tsx scripts; `managedKey` in `lib/ai-access.ts`). OpenRouter is never a managed provider | L | — |
| `TYPESAFE_API_KEY` | dev (TypeSafe is otherwise BYOK only) | none | L | — |
| `ORBIT_EVAL_GEMINI_KEY`, `ORBIT_EVAL_OPENAI_KEY`, `ORBIT_EVAL_ANTHROPIC_KEY`, `ORBIT_EVAL_TYPESAFE_KEY`, `ORBIT_EVAL_NETWORK` | dev; keys used by `scripts/eval-ai.ts` only | none | L | — |
| `ORBIT_JEV` | kill switch (`off`) | on | all | — |
| `ORBIT_DEMO_MANAGED_AI` | dev (`off` = localhost behaves like production) | dev keys used (needs `NODE_ENV=development` and no `VERCEL`) | L | — |
| `ORBIT_AI_RESULT_CACHE` | optional (`off`) | on | all | — |
| `DEEPGRAM_API_KEY` | expected | speech falls back to the user's OpenAI or Gemini key | P, Prod | presence |
| `DEEPGRAM_PROJECT_ID` | expected | nightly usage reconciliation skips | Prod | presence |
| `ORBIT_DEEPGRAM` | kill switch (`off`) | on when a key is present | all | — |

## Billing

| Variable | Required | Default if unset | Envs | Validated |
|---|---|---|---|---|
| `STRIPE_SECRET_KEY` | expected | `/pricing` shows "not on sale yet" | P, Prod | `sk_live_` (prod) |
| `STRIPE_WEBHOOK_SECRET` | cond (when `STRIPE_SECRET_KEY` is set) | the webhook answers 500 | P, Prod | presence |
| `STRIPE_LIFETIME_PRICE_ID`, `STRIPE_LIFETIME_STANDARD_PRICE_ID`, `STRIPE_PRO_MONTHLY_PRICE_ID`, `STRIPE_PRO_ANNUAL_PRICE_ID` | **retired**: prices resolve by lookup key since pricing v2 (`lib/stripe-prices.ts`, created by `scripts/stripe-pricing-v2.ts`); `src/` ignores them and only `playwright.config.ts` still forwards three | — | — | — |

## Email and SMS

| Variable | Required | Default if unset | Envs | Validated |
|---|---|---|---|---|
| `RESEND_API_KEY` | prod | mail not sent | P, Prod | presence |
| `RESEND_FROM_EMAIL` | prod | outreach falls back to `outreach@orbit.local` | P, Prod | presence |
| `RESEND_WEBHOOK_SECRET` | expected | bounces never recorded | Prod | presence |
| `CONTACT_INBOX_EMAIL`, `CONTACT_FROM_EMAIL` | optional | `/contact` form hidden; From falls back to `RESEND_FROM_EMAIL` | Prod | — |
| `WAITLIST_HOST`, `WAITLIST_BASE_URL`, `WAITLIST_FROM_EMAIL`, `WAITLIST_REPLY_TO` | optional; `FROM` is cond on `HOST` | waitlist served at `/interest` | Prod | domain separation (prod) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | optional (Outreach, gated) | users bring their own | Prod | — |

## Integrations and storage

| Variable | Required | Default if unset | Envs | Validated |
|---|---|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | expected | Google connect unavailable | all | presence |
| `GOOGLE_REDIRECT_URI` | expected (**effectively required when the client id is set**: connect throws without it) | throws at connect | all | presence |
| `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY`, `NEXT_PUBLIC_GOOGLE_APP_ID` | optional | Drive import button off | all | — |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI` | expected (same redirect caveat) | Outlook unavailable | all | presence |
| `MICROSOFT_TENANT_ID` | optional | `common` | all | — |
| `EVENTBRITE_CLIENT_ID`, `EVENTBRITE_CLIENT_SECRET`, `EVENTBRITE_REDIRECT_URI` | optional | connect unavailable; redirect defaults to `APP_BASE_URL/api/events/eventbrite/callback` | all | — |
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | optional (HubSpot is `availability: "planned"` in `lib/connectors/registry.ts`) | "not configured" | — | — |
| `APOLLO_API_KEY` | **effectively unused**: read only for plans with `hostedEnrichment`, which no plan has (`lib/apollo.ts`); users bring their own key | users' own Apollo key in Settings | — | — |
| `MICROLINK_API_KEY` | optional | free tier, slower LinkedIn photo backfill | Prod | — |
| `BLOB_READ_WRITE_TOKEN` (or `BLOB_STORE_ID` + `VERCEL_OIDC_TOKEN`) | expected | photos stored inline on the row | P, Prod | presence |
| `NEXT_PUBLIC_EXTENSION_URL` | optional | "Add to Chrome" shows as coming soon | all | — |

## Observability and ops

| Variable | Required | Default if unset | Envs | Validated |
|---|---|---|---|---|
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | expected | Sentry inert | P, Prod | presence |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | needed for readable stack traces | **no source-map upload, silently** | Vercel build (CI blanks the token) | — |
| `SENTRY_PROJECT_URL` | optional | no admin link in `/admin/health` | Prod | — |
| `SLACK_OPS_WEBHOOK_URL`, `SLACK_OPS_CRITICAL_WEBHOOK_URL` | expected | alerts only on `/admin/health` | Prod, GH | presence |
| `SLACK_BOT_TOKEN`, `SLACK_ALERT_USER_ID` | expected (both or neither) | webhook fallback | Prod | `xoxb-`, paired |
| `BETTERSTACK_HEARTBEAT_URL` | expected | no dead-scheduler detection (the sweep pings it) | Prod | presence |
| `HEALTH_TOKEN` | expected | deep `/api/health` view off | Prod | presence (no minimum length) |
| `ANALYTICS_SALT` | expected | `/api/track` records nothing | Prod | ≥16 |
| `CRON_SECRET` | prod; **must equal the GitHub `ops` secret** | internal routes answer 401 whenever `NODE_ENV` isn't `development` or `VERCEL` is set; open only on `next dev` | P, Prod, GH | ≥16 |
| `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`, `NEON_API_KEY`, `NEON_PROJECT_ID`, `ADMIN_<PROVIDER>_DASHBOARD_URL` (`BLOB`, `RESEND`, `SLACK`, `DEEPGRAM`, `ANTHROPIC`, `OPENAI`, `GOOGLE`, `MICROSOFT`, `VERCEL`, `NEON`, `CLERK`, `STRIPE`) | optional (admin provider panel) | "unconfigured" / default links | Prod | — |

## Flags and kill switches

| Switch | Effect | Where it lives |
|---|---|---|
| `ORBIT_MANAGED_AI=off` | every plan falls back to the account's own key | env (redeploy) |
| `/admin/billing` included AI on/paused (`site_settings.managed_ai_paused`) | same, without a deploy. **A never-set value reads as paused when `VERCEL_ENV=production`** (`managedAiPausedDefault`), so a fresh or restored database turns included AI off | DB |
| `ORBIT_DEEPGRAM=off`, `ORBIT_JEV=off`, `ORBIT_AI_RESULT_CACHE=off` | speech fallback / decision model off / no AI answer cache | env |
| `/admin/product` (`app_surface_flags`) | hide a surface or mark it coming soon | DB |
| `SITE_STEALTH=1` | stealth default; the `/admin` switch overrides it once set. `/api/v1/openapi.json` 404s while stealthy | env + DB |
| `CSP_ENFORCE=1` | enforce CSP instead of report-only | env (build) |
| `MCP_OAUTH_REQUIRE_SCOPES=1` | refuse scope-less MCP OAuth tokens | env |

## Local development and tests

Nothing is required locally. Knobs: `ORBIT_DEMO_DATA=off`, `ORBIT_DEMO_PERSONA=student|gillings`,
`ORBIT_DEMO_MANAGED_AI=off`, `ORBIT_PGLITE_DIR`, `ORBIT_SIM_DB_LATENCY_MS`, `ORBIT_BENCH=1` (builds
the `*.bench.tsx` routes under `src/app/bench`, see `pageExtensions` in `next.config.ts`). Tooling-only variables such
as `BENCH_URL`, `APPLE_ID` / `APPLE_APP_PASSWORD` (`scripts/dev/icloud-caldav-probe.ts`), `SCAN_TOKEN` and
`RESEND_BASE_URL` (a smoke's fake server) are read by `scripts/` only.

**Careful:** if `.env.local` sets `DATABASE_URL` to a remote database, `npm run db:migrate` and every
`scripts/backfill-*` will write to it. Smoke scripts are fenced: `scripts/smoke/_env.ts` deletes
`DATABASE_URL` unless `SMOKE_ALLOW_REMOTE=1`, and strips provider keys unless
`SMOKE_ALLOW_PROVIDER_KEYS=1`. E2E knobs: `E2E_PORT`, `E2E_AI_STUB_PORT`, `E2E_PGLITE_DIR`;
`GOOGLE_GEMINI_BASE_URL` (read by the `@google/genai` SDK, not by Orbit) points it at the stub.

## Browser extension (`extension/`)

`extension/.env.production` is committed and holds public values only: `VITE_ORBIT_APP_URL`,
`VITE_CLERK_PUBLISHABLE_KEY` (`pk_live_`), `VITE_CLERK_FRONTEND_API`, `VITE_EXTENSION_KEY` (pins the
extension id). `VITE_ORBIT_DEV_SECRET` (dev only) matches the app's `EXTENSION_DEV_SECRET`.
`manifest.config.ts` refuses a production build with localhost or missing values.

## GitHub Actions secrets

- This repo (`ops.yml`): `APP_URL` (must equal `APP_BASE_URL`), `CRON_SECRET` (must equal Vercel's),
  `SLACK_OPS_CRITICAL_WEBHOOK_URL`.
- Private ops repo (backup) *(verify)*: `DATABASE_URL` (direct host, not `-pooler`),
  `BACKUP_AGE_PUBLIC_KEY`, `SLACK_OPS_CRITICAL_WEBHOOK_URL`, `BETTERSTACK_BACKUP_HEARTBEAT_URL`.

## Preview deployments *(verify in Vercel)*

- Scope `DATABASE_URL` to Production only; previews get a Neon branch.
- Set `PRODUCTION_DB_HOST` on all environments.
- Use Clerk and Stripe **test** keys on Preview; the build doesn't check key mode outside production.
- Don't set `EXTENSION_ORIGIN` on Preview.
