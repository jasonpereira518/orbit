# Orbit Chrome extension revision — design + phased plan

## Context

The extension (`extension/`, MV3 side panel, shipped in PR #95, never published) does one thing: read the person on the current page, say whether you know them, and capture them. Jason's goals: it **feels too thin**, it must be **Chrome Web Store ready**, and a **rethink is allowed**.

Exploration showed the thinness is mostly unfinished seams, not missing foundations:

- Non-person pages dead-end at "Nothing to add here". No search, no due-today, nothing on company pages.
- Built but unused: `GET /api/extension/contacts?q=` has no client; most of `MeResponse` and half of `ContactSnapshot` never render; multi-person reads (`PageContext.candidates`) are extracted and never shown; save `warnings` dropped; "Snooze" creates a new follow-up instead of snoozing the reminder.
- `contact_profiles` / `contact_experiences` have no extension producer (PR #133's DOM readers were reverted in `68fff0df`, never verified on real markup).
- Opening the side panel from the icon does not grant `activeTab`, so every site starts with a grant wall and sites outside LinkedIn/X/Gmail can't be read at all.
- The web app barely knows the extension exists: no install detection, settings tab, welcome page or marketing copy; `canUseExtension` is sold as paid and enforced nowhere; `/resolve` uses `ILIKE` instead of the `contact_identities` spine.
- Launch gaps: zero tests in `extension/`, no `/api/extension` smoke script, privacy copy says "LinkedIn profile" only, no store listing material.
- Live bugs found in passing: a note typed for contact A can be saved to contact B (`KnownContactView` has no `key`, never registers dirty); `forceCreate` and `sealed` never reset on navigation; `/me` refetched on every navigation (4 calls per profile against a 60/min budget).

## Decisions made with Jason

1. **Shape: Companion + Home.** No injected UI on host pages.
2. **Gating: free core, paid depth.**
3. **Work history: model reads page text**, no clicks, no DOM section readers.
4. **Contexts:** multi-person pick lists, company & team pages, GitHub profiles, right-click. Gmail bodies and Google Calendar stay out.

Two refinements to confirm at review:
- **Search tiering.** Keyword search stays free (quick-note-about-anyone and "link to an existing contact" need a picker, and the installed v1 build calls it). Pro gets hybrid semantic search. 
- **Cut from this revision:** the ambient toolbar badge (`/identities`), a `github_login` identity kind (needs a contacts column + DDL + duplicate-spine changes; GitHub matches via `website` plus the email/X/LinkedIn links on the page instead), company matching by domain/LinkedIn slug (nothing stored to match), skills/certs extraction, tag removal, a blocking onboarding step, replacing Clerk `syncHost`.

## What the extension does

| Route in the panel | When | Shows / does |
|---|---|---|
| **Person** (known / new / ambiguous) | profile pages, threads, posts, a picked row, a right-clicked link | Known: what changed, open reminders with real complete/snooze, open loops, tags, 3-item timeline, notes preview, how you met, what to say, work history, note + follow-up. New: the record-row capture, inline note, follow-up, duplicates, save warnings. "Capture work history" (Pro) on LinkedIn profiles and `/details/experience`. |
| **People** | LinkedIn search/My Network/company-people, multi-party threads, team pages | One batch resolve, rows marked known or new, pick one at a time, back chip. Never "add all". |
| **Company** | LinkedIn company/school pages, GitHub orgs, company sites | "You know N people here" (count free, list Pro): current by `contacts.company`, former by `contact_experiences`. |
| **Home** | any other page, no grant, restricted pages | Tab hint, search, due today, quick note about anyone (search, pick, note), account row. |
| System | signed-out, error, update-required | As today, plus update nag from `contractVersion`. |

Locking is a per-section `<Locked feature>` row inside routes, never a route. Entry points: toolbar icon, `Cmd/Ctrl+Shift+O`, right-click **Add to Orbit** on a profile link (resolves from the URL, never visits or fetches it), right-click **Save selection as a note about…**, a `quick-note` command.

README's "deliberately does not do" list is kept in full. One sentence is amended: selection text passes through `chrome.storage.session` (memory only, capped, deleted on consume).

## Permission model rework

`extension/src/background/index.ts`: `openPanelOnActionClick: false`; in `action.onClicked`, `contextMenus.onClicked` and `commands.onCommand`, call `chrome.sidePanel.open({ windowId })` synchronously (no `await` first), then write an intent to `chrome.storage.session` key `orbit:intent` (`action | link | selection | quick-note | session-poke`, with `id`, `at`, `tabId`, `windowId`). The panel reads it on mount, subscribes to `storage.session.onChanged`, ignores stale (>10s) or other-window intents, deletes on consume.

Result: the click grants `activeTab`, so first use on any site needs no grant screen. Same-origin SPA navigation keeps the grant; cross-origin navigation or an un-invoked tab falls to Home with a one-line hint ("Click the Orbit icon to read this tab", plus "Always follow LinkedIn" on known sites). Persistent optional host grants become the auto-follow upgrade, moved into a Settings sheet (`GrantAccessView` becomes `SiteAccessSettings`). GitHub is added to `optional_host_permissions` and `KNOWN_SITES` together.

**This rests on Chrome behaviour reasoned from docs, not tested.** Spikes before building on it: S1 `sidePanel.open()` in `action.onClicked` grants `activeTab` and the panel can `executeScript`; S2 same for context menu and command; S3 which navigations keep or drop the grant; S4 icon click with the panel already open re-grants; S5 web-app gesture carries through `onMessageExternal` (only gates an optional `open-panel` message); S6 Chrome for Testing headless loads `--load-extension` in CI. If S1 fails, fall back to today's grant model with GitHub added, and keep everything else.

Manifest diff: `+contextMenus`, `+https://github.com/*` optional host, `+externally_connectable: { matches: [appOrigin/*] }`, `+commands.quick-note`. `minimum_chrome_version` stays 116.

## How it talks to the web app

**Contract v2** (`src/lib/extension/contract.ts` + `contract.schema.ts`), additive only; server keeps v1 valid indefinitely and deploys before the client; client gates new behaviour on `me.contractVersion >= 2` (enum additions like `site: "github"` fail on an old server).
- `MeResponse` gains `entitlements { plan, planLabel, contactLimit, contactsRemaining, features: Record<"starters"|"workHistory"|"company"|"search", boolean> }`, `minSupportedContractVersion`, `links`.
- New error code `feature_locked` → HTTP **402** with `feature` and `upgradeUrl`; message must read well verbatim for v1 clients.
- `PageSite += "github"`; `PageContext.company?`, `section?`; `PageCandidate.email?`, `handle?`; `SaveContactRequest.captureProfile?`; `ContactSnapshot.experienceCount?`, `profileCapturedAt?`; `ContactSearchResponse.mode`.

**Routes** (all through `extensionRoute`, which gains `entitlement?`, `maxBodyBytes?`, `ctx.entitlements`, and a `deferSafely` wrapper around `after()` so smoke tests can drive handlers):

| Route | Tier | Notes |
|---|---|---|
| `GET /me` | free | v2 fields; panel caches 5 min |
| `GET /home` | free | due reminders (≤10) + recent contacts (≤8) + counts, 3 parallel statements |
| `POST /resolve` | free | identity spine first (below) |
| `POST /resolve-batch` | free | ≤10 candidates, ≤2 statements, name-only hits never `confident` |
| `GET /contacts?q=` | keyword free / hybrid Pro | `hybridSearchContacts`, 2.5s race, falls back to ILIKE |
| `POST /contacts`, `/interactions`, `/follow-ups`, `/parse` | free | `/contacts` gains `captureProfile`; replaced photos get blob-deleted |
| `POST /reminders` | free | id in body; wraps `completeReminder`/`snoozeReminder`/`reopenReminder` in `src/lib/reminders.ts`; extract `clearContactFollowUpForUser` from `src/actions/reminders.ts` so completing a follow-up also clears `contacts.nextFollowUpAt` |
| `POST /starters` | Pro | free gets 200 degraded with `degradedReason: "plan"` and heuristics, so v1 builds don't regress |
| `POST /company` | count free, list Pro | new `src/lib/extension/company.ts`; reuse `normalizeCompanyKey` / `canonicalCompanyClusterName`; align `loadNetworkOverlap` with it |
| `POST /profile` | Pro | work history, below; `maxDuration = 60`, `maxBodyBytes 256_000` |
| `POST /gate` | free | records the throttled gate hit on a lock-row click |

**Entitlements** (`src/lib/entitlements.ts`): `canUseExtension` becomes true on every plan; add `canUseExtensionPro: paid` and FeatureKey `extensionPro`. Gate hits are recorded on user intent (lock click → `/gate`) and by the wrapper's 402 backstop, through a new throttled `recordExtensionGateHit` in `src/lib/gate-events.ts` (one `INSERT … WHERE NOT EXISTS` per user, sub-feature, 24h; no schema change). Pricing table, FAQ and promo copy change in the same PR as the entitlement so claims and enforcement never disagree.

**Resolve on the identity spine** (`src/lib/extension/resolve.ts`): step 1 `identityKeysFor` + `findIdentityOwners` (one indexed probe); exactly one owner → snapshot, `confident`, skip the matcher. Step 2 only otherwise: today's query with the LinkedIn `ILIKE` swapped for `eq(contacts.linkedinSlug, slug)`, then `matchAgainst`/`classify` unchanged. `matchesForPage` (the save-path duplicate guard) gets the same two steps. Emit the LinkedIn key only when the host is linkedin.com.

**Work history** (new `src/lib/extension/profile-capture.ts`, guards ported from `git show 68fff0df^:src/lib/extension/profile-capture.ts`): LinkedIn person pages only; contact must already exist (or be created in the same user-confirmed save); fail-closed slug guard returning `conflict` with zero model calls; `confirmMismatch` never rewrites `linkedinUrl`; degraded 200s for no key / no text. One model call over a fenced, 40k-char page block (extend `untrustedPageBlock` with `maxChars`), `operation: "extension.profile"`. Model-output schema **clamps, never 400s**. Writes only through `saveContactProfile` (`src/lib/contact-profile.ts`, source `"extension"`, already refuses empty wipes). If the text was truncated and would store fewer roles than exist, return `partial` and write nothing. Extension side: detect `/in/<slug>/details/*`, cap by bytes, send the full text only to `/profile` on a user click (a light 8k copy goes to resolve/parse/starters), and show a text-only hint when the profile shows a shortened list. No navigation button.

**Handshake**: `externally_connectable` limited to the app origin; worker answers `orbit/hello` → `{version, contractVersion, grantedSites}` and `orbit/session-changed` (writes a `session-poke` intent so the panel rechecks sign-in). Checks `sender.origin`, returns no user data, accepts no URLs or payloads. Web app combines the ping with server-side `extension_usage.lastSeenAt`.

**Web-app surfaces** (paths on `origin/main`): Settings → Integrations "Browser extension" tab (`src/components/settings/sections.ts`, new `integrations-extension-tab.tsx`); promo hides when installed and gets free-core copy (`extension-promo.tsx`, dismiss key `-v2`); static Clerk-free `src/app/(site)/extension/welcome/page.tsx` opened on install instead of `/dashboard`; one nudge card on the wizard review screen (desktop Chromium only); landing section; two pricing rows in `plan-comparison.tsx`; contact-page provenance; admin `extensionPro` row. Shared `src/lib/extension/links.ts` (zero imports) for store URL and extension ID.

**Auth**: keep Clerk `syncHost`. Add an account row (name, plan, "Manage account" opens the app). No `signOut()` from the panel.

## Sub-projects, in order

Each is independently shippable and gets its own spec → plan → implementation cycle (`docs/superpowers/specs/`, then writing-plans). Server ships before client in every pair. **No schema changes anywhere in this revision.**

0. **Baseline + hygiene.** Merge `origin/main` (extension diff there is only `tokens.css`). Fix the wrong-contact note bug, `forceCreate`/`sealed` reset, offline-by-string-match, `/me` caching. Surface existing data: real reminder snooze/complete, reminders band, tags, timeline, notes preview, how-you-met, inline note on capture, save warnings, update nag, Settings sheet + account row. Add `extension/src/lib/browser.ts` (injectable chrome wrapper), vitest + happy-dom, shared identity vectors (`extension/test/vectors/identity.json`, consumed by both the extension tests and an app-side test, replacing the unenforced "byte-identical" rule), CI lint + test, dev-only sanitizing fixture saver.
1. **Permission rework.** Spikes S1–S4, worker + intents, `useTarget`, tab hint, grant UI into Settings. No server work; biggest single UX win.
2. **Server foundation.** Contract v2, `extensionRoute` options, entitlement reshape + throttled gate recorder, `/me` v2, `/gate`, `/starters` plan-degrade, pricing/FAQ/promo copy, `scripts/smoke-extension-api.ts` skeleton (registered in `scripts/run-smoke.ts`, first import `./smoke/_env`, non-demo user IDs).
3. **Routing + Home.** Split `usePanel` into `useTarget` / `useDraftGuard` / `usePageRead` / `usePanelData` + pure `state/route.ts` (`deriveRoute`) + `PanelServices` context; `RouteView`, `HomeView`, `Locked`, `ContactPicker`, `NoteComposer`; harness renders routes from fixtures. Server: identity-spine resolve, `/home`, `/reminders`, search modes.
4. **People + Company + GitHub + right-click.** `/resolve-batch`, `/company`; `PeopleView`, `CompanyView`, `PersonRow`; LinkedIn company-people and generic team pages; `adapters/github.ts` (before generic in the registry; social links yield LinkedIn/X match keys); context menus + identity-only pages + selection-to-note.
5. **Work history.** `/profile`, `captureProfile` on save, `WorkHistoryAction`, details-page detection, `scripts/eval-extension-profile.ts` with pasted-text fixtures. **Does not merge until the eval passes on ≥5 real fixtures with zero invented employers.**
6. **Web-app surfaces + handshake.** Settings tab, welcome page, promo detection, wizard nudge, landing section, provenance.
7. **Launch.** Privacy paragraph rewrite (any page you open the panel on, right-click sends only the link, nothing in the background) with `TERMS_VERSION` + `LEGAL_LAST_UPDATED` in the same commit, shipped with the deploy that widens contexts; `docs/extension/store-listing.md` (single purpose, per-permission justifications, data-use answers, copy, screenshot list from the harness); `docs/RUNBOOK.md` extension release section; `extension/docs/release-checklist.md` recording spike results and the manual gesture checks; headless E2E job (`extension/e2e/`, reusing `scripts/dev/cdp.mjs`, `vite build --mode e2e` with a stub API; `scripts/zip.mjs` rejects any localhost host), `continue-on-error` until stable.

## Critical files

Extension: `extension/manifest.config.ts`, `src/background/index.ts`, `src/lib/{page,permissions,api,env}.ts`, `src/panel/App.tsx`, `src/panel/state/usePanel.ts`, `src/panel/views/{KnownContactView,CaptureView,GrantAccessView}.tsx`, `src/inject/adapters/{linkedin,generic,gmail,registry}.ts`, `src/inject/dom/{url,text}.ts`, `dev/preview.tsx`, `scripts/zip.mjs`, `README.md`.
Server: `src/lib/extension/{http,contract,contract.schema,resolve,writes}.ts`, `src/app/api/extension/*`, `src/lib/entitlements.ts`, `src/lib/gate-events.ts`, `src/lib/money-metrics.ts`, `src/lib/reminders.ts`, `src/lib/contact-profile.ts`, `src/lib/conversation-starters.ts`, `src/lib/hybrid-search.ts`, `.github/workflows/ci.yml`.

## Verification

- Per sub-project: `npm --prefix extension run typecheck && lint && test && build`; app `tsc`, eslint (0 errors baseline), `npm test` including `smoke-extension-api`, `smoke-entitlements`, `smoke-toast-copy`, `smoke-legal-pages`, `smoke-contact-profile`.
- `smoke-extension-api.ts`: entitlement matrix per route (free vs comped), gate throttle (3 locked calls → 1 row), duplicate → force, merge-union, identity-spine resolve (locale-variant URL, legacy row, two owners → ambiguous), batch resolve statement budget, reminder round-trip clears `next_follow_up_at`, profile capture (conflict with zero model calls, no-wipe, clamp regression for the old 400, partial refusal) with an injected model function.
- Panel: every route and state as a harness fixture (`npm run preview:design`), screenshots checked over headless Chrome/CDP, not the occluded pane.
- Manual (can't be automated): real toolbar gesture + `activeTab` behaviour, context-menu clicks, live LinkedIn/X/GitHub, sign-in handshake, against a non-demo user so gating is visible.

## Manual steps for Jason

Vercel env (`EXTENSION_ORIGIN` Production only, `NEXT_PUBLIC_EXTENSION_URL`, `NEXT_PUBLIC_EXTENSION_ID`); Clerk allowed origin for `chrome-extension://<id>`; Web Store developer account, listing, data-use form, screenshots; keep `key.pem` safe; save ~5 anonymised LinkedIn text fixtures (incl. `/details/experience`, grouped roles, a sparse profile) and run the eval; the release-checklist gesture checks. Terms re-acceptance will prompt every user once.
