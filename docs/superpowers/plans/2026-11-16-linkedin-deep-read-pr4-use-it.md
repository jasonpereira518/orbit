# LinkedIn deep read, PR 4: use it. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the deep read learned (how you met, relationship kind, overlap, topics, what they are working on, open threads, your own history) reaches chat, Cosmo, drafts, Radar's notes and the contact page, for deep-read users only.

**Architecture:**
- One server module loads a contact's deep-read context and one pure function renders it as a short block of single-line, fenced-ready text. Every prompt path appends that block where it already assembles per-contact context.
- Your own history joins the two "about you" renderers. It needs no gate, because only deep-read users ever have `career_profile.positions` / `education` (written behind the flag in PR 1).
- The contact page shows the same facts in the existing overview card, plus one control: remove a wrong relationship kind, which sticks (PR 2 rule: a `removed` kind is never set again).

**Tech Stack:** TypeScript, Next.js App Router server components and server actions, Drizzle, tsx smokes.

**Spec:** `docs/superpowers/specs/2026-11-15-linkedin-deep-read-design.md`, "PR 4: Use it". Builds on PR 1 (#707), PR 2 (#709), PR 3 (#710).

## Global Constraints

- Gate: `deepReadOn(userId)` (src/lib/deep-read.ts). With it off, every prompt and page renders exactly as today; the smokes named below pass with their existing expectations.
- **MCP gets none of it.** The relationship block is added for the `chat` tool surface only (chat and Cosmo, which calls tools as `chat`). MCP clients are outside services, and /privacy (PR 5) must say so before anything new leaves Orbit.
- Every rendered value is model or import text: one line each, capped, and placed inside the existing fences (`PROFILE`, `CONTACT`, …). It never goes in a system prompt.
- No DDL, no new route, no new `maxDuration`.
- New smokes are registered in `scripts/run-smoke.ts` and the source-reader manifest (`npm run check:sources`); `npm run css:site` if the marketing source list moves.
- Commit after each task; nothing pushed until Jason says so.

## Review Focus

1. A removed relationship kind: never shown, never in a prompt, and the engine never sets it again. (Tasks 1, 5)
2. A month- or year-precision origin: shown as "Sep 2022" / "2022", never as a made-up day. (Task 1)
3. A contact with a digest from before PR 2 (no origin, no relationship): the block shows what exists and nothing else; no "undefined", no empty labels. (Task 1)
4. A focus contact in chat with deep read off: the prompt is byte-identical to today's. (Task 2)
5. Text from other people's messages in a block that reaches a prompt: fenced, one line, capped. (Tasks 1, 2)

## File Structure

- Create `src/lib/relationship-context.ts`: `loadRelationshipContexts`, `renderRelationshipBlock`, `formatOriginWhen`. Pure parts are separated from the loader.
- Create `scripts/smoke-relationship-context.ts` (pure for the renderer, PGlite for the loader; pick the PGlite tier and keep it one file).
- Modify: `src/lib/chat-context.ts` (`renderFocusRelationship` caller, `renderAboutUser`), `src/lib/voice/tools.ts` (`aboutTheUser`), `src/lib/tools/definitions.ts` (`get_contact`), `src/lib/tools/definitions-features.ts` (`get_dossier` + its `fields`), `src/lib/follow-up-drafts.ts` (`draftFromContext`), `src/lib/radar/explain.ts` (`loadTargets` → why facts), `src/lib/radar/editor.ts` (`EditorCandidate` gets `relationship?`), `src/app/(clerk)/(app)/(main)/contacts/[id]/page.tsx`, `src/components/contacts/contact-profile-overview.tsx`, `src/actions/contacts.ts` (one action).

---

### Task 1: Load and render the context

**Interfaces (produced):**

```ts
export type RelationshipContext = {
  origin: { text: string; when: string | null; excerpt: string } | null;   // when: formatOriginWhen
  kind: RelationshipKind | null;                                         // null when absent or removed
  overlaps: string[];                                                    // "You both worked at Acme, 2021 to 2023"
  topics: string[];                                                      // labels, newest first, at most 6
  workingOn: string | null;
  openThreads: string[];                                                 // text, at most 4
};
/** "Sep 17, 2022" | "Sep 2022" | "2022" | null, from RelationshipOrigin.date + precision. UTC. */
export function formatOriginWhen(date: string | null, precision: DatePrecision | null): string | null;
/** Lines "How you met: …", "Relationship: …", "You overlapped: …", "You talk about: …", "Working on: …", "Open: …"; null when every part is empty. Each line cleaned to one line and capped at 240 chars. */
export function renderRelationshipBlock(ctx: RelationshipContext | null | undefined): string | null;
/** Empty map when deepReadOn(userId) is false. One read of digests, one of the user's history, one of contact_experiences. */
export async function loadRelationshipContexts(userId: string, contactIds: readonly string[], opts?: { deepRead?: boolean }): Promise<Map<string, RelationshipContext>>;
```

The overlap lines use the same wording and the same contact-side fallback (company / school with no years) as PR 2's runner (`overlapLine` in relationship-engine/runner.ts). Move `overlapLine` to `src/lib/history-overlap.ts` and import it in both places.

- [ ] **Step 1: Failing checks** in the new smoke:
  - `formatOriginWhen("2022-09-17","day") === "Sep 17, 2022"`, `("2022-09-01","month") === "Sep 2022"`, `("2022-01-01","year") === "2022"`, `(null, null) === null`;
  - a full context renders all six lines in that order;
  - an empty context and `null` give `null`;
  - a context with only `workingOn` renders only that line;
  - a multi-line, 1,000-character topic renders as one line of at most 240 characters;
  - loader (PGlite): a digest with `relationship.removed` gives `kind: null`; a digest from before PR 2 gives `origin: null, kind: null` with topics intact; `{ deepRead: false }` gives an empty map.
- [ ] **Step 2: Run** `npx tsx scripts/smoke-relationship-context.ts`. Expected: fails (module missing).
- [ ] **Step 3: Implement.** Register the smoke (`scripts/run-smoke.ts`, tier `pglite`) and run `npm run check:sources`.
- [ ] **Step 4: Run** it and `npx tsx scripts/smoke-relationship-runner.ts` (overlapLine moved). Expected: pass.
- [ ] **Step 5: Commit** `feat(deep-read): load and render a contact's relationship context`.

### Task 2: Chat, tools and Cosmo

- `prepareChatContext`: when deep read is on for the user, `focusProfile` gains the block after `renderFocusRelationship(...)`. One `loadRelationshipContexts(userId, [focusContactId])` call, in the existing parallel batch.
- `get_contact` (chat surface only): result gains `relationship: string | null` (the rendered block). MCP results are unchanged.
- `get_dossier`: result gains top-level `relationship: string | null`; add `"relationship"` to its `fields.chat` list only.
- `renderAboutUser` and voice `aboutTheUser`: append "Previously: <title> at <company> (<years>)" for up to 3 past positions and "Studied: <degree> at <school>" for up to 2 schools, from `career_profile.positions` / `education`, inside their existing caps.

- [ ] **Step 1: Failing checks.**
  - In `smoke-chat-context.ts` (PGlite): with deep read on and a digest whose origin is "Met at HackNC", the focus profile contains "How you met: Met at HackNC (Sep 2022)". With deep read off, the focus profile equals the string the existing check already pins.
  - `renderAboutUser` with `careerProfile.positions` of 4 roles shows 3 "Previously" entries.
  - In `smoke-chat-feature-tools.ts`: `get_dossier` on chat has `relationship`; on MCP it has no `relationship` key.
- [ ] **Step 2: Run** both smokes. Expected: FAIL on the new lines only.
- [ ] **Step 3: Implement.** Regenerate `src/lib/tools/tools.snapshot.json` if `smoke-tool-registry` pins tool output fields (its own update flag), and say so in the commit.
- [ ] **Step 4: Run** `smoke-chat-context`, `smoke-chat-feature-tools`, `smoke-tool-registry`, `smoke-orbit-voice`, `smoke-tenant-isolation`, `smoke-behavior-golden`. Expected: pass.
- [ ] **Step 5: Commit** `feat(deep-read): chat and Cosmo see how you met and what you share`.

### Task 3: Drafts

- `buildProfileBlock(contact, relationshipBlock?: string | null)`: when given, the block is appended after "Key facts". `draftFromContext` loads it with `loadRelationshipContexts` (deep users only) and passes it. `conversation-starters.ts` passes nothing (unchanged).

- [ ] **Step 1: Failing check** in `smoke-sender-profile.ts`: `buildProfileBlock(row, "How you met: Met at HackNC (Sep 2022)")` ends with that line; `buildProfileBlock(row)` equals today's output for the same row.
- [ ] **Step 2–4:** run, implement, run `smoke-sender-profile`, `smoke-ai-guardrails`. Expected: pass.
- [ ] **Step 5: Commit** `feat(deep-read): drafts know how you met`.

### Task 4: Radar's notes

- `radar/explain.ts` `loadTargets`: for deep users, each target's `facts` gain the rendered lines "How you met: …" and "You overlapped: …" only (not topics or threads: a Radar note is one sentence).
- `radar/editor.ts`: `EditorCandidate` gains `relationship?: string` (the same two lines joined with "; "), added to the candidate line `buildEditorPrompt` renders. With deep read off, the candidate and prompt are unchanged.

- [ ] **Step 1: Failing check** in `smoke-radar-score.ts` (pure): `buildEditorPrompt` with a candidate carrying `relationship: "How you met: Met at HackNC (Sep 2022)"` includes it inside the candidate's fenced text; without it the prompt equals today's.
- [ ] **Step 2–4:** run, implement, run `smoke-radar-score` and every `smoke-radar-*` that is pure. Expected: pass.
- [ ] **Step 5: Commit** `feat(deep-read): Radar's notes know how you met`.

### Task 5: The contact page

- Page loader: when deep read is on, call `loadRelationshipContexts(userId, [id])` alongside `getContactForProfile`, and pass `relationship` to `ContactProfileOverview`.
- `ContactProfileOverview` gains an optional prop `relationship?: RelationshipContext | null`, rendered in the existing "How you met" area:
  - a kind chip ("Classmate") with a small "Not right?" button;
  - "Met …" line from `origin.text` + `when`, with the excerpt as a quiet quote under it ("From your messages: “…”");
  - "You overlapped: …" lines;
  - when the user has typed how-met themselves, show theirs (`howMetSummary`) and the origin as a secondary line, never instead.
- Server action `removeRelationshipKind(contactId: string): Promise<{ ok: true }>` in src/actions/contacts.ts: auth via the page's usual guard, sets `relationship_digests.relationship.removed = true` for the user's own contact (tenant-checked), revalidates the contact page.

- [ ] **Step 1: Failing checks** (PGlite, in `smoke-relationship-context.ts`): after `removeRelationshipKind`, `loadRelationshipContexts` gives `kind: null`; a later `applyDigestPlan` with a new kind leaves it removed (PR 2's rule); the action refuses another user's contact.
- [ ] **Step 2–4:** run, implement, run the smoke. Expected: pass.
- [ ] **Step 5: Browser check.** Start the preview, open a contact that has a seeded digest (seed with a scratch script, not a committed one), screenshot the card at desktop and 375px, click "Not right?" and confirm the chip goes and stays gone after reload. Follow the design language memory (Fraunces/Outfit, teal+gold) and the existing card's components; no new visual system.
- [ ] **Step 6: Commit** `feat(deep-read): the contact page shows how you met and what you share`.

### Task 6: Whole-branch checks

- [ ] `tsc` (0 errors outside `.next`), `npm run lint`, `npm run db:check`, `npm run check:sources`, `npm run check:cycles`, `npm run css:site` (commit if it changes).
- [ ] Stop `next dev`, then `npm test`. Expected: all pass.
- [ ] Report to Jason with the screenshots. Nothing pushed.

## Not in this PR

- MCP exposure, /privacy, TERMS_VERSION, turning the flag on, the existing-user catch-up: PR 5.
- B (circles, "closest people" list): its own design after PR 5.
- Editing the origin text from the card (the existing contact form edits how-met).
