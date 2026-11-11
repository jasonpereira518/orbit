# Custom constellations from a prompt

## Context

`/graph` draws one sky: your whole (engaged) network, auto-grouped by company, school and role.
Jason wants **standing groups** ("my mentors", "founders I invest with"): named skies he comes
back to and switches between like tabs. You type a prompt once, Orbit proposes who belongs, the
sky draws straight away, and you curate it by hand from then on.

Decisions made in conversation (Jason's):
- A **separate, saved sky** per prompt, switched like tabs on `/graph`. Not a highlight inside
  the main sky, and not a regrouping of it.
- **AI picks once, then you curate.** Membership is a fixed list after creation; new contacts
  join only when you add them. No live rule re-run.
- **Straight to the sky.** No review checklist. Wrong stars get removed from the inspect panel.
- **All plans; Free capped at 3** saved constellations, Pro/Max unlimited. Each prompt spends
  normal AI credits.

Non-goals (v1): live/auto-updating membership, a "refresh suggestions" button, sharing a
constellation, adding people from the contact profile page, chat/MCP tools for it. Each is a
later step once the core is used.

Anti-goals: an empty or nonsense sky saved silently; members leaking across users; a merge or
purge leaving members pointing at a deleted contact; slowing the default `/graph` load.

## How it works

### 1. Storage (schema 220, or next free number at merge time)
Two new tables in `src/db/schema.ts` + DDL in `src/db/index.ts` (new table = DDL + version bump,
no alters entry, per the schema migration gate):
- `custom_constellations`: `id, user_id → users (cascade), name, prompt, position, created_at,
  updated_at`. Shape copied from `reminder_lists` (schema.ts ~1298). Named `custom_*` to stay
  clear of the existing admin `constellation_settings` table and `contacts.constellation_pin`.
- `custom_constellation_members`: `id, user_id, constellation_id → custom_constellations
  (cascade), contact_id → contacts (cascade), source ('ai' | 'manual'), reason text,
  created_at`. Index on `(constellation_id)`.
  **No unique key on (constellation_id, contact_id)** on purpose: it lets the table join
  `REPOINTED_TABLES` in `src/lib/contact-merge.ts` with a plain UPDATE (that list requires
  no contact column in a unique key). Reads use `DISTINCT contact_id`; inserts skip ids
  already present. A post-merge duplicate is the same star twice, which DISTINCT hides.
- Register the members table in `REPOINTED_TABLES` (scoped: true) and both tables in the
  purge registry (`src/lib/user-data.ts`) and data export (`src/lib/data-export.ts`).

### 2. Picking members from a prompt: `src/lib/custom-constellations.ts`
`proposeMembers(userId, prompt)`:
1. `understandQuery(prompt)` from `src/lib/chat-retrieval.ts` → `ParsedQuery` (filters, time
   window, semanticQuery). Reuses operation `chat.understand`.
2. Candidates, by what the parse found:
   - **Pure filter** ("people at Stripe", "Duke alumni"): filters/time window and no semantic
     remainder → `listContactsMatching()` from `src/lib/hybrid-search.ts` (cap 200). No judge.
   - **Fuzzy or mixed** ("my mentors", "mentors at Stripe"): any semantic remainder →
     `hybridSearchContacts(userId, { query: semanticQuery, filters, limit: 80 })`, so the
     filters narrow the pool and the fuzzy part still gets judged.
   *My call:* a mixed prompt must never fall to the filter path, or "mentors at Stripe"
   silently becomes "everyone at Stripe".
3. Fuzzy/mixed path only: **one judge call**: `completeJson` with a new
   operation `constellation.pick` (tier fast, thinking minimal, registered in
   `src/lib/ai-operations.ts`) over compact candidate cards (name, title, company, closeness,
   one-line digest); returns `{ name, members: [{ id, reason }] }`. Ids not in the candidate
   set are dropped (the model can't invent people). Pure-filter results get their name from a
   short label of the prompt.
   *My call:* the judge is what makes "my mentors" work. Hybrid search alone returns up to 80
   ranked people with no cut-off, which would be a noisy sky.
4. Zero members → throw a `UserFacingError` ("No one in your network matched that. Try naming a
   company, school, place or tag."); nothing is saved.

AI access goes through `completeJson` / `ai-access.ts` as usual, so credits, holds and own-key
handling are unchanged. A refusal surfaces through the existing `friendlyError` toast path.

### 3. Server actions: `src/actions/custom-constellations.ts`
All behind `requireUserForSurface("page.graph")`, every query scoped by `user_id`:
- `createConstellation(prompt)`: checks the plan cap first, then `proposeMembers`, then inserts
  the row + members in one batch and returns `{ id }`.
- `renameConstellation(id, name)`, `deleteConstellation(id)`.
- `addMember(id, contactId)` / `removeMember(id, contactId)` (source 'manual'). `addMember`
  verifies the contact belongs to the user.
- `listConstellations()`: id, name, member count, for the tab strip.

Plan cap: add `maxCustomConstellations` to `src/lib/plans/plan-config.ts`, shaped like
`RADAR_PLAN_LIMITS`: free 3, orbit / max / lifetime `Infinity`. Over the cap → a
`UserFacingError` with the upgrade copy the other plan gates use.
**Downgrade (Jason's call):** the cap is checked at create only. Someone who drops to Free
with 6 keeps all 6 fully usable; they just can't create another until they're under 3.

### 4. Drawing a custom sky
- `loadGraphData(userId, { scope, onlyIds? })` in `src/lib/graph-data.ts`: when `onlyIds` is
  given, skip the engaged filter and keep only those rows **before** encoding, the same
  server-side trim the engaged filter does (payload carries only what it draws).
  `summary.total` stays over all rows, as today.
- `getConstellationGraphData(id)` in `src/actions/graph.ts`: loads member ids (1 statement),
  then `loadGraphData(..., { scope: "all", onlyIds })` → `encodeGraphPayload`. A separate
  action, so the default `/graph` load and its 9-statement budget are untouched.
- Layout, clustering and both renderers are reused unchanged. A small sky simply gets fewer
  clusters.

### 5. UI on `/graph`
- **Tab strip** in the page header (outside Suspense, next to `ConstellationScopeToggle`):
  "Everyone" first, then saved constellations in `position` order, then **"+ New"**.
- Selection lives in the URL, `/graph?c=<id>`, so it's linkable and back/forward work.
  `page.tsx` reads `c`; `GraphIsland` calls `getConstellationGraphData(c)` instead of
  `getGraphData()`. An unknown or foreign id falls back to Everyone. *My call:* a plain URL
  param beats another module bus; a tab switch is a normal navigation.
- **"+ New"** opens a small popover: one text field ("Who belongs here?") and Create. While it
  runs, show the existing chat loading treatment; on success navigate to `?c=<id>`. On a Free
  account at the cap, the popover shows the upgrade note instead of the field.
- **Tab menu** (⋯ on the active custom tab): Rename, Delete (confirm dialog).
- **Inside a custom sky**: hide the engaged/all scope toggle (membership is explicit). The
  inspect panel gets "Remove from <name>".
- **Adding people** (*my call*): today the `/graph` search hits (`searchDashboardContacts`,
  whole network) only highlight stars already drawn; hits outside the sky show nowhere. In a
  custom sky, add a small results list under the search box showing **only hits not in the
  sky**, each with an "Add" button; members keep today's highlight behaviour. A real listbox
  (arrow keys, Enter adds, announced to screen readers), checked at 375px. This is a new
  component, not a tweak, and it's the only way a sky grows after creation.
- The inspect panel shows the AI's `reason` for AI-picked members ("Why they're here").

### 6. Legal copy
The prompt and candidate summaries go to the AI provider, the same processing chat already
discloses. Check `/privacy` covers "saved groups you create"; if not, add one line (the
`legal.ts` date bumps with it).

## Files
- `src/db/schema.ts`, `src/db/index.ts` (tables + DDL + version)
- `src/lib/custom-constellations.ts` (new: `proposeMembers`, member reads)
- `src/actions/custom-constellations.ts` (new), `src/actions/graph.ts`
- `src/lib/graph-data.ts` (`onlyIds`)
- `src/lib/ai-operations.ts` (`constellation.pick`), `src/lib/plans/plan-config.ts` (cap)
- `src/lib/contact-merge.ts`, `src/lib/user-data.ts`, `src/lib/data-export.ts`
- `src/app/(clerk)/(app)/(main)/graph/page.tsx`, new `src/components/graph/constellation-tabs.tsx`,
  `network-graph.tsx` / inspect panel (remove + reason), search add action

## Verification
- New smoke `scripts/smoke-custom-constellations.ts` (register it in the suite) with stubbed AI:
  - filter prompt → members from `listContactsMatching`, no judge call
  - fuzzy prompt → judge called; an id outside the candidates is dropped
  - mixed prompt ("mentors at Stripe") → filters narrow the pool AND the judge runs
  - zero matches → error, no rows written
  - Free cap: 4th create refused; Pro allowed
  - another user's constellation id → not found, from every action
  - `onlyIds` payload contains no trace of non-members (same substring check as
    `smoke-constellation-payload-leak`)
  - merge two contacts that are both members → one star (DISTINCT); merge undo restores
  - purge removes both tables
- `scripts/smoke-page-budgets.ts`: default `loadGraphData` still ≤ 9 statements; add a budget
  line for `getConstellationGraphData`.
- `npx tsx scripts/smoke-graph-layout.ts` (layout untouched, should stay green), tsc, eslint,
  full `npm test`.
- Browser pane on the demo worktree: create "people at Stripe" and a fuzzy one, switch tabs,
  remove/add a star, rename, delete, check 375px. Screenshots as proof.
