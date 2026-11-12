# 12. Stealth host and app_surface_flags for gating unreleased surfaces

Status: Accepted. Recorded retroactively from the code comments cited below; where the code does not say why, the text says "Rationale not recorded".

## Context

`src/lib/waitlist-host.ts` explains the waitlist domain: waitlist visitors must not be able to reach the app, its marketing pages or its name, so the waitlist is served on its own host (`WAITLIST_HOST`) that answers only the waitlist, built from `next.config.ts` redirects because only the config layer sees every request to that host. Stealth closes the app host to people without an account and is a runtime switch (`site_settings`, admin console), with `SITE_STEALTH=1` as the default; it lives in the proxy because config rules are frozen at build time. `src/lib/site-mode-proxy.ts` reads the switch with one Neon statement, cached for 10 seconds, because a second PGlite instance in the proxy bundle would corrupt the single-writer directory. `src/lib/surfaces.ts` is the catalogue of surfaces an operator can hide from every user.

## Decision

Pre-launch exposure is controlled at runtime from the admin console: stealth for the whole app host, and `app_surface_flags` (`/admin/product`) to hide a surface or mark it coming soon. Hiding is presentation plus enforcement, never deletion. A database error never decides who can see the site: the proxy answers with the last value it saw, else the env default.

## Consequences

- Toggles reach every instance within the cache window (10 seconds).
- `/api/v1/openapi.json` 404s while stealthy.
- Surface keys are stored in flag rows and must never be renamed.
- Gated tools in the chat registry re-check the surface inside `run` (`releasedSurface`).

## Revisit when

After launch, when stealth is no longer needed, and when new surfaces stop shipping closed.
