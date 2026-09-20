# Integrations UI — one home for every connector

Status: design approved 2026-09-19. Companion to
`2026-09-19-integrations-strategy-design.md`, which settles *which* connectors and *how deep*.
This spec settles *where a user connects them and manages them*.

## Context

Connecting something to Orbit today happens in four unrelated places: `/imports` (LinkedIn CSV,
Google/Outlook contacts, calendar subscriptions), the Settings → Integrations dialog (AI key,
outreach keys, calendar feed, API keys, webhooks, plus the same four importers), `/events`
(Luma, Eventbrite) and `/recruiters` (Gmail). The same Google connection is offered from two
surfaces with different copy, and neither shows what is connected overall.

The strategy spec adds roughly 25 connectors across eight families, several of which write back
to the other tool. A flat nine-item side nav cannot carry that, and a user cannot answer "what is
Orbit plugged into, and is any of it broken?" from any screen we have.

Settled decisions:
- **The Settings Integrations dialog is the one home.** No `/integrations` page.
- **Home view + detail pane.** The dialog opens on an overview; a provider opens a detail pane.
- **Read on, write off.** Connecting grants read scopes and turns reads on; every write-back
  capability is off until enabled, which triggers incremental consent.
- **Long jobs detach.** Closing the dialog never cancels an import.
- **`/imports` is retired** and redirects into the dialog.
- **Unbuilt connectors are listed with a Request button** that records a vote.

## Architecture

### The registry is the source of truth

The UI reads the connector registry from the strategy spec's P0
(`src/lib/connectors/registry.ts`) and renders itself. Adding a connector must mean adding a
manifest entry plus a detail panel — never editing the nav, the icon map, the status fan-out, the
deep-link table and the alert CTAs one at a time, which is the drift `sections.ts` already warns
about in its header comment.

Each manifest entry carries what the UI needs: `id`, `label`, `family`, `auth`, `capabilities`
(each with `direction: "read" | "write"`, a label, and the scopes it needs), `status` (the
lookup), `availability` (`"available" | "planned"`), `entitlement`, and `icon`.

`INTEGRATION_TABS` in `src/components/settings/sections.ts` is replaced by a derivation over the
registry. `integrationHref`, `isIntegrationTabId` and `INTEGRATION_TAB_FOR_LEGACY_HASH` keep
their names and behaviour, so existing deep links and `account-alerts.ts` CTAs keep working.
`INTEGRATION_ICONS` in `integrations-dialog.tsx` moves into the manifest.

The five service tabs that are not really connectors — AI provider, Outreach keys, Calendar feed,
API & connectors, Webhooks — stay as they are, in a separate nav group below a divider. They are
settings sections, they keep their surface keys, and an operator hiding `settings.webhooks` must
still hide that tab.

### Layout

```
┌ Integrations ─────────────────────────────┐
│ Home         │ 🔍 Search tools…           │
│ Mail         │ CONNECTED (4)              │
│ Calendar     │ ● Google  ● Outlook        │
│ Contacts     │ ● iCloud  ⚠ HubSpot reauth │
│ Tasks        │                            │
│ Notes & docs │ MAIL                       │
│ CRM          │ [Gmail ✓] [Outlook ✓]      │
│ Automation   │ [BCC address]              │
│ ─────────    │ TASKS                      │
│ AI provider  │ [Reminders] [To Do] [Todoist]│
│ API & hooks  │ …                          │
└──────────────┴────────────────────────────┘
```

- **Nav** lists the eight families plus Home, then the five service sections. Roughly 14 rows,
  stable as connectors grow. It reuses the existing responsive `useIsWide` treatment: on narrow
  screens the nav collapses and Home is the entry point.
- **Home** shows a Connected strip (every live connection, with health) and then the full catalog
  grouped by family. Search filters the catalog by label, family and alias ("iCloud" finds Apple
  Contacts; "Teams" finds Outlook Calendar).
- **A family row** in the nav scrolls Home to that family rather than opening a separate view —
  one less state to manage, and search keeps working.
- **Detail pane** replaces the catalog when a card is clicked, with a Back control. It shows the
  account identity, capability toggles, health/last-synced, and Disconnect
  (`disconnect-account-dialog.tsx` already exists and is reused).

### Capability toggles and consent

A detail pane lists capabilities from the manifest, split into what Orbit reads and what Orbit
writes out. Reads granted at connect time are on. Writes are off, and enabling one:

1. checks whether the connection already holds the scope; if not, starts an incremental consent
   round trip through the generic OAuth helper, returning via `oauth-return.ts` to the same
   detail pane (the return URL carries `?integration=<id>`);
2. on return, persists the capability as enabled and enqueues the first outbox pass.

Write toggles state their effect in one line before the switch — "Creates a reminder in your
Apple Reminders list for each Orbit follow-up" — because the user is about to let Orbit put rows
in another system.

A connector whose entitlement the plan does not cover renders through the existing
`LockedFeature` treatment rather than being hidden, matching how `/imports` gates calendar today.

### Status and health

`getIntegrationStatuses` in `src/actions/integrations.ts` keeps its shape — the per-lookup 8s
`settle()` timeout and the `"unknown"` fallback are good and stay — but iterates the registry
instead of a hardcoded fan-out of six. Two additions:

- `needs_reauth` becomes a first-class state, rendered as a warning dot with a Reconnect action
  in the Connected strip, so a dead connection is visible without opening anything.
- The Connected strip is the single place that answers "is any of this broken?", which is what
  `account-alerts.ts` codes (`connection.gmail`, `connection.outlook`, `calendar.sync_error`)
  link to.

### Long-running jobs

Starting an import hands it to the existing `import-job-runner` singleton
(`src/lib/import-job-runner.ts`) and renders `ImportProgress` inline on the provider's card and
detail pane. Closing the dialog leaves the job running; the notification center carries progress
and completion. Reopening the dialog auto-opens the running job's detail pane — the behaviour
`tabForImportJob` already implements, now driven by the registry.

The dialog's existing deep-link discipline is preserved verbatim: `?integration=` is read during
render, not in an effect, and `clearDeepLink()` strips the param **only on close**. The comment
in `integrations-settings.tsx` explaining why stripping on open silently dropped a queued server
action must survive this refactor — it is the `replaceState`-drops-server-actions trap.

### Planned connectors

A manifest entry with `availability: "planned"` renders as a muted card with a Request button. A
request writes a row keyed by `(user_id, connector_id)` — unique, so the button reads "Requested"
afterwards — reusing the feedback table's pattern. `/admin/feedback` gains a tally view so the
vote counts pick the next connector to build.

Planned cards are never focusable-but-dead: the card's only action is Request.

### Retiring `/imports`

`/imports` and its hash anchors redirect (308) to `/settings?integration=<id>`, mapped through
`INTEGRATION_TAB_FOR_LEGACY_HASH`. The importer components themselves already render inside the
dialog and are unchanged; only their page host goes away. The nav item points at the dialog.
Calendar subscriptions and the file importers (`contacts-file-import`, calendar file) become
registry entries so nothing currently reachable only from the page is lost.

Luma and Eventbrite move out of `/events` into the registry under an Events family; `/events`
keeps a link to the dialog. Gmail's recruiter connection keeps its `page.recruiters` surface key
while living in the catalog.

### Onboarding

The wizard's import step embeds a curated slice of the same catalog — a `families` filter over
the registry, not a second component — so what onboarding offers can never drift from what
Settings offers.

## Out of scope

A standalone `/integrations` page; per-field mapping UI (a connector's mapping lives in its own
detail pane if it needs one); admin/org-level connection management; changing how any existing
importer parses files.

## Verification

- `npx tsc --noEmit` clean; eslint 0 errors (baseline is 0 errors / ~36 warnings, so any error
  is ours).
- A registry smoke script asserting every manifest entry has an icon, a status lookup, a rate
  bucket, a purge category and an entitlement, and that every `INTEGRATION_TAB_FOR_LEGACY_HASH`
  key still resolves. Registered in the smoke manifest — an unregistered smoke script kills the
  whole suite.
- `scripts/smoke-oauth-return.ts` and `smoke-oauth-revoke.ts` still pass; a new case covers
  incremental consent returning to the right detail pane.
- Redirect check: every old `/imports#anchor` lands on the matching tab.
- Visual verification in the demo-mode preview over CDP (a hidden pane starves rAF and passes
  vacuously): Home renders families and the Connected strip, search filters, a detail pane opens
  and goes back, a running import survives closing the dialog, and the dialog is usable at phone
  width with no horizontal scroll.
