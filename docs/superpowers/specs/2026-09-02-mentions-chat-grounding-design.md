# Mention-grounded chat, unresolved-mention review, prefilled contact creation

**Date:** 2026-09-02
**Status:** Approved design, not yet implemented
**Plan:** `docs/superpowers/plans/2026-09-02-mentions-chat-grounding.md`
**Depends on:** the note-processing overhaul (`docs/superpowers/specs/2026-09-02-note-processing-design.md`, PR #107, schema v19)

## Problem

The note-processing overhaul split people named in a pasted note into participants (get a
timeline entry) and mentions (named but not present, e.g. "Sarah said her cofounder Raj is
hiring"). A mention that resolves to an existing contact gets a durable row in
`interaction_mentions`, visible on both profiles. A mention that resolves to *no* contact is
a dead end: it lives only as `{ text, context }` inside the jsonb snapshot on
`note_batches.result.unresolvedMentions`, with no stable id, no visibility outside the one
batch it came from, and a results-page "Add as contact" link that passes no data and goes
nowhere useful (`/capture?mode=structured`).

Separately, "ask your network" chat (`askNetwork` → `chatWithNetwork`) grounds answers in
relevance-ranked contacts and their notes but has no awareness of the mention graph — it
cannot answer "who's mentioned Raj Patel" even though that is now structured data.

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Unresolved mentions | Get a real table (`unresolved_mentions`), not a cross-batch jsonb flatten | No precedent in this codebase for querying many rows and flattening a jsonb array across them; a real table lets the review screen, the notification count, and the per-batch results page share one identity via a stable id |
| Notification entry | One aggregate `info`-urgency panel item ("N people mentioned need review"), not one per mention | Matches the existing `suggestion`/`suggested_reminder` precedent; avoids flooding the panel; never fires a desktop notification, same as an unconfirmed AI date guess |
| Resolving a mention | "Link to existing contact" or "Add as new contact", both close the loop by marking the row resolved | Mirrors `suggested_reminders`' stage-then-confirm shape; `interaction_mentions.matchedBy` already has a `"user_pick"` literal anticipating this |
| Contact creation | `/contacts/new` accepts a prefill via query params; a mention-originated create also resolves the mention on success | One route serves both the batch results page's "Add as contact" and the new review screen's, no duplicate UI |
| Chat grounding | Extend the existing per-contact context block with mention lines for the already-retrieved top-K contacts; no new intent-gated subsystem | Mentions are only meaningful for contacts that already surfaced via semantic/keyword search; a `chat-roster.ts`-style exhaustive lookup is unneeded machinery for this |
| Chat response validation | Left as-is (no zod schema) | Pre-existing condition, out of scope for this work |

## 1. Data model (SCHEMA_VERSION 19 → 20)

New table, added to the `DDL` template in `src/db/index.ts` only — per this repo's migration
rule, a brand-new table needs no `alters` entry and no `ensureColumn` call (those exist only
for adding a column to a table that already exists elsewhere):

```
CREATE TABLE IF NOT EXISTS unresolved_mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  note_batch_id uuid NOT NULL REFERENCES note_batches(id) ON DELETE CASCADE,
  interaction_id uuid REFERENCES interactions(id) ON DELETE SET NULL,
  near_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  mention_text text NOT NULL,
  context text,
  source_hash text NOT NULL,
  item_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  resolved_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS unresolved_mentions_user_status_idx ON unresolved_mentions(user_id, status);
CREATE INDEX IF NOT EXISTS unresolved_mentions_batch_idx ON unresolved_mentions(note_batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS unresolved_mentions_user_item_hash_uidx ON unresolved_mentions(user_id, item_hash);
```

FK reasoning: `note_batch_id` cascades — the batch is the owning unit, matching how
`undoNoteBatchForUser` already treats a batch's dependents. `interaction_id`,
`near_contact_id`, and `resolved_contact_id` are `SET NULL` — losing an interaction or a
contact must not destroy the review row's identity, mirroring the existing comment on
`suggested_reminders.contact_id`.

**Correction found while writing the task plan** (the design above under-specified this):
every sibling table in this pipeline — `action_items`, `reminders`, `interaction_mentions`
— dedupes across a re-paste of the same note, either via a soft-unique `external_id`, an
`item_hash`, or a real unique index. `unresolved_mentions` needs the same guard, or
re-pasting a note that still contains an unresolved name (a very normal thing — the user
hasn't acted on it yet) would insert a fresh duplicate "pending" row on every paste,
flooding the review screen. `item_hash = buildSuggestionItemHash(sourceHash, "mention",
mentionText)` — reusing the existing hash helper from `suggested-reminder-utils.ts` with a
fixed second argument in place of a due date — backed by a unique `(user_id, item_hash)`
index, `onConflictDoNothing` on insert. `source_hash` is stored denormalized (same pattern
`suggested_reminders` already uses) so the hash can be recomputed/verified without a join.

`NoteBatchResult.unresolvedMentions` (in `src/db/schema.ts`) gains an optional `id`:
`{ text: string; context: string | null; id?: string }`. Optional so jsonb rows written
before this ships stay valid; every consumer must treat a missing `id` as "no resolve
action available for this legacy row."

Bump `SCHEMA_VERSION` from 19 to 20; run `npx tsx scripts/smoke-schema-ddl.ts --update`
after, and confirm `npm run db:check`.

## 2. Write path

In `src/lib/note-batch-save.ts`'s mention loop (the `for (const m of input.mentions ?? [])`
block, step "1b"), both `result.unresolvedMentions.push({ text: m.text, context: m.context
})` sites (no resolvable contact; a resolvable contact with no interaction to hang it on)
also push into a local `unresolvedCandidates` array carrying `{ userId, noteBatchId: batchId,
interactionId: interactionId ?? null, nearContactId: nearId ?? null, mentionText: m.text,
context: m.context, sourceHash: input.sourceHash, itemHash: buildSuggestionItemHash(input.sourceHash,
"mention", m.text) }`, built in lockstep with `result.unresolvedMentions` so array
position lines up. After the loop, one `insert(...).onConflictDoNothing({ target: [userId,
itemHash] }).returning()`; for any candidate whose hash didn't come back (a real re-paste
conflict), a follow-up `select` by the missing hashes resolves the existing row's id. Stamp
every id back onto `result.unresolvedMentions[i].id` by matching `itemHash`.

## 3. Read path and actions

New `"use server"` file `src/actions/unresolved-mentions.ts`:

```ts
export async function listUnresolvedMentions(): Promise<UnresolvedMentionRow[]>
export async function resolveUnresolvedMentionToContact(mentionId: string, contactId: string): Promise<void>
export async function dismissUnresolvedMention(mentionId: string): Promise<void>
```

`listUnresolvedMentions` joins `contacts` (for `near_contact_id`) and `interactions` (for
`interaction_id`) to give the review screen display context, filtered to the caller's
`pending` rows, newest first, capped at 100 — the same order of magnitude as the other
per-user queries in `listNotificationPanel`.

`resolveUnresolvedMentionToContact` marks the row `resolved` with `resolved_contact_id` and
`resolved_at`, and — only when the row has an `interaction_id` — also inserts a real
`interaction_mentions` row (`matchedBy: "user_pick"`, confidence 0.6, `onConflictDoNothing`
on the existing `(interaction_id, contact_id)` unique index) so the mention retroactively
appears on both profiles' "Mentioned in" sections. `dismissUnresolvedMention` just flips the
status, no further writes.

A sibling `revalidateMentionPaths(contactId?: string | null)` lives in
`src/lib/reminder-paths.ts` next to `revalidateReminderPaths` — same file, same reason
(`"use server"` modules may only export async functions): revalidates `/mentions/review`,
and the resolving contact's profile when a `contactId` is given.

## 4. Review screen

New route `src/app/(app)/(main)/mentions/review/page.tsx` (Server Component) renders
`src/components/mentions/unresolved-mentions-review.tsx` (client): one row per mention with
its text, context, and "found in your note about {nearContactName}" when available. Three
actions per row:

- **Link to existing contact** — reuses `searchContactsForPicker(q?, limit)` from
  `src/actions/contacts.ts`, the same pattern `reminder-form-dialog.tsx` already uses; no
  new picker component.
- **Add as new contact** — routes to `/contacts/new` with the mention's text, context, and
  id (see §5).
- **Dismiss** — calls `dismissUnresolvedMention`.

## 5. Notification-panel entry

In `src/actions/reminders.ts`'s `listNotificationPanel()`, add a fifth query to the existing
`Promise.all`: a `count(*)` against `unresolved_mentions` filtered to the caller's `pending`
rows — a count, not a row fetch, so cost never scales with backlog size. Extend
`PanelItem["kind"]` with `"unresolved_mentions"`. When the count is nonzero, push one item:

```ts
{ id: "unresolved_mentions", kind: "unresolved_mentions",
  title: `${n} ${n === 1 ? "person" : "people"} mentioned need review`,
  body: null, url: "/mentions/review", dueAt: null, urgency: "info" }
```

`urgency: "info"` matches the existing `suggestion`/`suggested_reminder` items exactly: it
never inflates the bell-badge `dueCount`, and never reaches `listDueNotificationItems`
(which only looks at `urgency === "due"`) — no desktop notification for an unresolved
mention. `NotificationRow` needs no change; it already renders any `PanelItem` via a plain
link to `item.url`.

## 6. Contact creation prefill

`src/app/(app)/(main)/contacts/new/page.tsx` gains
`searchParams: Promise<{ name?: string; context?: string; mentionId?: string }>`. When
`name` is present, build `initial: Partial<ContactInput> = { fullName: name, notes: context
|| undefined, source: "mention_capture" }`. Render plain `<ContactForm initial={initial} />`
when there is no `mentionId` (identical to today's behavior when `name` is absent); when
`mentionId` is present, render a new small client wrapper,
`src/components/contacts/contact-form-from-mention.tsx`, which passes
`redirectOnSuccess={false}` and an `onSuccess` that calls
`resolveUnresolvedMentionToContact(mentionId, contact.id)` (best-effort — a failed resolve
must not block navigation) before redirecting to the new contact's profile.

`ContactForm`'s submit handler forwards `initial?.source` into the submitted `ContactInput`
(it currently forwards every other `initial` field except this one). This is safe
unconditionally on both create and update: the create path already defaults
`input.source ?? "manual"`, and the update path only assigns `source` when it is not
`undefined` — the profile-edit flow's own prefill object never sets `source`, so editing an
existing contact is unaffected.

Both "Add as contact" callers (the batch results page and the new review screen) build the
same href shape: `/contacts/new?name=<mention text>&context=<mention context>&mentionId=<id>`
(the last param omitted when the mention has no stable id — a legacy jsonb row).

Known limitation, accepted for v1: mention text is not always a clean full name — it
prefills a name the user edits before submitting, not a guaranteed-correct one.

## 7. Chat grounding

New batched query in `src/lib/contact-mentions.ts`, alongside the existing single-contact
`listContactMentions`:

```ts
export async function listContactMentionsBatch(
  userId: string,
  contactIds: string[]
): Promise<Map<string, { mentionedByLines: string[]; mentionsOfLines: string[] }>>
```

Two queries total (not N per contact), mirroring `listContactMentions`'s two directions but
with `inArray` in place of `eq`, each bounded by `limit(contactIds.length * 5)` since
`inArray` cannot cap per group; group in memory (rows already ordered by interaction date
descending) and take the first 3 per direction per contact.

`src/actions/chat.ts`'s `askNetwork` calls this right after computing `retrieved`
(the top-12 semantically-ranked contacts) and attaches `mentionedByLines`/`mentionsOfLines`
to each contact's payload passed into `chatWithNetwork`. `src/lib/ai.ts`'s `chatWithNetwork`
gains the same two optional fields on its `contactsContext` element type and renders them as
additional conditional lines in the per-contact context block, following the exact pattern
already used for `keyFacts`/`recentMessages`. No system-prompt change needed.

## 8. Risks

- **Rebase risk**: another branch may replace `askNetwork`/`chatWithNetwork` with a
  streaming `/api/chat` route. Verified at design time that neither exists yet in this
  worktree. If that lands on `main` first, §7's wiring must be re-applied to whatever
  retrieval module replaces it; `listContactMentionsBatch` itself is implementation-agnostic
  and carries over unchanged.
- **Backward compatibility**: existing `note_batches.result.unresolvedMentions` rows written
  before this ships have no `.id`. The results page must render legacy rows without a resolve
  affordance rather than assume an id that isn't there.
- **Query cost**: the notification-panel addition is a `count(*)`, not a row fetch, so
  backlog size never affects panel load time. The review screen has no pagination beyond
  `limit(100)` for v1, matching the existing `suggested_reminders` precedent in the same
  function.
- **Idempotency**: resolving a mention twice (e.g. two tabs) is safe — the
  `interaction_mentions` insert uses `onConflictDoNothing` on its existing unique index.

## 9. Repo rules this plan must carry

- Every `completeJson` call keeps its `operation` label (unchanged by this work — no new AI
  calls are introduced).
- A brand-new table needs only the `DDL` template entry plus a `SCHEMA_VERSION` bump; do not
  add spurious `alters`/`ensureColumn` entries for it.
- `"use server"` files export only async functions.
- Never `db:push`.
- Worktrees have no `node_modules`; symlink the main repo's.
- PGlite is single-writer per worktree; stop any dev server for this worktree before running
  a DB-writing smoke script.

## 10. Verification

1. `npm run db:check` after the schema slice; re-run the PGlite migration one-liner to
   confirm `unresolved_mentions` is queryable.
2. `npx tsc --noEmit` and `npx eslint` on every touched file after each slice.
3. Extend `scripts/smoke-note-batch.ts` to assert an unresolved mention gets a real row with
   the id stamped back into the snapshot.
4. No smoke suite exists for chat (no test harness for it in this repo) — verify manually:
   ask "who's mentioned `<name>`" for a contact with a resolved mention and confirm the
   answer cites it.
5. End-to-end manual pass: paste a note naming an unknown person → confirm a notification
   panel item appears → open `/mentions/review` → link one mention to an existing contact
   and confirm it now shows on that contact's "Mentioned in" section → create a new contact
   from another mention and confirm the review list drops it and the new contact has
   `source: "mention_capture"`.
