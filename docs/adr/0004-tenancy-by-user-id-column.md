# 4. Tenancy by user_id column, without foreign keys or row-level security

Status: Accepted. Recorded retroactively from the code comments cited below; where the code does not say why, the text says "Rationale not recorded".

## Context

Identity lives in Clerk. There is no `users` table: 86 of the 119 tables carry `user_id text` holding the Clerk user id, and nothing references a users row. Server actions are public endpoints (the header of `scripts/smoke-action-user-scope.ts` cites Next's data-security guide), so a user id taken from a caller instead of the session is a cross-account hole. Rationale for choosing a plain column over foreign keys or RLS is not recorded; inferred: Clerk owns the user record, and Neon HTTP sessions do not carry a per-request database role that RLS would need.

## Decision

Every tenant query filters on `user_id`, passed explicitly into `src/lib/**` functions. Entry points derive it from the session (`requireUserId` and the surface/admin guards built on it). Account deletion and per-category data deletion use one list of delete steps, `STEPS` in `src/lib/user-data.ts`. `scripts/smoke-action-user-scope.ts` parses every `"use server"` module and fails on an exported action that takes a user-id-shaped parameter without deriving the user from the session.

## Consequences

- A forgotten `user_id` filter is a cross-tenant leak, and the database will not stop it. The smoke guard covers actions' signatures, not every query.
- A new user-scoped table needs a delete step in `STEPS`, or deletion leaves rows behind.
- No cascades: related rows are removed by explicit deletes.

## Revisit when

If a second tenant model (organizations) is added, or if a query-level guard (lint rule, RLS with per-request roles) becomes practical.
