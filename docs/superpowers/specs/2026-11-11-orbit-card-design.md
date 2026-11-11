# Orbit Card — swap contacts by QR, NFC or link, with or without Orbit

## Context

Jason wants people to land in each other's Orbit in seconds — by QR code, NFC, or a link —
even when the other person has no Orbit account. The prompt behind it: "Haven't come across a
way to share contacts with many people."

Business-card apps (Blinq, Popl, HiHello, Wave, Linq) all ship the same core: a web card page
reached by QR / NFC sticker / wallet pass, a "Save contact" vCard, and a "share yours back"
form. They stop at a bare vCard or a CRM lead — no where-we-met, no note — and they are strictly
one-to-one. NameDrop / Google Tap to Share are phone-to-phone, one person at a time, and never
reach Orbit.

Orbit's edge, and the point of this design: **the swap carries context** (the event you're at,
the date, a note typed while you're still standing there) and **it works for groups** (one QR,
everyone gets everyone).

**Hard platform fact:** a website cannot do phone-to-phone NFC on iPhone (Web NFC is Chrome on
Android only). "NFC" therefore means an NFC sticker/card that holds the same link as the QR —
which is how Popl and Blinq do it too.

## Decisions

Jason (Nov 11):
- **Personal card first, then group exchange** (one QR at a table; everyone who joins gets everyone).
- **Arrivals go straight in, tagged** — a share-back becomes a contact immediately, with "via your
  card", the date, and the live event; an identifier you already have attaches to that person.
- **Random, resettable link** — `/c/<random>`; reset kills the old link (and printed QRs/stickers).
- **Wallet pass is a later PR** — needs his Apple Developer account + pass-signing cert and a
  Google Wallet issuer account.

My calls (flag any you disagree with):
- **Every plan, free.** Every card shown is Orbit in front of a non-user — it's the growth loop.
  Dark-launched behind a coming-soon surface (`page.card`); Jason releases it from
  /admin/product. **While dark, admin-owned cards still resolve publicly**, so Jason can do the
  real-phone checks in production before release (everyone else's `/c/` links 404). The public
  page checks the OWNER with `isSurfaceReleased` (surface-visibility.ts:439), not `isSurfaceLive`.
- **No card exists until the user creates it** on /card and sees exactly which fields are public.
  Defaults on: name, photo, title + company, headline, LinkedIn, email. Off: phone (typed onto the
  card — `user_settings` has no phone), website, location. Never public: `senderBio`, skills, aim.
- **Untrusted share-backs never edit an existing contact** (see "Safe write path").
- **Event tagging is automatic**: arrivals during an attended event that is live now are linked
  to it. No manual picker in v1.
- **Photo is not embedded in the vCard** in v1 (iOS ignores URL photos; base64 embedding is extra
  weight). Name, org, title, email, phone, URLs, note line "Met via Orbit".

## What exists to build on (verified in this worktree)

- `qrcode` package, rendered server-side as SVG with `currentColor` — `mintScanHandoffAction` in
  `src/actions/scan.ts`. Reuse that exact call.
- Public no-login page precedent: `/scan/[token]` + `src/lib/scan-handoff.ts`.
- Public paths: `src/lib/public-routes.ts` (`PUBLIC_ROUTES`, checked by
  `scripts/smoke-public-routes.ts`), `STEALTH_OPEN_PREFIXES` in `src/lib/waitlist-host.ts`,
  disallow in `src/app/robots.ts`.
- Public form guards, the waitlist/contact-form pattern: thin server action → `...Core(input,
  {ip})` in `src/lib/`; honeypot `website` + `elapsedMs` (`src/lib/contact-message.ts`
  `MIN_FILL_MS`); `consumeIpBucket` / `consumeBucket` + `RATE_LIMITS` / `BUCKET_LABELS` in
  `src/lib/rate-limit.ts`; BotID `isBotRequest()` in `src/lib/bot-check.ts` +
  `BOTID_PROTECTED_POSTS` in `src/instrumentation-client.ts`; plausible success for bots.
- Untrusted-text cleaners: `cleanAgentContactFields`, `cleanSingleLine`, `safeHttpUrl`,
  `sanitizeAgentText`, `auditUntrustedWrite` in `src/lib/ai-security.ts`.
- Contacts: `findIdentityOwners` / `claimIdentities` (`src/lib/contact-identity.ts`),
  `identityKeysFor` (`src/lib/duplicates.ts`), `createContactForUser` /
  `logNoteInteractionForUser` / `addTagsForUser` (`src/lib/contact-writes.ts`),
  `resolveOrCreateContact` (`src/lib/contact-resolve.ts`), `formatHowMetSummary` / `metContext`.
- Events: `recordMetAtEvent`, `upsertEventAttendees`, `attendedEventFilter`
  (`src/lib/events/store.ts`); `AttendeeSource` union in `src/lib/events/types.ts`.
- Own profile: read `user_settings` directly (`firstName`, `lastName`, `email`,
  `profileImageUrl`, `socialLinks`, `careerProfile.profile.headline`,
  `careerProfile.role.{title,company}`) — `loadYouCurrent` returns only career/bio/schools.
- ICS helpers `escapeIcsText`, `foldLine` are exported from `src/lib/ics.ts` — import them for
  the vCard writer.
- Signed-in hint without Clerk: `src/lib/clerk-session-hint.ts`.
- Surfaces / dark launch: `src/lib/surfaces.ts`; `requireUserForReleasedSurface`
  (`src/lib/plan-guards.ts`); `isSurfaceReleased` / `isSurfaceLive`
  (`src/lib/surface-visibility.ts`).
- `RATE_LIMITS` keys are camelCase (`src/lib/rate-limit.ts:145`); `BOTID_PROTECTED_POSTS` is
  declared in `src/lib/waitlist-host.ts:108`.
- Resend system email: `deliver()` pattern in `src/lib/interest-list-email.ts`.
- Notifications panel is built from source tables (`loadNotificationPanel`,
  `src/lib/notification-panel.ts`) — no table to add to.

## Safe write path (the security core)

`resolveOrCreateContact` must NOT be used for public input: on an identifier match it
**overwrites** the contact (`updateContactForUser`, contact-resolve.ts:278), merges contacts that
share the submitted identifiers (:296), folds on name evidence (:346) and merges after a lost
claim (:388); `createContactForUser` also merges on a lost claim by default
(contact-writes.ts:598). A stranger typing a known email + a known LinkedIn URL could rewrite or
merge the owner's real contacts.

Instead, a dedicated ~20-line `resolveUntrusted` in `src/lib/cards/share-back.ts`, built from
existing primitives (the shared resolver every import uses stays untouched):
1. **Require at least one identity key** — a valid non-role email or a parseable phone
   (`identityKeysFor`); otherwise reject with a field error. Stops junk from filling the cap.
2. Identifier match (`findIdentityOwners`) → that contact (oldest if several). **Write no
   fields, merge nothing, claim nothing.**
3. No match → check `contactHeadroomForUser` first (at cap → share row `held`, no create, no cap
   event logged against the owner); else `createContactForUser(..., { settleClaims: false,
   skipSummary: true, skipEmbedding: true })` with `source: "card"`. Claim email/phone keys;
   **don't claim `linkedin_slug`** (a pasted stranger's URL would capture the real person's
   future imports). Name lookalikes → `nameMatchesFor` + `recordDuplicateSuggestions` only.
4. Fields pass through `cleanAgentContactFields` / `safeHttpUrl`; `auditUntrustedWrite` records it.

**Only fixed, server-written text ever reaches the owner's timeline.** The interaction is
"Shared their details via your card" (+ " at {event}" — type `event`, else `note`), logged with
`skipSummary` / `skipEmbedding` so a busy card doesn't spend the owner's brief/embedding budget.
The visitor's message, and any email/phone that differs from a matched contact, stay on the
`card_shares` row and show on /card marked as from them — never written into notes, memory
chunks, or Chat context. The owner's own quick note (typed on /card) is the real note.

**Replays**: the public form carries a nonce minted at render; `card_shares` has a unique
`(card_id, nonce)`; the share row is inserted first and its id keys the interaction
(`externalId = card:<shareId>`). A replay is a no-op with the same success screen.

**Event link**: give `recordMetAtEvent` (`events/store.ts:551`) an optional `{ source, byName }`
so card arrivals write `source: "card"` (added to `AttendeeSource`) and match roster rows on
identifiers only — never the exact-name fallback (:591). Only when the owner has Events
(`isSurfaceLive(owner, "page.events")` — on every plan by default, admin-overridable).

**Abuse caps**: per-IP `cardShare` (~10/h), per-card `cardShareCard` (~200/h — speakers get
bursts), plus a per-card daily cap on contacts created (~300) after which arrivals are `held`.

## Data model (one schema bump, number above every remote branch at commit time — main's is 219)

- `share_cards` — `id`, `user_id` (unique: one card per user), `slug` (unique, random
  `randomBytes(8).toString("base64url")`), `fields` jsonb (which fields are public), `phone`,
  `tagline`, `paused_at`, `created_at`, `updated_at`.
- `card_shares` (arrivals) — `id`, `user_id`, `card_id`, `nonce` (unique with `card_id`),
  `contact_id` (nullable), `event_id` (nullable), `name`, `email`, `phone`, `company`, `title`,
  `linkedin_url`, `message`, `status` (`added` | `matched` | `held`), `visitor_user_id`
  (nullable, PR3), `created_at`.
- PR4: `exchanges` — `id`, `host_user_id`, `slug`, `title`, `event_id`, `closes_at`, `closed_at`;
  `exchange_members` — `id`, `exchange_id`, `user_id` (nullable), `member_token_hash`, the same
  contact fields, `email_me` bool, `joined_at`.
- Each table: `schema.ts` + `DDL` in `src/db/index.ts` + FK index in `SCALE_DDL` +
  `SCHEMA_VERSION` + changelog + `scripts/setup-db.ts` `EXPECTED_TABLES` +
  `smoke-schema-ddl --update` + purge registry (`smoke-purge`) + `data-export.ts`.

## PR plan

### PR 1 — The card, the public page, share-back (the whole loop)
- **Owner page `/card`** (`src/app/(clerk)/(app)/(main)/card/page.tsx`, surface `page.card`,
  `comingSoon: true`): first visit = setup (fields prefilled from `user_settings`, toggles, live
  preview). After that: big QR (server SVG), **Copy link**, **Share** (Web Share API), **Reset
  link** (confirm: "printed codes and stickers stop working"), **Pause**, and **Arrivals** —
  newest first, each with a one-line "What did you talk about?" note box (→ note interaction).
  While the page is open, arrivals poll every 5 s (server action read).
- **Show mode**: full-screen QR + name + "Scan to save my contact", screen kept bright, arrivals
  ticker under it. Entry points: mobile header QR button (`app-shell.tsx` mobile header), command
  palette "Share my card", and the event page while an event is live.
- **Public page `/c/[slug]`** in `src/app/(site)/c/[slug]/page.tsx` (Clerk-free, `site.css`;
  regenerate `site-sources.css`): noindex; 404 when slug unknown, card paused, owner suspended,
  or `page.card` not live for the owner. Shows photo, name, title @ company, headline, links;
  **Save contact** (vCard) first, then **Share your details with {first name}**: name (required),
  email or phone (one required), company, role, LinkedIn, "Anything to remember?" — guarded as
  above. Done state: "{first} has your details" + Save contact again.
- **vCard**: `src/lib/vcard.ts` (3.0, using `escapeIcsText` / `foldLine` from `ics.ts`);
  `GET /c/[slug]/vcard` route handler (`params` is a Promise), `text/vcard`, attachment
  `First Last.vcf`, `Cache-Control: no-store` (a reset kills it at once), `X-Robots-Tag: noindex`.
  No `maxDuration` export (keeps the Vercel 12-function cap untouched).
- **Core**: `src/lib/cards/` — `card-store.ts` (create/update/reset/pause/load-by-slug),
  `share-back.ts` (`shareBackCore(slug, input, {ip})`: guards → share row → `resolveUntrusted` →
  fixed interaction → event link), `live-event.ts` (`liveEventFor(userId, now)`: attended event
  with `starts_at <= now <= COALESCE(ends_at, starts_at + 3h)`, raw SQL because
  `attendedEventFilter` expects the table aliased `e`). Owner actions in `src/actions/cards.ts`;
  the public share-back action alone in `src/actions/card-public.ts` (`"use server"`, like
  `actions/contact.ts`). Regenerate `site-sources.css` (the page pulls `contact-writes`' graph).
- **Public plumbing**: `/c/(.*)` in `PUBLIC_ROUTES` + `STEALTH_OPEN_PREFIXES`, robots disallow,
  `/c/` added to `BOTID_PROTECTED_POSTS`, rate-limit scopes `cardShare` / `cardShareCard` in
  `RATE_LIMITS` + `BUCKET_LABELS`.
- **/privacy**: one paragraph — what's public on your card, what we store when someone shares
  back, that it lands only in the card owner's Orbit. Bump `TERMS_VERSION` only if /terms changes.

### PR 2 — Sharing tools: print, NFC, link previews, home-screen shortcut
- **Download QR** as SVG and PNG (for slides, badges, table tents) on /card.
- **NFC**: "Write to an NFC tag" button on Android Chrome (`NDEFReader.write` URL record), feature-
  detected; elsewhere a short how-to (any NFC sticker + a free writer app, paste your link).
- **Link previews**: `generateMetadata` title/description + an OG image via `next/og`, copying
  `src/app/api/interest-list/ticket-image/route.tsx` (fonts, CDN cache, 308 on unknown).
- **Home-screen shortcut**: `src/app/manifest.ts` with a `shortcuts` entry to show mode, and
  apple-web-app metadata on show mode so "Add to Home Screen" opens straight to the QR.

### PR 3 — Orbit to Orbit
- Public page, when the session hint says signed in: **Add each other in Orbit** → in-app
  `/card/add/[slug]` (signed-out Orbit users sign in first). Both sides get each other: the owner
  from their own public card fields (trusted — they published them), the visitor from their card
  or `user_settings` (authenticated) via the same untrusted resolve on the owner's side. Both get
  the interaction + live-event link. One confirm screen: "You and Priya are in each other's
  Orbit · add a note".
- **"Already in your Orbit" at sign-up**: on the first app load (alongside `captureAttribution`
  in `(clerk)/(app)/layout.tsx`), match the new user's Clerk-verified primary email to
  `card_shares.email` from the last 90 days; add each card owner (still live) as a contact with
  "Shared details via {owner}'s card on {date}", set `visitor_user_id`, and show the line in
  onboarding's People step. Post-share-back CTA on the public page: "Start your own Orbit —
  {first} will already be in it."

### PR 4 — Group exchange (many ↔ many)
- From /card or an event page: **Start a group** → title (prefilled with the live event), one QR
  / link `/x/[slug]`, closes in 24 h (host can close early), max 100 people.
- Public page `/x/[slug]`: join form with consent line "Everyone in this group will see these
  details"; joining sets a member cookie (random token, hash stored) — only members and the host
  see the list. Live list (5 s poll), **Save everyone** (one multi-contact .vcf), **Add everyone
  to my Orbit** for signed-in users (in-app route, same untrusted resolve, tagged with the group
  title + event). Optional "Email me the full list when it closes" → one Resend email with the
  .vcf attached (pattern from `interest-list-email.ts`).
- The host gets every member as a contact automatically (same rules as share-back).
- Non-host member rows deleted 30 days after close by the existing sweep cron
  (`src/app/api/imports/process-stalled/route.ts`, next to `sweepExpiredHandoffs`).

### Later (not planned here)
Apple/Google Wallet pass (needs Jason's accounts); chosen handles (`/c/jason`); card view/save
stats for the owner.

## Verification

Per PR:
- `npx tsc --noEmit`, `npm run lint` (0 errors), `npm test` (run-smoke --ci); stop `next dev`
  before any build (PGlite single-writer).
- New `scripts/smoke-share-card.ts` (starts with `import "./smoke/_env"`, registered in the smoke
  runner), asserting: card create/load; reset → old slug 404; paused → 404; dark surface → 404
  except an admin owner; share-back creates a contact + one interaction + event link (source
  `card`) when an event is live; **known email → no field written, interaction text is the fixed
  line, the visitor's message only on `card_shares`**; **email of contact A + phone of contact B
  merges nothing**; LinkedIn not claimed; no identity key → rejected; name lookalike →
  suggestion, not a fold; same-named roster guest not linked; at cap → `held`, no create;
  honeypot / fast fill / rate limit → plausible success, no row; replayed nonce → one share, one
  interaction; vCard escaping + folding. Verify each guard FAILS with its fix reverted.
- Existing guards that must stay green: `smoke-public-routes`, `smoke-clerk-free-site`,
  `smoke-site-css-sources`, `smoke-schema-ddl`, `smoke-purge`, `smoke-origin-checks`.
- Browser (demo-mode worktree preview, Playwright + system Chrome if the pane is hidden): set up
  /card → open `/c/<slug>` at 375 px → Save contact returns a .vcf → share back → arrival shows on
  /card within ~5 s → add a note → it appears on the contact. Seed a live event and confirm the
  arrival lands on its roster with "spoke to".
- Real-device checks owed to Jason: iPhone camera scan → page → vCard opens the Contacts sheet;
  Android NFC tag write + tap (PR2).
