# Orbit

Personal networking tracker — capture contacts from notes, import LinkedIn CSV, track relationship strength, follow up on time, and ask AI who in your network can help.

## Stack

- Next.js (App Router) + TypeScript + Tailwind + shadcn/ui
- Clerk auth (optional — demo mode without keys)
- Neon Postgres **or** local on-disk PGlite (`.data/pglite` when `DATABASE_URL` is unset)
- Google Gemini (`@google/genai`) for note parsing, chat, and embeddings (BYOK in Settings or `GEMINI_API_KEY`)
- React Flow for the network graph

## Quick start

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or the port Next prints if 3000 is taken).

Without Clerk keys, the app runs as `demo-user`. Add a Gemini API key in **Settings** (or `GEMINI_API_KEY`) before using Capture / Chat. Default model: `gemini-3.5-flash`.

Optional demo contact:

```bash
npm run db:seed
```

Then restart `npm run dev` if the server was already running, so it reloads the shared PGlite database.

### Optional env

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon/Postgres connection (omit to use local `.data/pglite`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | Auth |
| `GEMINI_API_KEY` | Server-side Gemini AI (or add a key in Settings) |
| `ENCRYPTION_SECRET` | Encrypts user BYOK keys at rest |

## App surfaces

| Route | Purpose |
|---|---|
| `/` | Dashboard — follow-ups, suggestions, recent contacts |
| `/contacts` | Searchable contact list + profiles |
| `/capture` | Paste notes → AI extract → review → save |
| `/imports` | LinkedIn connections + messages, calendar ICS/CSV |
| `/chat` | Ask who in your network can help |
| `/graph` | Interactive network map |
| `/settings` | BYOK, export, delete data |

## Demo path

1. Settings → add Gemini API key
2. Capture → paste meeting notes → review AI extraction → save
3. Dashboard → see follow-up suggestions
4. Chat → “Who should I talk to about AI-assisted development?”
5. Graph → explore your network

Product spec: [docs/orbit_networking_tracker_spec.md](docs/orbit_networking_tracker_spec.md)
