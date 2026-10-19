# 6. Server actions for app mutations; route handlers only for what an action cannot do

Status: Accepted. Recorded retroactively from the code comments cited below; where the code does not say why, the text says "Rationale not recorded".

## Context

Every export of a `"use server"` module is a callable POST endpoint, so actions are treated as public endpoints (`scripts/smoke-action-user-scope.ts`). Layouts do not run for action POSTs, which is why the session gate lives in `requireUserId` and not in a layout (`src/lib/auth.ts`). Rationale for preferring actions over a REST layer for the app's own UI is not recorded; inferred: fewer endpoints to authenticate and type, and `revalidatePath` integration.

## Decision

App mutations are server actions in `src/actions/*.ts`: authenticate, validate, call `src/lib`, `revalidatePath`. Route handlers (`src/app/api/**/route.ts`) exist for what an action cannot do: streaming (chat SSE), uploads, webhooks, OAuth callbacks, token URLs, the REST v1 API, the MCP server, the extension API and the internal job routes.

## Consequences

- Action inputs are not validated at runtime today (audit A3 and plan P5 propose schema validation at every boundary).
- Some domain logic still lives in action files and some lib code calls actions (audit B4); the rule in CONTRIBUTING is the target state.
- Two API surfaces exist (actions for the app, REST/MCP for outside callers) and share `src/lib`.

## Revisit when

When the layering clean-up (plan P6) lands, or if an outside client needs the app's mutations.
