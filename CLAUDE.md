@AGENTS.md

# Orbit repo rules

Rules that apply to every change here. Detail lives in [docs/](docs/README.md).

- **Fresh worktree:** run `npm ci`. Never symlink another checkout's `node_modules`. With no `.env.local`, the app runs in demo mode on local PGlite ([DEVELOPMENT.md](docs/DEVELOPMENT.md)).
- **One writer per `.data/pglite`:** stop `next dev` before running a seed, a script that writes, or `npm run build`. Two writers corrupt it.
- **Schema changes** go in `src/db/index.ts` with a `SCHEMA_VERSION` bump. Read the comment above it first. `npm run db:check` fails when DDL changed without a bump. If a branch's DDL merges after main moved, it needs a new version, not the old one.
- **Never run `drizzle-kit push`** (`db:push:DANGEROUS`). It drops the columns Orbit manages outside `schema.ts`. Use `npm run db:migrate`.
- **Provider keys come only from `src/lib/ai-access.ts`.** Don't read AI keys anywhere else.
- **A new env var goes in `.env.example`**, or `smoke-env-documented` fails CI. Production requirements are in `src/lib/env.ts`.
- **Error copy:** show `friendlyError()` / `UserFacingError` (`src/lib/errors.ts`), never `err.message`. `smoke-toast-copy` enforces this.
- **Coming-soon pages** are flagged in `src/lib/surfaces.ts` (`comingSoon`). They are closed for admins too.
- **Tests:** a change comes with its smoke script (`scripts/smoke-*.ts`). Register each new script in the `MANIFEST` in `scripts/run-smoke.ts`, or `npm run test:check` fails. Run `npm test` before committing ([TESTING.md](docs/TESTING.md)).
- **Don't hand-edit `AGENTS.md`.** `next dev` rewrites it.
- **Docs:** if a change alters what a living doc in `docs/README.md` describes, update that doc in the same change. Finished specs and plans go to `docs/archive/`.
