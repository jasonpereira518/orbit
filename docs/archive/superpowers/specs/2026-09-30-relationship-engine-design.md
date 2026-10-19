# Relationship engine — understanding every conversation, per contact

**Date:** 2026-09-30
**Status:** Design approved in conversation; awaiting spec review. Implementation plan to follow.
**Branch:** `claude/contact-relationship-engine-ada98f`, cut from `main` at `28150e12` (schema 143).

## Problem

Jason asked for a processing engine: upload connections and messages, and Orbit reads them,
understands each relationship — what the person does, what you have been talking about, the
important notes, action items and implied follow-ups — writes that onto the person's profile,
and turns dates into reminders.

A thin version exists, for LinkedIn messages only, and it is the wrong shape to grow:

- `src/lib/message-enrichment.ts` (362 lines) runs from the LinkedIn messages adapter's
  `finalize`, one `import.enrich` call per contact, returning
  `{summary, key_facts, open_loops, relationship_score_suggestion, topics}`.
- It is capped at **40 contacts per import, in arbitrary order** (`maxContacts ?? 40`), so a
  500-conversation import enriches 40 people.
- It extracts **no dates**, so it writes no reminders and no action items.
- Its summary is appended to `contacts.ai_summary`, which `generateAndStoreContactBrief`
  rewrites wholesale the next time the brief regenerates.
- Open loops are stored as `"Open: …"` strings inside `contacts.key_facts`. Nothing reads them.
- `finalize` has no time budget, so the cap cannot simply be lifted.

Meanwhile capture already extracts everything asked for — promises (`you_owe`/`they_owe`),
implied next steps, dated commitments with deterministic date resolution, work details — and
saves through `saveNoteBatch` with batch Undo. The Drive import already runs that pipeline
unattended with stricter, age-aware reminder rules (`src/lib/imports/drive-reminder-rules.ts`).
Only LinkedIn message bodies are stored today; email bodies are stored nowhere.

## Decisions taken

Settled with Jason during design; recorded so nothing relitigates them.

| # | Decision | Choice | Declined |
|---|---|---|---|
| 1 | Sources in v1 | LinkedIn messages **plus WhatsApp and iMessage chat exports** | LinkedIn only with a pluggable core; LinkedIn + Gmail/Outlook bodies; just fixing the existing enrichment |
| 2 | Autonomy | **Auto-write, date-aware.** Profile facts land automatically; reminders only for stated future dates and implied follow-ups from recent messages; older loops become open threads with no reminder; one Undo per run | Review queue first; hybrid by confidence; fully automatic incl. past-due reminders |
| 3 | Group chats | **Analyzed, attributed to known people only.** Unmatched members are offered as "add as contact", never auto-created | 1:1 only; full group support with auto-created members |
| 4 | Architecture | **A — conversation digest engine**: normalized conversations, a durable incremental per-contact pass with a message-tuned call, reusing capture's validators, date rules and note-batch save/undo. Replaces `message-enrichment.ts` | B — feed chats through capture as synthetic notes (user-tier model, ~60 s per note, overflows on long chats, no incremental mode, re-creates stored interactions); C — upgrade the enrichment in place (finalize time limit, stays thin) |

## Goals

1. Every person you have a real conversation with gets a profile that says what they do, what
   you talk about, what is open between you, and what happens next.
2. Dates become reminders — but a two-year-old "let's grab coffee next week" never becomes an
   overdue reminder today.
3. Re-uploading an export processes only what is new.
4. Everything the engine writes can be undone as one batch, and never blocks undoing the import.
5. Cheap by construction on the user's own key: trivial threads skipped by rule, fast tier,
   Batch API for the long tail, a visible estimate before starting.

## Non-goals (v1)

- Email as a source. The `Conversation` shape leaves room for it; Gmail/Outlook bodies need
  their own privacy and restricted-scope work.
- Changing how LinkedIn messages are stored (one `interactions` row per message stays).
- Re-processing when an old message is edited or deleted.
- "They messaged you and you never replied" — Radar already reads unanswered inbound messages
  (`src/lib/radar/signals/internal.ts`); the engine does not duplicate it.
- Auto-creating contacts from group chats.
- Overwriting `contacts.title` / `contacts.company`.

## 1. Pipeline

```
upload: LinkedIn messages.csv | WhatsApp .txt/.zip | imessage-exporter .txt
  → parser → Conversation
  → resolve people
       1:1   → match existing contact, else create
       group → match existing only; the rest offered as "add as contact"
  → store as interactions
       LinkedIn: one row per message (unchanged)
       chat exports: one row per session, per matched person
  → touched contacts become pending (a predicate, not a flag)
  → relationship pass — durable background run, highest-value contacts first
       gather   : messages since the contact's watermark + previous digest
       skip     : rule-skip trivial threads (no AI call)
       extract  : relationship.digest (fast tier; Batch API for the tail)
       validate : verbatim excerpts, dates resolved in code, confidence floors
       apply    : profile writes + reminders through the note-batch save → one Undo per run
       advance the watermark
  → the contact brief regenerates from the digest
```

### Units

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/lib/conversations/types.ts` | `Conversation { source, isGroup, title, participants[], messages[{senderKey, direction, at, text}] }` and `ParticipantHint { displayName, phoneE164?, email?, isSelf }` | nothing |
| `src/lib/conversations/whatsapp.ts` | Parse a WhatsApp export (`.txt`, or `.zip` → `_chat.txt`) into a `Conversation` | types |
| `src/lib/conversations/imessage.ts` | Parse an `imessage-exporter` `.txt` into a `Conversation` | types |
| `src/lib/conversations/sessions.ts` | Group messages into sessions by time gap | types |
| `src/lib/import-adapters/whatsapp-chat.ts`, `imessage-chat.ts` | Import-engine adapters: identity, create/merge, `interactions()` per session, `finalize` marks + kicks the runner | conversations, import engine |
| `src/lib/relationship-engine/gather.ts` | Build one contact's input window from interactions past the watermark + digest | db |
| `src/lib/relationship-engine/extract.ts` | Prompt, output schema, the `relationship.digest` call | ai.ts, ai-security.ts |
| `src/lib/relationship-engine/validate.ts` | Excerpt containment, date resolution, confidence floors — wraps capture's validators | date-commitment-extract.ts, implied-next-steps.ts |
| `src/lib/relationship-engine/rules.ts` | Pure: validated output + now → writes / open threads / flags | drive-reminder-rules.ts helpers, note-batches.ts |
| `src/lib/relationship-engine/apply.ts` | The only writer: digest, key facts, action items, reminders, job change, watermark | note-batch-save.ts, job-changes.ts |
| `src/lib/relationship-engine/runner.ts` | Claim, lease, time budget, priority order, inline vs batch, continuation | time-budget.ts, ai-batch.ts |
| `src/app/api/relationships/run/route.ts` | Internal continuation route, `maxDuration = 300`, in `PUBLIC_ROUTES` | runner |

The LinkedIn messages adapter maps its rows into the same gather input, so the engine never
branches on source. `message-enrichment.ts` is deleted; the adapter's `finalize` keeps
`kickLinkedInTimelineBackfill` and replaces `enrichContactsFromMessagesBatched` with "kick the
relationship runner".

## 2. Parsers and identity

### WhatsApp

- WhatsApp exports one chat at a time, from the phone, as `.txt` or `.zip` (`_chat.txt` plus
  media). **Media is discarded in the browser and never uploaded.**
- Two line formats: iOS `[DD/MM/YYYY, HH:MM:SS] Name: text`, Android
  `DD/MM/YYYY, HH:MM - Name: text`; both vary by locale (12/24 h, `/` vs `.`, day/month order).
- Day/month order is decided **per file**: scan every date; any first field > 12 means
  day-first, any second field > 12 means month-first; if neither appears, fall back to the
  browser locale and mark the conversation `dateOrderGuessed` in the preview.
- Continuation lines (no timestamp prefix) append to the previous message.
- System lines ("Messages and calls are end-to-end encrypted", "X added Y", "<Media omitted>",
  "This message was deleted") are dropped.
- Senders are the names saved in the user's phone, or a raw number when unsaved. A raw number
  becomes `phoneE164`.
- **Which sender is you**: WhatsApp has no "Me" marker. The preview asks once per upload which
  name is the user, defaulting to the owner's name when it matches; the answer is remembered in
  `user_settings.chat_self_names` (text[]) for later uploads.
- More than two distinct senders → `isGroup`.

### iMessage

- Apple has no native export. v1 supports the open-source `imessage-exporter` CLI's `txt`
  output: one file per conversation, named by handle (`+15551234567.txt`,
  `name@example.com.txt`, or a group's participant list), sender `Me` for the user.
- The filename handle becomes `phoneE164` / `email` — a stronger match than WhatsApp's names.
- Group files (several handles) → `isGroup`.

### Identity

- Every person goes through `resolveOrCreateContact` and `identityKeysFor`
  (`src/lib/contact-identity.ts`); identities are never written anywhere else.
- **1:1:** an identifier match, or a name match at or above `DUPLICATE_MERGE_CONFIDENCE`
  (0.85), links automatically. Below that, the preview shows a picker (top candidates + "new
  contact"). A 1:1 conversation with no match creates the contact, dated from its first message.
- **Group:** the same matching per member, but an unmatched member is listed as "add as
  contact" and never created. Group messages are stored and analyzed only for matched members.
- The owner is filtered with capture's self rules (`isSelf`), so the user never becomes a contact.

### Sessions

Chat-export messages are stored as **sessions**, not one row per message — a 10,000-message
WhatsApp chat must not become 10,000 timeline rows and 10,000 tiny memory chunks.

- A session is a run of messages with no gap over 6 hours, capped at 200 messages or 12,000
  characters (split at the cap).
- One `interactions` row per session **per matched contact**: `interaction_type 'message'`,
  `source 'whatsapp' | 'imessage'`, `interaction_date` = first message, `raw_notes` = the
  transcript lines (`[HH:MM Name] text`), `ai_summary` = first 240 characters,
  `direction` = direction of the last message.
- `external_id = chat:<source>:<conversationKey>:<sessionStartEpoch>:<contactId>` — scoped
  per contact like the calendar formula, so a group session written for three members does not
  collide, and a re-upload of the same export upserts instead of duplicating.
- These rows feed memory chunks through the existing sweep unchanged.

## 3. Data model

Schema bump: the next free `SCHEMA_VERSION` — **147** as of today (main is 143; the unmerged
direct-email stack claims up to 146). Re-scan every ref **and** `git worktree list` before the
PR, per `src/db/index.ts`'s changelog. Both new tables need the DDL template and the version bump.

### New: `relationship_digests` — one row per contact

| Column | Type | Purpose |
|---|---|---|
| `contact_id` | uuid PK → contacts, cascade | |
| `user_id` | text not null | |
| `what_they_do` | text | One line from the conversations ("runs growth at Ramp, hiring PMs") |
| `working_on` | text | What they are building or looking for, if said |
| `summary` | text | The relationship narrative; rewritten each pass with the previous one as context |
| `topics` | jsonb `{label, lastDiscussedAt}[]` | "What you talk about" |
| `open_threads` | jsonb `{key, text, owedBy, sinceIso, interactionId, excerpt}[]` | Older open loops with no reminder; each promotable with one click |
| `message_count` | integer | For the profile's source line |
| `sources` | text[] | `linkedin`, `whatsapp`, `imessage` |
| `watermark_at` | timestamptz | Date of the last processed message |
| `watermark_interaction_id` | uuid | Tie-break at equal timestamps |
| `history_truncated_before` | timestamptz | Set when the first pass skipped older history (§5) |
| `attempts` | integer default 0 | Failed passes since the last success |
| `last_error` | text | |
| `input_hash` | text | sha256 of the prompt inputs; an identical window returns the stored digest |
| `model` | text | |
| `run_id` | uuid | The run that last wrote it |
| `updated_at` | timestamptz | |

**Pending is a predicate, not a flag** — the convention `PENDING_TIMELINE_CONTACTS` set: a
contact is pending when it has a message interaction (`linkedin_message`, or `message` from a
chat source) whose `(interaction_date, id)` is after its watermark, or it has messages and no
digest, and `attempts < 3`. Nothing can drift out of sync with the data it describes.

### New: `relationship_runs` — one row per engine run

`id`, `user_id`, `import_id` (nullable — the import that started it), `status`
(`queued | running | waiting_key | done | failed | undone`), `claim_token`, `lease_until`,
`processed`, `skipped`, `failed`, `reminders_created`, `facts_added`, `open_threads_added`,
`flags` (jsonb, §4), `note_batch_id`, `batch_job_ids` (uuid[]), `created_at`, `finished_at`.

A run is its own row rather than a column on `imports`, so several uploads in quick succession
fold into one run. **One active run per user**: a new trigger while a run is active does
nothing — the newly pending contacts are picked up by that run's next loop.

### Changed

- **`note_batches.entry_point`** gains `'relationship'`. Each run writes one batch
  (`source_text` = the run's label, `source_hash` = `relationship:<runId>`,
  `anchor_basis 'upload'`) so capture's `undoNoteBatchForUser` undoes a run unchanged.
- **`action_items.owed_by`** — new nullable text, `'me' | 'them'`. Null on existing rows and on
  capture items until capture starts writing it (capture already extracts `promises[].direction`;
  wiring it is a one-line follow-up, not in scope).
- **`user_settings.relationship_engine_enabled`** — integer default 1 (house convention).
- **`user_settings.chat_self_names`** — text[] default `{}`.

### Reused without schema change

- `reminders`: `created_by 'ai'`, `origin 'explicit' | 'implied'`, `source_excerpt`,
  `raw_date_phrase`, `date_basis`, `confidence_score`, `note_batch_id`, `source_interaction_id`,
  `item_hash`, `action_item_id`.
- `contacts.key_facts`: deduplicated facts appended (case- and whitespace-insensitive). The
  `"Open: …"` strings are no longer written; existing ones are left alone.
- `contacts.title` / `company`: filled **only when empty**.
- `contact_career_moves` via `src/lib/job-changes.ts`: a self-stated job change from a message in
  the last 90 days is recorded through the existing path (title/company update, `job_change`
  interaction, congrats suggestion if the role started ≤ 6 months ago).
- `contacts.next_follow_up_at`: set to the earliest open reminder the run created, if earlier
  than the current value.
- `contacts.ai_summary`: **not written by the engine.** `generateAndStoreContactBrief` reads the
  digest (`what_they_do`, `summary`, `topics`, `open_threads`) in place of raw messages for
  message-heavy contacts — today it reads the 20 most recent interactions, which for a LinkedIn
  contact are 20 individual messages.

### Housekeeping

- Both new tables join `purgeUserData` (and `smoke-purge` gets a fixture row for each).
- `mergeContacts` repoints `relationship_digests.contact_id` inside its atomic write. If both
  sides have a digest, the winner keeps its row, the loser's is deleted, and the winner's
  watermark is cleared — the next pass re-reads the merged history.
- Import undo (`src/lib/imports/import-undo.ts`): reminders, action items and interactions whose
  `note_batch_id` belongs to a relationship run started by that import are counted as the
  import's **own writes**, not user touches — otherwise every analyzed person becomes
  un-undoable. Undoing the import also undoes the run's batch.

## 4. Extraction and write rules

### The call: `relationship.digest`

Registered in `src/lib/ai-operations.ts` as `{ tier: "fast", thinking: "minimal", background: true }`,
with a matching price check in `ai-pricing.ts`.

**Input window, per contact:**

- The previous digest (summary, topics, open threads with their keys) — model-written, so fenced.
- The new messages, one per line, `[2024-03-12 Me] …` / `[2024-03-12 Maya] …`, wrapped in
  `fenceUntrusted`. In group sessions every speaker's lines stay for context; the prompt says to
  attribute only what the target person said, or what was promised to or by them.
- The contact's name, and the owner's name for "Me".
- About 20,000 characters per call. See §5 for long histories.

**Output schema** (zod, parsed with `parseAiJson`):

```
what_they_do:  string | null
working_on:    string | null
job_change:    { company, title, excerpt } | null      // only if the person states it
summary:       string                                  // ≤ 3 sentences
topics:        string[]
facts:         { text, excerpt }[]
commitments:   { text, owed_by: "me"|"them", raw_date_phrase: string|null,
                 message_date, excerpt, confidence }[]
implied:       { text, owed_by: "me"|"them"|null, message_date, excerpt, confidence }[]
closed:        { open_thread_key, excerpt }[]          // earlier loops now resolved
```

### Validation (`validate.ts`)

- Every `excerpt` must be contained verbatim (whitespace-normalized) in the window, or the item
  is dropped. Same rule as capture.
- Dated commitments go through `validateCommitments` (`src/lib/date-commitment-extract.ts`).
  **A relative phrase resolves against the date of the message it appeared in, not today.**
  "Next Tuesday" said on 2024-03-12 is 2024-03-19. The year is never taken from the model.
- `implied` items must clear `IMPLIED_MIN_CONFIDENCE` (0.6, `src/lib/implied-next-steps.ts`).
- `closed[].open_thread_key` must name a thread that exists on the digest.
- `job_change` must have an excerpt from a message sent by the contact.

### Write rules (`rules.ts`, pure)

"Recent" = the message is within the last **45 days**. Helpers shared with
`drive-reminder-rules.ts` (explicit-date test, flag shape) rather than copied.

| Found | Outcome |
|---|---|
| Stated date resolved into the future | **Action item** (`owed_by`) + **reminder** on that date. A `them` item's reminder is a check-in the day after ("Check Maya sent the deck"). |
| Stated date passed within the last **14 days**, confidence ≥ **85** | **Flag** on the run (`relationship_runs.flags`), one click to make a reminder. Nothing written. |
| Undated commitment or implied follow-up from a **recent** message | **Action item** (`owed_by`) + **reminder**, due at `windowDueDate(messageDate, FOLLOW_UP_DAYS_BY_CLOSENESS[tier])`, never earlier than tomorrow |
| Anything older, still unresolved | **Open thread** on the digest. No reminder, no action item. |
| `closed[]` | The thread is removed from `open_threads`; a matching open action item is marked done; its reminder is marked done |
| `facts`, `what_they_do`, `working_on`, `topics`, `summary` | Written to the digest / `key_facts` directly. No date gating. |
| `job_change` (message ≤ 90 days old) | Through `job-changes.ts` (§3) |

**Guards**

- At most **3 reminders per contact per run** and **25 per run**. Overflow becomes open threads,
  and the run summary says how many.
- Reminders and action items dedupe on `item_hash`, so anything the user dismissed is never
  recreated — the dismissed row keeps blocking, as in capture.
- Apply is idempotent: re-applying the same validated output writes nothing new.

## 5. Execution and cost

### Runner

- **Trigger:** a LinkedIn messages, WhatsApp or iMessage import's `finalize` kicks
  `/api/relationships/run` (fire-and-forget fetch, like the timeline backfill) — never inline.
- **Claim:** take or create the user's active run with a `claim_token` and a 5-minute
  `lease_until`; a concurrent kick that finds a live lease exits.
- **Loop:** under `deadlineAfter(270_000)`, select pending contacts in priority order
  (latest message date desc, then message count desc, then closeness tier), process, and
  re-kick the route before the budget runs out.
- **Stalls:** `process-stalled` (hourly, already sweeping imports, capture jobs and batches)
  resumes runs whose lease expired.
- **Disabled:** if `relationship_engine_enabled = 0`, imports store messages and no run starts.
  Re-enabling starts a run over everything pending.

### Inline vs batch

- The **first 25 pending contacts of a run go inline**, so the people you talk to most fill in
  within minutes.
- The rest are submitted through `submitAiBatch` (groups of ≤ `MAX_BATCH_REQUESTS` = 100) at
  half price, with a new `relationship.digest` applier in `ai-batch-apply.ts`. Results land
  within hours, through the same `validate → rules → apply` path.
- A provider without batch support, or a failed or expired batch, hands the work back to the
  inline path — the existing applier contract.

### Long histories

- A window is about 20,000 characters. A first-time backlog larger than that is processed
  oldest-to-newest in chunks, the watermark advancing after each, with the previous chunk's
  digest as context.
- At most **3 chunks per contact per run**. When a backlog needs more, the engine starts from
  the newest 3 chunks' worth, records `history_truncated_before`, and the run summary says
  "older history not read for N people". Old history matters least to what is open now.

### Skipping

- Rule skip, no AI call: a window with fewer than 3 messages **and** under 200 characters of
  text, or only connection pleasantries (a small phrase list: "thanks for connecting", "nice to
  meet you", …). The watermark advances; the contact counts as skipped.
- The existing decision-model skip gate pattern (`import.enrich.gate`) can sit in front later as
  `relationship.digest.gate`, shipped off (null threshold) until measured.

### Keys and spend

- Managed AI is off, so the engine always runs on the user's key through `resolveAiAccess`.
- No key → the run goes `waiting_key`. Contacts stay pending (it is a predicate, so nothing is
  lost) and the summary says "Add an AI key to analyze 312 conversations". Saving a key kicks
  the runner.
- Key-level errors (invalid, quota, out of credit) pause the run as `waiting_key` instead of
  spending a contact's attempts. Per-contact errors increment `attempts` and set `last_error`;
  after 3 the contact is skipped and listed.
- Spend is recorded under `relationship.digest` in `usage_events` like every operation.
- **The import preview shows an estimate**: characters → tokens × the fast-tier price in
  `ai-pricing.ts`, discounted for the batched share — e.g. "Analyzing ~4,800 messages ≈ $0.40 on
  your Gemini key".
- A run never fails the import that started it.

## 6. UI

### Upload (`/imports`)

- The existing drop zone and queue recognize WhatsApp `.txt` / `.zip` and imessage-exporter
  `.txt` by content, not just extension. Multiple files can be dropped at once.
- Parsing happens in the browser; conversations are staged to the server in chunks through the
  import engine's existing staging, so neither the 4.5 MB function body limit nor the proxy's
  body truncation is reached.
- **Preview**, one row per conversation:
  - 1:1 or group, message count, date span, and a "dates guessed" note if day/month order was
    ambiguous.
  - **Who it is**: auto-linked when confident; a picker (candidates + "new contact") otherwise.
  - **Which sender is you** (WhatsApp only, once per upload, remembered).
  - For groups: matched members, and unmatched ones with "add as contact".
  - The cost estimate, and Start.

### Run summary

In the import's detail sheet, plus a bell notice when the run finishes:

- "Analyzed 184 people · 9 reminders · 31 open threads · 12 skipped (too short)".
- The reminders created, with **Undo all** (the run's note batch).
- Flags for just-passed dates, one click each.
- Failures, skips, overflow past the caps, and "older history not read".
- While running: progress ("Analyzing 25 of 184 — the rest within a few hours").

### Profile (existing components, no new page)

- **Brief card** (`contact-brief-card.tsx`): a **what they do** line, the summary, **topic
  chips** with "last discussed …", and a source line — "From 214 WhatsApp messages · updated
  Sep 30".
- **Next steps** (`contact-next-steps.tsx`): action items get a **You owe** / **They owe** badge
  from `owed_by`.
- **Open threads**: a collapsed list under next steps; each shows its quote and date, with
  **Remind me** (creates a reminder in the run's batch) and **Dismiss** (removes it).
- **Timeline** (`contact-timeline.tsx`): chat sessions render in the existing `written` family
  with a WhatsApp / iMessage source icon, expandable to the transcript.
- **Settings → AI**: the "Relationship analysis" switch.

## 7. Privacy and release

Storing WhatsApp and iMessage content is a **new data category**. `/privacy` must disclose it,
and editing `/privacy` trips the legal lock and forces a `TERMS_VERSION` bump (every user
re-consents). **Decision owed by Jason:** fold the disclosure into pricing v2's (#370) legal
update, alongside Outlook send. Until it ships, the WhatsApp and iMessage adapters ship dark
behind a new `feature.chat-imports` surface; the engine itself (LinkedIn messages, already
disclosed) ships live.

## 8. Testing

### Smokes (PGlite, registered in the smoke manifest)

- `smoke-chat-parsers`: iOS and Android WhatsApp formats; day-first, month-first and ambiguous
  files; 12/24 h; multi-line messages; system lines; `.zip` extraction; imessage-exporter handles,
  `Me`, groups; self-name selection.
- `smoke-chat-sessions`: gap splitting, size caps, per-contact `external_id`, re-upload upserts.
- `smoke-relationship-rules`: table-driven `rules.ts` cases — dates anchored to old messages,
  the 45 / 14-day boundaries, the 3 / 25 caps, `them` check-ins, `closed[]`.
- `smoke-relationship-apply`: idempotent re-apply; dismissed items never recreated; key-fact
  dedupe; title/company only when empty; `next_follow_up_at`.
- `smoke-relationship-runner`: claim/lease, one run per user, continuation, `waiting_key`,
  attempts, priority order, inline/batch split with stubbed providers, the batch applier.
- Undo: run batch undo; import undo still removes analyzed people (`ownWrites`); merge moves
  the digest; `smoke-purge` covers both tables.
- `smoke-ai-access` / `smoke-provider-exhaustive` stay green (no new SDK use outside the gate;
  new ai.ts code appended at the end of the file).

### Eval (gate for the fast tier)

A `relationship` task in `scripts/eval-ai.ts` with about 20 synthetic fixtures (LinkedIn,
WhatsApp 1:1, WhatsApp group, iMessage): relative dates in old messages, `you owe` vs `they
owe`, loops resolved later in the window, job changes, and pleasantry-only threads that must
produce nothing. Gated on fact recall, commitment precision and recall, exact date accuracy,
and zero invented items. Per the #231 rule, the fast tier ships only once a baseline is recorded
— which needs a paid Gemini key.

### Browser

A pass on the local demo workspace with seeded sample exports (one of each source, one group):
upload preview, run summary, Undo all, profile surfaces, open-thread promotion.

## Open items

1. **Privacy / TERMS_VERSION** (§7) — Jason's call on folding into #370.
2. **Eval baseline** — needs a paid Gemini key.
3. Wiring capture's `promises[].direction` into `action_items.owed_by` — follow-up, out of scope.
