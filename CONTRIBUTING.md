# Contributing

Start with [README.md](README.md#for-developers) to run the app, then [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
This Next.js has breaking changes from older versions: read the relevant guide in
`node_modules/next/dist/docs/` before writing framework code (see `AGENTS.md`).

## Where new code goes

| You are adding | It goes in | Rules |
|---|---|---|
| A page | `src/app/(clerk)/(app)/(main)/<area>/page.tsx` (server component) | Call `src/lib` loaders. No direct DB queries |
| A mutation the app's own UI calls | `src/actions/<area>.ts` (`"use server"`) | See "Server actions" below |
| Domain logic, queries, integrations | `src/lib/**` | Takes `userId` as a parameter; never reads the session |
| A streaming, upload, webhook, OAuth callback, REST v1, MCP, extension or job endpoint | `src/app/api/**/route.ts` | Only what an action can't do. Job routes check `isInternalRequest` (`CRON_SECRET`) |
| Table or column | `src/db/schema.ts` **and** `src/db/index.ts` | See "Schema changes" |
| UI | `src/components/**` | Never import `@/db` values, `node:*` or server-only modules. Call an action |
| An MCP or chat tool | `src/lib/tools/definitions.ts` | Read the security comment at the top of `src/lib/mcp/server.ts` first; then `npx tsx scripts/gen-mcp-docs.ts` |
| An AI call | `src/lib/ai.ts` (`completeJson`) | Only `src/lib/ai*.ts` import provider SDKs. Keys come from `ai-access.ts` |
| Scheduled or long-running work | A job route plus DB job rows | Lease, time budget, `cron_runs` row; add the schedule to `.github/workflows/ops.yml` |
| An env var | Read it, then document it | `.env.example`, [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md), and `src/lib/env.ts` if production needs it |

## Server actions

Every export of a `"use server"` file is a public POST endpoint.

1. Derive the user from the session (`requireUserId()` or a surface/admin guard built on it). Never accept a
   `userId` parameter from the caller. `scripts/smoke-action-user-scope.ts` fails on it.
2. Validate input. Don't trust types: callers can post anything.
3. Call `src/lib`, passing `userId`. Keep domain logic out of the action, and don't call other actions.
4. Group writes with `runAtomicWrite` / `runAtomicBatch`. Never call `db.transaction` or `db.batch` directly
   (Neon HTTP has no interactive transactions).
5. `revalidatePath` what changed.
6. Return `ActionResult` (`{ ok: true, value } | { ok: false, error }`, `src/lib/errors.ts`), not ad hoc shapes.
7. In a `catch`, call `reportError` (`src/lib/report-error.ts`) so it reaches Sentry. If swallowing is
   intentional, say why in a comment (`// best-effort: <why>`). ESLint enforces the rest:
   `no-console` forbids `console.error`/`log`/`info` in `src/actions`, `src/lib` and `src/app`
   (a bare `console.error` reaches only Vercel's runtime log, which keeps it about an hour);
   `console.warn` is allowed for expected-degradation notices. Use `level: "warning"` for
   best-effort paths with a backstop (throttled to one per minute per `where`).
8. Every tenant query filters on `user_id`. There are no foreign keys or row-level security to catch a miss.

## Schema changes

The database is built by hand-written SQL, not by generated migrations ([ADR 0001](docs/adr/0001-hand-written-ddl.md)). `drizzle-kit` is not a dependency.

1. Add the column or table to `src/db/schema.ts`.
2. Add it to the `DDL` template in `src/db/index.ts` (and `SCALE_DDL` for generated columns or indexes).
3. Add an idempotent `ALTER ... IF NOT EXISTS` to the Neon `alters` list.
4. Add an `ensureColumn(...)` call in `migratePglite`.
5. Bump `SCHEMA_VERSION` and add a line to the changelog comment above it. The fingerprint does not cover
   `ensureColumn` calls, so don't rely on CI to remind you.
6. `npm run db:check`, then `npx tsx scripts/smoke-schema-ddl.ts --update` to rewrite
   `scripts/schema-ddl.lock.json`. Commit both.
7. User-scoped table: add its delete to `STEPS` in `src/lib/user-data.ts`.
8. Expand, then contract: the migration runs in the Vercel build *before* `next build`, so the old code must
   survive the new schema. Add first, remove the code in a later deploy, and drop only after that
   ([ADR 0009](docs/adr/0009-migrate-in-the-vercel-build.md)).

Do not reintroduce `drizzle-kit push`: it would drop `embedding_vector` and the HNSW index.

## Naming

Apply these to new code. Rename only when you are already touching a file, never as a sweep.

- `get` returns one thing or null. `list` returns many or a page. `load` builds a page view-model.
  `fetch` means outbound HTTP only.
- Server actions end in `Action`. Library writes that take a `userId` end in `ForUser`.
- Files are kebab-case. Tests sit next to the code as `*.test.ts`.

## Checks

Run the gate before opening a PR (CI runs the same):

```bash
npm run typecheck
npm run lint            # warning count must not rise
npm test                # smoke suite on throwaway PGlite; --shard i/n or --only <name> to narrow
npm run test:unit       # node:test unit tests (src/**/*.test.ts, scripts/**/*.test.ts)
npm run test:e2e        # Playwright against next dev with a stub AI server
npm run build
```

Also useful: `npm run test:check` (every smoke script is in the manifest) and `npm run db:check`.
`npx tsx scripts/smoke-env-documented.ts` and `npx tsx scripts/smoke-schedules.ts` check the env and
schedule docs. Smoke scripts run on a throwaway database and strip provider keys (`scripts/smoke/_env.ts`);
set `SMOKE_ALLOW_REMOTE` or `SMOKE_ALLOW_PROVIDER_KEYS` only on purpose.

## Pull requests

- One kind of change per PR: a deletion, a mechanical move, or a behaviour change. A mechanical PR must leave
  `tsc`, the DDL fingerprint and smoke results unchanged.
- Say what changed and why, and how you tested it. A behaviour change adds or updates a test first.
- Mention the new env var, schema version or schedule if you added one, and update the docs it touches.
- Coordinate before touching `src/db/schema.ts`, `src/db/index.ts`, `package.json` or the lockfile: many
  branches are in flight and these files conflict.
- CI is not a required check on `main` yet and docs-only changes skip it, so check CI yourself before merging.
- Record a decision a newcomer would have to reverse-engineer as an ADR in [docs/adr](docs/adr/README.md).
