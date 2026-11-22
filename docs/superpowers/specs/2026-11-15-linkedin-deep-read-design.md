# LinkedIn deep read: design

Date: 2026-11-15. Status: awaiting Jason's approval. Schema at time of writing: 246.

## Intent

One LinkedIn export should leave Orbit knowing four things, and using them:

1. **You**: your full work and school history, not just your current role.
2. **Each person**: when and how you really met, what kind of relationship it is, what they do.
3. **What you talk about**: topics, plus a dated log of what happened between you.
4. **Who is closest**: ranked from real evidence in the export.

Why: Jason wants Orbit to "learn as much as possible" from the export and use it as context
for suggestions, drafts, chat and Cosmo. Today most of it is read once and used in two places.

## What exists today (verified in code)

- **Relationship engine** (`src/lib/relationship-engine/`): one model call per contact
  conversation. Returns summary, what they do, working on, topics, facts, commitments. Every
  item needs an excerpt copied from one message or it is dropped (`validate.ts`). Written with
  no review, one Undo per run. Stored in `relationship_digests`.
- **"Date met" is the LinkedIn Connected On date**; "how met" is the literal label
  "LinkedIn connection" (`import-adapters/linkedin-connections.ts:40-43`). Both are fill-only
  on merge (`contact-writes.ts:1241-1243`), with no record of who wrote them.
- **Long threads lose their start**: a backlog over 3 windows (60k chars) or 2,000 rows is cut
  from the old end (`gather.ts:47-53`).
- **Invitation notes, your LinkedIn notes and recommendations** are saved as `interactions`
  rows (source `linkedin_export`, no `direction`) that the engine never reads.
- **A second, older reader** (`linkedin-timeline-backfill.ts`, operation
  `import.linkedin.timeline`) makes its own AI call per contact to log `reach_out` / `meeting`
  / `in_person` rows (source `ai_derived`, external id `li-event:<contactId>:<type>:<hash>`).
- **About you**: only the current Title + Company from Positions.csv, and school names from
  Education.csv (`linkedin-you.ts:65-67,104-108`). Past jobs, all dates and degrees are dropped.
- **Closeness** (`closeness.ts`, `closeness-evidence.ts`, `closeness-cohort.ts`): evidence is
  a stated rating, touch count and mail/calendar coverage. Message direction is aggregated but
  not scored. The cohort builder's own comment: "Orbit stores no company or school for the
  user themselves".
- **Digest readers**: contact brief, meeting talking points, work-history gates, Radar open
  threads. Not chat, not the `get_contact` / `get_dossier` tools (so not Cosmo), not drafts,
  not Radar's why/editor prompts.
- **/privacy is out of date** for this area ("a short summary for up to 40 of the people you
  talked with most", `privacy/page.tsx:597-605`).

## Goals

- Real first-met date and how-you-met on a contact when the messages say it, with the quote.
- A relationship kind per person, with the quote.
- One dated event log per person from one AI call (the old reader retired).
- Your full history stored, and "you overlapped at X, 2021 to 2023" computed from it.
- Closeness that counts LinkedIn evidence.
- All of it reaching chat, Cosmo, drafts and Radar.

## Non-goals

- Reading Reactions, Comments or anything about strangers' posts (legal.ts already promises
  those never leave the browser). Company Follows stay stored and unused (settled earlier).
- Creating contacts from messages. Releasing WhatsApp / iMessage imports (they stay dark, and
  get the same upgrades for free because they share the engine).
- New pages. Manual editing of relationship kind beyond "remove".

## Anti-goals

- Stating anything about a person that their messages do not say.
- Overwriting something the user typed.
- A second AI call per person. More than one re-consent prompt for the whole project.
- Old messages producing overdue reminders (existing rule, unchanged).

## Approaches

- **A. Deepen the existing reader, count the rest without AI.** Picked. Reuses the engine's
  proof rule, Undo, batching and eval. Costs a one-time re-read for existing users.
- **B. A whole-network AI pass on top of A** (circles, closest people with reasons, your
  story). Picked as a follow-on after A ships; it reads A's output, so it cannot come first.
  It gets its own short design once A is live. Outline at the end.
- **C. Keep raw messages searchable, look up on demand.** Rejected: nothing is ever "known",
  so no met date, no event log, no ranking.

## Design (A), in shipping order

All five PRs sit behind a new surface key `feature.linkedin-deep-read` (pattern:
`src/lib/surfaces.ts:264-274`), dark for everyone until PR 5. The gate is checked on the
server, per user, and it covers everything that changes what Orbit reads, infers or stores:
the new file parsers, the new prompt outputs, the new writes and the new closeness inputs.
With the gate off a user gets exactly today's behaviour, including the old timeline reader.
With it on, the old reader is no longer kicked for that user. Before launch it is on for admins
(by user id, `deepReadOn` in `src/lib/deep-read.ts`), so it works in background jobs, which
have no browser cookie, and Jason's own export can be measured before launch.

### PR 1: Your history (no AI, no DDL)

- Positions.csv: keep every row: title, company, started, finished, location, and description
  capped. Education.csv: school, degree, start, end.
- Store as new keys `career_profile.positions[]` and `career_profile.education[]`.
  `career_profile.role` and `user_settings.schools` keep working as they do now.
- Languages.csv / Courses.csv: dropped (Nov 16). Jason's real export has neither file, so
  their columns cannot be checked and they add little.
- Education.csv has no field-of-study column; the degree name is kept as LinkedIn writes it.
- New pure function: overlap between your history and a contact's `contact_experiences`
  (fallback `contacts.company` / `contacts.school`), returning org + years. Computed on read,
  not stored.
- "Remove imported details" in Settings must clear the new keys.
- Review: on a new upload, the history joins the existing tick-to-approve list for your own
  details, ticked by default: one item on the Positions file ("Work history") and one on the
  Education file ("Degrees and dates"), because the review is per file.

### PR 2: Reader upgrade (DDL: two jsonb columns on `relationship_digests`)

Same single model call, three new outputs, each needing an excerpt like everything else:

- `origin`: how you met in one line, a date with precision (day / month / year), and a
  context picked from the six values `met_context` already uses (event, introduction, work,
  school, online, other). Dropped if the date is later than the message that states it.
- `relationship`: one of coworker, classmate, friend, family, mentor, mentee, recruiter,
  client, investor, collaborator, acquaintance.
- `events`: dated things that happened (met up, call, intro made, favour done). They map onto
  the existing interaction types (`meeting`, `in_person`, `call`); anything that does not fit
  becomes a fact, not a new type. Written as `ai_derived` rows with external id
  `li-event:<contactId>:<type>:<YYYY-MM-DD>`. The old reader's ids hash the model's own
  wording, so ids alone cannot prevent repeats: before inserting, skip any event when an
  `ai_derived` row of the same type already exists for that contact on that day. No old rows
  are deleted or migrated.

Reading changes:

- **Read the start.** On a contact's first pass, when the backlog must be cut, keep the
  opening stretch and the newest stretch and cut the middle, with one line in the window
  saying what was skipped. `history_truncated_before` keeps its meaning.
- **Read the signals.** Invitation notes, your LinkedIn notes and recommendations join the
  window in date order. Who said each one is read from the row's existing `external_id`
  (`li-export:invitation_sent:…` and so on), so rows imported before this PR need no backfill.
- **Which signals earn a read on their own.** An invitation note or a recommendation with
  text makes a contact pending even with no message thread (widen `MESSAGE_INTERACTION_SQL`,
  which the claim, count, cron sweep and Undo sweep all share). The existing trivial-thread
  rule still skips "thanks for connecting". Your own LinkedIn notes are context only: they
  are read when the contact is read for another reason, never a trigger.
- The prompt is also given the PR 1 overlap as known context ("both at Acme 2021 to 2023"),
  fenced like the rest.

Writing rules:

- The digest stores `origin` and `relationship` with excerpt and interaction id.
- `contacts.how_met` / `date_met` / `met_context` are replaced only when the user has not set
  them. From this PR on, the contact form stamps those fields in `field_sources` as `user`.
  For rows with no stamp, "not set by the user" means `how_met` is blank or one of the import
  labels (one shared constant for the adapters and this rule).
- The replaced values are kept inside `origin`, and Undo for the run restores them. Facts keep
  today's behaviour (they stay after Undo).
- `contacts.date_met` is a full timestamp that many readers show as a day, so it is written
  only for a day-precision origin. A month or year origin stays on the digest, and the contact
  page and the PR 4 helper show it as "Sep 2022" or "2022". `how_met` and `met_context` are
  written at any precision.
- `first_interaction_at` widens through the existing LEAST rule, using the end of the stated
  period for a month origin and not at all for a year origin.
- Relationship kind has a one-click remove that sticks (a removed kind is not set again).

Retiring the old reader:

- Stop kicking `kickLinkedInTimelineBackfill` (messages adapter, process-stalled, admin
  refresh). Its rule-based `reach_out` for the earliest message moves into the engine's apply
  step, so one-message threads still get it with no AI call.
- Keep its batch-apply path for one release so in-flight batches land, then delete the reader,
  its gate and its daily cap in a follow-up.

Eval: extend the `relationship` eval fixture with origin, kind and event cases, and record a
baseline before and after the prompt change.

### PR 3: Closeness from LinkedIn evidence (no AI, no DDL expected)

Endorsements are not read (decided Nov 16): Jason's export has no endorsement files, so their
columns cannot be checked. Recommendations carry that weight instead. Built as `depth`
(both sides wrote 0.35, years in touch 0.35, a recommendation 0.3) at weight 0.23, and real
overlap in the prior at 0.2 / 0.1; see `src/lib/closeness-depth.ts`.

New counted inputs to the cohort builder:

- both sides wrote (direction is already aggregated at `closeness-cohort.ts:97-116`)
- number of distinct years with an exchange
- a recommendation written either way
- real overlap with your own employers and schools, replacing the orbit-relative
  company/school concentration guess where your history is known

Constraints: a stated rating still outweighs everything; ring quotas and the evidence floor
keep their meaning; AI output (relationship kind) is not an input. Exact weights are the
builder's, checked against the closeness smokes and Jason's own export.

### PR 4: Use it

- One helper that renders a compact relationship block for a set of contacts: origin, kind,
  summary, topics, working on, open threads, overlap.
- Wire it into: chat focus (`renderFocusRelationship`, chat-context.ts:646), the `get_contact`
  and `get_dossier` tools (this covers Cosmo), drafts (`loadContactContext` /
  `buildProfileBlock`, follow-up-drafts.ts:127,174), and Radar's why and editor prompts.
- About you: past positions and education join `renderAboutUser` and voice `aboutTheUser`.
- Contact page, in the existing overview:

```
Maya Chen                                  [Classmate]
Met Sep 2022 at HackNC, introduced by Priya
  From your messages: "so good meeting you at HackNC!"   Not right?
Connected on LinkedIn Oct 3, 2022
You overlapped: UNC Chapel Hill, 2021 to 2025
```

### PR 5: Launch

- Rewrite the LinkedIn paragraphs of /privacy to describe what is read, kept and written, and
  bump `TERMS_VERSION` once.
- Turn the surface on.
- Existing users, first: re-run the export apply from the kept files (only an export uploaded
  whole is kept), so your history, endorsements and signal direction exist for people who
  imported before launch. Someone who already applied "From your LinkedIn export" gets the
  history with no new review step; anyone else is offered it in Settings.
- Existing users, second: a one-time origin pass over every contact that has a digest and no
  origin check yet, which includes anyone imported while the feature was dark. It sends
  only the opening stretch and the signals, applies only origin, kind and events, and does not
  move the watermark (moving or clearing it would trigger a full paid re-read). It runs
  through the provider batch path and the existing cron backstop.
- Before launch, measure on Jason's own export: tokens and cost per 1,000 conversations for a
  first read and for the origin pass, and put the numbers in the PR.

## Constraints

- AI only through `ai-access.ts` / `completeJson`. No new route or `maxDuration` value (the
  Vercel function cap is full); reuse `/api/relationships/run`.
- DDL goes through `reconcileSchema` with a new version (re-scan open branches for the next
  free number above 246) and `scripts/schema-ddl.lock.json` updated.
- Model text that is stored and re-read stays single-line, capped and fenced, as today.
- Every new smoke is registered in the manifest.
- Column names of the endorsement, languages and courses files must be checked against a real
  export before the parsers are written.

## Checked against a real export (Nov 16, Jason's own, headers and counts only)

- Positions.csv and Education.csv headers match the parsers. All 18 roles parse with a
  "Mmm YYYY" start; 11 have no end (current). Education dates are mostly blank (1 of 6
  schools has them) and use "Mmm YYYY", not a bare year. Expect school overlap without years
  most of the time.
- Not in this export: Endorsement_Received_Info.csv, Endorsement_Given_Info.csv,
  Recommendations_Given.csv, Languages.csv, Courses.csv. PR 3 must not depend on
  endorsements or given recommendations to rank anyone.
- In this export and unused so far: Events.csv (`Event Name, Event Time, Status,
  External Url`), the LinkedIn events you went to. Not used in PR 2 (decided Nov 16): the
  export has two events and their dates are ranges, so a parser is not worth it yet. Learning.csv
  (LinkedIn Learning videos) and Rich_Media.csv stay unread.

## Left to the builder

Window sizes for the opening stretch, caps on description text, closeness weights, the exact
prompt wording, how the PRs split into commits, and the wording of the "Not right?" control.

## B, later (outline only)

After a run finishes, one AI step reads the per-person digests, the counted closeness and your
history, and writes a network picture kept on the user's settings: your circles (who is in
each and why), your closest people with a one-line reason each, and a short account of your
own path. Every person it names must be a contact id from its input. It feeds chat, Cosmo and
a "Closest people" list. It gets its own design once A is live, because what A actually learns
decides what B can say.

## Calls made here that Jason has not confirmed

- The eleven relationship kinds.
- Replacing "date met" with the real date (Connected On stays visible as its own line).
- Undo restores met date and how-met, but leaves facts (today's behaviour).
- AI-read relationship kind does not feed closeness in A.
- Everything dark until one launch PR, to keep re-consent to a single prompt.
- The existing-user pass runs automatically, not on a button.
- An invitation note or recommendation alone is enough for an AI read; your own notes and
  endorsements are not.
- A month or year "met" date is shown as such and never written into the day-level
  "date met" field.
- Your work and school history is one pre-ticked item in the existing review list, and is
  applied without a new review for people who already imported their own details.
- Repeat events are avoided by matching type and day; old timeline rows are left alone.
- Endorsements are read in PR 3, not PR 1 (found while planning: a saved endorsement would
  count as a touch).
