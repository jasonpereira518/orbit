# Orbit integrations strategy — which connectors, how deep, in what order

Status: strategy approved 2026-09-19. Each phase below gets its own spec → plan → build cycle.

## Context

Orbit should be the hub where a person manages their network (follow-ups, warm leads, upkeep)
**without leaving the tools they already use**. Requested: LinkedIn, Gmail, Google Calendar,
Outlook, Outlook People, Teams, Apple Reminders/Notes/Contacts/Calendar, Notion, Google Sheets,
Apollo, Obsidian, Salesforce, HubSpot, Confluence. This spec settles *what else* to add and *how
deep each goes*. The connect-everything UI is a separate spec.

Settled decisions:
- **Individuals first.** Job seekers, founders, solo operators. Work systems (CRM, Teams,
  Confluence) are per-user connectors, never org installs.
- **Apple via iCloud CardDAV/CalDAV + Apple Shortcuts.** No native Mac/iOS app.
- **Hub model: read wide, write back narrowly.** No field-level two-way sync.
- **Build on the existing connector spine.** No Nango / Merge / Unified.to; tokens stay in our DB.

State of main (ebd7e7c4) this builds on:
- Settings already has an Integrations group and dialog (`src/components/settings/sections.ts`
  `INTEGRATION_TABS`, `integrations-dialog.tsx`, `src/actions/integrations.ts`
  `getIntegrationStatuses`, `?integration=`), plus `src/lib/oauth-return.ts` and `oauth-revoke.ts`.
- The connector backbone is live (PR #137): ingest spine `src/lib/ingest/events.ts`
  (`NetworkEvent` → `openIngestContext`/`ingestEvents`/`finalizeIngest`), external-id contract
  `src/lib/ingest/external-id.ts`, scheduler `src/lib/sync-scheduler.ts` (`runSyncPass`), leases
  and backoff in `src/lib/provider-connections.ts`, `syncStateColumns()`, public API `/api/v1/*`,
  outbound webhooks, MCP server, `canUseSync`/`canUseApi` entitlements, `RATE_LIMITS`, ops alerts.
- Gaps: no connector **registry** (`runSyncPass` hardcodes three families; `PROVIDER_TABLES` knows
  only google/microsoft; Luma/Eventbrite sync on a parallel path and are missing from the dialog);
  no **continuous contact sync** (contacts are one-shot staged imports); no **write-back** path;
  Outlook Calendar sync is stranded on `claude/calendar-contact-enrichment-6e5bbd` (`11ee7eba`);
  Google consent split is stranded on `claude/launch-p4` (`c74dd8dd`).

## Depth ladder (the vocabulary for every connector)

| Level | Meaning | Existing example |
|---|---|---|
| L0 File | upload / export a file | LinkedIn CSV, vCard |
| L1 Connect | OAuth/key, one-shot import or on-demand lookup | Outlook contacts, Apollo |
| L2 Continuous read | scheduled/pushed sync into the ingest spine | Google Calendar |
| L3 Write-back | Orbit pushes follow-ups / logged activity / new contacts out | (none yet) |
| L4 Embedded | Orbit shows up *inside* the other tool | browser extension, MCP |

Hub rule: every connector reads as wide as its API allows; **write-back is limited to three
verbs** — *follow-up → task*, *interaction → activity log*, *new contact → record* — and is always
opt-in per connection. No field-level two-way contact sync anywhere.

## Connector map

### Tier 1 — the daily loop (mail, calendar, address book)
| Service | Target depth | Notes |
|---|---|---|
| Gmail | L2 | Continuous **metadata-only** email interactions (from/to/date/subject → `email` NetworkEvents → last-contacted, closeness evidence). Body/AI summary opt-in. Keeps recruiter scan. Blocker: `gmail.readonly` is a Google *restricted* scope → CASA assessment + Limited Use disclosure (audit already flagged the privacy page). |
| Google Contacts | L2 | People API sync tokens instead of one-shot. Write new contacts (L3) deferred. |
| Google Calendar | L2 (done) | Stays read-only; outbound stays the zero-scope ICS feed. |
| Outlook mail | L2 | `Mail.ReadBasic` (metadata, no bodies) + Graph delta. |
| Outlook Calendar | L2 | Harvest `11ee7eba`. Teams *meetings* arrive here for free. |
| Outlook People | L2 | `Contacts.Read` + `People.Read` via delta queries. |
| Apple Contacts | L2 | iCloud CardDAV, app-specific password, ctag/etag sync. |
| Apple Calendar | L2 | iCloud CalDAV, same credential; reuses `calendar-import.ts` ICS parsing. |
| LinkedIn | L0 + L4 | No API; never scrape server-side. Deepen the extension (log message threads as viewed) and make CSV re-upload a *diff* with a periodic re-export nudge. |
| **+ BCC/forward address** (new) | L2 | `log-<token>@…` inbound mail → interaction. Works with Apple Mail and any client, zero OAuth. Rides the existing Resend inbound webhook. |

### Tier 2 — follow-ups where you already work (the write-back tier)
| Service | Target depth | Notes |
|---|---|---|
| Apple Reminders | L3 via Shortcut | No server API (iCloud reminders left CalDAV in iOS 13). Ship a signed Shortcut: pull `GET /v1/followups` → create Reminders; push completed ones back. Runs on a Shortcuts automation. |
| Apple Notes | L1 via Shortcut/share sheet | "Send to Orbit" → new `POST /v1/notes` → capture pipeline (note processing already exists). |
| **+ Microsoft To Do** (new) | L3 | `Tasks.ReadWrite`; the Microsoft twin of Reminders, same OAuth app as Outlook. |
| **+ Google Tasks** (new) | L3 | Same Google connection, one incremental scope. |
| **+ Todoist** (new) | L3 | Clean API, popular with the target user. |

### Tier 3 — second brain, sheets, long tail
| Service | Target depth | Notes |
|---|---|---|
| Notion | L1 + L3 | Import a people database (property mapping); live one-way mirror Orbit → a Notion database with Orbit-owned properties. |
| Google Sheets | L1 + L3 | `drive.file` + Picker (non-sensitive scope): import with the existing column mapper (`contacts-file-import`), live one-way export. |
| Obsidian | L4 | Community plugin on the public API: contacts as markdown + frontmatter, notes linking a person pushed back as interactions. |
| **+ Zapier/Make app** (new) | L4 | Thin wrapper on the existing API + webhooks; covers Airtable, Attio, Pipedrive, Affinity, Slack, etc. without bespoke connectors. |
| **+ "Switch from" importers** (new) | L0 | Dex / Clay / Folk / generic CSV — acquisition lever, reuses the import engine adapters. |
| **+ WhatsApp chat export** (new) | L0 | Upload `.txt` export → `message` events. No API exists; high value outside the US. |

### Tier 4 — work systems (per-user, not org installs)
| Service | Target depth | Notes |
|---|---|---|
| HubSpot | L2 + L3 | First: free tier, easy OAuth. Read my owned contacts + engagements; write-back = log activity on matched record, create contact on explicit action. |
| Salesforce | L2 + L3 | Same shape (Contacts/Leads I own, Tasks/Events). Needs API-enabled editions. |
| Apollo | L1 (+lists) | Keep enrichment; add "import my Apollo lists/contacts"; feed warm-lead discovery (target company × who I know). |
| Teams chat | L2, opt-in, last | Work accounts only; many tenants block user consent. Metadata only (who/when). Meetings already covered by Outlook Calendar. |
| Confluence | L1, light — **recommend defer** | Weak fit for individuals (team wiki). If built: Atlassian 3LO read-only, pages mentioning a contact → linked references. Zapier/MCP covers it until demand shows. |
| **+ Meeting notetakers** (Fathom, Fireflies) (new) | L2 | Webhook → `/v1/events` with transcript summary + action items → suggested reminders. |
| **+ Calendly / Cal.com** (new) | L2 | Booking webhooks give email + intake answers the calendar event lacks. |
| **+ Slack** (new) | L4 light | `/orbit` lookup + follow-up DMs. Reading DMs needs admin approval → skip. |

Explicitly out: iMessage/SMS (needs a native Mac app), server-side LinkedIn scraping, org-level
CRM installs, field-level two-way sync, Partiful/Telegram/Discord.

## Foundation work (Phase 0 — before any new connector)

1. **Harvest stranded work**: port `11ee7eba` (Outlook Calendar) and review `c74dd8dd`
   (per-capability Google consent) as the incremental-consent precedent.
2. **Connector registry** — `src/lib/connectors/registry.ts`. One manifest per connector: `id`,
   `family` (people · conversations · calendar · tasks · knowledge · crm · enrichment · automation),
   `auth` (oauth2 · api_key · dav_password · file · extension · api_token), `capabilities`
   (importContacts, syncPeople, syncEvents, writeTasks, logActivity, writeContact), scopes **per
   capability**, entitlement, rate bucket, status lookup, sync fn. The registry drives
   `runSyncPass`, `getIntegrationStatuses`, the Integrations dialog tabs (replacing hardcoded
   `INTEGRATION_TABS`), `account-alerts`, `ops-alerts`, and the `purgeUserData` category registry.
   Luma/Eventbrite get registered too.
3. **Credentials** — keep `gmail_connections`/`outlook_connections` (the header of
   `provider-connections.ts` rejects *migrating* them, rightly). Add **one** generic
   `connector_connections` table for every new provider, shaped like `event_provider_connections`
   (`provider`, `auth_kind`, AES-GCM encrypted tokens via `src/lib/crypto.ts`, `scopes`, `status`,
   `syncStateColumns()`), reached only through `provider-connections.ts`. New-table migration path:
   DDL template + `SCHEMA_VERSION` bump (scan all branches for the next free version).
4. **People stream** — `src/lib/ingest/people.ts`: the contact analogue of `ingestEvents` for
   delta-token sources, built on the same `buildDuplicateIndex` / `createContactsBulkForUser` /
   `bulkMergeContactsForUser` / `claimIdentities` primitives. Staged import engine stays for files.
5. **Write-back** — `external_links` (orbit entity ↔ remote id per connection) + `connector_outbox`
   modelled on `outbound_webhook_deliveries` (same retry/backoff/disable rules in
   `webhooks/dispatch.ts`), drained by a new GitHub Actions entry in `.github/workflows/ops.yml`.
6. **Generic OAuth2 helper** — state + PKCE + `oauth-return.ts` + refresh-rejection →
   `needs_reauth` + `oauth-revoke.ts`, so a new provider is config not code.
7. **API additions** for Shortcuts / Obsidian / Zapier: `POST /v1/notes`, `PATCH /v1/followups/:id`
   (complete/snooze), `GET /v1/interactions`, `updated_since` cursors on list routes; extend
   `openapi.json`.
8. **Guardrails** — email volume must flow through coverage-aware closeness (`loadCoverageSources`),
   not raw counts; metadata-only defaults; scheduler fairness beyond today's 5-connections/run
   (prefer push: Gmail watch, Graph subscriptions, HubSpot/Notion webhooks); new internal routes
   added to `PUBLIC_ROUTES` + `isInternalRequest`.

Non-code long poles to start early: Google CASA/restricted-scope verification, Microsoft publisher
verification, Notion/HubSpot/Salesforce/Atlassian app listings.

## Phasing

- **P0** Foundation (above).
- **P1** Tier 1: Gmail metadata, Google Contacts continuous, Outlook mail/calendar/people, iCloud
  CardDAV/CalDAV, BCC address.
- **P2** Tier 2: tasks family write-back + Apple Shortcuts + Notes capture.
- **P3** Tier 3: Notion, Sheets, Obsidian plugin, Zapier app, switch-from importers, WhatsApp.
- **P4** Tier 4: HubSpot → Salesforce → Apollo lists → notetakers/Calendly → Slack → Teams chat;
  Confluence only on demand.

Each phase gets its own spec → plan → implementation cycle (brainstorming → writing-plans).

## Next specs

1. **Integrations UI**: a registry-driven connect experience (catalog by family, one connect
   flow per auth kind, per-capability toggles, health/reauth). It resolves today's duplication
   between `/imports` and the Integrations dialog, and folds in Luma/Eventbrite (`/events`) and
   the onboarding wizard.
2. **P0 foundation.**

## Verification (for P0)

- `npx tsc --noEmit`, eslint 0 errors, registry smoke script (every connector
  has status lookup + purge category + rate bucket; registered in the smoke manifest), PGlite DDL
  run for the new tables (forced temp PGlite via `scripts/smoke/_env.ts`, never Neon), existing
  `smoke-import-engine` / sync smokes still green, Integrations dialog renders from the registry
  in the demo-mode preview.
