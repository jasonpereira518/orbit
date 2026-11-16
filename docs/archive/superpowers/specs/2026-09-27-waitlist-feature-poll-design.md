# Waitlist feature poll — design

Date: 2026-09-27 · Branch: `claude/waitlist-feature-poll-85bec5`

## Goal

An interactive poll on the waitlist page (`src/app/(site)/interest/page.tsx`), between
"How early access works" and "A few answers": visitors vote for the feature they want most,
and once they have voted they see every option ranked by what other people chose.

## Decisions (from brainstorming)

- **Who votes:** anyone. If the visitor arrives with a `?me=` pass that resolves to a signup,
  the vote is keyed to that signup; otherwise to a random `wp_voter` cookie id.
- **Low-vote results:** below a floor of 25 total votes, show ranked bars only (no
  percentages or counts) with the caption "Results sharpen as more votes come in." At or
  above the floor, show percentages. No seeded/fabricated votes.
- **Single choice, changeable.** Tapping another option moves the vote (upsert).
- **Fixed option order** before voting (authored order; no per-visitor shuffle, which would
  risk a hydration mismatch).
- **Out of scope:** admin results view (the public results are the same data), admin-editable
  options, live polling of results, deduping across different browsers without `?me=`.

## Data

New table `waitlist_poll_votes`:

| column      | type        | notes                                           |
|-------------|-------------|-------------------------------------------------|
| id          | uuid PK     | `defaultRandom()`                               |
| option_id   | text        | validated against the option list in code       |
| voter_key   | text UNIQUE | `signup:<id>` or `cookie:<random id>`           |
| signup_id   | uuid, nullable | `interest_list_signups.id`. No FK and no `ON DELETE SET NULL` (repo convention): a deleted signup simply leaves the vote counted |
| created_at  | timestamptz | default now                                     |
| updated_at  | timestamptz | bumped when the vote changes                    |

Index on `option_id` for the tally. Migration follows the new-table path: `pgTable` in
`src/db/schema.ts`, `CREATE TABLE IF NOT EXISTS` in the `DDL` template in `src/db/index.ts`,
`SCHEMA_VERSION` bump (126 as built), `EXPECTED_TABLES` in `scripts/setup-db.ts`, then
`smoke-schema-ddl.ts --update`. Main moves quickly; rescan versions
before pushing (see the merge-DDL-needs-new-version note).

## Behaviour

**Options** live as a const in `src/lib/waitlist-poll.ts` (pure, client-safe) with stable ids and plain-language
labels (no product jargon, matching the page's under-wraps stance). First-draft list:

1. Ask your network anything
2. Reminders to reach out at the right moment
3. Auto-import from your inbox and calendar
4. A visual map of your network
5. Drafted outreach messages
6. Finding new people worth knowing

**Vote action** (`src/actions/waitlist-poll.ts`, request-reading half; logic in
`src/lib/waitlist-poll-votes.ts` (server-only, DB) so the smoke can drive it without a request):

1. Rate-limit by IP via a new `RATE_LIMITS.pollVote` bucket (~20 per 10 min).
2. Reject an unknown `option_id`.
3. Resolve the voter: valid `?me=` token → `signup:<id>` (and delete any cookie-keyed vote
   from this browser, so voting before and after joining doesn't count twice); otherwise the
   `wp_voter` cookie (httpOnly, long-lived; minted if absent).
4. Upsert on `voter_key`.
5. Return the fresh tally plus the voter's choice.

**Tally** is a `GROUP BY option_id`, memoized ~30s (invalidated on a write, like the proof
line). The page is already `force-dynamic`, so the server reads the cookie / `?me=` and
renders returning voters straight into the results state with no flash.

## UI (`src/components/interest/feature-poll.tsx`, client)

- Section heading "What should we build first?", same `HEADING` / `Reveal` treatment and
  `landing-glass` cards as the neighbouring sections.
- Before voting: a `role="group"` of toggle-button cards (`aria-pressed`); one tap casts the vote, no submit button. Not a radiogroup: arrow keys on native radios would cast a vote on every press and, with the reordering list, alternate the top two cards.
- After: bars animate in from zero, cards reorder to ranked order with a layout animation,
  rank number and share on each, the visitor's pick highlighted with a check. Tapping another
  card changes the vote.
- Below the floor: bars in rank order, no numbers, plus the caption. At/above: percentages.
- Reduced motion: reveal and reorder snap. Read the preference at render time, not from the
  hook's first render (it is false for one render).
- `aria-live` note on vote ("Your vote is in").
- Optimistic update with rollback and a friendly error on failure (`friendlyError`, never
  `err.message`).

## Files

- `src/lib/waitlist-poll.ts` — options, floor, ranking helpers (pure, client-safe)
- `src/lib/waitlist-poll-votes.ts` — tally, vote core, DB access (server-only)
- `src/lib/waitlist-pass-events.ts` — small client DOM event so a just-joined visitor's vote ties to their signup without a reload
- `src/actions/waitlist-poll.ts` — request-reading action
- `src/components/interest/feature-poll.tsx` — client component
- `src/app/(site)/interest/page.tsx` — new section + server-side initial state
- `src/db/schema.ts`, `src/db/index.ts`, `scripts/setup-db.ts` — table
- `src/lib/rate-limit.ts` — `pollVote` bucket
- `scripts/smoke-waitlist-poll.ts` — new smoke (registered per repo convention)

A server action posts to the page path, which is already public, so no `PUBLIC_ROUTES` /
`WAITLIST_ALLOWED_PATHS` change is expected; verify on the waitlist host.

## Testing

- `smoke-waitlist-poll.ts` (run with `DATABASE_URL=""` → local PGlite, never shared Neon):
  first vote, change vote, signup-tied dedupe, cookie→signup handoff, invalid option,
  floor rule, rate limit.
- `smoke-schema-ddl.ts`, `tsc --noEmit`, eslint (baseline: 0 errors).
- Browser pass at desktop and phone width and with reduced motion (dev server on a free
  port; do not run a build against the same `.next`).
- `scripts/dev/scan-waitlist-leaks.mjs` against a production build to confirm nothing
  branded reaches the waitlist host.

## Accepted risks

- A different browser without `?me=` can vote again; a poll about feature preference
  tolerates this noise.
- Fixed option order carries some position bias.
