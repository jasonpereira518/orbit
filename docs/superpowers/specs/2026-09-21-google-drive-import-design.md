# Google Drive import — design

**Status:** design approved in conversation, Sep 21 2026. Implemented on `claude/google-drive-import`.
**Builds on:** the `/imports` redesign (PR #238) — drop hero, sequential queue, import history + detail sheet.

## What it is

A third button on the `/imports` drop hero, beside **Choose files** and **Choose a folder**:
**Choose from Google Drive**. The person picks Docs and Slides in Google's own file picker,
Orbit suggests which ones look like notes, and the ones they keep are read and run through the
same extraction `/capture` uses: people, one logged meeting per doc, and — under stricter rules
than capture — reminders.

## Settled decisions

| Question | Decision |
|---|---|
| How much of Drive can Orbit see? | **Only the files the person picks.** Scope `drive.file` + Google Picker. Non-sensitive, so no CASA / restricted-scope assessment. Scanning the whole Drive for suggestions needs `drive.readonly` (restricted) and is **later**, not this. |
| Where it lives in the engine | **A new import type**, `drive_docs`, on the staged import engine, with its own processor (the Gmail recruiter scan pattern). Not an `ImportAdapter` — adapters are pure, and each row here is a network fetch plus a multi-call AI parse. |
| How "looks like notes" is judged | **Filename and metadata only** — free, instant, no AI before the person has chosen anything. Weak on "Untitled document"; accepted. |
| What gets written | **Everything capture produces** — people, the logged meeting, reminders — with **stricter reminder rules** (below). |
| File types | **Google Docs and Google Slides only.** Sheets, PDFs, Word files are out. |
| Picker token | A short-lived access token minted server-side from the stored Google grant and handed to the Picker in the browser. **The first time a Google token reaches the client in this codebase** — accepted: it is the user's own token, `drive.file` + identity only, never stored client-side. |

## 1. Connecting

- Add a `drive` purpose to `GOOGLE_PURPOSES` in `src/lib/google-scopes.ts`, scope
  `https://www.googleapis.com/auth/drive.file`.
- Reuses the existing `gmail_connections` row via incremental consent, exactly like calendar.
  No new table, no new redirect URI (`/api/gmail/callback`).
- The privacy page's scope table reads from the same module and updates itself.
- `smoke-google-scopes` gains the new purpose.

## 2. Picking

- Client loads the Picker (`apis.google.com/js/api.js` → `gapi.load("picker")`) lazily, only
  when the button is pressed.
- A server action `getDrivePickerToken()` returns `{ ok: true; accessToken }` from
  `getValidAccessToken`, or `{ ok: false; reason; error? }` with `reason` one of
  `"needs_consent"`, `"needs_reconnect"`, `"not_connected"`, `"error"` — distinct enough that
  the three consent-shaped reasons all route to the same incremental-consent OAuth and only
  `"error"` shows a toast. With no Drive grant, the button starts that OAuth first and comes
  back to `/imports`.
- Picker config: `DocsView` filtered to `application/vnd.google-apps.document` and
  `…presentation`, multi-select on, `setAppId(NEXT_PUBLIC_GOOGLE_APP_ID)` (must be the same GCP
  project as the OAuth client, or `drive.file` grants nothing), `setDeveloperKey(NEXT_PUBLIC_GOOGLE_PICKER_API_KEY)`.
- **Both env vars are optional.** Unset → the Drive button is not rendered. They must not join
  the prod env gate in `env.ts`, which blocks every deploy on a missing required var.
- CSP (`security-headers.ts`): `apis.google.com` in `script-src`, `docs.google.com` and
  `drive.google.com` in `frame-src`.
- Picker results carry id, name, mimeType, lastEditedUtc, and owner — that is all triage reads.

## 3. Triage — `src/lib/imports/drive-triage.ts` (pure)

`triageDriveFile(meta, now) → { likely: boolean; why: string }`.

Signals, all from metadata:
- Name patterns: `1:1`, `1on1`, `one-on-one`, `notes`, `meeting`, `sync`, `standup`, `call`,
  `debrief`, `retro`, `interview`, `catch up`, `coffee`, `intro`, a person-like `X / Y` or
  `X <> Y`, a date in the name.
- Negative patterns: `template`, `resume`/`CV`, `invoice`, `budget`, `roadmap`, `spec`, `PRD`,
  `deck` (Slides named like a pitch).
- Recency: edited in the last 12 months nudges up.
- "Untitled document" → not pre-selected, `why` says the name gives nothing to go on.

`likely` rows are pre-selected; `why` is one clause shown on the row ("Named like meeting
notes", "Looks like a template"). Pure-tier smoke with a table of real-world file names.

## 4. The import type and processor

- `src/lib/drive-import-type.ts`: `DRIVE_IMPORT_TYPE = "drive_docs"` (mirrors `gmail-scan-type.ts`).
  Alone in an import-free module, same reason as `gmail-scan-type.ts`: `import-job-dispatch.ts`
  reads it at module scope in a cycle with the processors.
- **Confirm** (`startDriveImport(files)`) creates the `imports` row and stages one
  `import_job_rows` row per file: `{ kind: "drive_file", fileId, name, mimeType, modifiedTime }`.
  Cheap — nothing is fetched yet. `ImportJobRowPayload` gains that variant (types only). It
  returns an `ActionResult<{ importId; totalRows }>` rather than throwing — a message thrown
  across a `"use server"` boundary is replaced by an opaque digest in production, so a
  `UserFacingError`'s own sentence only survives the trip as data. The client-side runner
  unwraps it and re-throws locally so the rest of the import UI sees the same errors as every
  other kind.
- **`runDriveImportJob`** in `src/lib/drive-import-processor.ts`:
  - small chunk (~4 rows; each is a fetch + a ~60 s parse), wall-clock budget,
    `scheduleContinuation` through `/api/imports/[id]/continue`. A row never starts with under
    90 s of the function's 300 s ceiling left — a read-plus-parse that started with less could
    run past the limit mid-write; progress is saved after every row rather than per chunk, and
    a row already marked finished is never overwritten, so a resumed run can't redo (or
    re-charge AI for) a doc it already read;
  - registered in `RESUMABLE_IMPORT_TYPES` and the `runImportJobById` dispatch, so the
    process-stalled cron and admin retry pick it up.
- Per row:
  1. `files.export(fileId, "text/plain")` — works for both Docs and Slides. Empty text →
     row `skipped` ("Nothing written in this one").
  2. **Already-imported check**, before spending an AI call: hash the exported text and look
     for an earlier *finished Drive row* carrying the same hash. Only a Drive row counts — a
     matching note batch saved through `/capture` from the same text is not recognised, since
     the two paths don't share a dedupe key. A hash match skips straight to "Already brought
     in — unchanged since" with no new interaction; an edited doc hashes differently and is
     treated as new.
  3. `runCaptureParse(userId, text, hints)` with **the doc's `modifiedTime` day as
     `hints.eventDate`** (not a new `"upload"` anchor basis — `runCaptureParse` already
     supports a date hint, and the resulting `anchorBasis` is `"hint"`). Without this, "next
     Tuesday" in a 2024 doc resolves against today.
  4. Write people, one interaction, and reminders through the same primitives capture uses —
     `saveNoteBatch`, the same call `/capture` makes. Its own dedupe key
     (`notes:<sourceHash>:<contactId>`) is what makes step 2's hash check correct: identical
     text never double-logs even without it.
- **Re-import dedupe rides capture's own key**, not a new `drive:<fileId>:<contactId>` external
  id — the hash check above is what recognises "the same doc, unchanged" before parsing even
  runs.
- **Extra people per doc ride the row payload** (`payload.contactIds`), not extra rows —
  `import-people.ts` unions `contact_id` with `payload->'contactIds'`, so the detail sheet's
  people list covers everyone the doc named and "Rows" still counts docs, not people.
- `import_type` is a text column and `stats` is jsonb — **no DDL, no `SCHEMA_VERSION` bump.**
- Requires an AI key (`ai-access.ts`). Without one, the button explains that instead of
  starting.
- Cap: **25 files per import.**

## 5. What gets written

- **People** — through the duplicate index, so a person already in Orbit is merged, not
  duplicated. They show up in the detail sheet's Added / Already in Orbit lists for free, since
  that list reads `import_job_rows.contact_id` (one row per doc; the sheet de-dupes per person).
  One doc usually names several people but a row holds one `contact_id`, so the processor
  records the first on the doc's row and inserts one extra `done` row per additional person
  (same `fileId` in the payload, `rowIndex` past the staged range). The people list then works
  unchanged; the rows count reports docs, not rows, for `drive_docs`.
- **Interaction** — one per person per doc, type `meeting`, dated from the parse (falling back to
  `modifiedTime`), saved through `saveNoteBatch` under its own key
  (`notes:<sourceHash>:<contactId>`) rather than a new `drive:<fileId>:<contactId>` external id
  — see §4. Re-importing an unchanged doc is caught before this by the hash check; an edited
  doc saves a new batch.
- **Reminders — stricter than capture:**
  1. **Future-dated only.** A commitment whose due date has passed never becomes a reminder —
     `saveNoteBatch`'s one follow-up per person, due `anchor + followUpDays`, is turned off
     when that date has already passed. Without this an old doc would generate a
     follow-up that's overdue the moment it's created.
  2. **Explicit dates only.** `origin === "explicit"`, a non-null `rawDatePhrase`,
     `dateBasis !== "vague"`, and not `yearInferred` — no reminder from "soon" or an implied
     next step.
  3. **At most 3 per document**, highest `confidenceScore` first.
  4. **A past-dated commitment that looks important is flagged, not created.** "Looks important"
     = explicit, `dateBasis === "absolute"`, `confidenceScore >= 85` (capture's 0–100 scale —
     see `EXPLICIT_AUTO_TICK_CONFIDENCE`), and due within the last 30 days. Flags are stored on
     the import (`stats.flaggedCommitments`, capped at 20: title, person, due date, source
     excerpt, doc name) and shown in the import's detail sheet under **Worth a look**, each with
     a **Make a reminder** button that creates it due today. Nothing is written for a flag the
     person ignores.
  - Existing (contactId, description) de-dupe still applies.
  - The 85 / 30-day thresholds are starting values; `eval-ai.ts` is the gate for tuning them.

## 6. UI

- Third button on the drop hero; hidden when the Picker env vars are unset.
- **Picked files get their own card** (`DriveImportCard`), in the queue card's slot, rather than
  entering the file queue — the queue's vocabulary is file detection (`ImportTarget`), and a
  Drive pick is not a file. One row per file with its triage `why`, likely ones pre-ticked; a
  single "Import N files" button starts the whole pick as one `drive_docs` job, with progress
  shown through the page's standalone `ImportProgress` (the same bar every other kind uses)
  rather than the queue's own.
- History: new label + icon in `import-sources.ts` / `SOURCE_ICON` (`smoke-import-sources`
  fails until they exist). `summarizeImport` chips: "N docs read · N people · N meetings logged
  · N reminders · N to look at".
- Detail sheet: the people list (already built), plus the **Worth a look** section.

## 7. Errors

All through `import-errors.ts`, never raw text:
- Grant revoked / `drive.file` missing → reconnect Google.
- A file deleted or unshared between picking and processing (404/403) → row `skipped`,
  "Orbit can’t open this file any more".
- Export too large (Google caps export at 10 MB) → row `skipped`.
- AI provider failures → the existing `AI_FAILURE_COPY` path.

## 8. Testing

- `smoke-drive-triage` (pure): named fixtures → expected `likely`/`why`.
- `smoke-drive-reminder-rules` (pure): the five rules as a table — past + unimportant dropped,
  past + important flagged, implied dropped, yearInferred dropped, fourth reminder dropped.
- `smoke-drive-import` (pglite): staging, chunk resumption, interaction de-dupe on re-import,
  a 404 row skipped without failing the job. The Drive fetch and the parse are injected, so the
  smoke calls no network and no model.
- `smoke-google-scopes`, `smoke-import-sources`, `smoke-toast-copy` extended.
- Live: pick real Docs in the demo preview (needs the env vars locally).

## Manual setup (Jason)

1. Enable **Google Drive API** and **Google Picker API** in the GCP project.
2. Browser API key, restricted to the site origins and the Picker API. *(done)*
3. Note the project number (the Picker's App ID).
4. Add `drive.file` to the OAuth consent screen's scopes.
5. Set `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY` and `NEXT_PUBLIC_GOOGLE_APP_ID` locally and in Vercel
   (Production + Preview).

## Out of scope

Whole-Drive scanning and suggestion (restricted scope), Sheets/PDF/Word, shared-drive browsing
beyond what the Picker shows, AI-based triage before picking.
