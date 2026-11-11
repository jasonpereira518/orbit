# People near you — "Also here" at events, then "Nearby now"

## Context

Jason asked for Bluetooth proximity to suggest people to connect with, and whether a web app
can do it. **It can't:** browsers cannot advertise over Bluetooth at all (Web Bluetooth only
connects to a device the user picks), LE scanning is an unshipped Chrome-only draft, and iOS
Safari — every iPhone browser — has no Web Bluetooth. The Chrome extension has no BLE either.
Bluetooth would need a native iOS/Android app, with iOS background limits and App Store review.

Jason chose the web-viable route, both parts, event first:
1. **Also here** — Orbit users at the same live event see each other as opt-in suggestions.
2. **Nearby now** — opt-in browser location while the page is open, for moments with no event.

Jason's calls (Nov 11): **Connect = request → they accept → both added** to each other's Orbit,
tagged with the event. **Opt in once** in Settings (off by default), **hide per event**.
**A matched person sees your Orbit Card** (only your public fields); no card or a paused card =
not findable.

**Depends on Orbit Card PR 1 being merged** (`share_cards`, `loadPublicCard`, `resolveArrival`
/ `resolveUntrusted` in `src/lib/cards/share-back.ts`, `liveEventFor`). The connect / mutual-add
core built here is the same one Card PR 3 ("add each other in Orbit") needs — Card PR 3 should
reuse it rather than build its own.

## My calls (flag any you disagree with)

- **Reciprocity:** you only see others if you are findable yourself (opted in, card live, not
  hidden at this event).
- **Requests are quiet:** a declined request stays "Requested" on the sender's side; the same
  pair can't re-request for 30 days; at most 50 requests sent per day.
- **On accept, contacts are written with the card safety rules** — an existing contact is never
  edited or merged (reuse `resolveUntrusted` / `resolveArrival`), only fixed text goes on the
  timeline: "Connected on Orbit at {event}" / "Connected on Orbit nearby". Event link via
  `recordMetAtEvent(…, { source: "orbit", byName: false })`.
- **Nearby now never reveals distance or location** to anyone — just "nearby now". Location is
  sent only after a tap, held 15 minutes, then deleted; no background tracking.
- People you're already connected with (accepted request) aren't suggested again.

## Matching across users (Also here)

Every Orbit table is per-user today; the shared signal is `event_aliases.value`
(`src/db/schema.ts:6166`, keys built in `src/lib/events/discovery/keys.ts:50`,
`discovery/record.ts:411`):
- `provider` (`luma:evt-…`, `partiful:…`, `eventbrite:…`) — exact match across users.
- `url` (canonicalised by `canonicalEventKey`) — exact match.
- `source_ref` `gcal:<iCalUID>` / `ics:<UID>` — match on the part after the prefix.
- Manual events with no URL — not matched (no fuzzy title matching in v1).

New indexes: `(kind, value) WHERE event_id IS NOT NULL` on `event_aliases`, plus an expression
index on the UID suffix for `source_ref` rows.

`alsoHereFor(viewerId, eventId)` (new, `src/lib/nearby/also-here.ts`): the viewer's event must be
live (same window as `liveEventFor`, `src/lib/cards/live-event.ts`) and attended
(`attendedEventFilter`, `src/lib/events/store.ts:77`); find other users whose own attended,
live, non-dismissed, non-hidden event shares any key; each must be discoverable, card unpaused,
not suspended, `page.card` released for them. Return their `PublicCard` (built by the existing
`build()` in `card-store.ts`, so only public fields) + request state. Cap 20.

## Data model (one schema bump, above every branch at commit time)

- `user_settings.discoverable_at timestamptz` — null = not findable (default).
- `events.discovery_hidden_at timestamptz` — "hide me at this event".
- `connect_requests` — `id`, `from_user_id`, `to_user_id`, `event_id` (sender's event, nullable),
  `context` (`event` | `nearby`), `status` (`pending` | `accepted` | `declined`), `created_at`,
  `responded_at`; unique pending pair; index on `(to_user_id, status)`.
- PR 3: `presence_pings` — `user_id` (unique), `lat`, `lng`, `accuracy_m`, `expires_at`; deleted
  on expiry by the existing sweep in `src/app/api/imports/process-stalled/route.ts`.
- Each table: schema + DDL + FK indexes + `SCHEMA_VERSION` + `EXPECTED_TABLES` +
  `smoke-schema-ddl --update` + purge registry (`src/lib/user-data.ts`, both users' rows on
  `connect_requests`) + export.

## PR plan

### PR 1 — Opt-in + "Also here" on the event page (see, not yet connect)
- Settings: "Let people at the same event find me" switch (sets `discoverable_at`), with a line
  explaining they'll see your card; disabled with a link to /card when there's no live card.
- Event detail page (`src/app/(clerk)/(app)/(main)/events/[id]/page.tsx`, beside the existing
  `showCardLink` logic ~:135): an "Orbit people here" `<Suspense>` card while the event is live —
  their cards, or an invite to opt in if you aren't findable; "Hide me at this event" toggle.
- `alsoHereFor` + indexes + columns; surface `feature.also-here` coming soon.
- /privacy paragraph (bumps `TERMS_VERSION`, forced by `smoke-legal-pages`).

### PR 2 — Connect requests and mutual add
- `src/lib/connections/`: `sendConnectRequest`, `respondToRequest(accept|decline)`,
  `addEachOther(userA, userB, context)` (the shared mutual-add core; Card PR 3 reuses it).
- "Connect" on each Also-here card → "Requested"; recipient sees it in the notification panel
  (new `connect_request` kind in `src/lib/notification-panel.ts`) and on the event page, with
  Accept / Decline. Accept writes both contacts + interactions + event links.
- `loadAppPulse()` (`src/lib/app-pulse.ts:57`) gains `alsoHereCount` for the live event, gated
  and `.catch(() => null)` like `unloggedEvent`, driving a small "3 Orbit people here" nudge.
- Rate limits in `src/lib/rate-limit.ts` (`connectRequest` 50/day per user).

### PR 3 — Nearby now (geolocation)
- `src/lib/security-headers.ts:126`: app `Permissions-Policy` `geolocation=(self)`; waitlist host
  (`:173`) stays `()`.
- "Find people nearby" button on /card show mode and the dashboard: one tap →
  `navigator.geolocation.getCurrentPosition` → `presence_pings` row for 15 min → list of other
  discoverable users with a live ping within ~200 m (bounding box on lat/lng, then haversine,
  widened by both accuracies, capped at 500 m). Re-polls every 30 s while open; "Stop sharing"
  deletes the row. Same cards, same Connect flow (`context: "nearby"`).
- /privacy line for location (another `TERMS_VERSION` bump).

## Verification

- Smokes (new `scripts/smoke-also-here.ts`, `smoke-connections.ts`, `smoke-nearby.ts`, each
  starting `import "./smoke/_env"`, registered in `run-smoke.ts`): two users, same Luma
  `provider` key → each sees the other only when both are opted in, card live, event live and
  attended, not hidden; `gcal:` vs `ics:` same UID matches; a viewer who isn't findable sees no
  one; paused card / suspended / dismissed event → invisible; hidden fields never in the payload.
  Connect: pending → accept writes exactly one contact each side + fixed interaction + roster
  link, existing contacts untouched; decline is invisible to the sender; 30-day re-request block;
  rate limit. Nearby: 150 m apart match, 2 km apart don't, expired ping ignored and swept,
  response contains no coordinates or distances.
- Guards: `smoke-schema-ddl`, `smoke-purge`, `smoke-legal-pages`, `smoke-origin-checks`,
  security-headers smoke (if any) for the geolocation policy; `tsc`, `npm run lint`, `npm test`.
- Browser (demo mode, Playwright + system Chrome, two contexts as two seeded users): both opted
  in at a seeded live Luma event → each sees the other on the event page → request → accept →
  each has the other as a contact with the event tag. Nearby: grant geolocation with Playwright's
  `geolocation` option at two close coordinates → match; far coordinates → none.
- Real-device check owed to Jason: two phones at one real event; iPhone Safari location prompt.
