# Orbit Card PR 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Orbit user can create a personal card, show it as a QR/link, and anyone (no account)
can open it, save the vCard, and share their details back — landing safely in the owner's Orbit,
tagged with the live event.

**Architecture:** Two new tables (`share_cards`, `card_shares`). Pure helpers in `src/lib/vcard.ts`;
everything else in `src/lib/cards/`. The public page lives Clerk-free in `src/app/(site)/c/[slug]`,
posts through a thin server action to `shareBackCore`, which writes via its own `resolveUntrusted`
(never `resolveOrCreateContact`). The owner page is `/card` in the app group, dark behind `page.card`.

**Tech Stack:** Next.js App Router (read `node_modules/next/dist/docs/` before route/page code —
`params` is a Promise), Drizzle + raw `DDL`, zod 4, `qrcode`, smoke scripts via `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-11-orbit-card-design.md`

## Global Constraints

- Slug: `randomBytes(8).toString("base64url")` (11 chars). Public path `/c/<slug>`; vCard at `/c/<slug>/vcard`.
- No `export const maxDuration` anywhere in new routes (Vercel 12-function cap).
- Never call `resolveOrCreateContact` or `updateContactForUser` from the share-back path.
- Contact `source`: `"card"`. Interaction `externalId`: `` `card:${shareId}` ``. Interaction text, exactly:
  `Shared their details via your card` — plus `` ` at ${eventTitle}` `` when an event is live. Type
  `"event"` when an event is live, else `"note"`. Write options: `{ skipSummary: true, skipEmbedding: true, skipRevalidate: true }`.
- Rate limits: `cardShare` `{ limit: 10, windowSec: 3600 }` per IP; `cardShareCard` `{ limit: 200, windowSec: 3600 }` per card id. Daily cap: 300 `added` shares per card per 24 h, then `held`.
- Live event window: `starts_at <= now <= COALESCE(ends_at, starts_at + interval '3 hours')`.
- Card field defaults — on: `photo`, `role`, `headline`, `linkedin`, `email`; off: `phone`, `website`, `location`.
- Public page and vCard: `robots: { index: false, follow: false }` / `X-Robots-Tag: noindex`; vCard `Cache-Control: no-store`.
- Arrivals poll interval on /card and show mode: 5000 ms, only while the tab is visible.
- Schema version: take a number above every remote branch's `SCHEMA_VERSION` at commit time (main is 219). Shell loops under `bash -c` (zsh modifier trap).
- Free on every plan; surface `page.card` is `comingSoon: true`. While dark, a card resolves publicly only when `isAdminUser(ownerId)`.

## Review Focus

1. A share-back whose email matches an existing contact must leave every field of that contact unchanged and put only the fixed line on its timeline — pinned in Task 5.
2. A share-back whose email and phone belong to two different contacts must merge nothing — Task 5.
3. A double-tapped submit (same nonce) must produce one share row and one interaction — Task 5.
4. A reset or paused card must 404 on both the page and the vCard immediately (no cached vCard) — Tasks 3 and 6.
5. A visitor's message containing prompt-injection text must never reach `interactions.raw_notes` — Task 5.

---

### Task 1: Tables and schema bump

**Files:**
- Modify: `src/db/schema.ts` (new `shareCards`, `cardShares` pgTables near `captureHandoffs` ~4311)
- Modify: `src/db/index.ts` (`DDL` template, FK indexes in `SCALE_DDL`, `SCHEMA_VERSION` + changelog ~3112)
- Modify: `scripts/setup-db.ts` (`EXPECTED_TABLES`), `scripts/schema-ddl.lock.json` (via `--update`)
- Modify: the purge category registry used by `scripts/smoke-purge.ts`, and `src/lib/data-export.ts`

**Interfaces:**
- Produces: `shareCards` (`id uuid pk default gen_random_uuid()`, `userId text not null unique`, `slug text not null unique`, `fields jsonb not null`, `phone text`, `tagline text`, `pausedAt timestamptz`, `createdAt`, `updatedAt`).
- Produces: `cardShares` (`id uuid pk`, `userId text not null`, `cardId uuid not null references share_cards(id) on delete cascade`, `nonce text not null`, `contactId uuid references contacts(id) on delete set null`, `eventId uuid references events(id) on delete set null`, `name text not null`, `email`, `phone`, `company`, `title`, `linkedinUrl`, `message`, `ownerNote` text, `status text not null`, `visitorUserId text`, `createdAt`); unique `card_shares_card_nonce_uidx (card_id, nonce)`; index `card_shares_user_created_idx (user_id, created_at desc)`.
- Produces in `schema.ts`: `export type CardFields = { photo: boolean; role: boolean; headline: boolean; linkedin: boolean; email: boolean; phone: boolean; website: boolean; location: boolean }` and `export type CardShareStatus = "added" | "matched" | "held"`.

- [ ] **Step 1:** `npx tsx scripts/smoke-schema-ddl.ts` before editing — expect PASS (baseline).
- [ ] **Step 2:** Add both pgTables + types, the two `CREATE TABLE IF NOT EXISTS` in `DDL`, FK indexes in `SCALE_DDL`, bump `SCHEMA_VERSION` with changelog line "share_cards + card_shares — Orbit Card", add both names to `EXPECTED_TABLES`.
- [ ] **Step 3:** `npx tsx scripts/smoke-schema-ddl.ts` — expect FAIL naming the stale lock; `--update`, rerun — expect PASS.
- [ ] **Step 4:** `npx tsx scripts/smoke-purge.ts` — expect FAIL on the unregistered tables; register both (rows by `user_id`) and add to `data-export.ts`; rerun — expect PASS.
- [ ] **Step 5:** `DATABASE_URL="" npx tsx scripts/smoke-schema-upgrade.ts` — expect PASS.
- [ ] **Step 6: Commit** `feat(card): share_cards and card_shares tables`

### Task 2: vCard writer

**Files:**
- Create: `src/lib/vcard.ts`
- Test: `scripts/smoke-vcard.ts` (register `"smoke-vcard": "pure"` in `scripts/run-smoke.ts`)

**Interfaces:**
- Consumes: `escapeIcsText`, `foldLine` from `src/lib/ics.ts`.
- Produces: `export type VCardPerson = { fullName: string; firstName?: string | null; lastName?: string | null; org?: string | null; title?: string | null; email?: string | null; phone?: string | null; urls?: string[]; note?: string | null }`; `export function buildVCard(p: VCardPerson): string` (vCard 3.0, CRLF); `export function vcardFileName(fullName: string): string`.

- [ ] **Step 1: Write the failing test** (`check()` helper as in `scripts/smoke-interest-list-join.ts`):
  - `buildVCard({ fullName: "Priya Shah", firstName: "Priya", lastName: "Shah", org: "Acme, Inc.", email: "p@x.test" })` starts with `"BEGIN:VCARD\r\nVERSION:3.0\r\n"`, ends with `"END:VCARD\r\n"`, contains `"FN:Priya Shah"`, `"N:Shah;Priya;;;"`, `"ORG:Acme\\, Inc."`, `"EMAIL;TYPE=INTERNET:p@x.test"`.
  - A 200-char `note` → no line over 75 octets; continuation lines start with a space.
  - A name with `;` and `\n` is escaped (`\\;`, `\\n`).
  - Null/empty fields emit no line (no `"TEL:"` when phone is null).
  - `vcardFileName("Priya / Shah")` === `"Priya  Shah.vcf"`; `vcardFileName("")` === `"contact.vcf"`.
- [ ] **Step 2:** `npx tsx scripts/smoke-vcard.ts` — expect FAIL (module not found).
- [ ] **Step 3:** Implement. `vcardFileName` keeps `[\p{L}\p{N} ._-]`, trims, falls back to `contact`.
- [ ] **Step 4:** Rerun — expect PASS.
- [ ] **Step 5: Commit** `feat(card): vCard 3.0 writer`

### Task 3: Card store and the `page.card` surface

**Files:**
- Create: `src/lib/cards/card-store.ts`
- Modify: `src/lib/surfaces.ts` — `{ key: "page.card", kind: "page", label: "Your card", description: "Share your contact by QR, NFC or link — and get theirs back.", href: "/card", comingSoon: true }`
- Test: `scripts/smoke-share-card.ts` (create; first line `import "./smoke/_env"`; register `"smoke-share-card": "pglite"` in `run-smoke.ts`)

**Interfaces:**
- Consumes: Task 1 tables; `isSurfaceReleased` (`src/lib/surface-visibility.ts`); `isAdminUser` (`src/lib/admin.ts`); `getAppBaseUrl` (`src/lib/app-url.ts`); `cleanSingleLine` (`src/lib/ai-security.ts`); `user_settings` `firstName`, `lastName`, `email`, `profileImageUrl`, `socialLinks`, `careerProfile`, `suspendedAt`.
- Produces:
  - `export const DEFAULT_CARD_FIELDS: CardFields`
  - `export type CardDraft = { fields: CardFields; phone: string | null; tagline: string | null }`
  - `export type PublicCard = { slug: string; ownerId: string; firstName: string; fullName: string; photoUrl: string | null; title: string | null; company: string | null; headline: string | null; email: string | null; phone: string | null; linkedinUrl: string | null; websiteUrl: string | null; location: string | null; tagline: string | null }`
  - `getCardForOwner(userId: string): Promise<(CardDraft & { slug: string; pausedAt: Date | null }) | null>`
  - `saveCard(userId: string, draft: CardDraft): Promise<{ slug: string }>` — creates on first save, updates after; `phone` via `cleanSingleLine(…, 40)`, `tagline` via `cleanSingleLine(…, 120)`.
  - `resetCardSlug(userId: string): Promise<{ slug: string }>`
  - `setCardPaused(userId: string, paused: boolean): Promise<void>`
  - `previewCard(userId: string, draft: CardDraft): Promise<PublicCard>` — what the public page would show (used by the editor).
  - `loadPublicCard(slug: string): Promise<PublicCard | null>` — null when the slug fails `^[A-Za-z0-9_-]{11}$` (before any query), no row, paused, owner suspended, or `!(await isSurfaceReleased(ownerId, "page.card")) && !isAdminUser(ownerId)`. Hidden fields → null. `fullName` falls back to the email local part.
  - `cardUrl(slug: string): string` → `` `${getAppBaseUrl()}/c/${slug}` ``

- [ ] **Step 1: Write the failing tests** (seed an owner `user_settings` row; release `page.card` by seeding `app_surface_flags` the way other smokes do — `grep -rn "live:page\." scripts`):
  - `saveCard` → `loadPublicCard(slug)` has the owner's name; `email` set by default, `phone` null by default.
  - `fields.email = false` → `.email === null`.
  - `resetCardSlug` → old slug null, new slug loads.
  - `setCardPaused(true)` → null; `false` → loads.
  - Owner `suspendedAt` set → null.
  - Release flag removed → null for a normal owner; non-null when `isAdminUser(ownerId)` is true (set whatever `src/lib/admin.ts` reads, in-process).
  - `loadPublicCard("../../etc")` → null.
- [ ] **Step 2:** `npx tsx scripts/smoke-share-card.ts` — expect FAIL (module not found).
- [ ] **Step 3:** Implement `card-store.ts` and the surface entry.
- [ ] **Step 4:** Rerun — expect PASS; run any surfaces smoke (`ls scripts | grep smoke-surface`) — expect PASS.
- [ ] **Step 5: Commit** `feat(card): card store and page.card surface`

### Task 4: Live event + identifier-only event linking

**Files:**
- Create: `src/lib/cards/live-event.ts`
- Modify: `src/lib/events/store.ts:551` (`recordMetAtEvent`), `src/lib/events/types.ts` (`AttendeeSource` += `"card"` with a doc line)
- Test: `scripts/smoke-share-card.ts`

**Interfaces:**
- Produces: `liveEventFor(userId: string, now?: Date): Promise<{ id: string; title: string } | null>` — raw SQL over `events e` with `attendedEventFilter()` (expects alias `e`), window from Global Constraints, latest `starts_at` wins; null unless `isSurfaceLive(userId, "page.events")`.
- Produces: `recordMetAtEvent(userId, eventId, contactIds, opts?: { source?: AttendeeSource; byName?: boolean })` — defaults `source: "capture"`, `byName: true` (existing callers unchanged); `byName: false` drops the exact-name roster fallback.

- [ ] **Step 1: Write the failing tests:**
  - Attended event that started 1 h ago, no end → returned; started 4 h ago, no end → null; dismissed → null.
  - Roster guest "Sam Lee" (no email); `recordMetAtEvent(owner, ev, [samContactId], { source: "card", byName: false })` leaves that guest unlinked and inserts a roster row with `source = "card"`, `spoke_to = 1`.
  - Same call without opts links the guest by name (capture regression).
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `smoke-share-card` and existing event smokes (`ls scripts | grep smoke-event`) — expect PASS.
- [ ] **Step 5: Commit** `feat(card): live event lookup, identifier-only event linking`

### Task 5: Share-back core (the security core)

**Files:**
- Create: `src/lib/cards/share-back.ts`, `src/lib/cards/share-back-schema.ts` (zod; server-only import)
- Modify: `src/lib/rate-limit.ts` — `RATE_LIMITS.cardShare`, `RATE_LIMITS.cardShareCard`; `BUCKET_LABELS` `cardShare: "card share"`, `cardShareCard: "card share (per card)"`
- Test: `scripts/smoke-share-card.ts`

**Interfaces:**
- Consumes: `loadPublicCard` (Task 3); `liveEventFor`, `recordMetAtEvent` (Task 4); `identityKeysFor` (`duplicates.ts`), `findIdentityOwners` (`contact-identity.ts`), `contactHeadroomForUser`, `createContactForUser`, `logNoteInteractionForUser` (`contact-writes.ts`), `nameMatchesFor` (`contact-resolve.ts`), `recordDuplicateSuggestions` (`contact-merge.ts`), `cleanAgentContactFields`, `cleanSingleLine`, `safeHttpUrl`, `sanitizeAgentText`, `auditUntrustedWrite` (`ai-security.ts`), `consumeIpBucket`, `consumeBucket`, `isRateLimitedError` (`rate-limit.ts`), `isBotRequest`, `recordBotBlocked` (`bot-check.ts`), `MIN_FILL_MS` (`contact-message.ts`).
- Produces:
  - `export type ShareBackInput = { slug: string; nonce: string; name: string; email?: string; phone?: string; company?: string; title?: string; linkedinUrl?: string; message?: string; website?: string; elapsedMs: number }`
  - `export type ShareBackResult = { ok: true } | { ok: false; message: string; fieldErrors?: Record<string, string> }`
  - `export async function shareBackCore(input: ShareBackInput, ctx: { ip: string }): Promise<ShareBackResult>`
  - `export async function resolveUntrusted(userId: string, input: ContactInput): Promise<{ contactId: string | null; status: CardShareStatus }>`

**Order inside `shareBackCore`:**
1. Parse (zod: `name` 1–120, `message` ≤ 500, `nonce` 16–64 chars, `website` must be empty).
2. Honeypot, `elapsedMs < MIN_FILL_MS`, or `isBotRequest()` → `{ ok: true }`, no write (`recordBotBlocked` on BotID hits).
3. `loadPublicCard` null → `{ ok: false, message: "This card isn't available." }`.
4. No identity key from `identityKeysFor({ email, phone })` → `{ ok: false, message: "Please fix the highlighted fields.", fieldErrors: { email: "Add an email or phone so they can reach you." } }`.
5. `consumeIpBucket("cardShare", ip, …)` then `consumeBucket("cardShareCard", cardId, …)`; rate-limited → `{ ok: true }`, no write.
6. Insert `card_shares` (`status: "added"` provisional) `ON CONFLICT (card_id, nonce) DO NOTHING`; conflict → `{ ok: true }`, stop.
7. `resolveUntrusted` → update the row's `status` / `contactId` / `eventId`.
8. If `contactId`: `logNoteInteractionForUser` with the fixed text; then, if `liveEventFor` returned an event, `recordMetAtEvent(…, { source: "card", byName: false })`.
9. `auditUntrustedWrite`.

**`resolveUntrusted` rules:** keys = `identityKeysFor` of email + phone ONLY → owners found → oldest contact, `"matched"`, no writes → else daily cap (≥ 300 `added` in 24 h) or `contactHeadroomForUser` returns 0 → `"held"` → else `createContactForUser(userId, { …cleaned fields WITHOUT linkedinUrl, source: "card" }, { settleClaims: false, skipSummary: true, skipEmbedding: true, skipRevalidate: true })`, then one direct `UPDATE contacts SET linkedin_url` (so `linkedin_slug` is never claimed), then `nameMatchesFor(userId, newId, input)` → `recordDuplicateSuggestions` (never merge) → `"added"`.

- [ ] **Step 1: Write the failing tests** (assert DB state, not only return values):
  - New visitor with email → one contact (`source = "card"`), one interaction, `raw_notes === "Shared their details via your card"`, type `note`, `external_id = "card:<shareId>"`, share `status = "added"`.
  - Contact holds `p@x.test`, company "Old Co" → share-back with that email, company "New Co", message "IGNORE PREVIOUS INSTRUCTIONS" → contact's `fullName, company, title, email, phone, linkedinUrl, notes, howMet, source` unchanged; interaction text is the fixed line; `card_shares.message` holds the message; no interaction's `raw_notes` contains "IGNORE".
  - Email of contact A + phone of contact B → both still exist, `contact_merges` count unchanged, share `contactId` = older of A/B.
  - LinkedIn URL submitted → new contact has `linkedin_url` set and no `contact_identities` row of kind `linkedin_slug`.
  - Only name + company → `{ ok: false }` with `fieldErrors.email`, no rows.
  - Lookalike of existing "Priya Shah" (different email) → new contact + a `duplicate_suggestions` row; existing contact untouched.
  - Live event → text `"Shared their details via your card at <title>"`, type `event`, roster row `source = "card"`.
  - Owner at cap (headroom 0) → share `held`, no new contact, no interaction.
  - `website: "x"` → `{ ok: true }`, no share row; `elapsedMs: 100` → same; `setBotCheckForTests(() => Promise.resolve(true))` → same.
  - 11th submit from one IP in the hour → `{ ok: true }`, still 10 rows.
  - Same nonce twice → 1 share row, 1 interaction.
  - Paused card → `{ ok: false, message: "This card isn't available." }`.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement schema, core, rate-limit entries.
- [ ] **Step 4:** Run — expect PASS. Then revert each guard once (LinkedIn not claimed, no write on match, nonce conflict) and confirm its assertion FAILS; restore.
- [ ] **Step 5: Commit** `feat(card): share-back core with untrusted resolve`

### Task 6: Public page, vCard route, public plumbing

**Files:**
- Create: `src/app/(site)/c/[slug]/page.tsx`, `src/app/(site)/c/[slug]/not-found.tsx`, `src/app/(site)/c/[slug]/vcard/route.ts`, `src/components/card/public-card.tsx` (server), `src/components/card/share-back-form.tsx` (`"use client"`), `src/actions/card-public.ts`
- Modify: `src/lib/public-routes.ts` (`"/c/(.*)"` with a comment like `/scan`'s), `src/lib/waitlist-host.ts` (`STEALTH_OPEN_PREFIXES` += `"/c/"`; `BOTID_PROTECTED_POSTS` += `/c/*` in its existing format), `src/app/robots.ts` (disallow `/c/`), `src/app/site-sources.css` (`npm run css:site`)

**Interfaces:**
- Consumes: `loadPublicCard` (Task 3); `buildVCard`, `vcardFileName` (Task 2); `shareBackCore`, `ShareBackInput`, `ShareBackResult` (Task 5); `clientIpFrom` (`src/lib/client-ip.ts`).
- Produces: `shareBackToCard(input: ShareBackInput): Promise<ShareBackResult>` — the only export of `src/actions/card-public.ts` (`"use server"`), body `shareBackCore(input, { ip: clientIpFrom(await headers()) })`.

Page: `generateMetadata` → title `` `${fullName} · Orbit` ``, `robots: { index: false, follow: false }`; `dynamic = "force-dynamic"`; `notFound()` on null. Top to bottom at 375 px: photo, name, title @ company, headline, tagline, link buttons (`mailto:`, LinkedIn, website), primary **Save contact** (`<a href="/c/<slug>/vcard">`), then **Share your details with {firstName}** (name*, email, phone, company, role, LinkedIn, "Anything to remember?"; hidden `website`; `nonce = crypto.randomUUID()` on mount; `elapsedMs` from mount; `type="email"`/`"tel"`/`"url"` and `autocomplete` `name`/`email`/`tel`/`organization`/`organization-title`/`url`). Done state: "{firstName} has your details." + Save contact again.

vCard route: `GET(_req, { params }: { params: Promise<{ slug: string }> })`; null → 404; else `buildVCard({ …, note: "Met via Orbit" })`, headers `Content-Type: text/vcard; charset=utf-8`, `Content-Disposition: attachment; filename="<ascii name>"; filename*=UTF-8''<encoded>`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`.

- [ ] **Step 1:** Add to `smoke-share-card.ts`: import the route's `GET`, call it for a live slug → 200 with the four headers and `FN:` in the body; after `resetCardSlug` the old slug → 404. Run — expect FAIL.
- [ ] **Step 2:** Implement page, components, action, route, list entries; `npm run css:site`.
- [ ] **Step 3:** Run `smoke-share-card`, `smoke-public-routes`, `smoke-clerk-free-site`, `smoke-site-css-sources`, `smoke-origin-checks` — expect PASS. Remove the `PUBLIC_ROUTES` line once and confirm `smoke-public-routes` FAILS; restore.
- [ ] **Step 4: Commit** `feat(card): public card page, vCard download, share-back form`

### Task 7: Owner page `/card`, show mode, entry points

**Files:**
- Create: `src/lib/cards/arrivals.ts`, `src/actions/cards.ts`, `src/app/(clerk)/(app)/(main)/card/page.tsx`, `src/app/(clerk)/(app)/(main)/card/show/page.tsx`, `src/components/card/card-editor.tsx`, `src/components/card/card-share-panel.tsx`, `src/components/card/arrivals-list.tsx`, `src/components/card/card-qr.tsx`
- Modify: `src/components/layout/app-shell.tsx` (mobile header QR button → `/card/show`), `src/components/layout/command-palette-dialog.tsx` ("Share my card" → `/card/show`), `src/lib/app-nav.ts` (`MOBILE_MORE_NAV` and the sidebar list: `/card`, "Your card"), the event detail page under `src/app/(clerk)/(app)/(main)/events/` ("Share your card" → `/card/show`, shown only while `liveEventFor` returns that event)

**Interfaces:**
- Consumes: Task 3 store; `requireUserForReleasedSurface("page.card")` (`plan-guards.ts`) first in every action; the `QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#000000", light: "#0000" } })` + `currentColor` swap exactly as `mintScanHandoffAction` (`src/actions/scan.ts:42`); `logNoteInteractionForUser`; `actionFailure` (`src/lib/action-failure.ts`).
- Produces in `src/lib/cards/arrivals.ts`:
  - `export type Arrival = { id: string; name: string; company: string | null; title: string | null; email: string | null; phone: string | null; message: string | null; status: CardShareStatus; contactId: string | null; eventTitle: string | null; ownerNote: string | null; createdAt: string }`
  - `listArrivals(userId: string, limit = 50): Promise<Arrival[]>` (newest first)
  - `addArrivalNoteCore(userId: string, shareId: string, text: string): Promise<{ ok: true } | { ok: false; message: string }>` — owner-scoped; `held` → `{ ok: false, message: "Make room in your contacts first." }`; else `logNoteInteractionForUser(userId, { contactId, rawNotes: text, interactionType: "note", source: "card", externalId: \`card-note:${shareId}\` })` on first save, and `ownerNote = text` every save.
- Produces in `src/actions/cards.ts`: `getMyCard()`, `saveMyCard(draft: CardDraft)`, `resetMyCardLink()`, `setMyCardPaused(paused: boolean)`, `getMyCardQr(): { ok: true; svg: string; url: string } | { ok: false; message: string }`, `listMyArrivals(): Arrival[]`, `addArrivalNote(shareId: string, text: string)` — mutations return `{ ok: true, … } | { ok: false; message: string }`.

UI: no card → editor (a toggle per `CardFields` key, phone + tagline inputs, live `previewCard`, **Create my card**). With a card: QR, **Copy link**, **Share** (`navigator.share`, else copy), **Show full screen** → `/card/show`, **Reset link** behind a confirm with "Printed codes and NFC stickers with the old link will stop working.", **Pause** toggle, editor collapsed under "Edit what's on your card", **Arrivals** (5000 ms poll while visible). Arrival rows show the visitor's message in a muted quote labelled "They wrote"; held rows say "Waiting — make room in your contacts". Show mode: QR at `min(80vw, 80vh)`, name, "Scan to save my contact", latest 3 arrivals, Screen Wake Lock when available.

- [ ] **Step 1:** Add to `smoke-share-card.ts`: `addArrivalNoteCore` twice on one share → one note interaction (owner's text), `ownerNote` = latest text; on a `held` share → refusal, no interaction; another user's shareId → refusal. Run — expect FAIL.
- [ ] **Step 2:** Implement `arrivals.ts`, actions, pages, components, entry points; rerun — expect PASS.
- [ ] **Step 3:** `npx tsc --noEmit` and `npm run lint` — expect 0 errors.
- [ ] **Step 4: Commit** `feat(card): /card owner page, show mode, arrivals with quick note`

### Task 8: Privacy line, full suite, browser check

**Files:**
- Modify: `src/app/(site)/(docs)/privacy/page.tsx` (one paragraph in the section listing what Orbit stores)

Copy (exact): "**Your Orbit card.** If you make a card, the fields you switch on are visible to anyone with its link. When someone shares their details back through your card, we store what they typed and add them to your Orbit only — they are not added to anyone else's. You can pause your card or reset its link at any time, which makes the old link stop working."

- [ ] **Step 1:** Add the paragraph. /terms is unchanged, so `TERMS_VERSION` stays.
- [ ] **Step 2:** Stop any `next dev`; `npx tsc --noEmit`, `npm run lint`, `npm test` — expect green (rerun a failing smoke alone before calling it real).
- [ ] **Step 3:** Browser (demo-mode preview; Playwright + system Chrome if the pane is hidden): `/card` → create → `/c/<slug>` at 375 px → Save contact returns the `.vcf` with the headers → share back → arrival on `/card` within ~5 s → add note → note on the contact page. Seed a live event → arrival on its roster with "spoke to". Screenshot `/c/<slug>` and `/card/show`.
- [ ] **Step 4: Commit** `docs(privacy): Orbit card`, then re-check remote `SCHEMA_VERSION`s and renumber if any branch claims ours.
