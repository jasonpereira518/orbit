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

- **Capture** — paste raw notes (one person or many), let AI pull out contacts, companies, and context, review, then save
- **Contacts** — searchable list + profiles, relationship strength, recruiter tracking
- **Dashboard** — follow-ups, dormant connections, and suggestions in one view
- **Chat** — ask natural-language questions about who's in your network and who can help
- **Constellation** — an interactive star-chart of your network, clustered by company and school
- **Imports** — LinkedIn CSV/message exports, calendar ICS subscribe/upload, Gmail inbox (recruiter threads)
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
npm install
npm run db:setup   # create tables (Neon via DATABASE_URL, or local PGlite)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or the port Next prints if 3000 is taken).

Without Clerk keys, the app runs as `demo-user` in development only. Add a Gemini, OpenAI, or Anthropic API key in **Settings** (or the matching env var) before using Capture / Chat.

Optional demo contact:

```bash
npm run db:seed
```

Restart `npm run dev` afterward if the server was already running, so it reloads the shared PGlite database.

### Database

| Command | Purpose |
|---|---|
| `npm run db:setup` | Bootstrap schema + verify read/write |
| `npm run db:push` | Sync Drizzle schema to `DATABASE_URL` (Postgres/Neon) |
| `npm run db:generate` | Generate SQL migrations under `drizzle/` |
| `npm run db:seed` | Insert a sample contact for `demo-user` |

Leave `DATABASE_URL` unset to use on-disk PGlite (`.data/pglite`). Set it to a Neon/Postgres URL for remote data.

### Env vars

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon/Postgres connection (omit to use local `.data/pglite`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | Auth |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Clerk webhooks (`user.created` / `user.deleted`) |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Server-side AI (or add a key in Settings) |
| `ENCRYPTION_SECRET` | Encrypts user BYOK keys at rest |
| `MICROLINK_API_KEY` | Optional — higher LinkedIn photo lookup quota |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Optional — Gmail import (recruiter inbox) |

A few features also read credentials that aren't in `.env.example` yet: an **Apollo** API key for live outreach prospect search (falls back to demo results without one), and **Resend**/**Twilio** credentials for sending outreach email/SMS.

## App surfaces

| Route | Purpose |
|---|---|
| `/` | Marketing landing |
| `/dashboard` | Follow-ups, suggestions, recent contacts |
| `/onboarding` | First-run tutorial — add or import your first people |
| `/contacts` | Searchable contact list + profiles |
| `/recruiters` | Recruiter tracking, linked from Contacts |
| `/capture` | Paste notes → AI extract → review → save |
| `/imports` | LinkedIn connections + messages, calendar ICS, Gmail |
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
