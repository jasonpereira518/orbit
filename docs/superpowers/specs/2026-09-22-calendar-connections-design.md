# Calendar connections: Google, Outlook and Apple

Date: 2026-09-22
Status: design approved, plan not yet written
Branch: `claude/calendar-connections-apple` (cut from main `5e892e2d`)

## The umbrella

Jason asked for calendar sync with Google, Outlook and Apple, inbound **and** write-back:
reminders and follow-ups written into the calendar, meetings scheduled from Orbit, and
important contact dates surfaced as events.

That is four projects, not one. Each gets its own spec, plan and PR:

| # | Sub-project | Delivers | Depends on |
|---|---|---|---|
| **1** | **Calendar connections** (this spec) | Apple over iCloud CalDAV; per-calendar selection for all three providers; recurrence expansion; Outlook parity fixes | — |
| 2 | Write-back engine + reminders | Write consent per provider, an Orbit-owned calendar, an outbox mirroring reminders (create/update/delete) | 1, plus outbox plumbing |
| 3 | Important contact dates | Birthday/anniversary/custom date fields, captured from notes and entered by hand, written through 2 | 2 |
| 4 | Schedule meetings from Orbit | Create a real invite to a contact, sent from the user's account, returning through inbound sync | 2 |

Order matters: everything later writes through 1's connections and 2's engine, and 4 is last
because it is the only outward-facing piece — it sends mail to other people from the user's
account.

### Settled decisions (do not re-ask)

1. Direction is inbound **plus** write-back. Full field-level two-way sync stays rejected, as in
   `2026-09-19-integrations-strategy-design.md`.
2. Calendars are **chosen per account**, not assumed. The default calendar is pre-checked; shared
   and subscribed calendars are unchecked and labelled read-only.
3. This project **adopts the account-first Integrations dialog** of
   `2026-09-22-integrations-dialog-simplification-design.md` (PR #257). There is no "Calendars"
   tab; Apple becomes a third account page beside Google and Microsoft.
4. **Connecting a calendar account is free — Google, Microsoft and Apple alike.** The dialog
   spec's decision 6 drops `requireSyncUser` for Google and Microsoft; Apple is neither, so it
   was decided separately (Jason, Sep 22 2026) and lands on the same side. `sync` gates
   write-back in sub-project 2.

   An earlier "one free connection, pay for the second" answer was superseded, deliberately: it
   would have split free from paid *inside* a single Google connection, which decision 3 of that
   spec fuses on purpose (one Connect grants contacts and calendar together).

   **Pasted ICS/webcal URLs keep `requireSyncUser`**, as they do today. The line is *an account
   Orbit authenticates to* versus *an arbitrary URL Orbit fetches on a schedule* — the latter is
   an open-ended fetcher, and the former is what makes a new user's network fill up.

## Sub-project 1: what exists today

On main at the time of writing:

- **Google Calendar** — connects through the shared Google OAuth (`gmail_connections`,
  per-purpose consent, `calendar.readonly`), syncs incrementally with `syncToken`, reads
  `calendars/primary` only, writes `meeting` NetworkEvents through `ingestEvents` with source
  `google_calendar`. Read-only. Its only connect button lives on `/events`.
- **Outlook Calendar** — landed in #237. `outlook_connections`, `Calendars.Read`, incremental
  through Graph `calendarView/delta`, default calendar only, source `microsoft_calendar`.
  Read-only.
- **Apple** — nothing. An Apple user can only paste an ICS/webcal URL into `/imports`, which is
  re-fetched whole every 30 minutes and parsed by `parseIcsEvents`.
- **Outbound** — a read-only ICS feed of pending reminders at `/api/calendar/[token]`. Nothing is
  ever written into a provider.

Two facts discovered while designing, both load-bearing:

- **`parseIcsEvents` ignores `RRULE` entirely.** A weekly 1:1 in a subscribed feed is recorded
  once, at its first occurrence. Google and Graph expand recurrences server-side, which is why
  neither has hit this. CalDAV does not, so Apple cannot work without an expander.
- **No DAV, iCal, RRULE or XML dependency exists.** `ics.ts` and `calendar-import.ts` are
  hand-rolled string work.

## Architecture

### `icloud_connections`

A third provider table shaped like `gmail_connections`, registered as one entry in
`PROVIDER_TABLES`. This is the extension path `provider-connections.ts` documents in its own
header; a unified `provider_connections` table was considered and rejected there, and that
ruling stands.

Instead of OAuth tokens it stores the Apple ID, the app-specific password encrypted through
`crypto.ts`, and the discovered principal and calendar-home URLs. The scheduler's claiming,
backoff, six-failure give-up and disarm then apply unchanged.

Because it holds a password rather than a revocable token:

- No read path returns the plaintext. Actions return the Apple ID and a status, nothing else.
- It is decrypted in exactly one place, the CalDAV client, at request time.
- `purgeUserData` gains the table (`smoke-purge.ts` enforces this for every user-scoped table).
- Account export carries the metadata and never the secret.

### `calendar_sources`

One row per calendar the user *can* sync, for all three providers: owning connection, provider
calendar id, display name, colour, read-only flag, `enabled`, and its own `sync_cursor`. It
backs the picker and moves the cursor from the connection down to the calendar.

**Migration.** On first run after deploy, every existing Google and Outlook connection gains one
row for its default calendar, seeded with the cursor already on the connection. Nobody re-syncs
and no interaction doubles.

**Schema version.** Both tables are one bump. Main was at 86 when this was written, but the
number must be re-scanned across every remote branch *and* local worktree at the moment the
migration is written — 74–76 are claimed by the integrations worktree, and the comment beside
`SCHEMA_VERSION` records what a silent collision costs (both sides wrote `73`, merged without a
conflict, and would have left every stamped database skipping a table forever).

### CalDAV client and connector

`src/lib/caldav/client.ts` speaks only what is needed: `PROPFIND` for discovery and calendar
listing, `REPORT` for events. Basic auth over HTTPS to `caldav.icloud.com`, host pinned to
Apple's domains, redirects refused, through the SSRF-guarded fetcher the ICS feed reader already
uses.

It adds **`fast-xml-parser`** — pure JS, no native build, safe in a serverless function. Regex
parsing of Apple's namespace-prefixed responses is how silent mis-parses happen.

`src/lib/connectors/apple-calendar.ts` implements the same three-function contract as the Google
and Microsoft connectors — fetch a page, map to `NetworkEvent`s, advance the cursor — so the
scheduler treats all three identically.

**Connect flow.** The user enters an Apple ID and an app-specific password generated at
appleid.apple.com (Apple requires one: with 2FA on, an account password will not authenticate
against CalDAV). Orbit then walks `/.well-known/caldav` → `current-user-principal` →
`calendar-home-set` → calendar list, and saves the connection only if the whole walk succeeds,
so a bad password fails at the form rather than silently at the next sync.

**Incremental sync** uses WebDAV-Sync: a `sync-collection` `REPORT` returns changed hrefs and a
`sync-token`, stored as the calendar's cursor — the same shape as Google's `syncToken` and
Graph's `deltaLink`, including an expired token forcing a full resync without counting a
failure. Fallback for a calendar that does not offer it: the collection `ctag` plus a time-range
query over the same 90-days-back / 60-ahead window.

**Two unknowns require a spike before the engine is written**, against a real iCloud account:
whether `sync-collection` is offered on every iCloud calendar, and whether server-side `expand`
works. The plan opens with that spike rather than assuming either.

### Recurrence

`src/lib/recurrence.ts` expands a master event over a window: `RRULE` with
`FREQ`/`INTERVAL`/`COUNT`/`UNTIL`/`BYDAY`/`BYMONTHDAY`/`BYSETPOS`, plus `EXDATE` and
`RECURRENCE-ID` overrides, DST-correct against the event's `TZID`, capped per event. Anything
more exotic falls back to today's behaviour — the master event alone — rather than guessing.

It is shared by CalDAV and the existing ICS paths, so **subscribed feeds start seeing every
occurrence of a recurring meeting**. That is a fix for current users, not only Apple ones, and a
deliberate scope addition: without it Apple sync would be wrong for exactly the meetings that
matter most, the recurring 1:1s.

**External ids.** Single events keep today's frozen `cal:<uid>:<contactId>` formula untouched
(`external-id.ts`, frozen by an assertion in `smoke-parsers.ts`). Occurrences get
`cal:<uid>_<occurrence-start>:<contactId>`. No stored value changes, so no meeting doubles.

### Scheduling and ingestion

`runSyncPass` gains an Apple pass after Microsoft, claiming through the same lease. A connection
now fans out over its enabled `calendar_sources`: the claim stays at the connection, and the
remaining wall-clock budget is checked between calendars, so a five-calendar account degrades by
syncing fewer calendars this pass rather than by blowing the budget. The next pass resumes
oldest-cursor-first, so no calendar starves.

Apple events go through `ingestEvents` with source `apple_calendar`, `createsContacts: true` —
the Google and Outlook path, not the ICS `applyNetworkingEvents` one. Same classification, same
0.85 duplicate floor, same Jev decision pass from `decisions/calendar.ts`.

**Known inconsistency, deliberately deferred.** The ICS subscription path also creates a
follow-up reminder two days after each recent meeting; the API paths do not. An Apple user
moving from a pasted ICS URL to a real connection will therefore stop getting those reminders.
Settled in sub-project 2, where reminders are the subject.

**Failures.** A 401 from Apple means the app-specific password was revoked: disarm immediately
and raise a reconnect alert rather than burning six retries. Rate limiting and 5xx use the
existing backoff.

### Outlook parity

Three fixes, cheapest to make while this code is open:

- `PENDING_MEETINGS` in `embedding-backfill.ts` lists only the Google and ICS sources, so
  **Outlook meetings are never embedded** and never reach chat or search. Add Microsoft and
  Apple.
- Account alerts only know `connection.google_calendar`. Make the alert per provider, so a dead
  Outlook or Apple connection actually says so.
- Event discovery runs on the Google pass only. Run it for all three.

## UI

Apple becomes a third account page in the account-first dialog. Connecting shows a short form —
Apple ID, app-specific password, and inline steps for generating one, since most people have
never made one. On success the page lists the account's calendars with checkboxes: default
pre-checked, shared and subscribed unchecked and labelled read-only. The same picker appears on
the Google and Microsoft pages. The password is never rendered back, not even masked.
Disconnecting deletes the connection and its sources.

`/imports` keeps the ICS subscribe panel — still the only way to follow a Fastmail or shared team
calendar — with copy pointing Apple users at the real connection first.

All user-facing copy goes through `friendlyError` / `UserFacingError`; `smoke-toast-copy`
enforces the voice repo-wide.

## Testing

New smokes:

- `smoke-apple-calendar-map.ts` — fixture XML to events, tombstones, and the
  cursor-never-adopted-mid-page rule, mirroring the Google and Outlook pairs.
- `smoke-recurrence.ts` — DST boundaries, `COUNT`/`UNTIL`, `EXDATE`, `RECURRENCE-ID` overrides,
  the occurrence cap, and that a non-recurring event's external id is byte-identical to today's.
- `smoke-calendar-sources.ts` — migration seeds exactly one row per existing connection carrying
  its cursor; disabled calendars are never claimed; budget fan-out.

Extensions to `smoke-sync-scheduler` (Apple pass, 401 disarm), `smoke-purge`
(`icloud_connections`) and `smoke-provider-connections` (three providers). Every new script must
be registered, or the whole suite dies (`run-smoke.ts`); note also that its pglite scripts share
one database, so any test claiming "due" work must first make itself the only tenant.

**Live verification is Jason's to drive.** Claude will not type an Apple app-specific password —
entering credentials is the user's action. Everything before that runs on fixtures; the final
check is Jason connecting his own iCloud account against a local dev server while Claude reads
the sync results and logs.

## Sequencing

1. Spike against a real iCloud account: `sync-collection` support, server-side `expand`.
2. Schema + `icloud_connections` + `calendar_sources` + migration.
3. CalDAV client, recurrence expander, Apple connector.
4. Scheduler fan-out, ingestion, Outlook parity.
5. UI — the only task with an outside dependency. It needs the account pages of that branch's
   **P2b** phase to exist, which is more than #257 merging: on
   `claude/settings-popup-redesign-0ed30d`, `GoogleAccountPage` is written but not yet mounted
   in the dialog's `Panel`, and `MicrosoftAccountPage` does not exist (P2b Task 5 Step 2 is
   unstarted). Everything else here proceeds regardless.
6. Re-scan `SCHEMA_VERSION` immediately before writing the migration.

## Risks

- **iCloud CalDAV behaviour is unverified.** Mitigated by the opening spike; if
  `sync-collection` is unavailable, the ctag fallback costs a full feed fetch per calendar per
  pass and the budget numbers need revisiting.
- **Recurrence is the widest blast radius in this project** — it changes what existing ICS
  subscribers see. Fixture coverage before it is enabled on the ICS path.
- **Sync budget.** Three providers and multiple calendars per account share one 4.5-minute pass
  on a `*/15` cron. Fan-out is bounded per pass; if accounts grow, the pass count, not the
  budget, is the lever.
- **Apple has no revocable per-app token.** A stored app-specific password is a long-lived
  secret; revocation is the user's action at appleid.apple.com, which the reconnect alert copy
  must explain.
