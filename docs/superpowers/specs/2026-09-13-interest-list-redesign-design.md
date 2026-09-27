# /interest redesign: a waitlist-shaped page for a list with no queue

**Date:** 2026-09-13
**Status:** Implemented on this branch (Sep 13 2026); three parked follow-ups listed in the PR
**Branch:** `claude/interest-list-redesign-232471` (behind `origin/main` at the time of
writing; merge main before implementation)

## Problem / motivation

`/interest` (`src/app/(site)/interest/page.tsx`, PR #139) is a quiet mailing-list
opt-in: hero, glass email card, three expectations, a sign-up detour, FAQ, final CTA. It
works, and its form already has real choreography (orbiting loader, starfield burst,
drawn checkmark). What it lacks is the thing that makes a YC-style waitlist page spread:
a number you get, a thing you can share, and proof that other people are here.

The page also insists, in three places, that "this isn't a waitlist". That stays true —
Orbit is live and sign-up is open — so the redesign borrows the waitlist *feel* without
inventing a queue.

A hidden mechanic already exists to build on: every signup is assigned a planet by ordinal
(`planetForSignupNumber` in `src/lib/interest-list-email.ts`: 1st gets Mercury, 8th
Neptune, then it cycles) and told about it in the welcome email. The page never shows it.

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Stance | Waitlist feel, honest list | Orbit is live; no fake queue, no gating. Counter, number + planet, share link, social proof. |
| Mechanics | Live counter, number + planet reveal, share link with referral tracking | Chosen over share-buttons-only. |
| Referral value | Visible count, drawn as moons orbiting your planet; a personal ticket URL | Recognition, no perks, no billing entanglement. |
| Sections kept | "What to expect" trio, FAQ, final CTA | The "Nothing to wait for" sign-up detour is dropped; its job moves to one ticket line and one FAQ answer. |
| Counter honesty | Hidden below a floor of 50 | Below it the same slot shows "Next planet up: X", which is always true. |
| Rendering | Fully dynamic page | Chosen over a static shell with client personalization: the ticket and invite strip render in the HTML, no post-hydration flash. The proof line is cached 60s to keep DB load flat. |
| Hero composition | Centered stack | Headline, one line, glass card with the proof line inside it, rings behind. One column, one ask. |
| Post-join reveal | Boarding pass | Card flips into a ticket: stub (planet, moons, number) + details (share tools). The thing people screenshot. |
| Share preview | Per-person ticket image | A `next/og` route renders the boarding pass for link previews. |
| Privacy | Real tickets for duplicate submits | Membership becomes inferable from the number. Accepted: opt-in newsletter, ticket is public by design, email never returned, duplicates send nothing, rate-limited. |

## Page structure

Top to bottom, all inside the existing `landing-root` shell with `LandingStarfield
interactive`:

1. **Header** — unchanged (`BackControl`, logo, `LandingAuthControls`).
2. **Hero, centered** — eyebrow "Interest list"; headline "Stay in *orbit*." (unchanged);
   one line: "Occasional notes from the one person building Orbit. Join and you're handed a
   planet."
3. **The card** — `landing-glass`, `OrbitRingsBackdrop` behind it (unchanged). Holds one
   of the three states below. In the form states the **proof line** sits inside the card
   under the field: a stack of small planet dots (the last three planets handed out) plus
   "1,284 people have joined · next planet up: Mars". Below the floor the count is omitted
   and the line reads "Next planet up: Mars".
4. **"What to expect"** — the existing trio, restyled to match, copy unchanged.
5. **FAQ** — existing `FaqList`; the "Is this a waitlist?" answer is rewritten: there is no
   queue and nothing to wait for, Orbit is live; the number and planet are yours to keep;
   the notes are the point.
6. **Final CTA** — "One address. Occasional news." anchoring to `#interest-join`.
7. **Footer** — unchanged.

Dropped: the "There's nothing to wait for" section and its hero-variant auth buttons.

### The card's three states

| State | URL | Contents |
|---|---|---|
| Form | `/interest` | Email field, "Join the list" button, proof line, honeypot. |
| Invited | `/interest?ref=TOKEN` | Form, plus a strip above the field: "Someone on Mars invited you. Join and you'll orbit right behind them." Planet resolved from the token on the server. Unknown token: no strip, no error. The token rides in a hidden field. |
| Ticket | `/interest?me=TOKEN`, or in place after joining | The boarding pass (below). Invalid token: plain form, silently. |

While the ticket shows, the headline reads "You're in *orbit*." (crossfade on the in-place
transition; server-rendered on a direct visit).

### The boarding pass

Two panes in one glass card, a perforated seam between them (an SVG dashed line, so it can
draw itself). On phones the stub stacks above the details.

**Stub:** the planet (the existing `public/landing/planets/*.{avif,webp,png}` art in a
`<picture>`, with the hero's `hero-planet-sphere` / `hero-planet-atmosphere` treatment),
its moons on an orbit ring around it, "#1,285" in Fraunces with tabular numerals, the
planet name beneath.

**Details:** eyebrow "Orbit · Interest list"; "Passenger 1,285, bound for *Mars*."; the join
date; the moon line — "3 people joined through you. They're the moons." or, at zero, "No
moons yet. Share your link and watch them arrive."; the share link in a read-only field
with a **Copy** button; **Share on X** and **LinkedIn** buttons; a **Share…** button that
appears after hydration where `navigator.share` exists; "Save this link — it's your page.";
"Not one for waiting? Orbit is live — start free." linking to the same `signUpHref` the
page computes today.

After a join in the same visit, once the action has resolved, the URL is rewritten to
`?me=TOKEN` with `history.replaceState` so a reload keeps the ticket. (Never call
`replaceState` while a server action is queued — see the memory on it; here it runs
strictly after the action returns.)

## Data model

`interest_list_signups` gains two columns (`src/db/schema.ts`, the `CREATE TABLE` template
in `src/db/index.ts`, and the `alters` list — all three, plus the index lines, so
`scripts/smoke-schema-ddl.ts`'s parity check stays green):

| Column | Type | Notes |
|---|---|---|
| `share_token` | `text`, nullable, **unique index** `interest_list_signups_share_token_uidx` | Opaque, minted with `generateUnsubscribeToken()`'s generator (same shape, separate value — the unsubscribe token must never appear in a public link). Nullable because existing rows have none; minted the next time the row is touched by a submit. |
| `referred_by_id` | `uuid`, nullable, **index** `interest_list_signups_referred_by_idx` | The referrer's row id, resolved from the `ref` token at join time. No FK, like the rest of the schema. |

`SCHEMA_VERSION` goes from 50 to **52**. 51 is taken by
`origin/claude/capture-page-redesign-525456`. Re-run the all-branches scan before opening
the PR and bump again if something else lands first (see the "merging DDL needs a new
version" memory).

## Read module: `src/lib/interest-list-ticket.ts`

Server-only, imports `@/db` and nothing from `next/server` (the low-level-module rule).

```ts
type Ticket = {
  number: number;        // ordinal by (created_at, id)
  planet: WelcomePlanet; // asWelcomePlanet(row.welcome_planet)
  joinedAt: Date;
  moons: number;         // rows with referred_by_id = row.id, unsubscribed or not
  shareToken: string;
};

getTicketByShareToken(token: string): Promise<Ticket | null>
getInviterPlanet(refToken: string): Promise<WelcomePlanet | null>
getInterestProof(): Promise<{ count: number; nextPlanet: WelcomePlanet; recent: WelcomePlanet[] }>
```

- **Ordinal:** `count(*) where created_at < mine or (created_at = mine and id <= mine)`.
  Two rows inserted in the same instant get distinct numbers.
- **Proof** is memoised in the module for 60 s; `invalidateInterestProof()` clears it on
  insert. Not `unstable_cache`: Next 16 deprecates the one-argument `revalidateTag`, and
  the helper cannot run inside a tsx smoke script. `count` is total rows ever joined — the same
  population the ordinals are drawn from, so "#1,285" and "1,284 have joined" agree.
  `nextPlanet = planetForSignupNumber(count + 1)`. `recent` is the `welcome_planet` of the
  last three rows by `created_at desc`, nulls mapped through `asWelcomePlanet`.
- `INTEREST_LIST_COUNT_FLOOR = 50` lives in `src/lib/interest-list.ts` (client-safe) so
  the page and the smoke test share it.

## Join action: `src/actions/interest-list.ts`

Input gains `ref?: string` (max 64, optional). Result becomes:

```ts
type InterestListResult =
  | { ok: true; ticket: { number: number; planet: WelcomePlanet; joinedAt: string; moons: number; shareToken: string } }
  | { ok: false; message: string };
```

Order of operations:

1. **Honeypot:** `website` non-empty → the plausible ticket below, before any parsing.
   (Today the honeypot fails schema validation and returns an *error*, contradicting the
   action's own comment that bots get the same success as everyone; this makes the code
   match the comment. The schema's `website: max(0)` stays as the second line of defence.)
2. Validate with `interestListSchema`. Failure → `{ ok: false, message }` as today.
3. **Too fast** (`elapsedMs < MIN_FILL_MS`) → `ok` with a **plausible ticket**: `number = cachedCount + 1`, planet for it, `moons: 0`, a freshly
   generated token that is stored nowhere, `joinedAt: now`. No row, no email.
4. **Rate limit:** `consumeBucket("interest.join", ip, RATE_LIMITS.interestJoin)` with a
   new policy `interestJoin: { limit: 5, windowSec: 600 }` in `src/lib/rate-limit.ts`.
   A `RateLimitedError` → the same plausible ticket. This replaces the per-instance `Map`
   limiter, which never held across instances. Any other throw from the limiter also →
   plausible ticket (a limiter that cannot count should not break signups, but it must not
   fail open into the write either — so the fake ticket, not the real path).
5. Resolve `ref`: `select id from interest_list_signups where share_token = ref`. Unknown →
   null.
6. Read-then-write, by email:
   - **No row:** insert `{ email, attribution…, unsubscribeToken, welcomePlanet:
     planetForSignupNumber(count + 1), shareToken: new, referredById: ref?.id ?? null }`
     with `onConflictDoNothing().returning()`. Empty returning (lost a race) → re-select
     the row and treat it as the *active* branch. Otherwise → **send welcome**.
   - **Row, unsubscribed:** update `unsubscribed_at = null, follow_up_sent_at = null,
     share_token = coalesce(share_token, new)`. Planet kept, `referred_by_id` untouched →
     **send welcome**.
   - **Row, active:** update `share_token = coalesce(share_token, new)` only if null.
     **No email.**
   - Self-referral: if `ref` resolves to the row we are about to touch, ignore it. (Only
     reachable on the insert branch by submitting the email that owns the token — which
     means the row exists, so the insert branch is never taken. Guard anyway.)
7. `invalidateInterestProof()` on the insert branch.
8. Return the real ticket via `getTicketByShareToken`.

The welcome and follow-up email builders gain `ticketUrl` and `shareUrl`
(`${appUrl}/interest?me=…` and `?ref=…`); each template adds two short lines. The welcome
send is best-effort as today.

`src/components/landing/waitlist-form.tsx` reads only `result.ok` and needs no change.

## Page and metadata: `src/app/(site)/interest/page.tsx`

- `export const dynamic = "force-dynamic"`. Reads `searchParams` (`me`, `ref`; both
  trimmed, max 64 chars, anything else ignored).
- Loads `getInterestProof()` always; `getTicketByShareToken(me)` when `me` is present;
  `getInviterPlanet(ref)` when `ref` is present and `me` is not. `Promise.all`.
- Passes a single `initial` prop to the client card: `{ kind: "form", proof, invite? }` or
  `{ kind: "ticket", ticket }`.
- `generateMetadata({ searchParams })`: for a token that resolves, title "Passenger 1,285,
  bound for Mars — Orbit", description "Every person who joins Orbit's interest list is
  handed a planet. Get yours.", `openGraph.images` and `twitter.images` set to the absolute
  ticket-image URL (built with `getAppBaseUrl()`; the root layout sets no `metadataBase`),
  `twitter.card: "summary_large_image"`. Otherwise today's metadata.
- The `Reveal` wrappers below the fold stay. `InterestPageSkeleton` in
  `src/components/loading/page-skeletons.tsx` is redrawn to the new hero.

## Ticket image: `src/app/api/interest-list/ticket-image/route.tsx`

- `GET ?token=…`, public: add `/api/interest-list/ticket-image` to `PUBLIC_ROUTES` in
  `src/lib/public-routes.ts`, next to the unsubscribe route.
- `ImageResponse` from `next/og`, 1200×630. The boarding pass: deep-space ground
  (`#05070f`), stub with the planet PNG (read from `public/landing/planets/<planet>.png`
  and inlined as a data URI — Satori fetching its own origin is one more moving part than
  reading a file), "#1,285", planet name; details with "Passenger 1,285, bound for Mars."
  and the Orbit wordmark. **No moons** on the image, so caching cannot make it stale in a
  way that matters.
- Type: one vendored Fraunces TTF (regular) plus one italic, under
  `src/app/api/interest-list/ticket-image/fonts/` with the OFL licence file beside them,
  loaded with `readFile`. `next/font/google` does not expose files to `ImageResponse`, and
  fetching Google Fonts at request time is a network dependency in a link-preview path.
- Headers: `Cache-Control: public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400`.
- Missing token → the generic card (same layout, "Get your planet" instead of a number),
  **200**, same cache headers. Unknown token → **308** to the tokenless URL, so every bogus
  token shares one CDN entry and one render instead of minting its own. A shared link must
  never show a broken preview.
- `runtime = "nodejs"` (the project standard; edge is not used anywhere).

## Motion and interaction

House tokens throughout (`src/lib/motion.ts`: `EASE_HOUSE`, `DUR`, `SPRING_SOFT`);
`MotionConfig reducedMotion="user"` is already provided by the marketing layout, and the
component additionally reads `useReducedMotion` for the imperative bits.

**On join (in-place transition):**

1. Submit → the existing orbiting loader on the button.
2. Success → the existing starfield pulse from the button's centre, measured before the
   button unmounts.
3. The card flips on Y: a `perspective` wrapper, the inner `motion.div` animates
   `rotateY` 0 → 90 (`DUR.slow`, ease-in half of the house curve), content swaps to the
   ticket at 90, then −90 → 0 (`DUR.slow`, ease-out). Height animates with `layout`. Total
   ≈ 0.55 s. The card's `backdrop-filter` is fine under a 3D transform in Chromium and
   Safari; verify the seam against the "Lightning CSS backdrop-filter trap" memory.
4. Ticket assembly, after the flip lands, in order:
   - seam: SVG `pathLength` 0 → 1 over `DUR.slow`;
   - number: rolls up from `max(1, number − 40)` to `number` over `DUR.celestial` on the
     house curve, via `animate()` on a motion value with `Math.round` on the way to text;
     `font-variant-numeric: tabular-nums` so the width never jitters;
   - planet: scale 0.6 → 1 on `SPRING_SOFT`, glow opacity 0 → 1;
   - moons: each drops onto the ring with a 90 ms stagger (scale 0 → 1, `DUR.base`), then
     all drift on a CSS rotation (`interest-orbit`-style keyframes, ~40 s), paused under
     reduced motion;
   - details column: each line rises 8 px and fades in, 40 ms stagger, share row last.
5. Headline crossfades "Stay in orbit." → "You're in orbit." (`AnimatePresence`, `DUR.slow`).
6. Focus moves to the ticket's heading after the assembly, as the current form does.

**On a direct ticket visit:** no flip. The ticket is in the HTML fully visible (progressive
enhancement, like `Reveal`); after hydration only the number roll and moon drop play, once.
The proof line's count does the same short roll on every load, from the final number minus
a few dozen; the server renders the final number so no-JS and reduced-motion see it at
once. The invited strip is static.

**Share row:** Copy uses `navigator.clipboard.writeText`, falls back to selecting the
field; the label becomes "Copied" with a check for 1.6 s and the field's border flashes
gold. X opens `https://twitter.com/intent/tweet?text=…&url=…`, LinkedIn opens
`https://www.linkedin.com/sharing/share-offsite/?url=…`, both `target="_blank"
rel="noopener noreferrer"`. Share text: "I'm passenger #1,285 on Orbit's interest list,
bound for Mars. Get your planet:". "Share…" calls `navigator.share({ title, text, url })`
and is rendered only after mount when the API exists.

**Moons cap:** up to 12 drawn; the count line carries the rest.

## Privacy and abuse

- **Accepted change:** a submit now returns the address's real ticket, so whether an
  address was already on the list can be inferred from its number. Mitigations: the email
  is never returned; the ticket exposes only number, planet, date, moon count; duplicates
  send no email; 5 submits per 10 minutes per IP, enforced in the shared bucket table.
- Bots, too-fast fills and rate-limited callers get a plausible ticket and no row — the
  response shape is identical to a real join, so nothing about which check failed leaks.
- The share token is separate from the unsubscribe token and grants nothing but a
  read-only ticket view and referral credit.
- Referral credit is only written on a brand-new row, never on a rejoin, never to yourself.
  Farming moons costs real signups at the rate limit and earns a drawing.
- The ticket image route is cacheable and rate-limited only by the CDN cache; the
  generator is bounded work with no DB fan-out (one indexed read).

## Edge cases

- Rows created before `share_token` existed have none; they get one the next time that
  email is submitted. No `?me=` link exists for them until then (their welcome email had
  none).
- Rows created before `welcome_planet` existed read as Mercury (`asWelcomePlanet`).
- An unsubscribed person's `?me=` link still renders their ticket; the count and ordinals
  include them (they did join).
- `?ref=` and `?me=` together: `me` wins; `ref` is ignored.
- The counter floor is compared against the cached `count`, so a page can show "50 have
  joined" up to a minute after the 50th join. Acceptable.
- The proof memo is per instance; a second instance can lag up to 60 s behind a join. Fine.
- The page is now dynamic: the marketing `loading.tsx` / `InterestPageSkeleton` shows on
  client navigations. Keep it structurally faithful to the new hero.

## Testing and verification

Three new smoke scripts, `pglite` tier, added to `MANIFEST` in `scripts/run-smoke.ts`,
each starting with `import "./smoke/_env"`:

1. **`scripts/smoke-interest-list-join.ts`** — drives the join logic directly. The
   action is split: `joinInterestList` (the `"use server"` export) reads `headers()` and
   `cookies()` and delegates to a headers-free `joinInterestListCore(input, { ip,
   attribution })` in `src/lib/interest-list-join.ts`, which is what the script calls.
   Asserts: new join → #1, Mercury, a stored share token; same email →
   same token, same number, still one row; unsubscribed rejoin → `unsubscribed_at` null,
   `follow_up_sent_at` null, planet kept; join with a valid `ref` → `referred_by_id` set,
   referrer's moons = 1; self-ref and unknown ref → null; honeypot → ok, fake ticket, no
   row; sixth submit in the window → fake ticket, no row; two rows with equal
   `created_at` → distinct numbers; proof: count omitted below the floor, `nextPlanet`
   correct, `recent` in order.
2. **`scripts/smoke-interest-list-page.ts`** — calls the page function with
   `searchParams` of `{}`, `{ ref }`, `{ me }`, `{ me: "bogus" }`, walking the element tree
   the way `smoke-interest-list-admin.ts` does. Asserts the proof line, the invited strip's
   planet, the ticket's number and planet, the form fallback on a bad token, and that
   `generateMetadata` returns the ticket-image URL for a valid token and the default
   otherwise.
3. **`scripts/smoke-interest-ticket-image.ts`** — calls the route handler with a valid and
   an invalid token; asserts 200, `image/png`, and the cache header on both. If Satori's
   wasm proves too slow or flaky under the harness, register it as `manual` and say so in
   the PR.

Existing gates: `scripts/smoke-interest-list-admin.ts` (new columns are nullable, must
stay green), `npm run db:check`, `npm run build`, `npx eslint` at zero errors (the baseline
memory: any error is yours).

Browser verification: the in-app Browser pane running the `orbit-web` launch config on
port 3001, kept FRONTED (a hidden pane starves rAF — see the occluded-tab memory), at desktop and the 390-wide mobile preset, plus one pass with
`prefers-reduced-motion: reduce`. Walk: load → proof line → invited strip via `?ref` →
join → flip → ticket assembly → Copy → reload keeps the ticket → `?me` direct visit →
image route renders. Screenshots in the PR.

## Out of scope

- The landing page's `WaitlistForm` keeps its one-line success state.
- Referral perks, leaderboards, position-skipping.
- Capturing `?ref` in the attribution cookie in `src/proxy.ts` (session-only capture via
  the hidden field is enough; the cookie route stays available as an upgrade).
- Admin: the interest-list console gains nothing in this pass. (A "moons" column is a
  one-liner later.)

## Files

New:
- `src/lib/interest-list-ticket.ts`
- `src/lib/interest-list-join.ts` (headers-free core of the join action)
- `src/components/interest/boarding-pass.tsx` (the ticket, client)
- `src/components/interest/interest-hero.tsx` (eyebrow, crossfading headline, sub-line, and
  the card state machine: form / invited / turning / ticket, the flip; absorbs today's `interest-form.tsx`)
- `src/components/interest/share-row.tsx`
- `src/components/interest/proof-line.tsx`
- `src/components/interest/moons.tsx`, `src/components/interest/planet-art.tsx`
- `src/lib/welcome-planets.ts` (client-safe planets; the email module re-exports them)
- `next.config.ts` gains `outputFileTracingIncludes` for the fonts and planet PNGs
- `src/app/api/interest-list/ticket-image/route.tsx` + `fonts/`
- `scripts/smoke-interest-list-join.ts`, `scripts/smoke-interest-list-page.ts`,
  `scripts/smoke-interest-ticket-image.ts`

Changed:
- `src/app/(site)/interest/page.tsx`
- `src/actions/interest-list.ts`, `src/lib/interest-list.ts`
- `src/lib/interest-list-email.ts` (two links per template)
- `src/db/schema.ts`, `src/db/index.ts` (template, alters, `SCHEMA_VERSION` 52)
- `src/lib/rate-limit.ts` (`interestJoin` policy)
- `src/lib/public-routes.ts`
- `src/components/loading/page-skeletons.tsx`
- `src/app/globals.css` (moon drift keyframes, ticket seam, flip perspective)
- `scripts/run-smoke.ts` (manifest)

Removed:
- `src/components/interest/interest-form.tsx` (folded into `interest-hero.tsx`)
