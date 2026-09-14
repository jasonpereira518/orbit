# Outreach interface

The Outreach UI keeps Orbit’s existing Fraunces/Outfit typography, theme tokens and app shell. It supports personal networking campaigns of 20–100 people. The approved direction is guided setup followed by flexible workspace tabs and recipient lists beside focused editors. This surface record documents the implementation; it does not define a new global design system. Product commitments remain in `PRODUCT.md`.

## Visual system

Fraunces marks the overview heading (36px), campaign heading (30px), setup and empty-state headings (24px), and setup summary (20px). Outfit carries working content: person and campaign row titles at 18px, controls/body mainly 14px, metadata at 12px, and draft message editing at 16px with relaxed leading. Counts use tabular numerals where implemented. Strong content uses `ink`; actions use `primary`.

Colors resolve through `src/app/globals.css`: the light theme retains pale neutral surfaces and deep teal; dark retains the navy surface ladder and pale blue accent. Cards, muted list wells, popovers, borders, and success/error text use their existing semantic tokens. Do not hard-code a light palette into Outreach. Selected rows use an accent wash; status chips remain muted unless conveying success, with words alongside color.

Containers use the existing radius scale (10px base, 14px large surfaces, 8px chips), thin borders, and tonal separation. The sticky action bar adds the existing large shadow and border ring. Reuse shared Button, Input, Textarea, and Dialog controls, including their focus, pending, disabled, and error treatments. No global tokens are introduced here.

## Layout and navigation

- `/outreach`: a heading, inline attention counts, Active/All/Archived filters and search, then divided campaign rows ordered by recent activity. Attention links target relevant workspace filters; historical campaigns remain accessible. Relative dates use the server-provided `asOf` reference to keep the initial render stable.
- Setup: Purpose → Channel & sender → Confirm audience. At desktop width, the form sits beside a 280px sticky summary with a 32px gap. Requirements, preferences and exclusions remain editable; funding is visible before creation. Returning to a step retains entered values; the new step heading receives focus.
- Workspace: campaign/sender context, compact outcome counts, progress entry point, and horizontally scrollable People/Drafts/Conversations/Activity navigation. Tabs remain mounted and remember their main-scroll position during the session.
- People, Drafts and Conversations share a list/detail grid from 1024px: `minmax(220px,0.8fr)` beside `minmax(0,2fr)`. Lists can scroll independently up to 72vh. Rows use 16px padding; detail panes use 20px, increasing to 24px from 640px. Common section gaps are 20–24px.

Below 1024px, selecting a row replaces the list with its detail, focuses the detail region, and exposes Back with focus restoration. List buttons support Up/Down/Home/End navigation. Setup's summary is hidden; fields and actions wrap. Sticky action bars sit 96px above the viewport bottom, with 96–112px page-bottom padding to accommodate the app's existing floating controls. Send review is capped at 90dvh with a scrollable body. These are implemented behaviors, not a claim that every viewport has been visually verified.

## Review and persistence

People use 20-result pages with separate page selection and all-matching selection. Filtering and polling retain selected IDs. Incoming research appends new people without moving existing rows; “Apply updated rankings” deliberately adopts the latest order. Detail shows match reasons, confidence, conflicting evidence, source excerpts and research dates, missing contact information, and prior-network context.

Draft and reply editors share buffers keyed by message ID and base revision. Buffers, selection, filters and active items survive workspace tab changes and background refreshes in memory; unsaved edits are not persisted across page reloads. Saving clears a buffer only after refreshed data arrives. A revision conflict preserves text and offers loading the saved revision. Regeneration and approval are disabled for dirty selections. Entering Drafts to review a newly generated batch or reply resets its filter to All so the target remains visible; ordinary tab switches retain filters.

Drafts provide previous/next review, explicit selection counts, batch rewrite instructions and compact approval actions. Saving edits requires new approval. Unverified addresses have a review acknowledgment. “Review & send” opens a recipient-by-recipient preview of the saved approved revision, including sender, transport, destination, subject, message and signature. The final action says “Queue”; approval, queueing, provider acceptance and confirmed sending remain distinct.

Conversations show last-checked time, stale browser tracking, original-thread links, outcome and close controls, and an editable reply before approval. Activity presents dated execution records, errors, funding, queue cancellation and verification actions. The header retains Pause/Resume and an Activity entry point during work or errors. Notices use status announcements; errors use alerts.

## Motion

Motion uses the installed `motion/react` package: setup advances directionally over 220ms; up to six overview rows enter over 240ms with 35ms stagger; editor changes, action bars, notices and the shared tab underline use short spring transitions. The shared spring is stiffness 420, damping 32, mass 0.8. Existing CSS interactions keep the global 120ms default. Movement identifies a change without animating result reordering during polling.

Reduced motion suppresses spatial entrances, makes setup and tab changes immediate, stops the progress spinner, and removes the overview arrow shift. The existing global reduced-motion rule also shortens CSS animation/transition duration and disables smooth scrolling. Content and status feedback remain available.

## Validation

`node --import tsx scripts/smoke-outreach-ui.ts` checks 100-person database summaries, tenant isolation, historical records, acceptance versus confirmation, draft revision state and stable research ordering. Existing Outreach provider, browser and v2 smoke suites continue to cover execution contracts.

The browser walkthrough uses `/tmp/orbit-outreach-preview` with an isolated PGlite fixture database and synthetic `example.test` addresses. Audience interpretation and reply generation are mocked only in that temporary preview copy. No real messages are sent. The primary checkout and its running localhost server retain their own data and configuration.

The September 12, 2026 validation passed TypeScript, scoped ESLint, and the UI, v2, provider and browser smoke suites. Browser checks confirmed selection across 100 people, edits retained across recipients and tabs, approval invalidation, exact approved send previews, setup validation and heading focus, dialog focus restoration, and targeted reply review from a previously filtered list. Desktop and mobile captures passed the bounded finish review; the dark draft editor was also visually checked. Live-provider sending, computed contrast and motion interruption remain outside this fixture walkthrough.

This document's visual and interaction descriptions are source-derived. The validation commands and preview method above describe coverage; they do not independently assert a fresh browser pass, performance result, or accessibility certification.

Keep `OUTREACH_V2_ENABLED=1` for local preview. The rollout gate is unchanged. User-facing fake campaigns and provider mock behavior are not added to the application.
