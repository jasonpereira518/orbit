# Orbit

Personal networking tracker — capture contacts from notes, import LinkedIn CSV, track relationship strength, follow up on time, and ask AI who in your network can help.

## Stack

- Next.js (App Router) + TypeScript + Tailwind + shadcn/ui
- Clerk auth (optional — demo mode without keys)
- Neon Postgres **or** local PGlite (no `DATABASE_URL` needed)
- OpenAI for note parsing, chat, and embeddings (BYOK in Settings or `OPENAI_API_KEY`)
- React Flow for the network graph

## Quick start

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Optional env

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon/Postgres connection (omit to use local `.data/pglite`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | Auth |
| `OPENAI_API_KEY` | Server-side AI (or add a key in Settings) |
| `ENCRYPTION_SECRET` | Encrypts user BYOK keys at rest |

## Demo path

1. Settings → add OpenAI API key
2. Capture → paste meeting notes → review AI extraction → save
3. Dashboard → see follow-up suggestions
4. Chat → “Who should I talk to about AI-assisted development?”
5. Graph → explore your network

Product spec: [docs/orbit_networking_tracker_spec.md](docs/orbit_networking_tracker_spec.md)
