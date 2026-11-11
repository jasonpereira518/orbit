# Custom Constellations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users type a prompt ("my mentors", "people at Stripe") on `/graph` and get a saved, named sky of just those people, switchable like tabs and curated by hand afterwards.

**Architecture:** Two new tables hold a constellation and its member list. A lib module turns a prompt into members (chat's query parser → filter listing or hybrid search + one AI judge call). The existing `loadGraphData` gains an `onlyIds` trim so a custom sky reuses the whole layout/render stack unchanged; the selected sky lives in the URL (`/graph?c=<id>`).

**Tech Stack:** Next.js App Router server actions, Drizzle (Neon prod / PGlite local), existing AI gate (`completeJson`), tsx smoke scripts run by `scripts/run-smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-11-11-custom-constellations-design.md`

## Global Constraints

- Schema version: next free number at implementation time (220 when written; re-check `SCHEMA_VERSION` in `src/db/index.ts` and origin/main before committing). New tables = DDL + version bump, no alters entry.
- Table names: `custom_constellations`, `custom_constellation_members`. No unique key on `(constellation_id, contact_id)`.
- Plan cap: Free 3; orbit / max / lifetime unlimited. Checked at create only (downgrade keeps everything usable).
- Every read and write scoped by `user_id`; every server action behind `requireUserForSurface("page.graph")`.
- All AI through `completeJson` (credits/holds unchanged). New operation id `constellation.pick`: tier `fast`, thinking `minimal`.
- Errors shown to users go through `UserFacingError` (`src/lib/errors.ts`) / `friendlyError`, never `err.message`.
- Default `/graph` load stays ≤ 9 statements (`smoke-page-budgets`).
- Limits (my calls): prompt ≤ 300 chars, name ≤ 60 chars, ≤ 200 members from a prompt, judge candidates ≤ 80.
- Copy (exact): empty result → "No one in your network matched that. Try naming a company, school, place or tag." Popover field placeholder → "Who belongs here?"

## Review Focus

1. Prompt that parses to nothing usable (e.g. "asdf", 3 chars) → fallback parse is shape `open` → hybrid search finds nothing → the empty-result error, no rows. Test in Task 2.
2. Judge returns an id that isn't a candidate, or the same id twice → dropped / deduped. Test in Task 2.
3. Notes/summaries in judge cards are untrusted text (prompt injection) → fenced with `fenceUntrusted`; the id allow-list is the hard stop. Test in Task 2 (id allow-list).
4. A member contact is deleted → FK cascade removes the member row; the sky just shrinks, and a sky emptied this way still opens (empty sky, not an error). Test in Task 4.
5. `?c=` with another user's id or garbage → falls back to Everyone, leaks nothing. Test in Task 4.

---

### Task 1: Storage, plan cap, merge/purge registration

**Files:**
- Modify: `src/db/schema.ts` (new tables beside `reminderLists`, ~line 1298)
- Modify: `src/db/index.ts` (DDL + `SCHEMA_VERSION` bump + changelog comment)
- Modify: `src/lib/plans/plan-config.ts` (cap)
- Modify: `src/lib/contact-merge.ts` (`REPOINTED_TABLES`)
- Modify: `src/lib/user-data.ts` (purge/export category)
- Create: `scripts/smoke-custom-constellations.ts`; register in `scripts/run-smoke.ts` as `"pglite"`

**Interfaces:**
- Produces: Drizzle tables `customConstellations` `{ id uuid pk, userId text → users cascade, name text, prompt text, position int default 0, createdAt, updatedAt }` and `customConstellationMembers` `{ id uuid pk, userId text, constellationId uuid → customConstellations cascade, contactId uuid → contacts cascade, source text ('ai'|'manual'), reason text null, createdAt }`, index on `constellationId`.
- Produces: `getConstellationLimitForPlan(plan: Plan): number` in `plan-config.ts` (free 3, others `Infinity`), shaped like `getRadarLimitsForPlan`.

- [ ] **Step 1: Write failing smoke checks** in `scripts/smoke-custom-constellations.ts` (pattern: `import "./smoke/_env"` then PGlite `getDb`, like `smoke-constellation-payload-leak.ts`):
  - `cap: free=3, orbit=Infinity` — `getConstellationLimitForPlan("free") === 3`, `("orbit") === Infinity`.
  - `merge repoints members` — seed user, contacts A & B, constellation with both as members; run the merge (B into A) through `contact-merge.ts`'s public merge function; `SELECT DISTINCT contact_id` for the constellation = `[A]`. Undo the merge; distinct ids = `{A, B}`.
  - `purge removes both tables` — run the purge category; both tables have 0 rows for the user.
- [ ] **Step 2: Run** `npx tsx scripts/smoke-custom-constellations.ts` → FAIL (tables/function missing).
- [ ] **Step 3: Implement** the tables, DDL, version bump; add `{ table: "custom_constellation_members", column: "contact_id", scoped: true }` to `REPOINTED_TABLES` with a comment (no unique key on purpose → no collision; DISTINCT on read). Add both tables to a purge category in `user-data.ts` that runs before `contacts` (exports + counts; delete members before constellations). Add the cap function.
- [ ] **Step 4: Run** the smoke → PASS. Run `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(constellations): tables, plan cap, merge + purge coverage`.

### Task 2: Prompt → members (`proposeMembers`)

**Files:**
- Create: `src/lib/custom-constellations.ts`
- Modify: `src/lib/ai-operations.ts` (register `"constellation.pick"`)
- Test: `scripts/smoke-custom-constellations.ts` (add checks)

**Interfaces:**
- Consumes: `understandQuery` (`src/lib/chat-retrieval.ts`), `listContactsMatching`, `hybridSearchContacts` (`src/lib/hybrid-search.ts`), `getQueryEmbedding` (`src/lib/embedding-cache.ts`), `completeJson` (`src/lib/ai.ts`), `fenceUntrusted` (`src/lib/ai-security.ts`).
- Produces:
  ```ts
  export type ProposedMember = { contactId: string; reason: string | null };
  export type Proposal = { name: string; members: ProposedMember[] };
  export type ProposeDeps = {
    understand?: typeof understandQuery;
    list?: typeof listContactsMatching;
    search?: typeof hybridSearchContacts;
    complete?: typeof completeJson;
  };
  export async function proposeMembers(userId: string, prompt: string, deps?: ProposeDeps): Promise<Proposal>;
  ```

Routing (decided): parse with `understandQuery(userId, prompt, [])`. If `parsed.shape` is `"list"` or `"count"` → `list(userId, { filters: parsed.filters, window: parsed.time })`; null or empty → empty result. No judge; `name` = the prompt trimmed, first letter capitalised, cut to 60 chars. Any other shape (open/fact/person — this covers mixed prompts like "mentors at Stripe") → `search(userId, { query: parsed.semanticQuery, filters: parsed.filters, expansionTerms: parsed.expansionTerms, embedding: getQueryEmbedding(...)` (pending, not awaited; `.catch(() => null)`), `limit: 80, withProse: false })` → judge. Judge = `complete(userId, { operation: "constellation.pick", system, user, maxOutputTokens: 2048, temperature: 0 })`; parse JSON `{ name: string, members: [{ id, reason }] }`; keep only ids in the candidate set, first occurrence wins; name trimmed to 60 (fallback to the prompt label). Candidate cards: id, name, title, company, closenessTier, `aiSummary` cut to 160 chars — the cards block wrapped in `fenceUntrusted("CONTACTS", …)`. Zero members → `throw new UserFacingError(<exact copy>)`.

- [ ] **Step 1: Write failing checks** (stub deps, no DB needed for these):
  - `list-shape prompt uses listing, no judge` — understand stub returns `{shape:"list", filters:{companies:["Stripe"]}, …}`; list stub returns 2 people; complete stub throws if called. Expect 2 members, `reason === null`, name `"People at Stripe"` for prompt `"people at Stripe"`.
  - `open-shape prompt is judged; foreign + duplicate ids dropped` — search returns candidates `c1,c2`; complete returns `{name:"Mentors", members:[{id:"c1",reason:"r"},{id:"zzz"},{id:"c1"}]}`. Expect members `[{contactId:"c1", reason:"r"}]`, name `"Mentors"`.
  - `mixed prompt passes filters to search and judges` — understand returns `{shape:"open", filters:{companies:["Stripe"]}, semanticQuery:"mentors"}`; assert search received `filters.companies[0]==="Stripe"` and complete was called once.
  - `nothing matched → UserFacingError, exact copy` — search returns `[]`; error message equals the exact copy; complete not called.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `proposeMembers` and register the operation.
- [ ] **Step 4: Run** → PASS; `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(constellations): propose members from a prompt`.

### Task 3: CRUD + server actions

**Files:**
- Modify: `src/lib/custom-constellations.ts` (DB functions)
- Create: `src/actions/custom-constellations.ts` (`"use server"`, thin wrappers)
- Test: `scripts/smoke-custom-constellations.ts`

**Interfaces:**
- Produces (lib, all take `userId` first; return `null` / `false` when the constellation isn't the user's):
  ```ts
  export type ConstellationTab = { id: string; name: string; memberCount: number };
  export async function createCustomConstellation(userId: string, prompt: string, plan: Plan, deps?: ProposeDeps): Promise<{ id: string }>;
  export async function listCustomConstellations(userId: string): Promise<ConstellationTab[]>; // position, then createdAt
  export async function renameCustomConstellation(userId: string, id: string, name: string): Promise<boolean>;
  export async function deleteCustomConstellation(userId: string, id: string): Promise<boolean>;
  export async function addConstellationMember(userId: string, id: string, contactId: string): Promise<boolean>; // contact must be the user's; skip if already present
  export async function removeConstellationMember(userId: string, id: string, contactId: string): Promise<boolean>; // deletes every row for the pair
  export async function getConstellationMembers(userId: string, id: string): Promise<{ name: string; members: Map<string, string | null> } | null>; // contactId → reason, DISTINCT
  ```
- Produces (actions): `createConstellation(prompt)`, `listConstellations()`, `renameConstellation(id, name)`, `deleteConstellation(id)`, `addToConstellation(id, contactId)`, `removeFromConstellation(id, contactId)`. Each: `requireUserForSurface("page.graph")`; create resolves the plan with `resolvePlan(settingsRow)` (`src/lib/entitlements.ts`, as `src/lib/radar/run.ts:390` does). Validation: prompt trimmed 1–300 chars, name trimmed 1–60, ids are uuids — else `UserFacingError`.

`createCustomConstellation`: count the user's rows; `>= getConstellationLimitForPlan(plan)` → `UserFacingError("Free plan keeps up to 3 constellations. Upgrade for unlimited, or delete one to make room.")` **before** any AI call. Then `proposeMembers`, then insert row (position = max+1) + members (`source: "ai"`) in one `db.batch` / transaction.

- [ ] **Step 1: Write failing checks**: `create saves row + members` (stub deps); `4th create on free refused before AI` (complete stub throws if called); `orbit plan allows 4th`; `rename/delete/add/remove by another user → false, rows unchanged`; `add of another user's contact → false`; `add twice → one distinct member`; `remove deletes duplicates too`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** lib functions and actions.
- [ ] **Step 4: Run** → PASS; tsc.
- [ ] **Step 5: Commit** `feat(constellations): create, list, rename, delete, curate`.

### Task 4: Drawing a custom sky

**Files:**
- Modify: `src/lib/graph-data.ts` (`onlyIds`)
- Modify: `src/actions/graph.ts` (`getConstellationGraphData`)
- Modify: `scripts/smoke-page-budgets.ts`
- Test: `scripts/smoke-custom-constellations.ts`

**Interfaces:**
- Produces: `loadGraphData(userId, { profile, scope?, onlyIds?: ReadonlySet<string> })` — when `onlyIds` is set, `visibleContacts = graphContacts.filter(c => onlyIds.has(c.id))` replaces the engaged filter (around `filterActive`, ~line 218); `constellationFilter.active = false`. `summary.total` unchanged.
- Produces: `getConstellationGraphData(id: string): Promise<{ payload: ReturnType<typeof encodeGraphPayload>; constellation: { id: string; name: string; reasons: Record<string, string> } } | null>` — `null` when not the user's or not a uuid (caller falls back to Everyone).

- [ ] **Step 1: Write failing checks**:
  - `onlyIds payload leaks no non-member` — seed 3 contacts with distinct names/companies, members = 1; `JSON.stringify(await loadGraphData(uid,{profile:null,scope:"all",onlyIds}))` contains none of the other two contacts' ids, names, companies.
  - `member deleted → sky still opens empty` — delete the only member contact; `getConstellationMembers` returns `members.size === 0`, not null.
  - `foreign id → null` from `getConstellationMembers`.
  - In `smoke-page-budgets.ts`: keep `graph issues ≤ 9 statements`; add `constellation graph issues ≤ 10 statements` for the members read + `loadGraphData`.
- [ ] **Step 2: Run** both smokes → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both smokes + `npx tsx scripts/smoke-graph-layout.ts` + `npx tsx scripts/smoke-constellation-payload-leak.ts` → PASS.
- [ ] **Step 5: Commit** `feat(constellations): draw a sky from a member list`.

### Task 5: Tabs, New popover, rename/delete

**Files:**
- Create: `src/components/graph/constellation-tabs.tsx` (client)
- Modify: `src/app/(clerk)/(app)/(main)/graph/page.tsx`

**Interfaces:**
- Consumes: actions from Task 3, `getConstellationGraphData` from Task 4.
- Produces: `<ConstellationTabs tabs={ConstellationTab[]} activeId={string | null} canCreate={boolean} />`.

Behaviour: `page.tsx` takes `searchParams` (check `node_modules/next/dist/docs/` for this Next version's `searchParams` shape first), reads `c`; header renders `ConstellationTabs` (server-fetched `listConstellations()` + cap) beside the scope toggle, which renders only when no custom sky is active. `GraphIsland` gets `c`: calls `getConstellationGraphData(c)`, falls back to `getGraphData()` on null. Tabs are `<Link href="/graph?c=…">` (Everyone = `/graph`), `aria-current="page"` on the active one, horizontally scrollable at 375px. "+ New" → popover (existing popover primitive in `src/components/ui`) with one input (placeholder exact copy), Create button, pending state; success → `router.push("/graph?c="+id)`; failure → toast via `friendlyError`. At the cap the popover shows the upgrade line + link to the plans page instead of the input. Active custom tab gets a ⋯ menu: Rename (inline input) and Delete (confirm dialog → `router.push("/graph")`).

- [ ] **Step 1:** Implement; `npx tsc --noEmit` and `npx eslint` on touched files → 0 errors.
- [ ] **Step 2:** Browser pane (demo worktree): create a list-shaped and an open-shaped constellation, switch tabs, back/forward, rename, delete, 375px. Screenshot each state.
- [ ] **Step 3: Commit** `feat(constellations): tab strip and create popover on /graph`.

### Task 6: Curating inside a custom sky

**Files:**
- Modify: `src/components/graph/network-graph.tsx` (+ the inspect panel component it renders) — accept `constellation?: { id; name; reasons }` from `GraphIsland`
- Create: `src/components/graph/constellation-add-list.tsx`

Behaviour: inspect panel shows "Why they're here: {reason}" when a reason exists, and a "Remove from {name}" button → `removeFromConstellation` → `router.refresh()`. Search: when `constellation` is set, hits from the existing `searchDashboardContacts` call that are NOT drawn render in `ConstellationAddList` under the search box — `role="listbox"`, arrow keys move, Enter adds, each row has an "Add" button, an `aria-live="polite"` line announces "Added {name}". Add → `addToConstellation` → `router.refresh()`. Drawn hits keep today's highlight.

- [ ] **Step 1:** Implement; tsc + eslint clean.
- [ ] **Step 2:** Browser pane: remove a star, add one via search (mouse and keyboard), reason shows, 375px. Screenshots.
- [ ] **Step 3: Commit** `feat(constellations): add and remove people inside a custom sky`.

### Task 7: Privacy line + full verification

- [ ] **Step 1:** Read `src/app/(site)/(docs)/privacy/page.tsx`; if saved groups built from your prompt aren't covered by the existing AI-processing text, add one sentence and bump the date in `src/lib/legal.ts`. Otherwise note "covered" in the PR.
- [ ] **Step 2:** `npx tsc --noEmit`, `npx eslint .` (0 errors), `npm test` (stop `next dev` first: PGlite single writer). Rerun any flake alone before calling it real.
- [ ] **Step 3: Commit** and report results with the screenshots.
