# 10. Stripe apiVersion left to the SDK

Status: Accepted. Recorded retroactively from the code comments cited below; where the code does not say why, the text says "Rationale not recorded".

## Context

`src/lib/stripe.ts` constructs the client lazily so importing it never throws at build time. Its comment says `apiVersion` is deliberately not pinned: the SDK pins its own, and hardcoding a version string means a mismatch every time the package is upgraded.

## Decision

Orbit does not pass `apiVersion`. The API version in effect is whatever the installed `stripe` package declares. Prices resolve by lookup key (`src/lib/stripe-prices.ts`).

## Consequences

- Upgrading the `stripe` package can change the API version and webhook payload shapes silently. `decideStripeEvent` in `src/lib/billing-stripe.ts` is the place that would notice.
- The webhook endpoint's own API version is set in the Stripe dashboard *(verify)*.

## Revisit when

When the Stripe SDK is next upgraded (CODE_HEALTH_PLAN.md P11.2), or after any webhook-shape incident.
