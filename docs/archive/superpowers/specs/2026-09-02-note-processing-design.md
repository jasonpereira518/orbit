# Note processing overhaul: participants, mentions, auto-reminders, and the contact brief

**Date:** 2026-09-02
**Status:** Approved design, not yet implemented
**Plan:** `docs/superpowers/plans/2026-09-02-note-processing.md`

## Problem

Orbit's paste-anything capture (`/capture`, messy mode) runs two concurrent AI passes over
a note dump: multi-person extraction (`parseMultiPersonNotesWithAI`, `src/lib/ai.ts`) and
absolute-date commitment extraction (`extractDatedCommitments`,
`src/lib/date-commitment-extract.ts`). People are matched to existing contacts with
`findDuplicateCandidates` and confirmed one card at a time in `BulkNotesPanel`; dated
commitments are staged in `suggested_reminders` and only become reminders after a click.
Every note write funnels through `logInteractionForUser` (`src/lib/contact-writes.ts`),
which regenerates a single-paragraph `contacts.aiSummary` (`src/lib/person-summary.ts`).

The goal is for notes to feel like an assistant read them: know who was actually spoken
to versus merely mentioned, date the interaction from the notes (or upload time), pull out
topics, deadlines, and event dates, create reminders and follow-ups automatically, and show
a useful brief on the profile (recent discussions and open next steps).

Gaps, verified against the code:

- No participant vs. mention distinction. Every name becomes a candidate contact with an
  interaction, so people you never met end up on timelines.
- Action items are `interactions.actionItems: string[]` with no completion state and no
  aggregation across notes. There is no "open next steps" view.
- Reminders from notes are suggest-then-confirm, and relative dates ("in two weeks") are
  rejected outright by `RELATIVE_RE`.
- The profile summary is one paragraph. There is no recent-discussions list.
- Mentions are inferred after the fact by substring scan (`src/lib/related-contacts.ts`)
  and never stored.

## Decisions taken

Settled during design; recorded so the plan does not relitigate them.

| Decision | Choice | Why |
|---|---|---|
| Reminder creation | Auto-create real `reminders` rows tagged from-notes, with a results view offering per-item dismiss/edit and a batch-level Undo | Zero friction; a little noise is cheaper than a confirm step nobody clicks |
| People | Participants get an interaction on their timeline. Mentions are matched to existing contacts and stored as a link shown on both profiles. Unknown mentions are offered as optional new contacts, never auto-created | Keeps timelines honest while still capturing the social graph |
| Relative dates | Resolved deterministically against the note's interaction date (or upload date), verified against the source text. Vague phrases ("soon") map to a 14-day window | Most follow-ups are phrased relatively; dropping them loses the value |
| Undated action items | Every item lands on the profile checklist and becomes its own reminder due in the default window, linked to the item | Nothing slips; the results view and collision rules keep volume sane |
| Undo scope | Reminders and mention links only. Contacts and interactions stay; the results page offers per-row delete for contacts the batch created | The user already reviewed contacts card by card before saving |
| Profile | Structured brief: 2–3 sentence "where things stand", "Recent discussions" (last 5, one line with date), "Open next steps" checklist aggregated across notes | Answers "what do I need to know before I reply" at a glance |
| Entry points | `/capture` stays the hub; add an "Add notes" card on the contact profile pre-seeded with that contact as participant. Chat panel and extension embeds are out of scope this round | The two places notes actually get pasted |
| Processing core | Extend the existing two concurrent passes rather than one mega-pass or a third mentions pass | Keeps failure isolation and the long-note two-pass escalation; output-token truncation is the real failure mode and a mega-schema makes it worse |
| Gating | Unchanged: BYOK key presence via `getAiCapability`; no plan gate. `capture.ts` stays un-surface-gated because the onboarding wizard depends on it | Policy change, not in scope |

Explicitly out of scope: dropping `suggested_reminders` (drained, not dropped), a digest
email, embedding individual notes, chat/extension entry points.

## 1. Data model (SCHEMA_VERSION 16 → 17)

New tables go in the `DDL` template in `src/db/index.ts`; new columns on existing tables
go in the `alters` list. One version bump carries everything so later slices need none.

### `interaction_mentions` (new)

```
id uuid pk, user_id text, interaction_id uuid → interactions ON DELETE CASCADE,
contact_id uuid → contacts ON DELETE CASCADE,
mention_text text,            -- as written in the note
confidence real,
matched_by text,              -- exact_name | name_company | first_name_unique | user_pick
created_at timestamptz
UNIQUE(interaction_id, contact_id); INDEX(user_id, contact_id)
```

A table rather than jsonb on `interactions` because both profiles need an indexed lookup
from either side. Unresolved mentions are not persisted here; they live in the batch
result (§3) as "offer as new contact".

### `action_items` (new)

```
id uuid pk, user_id text, contact_id uuid → contacts CASCADE,
interaction_id uuid → interactions CASCADE,
text text, position int,
status text 'open'|'done', completed_at timestamptz,
item_hash text,               -- sha256(`${interactionId}|${text.trim().toLowerCase()}`)
reminder_id uuid → reminders SET NULL,
created_at timestamptz
UNIQUE(user_id, item_hash); INDEX(user_id, contact_id, status)
```

`interactions.actionItems: string[]` stays as a write-through denorm so the four current
readers (`contact-timeline.tsx`, `conversation-starters.ts`, `admin-user-detail.ts`, the
timeline edit form) are untouched. Sync point: `syncActionItems(userId, interactionId,
contactId, texts)` in new `src/lib/action-items.ts`, built on a pure
`diffActionItems(existing, incoming) → { insert, deleteIds }` that never deletes rows with
`status = 'done'` or a `reminder_id`. Called from `logInteractionForUser` and
`updateInteraction`. Capped at 10 items per interaction.

Backfill of legacy rows: one idempotent statement in `alters` using
`jsonb_array_elements_text(action_items)` and `encode(sha256(...), 'hex')` with
`ON CONFLICT DO NOTHING`. The SQL hash formula must match the TS one exactly; the smoke
test hashes a fixture both ways and asserts equality.

### `reminders` (new columns)

```
note_batch_id uuid, source_interaction_id uuid → interactions SET NULL,
action_item_id uuid,          -- bare uuid, no FK (see below)
source_excerpt text, raw_date_phrase text,
date_basis text,              -- absolute | relative | vague | window
item_hash text
UNIQUE INDEX reminders_user_item_hash_uidx ON reminders(user_id, item_hash)
```

No predicate on that index and none needed: Postgres treats NULLs as distinct, so every
reminder without an `item_hash` (anything not created from notes) sits outside it.

`reminders.action_item_id` carries **no** foreign key. `action_items` is created *after*
`reminders` in the bootstrap DDL template — it references `reminders.id` — so a reverse FK
here would be a forward reference to a table that does not exist yet. The one real FK
between the two runs the other way, `action_items.reminder_id → reminders.id`.

`item_hash` reuses `buildSuggestionItemHash(sourceHash, dueDateIso, title)` from
`src/lib/suggested-reminder-utils.ts`. "From notes" means `note_batch_id IS NOT NULL`.
`reminderType` is `extracted_date` for absolute/relative and `ai_suggested` for
vague/window. New `status` value `dismissed`: undo marks, never deletes, so the hash index
keeps blocking re-creation on re-paste. `listDueNotificationItems` and every reminder list
query must filter `status = 'pending'` explicitly (audit for `!= 'done'`).

`suggested_reminders` stops receiving writes. Existing pending rows keep working through
the current panel until drained.

### `note_batches` (new)

```
id uuid pk, user_id text, source_hash text, source_text text,
entry_point text 'capture'|'profile', seed_contact_id uuid,
anchor_date timestamptz, anchor_basis text 'note'|'hint'|'upload',
status text 'saved'|'undone', result jsonb, created_at, undone_at
INDEX(user_id, created_at); INDEX(user_id, source_hash)
```

Plus `interactions.note_batch_id uuid` in `alters`. `result` shape:

```ts
{ participants: { contactId, interactionId, name, created: boolean }[],
  mentions: { interactionId, contactId, text, confidence, matchedBy }[],
  unresolvedMentions: { text, context }[],
  actionItems: { id, contactId, text, reminderId }[],
  reminders: { id, contactId, title, dueIso, dateBasis, rawDatePhrase, sourceExcerpt }[],
  skipped: { relative, unverifiable, past, duplicate } }
```

### `contact_briefs` (new, 1:1)

```
contact_id uuid pk → contacts CASCADE, user_id text,
standing text, recent_discussions jsonb,   -- { interactionId, dateIso, line }[]
generated_at timestamptz, basis_interaction_id uuid, model text
```

Kept off `contacts` because that table is scanned whole on hot paths
(`getClosenessCohort`, the list page). Open next steps are never stored; they are a live
query over `action_items`.

## 2. Processing flow (`parseBulkCaptureNotes`, `src/actions/capture.ts`)

The shape stays: two concurrent passes, fail only if both come back empty.

**People pass** (`src/lib/ai.ts`). `noteParseSchema` gains
`presence: 'participant' | 'mentioned'` (default participant) — named `presence`, not
`role`, because `role` is already the person's job title on the same object.
`multiPersonNoteParseSchema` gains top-level
`mentions: { name, context, near_person }[]` for names the model judges were not present.
Both the single-pass prompt and the identify pass of the two-pass path carry `presence`;
otherwise long notes lose it. `PERSON_FIELD_SHAPE` documents it.

**Dates pass** (`src/lib/date-commitment-extract.ts`). The prompt drops "ABSOLUTE DATES
ONLY" and asks for every dated or relatively-dated commitment, copying `raw_date_phrase`
verbatim, with a `date_kind` hint (`absolute | relative | vague`). The model still emits
an ISO guess for absolute phrases only. `validateCommitments(rawItems, notes, { today,
anchor })`:

1. Verbatim containment of `raw_date_phrase` in the note (hallucination guard, unchanged).
2. If `RELATIVE_RE` matches: `resolveRelativeDate(phrase, anchor)`; null counts as
   `rejected.relative`.
3. Otherwise `deriveMonthDay` + `resolveDate` as today, plus the model-ISO agreement check.
4. Past check against today, not the anchor: `rejected.past`.
5. Dedupe on `isoDay|title`, cap at `MAX_COMMITMENTS`.

`DatedCommitment` gains `dateBasis` and `anchorIso`.

**Anchor.** Computed after `Promise.all`:
`anchor = personParse.interaction_date ?? mergedHints.eventDate ?? now`, with
`anchorBasis` recorded on the batch. Resolution runs after both passes, which keeps them
concurrent while giving the resolver the date the people pass found.

**Mention resolution.** New pure module `src/lib/mention-resolution.ts`:
`resolveMentions(index: DuplicateIndex, mentions, ctx: { participantCompanies })
→ { resolved, unresolved }` on top of `buildDuplicateIndex` /
`findDuplicateCandidatesIndexed` (`src/lib/duplicates.ts`; the file reads as binary, use
`git show HEAD:src/lib/duplicates.ts | cat -v`). Rules: a full name at ≥ 0.85 resolves; a
first-name-only mention resolves only when exactly one contact shares that first name (and
the company matches if the note gave one); anything else is unresolved. Participants in
the same batch are excluded as mention targets.

**Preview payload.** The client receives `role`, resolved and unresolved mentions,
per-item `dateBasis`, and action items with their projected reminder due dates, so the
review cards can show "will create N reminders" before save.

## 3. Save, results view, undo (`confirmBulkCapture`, `src/actions/capture.ts`)

Per participant (existing `confirmCapture` path):

- The interaction insert gets `externalId = notes:${sourceHash}:${contactId}` with
  `onConflictDoNothing` on the existing `(user_id, external_id)` index. A re-paste is a
  no-op counted in `skipped.duplicate`. `note_batch_id` is set.
- `syncActionItems` runs for the interaction. For each new item a reminder is inserted
  (`reminderType ai_suggested`, `dateBasis window`, due `anchor + 14d` pinned to local
  noon, `action_item_id` linked, `item_hash = buildSuggestionItemHash(sourceHash, dueIso,
  text)`).
- Dated commitments for this person become reminders directly (`extracted_date`,
  provenance columns filled, `item_hash` dedupe). The existing 3-day collision rule is
  kept and extended: a dated commitment suppresses a window reminder for an action item
  with the same normalized title.
- The per-participant "Follow up with X" reminder (`follow_up_days`) is created only when
  the participant ended up with zero reminders from the two rules above, so the
  relationship-hygiene nudge survives without doubling.
- `contacts.nextFollowUpAt` is still set, as today (separate signal).

Then `interaction_mentions` rows are inserted, the `note_batches` row is written, and
`batchId` is returned. `BulkNotesPanel.onSaved` routes to `/capture/[batchId]`, a server
page that renders `result`: participants (with a "new" badge and per-row delete for
`created: true`), mentions, unresolved mentions with "Add as contact" (opens the existing
create flow pre-filled), reminders with inline dismiss/edit (reuse `reminder-form-dialog`),
action items, and skipped counts with the anchor date labelled ("counted from Sep 1, the
date in your notes").

Batch-level Undo calls `undoNoteBatch(batchId)`: pending reminders with that
`note_batch_id` become `dismissed`; the batch's `interaction_mentions` are deleted;
`status = 'undone'`. Interactions, action items, and contacts are untouched.

Dashboard and reminders pages already render `reminders` rows; add a small "From notes"
chip when `note_batch_id` is set, linking to the batch page.

## 4. Relative-date resolver (new `src/lib/relative-date.ts`, pure)

```ts
export type DateBasis = "absolute" | "relative" | "vague";
export function resolveRelativeDate(
  phrase: string,
  anchor: Date,
  opts?: { defaultWindowDays?: number },
): { date: Date; basis: DateBasis; rule: string } | null;
```

Grammar (all pinned to `atLocalNoon`; reuse and export `WEEKDAYS` from
`src/lib/interaction-date.ts`):

- `tomorrow`
- `in N days|weeks|months`, N numeric or one..twelve, "a couple of" = 2, "a few" = 3
- bare, `next`, or `this <weekday>`: first strictly-after occurrence
- `next week`: Monday after the anchor's week; `next month`: 1st of the following month
- `end of (the) week|eow`: Friday; `end of (the) month|eom`: last day; `end of quarter|year`
- `q1..q4`: first day of that quarter, next future occurrence; `after the holidays`: Jan 2
- vague set `soon|at some point|sometime|later|eventually|when (I|you) get a chance|next
  time`: anchor + `defaultWindowDays` (14), basis `vague`
- anything else: null

`parseInteractionDateFromNotes` is deliberately not reused: it walks yearless dates
backwards, which is right for dating a past interaction and wrong here.

## 5. Profile brief (`src/lib/person-summary.ts` → `src/lib/contact-brief.ts`)

`generateAndStoreContactBrief(userId, contactId, { force })` replaces
`generateAndStorePersonSummary` at every call site (`contact-writes.ts`,
`actions/contacts.ts`, `extension/writes.ts`, `regenerateContactSummary`). One
`completeJson` call with `operation: "contact.brief"` and zod
`{ summary: string, standing: string (≤ 600 chars) }`. It writes `contacts.aiSummary`
(the legacy paragraph, so embeddings and chat are unchanged) and `contact_briefs`.
`recent_discussions` is built deterministically (last 5 interactions: `isoDay` plus the
first sentence of `aiSummary` or the first 120 chars of `rawNotes`) and written even when
the AI call fails, alongside the existing deterministic fallback for the paragraph.

Staleness: `contact_briefs.generated_at < contacts.lastInteractionAt`. The profile page
renders what exists and, if stale, kicks `after(() => generateAndStoreContactBrief(...))`.

`listOpenActionItems(userId, contactId)` (status open, newest interaction first) feeds
the checklist. `setActionItemStatus(id, 'open' | 'done')` is a server action.
`markReminderDone` also closes a linked action item, and checking an item completes its
linked reminder.

**UI.** New `ContactBriefCard` between `ContactStatPills` and `ContactProfileOverview` on
`src/app/(app)/(main)/contacts/[id]/page.tsx`: standing paragraph, "Recent discussions"
(each line links to the timeline entry), "Open next steps" checklist.
`ContactProfileOverview` keeps `aiSummary` and key facts as "Who they are". A new
"Mentioned in" section below the timeline lists `interaction_mentions` in both
directions, each linking to the interaction.

## 6. Profile "Add notes" entry

A collapsible "Add notes" card above `ContactTimeline` renders `BulkNotesPanel` in
`compact` mode with a new `lockedParticipantId` (plus name) prop: the review step
pre-selects merge into that contact, marks the role participant, and passes
`hints.seedPeople = [{ name }]` so the people pass attributes first-person notes to them.
`entry_point = 'profile'` and `seed_contact_id` are set on the batch. On save, the page
stays on the profile and shows a toast linking to `/capture/[batchId]`.

## 7. Implementation slices

Each slice is one PR with its own smoke script (`scripts/smoke-*.ts`, run with `npx tsx`;
the repo has no vitest or jest).

| # | Slice | Key files | Smoke |
|---|---|---|---|
| 1 | Relative-date resolver, `validateCommitments` anchor routing, dates prompt change | `src/lib/relative-date.ts`, `date-commitment-extract.ts`, `interaction-date.ts` (export `WEEKDAYS`) | `scripts/smoke-relative-date.ts`: grammar table at a fixed anchor, year boundary, past-vs-today, vague default; extend `smoke-date-commitments.ts` |
| 2 | Schema v17 (all tables and columns), provenance, auto-create, `note_batches`, `/capture/[batchId]`, `undoNoteBatch`, "From notes" chip, `dismissed` status audit | `schema.ts`, `db/index.ts`, `capture.ts`, `actions/note-batches.ts`, `app/(app)/(main)/capture/[batchId]/page.tsx`, `actions/reminders.ts` | `scripts/smoke-note-batch.ts` (PGlite): save twice → one interaction and one reminder; undo → dismissed; re-paste → `skipped.duplicate`; `npm run db:check` |
| 3 | Participant/mention roles in both prompts, `resolveMentions`, `interaction_mentions` writes, "Mentioned in" section, unresolved offers on the results page | `ai.ts`, `src/lib/mention-resolution.ts`, `capture.ts`, profile components | `scripts/smoke-mention-resolution.ts` (pure): full name, unique first name, ambiguous first name, participant exclusion |
| 4 | `action_items` sync, backfill, per-item reminders, checklist, reminder↔item completion link | `src/lib/action-items.ts`, `contact-writes.ts`, `actions/contacts.ts`, `actions/action-items.ts`, `ContactBriefCard` (checklist part) | `scripts/smoke-action-items.ts`: diff rules, hash parity SQL vs TS, done rows survive re-sync |
| 5 | `contact_briefs`, `generateAndStoreContactBrief`, brief card | `src/lib/contact-brief.ts`, profile page | `scripts/smoke-contact-brief.ts`: deterministic recent discussions without an AI key, staleness predicate |
| 6 | Profile "Add notes" card, `lockedParticipantId` | `bulk-notes-panel.tsx`, profile page | manual, plus a `smoke-parsers` hint-construction check |

Order matters. Slice 1 is pure and ships inside today's staged flow. Slice 2 lands the
schema once. Slices 3–5 are independent after 2. Slice 6 is last.

## 8. Risks and mitigations

- **Auto-created reminders reach desktop notifications**, which is why
  `suggested_reminders` existed. Due dates are always ≥ today, undo marks `dismissed`, the
  results view is surfaced immediately after save, and `item_hash` dedupes.
- **Reminder volume** with "a reminder each": the collision rule against dated
  commitments, the per-participant follow-up only when nothing else was created, the
  results page dismiss, and the 10-item cap per interaction.
- **Anchor quality**: with no date in the notes and no hint, relative phrases resolve from
  upload time. The batch stores `anchor_basis` and the results view labels it.
- **Long notes lose `role`** if only the single-pass prompt changes. Slice 3 updates the
  identify pass too and `smoke-parsers` covers both shapes.
- **Hash parity** between the SQL backfill and the TS `item_hash` is asserted by smoke test.
- **`updateInteraction` and imports bypass `syncActionItems`** unless wired. Slice 4 wires
  the former; import-engine interactions carry no action items today.
- **Parallel worktrees**: re-check `origin/main` before each PR; rival implementations have
  landed mid-task before.

## 9. Repo rules the plan must carry

- Read `node_modules/next/dist/docs/` before writing route or action code (AGENTS.md).
- Every `completeJson` call passes an `operation` label.
- Schema changes go through the DDL template and `alters` list in `src/db/index.ts`, a
  `SCHEMA_VERSION` bump, and `npm run db:check -- --update`. Never `db:push`.
- Stop the worktree's dev server before running any PGlite-writing smoke script.
- Worktrees have no `node_modules`; symlink main's or `tsc`/`eslint` silently no-op.

## 10. Verification (end to end, after all slices)

1. `npm run db:check`, `npx tsc --noEmit`, `npx next build` (build passes at baseline;
   eslint baseline is 48 errors).
2. Run every new smoke script with the worktree dev server stopped.
3. Dev server on the worktree port with a Gemini key in `.env.local`. Paste a fixture note
   containing two participants, one mention of an existing contact, one unknown mention,
   "kickoff Sept 20", "circle back in two weeks", "send the deck soon", and three undated
   action items. Confirm: two interactions dated from the note, one `interaction_mentions`
   row, the unknown mention offered not created, reminders for Sept 20, +14d relative,
   +14d vague, and the window items minus collisions, the results page renders, Undo
   dismisses reminders and removes the link, and a re-paste reports duplicates.
4. Open each participant's profile: the brief card shows standing, recent discussions, and
   the checklist; checking an item marks its linked reminder done; "Mentioned in" shows the
   link on both profiles. Add notes from the profile card with the contact locked.
