# Also here (People near you PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orbit users who opted in and are at the same live event see each other's Orbit Card on the event page (see only — connecting is PR 2).

**Architecture:** Two opt-in columns (`user_settings.discoverable_at`, `events.discovery_hidden_at`) and two `event_aliases` indexes. A server-only `alsoHereFor(viewerId, eventId)` matches other users through shared alias values and returns their public card fields (built by the card store, so only what they chose to show). The event page renders it in a `<Suspense>` card while the event is live; Settings gets one switch.

**Tech Stack:** Next.js App Router (read `node_modules/next/dist/docs/` first), Drizzle + raw `DDL`, raw SQL via `db.execute(sql\`…\`)`, smoke scripts via `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-11-people-near-you-design.md` (stacked on Orbit Card PR 1, #627).

## Global Constraints

- Findable = `user_settings.discoverable_at IS NOT NULL` AND a card `loadPublicCardForOwner` returns (unpaused, owner not suspended, `page.card` released or admin owner) AND `feature.also-here` released for them or admin AND their event's `discovery_hidden_at IS NULL`. Off by default.
- **Reciprocity:** a viewer who is not findable at this event gets `{ findable: false, people: [] }` — never anyone else's card.
- Match keys: `provider` and `url` alias values exact; `source_ref` values starting `gcal:` or `ics:` match on the text after the FIRST colon. Other `source_ref` (e.g. `gmail:`) never match. Manual events with no alias never match.
- Both sides' events: attended (`attendedEventFilter()`, alias `e`), not dismissed, alias row not a tombstone (`event_id IS NOT NULL`), live: `starts_at <= now <= COALESCE(ends_at, starts_at + interval '3 hours')`.
- Payload per person never includes `ownerId`, `slug`, or any field their card hides. People cap: 20.
- Schema version: one above the Card branch's 226 → **227**, re-checked above every remote branch at commit time.
- Surface `feature.also-here` is `comingSoon: true`. Free on every plan.
- Copy: Settings switch label "Let people at the same event find me"; helper "They'll see your Orbit card. You can hide yourself at any event."; event card title "Orbit people here"; hide toggle "Hide me at this event"; not-findable invite "Turn on “Let people at the same event find me” to see who else is here." with a link to `/settings#settings-data`; no card → link "Create your card" to `/card`.
- Privacy paragraph (exact): "**People at the same event.** If you turn on “Let people at the same event find me”, other Orbit users who have also turned it on and are at the same event while it is happening can see your Orbit card — only the fields you made public. You can hide yourself at any event or turn it off at any time."

## Review Focus

1. Viewer at a Luma event via a slug link (no `luma:` provider key yet) and another via the canonical URL — they must still match on the `url` key — Task 3.
2. Same calendar invite seen as `gcal:<uid>` by one user and `ics:<uid>` by another must match — Task 3.
3. A user who turned discoverability on, then paused their card, must disappear immediately — Task 3.
4. Event ended 10 minutes ago (no `ends_at`, started 3 h 10 min ago) must not match — Task 3.
5. Two users with no alias in common but identical event titles and times must NOT match — Task 3.

---

### Task 1: Columns, indexes, surface

**Files:**
- Modify: `src/db/schema.ts` (`userSettings` + `discoverableAt`, `events` + `discoveryHiddenAt`, `eventAliases` index declarations)
- Modify: `src/db/index.ts` (`alters`: two `ALTER TABLE … ADD COLUMN IF NOT EXISTS … timestamptz`; `SCALE_DDL`: the two indexes; `SCHEMA_VERSION = 227` + changelog line)
- Modify: `src/lib/surfaces.ts` (`{ key: "feature.also-here", kind: "feature", label: "Orbit people here", comingSoon: true }` — copy an existing feature entry's shape)
- Modify: `scripts/schema-ddl.lock.json` (via `--update`)

**Interfaces:**
- Produces: `userSettings.discoverableAt: Date | null`, `events.discoveryHiddenAt: Date | null`; indexes `event_aliases_kind_value_idx ON event_aliases(kind, value) WHERE event_id IS NOT NULL` and `event_aliases_uid_idx ON event_aliases((substring(value from position(':' in value) + 1))) WHERE kind = 'source_ref' AND event_id IS NOT NULL AND (value LIKE 'gcal:%' OR value LIKE 'ics:%')`.

- [ ] **Step 1:** `npx tsx scripts/smoke-schema-ddl.ts` — expect PASS (baseline).
- [ ] **Step 2:** Make the edits; `npx tsx scripts/smoke-schema-ddl.ts` → FAIL (stale lock) → `--update` → PASS.
- [ ] **Step 3:** `DATABASE_URL="" npx tsx scripts/smoke-schema-upgrade.ts` and `npx tsx scripts/smoke-merge-coverage.ts` — PASS (add `discovery_hidden_at` to whatever merge-coverage list demands a decision, with a reason).
- [ ] **Step 4: Commit** `feat(nearby): discoverability columns and alias match indexes`

### Task 2: Discoverability store + owner-keyed card read

**Files:**
- Create: `src/lib/nearby/discoverability.ts`
- Modify: `src/lib/cards/card-store.ts` (extract the post-slug gates of `loadPublicCard` into `loadPublicCardForOwner`; `loadPublicCard` calls it)
- Test: `scripts/smoke-also-here.ts` (create; first line `import "./smoke/_env"`; register `"smoke-also-here": "pglite"` in `scripts/run-smoke.ts`; `check()` + `process.exit` as in `scripts/smoke-share-card.ts`, whose seeding of owners, cards and `page.card` release it should copy)

**Interfaces:**
- Produces: `loadPublicCardForOwner(ownerId: string): Promise<PublicCard | null>` (same gates as `loadPublicCard` minus the slug shape/lookup).
- Produces: `setDiscoverable(userId: string, on: boolean): Promise<void>`; `isDiscoverable(userId: string): Promise<boolean>`; `setHiddenAtEvent(userId: string, eventId: string, hidden: boolean): Promise<boolean>` (owner-scoped; false when the event isn't theirs).

- [ ] **Step 1: Failing tests:** `setDiscoverable(u,true)` → `isDiscoverable(u)` true, then false after `setDiscoverable(u,false)`; `setHiddenAtEvent(u, otherUsersEvent, true)` → false and that row's `discovery_hidden_at` stays null; own event → true and column set; `loadPublicCardForOwner` returns the card, then null after `setCardPaused(u,true)`; `smoke-share-card` still passes (the refactor keeps `loadPublicCard`'s behaviour).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx tsx scripts/smoke-also-here.ts` and `npx tsx scripts/smoke-share-card.ts` — PASS.
- [ ] **Step 5: Commit** `feat(nearby): opt-in store and owner-keyed card read`

### Task 3: `alsoHereFor` matching core

**Files:**
- Create: `src/lib/nearby/also-here.ts`
- Test: `scripts/smoke-also-here.ts` (Task 3 section)

**Interfaces:**
- Consumes: Task 2 functions; `attendedEventFilter` (`src/lib/events/store.ts`); `isSurfaceReleased` (`src/lib/surface-visibility.ts`); `isAdminUser` (`src/lib/admin.ts`).
- Produces: `export type AlsoHerePerson = Omit<PublicCard, "ownerId" | "slug">` and `alsoHereFor(viewerId: string, eventId: string, now?: Date): Promise<{ findable: boolean; people: AlsoHerePerson[] }>`.

Steps inside: (1) load the viewer's event owner-scoped; not theirs / not attended / not live / dismissed → `{ findable: false, people: [] }`. (2) Viewer not findable (Global Constraints) → same. (3) Collect the event's non-tombstone alias keys. (4) One raw SQL query over `event_aliases a JOIN events e JOIN user_settings us` for other users matching any key under the Global Constraints (live, attended, not hidden, `discoverable_at` set, not suspended), distinct user ids, `LIMIT 50`. (5) For each, `loadPublicCardForOwner` and the `feature.also-here` release/admin check; drop nulls; strip `ownerId`/`slug`; cap 20, stable order by full name.

- [ ] **Step 1: Failing tests** (two or three seeded users, each with their own `events` + `event_aliases` rows; release `page.card`, `page.events`, `feature.also-here` the way `smoke-share-card` releases `page.card`):
  - Same `provider` key `luma:evt-1`, both opted in, cards live, events live → each sees exactly the other; payload has no `ownerId`/`slug`; a field hidden on B's card is `null` in A's view.
  - A has only a `url` key `https://luma.com/x`, B has that `url` plus `luma:evt-1` → match.
  - `gcal:UID-9` vs `ics:UID-9` → match; `gmail:m1` vs `gmail:m1` → no match.
  - Same title and `starts_at`, no shared alias → no match.
  - Viewer not opted in → `{ findable: false, people: [] }` even though B is findable.
  - B hides at the event / pauses card / turns discoverability off / is suspended / dismissed the event / RSVP `maybe` on a discovered event → B absent.
  - B's event started 3 h 10 min ago with no `ends_at` → absent; started 1 h ago → present.
  - Viewer asks about another user's event id → `{ findable: false, people: [] }`.
  - 25 matching users → 20 returned.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run — PASS. Remove the `us.discoverable_at` predicate once and confirm the "B turns discoverability off" check FAILS; restore.
- [ ] **Step 5: Commit** `feat(nearby): match people at the same live event`

### Task 4: Settings switch, event page card, privacy

**Files:**
- Create: `src/actions/nearby.ts`, `src/components/nearby/also-here-card.tsx`, `src/components/nearby/discoverable-switch.tsx`
- Modify: the "Data and privacy" settings section component (`settings-data` in `src/components/settings/sections.ts` — find its renderer) to include the switch
- Modify: `src/app/(clerk)/(app)/(main)/events/[id]/page.tsx` (~:133-138, next to `showCardLink`)
- Modify: `src/app/(site)/(docs)/privacy/page.tsx`, `src/lib/legal.ts` (`TERMS_VERSION` → `"2026-11-11.3"` + changelog line), `scripts/legal-pages.lock.json` (via `npx tsx scripts/smoke-legal-pages.ts --update`)

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces (actions, each starting `requireUserForReleasedSurface("feature.also-here")` from `src/lib/plan-guards.ts`; failures via `actionFailure`): `setMyDiscoverable(on: boolean)`, `setHiddenHere(eventId: string, hidden: boolean)`, `getAlsoHere(eventId: string): Promise<{ findable: boolean; hiddenHere: boolean; hasCard: boolean; people: AlsoHerePerson[] }>`.

UI: the event page renders `<AlsoHereCard>` inside `<Suspense>` only when `liveEvent?.id === event.id` and `feature.also-here` is live for the viewer. States: people list (photo, name, title @ company, headline, links — reuse the visual language of `src/components/card/public-card.tsx` at small size); empty "No one else here has turned this on yet."; not findable → the invite copy; no live card → "Create your card"; "Hide me at this event" switch. Settings switch is disabled with the "Create your card" link when the user has no live card. Client components import only types from modules reaching `@/db`.

- [ ] **Step 1:** Add the privacy paragraph and `TERMS_VERSION`; `npx tsx scripts/smoke-legal-pages.ts` → FAIL → `--update` → PASS.
- [ ] **Step 2:** Implement actions, components, page wiring.
- [ ] **Step 3:** `npx tsc --noEmit`, `npm run lint` (0 errors), `smoke-also-here`, `smoke-share-card`, `smoke-surface-visibility`, `smoke-a11y-patterns`, `smoke-icon-button-names`, `smoke-origin-checks` — PASS.
- [ ] **Step 4:** Browser (demo mode, Playwright + system Chrome; seed a second user with a card, `discoverable_at`, and a live event sharing a `luma:` key with demo-user's live event): the event page shows "Orbit people here" with the other card; toggling "Hide me at this event" for the other user (via seed) removes them; Settings switch round-trips. Screenshot the card at 375 px and desktop.
- [ ] **Step 5: Commit** `feat(nearby): Orbit people here on the event page`
