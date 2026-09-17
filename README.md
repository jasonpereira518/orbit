<p align="center">
  <img src="public/orbit-logo.png" width="72" alt="Orbit logo" />
</p>

<h1 align="center">Orbit</h1>

<p align="center">
  Keep every connection in orbit.<br/>
  Your people, your last conversation, your next follow-up — all in one place.
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" />
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-black" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-blue" />
</p>

Orbit is a personal networking CRM. Paste in messy notes from a coffee chat or conference and it extracts the people, tracks who you should follow up with, and lets you ask your own network questions like *"who do I know at OpenAI?"*

## Screenshots

| | |
|---|---|
| **Landing** | **Dashboard** |
| ![Landing page](docs/screenshots/landing.png) | ![Dashboard](docs/screenshots/dashboard.png) |
| **Capture — AI note extraction** | **Constellation — network map** |
| ![Capture](docs/screenshots/capture.png) | ![Constellation graph](docs/screenshots/graph.png) |
| **Chat with your network** | |
| ![Chat](docs/screenshots/chat.png) | |

## Features

- **Capture** — paste raw notes (one person or many), let AI pull out contacts, companies, and context, review, then save. Unsaved notes are kept as you type, phones get a "Scan business card" camera button, and recent captures stay listed on the page with the original notes and photos one click away
- **Command palette** — ⌘K / Ctrl+K from anywhere: jump to a person or page, start a capture, "Capture this" to send what you typed straight to Capture, or hand a question to the ask bar (⌘J)
- **Contacts** — searchable list + profiles, relationship strength, recruiter tracking
- **Dashboard** — follow-ups, dormant connections, and suggestions in one view
- **Chat** — ask natural-language questions about who's in your network and who can help
- **Constellation** — an interactive star-chart of your network, clustered by company and school
- **Imports** — LinkedIn CSV/message exports, address-book files (vCard `.vcf` or Google/Outlook contacts CSV — no account connection needed), calendar ICS subscribe/upload, Gmail inbox (recruiter threads)
- **Outreach** — search prospects (via Apollo) and send tracked email/SMS campaigns
- **Knowledge base** — everything Orbit has learned about your network from notes, imports, and summaries in one searchable place
- **Reminders** — timed follow-up nudges so no relationship goes cold
- **Settings** — bring your own AI key (Gemini/OpenAI/Anthropic), export your data, delete your data

## Stack

- Next.js (App Router) + TypeScript + Tailwind + shadcn/ui
- Clerk auth (optional — demo mode without keys)
- Neon Postgres **or** local on-disk PGlite (`.data/pglite` when `DATABASE_URL` is unset)
- Google Gemini (`@google/genai`), OpenAI, and Anthropic for note parsing, chat, and embeddings (BYOK in Settings, or server-side keys)
- React Flow for the network graph

## Quick start

```bash
cp .env.example .env.local
npm ci             # a fresh git worktree has no node_modules of its own
npm run db:setup   # create tables (Neon via DATABASE_URL, or local PGlite)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or the port Next prints if 3000 is taken).

Add a Gemini, OpenAI, or Anthropic API key in **Settings → Integrations → AI provider** (or the matching env var, honoured locally only) before using Capture / Chat.

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

Optional demo contact:

```bash
npm run db:seed
```

Restart `npm run dev` afterward if the server was already running, so it reloads the shared PGlite database.

### Database

| Command | Purpose |
|---|---|
| `npm run db:setup` | Bootstrap schema + verify read/write |
| `npm run db:migrate` | Reconcile the schema to `SCHEMA_VERSION` — what every Vercel build runs before `next build` |
| `npm run db:check` | Fail when DDL changed without a `SCHEMA_VERSION` bump |
| `npm run db:push:DANGEROUS` | `drizzle-kit push`. Refused unless `ALLOW_DRIZZLE_PUSH=1` and `DATABASE_URL` is not `PRODUCTION_DB_HOST`; prefer `db:migrate` |
| `npm run db:generate` | Generate SQL migrations under `drizzle/` (reference only; the app never applies them) |
| `npm run db:seed` | Insert a sample contact for `demo-user` |

Leave `DATABASE_URL` unset to use on-disk PGlite (`.data/pglite`). Schema changes go in `src/db/index.ts` — read the comment above `SCHEMA_VERSION` first. There is deliberately no plain `db:push`: `drizzle-kit push` would drop columns Orbit manages outside `schema.ts` (`embedding_vector`, the HNSW index, the migration tables).

### Env vars

`.env.example` is the complete, commented list — `scripts/smoke-env-documented.ts` fails CI when the code reads a variable it does not mention. `src/lib/env.ts` says what production requires (`REQUIRED_IN_PRODUCTION`, which fails the build) and expects (`EXPECTED_IN_PRODUCTION`, which warns). To get started you need at most:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon/Postgres connection (omit to use local `.data/pglite`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | Auth (omit locally for demo mode) |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Server-side AI, local dev only — on Vercel every user brings a key |
| `ENCRYPTION_SECRET` | Encrypts BYOK keys and OAuth tokens at rest |
| `ORBIT_DEMO_DATA=off` | Start local accounts empty, for onboarding work |

## App surfaces

| Route | Purpose |
|---|---|
| `/` | Marketing landing |
| `/dashboard` | Follow-ups, suggestions, recent contacts |
| `/onboarding` | First-run tutorial — add or import your first people |
| `/contacts` | Searchable contact list + profiles |
| `/recruiters` | Recruiter tracking, linked from Contacts |
| `/capture` | Paste notes → AI extract → review → save; recent captures below |
| `/capture/[id]` | One capture: the original notes and photos, and what they produced |
| `/imports` | LinkedIn connections + messages, vCard / contacts CSV, calendar ICS, Gmail |
| `/chat` | Ask who in your network can help |
| `/graph` | Constellation — interactive network map |
| `/knowledge` | Searchable knowledge base built from notes, imports, and summaries |
| `/outreach` | Prospect search (Apollo) + tracked email/SMS campaigns |
| `/reminders` | Follow-up reminders |
| `/settings` | BYOK, export, delete data |

## Demo path

1. Settings → add an AI API key
2. Capture → paste meeting notes → review AI extraction → save
3. Dashboard → see follow-up suggestions
4. Chat → "Who should I talk to about AI-assisted development?"
5. Constellation → explore your network

## License

MIT — see [LICENSE](LICENSE).

Product spec: [docs/orbit_networking_tracker_spec.md](docs/orbit_networking_tracker_spec.md)
