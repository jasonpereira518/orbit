# Events v2: built around "who did I meet"

## Context

Events already exists (~4.6k lines, hidden behind the `page.events` coming-soon switch). It starts from the guest list: you import a roster, tick who you spoke to, then press Connect, which creates contacts with no note and no follow-up. Setup offers six sources.

Jason's real moment comes **after** an event. He walks out with LinkedIn connects, names in his head, and sometimes the host's guest list. Five minutes after opening Orbit, he wants **every person saved as a contact tagged "met at X", with a note and a follow-up reminder**, and setup should be close to zero.

**What Jason decided while planning:**
- **Approach:** rethink the flow; the existing code is parts to reuse.
- **First moment to get right:** after the event.
- **Inputs:** LinkedIn connects, names from memory, the host's guest list.
- **Success:** contacts, notes and follow-up reminders. No auto-drafted messages.
- **Setup:** zero by default. Events come from the connected calendar. Anything else gets added at debrief time by name or link. The Luma and Partiful feeds and the host APIs move under "More sources". The Gmail scan leaves the page.
- **LinkedIn:** paste profile links now; an extension pull of recent connections comes later.
- **Ticking guest-list rows** feeds the same debrief. The old Connect write path is deleted.
- **Plans:** Events is available on every plan.

**The key reuse:** the debrief **is the existing /capture flow, seeded with an event**. Capture already handles:
- typed notes, voice, card scans, and pasted LinkedIn URLs (looked up via Apollo);
- a review deck where each person is matched or created, with a "met at" field;
- duplicate-safe saves;
- "Follow up with X" reminders (`saveNoteBatch`).

It also already takes `/capture?event=<calendar id>` for meetings. So v2 is mostly wiring, not a new debrief UI.

## What the user sees

1. **An event appears on its own**, through calendar discovery, which is already built. Or the user clicks **Add event**: one field, "Event name or link", plus a date prefilled with today. If the event is today or in the past, saving goes straight to the debrief.
2. **The morning after**, a card says *"How was {event}? Log who you met"*. It's the same slot as the existing "How did it go?" meeting card.
3. **The debrief is /capture, opened for that event.**
   - The note box is prefilled: `Met at "{title}":` followed by one line per ticked guest, if any.
   - The page says you can type names, paste LinkedIn links, or record a voice memo.
   - Extract, then review the cards, with "met at" already filled in. Then Save.
   - The result: contacts are created or matched, each timeline gets an `event` interaction with the note, follow-up reminders are created, and each person is recorded as **met** on the event.
4. **On a past event's page**, "People you met" sits at the top with a **Log who you met** button.
   - The guest list stays below it. Ticking rows and pressing **Log these people** opens the same debrief with those guests in the note.
   - Upcoming events keep today's prep layout: who to talk to, companies, roster.

## Implementation (4 PRs, in order)

### PR 1: Debrief = capture + event (the core)
- **Schema 182:** add `capture_jobs.event_id uuid null`, a foreign key to `events` with `ON DELETE SET NULL`.
  - It's a column, not part of `input_hints`, for the same reason given in `mentionPicks`' comment (`src/db/schema.ts` ~4059): a non-hint value must not end up in a prompt.
  - Follow the schema migration gate: add the versioned DDL in `src/db/index.ts`, bump `SCHEMA_VERSION`, and update the schema lock.
- **`/capture?eventId=<events.id>[&attendees=id,id…]`** in `src/app/(clerk)/(app)/(main)/capture/page.tsx`, next to the existing `?event=` block (~lines 80–95):
  - Load the event and the selected attendees through `src/lib/events/store.ts`.
  - Build `initialMeeting`: the prefilled note text, plus hints `{ eventDate, interactionType: "event", seedPeople: <selected attendees>, metAt: event.title }`.
  - Cap `attendees` at 25.
  - Pass `eventId` through `CaptureFlowLazy` to `queueCaptureJob` (`src/actions/capture-jobs.ts`). It verifies the event belongs to the user and stores it in `capture_jobs.event_id`.
- **Pre-fill "met at":** add an optional `metAt` to `CaptureParseHints` (`src/lib/ai.ts` ~315). When building cards in `capture-parse.ts`, use it to fill in `met_at` wherever the model left it blank. Save already writes it to `contacts.howMet`.
- **Record who was met:** add a follow-on step in `runSave` in `src/lib/capture-job-runner.ts` (~217), in the same `followOn(...)` / `reportAndContinue` pattern as the `meeting` step.
  - When `row.eventId` is set, run `upsertEventAttendees` (source `capture`), then `linkAttendeesToContacts`, then `setSpokeToForUser`, all from `src/lib/events/store.ts`, for every saved contact.
  - A seeded guest updates its existing row, because `identity_key` is unique.
  - This makes "People you met", `contact-events-together.tsx` and repeat people work with no further changes.
- **Delete the old Connect write path:**
  - Delete `connectAttendees` (`src/lib/events/connect.ts`), the `addSpokenToConnections` and `previewConnectAttendees` actions, `connect-preview-dialog.tsx`, and their uses in `attendee-roster.tsx`.
  - **Keep `previewConnect`**: `matchRosterToNetwork` uses it for the "already a contact" badges. Also keep `restampEventInteractions`.
  - Fix the smoke cases in `scripts/smoke-event-roster.ts` to match.
  - `ponytail:` interactions logged through capture use `notes:` external ids, so `restampEventInteractions` won't move them when an event's date is edited. That's acceptable unless people edit the dates of past events.
- **Roster selection:** in `attendee-roster.tsx`, the button becomes **Log these people**, which goes to `router.push('/capture?eventId=…&attendees=…')`.
- **Event page** (`events/[id]/page.tsx`): branch on past vs upcoming.
  - Past: "People you met" (attendees with `spoke_to`, linked to their contacts) and the Log CTA, then the roster import, the roster and companies.
  - Upcoming: today's order.
- **Add event dialog** (`add-event-dialog.tsx`):
  - One "Event name or link" input. If it parses as a URL it's the link, otherwise the title.
  - The date input is prefilled with today. Send `startsAt` only if there's no link or the user changed the date, so it doesn't override the page's real date.
  - If the date is today or earlier, go to `/capture?eventId=`; otherwise go to `/events/:id`.
- **Double page fetch (gap 7):** drop the `after()` enrich call in `createEvent` (`src/actions/events.ts`), because the dialog already awaits `enrichEventFromUrl`.

### PR 2: The morning-after nudge
- Add `lastUnloggedEvent(userId)` beside `lastUnloggedMeeting` (`src/lib/meeting-context.ts` ~592). It returns the most recent event that meets all of these:
  - the user attended it (`attendedEventFilter`);
  - it ended (`ends_at`, or `starts_at` + 3h) within the last 36 hours;
  - it has no `spoke_to` attendees and no `capture_jobs` row with that `event_id`.
- Add `unloggedEvent` to the app pulse (`src/lib/app-pulse.ts`). Render it through `meeting-note-card.tsx` with event copy, linking to `/capture?eventId=`.
- **No double nudge:** when the unlogged *meeting* resolves to an Event through `linkedEventFor`, link that card to the event debrief instead of `/capture?event=`, and skip the separate event card.
- On the events list, past cards with nobody met get a small "Log who you met" chip (`event-card.tsx`).

### PR 3: Zero-setup sources + release
- Replace `event-connections-card.tsx` with:
  - one line: "Events on your calendar show up here automatically", or, when no calendar is connected, a **Connect your calendar** button using the existing integrations entry;
  - a collapsed **More sources** section holding the Luma and Partiful calendar links, the Luma API key and Eventbrite, all reusing the existing rows.
- **Delete the Gmail confirmation scan:**
  - the UI row and `setGmailEventScan` (`src/actions/events.ts`);
  - `src/lib/events/discovery/from-gmail.ts` and its step in `src/lib/events/sync.ts`;
  - the `event_mail` purpose in `src/lib/google-scopes.ts` and `microsoft-scopes.ts`, and its smoke (`smoke-event-gmail-scan`). Fix `smoke-google-scopes` and `smoke-event-discovery-store`;
  - existing gmail connections: `DELETE FROM event_provider_connections WHERE provider='gmail'` in the schema-182 migration (only admins and the demo account could have any). Remove `gmail` from the `EventConnectionProvider` type.
- **Copy:** the `/events` empty state still mentions Luma links, which conflicts with the Luma page-fetch block (ae51e304). Rewrite it to "Events from your calendar appear here. Add one by name or link."
- Remove the unused `googleConnected` prop.
- **Release:** remove `comingSoon: true` from `page.events` in `src/lib/surfaces.ts` (~76), with no plan-tier rule. Update `smoke-surface-visibility` and the teaser copy if it's still referenced. Meeting prep's event link (gap 2) then works on its own.

### PR 4 (later, ships with an extension release): LinkedIn connections to the event
- On `linkedin.com/mynetwork/…connections` (the `list` page kind already exists in `extension/src/inject/adapters/linkedin.ts`), the panel offers **Log at event…** with recent events from the last 14 days.
- It posts the selected profile URLs to a new extension route. That route calls `queueCaptureJob` with the `eventId`, then opens `/capture?job=…`.
- No personal data goes in URLs. This needs a Chrome Web Store release (see the extension release memory).

## Verification
- `npm run typecheck`, `npm run lint`, `npx tsx scripts/run-smoke.ts`, and update the schema lock.
- **New PGlite smoke `smoke-capture-event-link.ts`**: an event-linked capture job saves two people (one a seeded guest, one new). Assert:
  - attendee rows have `spoke_to=true` and `contact_id` set;
  - each contact has an `interaction_type='event'` row;
  - a follow-up reminder exists;
  - the seeded guest was not duplicated;
  - `lastUnloggedEvent` returns the event before the save and null after it;
  - a job whose `eventId` belongs to another user is refused.
- **Browser check** on the demo-mode preview (port 3001, see the visual preview setup memory):
  1. Add event "Founders Mixer", today.
  2. It should land on capture with the prefilled note.
  3. Type "Sarah Chen, Stripe infra, follow up next week" and paste a LinkedIn URL.
  4. Review, then save.
  5. On the event page, "People you met" shows 2.
  6. Sarah's timeline shows an Event entry, and /reminders has her follow-up.
  7. Tick a guest, then **Log these people**: the prefilled line should appear.
  8. Check the morning-after card by backdating the event.
- Once implementation starts, commit this design to `docs/superpowers/specs/2026-10-25-events-v2-design.md`.
