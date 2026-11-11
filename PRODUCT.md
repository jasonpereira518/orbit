# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Opportunity seekers: people looking for a job, an internship, or another opening that comes through someone they know. They already have a network scattered across LinkedIn, Gmail, their calendar and their notes, and they lose track of it between conversations.

Whether the product narrows to students specifically is undecided (strategy notes dated 2026-11-05 are not settled).

## Product Purpose

Orbit keeps a record of everyone the user knows, works out who has gone quiet, and tells the user who to follow up with. Success is a user reaching out to the right person before the connection goes cold.

## Positioning

Orbit sorts a network by how recently the user really talked to each person, using their own email, calendar and LinkedIn history, and turns that into a short list of who to contact now. It is a prompt to act, not a database to maintain.

## Operating Context

- The user imports LinkedIn's Connections.csv, and connects Gmail, Google Contacts and Google Calendar.
- Each person gets one page with their emails, meetings and notes.
- People are grouped by employer, school and old team; the app calls these constellations.
- The user can ask questions about their network in Orbit, or from Claude or ChatGPT through Orbit's connector.

## Capabilities and Constraints

- A contact counts as quiet after 30 days without contact (`DORMANT_DAYS`), unless the user set a different cadence for that person.
- A contact becomes a comet after a year without contact (`COMET_DORMANT_DAYS`).
- The Free plan covers the first 500 contacts (`FREE_CONTACT_LIMIT`). Paid plans are Pro and Max; prices live on `/pricing`.
- Marketing pages must not load Clerk, must stay static, and must not claim features that are still marked coming soon.
- The stealth waitlist at `/interest` is unbranded and is a separate surface.

## Brand Commitments

- Name: Orbit. Vocabulary: orbit, constellation, comet.
- Typefaces: Fraunces for display, Outfit for text.
- Colour: navy deep space, gold `#f2c14e`, teal. The landing page is always dark.
- Glass cards (`GlassCard`) are part of the brand.
- Binding direction for the landing page, from the owner: very celestial, with high-quality real imagery, 3D models and animation.

## Evidence on Hand

- The running app in demo mode, which can be screenshotted (use the fictional student workspace only).
- A product demo video on YouTube, linked from the landing page.
- There are no testimonials, customer logos, press quotes or usage statistics. Do not invent any.

## Product Principles

1. Tell the user who to contact, not just what is stored.
2. Use the user's real history; never ask them to type their network in.
3. State only rules the product enforces and features that have shipped.
4. The celestial vocabulary carries meaning: distance is time since last contact.

## Accessibility & Inclusion

All copy is readable with motion off and without WebGL. Reduced motion is honoured both from the operating system and from the in-app setting (`html[data-motion="reduce"]`).
