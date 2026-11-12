# Integrations dialog — connect accounts, not keys

Status: design approved 2026-09-22 (brainstormed with Jason 2026-09-21/22).
Branch: `claude/settings-popup-redesign-0ed30d`.
Scope: the Settings → Integrations dialog only (`src/components/settings/integrations-dialog.tsx`
and what it renders). The rest of `/settings`, `/imports`, `/events` and onboarding are out of
scope except where named below.

## Context

The dialog has nine tabs named after technologies — AI provider, Outreach, Calendar feed, API &
connectors, Webhooks, Google Contacts, LinkedIn, Outlook, Gmail — split into "Services" and
"Import contacts". A non-technical user meets:

| Tab | Asks the user to |
|---|---|
| AI provider | paste an API key; pick a model (managed AI is off, so every user must) |
| Outreach | paste five secrets (Apollo, Resend, Twilio SID + token, a phone number) |
| Calendar feed | copy a private link shown exactly once |
| API & connectors | copy a connector URL; create and copy an API key |
| Webhooks | paste an endpoint URL; copy a signing secret shown once |
| LinkedIn | upload a CSV and a CSV/ZIP (LinkedIn has no API) |
| Google Contacts / Gmail / Outlook | sign in — but one Google account is split across three places (these two tabs and Calendar sync, which only exists on `/events`), and the Outlook recruiter scan lives only on `/recruiters` |

Defects found while surveying (all verified in code, 2026-09-21):

1. Every Google/Microsoft connect runs `requireSyncUser` (`src/actions/gmail.ts:104-142`,
   `src/actions/outlook.ts:102-140`), but only the Gmail tab shows a plan gate. A free user
   clicking "Connect Google" gets the generic "Couldn't connect your account — try again?".
2. `GoogleContactsImport` and `OutlookContactsImport` render `null` while their status loads and
   swallow a failed load, so the panel stays blank for good.
3. `getIntegrationStatuses` (`src/actions/integrations.ts:111-115`) assigns the same Google
   summary to both `google` and `gmail`, so Gmail reads "Connected" when `gmail.readonly` was
   never granted. It is scope-blind in general.
4. `upsertGmailConnection` (`src/lib/gmail.ts:235-254`) unions scopes even when the reconnect is a
   different Google account, so stored scopes can claim grants the new token lacks.
5. `disconnectGmail` leaves the `event_provider_connections` `provider='gmail'` opt-in row, which
   keeps being claimed and failing to get a token.
6. Outlook contacts preview/confirm and the Outlook avatar index don't check `Contacts.Read`
   server-side.
7. `MICROSOFT_*` env vars are documented in `.env.example` but absent from `src/lib/env.ts`.
8. Smaller: the Gmail plan lock says "Orbit Pro" (it is Pro and Lifetime) and links `/pricing`
   while the API tab links `/upgrade`; webhooks' free-plan block is a toast with no upgrade
   action; `ApiSettings` still has a "Copy MCP URL" aria-label for a key type that no longer
   exists; the disconnect dialog on a *contacts* card offers to delete "Recruiter links and
   messages"; Outreach counts Orbit's own hosted keys as "Saved" and has no way to remove a key.

What already works and is reused, not rebuilt: one `gmail_connections` / `outlook_connections`
row per user; per-purpose scopes (`src/lib/google-scopes.ts`, `src/lib/microsoft-scopes.ts`);
Google incremental consent via `include_granted_scopes` + `unionScopes`; Microsoft re-requesting
prior grants via `microsoftScopesFor`; `returnTo` bringing OAuth back into the dialog; the
`import-job-runner` singleton; the deep-link discipline in `integrations-settings.tsx`.

## Decisions (settled 2026-09-21/22)

1. **Scope: the Integrations dialog only.**
2. **Account-first structure** (approach A): an Overview page plus one page per account, not per
   technology and not per task.
3. **Consent: basics now, mail on demand.** One click grants contacts + calendar (both
   "sensitive", not "restricted"). Mail features (read inbox, send) ask the first time they are
   used. Reason: `gmail.readonly` / `gmail.send` are restricted scopes; until Google's security
   assessment (CASA) passes only listed test users can grant them, so bundling them would break
   Connect for everyone. Microsoft follows the same shape for symmetry.
4. **AI: one-click OpenRouter plus a guided paste.** "Connect OpenRouter" (OAuth PKCE, no paste)
   is primary; a guided free-Gemini-key paste is the fallback; OpenAI/Anthropic keys move under
   "More options". Managed AI stays off.
5. **Developer tools in a collapsed "Advanced" group** in the same dialog: API keys, Webhooks,
   Outreach keys. The Claude/ChatGPT connector becomes its own plain-language page.
6. **Reminders in calendar: one-click subscribe now, direct write later.** This project replaces
   copy-a-link with per-app buttons. Writing reminders into a connected Google/Microsoft calendar
   is a later phase.
7. **Plans: Google and Microsoft are free** — connecting, contacts import, photo matching,
   meetings sync, send-from-Gmail. **Exception: the recruiter inbox scan stays Pro/Lifetime**,
   because it is part of the paid Recruiters feature; its row renders locked with an Upgrade
   action.

## Information architecture

### Navigation

```
Overview                      ← the dialog opens here
YOUR ACCOUNTS
  Google
  Microsoft
  LinkedIn
AI AND CALENDAR
  AI
  Claude and ChatGPT
  Reminders in calendar
▸ Advanced                    ← collapsed by default
    API keys
    Webhooks
    Outreach keys             ← only while the Outreach surface is visible
```

- `Advanced` expands automatically when the selected page is inside it (a deep link, or the
  keyboard moving into it). Its expanded state is not persisted.
- Wide screens (`md`+) keep the side nav. Below `md` the horizontal tab strip is removed: the
  dialog shows Overview as a list, and every other page has a Back control to Overview.
  `aria-orientation` and roving-tabindex keyboard handling stay as today for the side nav.

### Page ids, legacy aliases, surface keys

`src/components/settings/sections.ts` stays the single source. `INTEGRATION_TABS` becomes the
new page list:

| Page id | Nav label | Group | Visibility follows |
|---|---|---|---|
| `overview` | Overview | — | shown when any other page is visible |
| `google` | Google | accounts | `page.imports` |
| `microsoft` | Microsoft | accounts | `page.imports` |
| `linkedin` | LinkedIn | accounts | `page.imports` |
| `ai` | AI | ai | section `settings-ai` |
| `assistants` | Claude and ChatGPT | ai | section `settings-api` |
| `reminders` | Reminders in calendar | ai | section `settings-calendar` |
| `api` | API keys | advanced | section `settings-api` |
| `webhooks` | Webhooks | advanced | section `settings-webhooks` |
| `outreach` | Outreach keys | advanced | section `settings-outreach` |

- **No section id and no surface key is renamed.** Hide-lists stored as `settings.ai` etc. keep
  matching (see the header of `sections.ts`).
- The Inbox rows on the Google and Microsoft pages follow `page.recruiters`: hiding `/recruiters`
  hides those rows, not the pages.
- Legacy ids keep working through an alias map consumed by `isIntegrationTabId` /
  `?integration=`: `gmail` → `google` (scrolled to the Inbox row), `outlook` → `microsoft`,
  `calendar` → `reminders`. `INTEGRATION_TAB_FOR_LEGACY_HASH` keeps resolving `#settings-*`.
- `integrationHref()` accepts new ids; existing callers (`ai-key-notice.tsx`, `wizard-ai-key.tsx`,
  `account-alerts.ts`, `reminder-calendar-sync.tsx`, `(site)/connect/page.tsx`) keep compiling
  because their ids (`ai`, `api`, `calendar`) are either unchanged or aliased; update `calendar`
  callers to `reminders` anyway.
- `account-alerts.ts` Google/Outlook reconnect CTAs (`:495-496`, `:509`) change from
  `/imports#import-google-contacts` / `#import-outlook-contacts` to `integrationHref("google")` /
  `integrationHref("microsoft")`.
- The deep-link behaviour in `integrations-settings.tsx` is preserved verbatim: `?integration=` is
  read during render, and `clearDeepLink()` strips it **only on close** (the
  `replaceState`-drops-queued-server-actions trap; keep that comment).

### Overview page

- One card per visible account page: icon/mark, name, a one-line plain description, a status line,
  and exactly one primary action.
  - Google / Microsoft: "Connect Google" starts OAuth directly from the card (basics consent);
    when connected, "Manage" opens the page.
  - LinkedIn: "Import" / "Import again" with the last import date.
  - AI: "Turn on AI" / "Manage".
  - Claude and ChatGPT: "Set up".
  - Reminders in calendar: "Set up" / "Manage"; status is "On · last checked <time>" (Orbit cannot
    tell which calendar app subscribed, so the status never names one).
- An attention strip above the cards lists anything broken or blocking, one row each with its fix:
  needs-reauth ("Google signed Orbit out — Sign in again"), AI not on ("AI isn't on yet, so notes
  and recruiter search can't use it — Turn on AI"), meetings sync paused by failure.
- Advanced pages do not get Overview cards.

### Settings page card

`IntegrationsSettings` shrinks to a compact list of the same Overview rows (name + status) and a
"Manage" button that opens the dialog on Overview. Clicking a row opens that page. The
"Services" / "Import contacts" sub-groups are removed.

### Status model

`getIntegrationStatuses` keeps its per-lookup 8 s `settle()` timeout and `"unknown"` fallback, and
returns one entry per page id. Google and Microsoft return a per-capability shape:

```ts
type AccountCapability = "contacts" | "meetings" | "inbox" | "send";
type CapabilityState =
  | "on"            // granted and in use (meetings: syncing)
  | "available"     // granted, not yet used (e.g. contacts never imported)
  | "not_allowed"   // connected, scope not granted — show an Allow action
  | "paused"        // meetings: user switched it off, or sync gave up (reason carried)
  | "locked";       // plan doesn't include it (inbox on free)

type AccountStatus = {
  state: "not_configured" | "not_connected" | "connected" | "needs_reauth";
  email?: string;
  capabilities: Partial<Record<AccountCapability, { state: CapabilityState; detail?: string }>>;
};
```

Capability state derives from the stored scopes (`hasScope`/`grantCovers`), the connection's sync
columns, and entitlements. The nav dot and Overview status derive from `state` plus any capability
in a failed `paused`.

## Google and Microsoft pages

### Connecting

- `startGmailOAuth` / `startOutlookOAuth` accept a list of purposes and request the union of their
  scopes. "Connect" sends `["contacts", "calendar"]`. Existing single-purpose callers
  (`/imports`, `/recruiters`, `/events`, compose) keep working unchanged.
- The callback checks each requested purpose with `grantCovers`. A partial grant (the user
  unticked calendar on Google's granular consent screen) is a successful connect: the page shows
  "Connected" and the Meetings row shows `not_allowed` with **Allow**. `reason=missing_scope` only
  fires when *no* requested purpose was granted.
- `returnTo` is `integrationHref("google" | "microsoft")`.
- After a connect that grants calendar, the first meetings sync is armed immediately (not left for
  the next 30-minute scheduler pass), so "Checked just now" is true soon after returning.

### Rows

One control per row; its label says what happens. Rows render in this order:

| Row | Google scope | Microsoft scope | Control | Plan |
|---|---|---|---|---|
| Contacts | `contacts.readonly` | `Contacts.Read` | **Import contacts** → the existing pick-who-comes-in review (`ImportPeopleReview`) inline; afterwards "N imported <date>" and **Check for new** | free |
| Meetings | `calendar.readonly` | `Calendars.Read` | switch; on after connect; off pauses sync | free |
| Recruiters in inbox | `gmail.readonly` | `Mail.Read` | **Scan inbox**; first press asks for mail access; needs AI (inline "Turn on AI" link when off); progress and results inline | Pro/Lifetime; free sees a locked row with **Upgrade** → `/upgrade` |
| Send from your email | `gmail.send` | — (not offered) | **Allow**; afterwards "Allowed" | free |
| Reminders in calendar | — | — | **Add** → opens the Reminders page with that app preselected | free |

- The Meetings switch: off sets the connection's sync to a user-paused state distinguishable from
  "gave up after failures" (use a distinct `sync_status` value if the column is free text;
  otherwise a nullable column in P2's migration) and clears `next_sync_at`; on re-arms it.
- Google Calendar meetings sync moves here from `/events` for the dialog; `/events` (coming soon)
  is not changed in this project and keeps its own button, which calls the same action.
- The Outlook recruiter scan (`recruiters/outlook-import-panel.tsx`) is brought into the Microsoft
  page's Inbox row; `/recruiters` keeps its panels.
- The Gmail event-confirmation scan (`event_mail`) stays on `/events`.
- Per-scope revocation is not possible (Google's revoke is all-or-nothing, Microsoft has none), so
  rows are not individually revocable. The account header's ⋯ menu holds **Switch account** and
  **Disconnect**.
- Header: avatar initials, provider name, connected email. Needs-reauth replaces the rows' area
  with one line and **Sign in again**; rows below render dimmed and inert until reconnected.

Components: the page composes the logic of the existing importers rather than embedding their
bordered cards (which nest a card in the dialog today). Extract the connection-status fetching
and contacts preview/confirm into hooks/sub-components shared with `/imports`
(`GoogleContactsImport`, `OutlookContactsImport`) and `/recruiters` (`GmailImportPanel`,
`OutlookImportPanel`) so those pages keep behaving the same.

### Fixes shipped with these pages

1. **Plan gate:** `requireSyncUser` comes off `startGmailOAuth` / `startOutlookOAuth` and off
   Google/Microsoft calendar sync. The `recruiter_scan` purpose instead requires
   `canUseRecruiters`, checked server-side, returning a `PaywallError` the UI renders as the locked
   row (never the generic retry toast). `calendar_subscriptions` (pasted ICS URLs) keep
   `canUseSync` — they are not Google/Microsoft. Update the copy that sells these as paid:
   `entitlements.ts` feature lists, the plan card's "What's included", `/pricing`.
2. **Account switch:** when a callback's account email (compared case-insensitively — both tables
   already store it, so no new column) differs from the stored one, replace scopes with the new grant instead of unioning, reset the
   sync cursor and sync state, and redirect with a flag that shows "Switched to <email>".
3. **Disconnect Google** also deletes the `event_provider_connections` `provider='gmail'` row.
4. **Disconnect dialog:** the "Also delete" option lists only categories this account actually
   produced (today: recruiters, only when the inbox scan has run).
5. **Loading/failure:** pages show a skeleton while loading and "Couldn't check your Google
   connection — Retry" on failure; never a blank panel.
6. **Server-side scope checks** for Outlook contacts preview/confirm and the Outlook avatar index;
   a missing grant surfaces as the Contacts row's `not_allowed`, not a thrown error.
7. **Env:** add `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI` to the
   expected (warning) list in `src/lib/env.ts`, alongside the Google trio. `MICROSOFT_TENANT_ID`
   stays optional.

## AI page

### Not on yet

- Heading "Turn on AI"; one paragraph: what AI does in Orbit and that it runs on the user's own AI
  account, so they pay only for use (usually cents a month).
- Primary: **Connect OpenRouter** — "Sign in or create an account, add a little credit, and you're
  back here. Works with Gemini, GPT and Claude."
- Collapsed: **Or use a free Google Gemini key** — three numbered steps: open Google AI Studio's
  key page (`https://aistudio.google.com/apikey`, external link) and sign in; press "Create API
  key" and copy it; paste here + **Save**. The key is verified on save as today
  (`saveAiSettings`). A one-line note: on Google's free tier, Google may use what is sent to
  improve its models.
- Collapsed: **I have an OpenAI or Anthropic key** → the More options block.

### On

- "AI is on" + which account ("Using your OpenRouter account" / "Using your Gemini key").
- Two figures: **This month** (cost) and, for OpenRouter when reported, **Credit left**.
- **Model** row with **Change** (the preset list for the active provider).
- **Disconnect** (OpenRouter) / **Remove key** (pasted).
- Collapsed **More options**: provider picker, model incl. "Custom model ID…", saved keys per
  provider with Clear, and the existing per-feature usage table (`AiUsageCard`).

### OpenRouter integration

- `AiProvider` gains `"openrouter"` (`src/lib/ai-providers.ts`) with its model presets. Preset ids
  are OpenRouter model slugs for Gemini, GPT and Claude families, verified against OpenRouter's
  models list during planning; the default is the Gemini Flash-class model matching
  `DEFAULT_MODELS.gemini`.
- Client: the OpenAI SDK pointed at `https://openrouter.ai/api/v1` with `HTTP-Referer` (app
  origin) and `X-Title: Orbit` headers, constructed next to the existing `new OpenAI(...)` in
  `src/lib/ai-access.ts`. Call sites in `src/lib/ai.ts` route `openrouter` through the OpenAI
  code path.
- Embeddings: `EmbeddingBackend` gains `"openrouter"` using `openai/text-embedding-3-small` via
  OpenRouter's OpenAI-compatible `/embeddings`. Planning verifies whether its vectors are
  interchangeable with the direct OpenAI backend; if so, moving between the two does not
  re-index.
- Connect flow:
  1. Server action `startOpenRouterConnect({ returnTo })` generates a PKCE verifier, stores it
     with a nonce and `returnTo` in an httpOnly cookie (10 min, like the Google/Microsoft state
     cookies), and redirects to `https://openrouter.ai/auth?callback_url=<origin>/api/openrouter/callback?n=<nonce>&code_challenge=<S256>&code_challenge_method=S256&key_label=Orbit`.
  2. `GET /api/openrouter/callback` requires the Clerk session, matches the nonce, exchanges the
     code at `POST https://openrouter.ai/api/v1/auth/keys` with `{ code, code_verifier,
     code_challenge_method: "S256" }`, verifies the returned key (`GET /api/v1/key`), stores it
     encrypted through the same path as pasted keys, selects `openrouter` + default model, and
     redirects to `returnTo` with `?openrouter=connected|error&reason=…`.
  3. Cancel / error returns to the AI page with a friendly toast.
- Usage and cost: record OpenRouter's reported per-call cost instead of the `ai-pricing.ts`
  estimate for this provider. "Credit left" reads the key-info endpoint; hidden when not
  reported.
- Errors: HTTP 402 → `UserFacingError` "Your OpenRouter credit ran out — add more" linking to
  OpenRouter's credits page; 401 → the AI page shows "Reconnect OpenRouter".
- Disconnect deletes Orbit's stored key and links to OpenRouter's keys page so the user can
  delete it there.
- `ai-access.ts` remains the only path to a key; managed AI stays off.
- **Gate:** `eval-ai.ts` must pass on the OpenRouter route (structured JSON output, vision for
  scanned notes, chat tool calls) before this ships.
- The not-on block is a standalone component (`TurnOnAi`) so onboarding (`wizard-ai-key.tsx`) can
  adopt it later; switching onboarding over is out of scope.

## Claude and ChatGPT page

- One line: ask Claude or ChatGPT about your network and let them log notes for you; you sign in,
  no key.
- A two-way choice, **I use Claude** / **I use ChatGPT**, each showing only its steps: a large
  **Copy link** (the `/api/mcp` URL), a direct external link to that assistant's connector
  settings, and "Paste it, then sign in to Orbit on the page that opens." ChatGPT's current steps
  are re-checked during planning.
- The remaining paste cannot be removed in code; a directory listing (Claude connectors, ChatGPT
  apps) is the fix and is tracked as a manual step.
- Content moves out of `ApiSettings` (the "Connect Claude or ChatGPT" box) into its own component.

## Reminders in calendar page

- Three buttons: **Google Calendar**, **Outlook**, **Apple Calendar**. The first click creates the
  feed if none exists — there is no separate "Create" step.
  - Google: `https://calendar.google.com/calendar/r?cid=<webcal URL>` (existing).
  - Outlook: "add from web" — personal `https://outlook.live.com/calendar/0/addfromweb?url=…&name=Orbit%20reminders`,
    work/school `https://outlook.office.com/calendar/0/addfromweb?url=…&name=…` (both formats
    verified during planning). If a Microsoft account is connected, pick by its email domain
    (outlook.com, hotmail.com, live.com, msn.com → personal); otherwise show the two choices.
  - Apple: the `webcal://` URL.
- After a click, show only that app's one relevant tip (Google: refreshes every few hours, add a
  notification in the calendar's settings; Apple: set refresh to hourly, keep alerts).
- Collapsed **Other calendar app**: **Copy link** and "Anyone with this link can see your
  reminders." ⋯ menu: **Reset link**, **Turn off**. "Last checked <time>" stays.
- **Storage change:** add a nullable `user_settings.calendar_feed_token_encrypted` (via the
  `alters` path + a `SCHEMA_VERSION` bump — scan every branch for claimed versions first; main is
  at 77 on 2026-09-22), written with `src/lib/crypto.ts` `encrypt` on create/regenerate. The hash
  column stays the lookup key; `/api/calendar/[token]` is unchanged. Feeds created before this
  have no encrypted copy: the page says the feed is on and offers **Set up again** (regenerate)
  to use the buttons.
- `reminders/reminder-calendar-sync.tsx` renders the same component, so there is one UI.

## LinkedIn page

- Opener: "LinkedIn doesn't let apps connect directly, so this takes one download."
- Three steps:
  1. **Open LinkedIn's download page** (external) — choose only *Connections* and *Messages*. The
     copy states an arrival time only after it is verified during planning (selected files are
     expected in minutes; the full archive takes up to ~24 h).
  2. Download the ZIP from LinkedIn's email.
  3. **Drop the ZIP here** — one drop zone that accepts the ZIP (or either CSV), finds
     `Connections.csv` and `messages.csv`, and runs connections then messages through the existing
     parsers and one review list.
- The timeline checkbox reads: "Also add meetings mentioned in your messages to timelines (uses AI,
  about <cost>)."
- Dependency: PR #238 (unmerged) adds file-kind detection to `/imports`. If it has landed, reuse
  its detector; if not, build a small ZIP detector #238 can adopt. `/imports` and onboarding keep
  their current LinkedIn cards.

## Advanced

Intro line: "For developers and automation tools. You don't need anything here to use Orbit."

- **API keys:** `ApiSettings` minus the connector box; fix the stale "Copy MCP URL" aria-label.
- **Webhooks:** visible label on the URL field; events listed in words (map ids like
  `contact.created` → "A contact is added"); free users get a **See plans** action (`/upgrade`)
  instead of a toast.
- **Outreach keys** (visible only while the Outreach surface is): **Remove** per saved key; stop
  reporting Orbit's hosted keys as the user's "Saved" key; a "Where do I get this?" external link
  per service.

## Copy rules

- Outside Advanced, no "API", "key" (except the guided Gemini/OpenAI/Anthropic paste), "OAuth",
  "scope", "token", "webhook", "ICS", "feed", "endpoint", "sync" or "BYOK". Say what happens:
  "Logs meetings with people you know", "Finds recruiter emails".
- Buttons are verb-first, 1–3 words, sentence case.
- Errors go through `friendlyError` / `UserFacingError`, never `err.message`; toast copy follows
  the repo's toast voice (`smoke-toast-copy` is repo-wide).
- Provider marks: the Google "G", Microsoft four-square and LinkedIn "in" marks as small inline SVG
  components used per the providers' brand guidelines (lucide has no brand icons).

## Phasing

Each phase is its own PR, shippable alone. Re-check `origin/main` before each PR (parallel
worktrees; #238 and #247 touch importers and Google OAuth).

| # | Phase | Contents | Depends on |
|---|---|---|---|
| P1 | Shell and status | New `INTEGRATION_TABS`, aliases, Overview + attention strip, Advanced group, phone Overview/Back, slim Settings card, per-capability `getIntegrationStatuses`, account-alert CTAs. Existing panels mounted in their new pages unchanged (Google page = current Google Contacts + Gmail panels; Microsoft = Outlook panel; Assistants = extracted connector box). | — |
| P2 | Google and Microsoft pages | Multi-purpose connect, rows, Meetings switch, Outlook inbox scan in the dialog, plan-gate change + copy, fixes 1–7 | P1 |
| P3 | AI | OpenRouter provider + connect + cost/credit, `TurnOnAi` with guided Gemini paste, More options | P1 (parallel with P2) |
| P4 | Reminders | Per-app buttons, encrypted token (schema bump), shared with the Reminders rail | P1 |
| P5 | LinkedIn and Advanced | One-ZIP guided import, Advanced fixes | P1; ideally #238 |

Later (not this project): Orbit writing reminders into a connected Google (`calendar.app.created`)
or Microsoft (`Calendars.ReadWrite`) calendar; Outlook send (`Mail.Send`); onboarding adopting
`TurnOnAi`; connector directory listings.

## Verification

- `npx tsc --noEmit` clean; eslint 0 errors (baseline 0 errors / ~44 warnings).
- Smoke scripts, each registered in `scripts/run-smoke.ts` (an unregistered smoke fails the suite):
  - `smoke-settings-layout` updated for the new groups/pages;
  - every legacy id and `#settings-*` hash resolves to the right page, and no surface key changed;
  - scope union vs. account-switch replacement, for both providers;
  - partial grant → connected with `not_allowed` capability;
  - OpenRouter PKCE: challenge/verifier pairing, nonce mismatch rejected, stored key encrypted;
  - calendar token encrypt/decrypt, and a hash-only legacy feed still served by the route;
  - LinkedIn ZIP detection finds both CSVs.
- `eval-ai.ts` on the OpenRouter route before P3 ships.
- Visual checks in the demo-mode preview (`orbit-demo`), driven over CDP because a hidden pane
  never hydrates and checks pass vacuously: every page at desktop and phone width, no horizontal
  scroll, Advanced collapse/expand, Back navigation, a running import surviving dialog close.
- Manual acceptance (needs real client IDs and test accounts; a checklist ships with each phase):
  Google and Microsoft connect incl. unticking calendar, account switch, disconnect; OpenRouter
  connect, out-of-credit, disconnect; each calendar app's subscribe button.

## Risks and manual steps

- **Google verification.** `contacts.readonly` and `calendar.readonly` are sensitive: until the
  consent screen is verified, users see "Google hasn't verified this app" and there is a 100-user
  cap — the first thing a non-technical user will hit. Gmail scopes additionally need CASA; that
  now blocks only the on-demand rows.
- **Microsoft publisher verification.** Work/school tenants may block consent to an unverified
  multi-tenant app; personal accounts are unaffected.
- **Production env.** Confirm `MICROSOFT_*` (and Google's) are set in Vercel production.
- **Load.** Free accounts now arm 30-minute calendar sync; watch the scheduler on the Hobby plan.
- **Parallel branches.** #238 (imports redesign) and #247 (Drive import, stacked on #238) touch
  importer components and Google OAuth.

## Relation to earlier specs

`2026-09-19-integrations-ui-design.md` (branch `claude/orbit-integrations-strategy-0b8be6`, not
on main) designed a registry-driven catalog of ~25 connectors. This spec is the near-term,
account-first version of the same dialog. It reuses that spec's Overview + detail layout, "read
on, write off" consent, and first-class needs-reauth state. It does not build the connector
registry, families, search, or Request votes, and it keeps `/imports` (that spec's retirement of
`/imports` was reversed on 2026-09-20).
