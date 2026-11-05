# Development

How to run Orbit locally. The product overview lives in [README.md](../README.md).

## Stack

- Next.js (App Router) + TypeScript + Tailwind + shadcn/ui
- Clerk auth (optional — demo mode without keys)
- Neon Postgres **or** local on-disk PGlite (`.data/pglite` when `DATABASE_URL` is unset)
- Google Gemini (`@google/genai`), OpenAI, and Anthropic for note parsing, chat, and embeddings. Included AI runs on Orbit's managed keys (`ORBIT_MANAGED_*_API_KEY`, only ever read by `src/lib/ai-access.ts`); any account can bring its own Gemini, OpenAI, Anthropic, or OpenRouter key in Settings
- Deepgram for speech-to-text (voice notes and meetings)
- React Flow (`@xyflow/react`) for the network graph; three.js for the landing globe and the sky camera

## Quick start

```bash
cp .env.example .env.local
npm ci             # a fresh git worktree has no node_modules of its own
npm run db:setup   # create tables (Neon via DATABASE_URL, or local PGlite)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or the port Next prints if 3000 is taken).

For Capture and Chat, put `GEMINI_API_KEY` (or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) in `.env.local`: `next dev` runs AI on it automatically, and no deployment ever reads it. A key saved in **Settings → Integrations → AI provider** wins over it. `ORBIT_DEMO_MANAGED_AI=off` makes localhost behave like an account with no included AI, for the "add your key" states.

### Three ways to run it locally

| You want | Run | What you get |
|---|---|---|
| The product with data in it (default) | `npm run dev`, with `DATABASE_URL` and the Clerk keys unset | Signed in as `demo-user` on local PGlite; an empty account gets a full demo workspace on its first request; plan limits are lifted on localhost |
| Empty states and onboarding | `ORBIT_DEMO_DATA=off npm run dev` | The same, with nothing seeded |
| The real sign-in surface | put the `pk_test_…` / `sk_test_…` Clerk keys in `.env.local`, keep `DATABASE_URL` unset, `npm run dev` | Clerk sign-in against your test instance, your account on local PGlite (seeded on first request unless `ORBIT_DEMO_DATA=off`) |

Things that catch people out:

- **A git worktree has no `node_modules`.** Run `npm ci` inside it; symlinking the main checkout's breaks as soon as the branch's dependencies differ.
- **`.data/pglite` outlives branches.** It may hold fixtures from another branch or an old smoke run. **Settings → Data and privacy → Delete data** clears your account’s data, and on localhost the demo workspace re-seeds on the next request.
- **One writer per `.data/pglite`.** Stop the dev server before running any script that writes to the local database; two writers corrupt it. `ORBIT_PGLITE_DIR=$(mktemp -d)` gives a throwaway database instead.
- **The port is part of Google OAuth.** Changing it breaks Gmail and Google Contacts until `GOOGLE_REDIRECT_URI` and the redirect URI in the Google Cloud console use the new port.
- **Demo sign-in links** (`scripts/demo-signin-link.ts`) need the Clerk user to exist in that instance first: `CLERK_SECRET_KEY=sk_test_… npx tsx scripts/provision-demo-account.ts`.

Extra seed data (stop `npm run dev` first; see the one-writer rule above):

```bash
npm run db:seed         # a few sample contacts, interactions, and recruiters for demo-user
npm run db:seed:graph   # 114 deterministic contacts for constellation work
```

`npm run db:seed:showcase -- --user <id>` fills one account with the full demo workspace, including a real account on a deployed database. Read its header first: `--reset` deletes that account's data.

### Database

| Command | Purpose |
|---|---|
| `npm run db:setup` | Bootstrap schema + verify read/write |
| `npm run db:migrate` | Reconcile the schema to `SCHEMA_VERSION` — what every Vercel build runs before `next build` |
| `npm run db:check` | Fail when DDL changed without a `SCHEMA_VERSION` bump |
| `npm run db:push:DANGEROUS` | `drizzle-kit push`. Refused unless `ALLOW_DRIZZLE_PUSH=1` and `DATABASE_URL` is not `PRODUCTION_DB_HOST`; prefer `db:migrate` |
| `npm run db:generate` | Generate SQL migrations under `drizzle/` (reference only; the app never applies them) |
| `npm run db:seed` / `db:seed:graph` / `db:seed:showcase` | Seed data, see above |

Leave `DATABASE_URL` unset to use on-disk PGlite (`.data/pglite`). Schema changes go in `src/db/index.ts` — read the comment above `SCHEMA_VERSION` first. There is deliberately no plain `db:push`: `drizzle-kit push` would drop columns Orbit manages outside `schema.ts` (`embedding_vector`, the HNSW index, the migration tables).

### Env vars

`.env.example` is the complete, commented list — `scripts/smoke-env-documented.ts` fails CI when the code reads a variable it does not mention. `src/lib/env.ts` says what production requires (`REQUIRED_IN_PRODUCTION`, which fails the build) and expects (`EXPECTED_IN_PRODUCTION`, which warns). To get started you need at most:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon/Postgres connection (omit to use local `.data/pglite`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | Auth (omit locally for demo mode) |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | AI for `next dev` only. Deployments run included AI on `ORBIT_MANAGED_*_API_KEY` |
| `ENCRYPTION_SECRET` | Encrypts BYOK keys and OAuth tokens at rest |
| `ORBIT_DEMO_DATA=off` | Start local accounts empty, for onboarding work |
| `ORBIT_DEMO_PERSONA=student` | Seeds a student / new-grad workspace instead of the founder one (localhost only) |

## App surfaces

Pages marked *coming soon* are closed by `comingSoon` in `src/lib/surfaces.ts`, for admins too, unless the preview cookie is set.

**App** (signed in)

| Route | Purpose |
|---|---|
| `/dashboard` | Follow-ups, suggestions, recent contacts |
| `/onboarding`, `/onboarding/wizard` | First run: quick setup or the guided tour, then add or import your first people |
| `/contacts`, `/contacts/[id]`, `/contacts/new` | Searchable contact list, profiles, and adding one by hand |
| `/contacts/duplicates` | Possible duplicates the app couldn't merge on its own |
| `/recruiters` (+ `/[id]`, `/new`, `/compose`) | Recruiter tracking, reached from Contacts |
| `/capture` | Paste notes or photos → AI extract → review → save; recent captures below |
| `/capture/[batchId]` | One capture: the original notes and photos, and what they produced |
| `/meetings`, `/meetings/[id]` | Record a meeting, review its people inline, browse past meetings |
| `/meetings/g/[batchId]` | One Granola meeting |
| `/imports` | LinkedIn connections + messages, vCard / contacts CSV, calendar ICS, Gmail |
| `/chat` | Ask who in your network can help |
| `/graph` | Constellation, the interactive network map |
| `/knowledge` | Searchable knowledge base built from notes, imports, and summaries |
| `/reminders` | Follow-up reminders |
| `/radar` | Who to reach out to this week, and why, rebuilt nightly (*coming soon*) |
| `/events`, `/events/[id]` | Events you went to, their guest lists, who you spoke to (*coming soon*) |
| `/find` | Research people outside your network (*coming soon*) |
| `/outreach` (+ `/[id]`, `/new`) | Prospects and tracked email/SMS campaigns (*coming soon*) |
| `/settings` | Integrations, AI keys, plan, export, delete data |
| `/upgrade` | Checkout |
| `/suspended` | What a suspended account sees |
| `/admin/*` | Admin console: health, users, billing, analytics, growth, feedback, access |

**Public**

| Route | Purpose |
|---|---|
| `/` | Marketing landing |
| `/pricing` | Plans |
| `/connect` | How to use Orbit from Claude or ChatGPT |
| `/interest` | The waitlist |
| `/privacy`, `/terms`, `/contact` | Legal and contact |
| `/scan/[token]` | Where a phone lands after scanning the desktop QR code; no sign-in needed |

## Demo path

1. Settings → add an AI API key
2. Capture → paste meeting notes → review AI extraction → save
3. Dashboard → see follow-up suggestions
4. Chat → "Who should I talk to about AI-assisted development?"
5. Constellation → explore your network
