# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Orbit serves people who actively maintain a professional network and need a dependable way to remember context, find useful connections, and follow up at the right time.

## Product Purpose

Orbit is a personal networking CRM. It turns notes and imported relationship history into organized contacts, reminders, network search, suggested follow-ups, and a constellation-style map of the user's professional relationships. Success means helping users keep valuable connections active without relying on memory or scattered notes.

## Positioning

Orbit treats a professional network as a living personal constellation: it combines relationship context, timely follow-up guidance, natural-language network search, and a visual map in one private workspace.

## Operating Context

Users capture meeting and conference notes, import contacts and relationship history, review follow-up suggestions, search their network, explore the constellation map, and manage their plan from the web app. Plan upgrades may originate from Clerk Billing, Stripe Checkout, or a complimentary entitlement granted outside the purchase flow.

## Capabilities and Constraints

- The product has Free, Orbit Pro, and Orbit Lifetime plans.
- A newly detected switch to Orbit Pro or Orbit Lifetime must trigger a one-time, full-screen plan-unlock celebration, including complimentary upgrades.
- The celebration should last roughly 6–8 seconds. It becomes skippable after the main reveal and must not replay on ordinary subsequent visits.
- Orbit Pro and Orbit Lifetime need distinct wording so a complimentary upgrade never implies that a purchase occurred.
- Existing entitlement resolution treats complimentary access, Lifetime purchase, and Pro subscription as different sources of the resolved plan.

## Brand Commitments

- The product name is Orbit, with a celestial and constellation-based identity.
- Orbit Pro's committed celebration color is blue.
- Orbit Lifetime's committed celebration color is yellow/gold.
- The plan-unlock moment should have the scale, pacing, and reward intensity of a Fortnite Battle Pass unlock while remaining recognizably Orbit.

## Evidence on Hand

- Product overview and current capabilities: `README.md`
- Current plan and entitlement behavior: `src/lib/entitlements.ts`, `src/lib/plan-copy.ts`, and `src/components/settings/plan-settings.tsx`
- Current paid-plan presentation: `src/components/pricing/pricing-tiers.tsx`
- Current motion tokens: `src/lib/motion.ts` and `src/app/globals.css`

## Product Principles

- Make relationship context useful at the moment it matters.
- Turn maintenance work into clear, confidence-building next actions.
- Keep the user's network legible, personal, and under their control.
- Make meaningful account milestones feel unmistakably rewarding.

## Accessibility & Inclusion

The plan celebration must preserve the result in text, respect reduced-motion preferences, avoid depending on color alone, and remain dismissible without pointer input once the main reveal is complete.
