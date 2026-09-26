# Integrations P2b — The Google and Microsoft account pages

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Google and Microsoft pages of the Settings → Integrations dialog into "connect once, then a row per feature" — Contacts, Meetings, Recruiters in inbox, Send from your email, Reminders — so the whole account is one place, the Overview's Connect button starts the consent screen itself, and the Outlook recruiter scan is reachable from Settings for the first time.

**Architecture:** The four existing panels (Google contacts, Outlook contacts, Gmail scan, Outlook scan) are near-twins whose connection chrome is duplicated four times. Three hooks are extracted from them first — `useProviderConnection`, `useContactsImport`, `useRecruiterScan` — and the existing panels adopt them with no visual change, so `/imports` and `/recruiters` keep working exactly as they do. The dialog's account pages are then written against those same hooks plus P2a's per-capability status, so the two surfaces can never disagree about what is connected.

**Tech Stack:** Next.js 16 App Router (client components + server actions), React 19, TypeScript, Tailwind v4, Base UI dialog, lucide-react 1.x, `tsx` smoke scripts.

**Spec:** `docs/superpowers/specs/2026-09-22-integrations-dialog-simplification-design.md` — this is the second half of its P2 row. P2a (`…-p2a-connect-model.md`) built the server model this consumes.

## Global Constraints

- Branch: continue on `claude/settings-popup-redesign-0ed30d` (it now carries P1 + P2a, merged with main at `fd48363c`). PR #257 tracks it.
- **Tasks 1–3 change no behaviour and no pixels.** They are pure extractions: `/imports`, `/recruiters` and the dialog must look and behave exactly as before. If a hook changes when a fetch fires or what a toast says, that is a defect.
- The spec's decisions this phase renders: one Connect asks contacts + calendar; mail features ask on first use; everything is free except the recruiter inbox scan (Pro/Lifetime), which renders as a locked row with an Upgrade action; a partial grant is connected, and the feature whose scope is missing offers its own **Allow**.
- Mail access cannot be revoked per feature (Google revokes everything, Microsoft nothing), so rows are never individually revocable — the account header's ⋯ menu holds **Switch account** and **Disconnect**.
- Copy rules: outside Advanced, no "API", "OAuth", "scope", "token", "webhook", "ICS", "feed", "endpoint", "sync" or "BYOK". Buttons verb-first, sentence case. Curly apostrophes (’). Toasts follow `scripts/smoke-toast-copy.ts`; errors go through `friendlyError` / `UserFacingError`, never `err.message`.
- Section ids and surface keys in `sections.ts` are never renamed (`src/lib/surfaces.ts` derives operator hide-lists from them). The Google page's inbox block still follows `page.recruiters`.
- Deep links: `?integration=` is read during render; `clearDeepLink()` strips it **only on close** (the `replaceState`-drops-a-queued-server-action trap). Keep those comments.
- A `history.replaceState` from one panel can drop another panel's in-flight server action — the reason `GmailTab` waits for the OAuth params to be stripped. Whatever replaces that file must keep a single owner for the OAuth return per page.
- Baselines: `npx tsc --noEmit` clean; `npx eslint` 0 errors (~45 warnings, all pre-existing, are the baseline).
- Per `AGENTS.md`, read the relevant guide in `node_modules/next/dist/docs/` before using a Next API not already used in the file you're editing.
- Don't put Tailwind class names in code comments.

## What P2a already provides (consume, don't rebuild)

| Interface | Where | Use in P2b |
|---|---|---|
| `GOOGLE_CONNECT_PURPOSES` / `MICROSOFT_CONNECT_PURPOSES` (`["contacts","calendar"]`) | `src/lib/google-scopes.ts:45`, `microsoft-scopes.ts:99` | what Connect asks for |
| `startGmailOAuth({ purposes })` / `startOutlookOAuth({ purposes })` | `src/actions/gmail.ts`, `outlook.ts` | Connect; single `purpose` still works for one feature |
| `?switched=1` on the callback URL | both callbacks | the "Switched to …" toast |
| `GmailConnectionStatus.hasCalendarScope` / `.syncPaused`, Outlook twins | status actions | Meetings row state |
| `setCalendarSync(enabled)` | `src/actions/gmail.ts:169`, `outlook.ts` | the Meetings switch (Task 4 Step 1 changes its return shape) |
| `googleAccountStatus` / `microsoftAccountStatus` → capabilities `contacts \| meetings \| inbox \| send` with states `on \| available \| not_allowed \| paused \| off \| locked` | `src/lib/integration-status.ts` | what each row renders |
| `previewOutlookContacts()` → `{ connected, contactsScopeGranted, people }` | `src/actions/imports.ts` | Contacts row, same shape as Google's |

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/google-scopes.ts`, `microsoft-scopes.ts` | modify | accept the old `+` separator on a consent screen already in flight |
| `src/components/settings/use-provider-connection.ts` | create | status load + retry, OAuth return (toasts, param strip, switched), connect, disconnect |
| `src/components/settings/use-contacts-import.ts` | create | preview, selection, import job for either provider |
| `src/components/settings/use-recruiter-scan.ts` | create | start, poll, cancel, background-job mirroring for either provider |
| `src/components/imports/google-contacts-import.tsx`, `outlook-contacts-import.tsx` | modify | adopt the hooks; no visual change |
| `src/components/recruiters/gmail-import-panel.tsx`, `outlook-import-panel.tsx` | modify | adopt the hooks; no visual change |
| `src/components/settings/account-page.tsx` | create | shell: connect prompt, header + ⋯ menu, `FeatureRow` |
| `src/components/settings/google-account-page.tsx` | create | the five Google rows |
| `src/components/settings/microsoft-account-page.tsx` | create | the four Microsoft rows |
| `src/components/settings/integrations-dialog.tsx` | modify | mount the account pages; drop the stacked panels and `GmailTab` |
| `src/components/settings/integrations-gmail-tab.tsx` | delete | its job moves into the Google page's inbox row |
| `src/components/settings/integrations-overview.tsx`, `integrations-settings.tsx` | modify | Connect starts the consent screen from the card |
| `src/components/settings/disconnect-account-dialog.tsx` | modify | list only what this account produced |
| `src/actions/gmail.ts`, `src/actions/outlook.ts` | modify | `setCalendarSync` returns a result instead of throwing |
| `scripts/smoke-account-rows.ts` | create | pure: which control each row shows for each capability state |
| `scripts/smoke-google-scopes.ts`, `smoke-microsoft-scopes.ts`, `smoke-settings-layout.ts`, `run-smoke.ts` | modify | separator tolerance, page registry, manifest |

---

### Task 1: Accept a consent screen that left before the separator changed

**Files:**
- Modify: `src/lib/google-scopes.ts` (`parseGooglePurposes`), `src/lib/microsoft-scopes.ts` (`parseMicrosoftPurposes`)
- Test: `scripts/smoke-google-scopes.ts`, `scripts/smoke-microsoft-scopes.ts`

P2a changed the purpose separator from `+` to `.` because form decoding turns `+` into a space. A consent screen opened before the deploy comes back with the old form; today it parses to zero purposes, so that one connect skips its missing-scope check. Accepting both costs one character class and closes the window.

- [ ] **Step 1: Write the failing checks**

Add to both scope smokes (Microsoft twin uses its own names):

```ts
check("a consent screen that left before the separator changed still parses", parseGooglePurposes("contacts+calendar").join(",") === "contacts,calendar");
check("and the current form still parses", parseGooglePurposes("contacts.calendar").join(",") === "contacts,calendar");
check("a mixed pair parses too", parseGooglePurposes("contacts+calendar.recruiter_scan").length === 3);
check("junk in either form is still dropped", parseGooglePurposes("contacts+nonsense.calendar").join(",") === "contacts,calendar");
```

Run: `npx tsx scripts/smoke-google-scopes.ts` — Expected: FAIL on the first check (`""` → no purposes).

- [ ] **Step 2: Accept both separators**

In both files, change the split and extend the comment:

```ts
/**
 * Tolerates a single purpose — a consent screen opened before the list shipped says just
 * `contacts` — and the `+` this used to join with, for a screen opened before that changed.
 */
export function parseGooglePurposes(raw: string | null | undefined): GooglePurpose[] {
  return (raw ?? "").split(/[.+]/).filter(isGooglePurpose);
}
```

Run both scope smokes — Expected: all ok.

- [ ] **Step 3: Typecheck, lint, commit**

Run: `npx tsc --noEmit`; `npx eslint src/lib`; `npx tsx scripts/smoke-google-scopes.ts`; `npx tsx scripts/smoke-microsoft-scopes.ts`.

```bash
git add src/lib/google-scopes.ts src/lib/microsoft-scopes.ts scripts/smoke-google-scopes.ts scripts/smoke-microsoft-scopes.ts
git commit -m "Accept a consent screen that left before the purpose separator changed"
```

---

### Task 2: `useProviderConnection` — one owner for connection chrome

**Files:**
- Create: `src/components/settings/use-provider-connection.ts`
- Modify: `src/components/imports/google-contacts-import.tsx`, `src/components/imports/outlook-contacts-import.tsx`, `src/components/recruiters/gmail-import-panel.tsx`, `src/components/recruiters/outlook-import-panel.tsx`

**Interfaces:**
- Consumes: `getGmailConnectionStatus` / `getOutlookConnectionStatus`, `startGmailOAuth` / `startOutlookOAuth`, `disconnectGmail` / `disconnectOutlook`, `describeOAuthReason`, `friendlyError`, `TOAST_COPY`.
- Produces (used by Tasks 4–6):

```ts
export type GoogleConnection = {
  kind: "google";
  status: GmailConnectionStatus | null;
  loading: boolean;
  failed: boolean;
  busy: boolean;
  retry: () => void;
  refresh: () => void;
  connect: (purposes?: readonly GooglePurpose[]) => void;
  disconnect: (opts: { alsoDelete: boolean }) => void;
};
export function useGoogleConnection(opts: { returnTo: string; enabled?: boolean }): GoogleConnection;
export function useMicrosoftConnection(opts: { returnTo: string; enabled?: boolean }): MicrosoftConnection; // same shape, MicrosoftPurpose, OutlookConnectionStatus
```

Behaviour the hook owns, moved verbatim from the four panels (read them first — `google-contacts-import.tsx:76-120` is the fullest example):
- **Load:** fetch the status on mount when `enabled !== false`; `loading` until the first settle; `failed` on rejection, cleared by `retry()`. Today `GoogleContactsImport` swallows the failure and renders nothing — the hook exposes it instead, and Task 4's pages render a Retry. **The existing panels keep their current rendering** (see Step 3).
- **OAuth return:** read the provider's outcome param (`google` for Google, `outlook` for Microsoft), toast success or `describeOAuthReason(reason, provider, purpose)`, strip `google`/`gmail`/`outlook`/`reason`/`purpose`/`switched` with `history.replaceState`, then re-read the status (a restore drops the in-flight mount fetch — keep that comment). When `switched=1` is present, toast `Switched to ${email}` **after** the status re-read resolves, so the new address is the one named.
- **Connect:** call the start action with the given purposes (default: that provider's `*_CONNECT_PURPOSES`), then `window.location.href = url`; on throw, `toast.error(friendlyError(err, TOAST_COPY.connectFailed))`. `busy` covers the transition.
- **Disconnect:** call the disconnect action with `{ alsoDelete }`, toast as the panels do today, then `refresh()`.

- [ ] **Step 1: Read the four panels and write the hook**

Create `src/components/settings/use-provider-connection.ts` with a shared internal implementation and the two exported wrappers. Keep the doc comment explaining why one hook owns the OAuth return: **two components on one page that both strip the params race, and the loser's queued action is dropped** — that race is what `integrations-gmail-tab.tsx`'s `awaitingStrip` gate exists for, and it disappears once a page has one owner.

- [ ] **Step 2: Prove the hook in isolation**

There is no React test harness in this repo, so the proof is the adoption diff plus Task 8's in-app checks. Do NOT invent a test framework. Instead, add to the hook file a short "Behaviour" comment block listing the five behaviours above, and make Step 3's adoption strictly mechanical so a reviewer can diff intent against it.

- [ ] **Step 3: Adopt in all four panels, changing nothing visible**

For each panel: delete its `status`/`loading` state, its mount effect, its OAuth-return effect, its `connect` and its disconnect handler; call the hook; keep every piece of JSX, every label and every toast string exactly as it is. Two rules:
- `GoogleContactsImport` and `OutlookContactsImport` currently `return null` while the status is loading and after a failed load. **Keep that** for now — Task 4 replaces those call sites; changing them here would be a visible change in `/imports`.
- `GmailImportPanel` and `OutlookImportPanel` receive `connection` as a **prop** from their server page and don't fetch. Give the hook an `enabled: false` mode that skips the load and lets the caller pass the server's status in: `useGoogleConnection({ returnTo, enabled: false })` then render from the prop, using the hook only for connect/disconnect/OAuth-return. Say so in the hook's doc.

- [ ] **Step 4: Verify nothing moved**

Run: `npx tsc --noEmit`; `npx eslint src/components`; `npx tsx scripts/smoke-toast-copy.ts`; `npx tsx scripts/smoke-tap-targets.ts`.
Then a visual diff: start the demo preview (`preview_start` `{ name: "orbit-demo" }`), front the tab (`tabs_select`; confirm the Settings "Manage" button has a `__reactFiber…` key before trusting anything), and confirm `/imports` (Connections tab) and `/settings?integration=google` render exactly as they did — same cards, same copy, same buttons, no console errors. Stop the preview.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/use-provider-connection.ts src/components/imports/google-contacts-import.tsx src/components/imports/outlook-contacts-import.tsx src/components/recruiters/gmail-import-panel.tsx src/components/recruiters/outlook-import-panel.tsx
git commit -m "Give a page one owner for its connection status and sign-in return"
```

---

### Task 3: `useContactsImport` and `useRecruiterScan`

**Files:**
- Create: `src/components/settings/use-contacts-import.ts`, `src/components/settings/use-recruiter-scan.ts`
- Modify: the same four panels

**Interfaces:**

```ts
export function useContactsImport(provider: "google" | "microsoft"): {
  people: ReviewPerson[];
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  remove: (id: string) => void;
  loaded: boolean;
  loading: boolean;          // preview in flight
  contactsScopeGranted: boolean;
  progress: ImportProgressState | null;
  jobRunning: boolean;       // this provider's job, not any job
  load: () => void;          // preview
  start: () => void;         // start the import job
};

// `Scan` is that provider's own status type: GmailScanStatus for google, OutlookScanStatus for
// microsoft. Write it as two wrappers over one implementation, the way Task 2 does for
// connections, so neither provider's type is widened.
export function useRecruiterScan(provider: "google" | "microsoft", initialScan: Scan | null): {
  scan: Scan | null;
  running: boolean;
  phaseLabel: string;
  percent: number | null;
  start: () => void;
  cancel: () => void;
};
```

- [ ] **Step 1: Extract `useContactsImport`**

Move, verbatim in behaviour: the preview call (`previewGoogleContacts` / `previewOutlookContacts`, including the `contactsScopeGranted` narrowing Google already does and P2a added to Outlook), the people/selected/loaded state, the completion effect that clears the review list when this provider's job reaches a terminal state, and `startImportJob({ kind })`. Map each provider's person shape to `ReviewPerson` exactly as the panels do today (`name`, `subtitle` = title · company).

**One deliberate fix, called out because it is visible:** today `busy` is `pending || job?.status === "running"` — *any* job, so a running LinkedIn import disables the Google card's buttons. The hook exposes `jobRunning` scoped to this provider's kind. In this task the panels keep their current `busy` expression so nothing changes; Task 4's rows use the scoped one. Note it in the hook's doc.

- [ ] **Step 2: Extract `useRecruiterScan`**

Move: `scan` state, the 2-second poll with its terminal toasts and `router.refresh()`, `phaseLabel`, the percentage (null until discovery completes), `startGmailRecruiterScan` / `startOutlookRecruiterScan` (surfacing `started.error` as a toast — P2a made the plan denial arrive there verbatim), `cancel*RecruiterScan`, and the `background-jobs` mirroring (`startBackgroundJob` / `updateBackgroundJob` / `finishBackgroundJob`) with the same ids and labels.

- [ ] **Step 3: Adopt in the four panels, changing nothing visible**

Same rule as Task 2: JSX, labels and toasts stay byte-identical.

- [ ] **Step 4: Verify and commit**

Run: `npx tsc --noEmit`; `npx eslint src/components`; `npx tsx scripts/smoke-toast-copy.ts`. Re-check `/imports` and `/recruiters` in the demo preview (hydration confirmed) — the cards, the review list and the scan block render as before.

```bash
git add src/components/settings/use-contacts-import.ts src/components/settings/use-recruiter-scan.ts src/components/imports src/components/recruiters
git commit -m "Extract the contacts import and the recruiter scan from their panels"
```

---

### Task 4: The account page shell and the Google page

**Files:**
- Modify: `src/actions/gmail.ts`, `src/actions/outlook.ts` (`setCalendarSync` returns a result)
- Create: `src/components/settings/account-page.tsx`, `src/components/settings/google-account-page.tsx`
- Create: `scripts/smoke-account-rows.ts`; Modify: `scripts/run-smoke.ts`

**Interfaces:**
- Produces:

```ts
// src/lib/integration-status.ts — pure, smoke-tested
export function rowControl(capability: AccountCapability, status: CapabilityStatus | undefined): RowControl;

// src/components/settings/account-page.tsx
export function AccountPageShell(props: {
  provider: "google" | "microsoft";
  account: AccountStatus | null;      // null while loading
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  onConnect: () => void;              // the shell's Connect and Switch account both call this
  onDisconnect: (opts: { alsoDelete: boolean }) => void;
  children: React.ReactNode;          // the rows
}): React.JSX.Element;

export function FeatureRow(props: {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;       // a node, so a row can carry a "Turn on AI" link
  control: RowControl;
  onAction: () => void;               // action, locked and switch all report through this
  disabled?: boolean;
  children?: React.ReactNode;         // the review list, the scan block
}): React.JSX.Element;

// src/components/settings/google-account-page.tsx
export function GoogleAccountPage(props: {
  returnTo: string;
  /** False when /recruiters is hidden — the inbox row is left out. */
  inboxVisible: boolean;
  canUseRecruiters: boolean;
  /** AI is on — the inbox row needs it; false renders a "Turn on AI" link instead of the action. */
  aiReady: boolean;
  /** False from the moment the dialog starts closing: stops the scan poll (Base UI unmounts late). */
  active: boolean;
  /** Opens another page of this dialog — used by the Reminders row and the "Turn on AI" link. */
  onOpenPage: (page: IntegrationTabId) => void;
}): React.JSX.Element;
```

`MicrosoftAccountPage` (Task 5) takes the same props minus `aiReady`'s Google-specific wording — it needs `aiReady` too, for its own inbox row.

- [ ] **Step 1: Make `setCalendarSync` answer instead of throwing**

P2a's `setCalendarSync` throws a `UserFacingError` when the grant has no calendar; thrown Server Action messages become a digest in production, so the switch would show a generic failure. Wrap it:

```ts
export async function setCalendarSync(enabled: boolean): Promise<ActionResult<void>> {
  return asActionResult(async () => { /* the existing body */ });
}
```

Keep the guard and its wording. Update both providers. `asActionResult` already rescues `UserFacingError` and (from P2a) `PaywallError`.

- [ ] **Step 2: Write the row-control rules as a pure function, with checks**

The row's control is decided by the capability state, not by the component. Add to `src/lib/integration-status.ts`:

```ts
export type RowControl =
  | { kind: "action"; label: string }      // Import contacts / Check for new / Scan inbox / Allow / Add
  | { kind: "switch"; on: boolean }        // Meetings
  | { kind: "locked"; label: string }      // Pro feature on a free plan
  | { kind: "none" };                      // nothing to do (already allowed, nothing to run)

export function rowControl(capability: AccountCapability, status: CapabilityStatus | undefined): RowControl;
```

Rules, and the checks that pin them in a new pure smoke `scripts/smoke-account-rows.ts` (register it as `pure`):

| capability | state | control |
|---|---|---|
| contacts | `available` | action "Import contacts" |
| contacts | `on` | action "Check for new" |
| contacts | `not_allowed` | action "Allow" |
| meetings | `on` | switch on |
| meetings | `off` | switch off |
| meetings | `paused` | action "Fix" |
| meetings | `not_allowed` | action "Allow" |
| inbox | `locked` | locked "Upgrade" |
| inbox | `available` | action "Scan inbox" |
| inbox | `not_allowed` | action "Allow" |
| send | `on` | none |
| send | `not_allowed` | action "Allow" |
| any | `undefined` | none |

- [ ] **Step 3: Build the shell**

`account-page.tsx` exports:
- `AccountPageShell({ provider, account, loading, failed, onRetry, onConnect, onSwitch, onDisconnect, children })` — renders, in order: a skeleton while `loading`; "Couldn’t check your {Provider} connection." + **Try again** when `failed`; the unconfigured note when `account.state === "not_configured"`; the connect prompt when `not_connected`; a needs-sign-in notice + **Sign in again** when `needs_reauth` (rows below render dimmed and inert); otherwise the header + `children`.
- **Connect prompt** copy: `Bring in your contacts and log your meetings from your {Provider} account.` then a primary **Connect {Provider}** button, then "Orbit will ask to" with two ticks — "See your contacts", "See your calendar" — and the line "It never changes, sends or deletes anything in your {Provider} account. Mail features ask separately, only if you turn them on."
- **Header**: initials avatar, provider name, the connected email, and a ⋯ menu (`DropdownMenu` from `@/components/ui/dropdown-menu`) with **Switch account** (connect again) and **Disconnect** (opens `DisconnectAccountDialog`).
- `FeatureRow({ icon, title, description, control, onAction, disabled, children })` — icon, title, one-line description, the control on the right, and `children` beneath for a row that expands (the contacts review list, the scan progress). Rows are bordered list items, not cards: the dialog panel already supplies the chrome.

- [ ] **Step 4: Build the Google page**

`google-account-page.tsx` composes `useGoogleConnection` + `useContactsImport("google")` + `useRecruiterScan("google", null)` + `googleAccountStatus` and renders five rows with this copy:

| Row | Description | Expands to |
|---|---|---|
| Contacts | `{n} imported {when}. You pick who comes in.` (before any import: `Bring your Google contacts into Orbit. You choose who before anything’s added.`) | the review list + import button |
| Meetings | `Logs meetings with people you know onto their timelines. Checked {when}.` / when off: `Off — meetings aren’t being logged.` | — |
| Recruiters in Gmail | `Finds recruiter emails and sums up each one. Asks Google first.` | the scan progress block; when locked: `Part of Orbit Pro and Lifetime` + Upgrade → `/upgrade` |
| Send from Gmail | `Replies you approve go out from your address.` | — |
| Reminders in Google Calendar | `See your follow-ups next to your meetings.` | — ; **Add** opens the Reminders page (`onOpenPage("reminders")`) |

Rules: the Meetings switch calls `setCalendarSync` and toasts `result.error` when it comes back not-ok; an **Allow** action calls `connect([thatPurpose])`; **Scan inbox** needs AI — when `initialSettings.hasApiKey` is false, render the row's description with a "Turn on AI" link (`onOpenPage("ai")`) and disable the action; the inbox row renders only when `inboxVisible`.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit`; `npx eslint src/components src/actions src/lib`; `npx tsx scripts/smoke-account-rows.ts`; `npx tsx scripts/smoke-integration-status.ts`; `npx tsx scripts/smoke-toast-copy.ts`; `npx tsx scripts/run-smoke.ts --check`.

```bash
git add src/actions/gmail.ts src/actions/outlook.ts src/components/settings/account-page.tsx src/components/settings/google-account-page.tsx src/lib/integration-status.ts scripts/smoke-account-rows.ts scripts/run-smoke.ts
git commit -m "Give Google one page: connect once, then a row per feature"
```

---

### Task 5: The Microsoft page, and the dialog mounting both

**Files:**
- Create: `src/components/settings/microsoft-account-page.tsx`
- Modify: `src/components/settings/integrations-dialog.tsx`
- Delete: `src/components/settings/integrations-gmail-tab.tsx`

- [ ] **Step 1: Build the Microsoft page**

Same shape as Google, four rows: Contacts, Meetings, **Recruiters in Outlook** (`useRecruiterScan("microsoft", null)` — this is the first time the Outlook scan appears in Settings), Reminders in Outlook. No Send row (Microsoft has no send purpose). Copy mirrors Google's with "Microsoft"/"Outlook" in place of "Google"/"Gmail".

- [ ] **Step 2: Mount them**

In `integrations-dialog.tsx`'s `Panel`, replace the `google` case (currently `GoogleContactsImport` + the `GmailTab` block) with `<GoogleAccountPage … />`, and the `microsoft` case with `<MicrosoftAccountPage … />`. Keep both pages behind `dynamic()` with the existing `PanelSkeleton` — they are the heavy half of the dialog. Keep the `focusTargetId("google", "inbox")` wrapper id on the Google page's inbox row so `?integration=gmail` still lands on it. Delete `integrations-gmail-tab.tsx` and its import; the `active` prop it consumed becomes the pages' `enabled`/polling guard (a page must stop polling the moment the dialog starts closing — Base UI unmounts late).

- [ ] **Step 3: Verify and commit**

Run the checks from Task 4 Step 5, plus `npx tsx scripts/smoke-settings-layout.ts`. In the demo preview (hydration confirmed): `?integration=google` and `?integration=microsoft` render the new pages; `?integration=gmail` lands on the Google inbox row; no console errors.

```bash
git add src/components/settings/microsoft-account-page.tsx src/components/settings/integrations-dialog.tsx
git rm src/components/settings/integrations-gmail-tab.tsx
git commit -m "Give Microsoft the same page, and mount both in the dialog"
```

---

### Task 6: Connect from the Overview, and the last connection details

**Files:**
- Modify: `src/components/settings/integrations-overview.tsx`, `src/components/settings/integrations-settings.tsx`, `src/lib/integration-status.ts` (`overviewAction`)
- Modify: `src/components/settings/disconnect-account-dialog.tsx`
- Modify: `src/components/imports/google-contacts-import.tsx`, `outlook-contacts-import.tsx`, `src/components/recruiters/gmail-import-panel.tsx`, `outlook-import-panel.tsx` (paused state)

- [ ] **Step 1: Connect starts the consent screen from the card**

The Overview's "Connect Google" currently opens the page. Give `IntegrationsOverview` an `onConnect(provider)` prop, wired by the dialog to the same hook the pages use, so the button starts the consent screen with `*_CONNECT_PURPOSES`. Keep "Manage" / "Sign in again" opening the page. `overviewAction`'s labels don't change.

- [ ] **Step 2: The disconnect dialog lists only what this account produced**

Today it always names recruiter data. Pass what the account actually has (the `inbox` capability's state, and whether a scan has run) so the checkbox lists nothing when there is nothing to delete, and the dialog then says plainly that contacts stay. Keep `DISCONNECT_DELETE_CATEGORIES` as the source of category text.

- [ ] **Step 3: A paused calendar reads as paused on the old cards**

`/imports` and `/recruiters` cards branch on `status === "disarmed"` only, so P2a's user-pause falls through to their on-state. Add the `"paused"` case to each of the four, using each card's existing voice (e.g. "Meetings are switched off — turn them on in Settings").

- [ ] **Step 4: Verify and commit**

Run: `npx tsc --noEmit`; `npx eslint src/components src/lib`; `npx tsx scripts/smoke-integration-status.ts`; `npx tsx scripts/smoke-account-rows.ts`; `npx tsx scripts/smoke-toast-copy.ts`.

```bash
git add src/components/settings src/components/imports src/components/recruiters src/lib/integration-status.ts
git commit -m "Connect straight from the Overview, and say when meetings are switched off"
```

---

### Task 7: The review items P1 deferred into these files

**Files:** `src/components/settings/integrations-dialog.tsx`, `integrations-settings.tsx`, `integrations-overview.tsx`, `integration-ui.tsx`, `provider-marks.tsx`, `src/lib/connection-status.ts`, `src/components/command-palette/command-palette-dialog.tsx`, `scripts/smoke-settings-layout.ts`

Each is small; do them in one commit, each with its own check where a check is possible:

- [ ] **Step 1:** Arrow keys derive their index from the focused tab, not the selected view, so ArrowDown from a fallback-tabbable row moves instead of reselecting (`integrations-dialog.tsx`'s `onTabKeyDown`).
- [ ] **Step 2:** The Advanced disclosure can collapse while an Advanced page is selected: render the list with `hidden` instead of unmounting it (so `aria-controls` always resolves) and drop the render-time force-open, keeping auto-open on a deep link.
- [ ] **Step 3:** Guard the legacy-hash effect with a handled-hash ref, so a server refresh (which makes `tabs` a new array) can't snap the view back to the hash after a save.
- [ ] **Step 4:** When `getSettings` times out, Google and Microsoft still report their page status and their sign-in attention item — only the inbox lock is unknown (`src/actions/integrations.ts` + `attentionItems`).
- [ ] **Step 5:** Show a running import on phones: the Overview card for that account gets the "· running" marker the nav row has.
- [ ] **Step 6:** Command palette labels follow the new pages ("API keys", "Reminders in calendar") — labels only, never the section ids.
- [ ] **Step 7:** Overview card buttons get `aria-describedby` pointing at their card's heading, and the attention strip's "Fix" says what it does ("See what happened").
- [ ] **Step 8:** Use Google's official mark colours in `provider-marks.tsx` (the current values are an icons8 approximation, and the consent screen is going through verification).
- [ ] **Step 9:** Delete `connectionSummary` from `src/lib/connection-status.ts` if nothing but its smoke still calls it (grep first; if a caller remains, leave it and say so).
- [ ] **Step 10:** Add to `scripts/smoke-settings-layout.ts`: every page id has a `Panel` case (parse the switch with the TypeScript compiler, as `smoke-connect-gates.ts`'s `callsIn` does), and `tabForImportJob` maps every `ImportJobKind`.

Run the full static set and the touched smokes, then commit:

```bash
git commit -m "Clear the review items P1 left in the dialog"
```

---

### Task 8: Verify in the app, then open the PR

- [ ] **Step 1: Static checks** — `npx tsc --noEmit` silent; `npx eslint` 0 errors; `npx tsx scripts/run-smoke.ts --check` exit 0; `npm test` all pass (rerun `smoke-admin-render` / `smoke-instrumentation` alone if they time out under load).

- [ ] **Step 2: Demo-mode checks** (preview started, tab fronted, hydration confirmed via a `__reactFiber…` key; a hidden or background tab never hydrates and every check passes vacuously)

Google and Microsoft are unconfigured in demo, so both pages show the unconfigured note — that is the expected state, not a failure. Check what demo can show:
1. Both account pages render their unconfigured note with no console errors.
2. `?integration=gmail` still lands on the Google page's inbox row.
3. The Overview's cards and the Settings card still read correctly, and "Manage" opens the page.
4. Advanced collapses and expands, including while an Advanced page is selected (Task 7 Step 2).
5. Arrow keys move between nav rows from a fallback-tabbable row (Task 7 Step 1).
6. Phone width: Overview first, Back on every page, Advanced reachable.
7. `/imports` and `/recruiters` are unchanged from before this phase.

- [ ] **Step 3: The manual checklist for Jason** (put it in the report and the PR body) — everything that needs real accounts:
- Connect Google from the Overview card: one consent screen asks contacts and calendar, nothing about mail.
- Untick calendar there: the page shows connected, and Meetings offers **Allow**.
- Meetings switch off → no new meetings; reconnect to add mail access → meetings stay off.
- Meetings switch on for an account whose grant lacks calendar: the refusal names calendar access (and is not a generic error).
- Scan inbox on Google and on Outlook (the Outlook one has never been reachable from Settings before).
- Free account: the inbox row is locked with Upgrade; everything else works.
- Connect a second Google account: "Switched to …" names the new address, and the Google page shows it.
- Disconnect: the dialog lists only what that account brought in.

- [ ] **Step 4: Re-check main, then ask before pushing**

```bash
git fetch origin main -q && git log --oneline HEAD..origin/main | head -20
```

Merge main if it moved into these files and re-run Step 1. Then ask Jason before pushing. PR #257 already tracks this branch, so pushing updates that PR — say so when asking, and offer the alternative of a separate PR from a branch cut at P2a.

---

## Out of scope (later phases)

P3 (AI: OpenRouter + guided Gemini paste), P4 (reminders: one-click subscribe buttons + the encrypted feed link), P5 (LinkedIn's one-ZIP import + the Advanced fixes). Also still open from P2a's review: the Free plan card never says connecting Google or Outlook is free; nothing pins that a purpose name cannot contain the separator; `confirmOutlookContactsImport`'s message digests in production because it throws across the action boundary.
