# 8. Custom smoke harness instead of a test framework

Status: Accepted. Recorded retroactively from the code comments cited below; where the code does not say why, the text says "Rationale not recorded".

## Context

`scripts/run-smoke.ts` runs every `scripts/smoke-*.ts` as an executable spec with its own exit code, in tiers: `pure`, `pglite`, `manual`. Its header says the point of the harness is a structural guard: it refuses to run a database-tier script that does not start with `scripts/smoke/_env.ts`, the only thing between a smoke test and deleting rows in the shared Neon database. Scripts run sequentially on one throwaway PGlite directory because PGlite is single-writer; `--shard i/n` splits the suite for CI. Rationale for not adopting a framework is not recorded; inferred: the scripts predate the need and tsx runs them without configuration.

## Decision

Behaviour is pinned by about 540 standalone smoke scripts listed in the manifest in `run-smoke.ts` (`--check` fails when a script on disk is missing from it). Many read source files as text, so they pin file paths as well as behaviour. New unit tests use Node's built-in runner: `npm run test:unit` runs `node --import tsx --test` over `src/**/*.test.ts` and `scripts/**/*.test.ts`. Smokes migrate only when touched. Browser flows are Playwright (`e2e/`).

## Consequences

- File moves and renames break path-reading smokes; the refactor plan lists them in a manifest first.
- Output is prose, so there is no per-test reporting, watch mode or coverage for smokes.
- Two runners coexist until smokes are ported.

## Revisit when

If the suite's runtime (about 10 minutes, sharded in CI) or the cost of path-reading smokes blocks refactors.
