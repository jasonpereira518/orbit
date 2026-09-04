# LinkedIn Experience Extraction

**Date:** 2026-09-03
**Status:** Design approved, not yet implemented

## Problem

A contact carries only its *current* `title` and `company`. Everything a person did
before now is absent from Orbit, so two kinds of question cannot be answered:

- On a person's own page — "what has she actually done?", "how long was he at Stripe?"
- Across the network — "who has ever worked at Google?", "who came out of a hardware
  company?"

The second is the one that motivates this: past employers and schools are what make a
network worth having, and today they are invisible.

## Sources

LinkedIn has no API for third-party profiles. Two sources, both already partly built:

**The Chrome extension.** Its LinkedIn adapter already reads the rendered profile page
and ships a text blob. It sees exactly what the user sees, which is the most accurate
picture available, and it costs the user nothing beyond a click.

**Apollo.** `people/match` is already called per contact by LinkedIn URL, and its
response already contains `employment_history` and `education` — which
`normalizeLinkedInProfile` currently discards. Structured, dated, works in bulk, but
gated on an Apollo key and blind to About/skills.

There is deliberately no paste-a-profile path.

## Scope

Everything on the profile page: roles, education, About, headline, skills,
certifications, volunteering, publications.

## Data model

Two new tables. Nothing is added to `contacts`, and `search_tsv` is not touched.

### `contact_profiles`

One row per contact, unique on `(user_id, contact_id)`. The prose half of a profile.

| column | type | notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `user_id` | text not null | |
| `contact_id` | uuid not null | `references contacts(id) on delete cascade` |
| `headline` | text | |
| `about` | text | |
| `skills` | jsonb | array of `{ name }` |
| `certifications` | jsonb | array of `{ name, issuer, year }` |
| `volunteering` | jsonb | array of `{ organization, role, years }` |
| `publications` | jsonb | array of `{ title, publisher, year }` |
| `source` | text not null | `'extension'` or `'apollo'` |
| `source_url` | text | the page the capture came from |
| `adapter_version` | text | so DOM churn is visible in the data |
| `warnings` | jsonb | array of strings; drives the "may be incomplete" notice |
| `captured_at` | timestamptz not null | |
| `created_at`, `updated_at` | timestamptz not null | |

### `contact_experiences`

One row per entry. Roles and education share a table because they differ by four
nullable columns and are always read together as one date-ordered list.

| column | type | notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `user_id` | text not null | |
| `contact_id` | uuid not null | `references contacts(id) on delete cascade` |
| `kind` | text not null | `'role'` or `'education'` |
| `organization` | text not null | as displayed |
| `organization_normalized` | text not null | via `normalizeCompanyKey` (`src/lib/apollo.ts`) |
| `title` | text | role title, or degree for education |
| `field_of_study` | text | education only |
| `location` | text | |
| `description` | text | |
| `start_year`, `start_month` | integer | month nullable — LinkedIn often shows year only |
| `end_year`, `end_month` | integer | null when current |
| `is_current` | boolean not null default false | |
| `sort_index` | integer not null | page order, so undated entries keep their sequence |
| `source` | text not null | `'extension'` or `'apollo'` |
| `created_at` | timestamptz not null | |

Dates are stored as parts, not as a `Date`. A synthesized `2019-01-01` for "2019"
claims a precision the source does not have, and overlap comparisons would silently
inherit the lie.

Indexes:

- `contact_experiences_contact_idx` on `(user_id, contact_id, sort_index)` — rendering
- `contact_experiences_org_idx` on `(user_id, organization_normalized)` — "who worked at X"
- `contact_profiles_contact_uidx` unique on `(user_id, contact_id)`

### Why not on `contacts`

A jsonb profile column on `contacts` would land in the default select list of the 27
contact queries that have no explicit projection, several of which scan the whole table.
Every import dedupe pass and knowledge-base load would drag profile blobs across the
wire to ignore them. This is the same reasoning that keeps `closeness_breakdown`
undeclared in the Drizzle schema (see `src/db/schema.ts`).

### Why not extend `search_tsv`

`search_tsv` is a generated column, and a generated column may only read its own row.
Denormalizing experience text onto `contacts` to feed it would mean dropping and
recreating the column plus rebuilding its GIN index. `hybrid-search.ts` already solves
exactly this problem for tags with an `exists` subquery; past employers get the same
treatment. See *Search* below.

### Migration

New-table path: DDL blocks appended to the list in `src/db/index.ts` plus the Drizzle
definitions, and a `SCHEMA_VERSION` bump. No `alters` entries — no existing column
changes.

This worktree is at 26, but another branch has already claimed 27. Whichever merges
second takes the next free number; check `origin/main` at PR time, not at write time.

## Ingest

Both paths converge on `saveContactProfile(userId, contactId, incoming)` in a new
`src/lib/contact-profile.ts` — auth-free and DB-only, so `scripts/smoke-contact-profile.ts`
can drive it against PGlite. This mirrors `src/lib/note-batch-save.ts`.

### Extension

The adapter gains profile-section readers and bumps `ADAPTER_VERSION` to `linkedin-2`.

**Expansion.** The adapter's stated rule is that it never navigates, clicks, scrolls or
paginates. This feature breaks that rule, deliberately and in one isolated place:
`extension/src/inject/dom/expand.ts` clicks LinkedIn's own "see more" / "Show all N"
controls inside profile sections before reading.

The rule existed for good reasons, so the exception is bounded:

- user-initiated only — a "Capture experience" button in the panel, never on page load
  or panel open
- a hard cap on total clicks and a wall-clock ceiling
- only controls inside the profile's own sections; never global navigation
- on failure or timeout, falls back to prompting the user to open
  `/in/<slug>/details/experience`, which LinkedIn serves uncollapsed, and reads there

This is the part most likely to break on a LinkedIn redesign, and the part that sits
closest to their automation terms. The fallback is what keeps a break from becoming a
dead feature.

**Contract.** `PageContext.schemaVersion` goes `1 -> 2`, adding an optional `profile`
field. **The server must keep accepting version 1 indefinitely.** Extension updates roll
out on Chrome's schedule, so a v1 payload has to stay valid rather than 400.

**Parsing.** Selectors first: the adapter maps sections to structured entries in the
page, and sets `parseIncomplete` when a section renders but yields no usable entries.
Only then does the server spend an AI call, through the existing `cost: "ai"` route
wrapper. No key, a timeout, or malformed output returns `degraded: true` and keeps
whatever the selectors got — never a 5xx. This is the `/api/extension/parse` precedent.

**Contact binding.** Capture requires an already-resolved contact. An unknown person
goes through the panel's existing create flow first; profile capture is not a second way
to mint contacts.

### Apollo

`normalizeLinkedInProfile` (`src/lib/apollo.ts`) starts returning `employment_history`
and `education` instead of discarding them. `refreshContactsFromLinkedIn` writes
profiles as a side effect of a refresh the user already asked for, and the contact page
gains a per-contact "Fill from Apollo" button.

Apollo returns no About, skills or certifications. Those columns stay null, and the UI
names the source so an Apollo profile does not read as a person who wrote nothing.

### Precedence

Enforced inside `saveContactProfile`:

- An **extension** capture replaces the profile wholesale — profile row updated, that
  contact's experience rows deleted and reinserted, in one transaction. The delete is not
  filtered by source: Apollo-derived rows go too, so the result is exactly what the page
  showed rather than a union with older guesses. A page the user
  actually looked at is the better truth, and a partial merge would strand stale roles
  that no future capture could remove.
- **Apollo** writes only when no profile exists, or when the existing one is also
  Apollo-sourced. It never overwrites an extension capture.
- Either path stamps `contacts.embeddingStaleAt` so the existing backfill re-embeds.
- **No contact field is ever written.** `title`, `company` and `school` stay user-owned.
  The profile section flags when they look stale; it does not fix them.

## Surfaces

### Profile page

`ContactExperienceSection` slots into `src/app/(app)/(main)/contacts/[id]/page.tsx`
directly after `ContactProfileOverview` — it answers "who is this person", not "what do
I do next", so it belongs above the follow-up and timeline sections. It loads behind a
`Suspense` boundary like the mentions and related-people sections, so a profile query
never delays first paint.

Ordering is exact rather than "roughly reverse-chronological": entries sort by
`is_current` descending, then `end_year`/`end_month` descending with nulls first, then
`start_year`/`start_month` descending, then `sort_index` ascending. An entry with no
dates at all therefore keeps its captured page position relative to its neighbours
instead of sinking to the bottom.

Renders: that career list, education grouped below, About as collapsible prose, and skills, certs,
volunteering and publications as compact chip rows that hide when empty. A provenance
line states source and capture date plainly — "From LinkedIn, captured Mar 3" versus
"From Apollo".

The empty state is the entry point: with a `linkedinUrl` on file it prompts to capture
with the extension, and offers "Fill from Apollo" when the user has a key.

### Chat — focused

In the `focusContactId` branch of `src/lib/chat-context.ts`, the focused contact carries
its entire profile: every role with dates, education, About, skills. It is one contact,
so it sits outside the tiered trimming `budgetContactsContext` applies to retrieved
results. This is what makes "any question about their LinkedIn" answerable.

### Chat — network-wide

Retrieved contacts get one compact career line — `ex-Google, ex-Stripe - MIT`. The cap
is four organizations total, current role included, taken in the display order above;
education contributes at most one school and only when fewer than four roles exist. Loaded for the top-K by contact id in a single query alongside
`loadKnowledgeSnippets`, inside the same `Promise.all`. Its length is added to the
per-contact cost in `budgetContactsContext` so the context budget stays honest.

### Search

- The `companies` and `schools` filters in `src/lib/hybrid-search.ts` match
  `contacts.company` / `contacts.school` only. Each gains an `or exists (...)` against
  `contact_experiences` on `organization_normalized`, shaped like the tag subquery
  directly below them. This is what makes "who has ever worked at Google" find the
  person who left in 2019.
- `buildContactEmbeddingContent` (`src/lib/search.ts`) gains the career line and About
  text, so semantic recall covers past employers.
- **Consequently** the embedding backfill's claim query needs
  `with: { profile: true, experiences: true }` next to its existing `contactTags`.
  Forgetting this is the silent failure mode: profiles save fine and nothing is findable.

### Out of scope: exhaustive rosters

`findOrgRosters` still answers "everyone at Stripe" from `contacts.company` alone. So
"who worked at Google" is as complete as search ranking makes it — very good for a
handful of matches, not guaranteed complete across a 5,000-person network. Extending the
roster later is additive, and `contact_experiences_org_idx` is already the index for it.

## Error handling

The failure that matters most is writing one person's career onto another. Capture is
bound to the panel's resolved `contactId`, and the server independently compares the
captured profile URL's slug against the contact's `linkedin_slug` generated column. A
mismatch returns a conflict the panel surfaces as an explicit "this page is a different
person, save anyway?" confirmation — it never silently proceeds. A contact with no
`linkedinUrl` on file has it written as part of accepting the capture.

| Failure | Behavior |
| --- | --- |
| Login wall, or not a `/in/` page | Adapter emits warnings; the panel refuses capture with a specific notice rather than saving an empty profile |
| Expansion blocked or times out | Prompts for the `/details/experience` page; whatever was read is still saveable, flagged incomplete |
| Selectors return nothing | Server AI fallback; unavailable means `degraded: true` and selector results are kept |
| Partial capture | Stored with `warnings`; UI says "may be incomplete" rather than presenting a truncated career as the whole story |
| Apollo no-match / 403 / rate limit | Existing `refreshContactsFromLinkedIn` error surfaces, unchanged |

The capture route goes through the existing `extensionRoute` wrapper, so rate limiting
and plan guards apply without new code.

## Testing

`scripts/smoke-contact-profile.ts`, in the existing harness (`npm run test`, temp PGlite
forced by `scripts/smoke/_env.ts`):

- an extension capture replaces profile and experience rows transactionally
- Apollo does not overwrite an extension profile, but does replace an older Apollo one
- `embeddingStaleAt` is stamped on both paths
- the slug-mismatch guard rejects without the confirmation flag
- a v1 `PageContext` payload still validates

Search gets its own case: a contact whose only Google connection is a role that ended in
2019 is returned by the `companies` filter. That is the point of the feature and the
assertion most likely to catch a wiring mistake.

Selector parsing is the churn-prone part, so the adapter's section readers are pure
functions over a DOM fragment, exercised against saved HTML fixtures. The extension has
no test runner today; rather than introduce one, the fixtures run as a node script under
the existing smoke harness.

`npm run db:check` verifies the DDL. The schema-DDL guard regex-slices source, so
commented-out migration code passes it — the new tables are confirmed by actually
running the bootstrap against PGlite, not by the guard going green.
