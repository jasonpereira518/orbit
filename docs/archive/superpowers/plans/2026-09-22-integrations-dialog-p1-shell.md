# Integrations Dialog P1 — Shell and Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganise the Settings → Integrations dialog around accounts — Overview, Google, Microsoft, LinkedIn, AI, Claude and ChatGPT, Reminders in calendar, and a collapsed Advanced group — with honest per-feature status, while every existing panel keeps working inside its new page.

**Architecture:** `sections.ts` stays the single registry: new page ids, groups, legacy-id aliases and link helpers. A new pure module `src/lib/integration-status.ts` derives every status line (Google/Microsoft per feature, the other pages, the attention strip, the Overview buttons) and is pinned by a pure smoke script. The dialog gains an Overview home view, a grouped side nav with a collapsible Advanced tablist, and a phone layout of Overview-then-Back; the Settings card shrinks to the Overview rows. Existing importer/settings panels are mounted unchanged in their new pages (P2–P5 redesign their insides).

**Tech Stack:** Next.js 16 App Router (client components), React 19, TypeScript, Tailwind v4, Base UI dialog, lucide-react 1.x, date-fns, Drizzle + PGlite (smoke tier), `tsx` smoke scripts.

**Spec:** `docs/superpowers/specs/2026-09-22-integrations-dialog-simplification-design.md` (this plan is phase P1 of its phasing table).

## Global Constraints

- Scope is the Integrations dialog, its Settings card, and the links into it. `/imports`, `/recruiters`, `/events`, onboarding and the importer components' internals are not changed.
- **Never rename an id in `SETTINGS_SECTIONS`.** `src/lib/surfaces.ts` derives operator hide-list keys from them (`settings-ai` → `settings.ai`); a rename silently un-hides a surface.
- Page visibility: `google`, `microsoft`, `linkedin` follow surface `page.imports`; the Google page's inbox block follows `page.recruiters`; `ai` → `settings-ai`; `assistants` and `api` → `settings-api`; `reminders` → `settings-calendar`; `webhooks` → `settings-webhooks`; `outreach` → `settings-outreach`.
- Legacy dialog ids keep working: `gmail` → Google page scrolled to its inbox block, `outlook` → `microsoft`, `calendar` → `reminders`; `#settings-*` hashes keep opening a page.
- Deep links: `?integration=` is read during render; `clearDeepLink()` strips it **only when the dialog closes** (a `history.replaceState` while a server action is queued drops that action — keep the existing comment explaining this).
- Copy outside the Advanced pages avoids "API", "OAuth", "scope", "token", "webhook", "ICS", "feed", "endpoint", "sync" and "BYOK". Buttons are verb-first, sentence case. Use curly apostrophes (’) in user-facing strings. Toasts follow `scripts/smoke-toast-copy.ts` (no trailing period, "Couldn’t", never "failed", `friendlyError` for errors).
- `"use server"` files may export only async functions and inline `export type X = …` declarations — never `export type { … }` re-exports and never non-async values. Shared types live in `src/lib/integration-status.ts`.
- `src/lib/integration-status.ts` is pure: no DB, no `next/*`, no server-only imports, so the client and pure-tier smoke scripts can import it.
- Every new smoke script is registered in `scripts/run-smoke.ts` `MANIFEST` (an unregistered script fails `--check`). Database-tier scripts start with `import "./smoke/_env";`.
- Baselines: `npx tsc --noEmit` clean; `npx eslint` 0 errors (≈44 warnings exist — any error is new).
- lucide-react is 1.x: the warning icon is `TriangleAlert` (there is no `AlertTriangle`).
- Per `AGENTS.md`, Next.js here has breaking changes; this plan uses only patterns already in these files (`useSearchParams`, `next/dynamic`). If you reach for any other Next API, read its guide in `node_modules/next/dist/docs/` first.
- Don't put Tailwind class names in code comments (Tailwind scans comments and compiles them).

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/integration-status.ts` | create | Pure status model: account capabilities, page lines, attention items, Overview buttons, `IntegrationStatuses` type |
| `scripts/smoke-integration-status.ts` | create | Pure smoke pinning the status rules |
| `src/lib/import-history.ts` | create | `lastCompletedImportAt(userId, types)` |
| `scripts/smoke-import-history.ts` | create | PGlite smoke for it |
| `src/actions/imports.ts` | modify | `getLastLinkedInImportAt()` action |
| `src/actions/gmail.ts` | modify | `GmailConnectionStatus.hasCalendarScope` |
| `src/components/settings/assistants-settings.tsx` | create | Claude and ChatGPT page |
| `src/components/settings/sections.ts` | modify | New page registry, groups, aliases, link helpers |
| `scripts/smoke-settings-layout.ts` | modify | Assertions for the new registry |
| `src/components/settings/api-settings.tsx` | modify | Drop the connector box (moved), plain title, stale aria-label |
| `src/app/(clerk)/(app)/settings/page.tsx` | modify | Pass `inboxVisible` |
| `src/actions/integrations.ts` | modify | Return `IntegrationStatuses` built by the pure module |
| `src/components/settings/integration-ui.tsx` | create | `IntegrationIcon`, `StatusDot`, `statusText` |
| `src/components/settings/provider-marks.tsx` | create | Google / Microsoft / LinkedIn marks |
| `src/components/settings/integrations-overview.tsx` | create | Overview page: attention strip + cards |
| `src/components/settings/integrations-dialog.tsx` | modify (rewrite in Task 7) | Dialog shell, nav, panels |
| `src/components/settings/integrations-settings.tsx` | modify (rewrite in Task 7) | Settings card + opening rules |
| `src/lib/account-alerts.ts`, `scripts/smoke-account-alerts.ts` | modify | Reconnect CTAs open the dialog |
| `src/components/reminders/reminder-calendar-sync.tsx` | modify | "Manage" link → `reminders` |
| `src/app/(site)/connect/page.tsx` | modify | CTA → `assistants` |
| `scripts/run-smoke.ts` | modify | Register the two new smokes |

---

### Task 1: Pure status model

**Files:**
- Create: `src/lib/integration-status.ts`
- Create: `scripts/smoke-integration-status.ts`
- Modify: `scripts/run-smoke.ts` (MANIFEST, pure section)

**Interfaces:**
- Consumes: `ConnectionHealth` type from `src/lib/connection-status.ts`; `IntegrationTabId` type from `src/components/settings/sections.ts` (type-only, used only as the key of `IntegrationStatuses.pages`, so this file compiles against today's ids and Task 4's; `AttentionItem.tab` is deliberately `AccountProvider | "ai"`, not `IntegrationTabId`, because `microsoft` only becomes a page id in Task 4).
- Produces (used by Tasks 5–7):
  - types `AccountProvider`, `AccountCapability`, `CapabilityState`, `CapabilityStatus`, `AccountState`, `AccountStatus`, `PageStatus`, `AttentionItem`, `GoogleConnectionInput`, `MicrosoftConnectionInput`, `IntegrationStatuses`
  - `googleAccountStatus(c: GoogleConnectionInput, plan: { canUseRecruiters: boolean }): AccountStatus`
  - `microsoftAccountStatus(c: MicrosoftConnectionInput, plan: { canUseRecruiters: boolean }): AccountStatus`
  - `accountPageStatus(a: AccountStatus): PageStatus`
  - `aiPageStatus(ai: { ready: boolean; providerLabel: string | null }): PageStatus`
  - `remindersPageStatus(feed: { enabled: boolean; lastFetchedAt: Date | null }, now: Date): PageStatus`
  - `linkedinPageStatus(lastImportedAt: Date | null, now: Date): PageStatus`
  - `attentionItems(input: { accounts: Partial<Record<AccountProvider, AccountStatus | "unknown">>; ai: { ready: boolean } | "unknown" }): AttentionItem[]`

- [ ] **Step 1: Write the failing smoke script**

Create `scripts/smoke-integration-status.ts`:

```ts
/**
 * How each Integrations page reads at a glance: Google and Microsoft described per feature,
 * the one-line page statuses, and the attention strip's order.
 *
 * The old single "Connected" line showed Gmail as connected when mail access was never
 * granted; these checks keep each feature answering for itself.
 *
 * Run: npx tsx scripts/smoke-integration-status.ts
 */
import {
  accountPageStatus,
  aiPageStatus,
  attentionItems,
  googleAccountStatus,
  linkedinPageStatus,
  microsoftAccountStatus,
  remindersPageStatus,
  type GoogleConnectionInput,
  type MicrosoftConnectionInput,
} from "../src/lib/integration-status";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const google = (over: Partial<GoogleConnectionInput> = {}): GoogleConnectionInput => ({
  configured: true,
  connected: true,
  emailAddress: "jo@gmail.com",
  status: "active",
  syncError: null,
  canImportContacts: true,
  hasCalendarScope: true,
  canRead: false,
  canSend: false,
  ...over,
});
const microsoft = (over: Partial<MicrosoftConnectionInput> = {}): MicrosoftConnectionInput => ({
  configured: true,
  connected: true,
  emailAddress: "jo@outlook.com",
  status: "active",
  syncError: null,
  hasContactsScope: true,
  hasCalendarScope: true,
  hasMailScope: false,
  ...over,
});
const pro = { canUseRecruiters: true };
const free = { canUseRecruiters: false };

console.log("googleAccountStatus");
check("unconfigured server", googleAccountStatus(google({ configured: false }), pro).state === "not_configured");
check(
  "no connection row",
  googleAccountStatus(google({ connected: false, status: null, emailAddress: null }), pro).state === "not_connected"
);
check("expired grant", googleAccountStatus(google({ connected: false, status: "needs_reauth" }), pro).state === "needs_reauth");
const g = googleAccountStatus(google(), pro);
check("connected, with the account's email", g.state === "connected" && g.email === "jo@gmail.com");
check("contacts granted reads available", g.capabilities.contacts?.state === "available");
check("calendar granted reads on", g.capabilities.meetings?.state === "on");
check("mail never granted is not_allowed", g.capabilities.inbox?.state === "not_allowed");
check("send not granted is not_allowed", g.capabilities.send?.state === "not_allowed");
check(
  "contacts unticked on the consent screen",
  googleAccountStatus(google({ canImportContacts: false }), pro).capabilities.contacts?.state === "not_allowed"
);
check(
  "calendar unticked on the consent screen",
  googleAccountStatus(google({ hasCalendarScope: false }), pro).capabilities.meetings?.state === "not_allowed"
);
const paused = googleAccountStatus(google({ status: "disarmed", syncError: "Google Calendar 403" }), pro).capabilities
  .meetings;
check("sync that gave up reads paused", paused?.state === "paused");
check("paused detail never echoes the provider's error", !(paused?.detail ?? "").includes("403"), paused?.detail);
check("paused detail names the fix", /sign in to Google again/.test(paused?.detail ?? ""), paused?.detail);
check(
  "a scope-shaped error asks for calendar access",
  /allow calendar access/.test(
    googleAccountStatus(google({ status: "disarmed", syncError: "insufficient scope" }), pro).capabilities.meetings
      ?.detail ?? ""
  )
);
check("inbox granted on Pro is available", googleAccountStatus(google({ canRead: true }), pro).capabilities.inbox?.state === "available");
check("inbox on free is locked, even when granted", googleAccountStatus(google({ canRead: true }), free).capabilities.inbox?.state === "locked");
check("send granted reads on", googleAccountStatus(google({ canSend: true }), pro).capabilities.send?.state === "on");
check(
  "not connected lists no features",
  Object.keys(googleAccountStatus(google({ connected: false, status: null }), pro).capabilities).length === 0
);

console.log("\nmicrosoftAccountStatus");
const m = microsoftAccountStatus(microsoft(), pro);
check("connected, with the account's email", m.state === "connected" && m.email === "jo@outlook.com");
check("Microsoft has no send feature", m.capabilities.send === undefined);
check("mail not granted", m.capabilities.inbox?.state === "not_allowed");
check("mail granted on Pro", microsoftAccountStatus(microsoft({ hasMailScope: true }), pro).capabilities.inbox?.state === "available");
check("mail on free is locked", microsoftAccountStatus(microsoft({ hasMailScope: true }), free).capabilities.inbox?.state === "locked");
check(
  "paused detail names Microsoft",
  /Microsoft/.test(microsoftAccountStatus(microsoft({ status: "disarmed", syncError: "x" }), pro).capabilities.meetings?.detail ?? "")
);

console.log("\naccountPageStatus");
check("unconfigured reads Unavailable", accountPageStatus(googleAccountStatus(google({ configured: false }), pro)).detail === "Unavailable");
const notConnected = accountPageStatus(googleAccountStatus(google({ connected: false, status: null }), pro));
check("not connected is off", notConnected.state === "off" && notConnected.detail === "Not connected");
const expired = accountPageStatus(googleAccountStatus(google({ connected: false, status: "needs_reauth" }), pro));
check("expired is partial, in plain words", expired.state === "partial" && expired.detail === "Sign in again", expired.detail);
const pausedPage = accountPageStatus(googleAccountStatus(google({ status: "disarmed", syncError: "x" }), pro));
check("paused meetings are partial", pausedPage.state === "partial" && pausedPage.detail === "Meetings paused");
const connectedPage = accountPageStatus(g);
check("connected names the account", connectedPage.state === "on" && connectedPage.detail === "Connected as jo@gmail.com");

console.log("\nother pages");
const now = new Date("2026-09-22T12:00:00Z");
const aiOff = aiPageStatus({ ready: false, providerLabel: "Google Gemini" });
check("AI off", aiOff.state === "off" && aiOff.detail === "Not on yet");
check("AI on names the provider", aiPageStatus({ ready: true, providerLabel: "Google Gemini" }).detail === "On · Google Gemini");
check("reminders off", remindersPageStatus({ enabled: false, lastFetchedAt: null }, now).detail === "Off");
check("reminders never checked", remindersPageStatus({ enabled: true, lastFetchedAt: null }, now).detail === "On · not checked yet");
const checkedAgo = remindersPageStatus({ enabled: true, lastFetchedAt: new Date("2026-09-22T10:00:00Z") }, now).detail;
check("reminders checked", checkedAgo === "On · checked about 2 hours ago", checkedAgo);
const never = linkedinPageStatus(null, now);
check("LinkedIn never imported", never.state === "off" && never.detail === "Not imported yet");
const imported = linkedinPageStatus(new Date("2026-09-13T12:00:00Z"), now);
check("LinkedIn imported", imported.state === "on" && imported.detail === "Imported 9 days ago", imported.detail);

console.log("\nattentionItems");
const items = attentionItems({
  accounts: {
    google: googleAccountStatus(google({ status: "disarmed", syncError: "x" }), pro),
    microsoft: microsoftAccountStatus(microsoft({ connected: false, status: "needs_reauth" }), pro),
  },
  ai: { ready: false },
});
check(
  "sign-in problems first, then paused meetings, then AI",
  items.map((i) => i.id).join(",") === "microsoft-reauth,google-meetings,ai-off",
  items.map((i) => i.id).join(",")
);
check("every item opens a page", items.every((i) => ["google", "microsoft", "ai"].includes(i.tab)));
check("unknown lookups add nothing", attentionItems({ accounts: { google: "unknown" }, ai: "unknown" }).length === 0);
check("healthy accounts and AI on add nothing", attentionItems({ accounts: { google: g, microsoft: m }, ai: { ready: true } }).length === 0);

if (failures > 0) {
  console.error(`\nsmoke-integration-status: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke-integration-status: all ok");
process.exit(0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/smoke-integration-status.ts`
Expected: FAIL — `Cannot find module '../src/lib/integration-status'`.

- [ ] **Step 3: Write the module**

Create `src/lib/integration-status.ts`:

```ts
/**
 * How each Integrations page reads at a glance, and what needs the person's attention.
 *
 * Pure and client-safe: `getIntegrationStatuses` builds these on the server from its lookups,
 * the dialog and the Settings card render them, and `smoke-integration-status.ts` pins the
 * rules. A Google or Microsoft account is described per feature rather than as one
 * "Connected", because one grant can cover contacts without mail — the old single line said
 * Gmail was connected when mail access had never been given.
 */
import { formatDistance } from "date-fns";
import type { IntegrationTabId } from "@/components/settings/sections";
import type { ConnectionHealth } from "@/lib/connection-status";

export type AccountProvider = "google" | "microsoft";
export type AccountCapability = "contacts" | "meetings" | "inbox" | "send";

/**
 * `available` is granted but not in continuous use (contacts to import, an inbox to scan);
 * `on` is granted and running (meetings) or simply allowed (sending). `locked` is the plan,
 * never the grant.
 */
export type CapabilityState = "on" | "available" | "not_allowed" | "paused" | "locked";
export type CapabilityStatus = { state: CapabilityState; detail?: string };

export type AccountState = "not_configured" | "not_connected" | "connected" | "needs_reauth";
export type AccountStatus = {
  state: AccountState;
  email: string | null;
  /** Empty unless connected — there is nothing to say per feature about an account Orbit can't reach. */
  capabilities: Partial<Record<AccountCapability, CapabilityStatus>>;
};

/** One line for a nav row or an Overview card. `none` draws no dot: nothing to be on or off. */
export type PageStatus = { state: "on" | "partial" | "off" | "none"; detail: string };

export type AttentionItem = {
  id: string;
  /** The page whose button fixes it — always an account page or AI. */
  tab: AccountProvider | "ai";
  message: string;
  action: string;
};

/** What `getIntegrationStatuses` returns. `unknown` is a lookup that failed or timed out. */
export type IntegrationStatuses = {
  pages: Partial<Record<IntegrationTabId, PageStatus | "unknown">>;
  accounts: Partial<Record<AccountProvider, AccountStatus | "unknown">>;
  attention: AttentionItem[];
};

/** The fields of `GmailConnectionStatus` this module reads. */
export type GoogleConnectionInput = {
  configured: boolean;
  connected: boolean;
  emailAddress: string | null;
  status: ConnectionHealth | null;
  syncError: string | null;
  canImportContacts: boolean;
  hasCalendarScope: boolean;
  canRead: boolean;
  canSend: boolean;
};

/** The fields of `OutlookConnectionStatus` this module reads. */
export type MicrosoftConnectionInput = {
  configured: boolean;
  connected: boolean;
  emailAddress: string | null;
  status: ConnectionHealth | null;
  syncError: string | null;
  hasContactsScope: boolean;
  hasCalendarScope: boolean;
  hasMailScope: boolean;
};

type Plan = { canUseRecruiters: boolean };
type ProviderName = "Google" | "Microsoft";

function accountState(c: { configured: boolean; connected: boolean; status: ConnectionHealth | null }): AccountState {
  if (!c.configured) return "not_configured";
  if (c.status === "needs_reauth") return "needs_reauth";
  if (!c.connected) return "not_connected";
  return "connected";
}

/** Never echoes `syncError`, which can be a provider's raw response body. */
function meetingsStatus(
  granted: boolean,
  health: ConnectionHealth | null,
  syncError: string | null,
  provider: ProviderName
): CapabilityStatus {
  if (!granted) return { state: "not_allowed" };
  if (health !== "disarmed") return { state: "on" };
  const scopeMissing = Boolean(syncError && /not granted|insufficient|scope/i.test(syncError));
  return {
    state: "paused",
    detail: `Meetings stopped coming in. Sign in to ${provider} again${scopeMissing ? " and allow calendar access" : ""}.`,
  };
}

function inboxStatus(granted: boolean, plan: Plan): CapabilityStatus {
  if (!plan.canUseRecruiters) return { state: "locked", detail: "Part of Orbit Pro and Lifetime" };
  return { state: granted ? "available" : "not_allowed" };
}

export function googleAccountStatus(c: GoogleConnectionInput, plan: Plan): AccountStatus {
  const state = accountState(c);
  if (state !== "connected") return { state, email: c.emailAddress, capabilities: {} };
  return {
    state,
    email: c.emailAddress,
    capabilities: {
      contacts: { state: c.canImportContacts ? "available" : "not_allowed" },
      meetings: meetingsStatus(c.hasCalendarScope, c.status, c.syncError, "Google"),
      inbox: inboxStatus(c.canRead, plan),
      send: { state: c.canSend ? "on" : "not_allowed" },
    },
  };
}

export function microsoftAccountStatus(c: MicrosoftConnectionInput, plan: Plan): AccountStatus {
  const state = accountState(c);
  if (state !== "connected") return { state, email: c.emailAddress, capabilities: {} };
  return {
    state,
    email: c.emailAddress,
    capabilities: {
      contacts: { state: c.hasContactsScope ? "available" : "not_allowed" },
      meetings: meetingsStatus(c.hasCalendarScope, c.status, c.syncError, "Microsoft"),
      inbox: inboxStatus(c.hasMailScope, plan),
    },
  };
}

export function accountPageStatus(a: AccountStatus): PageStatus {
  switch (a.state) {
    case "not_configured":
      return { state: "off", detail: "Unavailable" };
    case "not_connected":
      return { state: "off", detail: "Not connected" };
    case "needs_reauth":
      return { state: "partial", detail: "Sign in again" };
    case "connected":
      if (a.capabilities.meetings?.state === "paused") return { state: "partial", detail: "Meetings paused" };
      return { state: "on", detail: a.email ? `Connected as ${a.email}` : "Connected" };
  }
}

export function aiPageStatus(ai: { ready: boolean; providerLabel: string | null }): PageStatus {
  if (!ai.ready) return { state: "off", detail: "Not on yet" };
  return { state: "on", detail: ai.providerLabel ? `On · ${ai.providerLabel}` : "On" };
}

export function remindersPageStatus(feed: { enabled: boolean; lastFetchedAt: Date | null }, now: Date): PageStatus {
  if (!feed.enabled) return { state: "off", detail: "Off" };
  if (!feed.lastFetchedAt) return { state: "on", detail: "On · not checked yet" };
  return { state: "on", detail: `On · checked ${formatDistance(feed.lastFetchedAt, now, { addSuffix: true })}` };
}

/** Relative, not a date: the server formats this, and a calendar date would be in its timezone. */
export function linkedinPageStatus(lastImportedAt: Date | null, now: Date): PageStatus {
  if (!lastImportedAt) return { state: "off", detail: "Not imported yet" };
  return { state: "on", detail: `Imported ${formatDistance(lastImportedAt, now, { addSuffix: true })}` };
}

const PROVIDERS: ReadonlyArray<[AccountProvider, ProviderName]> = [
  ["google", "Google"],
  ["microsoft", "Microsoft"],
];

/**
 * What the Overview's strip lists, most urgent first: accounts that signed Orbit out, then
 * meetings that stopped arriving, then AI being off. The caller drops items whose page the
 * viewer can't see.
 */
export function attentionItems(input: {
  accounts: Partial<Record<AccountProvider, AccountStatus | "unknown">>;
  ai: { ready: boolean } | "unknown";
}): AttentionItem[] {
  const known = PROVIDERS.flatMap(([provider, name]) => {
    const account = input.accounts[provider];
    return account && account !== "unknown" ? [{ provider, name, account }] : [];
  });

  const items: AttentionItem[] = [];
  for (const { provider, name, account } of known) {
    if (account.state === "needs_reauth") {
      items.push({
        id: `${provider}-reauth`,
        tab: provider,
        message: `${name} signed Orbit out. Sign in again to keep things up to date.`,
        action: "Sign in again",
      });
    }
  }
  for (const { provider, name, account } of known) {
    const meetings = account.capabilities.meetings;
    if (meetings?.state === "paused") {
      items.push({
        id: `${provider}-meetings`,
        tab: provider,
        message: meetings.detail ?? `Meetings from ${name} stopped coming in.`,
        action: "Fix",
      });
    }
  }
  if (input.ai !== "unknown" && !input.ai.ready) {
    items.push({
      id: "ai-off",
      tab: "ai",
      message: "AI isn’t on yet, so notes and recruiter search can’t use it.",
      action: "Turn on AI",
    });
  }
  return items;
}
```

- [ ] **Step 4: Register the smoke and run it**

In `scripts/run-smoke.ts`, add to the `MANIFEST` pure section, directly after `"smoke-connection-status": "pure",`:

```ts
  "smoke-integration-status": "pure",
```

Run: `npx tsx scripts/smoke-integration-status.ts`
Expected: every line `ok`, ending `smoke-integration-status: all ok`.

Run: `npx tsx scripts/run-smoke.ts --check`
Expected: exits 0 (no unregistered scripts).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` — Expected: no errors.

```bash
git add src/lib/integration-status.ts scripts/smoke-integration-status.ts scripts/run-smoke.ts
git commit -m "Describe Google and Microsoft per feature, not as one Connected line"
```

---

### Task 2: Status inputs — Google's calendar grant and LinkedIn's last import

**Files:**
- Create: `src/lib/import-history.ts`
- Create: `scripts/smoke-import-history.ts`
- Modify: `src/actions/imports.ts` (add one action after `listImports`, ~line 559)
- Modify: `src/actions/gmail.ts:34-102` (`GmailConnectionStatus` + `getGmailConnectionStatus`)
- Modify: `scripts/run-smoke.ts` (MANIFEST, pglite section)

**Interfaces:**
- Consumes: `imports` table (`src/db/schema.ts:1477`), `getDb` from `@/db`.
- Produces:
  - `lastCompletedImportAt(userId: string, importTypes: readonly string[]): Promise<Date | null>` in `src/lib/import-history.ts`
  - `getLastLinkedInImportAt(): Promise<Date | null>` server action in `src/actions/imports.ts`
  - `GmailConnectionStatus.hasCalendarScope: boolean` — satisfies `GoogleConnectionInput` from Task 1.

- [ ] **Step 1: Write the failing PGlite smoke**

Create `scripts/smoke-import-history.ts`:

```ts
/**
 * When someone last finished an import of a given kind — the LinkedIn line on the
 * Integrations overview. Completed runs only, newest first, one person's rows only.
 *
 * Run: npx tsx scripts/smoke-import-history.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { imports } from "../src/db/schema";
import { lastCompletedImportAt } from "../src/lib/import-history";
import { run } from "./smoke/_env";

const USER = "smoke-import-history-user";
const OTHER = "smoke-import-history-other";
const LINKEDIN = ["linkedin_connections", "linkedin_messages"] as const;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

run(async () => {
  const db = await getDb();
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(imports).where(eq(imports.userId, OTHER));

  check("never imported is null", (await lastCompletedImportAt(USER, LINKEDIN)) === null);

  await db.insert(imports).values([
    { userId: USER, importType: "linkedin_connections", status: "completed", updatedAt: new Date("2026-09-10T00:00:00Z") },
    { userId: USER, importType: "linkedin_messages", status: "completed", updatedAt: new Date("2026-09-12T00:00:00Z") },
    { userId: USER, importType: "linkedin_connections", status: "failed", updatedAt: new Date("2026-09-20T00:00:00Z") },
    { userId: USER, importType: "google_contacts", status: "completed", updatedAt: new Date("2026-09-21T00:00:00Z") },
    { userId: OTHER, importType: "linkedin_connections", status: "completed", updatedAt: new Date("2026-09-22T00:00:00Z") },
  ]);

  const at = await lastCompletedImportAt(USER, LINKEDIN);
  check(
    "the newest completed LinkedIn import, of either kind — not a failed run, another type, or another person",
    at?.toISOString() === "2026-09-12T00:00:00.000Z",
    at?.toISOString()
  );
  check("an empty type list is null", (await lastCompletedImportAt(USER, [])) === null);

  // The smoke runner shares one PGlite across scripts.
  await db.delete(imports).where(eq(imports.userId, USER));
  await db.delete(imports).where(eq(imports.userId, OTHER));
});
```

Register it in `scripts/run-smoke.ts` `MANIFEST`, in the pglite section next to `"smoke-account-alerts": "pglite",`:

```ts
  "smoke-import-history": "pglite",
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx scripts/smoke-import-history.ts`
Expected: FAIL — `Cannot find module '../src/lib/import-history'`.

- [ ] **Step 3: Write the query**

Create `src/lib/import-history.ts`:

```ts
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { imports } from "@/db/schema";

/**
 * When this person last finished an import of any of these kinds, or null if never.
 * Completed runs only — a failed or cancelled one isn't something to report as imported.
 */
export async function lastCompletedImportAt(
  userId: string,
  importTypes: readonly string[]
): Promise<Date | null> {
  if (importTypes.length === 0) return null;
  const db = await getDb();
  const [row] = await db
    .select({ at: imports.updatedAt })
    .from(imports)
    .where(
      and(
        eq(imports.userId, userId),
        eq(imports.status, "completed"),
        inArray(imports.importType, [...importTypes])
      )
    )
    .orderBy(desc(imports.updatedAt))
    .limit(1);
  return row?.at ?? null;
}
```

- [ ] **Step 4: Run the smoke to verify it passes**

Run: `npx tsx scripts/smoke-import-history.ts`
Expected: three `ok` lines, exit 0.

- [ ] **Step 5: Add the action**

In `src/actions/imports.ts`, add the import near the other `@/lib` imports:

```ts
import { lastCompletedImportAt } from "@/lib/import-history";
```

and add directly after `listImports()` (ends ~line 559):

```ts
/** When the last LinkedIn import finished — the LinkedIn line on the Integrations overview. */
export async function getLastLinkedInImportAt(): Promise<Date | null> {
  const userId = await requireUserId();
  return lastCompletedImportAt(userId, ["linkedin_connections", LINKEDIN_MESSAGES_IMPORT_TYPE]);
}
```

(`LINKEDIN_MESSAGES_IMPORT_TYPE` is already imported in this file — it is used at ~line 501. Confirm with `grep -n LINKEDIN_MESSAGES_IMPORT_TYPE src/actions/imports.ts`; if the import is missing, add `import { LINKEDIN_MESSAGES_IMPORT_TYPE } from "@/lib/import-adapters/linkedin-messages";`.)

- [ ] **Step 6: Expose Google's calendar grant**

In `src/actions/gmail.ts`, add to the `GmailConnectionStatus` type (after `canImportContacts`):

```ts
  /** The grant covers calendar.readonly: meetings can come in. */
  hasCalendarScope: boolean;
```

In the not-configured return of `getGmailConnectionStatus` (~line 62), add `hasCalendarScope: false,` after `canImportContacts: false,`. In the configured return (~line 99), add after `canImportContacts: …`:

```ts
    hasCalendarScope: Boolean(conn && conn.status === "active" && hasCalendarScope(conn.scopes)),
```

(`hasCalendarScope` the function is already imported at line 18; the object key shadows nothing.)

- [ ] **Step 7: Typecheck, lint, commit**

Run: `npx tsc --noEmit` — Expected: no errors. (If any other file builds a `GmailConnectionStatus` literal, tsc names it; add `hasCalendarScope: false` there.)
Run: `npx eslint src/lib/import-history.ts src/actions/imports.ts src/actions/gmail.ts scripts/smoke-import-history.ts` — Expected: 0 errors.

```bash
git add src/lib/import-history.ts scripts/smoke-import-history.ts scripts/run-smoke.ts src/actions/imports.ts src/actions/gmail.ts
git commit -m "Report Google's calendar grant and LinkedIn's last import for the overview"
```

---

### Task 3: The Claude and ChatGPT page

**Files:**
- Create: `src/components/settings/assistants-settings.tsx`

**Interfaces:**
- Consumes: `SettingsSection` (`settings-section.tsx`), `Button` + `buttonVariants` (`@/components/ui/button`), `toast` (`@/lib/toast`), `TOAST_COPY.copyFailed` (`@/lib/toast-copy`).
- Produces: `AssistantsSettings(): JSX.Element` — no props. Mounted by Task 4.

This page replaces the "Connect Claude or ChatGPT" box in `api-settings.tsx` (removed in Task 4). The paste into the assistant is unavoidable; the page makes it one guided step per assistant. Current menu paths (checked 2026-09-22): Claude — Customize → Connectors → + → Add custom connector; ChatGPT — Settings → Apps → Advanced settings → Developer mode (paid ChatGPT plans), then Create.

- [ ] **Step 1: Write the component**

Create `src/components/settings/assistants-settings.tsx`:

```tsx
"use client";

import { useState, useSyncExternalStore } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/settings-section";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import { cn } from "@/lib/utils";

type Assistant = "claude" | "chatgpt";

const ASSISTANTS: Record<
  Assistant,
  { label: string; settingsHref: string; settingsLabel: string; steps: readonly string[] }
> = {
  claude: {
    label: "Claude",
    settingsHref: "https://claude.ai/settings/connectors",
    settingsLabel: "Open Claude",
    steps: [
      "Copy your Orbit link.",
      "In Claude, open Customize, then Connectors. Press + and choose Add custom connector.",
      "Paste the link and press Add, then sign in to Orbit on the page that opens.",
    ],
  },
  chatgpt: {
    label: "ChatGPT",
    settingsHref: "https://chatgpt.com/#settings",
    settingsLabel: "Open ChatGPT",
    steps: [
      "Copy your Orbit link.",
      "In ChatGPT, open Settings, then Apps. Under Advanced settings, turn on Developer mode — it needs a paid ChatGPT plan.",
      "Choose Create and paste the link, then sign in to Orbit on the page that opens.",
    ],
  },
};

const ASSISTANT_IDS = Object.keys(ASSISTANTS) as Assistant[];

/** Derived from wherever Orbit is served, so a preview deployment hands out its own link. */
const subscribeNever = () => () => {};
const getConnectorUrl = () => `${window.location.origin}/api/mcp`;

/**
 * Settings → Integrations → Claude and ChatGPT: Orbit inside the assistant someone already
 * uses. The assistant signs in to Orbit, so there is no key; the one paste left is the link
 * itself, which only an assistant's own connector directory could remove.
 */
export function AssistantsSettings() {
  const [assistant, setAssistant] = useState<Assistant>("claude");
  const [copied, setCopied] = useState(false);
  // No subscription — the origin never changes — and null on the server, which has no window.
  const url = useSyncExternalStore(subscribeNever, getConnectorUrl, () => null);
  const chosen = ASSISTANTS[assistant];

  async function copyLink() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied");
    } catch {
      toast.error(TOAST_COPY.copyFailed);
    }
  }

  return (
    <SettingsSection
      title="Claude and ChatGPT"
      description="Ask Claude or ChatGPT about your network, and let them log notes for you. They sign in to Orbit, so there’s no key to copy. Works on every plan."
    >
      <div
        role="group"
        aria-label="Which assistant do you use?"
        className="inline-flex rounded-lg border border-border/70 p-0.5"
      >
        {ASSISTANT_IDS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={assistant === id}
            onClick={() => setAssistant(id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium outline-none transition-colors duration-fast ease-house",
              "focus-visible:ring-2 focus-visible:ring-ring/70",
              assistant === id
                ? "bg-card text-ink shadow-sm ring-1 ring-border/70"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            I use {ASSISTANTS[id].label}
          </button>
        ))}
      </div>

      <ol className="list-decimal space-y-2 pl-5 text-sm text-foreground">
        {chosen.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={copyLink} disabled={!url}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : "Copy link"}
        </Button>
        <a
          href={chosen.settingsHref}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "outline" })}
        >
          {chosen.settingsLabel}
          <ExternalLink aria-hidden />
        </a>
      </div>

      {url ? (
        <p className="text-xs break-all text-muted-foreground">
          Your Orbit link: <span className="font-mono">{url}</span>
        </p>
      ) : null}
    </SettingsSection>
  );
}
```

- [ ] **Step 2: Verify the external links land where the steps say**

Open `https://claude.ai/settings/connectors` and `https://chatgpt.com/#settings` in the Browser pane (`mcp__Claude_Browser__navigate`). If either no longer lands on its settings (a 404 or a marketing page), change that `settingsHref` to the product's root (`https://claude.ai` / `https://chatgpt.com`) — the steps name the menu path either way. Do not sign in.

- [ ] **Step 3: Typecheck, lint, toast copy, commit**

Run: `npx tsc --noEmit` — no errors.
Run: `npx eslint src/components/settings/assistants-settings.tsx` — 0 errors.
Run: `npx tsx scripts/smoke-toast-copy.ts` — all ok ("Link copied" has no trailing period).

```bash
git add src/components/settings/assistants-settings.tsx
git commit -m "Add a plain-language Claude and ChatGPT page for the Integrations dialog"
```

---

### Task 4: The page registry — account-first ids, aliases, link helpers

**Files:**
- Modify: `src/components/settings/sections.ts:47-102` (everything from the `INTEGRATION_TABS` doc comment down to `INTEGRATION_TAB_FOR_LEGACY_HASH`; keep `SECTION_SCROLL_OFFSET`)
- Modify: `scripts/smoke-settings-layout.ts` (the "integrations dialog" block)
- Modify: `src/components/settings/integrations-dialog.tsx` (icons, `tabForImportJob`, `Panel`, `inboxVisible` prop)
- Modify: `src/components/settings/integrations-settings.tsx` (param/hash resolution, `inboxVisible` prop)
- Modify: `src/actions/integrations.ts` (status keys only; rewritten in Task 5)
- Modify: `src/components/settings/api-settings.tsx` (connector box removed)
- Modify: `src/app/(clerk)/(app)/settings/page.tsx` (pass `inboxVisible`)

**Interfaces:**
- Consumes: `AssistantsSettings` (Task 3).
- Produces (used by Tasks 5–8):
  - `INTEGRATION_TAB_GROUPS` with keys `"accounts" | "ai" | "advanced"`; type `IntegrationTabGroupKey`
  - `INTEGRATION_TABS` (9 pages, below); type `IntegrationTabId = "google" | "microsoft" | "linkedin" | "ai" | "assistants" | "reminders" | "api" | "webhooks" | "outreach"`
  - `OVERVIEW = "overview"`; type `IntegrationView = typeof OVERVIEW | IntegrationTabId`
  - `OVERVIEW_TABS: readonly IntegrationTabId[]` (the six non-advanced pages)
  - type `IntegrationFocus = "inbox"`
  - `INTEGRATION_TAB_ALIASES` (`gmail`, `outlook`, `calendar`); type `IntegrationLinkTarget = IntegrationView | keyof typeof INTEGRATION_TAB_ALIASES`
  - `integrationHref(target: IntegrationLinkTarget): string`
  - `isIntegrationTabId(value): value is IntegrationTabId`
  - `resolveIntegrationParam(value: string | null | undefined): { view: IntegrationView; focus: IntegrationFocus | null } | null`
  - `legacyHashTab(hash: string): IntegrationTabId | null`
  - `integrationLabel(id: IntegrationTabId): string`
  - `INTEGRATION_PARAM` (unchanged)

- [ ] **Step 1: Rewrite the smoke's dialog assertions (failing)**

In `scripts/smoke-settings-layout.ts`, replace the import block with:

```ts
import { readFileSync } from "node:fs";
import {
  INTEGRATION_TAB_GROUPS,
  INTEGRATION_TABS,
  OVERVIEW,
  OVERVIEW_TABS,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  integrationHref,
  legacyHashTab,
  resolveIntegrationParam,
} from "../src/components/settings/sections";
import { getSurface } from "../src/lib/surfaces";
```

and replace everything from `console.log("\nintegrations dialog");` up to (not including) `console.log("\npage");` with:

```ts
console.log("\nintegrations dialog");
const tabIds: string[] = INTEGRATION_TABS.map((t) => t.id);
check("page ids are unique", new Set(tabIds).size === tabIds.length);
check("overview is the home view, not a page", !tabIds.includes(OVERVIEW));
const tabGroupKeys = new Set<string>(INTEGRATION_TAB_GROUPS.map((g) => g.key));
for (const tab of INTEGRATION_TABS) {
  check(`page "${tab.id}" is in a real group`, tabGroupKeys.has(tab.group), tab.group);
}
for (const section of SETTINGS_SECTIONS.filter((s) => s.group === "integrations")) {
  const tabs = INTEGRATION_TABS.filter((t) => "section" in t && t.section === section.id);
  check(`${section.id} has a dialog page`, tabs.length >= 1, `found ${tabs.length}`);
  const legacy = legacyHashTab(`#${section.id}`);
  check(
    `#${section.id} still opens one of its pages`,
    legacy !== null && tabs.some((t) => t.id === legacy),
    String(legacy)
  );
}
for (const tab of INTEGRATION_TABS) {
  if ("section" in tab) {
    const section = SETTINGS_SECTIONS.find((s) => s.id === tab.section);
    check(
      `page "${tab.id}" points at an Integrations section`,
      section?.group === "integrations",
      tab.section
    );
  } else {
    check(`page "${tab.id}" follows a real surface`, getSurface(tab.surface) !== undefined, tab.surface);
  }
  const resolved = resolveIntegrationParam(
    new URL(integrationHref(tab.id), "http://x").searchParams.get("integration")
  );
  check(`integrationHref("${tab.id}") round-trips`, resolved?.view === tab.id && resolved.focus === null);
}
check(
  "integrationHref(overview) round-trips",
  resolveIntegrationParam(new URL(integrationHref(OVERVIEW), "http://x").searchParams.get("integration"))
    ?.view === OVERVIEW
);
check(
  "Overview cards skip Advanced",
  OVERVIEW_TABS.length > 0 &&
    OVERVIEW_TABS.every((id) => INTEGRATION_TABS.find((t) => t.id === id)?.group !== "advanced")
);

console.log("\nold dialog ids");
// Links, bookmarks and consent screens already in flight still use these.
const OLD_IDS: Array<[string, string, string | null]> = [
  ["gmail", "google", "inbox"],
  ["outlook", "microsoft", null],
  ["calendar", "reminders", null],
  ["google", "google", null],
  ["linkedin", "linkedin", null],
  ["ai", "ai", null],
  ["api", "api", null],
  ["webhooks", "webhooks", null],
  ["outreach", "outreach", null],
];
for (const [old, view, focus] of OLD_IDS) {
  const r = resolveIntegrationParam(old);
  check(`?integration=${old} opens ${view}${focus ? ` at ${focus}` : ""}`, r?.view === view && r.focus === focus);
}
check("an unknown id opens nothing", resolveIntegrationParam("nope") === null);
check("empty opens nothing", resolveIntegrationParam("") === null && resolveIntegrationParam(null) === null);
check(
  "prototype keys are not ids",
  resolveIntegrationParam("constructor") === null && legacyHashTab("#toString") === null
);
check("the gmail link keeps its alias", integrationHref("gmail") === "/settings?integration=gmail");

console.log("\nsurface keys");
// Operator hide-lists are stored by these; renaming one silently un-hides its surface.
const FROZEN_SECTION_IDS = [
  "settings-profile",
  "settings-plan",
  "settings-appearance",
  "settings-notifications",
  "settings-goals",
  "settings-targets",
  "settings-ai",
  "settings-outreach",
  "settings-calendar",
  "settings-api",
  "settings-webhooks",
  "settings-knowledge",
  "settings-help",
  "settings-data",
];
check(
  "section ids are unchanged",
  SETTINGS_SECTIONS.map((s) => s.id).join(",") === FROZEN_SECTION_IDS.join(",")
);
```

Run: `npx tsx scripts/smoke-settings-layout.ts`
Expected: FAIL — tsx errors on the missing exports (`OVERVIEW`, `legacyHashTab`, …).

- [ ] **Step 2: Rewrite the registry**

In `src/components/settings/sections.ts`, replace everything from the doc comment above `export const INTEGRATION_TABS` through the end of `INTEGRATION_TAB_FOR_LEGACY_HASH` (keep the file header, `SETTINGS_GROUPS`, `SETTINGS_SECTIONS`, and `SECTION_SCROLL_OFFSET` at the end) with:

```ts
export const INTEGRATION_TAB_GROUPS = [
  { key: "accounts", label: "Your accounts" },
  { key: "ai", label: "AI and calendar" },
  { key: "advanced", label: "Advanced" },
] as const;

export type IntegrationTabGroupKey = (typeof INTEGRATION_TAB_GROUPS)[number]["key"];

/**
 * The Integrations dialog's pages, in nav order.
 *
 * Organised by account rather than by technology: one Google page holds contacts, meetings
 * and Gmail, which used to be three places. `section` pages are settings sections moved off
 * the page and keep their surface key, so an operator hiding `settings.webhooks` hides
 * Webhooks. `surface` pages embed importers whose home is another page and follow that page's
 * surface — a hidden /imports must not leak back in through Settings. Claude and ChatGPT and
 * API keys share `settings-api` because the old card held both.
 *
 * Overview is not a page here: it is the dialog's home view, shown whenever any page is.
 */
export const INTEGRATION_TABS = [
  { id: "google", label: "Google", group: "accounts", surface: "page.imports" },
  { id: "microsoft", label: "Microsoft", group: "accounts", surface: "page.imports" },
  { id: "linkedin", label: "LinkedIn", group: "accounts", surface: "page.imports" },
  { id: "ai", label: "AI", group: "ai", section: "settings-ai" },
  { id: "assistants", label: "Claude and ChatGPT", group: "ai", section: "settings-api" },
  { id: "reminders", label: "Reminders in calendar", group: "ai", section: "settings-calendar" },
  { id: "api", label: "API keys", group: "advanced", section: "settings-api" },
  { id: "webhooks", label: "Webhooks", group: "advanced", section: "settings-webhooks" },
  { id: "outreach", label: "Outreach keys", group: "advanced", section: "settings-outreach" },
] as const satisfies ReadonlyArray<
  { id: string; label: string; group: IntegrationTabGroupKey } & (
    | { section: SettingsSectionId }
    | { surface: string }
  )
>;

export type IntegrationTabId = (typeof INTEGRATION_TABS)[number]["id"];

/** The dialog's home view. */
export const OVERVIEW = "overview";
export type IntegrationView = typeof OVERVIEW | IntegrationTabId;

/** The pages the Overview gives a card — everything outside Advanced. */
export const OVERVIEW_TABS: readonly IntegrationTabId[] = INTEGRATION_TABS.filter(
  (tab) => tab.group !== "advanced"
).map((tab) => tab.id);

/** A place inside a page a link can land on. Only the Google page has one so far. */
export type IntegrationFocus = "inbox";

/**
 * Ids the dialog used before it was organised by account. Links, bookmarks and the
 * `returnTo` of Google and Microsoft consent screens already in flight still say these, and
 * `gmail` stays the way to link straight to the Google page's inbox.
 */
export const INTEGRATION_TAB_ALIASES = {
  gmail: { view: "google", focus: "inbox" },
  outlook: { view: "microsoft" },
  calendar: { view: "reminders" },
} as const satisfies Record<string, { view: IntegrationTabId; focus?: IntegrationFocus }>;

export type IntegrationLinkTarget = IntegrationView | keyof typeof INTEGRATION_TAB_ALIASES;

/** Query param that opens the Integrations dialog: `/settings?integration=google`. */
export const INTEGRATION_PARAM = "integration";

export function integrationHref(target: IntegrationLinkTarget) {
  return `/settings?${INTEGRATION_PARAM}=${target}`;
}

export function isIntegrationTabId(value: string | null | undefined): value is IntegrationTabId {
  return INTEGRATION_TABS.some((tab) => tab.id === value);
}

function ownKey<T extends object>(record: T, key: string): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** What `?integration=` asks for — a page, the overview, or an old id — or null. */
export function resolveIntegrationParam(
  value: string | null | undefined
): { view: IntegrationView; focus: IntegrationFocus | null } | null {
  if (!value) return null;
  if (value === OVERVIEW) return { view: OVERVIEW, focus: null };
  if (isIntegrationTabId(value)) return { view: value, focus: null };
  if (!ownKey(INTEGRATION_TAB_ALIASES, value)) return null;
  const alias: { view: IntegrationTabId; focus?: IntegrationFocus } = INTEGRATION_TAB_ALIASES[value];
  return { view: alias.view, focus: alias.focus ?? null };
}

/**
 * The anchors these pages had when they were cards on the settings page. `#settings-api`
 * held both API keys and the Claude/ChatGPT connector; it opens API keys, the literal
 * meaning of the old anchor.
 */
const LEGACY_HASH_TAB = {
  "settings-ai": "ai",
  "settings-outreach": "outreach",
  "settings-calendar": "reminders",
  "settings-api": "api",
  "settings-webhooks": "webhooks",
} as const satisfies Record<string, IntegrationTabId>;

/** The page an old `#settings-*` anchor stands for, or null. Accepts the hash with or without `#`. */
export function legacyHashTab(hash: string): IntegrationTabId | null {
  const key = hash.replace(/^#/, "");
  return ownKey(LEGACY_HASH_TAB, key) ? LEGACY_HASH_TAB[key] : null;
}

export function integrationLabel(id: IntegrationTabId): string {
  return INTEGRATION_TABS.find((tab) => tab.id === id)?.label ?? id;
}
```

Also update the file's header comment: replace "and `IntegrationsDialog` renders its side nav from `INTEGRATION_TABS`" with "and `IntegrationsDialog` renders its side nav and Overview from `INTEGRATION_TABS`".

Run: `npx tsx scripts/smoke-settings-layout.ts`
Expected: all ok.

- [ ] **Step 3: Move the Claude/ChatGPT box out of API keys**

In `src/components/settings/api-settings.tsx`:

1. Delete the whole `{/* Connect an assistant. … */}` block — the `<div className="space-y-3 rounded-lg border p-4">` that contains "Connect Claude or ChatGPT", the `<code>{mcpUrl ?? "…"}</code>`, the copy button and the `<ol>` of steps (≈ lines 153–182).
2. Delete `const mcpUrl = useSyncExternalStore(...)` and the comment above it, plus the module-level `subscribeNever` and `getOriginSnapshot` and their comment. Remove `useSyncExternalStore` from the React import and `Plug` from the lucide import (run `grep -n "useSyncExternalStore\|Plug" src/components/settings/api-settings.tsx` to confirm nothing else uses them).
3. Change the section header:

```tsx
    <SettingsSection
      title="API keys"
      description="Connect Orbit to Zapier, Make, n8n or your own scripts. A key acts as you, so treat it like a password."
    >
```

4. In the new-key box, change `aria-label={created.mcpUrl ? "Copy MCP URL" : "Copy key"}` to `aria-label="Copy key"`.
5. Replace the helper paragraph under "Create a key" ("Use an API key for Zapier, Make, n8n, or the command line. Claude and ChatGPT do not need one — connect them above and sign in instead.") with:

```tsx
          Use an API key for Zapier, Make, n8n or the command line. Claude and ChatGPT don’t
          need one — set them up under Claude and ChatGPT.
```

- [ ] **Step 4: Point the dialog at the new ids**

In `src/components/settings/integrations-dialog.tsx`:

1. lucide import: remove `MailSearch`, add `Bot`.
2. Import the new page and the alias-capable href (add `AssistantsSettings`; `integrationHref` is already imported):

```ts
import { AssistantsSettings } from "@/components/settings/assistants-settings";
```

3. Replace `INTEGRATION_ICONS` with:

```ts
export const INTEGRATION_ICONS: Record<IntegrationTabId, LucideIcon> = {
  google: Users,
  microsoft: BookUser,
  linkedin: FileSpreadsheet,
  ai: Sparkles,
  assistants: Bot,
  reminders: CalendarDays,
  api: KeyRound,
  webhooks: Webhook,
  outreach: Send,
};
```

4. In `tabForImportJob`, change `case "outlook_contacts": return "outlook";` to `return "microsoft";`.
5. Add `inboxVisible: boolean` to the props of `IntegrationsDialog`, `DialogBody` and `Panel`, and thread it through (`IntegrationsDialog` → `<DialogBody inboxVisible={inboxVisible} …>` → `<Panel inboxVisible={inboxVisible} …>`). Doc it on `IntegrationsDialog`: `/** False when /recruiters is hidden: the Google page then leaves out its Gmail inbox block. */`
6. Replace the body of `Panel`'s `switch` with:

```tsx
  switch (id) {
    case "google":
      return (
        <div className="space-y-5">
          <GoogleContactsImport returnTo={integrationHref("google")} />
          {inboxVisible ? (
            <div id="integration-google-inbox" className="scroll-mt-4">
              <GmailTab active={active} canUseRecruiters={canUseRecruiters} returnTo={integrationHref("gmail")} />
            </div>
          ) : null}
        </div>
      );
    case "microsoft":
      return <OutlookContactsImport returnTo={integrationHref("microsoft")} />;
    case "linkedin":
      return (
        <div className="space-y-5">
          <LinkedInConnectionsImport />
          <LinkedInMessagesImport />
        </div>
      );
    case "ai":
      return (
        <div className="space-y-5">
          <AiSettings initialSettings={initialSettings} />
          <AiUsageCard />
        </div>
      );
    case "assistants":
      return <AssistantsSettings />;
    case "reminders":
      return <CalendarFeedSettings />;
    case "api":
      return <ApiSettings />;
    case "webhooks":
      return <WebhookSettings />;
    case "outreach":
      return <OutreachSettings initial={initialSettings.outreach} />;
  }
```

- [ ] **Step 5: Resolve old ids on the Settings card**

In `src/components/settings/integrations-settings.tsx`:

1. In the `@/components/settings/sections` import, remove `INTEGRATION_TAB_FOR_LEGACY_HASH` and `isIntegrationTabId`; add `OVERVIEW`, `legacyHashTab`, `resolveIntegrationParam`.
2. Add `inboxVisible: boolean` to the component props (doc: `/** False when /recruiters is hidden — the Google page drops its inbox block. */`) and pass `inboxVisible={inboxVisible}` to `<IntegrationsDialog>`.
3. Replace the render-time `?integration=` block's inner `if` with:

```ts
  if (requested !== handled) {
    setHandled(requested);
    const resolved = resolveIntegrationParam(requested);
    // The Overview arrives with the new dialog shell; until then it opens on the first page.
    const target = resolved ? (resolved.view === OVERVIEW ? tabs[0] : resolved.view) : undefined;
    if (target && tabs.includes(target)) {
      setTab(target);
      setOpen(true);
    }
  }
```

4. In the legacy-hash effect, replace `const target = INTEGRATION_TAB_FOR_LEGACY_HASH[window.location.hash.slice(1)];` with `const target = legacyHashTab(window.location.hash);`.
5. In `clearDeepLink`, replace `const legacyHash = INTEGRATION_TAB_FOR_LEGACY_HASH[window.location.hash.slice(1)];` with `const legacyHash = legacyHashTab(window.location.hash);`.

- [ ] **Step 6: Rename the status keys**

In `src/actions/integrations.ts`: rename `statuses.calendar` → `statuses.reminders`; replace the Google/Gmail/Outlook block with:

```ts
  statuses.google = google === "unknown" ? "unknown" : connectionSummary(google);
  statuses.microsoft = outlook === "unknown" ? "unknown" : connectionSummary(outlook);
```

(`gmail` has no page of its own any more; Task 5 replaces this whole function.)

- [ ] **Step 7: Pass inbox visibility from the page**

In `src/app/(clerk)/(app)/settings/page.tsx`, add to `<IntegrationsSettings …>`:

```tsx
          inboxVisible={!hidden.has("page.recruiters")}
```

and update the comment above `integrationTabs` to: `// Section pages follow their own settings surface; account pages follow /imports, so hiding it can't be undone by reaching it through Settings. The Google page's Gmail block follows /recruiters.`

- [ ] **Step 8: Typecheck, lint, smokes, commit**

Run: `npx tsc --noEmit` — no errors.
Run: `npx eslint src/components/settings src/actions/integrations.ts "src/app/(clerk)/(app)/settings/page.tsx"` — 0 errors.
Run: `npx tsx scripts/smoke-settings-layout.ts && npx tsx scripts/smoke-integration-status.ts` — all ok.

```bash
git add src/components/settings/sections.ts scripts/smoke-settings-layout.ts src/components/settings/integrations-dialog.tsx src/components/settings/integrations-settings.tsx src/components/settings/api-settings.tsx src/actions/integrations.ts "src/app/(clerk)/(app)/settings/page.tsx"
git commit -m "Organise the Integrations dialog by account, keeping every old link working"
```

---

### Task 5: Honest statuses from the server, shared status UI

**Files:**
- Modify: `src/actions/integrations.ts` (rewrite `getIntegrationStatuses`)
- Create: `src/components/settings/integration-ui.tsx`
- Modify: `src/components/settings/integrations-dialog.tsx` (use `integration-ui`, `statuses.pages`)
- Modify: `src/components/settings/integrations-settings.tsx` (use `integration-ui`, `statuses.pages`)

**Interfaces:**
- Consumes: Task 1's builders and `IntegrationStatuses`; Task 2's `getLastLinkedInImportAt` and `hasCalendarScope`; `getSettings().plan.canUseRecruiters`, `getSettings().hasApiKey`, `getSettings().providers`, `getSettings().aiProvider`.
- Produces:
  - `getIntegrationStatuses(): Promise<IntegrationStatuses>` (type from `@/lib/integration-status`)
  - `integration-ui.tsx`: `IntegrationIcon({ id, className })`, `StatusDot({ status, className })` taking `PageStatus | "unknown" | undefined`, `statusText(status): string`

- [ ] **Step 1: Rewrite the action**

Replace `src/actions/integrations.ts` from its imports through the end of the file with:

```ts
"use server";

import { getSettings } from "@/actions/settings";
import { getCalendarFeedStatus } from "@/actions/calendar-feed";
import { listApiKeys } from "@/actions/api-keys";
import { listWebhookEndpoints } from "@/actions/webhook-endpoints";
import { getGmailConnectionStatus } from "@/actions/gmail";
import { getOutlookConnectionStatus } from "@/actions/outlook";
import { getLastLinkedInImportAt } from "@/actions/imports";
import {
  accountPageStatus,
  aiPageStatus,
  attentionItems,
  googleAccountStatus,
  linkedinPageStatus,
  microsoftAccountStatus,
  remindersPageStatus,
  type IntegrationStatuses,
} from "@/lib/integration-status";

/**
 * Per-lookup budget. The calendar feed status has hung in production rather than failed
 * (see `calendar-feed-settings.tsx`), and one hung lookup must not hold up the others.
 */
const LOOKUP_TIMEOUT_MS = 8_000;

async function settle<T>(promise: Promise<T>): Promise<T | "unknown"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"unknown">((resolve) => {
    timer = setTimeout(() => resolve("unknown"), LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Every Integrations page's one-line status, Google and Microsoft per feature, and what the
 * Overview should flag. Loaded after the page paints rather than with it, so these lookups —
 * two of them to third-party config — never sit in front of the settings page.
 */
export async function getIntegrationStatuses(): Promise<IntegrationStatuses> {
  const [settings, feed, keys, webhooks, google, outlook, linkedin] = await Promise.all([
    settle(getSettings()),
    settle(getCalendarFeedStatus()),
    settle(listApiKeys()),
    settle(listWebhookEndpoints()),
    settle(getGmailConnectionStatus()),
    settle(getOutlookConnectionStatus()),
    settle(getLastLinkedInImportAt()),
  ]);
  const now = new Date();
  const pages: IntegrationStatuses["pages"] = {};
  const accounts: IntegrationStatuses["accounts"] = {};

  if (settings === "unknown") {
    pages.ai = "unknown";
    pages.outreach = "unknown";
  } else {
    const provider = settings.providers.find((p) => p.id === settings.aiProvider);
    pages.ai = aiPageStatus({ ready: settings.hasApiKey, providerLabel: provider?.label ?? null });

    const outreach = [settings.outreach.apollo, settings.outreach.resend, settings.outreach.twilio];
    const configured = outreach.filter(Boolean).length;
    pages.outreach =
      configured === 0
        ? { state: "off", detail: "Not set up" }
        : {
            state: configured === outreach.length ? "on" : "partial",
            detail: `${configured} of ${outreach.length} set up`,
          };
  }

  pages.reminders = feed === "unknown" ? "unknown" : remindersPageStatus(feed, now);

  pages.api =
    keys === "unknown"
      ? "unknown"
      : keys.length > 0
        ? { state: "on", detail: plural(keys.length, "key") }
        : { state: "off", detail: "No keys" };

  if (webhooks === "unknown") {
    pages.webhooks = "unknown";
  } else {
    const live = webhooks.filter((w) => w.status === "active").length;
    pages.webhooks =
      webhooks.length === 0
        ? { state: "off", detail: "None" }
        : {
            state: live === webhooks.length ? "on" : "partial",
            detail: live === webhooks.length ? `${live} live` : `${live} of ${webhooks.length} live`,
          };
  }

  // Without the plan, a locked inbox can't be told from an open one — so the accounts read as
  // unknown rather than guessing either way.
  const plan = settings === "unknown" ? null : { canUseRecruiters: settings.plan.canUseRecruiters };
  accounts.google = google === "unknown" || !plan ? "unknown" : googleAccountStatus(google, plan);
  accounts.microsoft = outlook === "unknown" || !plan ? "unknown" : microsoftAccountStatus(outlook, plan);
  pages.google = accounts.google === "unknown" ? "unknown" : accountPageStatus(accounts.google);
  pages.microsoft = accounts.microsoft === "unknown" ? "unknown" : accountPageStatus(accounts.microsoft);

  pages.linkedin = linkedin === "unknown" ? "unknown" : linkedinPageStatus(linkedin, now);

  // Assistants sign in through Clerk and leave no record in Orbit, so there is nothing to report.
  pages.assistants = { state: "none", detail: "Works on every plan" };

  const attention = attentionItems({
    accounts,
    ai: settings === "unknown" ? "unknown" : { ready: settings.hasApiKey },
  });

  return { pages, accounts, attention };
}
```

(The `connectionSummary` import is gone; `connection-status.ts` itself is unchanged — other callers use it.)

- [ ] **Step 2: Create the shared status UI**

Create `src/components/settings/integration-ui.tsx`:

```tsx
"use client";

import {
  BookUser,
  Bot,
  CalendarDays,
  FileSpreadsheet,
  KeyRound,
  Send,
  Sparkles,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import type { IntegrationTabId } from "@/components/settings/sections";
import type { PageStatus } from "@/lib/integration-status";
import { cn } from "@/lib/utils";

const ICONS: Record<IntegrationTabId, LucideIcon> = {
  google: Users,
  microsoft: BookUser,
  linkedin: FileSpreadsheet,
  ai: Sparkles,
  assistants: Bot,
  reminders: CalendarDays,
  api: KeyRound,
  webhooks: Webhook,
  outreach: Send,
};

/** Decorative: every use sits beside the page's name. */
export function IntegrationIcon({ id, className }: { id: IntegrationTabId; className?: string }) {
  const Icon = ICONS[id];
  return <Icon aria-hidden className={className} />;
}

/** `undefined` is still loading; `none` is a page with nothing to be on or off. */
export function StatusDot({
  status,
  className,
}: {
  status: PageStatus | "unknown" | undefined;
  className?: string;
}) {
  if (status === undefined) {
    return (
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground/30", className)}
      />
    );
  }
  if (status !== "unknown" && status.state === "none") return null;
  const state = status === "unknown" ? "off" : status.state;
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        state === "on" && "bg-primary",
        state === "partial" && "bg-warning",
        state === "off" && "bg-muted-foreground/35",
        className
      )}
    />
  );
}

export function statusText(status: PageStatus | "unknown" | undefined) {
  if (status === undefined) return "Checking…";
  if (status === "unknown") return "Couldn’t check";
  return status.detail;
}
```

- [ ] **Step 3: Switch the dialog and card to it**

In `src/components/settings/integrations-dialog.tsx`:
- Delete `INTEGRATION_ICONS`, `StatusDot` and `statusText` (and the now-unused lucide icon imports and `type LucideIcon`, and the `IntegrationStatus` import).
- Import `import { IntegrationIcon, StatusDot, statusText } from "@/components/settings/integration-ui";` and `import type { IntegrationStatuses } from "@/lib/integration-status";` (replacing the `@/actions/integrations` type import).
- In the tab row, replace `const Icon = INTEGRATION_ICONS[t.id];` + `<Icon … />` with `<IntegrationIcon id={t.id} className={cn("size-4 shrink-0", selected ? "text-primary" : "opacity-80")} />`, and `const status = statuses?.[t.id];` with `const status = statuses?.pages[t.id];`.

In `src/components/settings/integrations-settings.tsx`:
- Import `IntegrationIcon, StatusDot, statusText` from `@/components/settings/integration-ui` instead of the dialog (keep `IntegrationsDialog` and `tabForImportJob` from the dialog); import `type IntegrationStatuses` from `@/lib/integration-status` (the `getIntegrationStatuses` value import stays on `@/actions/integrations`).
- Replace `const Icon = INTEGRATION_ICONS[t.id];` + `<Icon className="size-4" aria-hidden />` with `<IntegrationIcon id={t.id} className="size-4" />`.
- Replace `statuses[id]` / `statuses?.[t.id]` with `statuses.pages[id]` / `statuses?.pages[t.id]`.

- [ ] **Step 4: Typecheck, lint, smokes, commit**

Run: `npx tsc --noEmit` — no errors.
Run: `npx eslint src/actions/integrations.ts src/components/settings` — 0 errors.
Run: `npx tsx scripts/smoke-integration-status.ts && npx tsx scripts/smoke-connection-status.ts` — all ok.

```bash
git add src/actions/integrations.ts src/components/settings/integration-ui.tsx src/components/settings/integrations-dialog.tsx src/components/settings/integrations-settings.tsx
git commit -m "Report each integration page honestly, Google and Microsoft per feature"
```

---

### Task 6: Provider marks and the Overview page

**Files:**
- Create: `src/components/settings/provider-marks.tsx`
- Modify: `src/components/settings/integration-ui.tsx` (marks for the three accounts)
- Modify: `src/lib/integration-status.ts` (add `overviewAction`)
- Modify: `scripts/smoke-integration-status.ts` (overview action checks)
- Create: `src/components/settings/integrations-overview.tsx`

**Interfaces:**
- Consumes: `IntegrationStatuses`, `AccountStatus`, `PageStatus` (Task 1); `OVERVIEW_TABS`, `integrationLabel` (Task 4); `IntegrationIcon`, `StatusDot`, `statusText` (Task 5).
- Produces:
  - `GoogleMark`, `MicrosoftMark`, `LinkedInMark` — `({ className }: { className?: string }) => JSX.Element`
  - `overviewAction(id: IntegrationTabId, page: PageStatus | "unknown" | undefined, account?: AccountStatus | "unknown"): { label: string; primary: boolean }`
  - `IntegrationsOverview({ tabs, statuses, onOpen }: { tabs: IntegrationTabId[]; statuses: IntegrationStatuses | null; onOpen: (tab: IntegrationTabId) => void })`

- [ ] **Step 1: Add failing checks for the Overview buttons**

In `scripts/smoke-integration-status.ts`, add `overviewAction` to the import list, and insert before the final `if (failures > 0)`:

```ts
console.log("\noverviewAction");
const label = (...args: Parameters<typeof overviewAction>) => overviewAction(...args).label;
const offGoogle = googleAccountStatus(google({ connected: false, status: null }), pro);
check("an unconnected account offers Connect", label("google", accountPageStatus(offGoogle), offGoogle) === "Connect Google");
check("Connect is the primary action", overviewAction("google", accountPageStatus(offGoogle), offGoogle).primary);
const offMicrosoft = microsoftAccountStatus(microsoft({ connected: false, status: null }), pro);
check("names Microsoft", label("microsoft", accountPageStatus(offMicrosoft), offMicrosoft) === "Connect Microsoft");
const expiredGoogle = googleAccountStatus(google({ connected: false, status: "needs_reauth" }), pro);
check("an expired account offers Sign in again", label("google", accountPageStatus(expiredGoogle), expiredGoogle) === "Sign in again");
check("a connected account offers Manage", label("google", accountPageStatus(g), g) === "Manage");
check("a still-loading account offers Open", label("google", undefined, undefined) === "Open");
check("an unavailable account offers Open", label("google", undefined, googleAccountStatus(google({ configured: false }), pro)) === "Open");
check("LinkedIn never imported", label("linkedin", linkedinPageStatus(null, now)) === "Import");
check("LinkedIn imported before", label("linkedin", linkedinPageStatus(new Date("2026-09-01T00:00:00Z"), now)) === "Import again");
check("AI off", label("ai", aiOff) === "Turn on AI" && overviewAction("ai", aiOff).primary);
check("AI on", label("ai", aiPageStatus({ ready: true, providerLabel: null })) === "Manage");
check("assistants", label("assistants", { state: "none", detail: "" }) === "Set up");
check("reminders off", label("reminders", remindersPageStatus({ enabled: false, lastFetchedAt: null }, now)) === "Set up");
check("reminders on", label("reminders", remindersPageStatus({ enabled: true, lastFetchedAt: null }, now)) === "Manage");
```

Run: `npx tsx scripts/smoke-integration-status.ts`
Expected: FAIL — `overviewAction` is not exported.

- [ ] **Step 2: Add `overviewAction`**

Append to `src/lib/integration-status.ts`:

```ts
/**
 * The one button on each Overview card. Only "Connect …", "Sign in again" and "Turn on AI"
 * are primary: they are the steps that make something work, not ways to look at it.
 */
export function overviewAction(
  id: IntegrationTabId,
  page: PageStatus | "unknown" | undefined,
  account?: AccountStatus | "unknown"
): { label: string; primary: boolean } {
  const on = page !== undefined && page !== "unknown" && page.state === "on";
  switch (id) {
    case "google":
    case "microsoft": {
      if (!account || account === "unknown" || account.state === "not_configured") {
        return { label: "Open", primary: false };
      }
      if (account.state === "not_connected") {
        return { label: `Connect ${id === "google" ? "Google" : "Microsoft"}`, primary: true };
      }
      if (account.state === "needs_reauth") return { label: "Sign in again", primary: true };
      return { label: "Manage", primary: false };
    }
    case "linkedin":
      return { label: on ? "Import again" : "Import", primary: false };
    case "ai":
      return on ? { label: "Manage", primary: false } : { label: "Turn on AI", primary: true };
    case "assistants":
      return { label: "Set up", primary: false };
    case "reminders":
      return { label: on ? "Manage" : "Set up", primary: false };
    default:
      return { label: "Open", primary: false };
  }
}
```

Run: `npx tsx scripts/smoke-integration-status.ts` — Expected: all ok.

- [ ] **Step 3: Create the provider marks**

Create `src/components/settings/provider-marks.tsx`:

```tsx
/**
 * The Google, Microsoft and LinkedIn marks, in the providers' own colours as their brand
 * guidelines ask. Decorative: the provider's name always sits beside them.
 */
type MarkProps = { className?: string };

export function GoogleMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden className={className}>
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}

export function MicrosoftMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 21 21" aria-hidden className={className}>
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

export function LinkedInMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path
        fill="#0A66C2"
        d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.125 2.062 2.062 0 0 1 0 4.125zM7.119 20.452H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"
      />
    </svg>
  );
}
```

In `src/components/settings/integration-ui.tsx`, import the marks and draw them for the three account pages:

```tsx
import { GoogleMark, LinkedInMark, MicrosoftMark } from "@/components/settings/provider-marks";

const MARKS: Partial<Record<IntegrationTabId, (props: { className?: string }) => React.JSX.Element>> = {
  google: GoogleMark,
  microsoft: MicrosoftMark,
  linkedin: LinkedInMark,
};

/** Decorative: every use sits beside the page's name. Accounts get their provider's mark. */
export function IntegrationIcon({ id, className }: { id: IntegrationTabId; className?: string }) {
  const Mark = MARKS[id];
  if (Mark) return <Mark className={className} />;
  const Icon = ICONS[id];
  return <Icon aria-hidden className={className} />;
}
```

(Replace the previous `IntegrationIcon`; the lucide entries for `google`/`microsoft`/`linkedin` stay in `ICONS` as the type requires every id.)

- [ ] **Step 4: Create the Overview page**

Create `src/components/settings/integrations-overview.tsx`:

```tsx
"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IntegrationIcon, StatusDot, statusText } from "@/components/settings/integration-ui";
import { OVERVIEW_TABS, integrationLabel, type IntegrationTabId } from "@/components/settings/sections";
import { overviewAction, type IntegrationStatuses } from "@/lib/integration-status";

const DESCRIPTIONS: Partial<Record<IntegrationTabId, string>> = {
  google: "Contacts, calendar and Gmail.",
  microsoft: "Outlook contacts, calendar and mail.",
  linkedin: "Your connections and messages.",
  ai: "Turns your notes into contacts and answers questions about your network.",
  assistants: "Use Orbit from inside Claude or ChatGPT.",
  reminders: "See your follow-ups next to your meetings.",
};

/**
 * The Integrations dialog's home: anything that needs fixing, then one card per account with
 * its status and the one thing to do next. Advanced pages get no card — they are reachable
 * from the nav for the people who want them.
 */
export function IntegrationsOverview({
  tabs,
  statuses,
  onOpen,
}: {
  /** Visible pages — hidden surfaces already filtered out. */
  tabs: IntegrationTabId[];
  statuses: IntegrationStatuses | null;
  onOpen: (tab: IntegrationTabId) => void;
}) {
  const cards = OVERVIEW_TABS.filter((id) => tabs.includes(id));
  const attention = (statuses?.attention ?? []).filter((item) => tabs.includes(item.tab));

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-medium text-ink">Overview</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          What Orbit is connected to, and what’s left to set up.
        </p>
      </div>

      {attention.length > 0 ? (
        <ul aria-label="Needs your attention" className="space-y-2">
          {attention.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm"
            >
              <TriangleAlert aria-hidden className="size-4 shrink-0 text-warning" />
              <span className="min-w-0 flex-1 text-foreground">{item.message}</span>
              <Button size="sm" variant="outline" onClick={() => onOpen(item.tab)}>
                {item.action}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="grid gap-3 sm:grid-cols-2">
        {cards.map((id) => {
          const status = statuses?.pages[id];
          const account = id === "google" || id === "microsoft" ? statuses?.accounts[id] : undefined;
          const action = overviewAction(id, status, account);
          const showStatus = !(status && status !== "unknown" && status.state === "none");
          return (
            <li key={id} className="flex flex-col gap-3 rounded-xl border border-border/60 p-4">
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70">
                  <IntegrationIcon id={id} className="size-4" />
                </span>
                <h4 className="text-sm font-medium text-ink">{integrationLabel(id)}</h4>
              </div>
              <p className="text-sm text-muted-foreground">{DESCRIPTIONS[id]}</p>
              {showStatus ? (
                <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <StatusDot status={status} />
                  <span className="truncate">{statusText(status)}</span>
                </p>
              ) : null}
              <div className="mt-auto">
                <Button
                  size="sm"
                  variant={action.primary ? "default" : "outline"}
                  onClick={() => onOpen(id)}
                >
                  {action.label}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

In P1 every card button opens its page (P2 makes "Connect Google/Microsoft" start sign-in straight from the card).

- [ ] **Step 5: Typecheck, lint, smoke, commit**

Run: `npx tsc --noEmit` — no errors.
Run: `npx eslint src/components/settings src/lib/integration-status.ts` — 0 errors.
Run: `npx tsx scripts/smoke-integration-status.ts` — all ok.

```bash
git add src/components/settings/provider-marks.tsx src/components/settings/integration-ui.tsx src/components/settings/integrations-overview.tsx src/lib/integration-status.ts scripts/smoke-integration-status.ts
git commit -m "Add the Integrations overview: what needs fixing, then one card per account"
```

---

### Task 7: The dialog shell and the Settings card that opens it

The dialog's props and its only caller change together, so this is one task with one commit.

**Files:**
- Modify (rewrite): `src/components/settings/integrations-dialog.tsx`
- Modify (rewrite): `src/components/settings/integrations-settings.tsx`

**Interfaces:**
- Consumes: Tasks 3–6 (`AssistantsSettings`; `OVERVIEW`, `OVERVIEW_TABS`, `INTEGRATION_PARAM`, `integrationLabel`, `legacyHashTab`, `resolveIntegrationParam`; `IntegrationIcon`/`StatusDot`/`statusText`; `IntegrationsOverview`; `IntegrationStatuses`; `getIntegrationStatuses`).
- Produces:
  - `IntegrationsDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; view: IntegrationView; onViewChange: (view: IntegrationView) => void; focus: IntegrationFocus | null; tabs: IntegrationTabId[]; statuses: IntegrationStatuses | null; inboxVisible: boolean; initialSettings: Settings; canUseRecruiters: boolean })`
  - `tabForImportJob(kind: ImportJobKind): IntegrationTabId | null` (unchanged name)
  - `IntegrationsSettings({ tabs, inboxVisible, initialSettings, canUseRecruiters })` — same props as after Task 4.

Dialog behaviour: it opens on `view` (Overview by default); wide screens show a side nav — an "Integrations" tablist (Overview, Your accounts, AI and calendar) and, below a divider, an **Advanced** disclosure button controlling a second "Advanced" tablist. Advanced opens by itself when the selected view is inside it (a deep link or a card); keyboard users reach it through the disclosure button, since a tablist may contain only tabs — this is how the spec's "the keyboard moving into it" is realised. Below `md` the nav is hidden: Overview is the list and every other page shows a Back button in the header. `focus: "inbox"` scrolls the Google page to `#integration-google-inbox`.

Card behaviour: the card lists the Overview rows (no Advanced rows) with their status; **Manage** opens the dialog on Overview (or on the running import's page); clicking a row opens that page; `?integration=` (including old ids and `gmail`'s inbox focus) and `#settings-*` open the right view; a running import job opens on its page.

- [ ] **Step 1: Replace the file**

Replace `src/components/settings/integrations-dialog.tsx` entirely with:

```tsx
"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, LayoutGrid } from "lucide-react";
import type { getSettings } from "@/actions/settings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { AiSettings } from "@/components/settings/ai-settings";
import { AiUsageCard } from "@/components/settings/ai-usage-card";
import { ApiSettings } from "@/components/settings/api-settings";
import { AssistantsSettings } from "@/components/settings/assistants-settings";
import { CalendarFeedSettings } from "@/components/settings/calendar-feed-settings";
import { IntegrationIcon, StatusDot, statusText } from "@/components/settings/integration-ui";
import { IntegrationsOverview } from "@/components/settings/integrations-overview";
import { OutreachSettings } from "@/components/settings/outreach-settings";
import { SettingsSurfaceProvider } from "@/components/settings/settings-section";
import { WebhookSettings } from "@/components/settings/webhook-settings";
import {
  INTEGRATION_TAB_GROUPS,
  INTEGRATION_TABS,
  OVERVIEW,
  integrationHref,
  type IntegrationFocus,
  type IntegrationTabId,
  type IntegrationView,
} from "@/components/settings/sections";
import { ImportProgress } from "@/components/imports/import-utils";
import {
  cancelImportJob,
  useImportJob,
  type ImportJobKind,
} from "@/lib/import-job-runner";
import type { IntegrationStatuses } from "@/lib/integration-status";
import { cn } from "@/lib/utils";

type Settings = Awaited<ReturnType<typeof getSettings>>;

/**
 * The page an in-flight import job belongs to. The calendar-file and contacts-file imports
 * live only on /imports, so they have none.
 */
export function tabForImportJob(kind: ImportJobKind): IntegrationTabId | null {
  switch (kind) {
    case "connections":
    case "messages":
      return "linkedin";
    case "google_contacts":
      return "google";
    case "outlook_contacts":
      return "microsoft";
    case "contacts_file":
    case "calendar":
      return null;
  }
}

const PanelSkeleton = () => (
  <div className="space-y-3" aria-busy="true" aria-label="Loading">
    <Skeleton className="h-6 w-44" />
    <Skeleton className="h-4 w-3/4" />
    <Skeleton className="h-28 w-full rounded-xl" />
    <Skeleton className="h-9 w-36 rounded-lg" />
  </div>
);

// The importers are the heavy half of this dialog — CSV parsing, review tables — and most
// visits never open them, so they load on first open of their page, as on /imports.
const GoogleContactsImport = dynamic(
  () =>
    import("@/components/imports/google-contacts-import").then((m) => ({
      default: m.GoogleContactsImport,
    })),
  { loading: () => <PanelSkeleton /> }
);
const OutlookContactsImport = dynamic(
  () =>
    import("@/components/imports/outlook-contacts-import").then((m) => ({
      default: m.OutlookContactsImport,
    })),
  { loading: () => <PanelSkeleton /> }
);
const LinkedInConnectionsImport = dynamic(
  () =>
    import("@/components/imports/linkedin-connections-import").then((m) => ({
      default: m.LinkedInConnectionsImport,
    })),
  { loading: () => <PanelSkeleton /> }
);
const LinkedInMessagesImport = dynamic(
  () =>
    import("@/components/imports/linkedin-messages-import").then((m) => ({
      default: m.LinkedInMessagesImport,
    })),
  { loading: () => <PanelSkeleton /> }
);
const GmailTab = dynamic(
  () =>
    import("@/components/settings/integrations-gmail-tab").then((m) => ({
      default: m.GmailTab,
    })),
  { loading: () => <PanelSkeleton /> }
);

function isAdvanced(view: IntegrationView): boolean {
  return INTEGRATION_TABS.some((tab) => tab.id === view && tab.group === "advanced");
}

/** The element a `focus` lands on, e.g. `integration-google-inbox`. */
function focusTargetId(view: IntegrationView, focus: IntegrationFocus) {
  return `integration-${view}-${focus}`;
}

/**
 * Settings → Integrations: the accounts Orbit works with, one page each, with the developer
 * tools folded into Advanced.
 *
 * Pages mount the first time they open and then stay mounted (hidden) for as long as the
 * dialog is open — the same rule as /imports — so a half-reviewed Google import or an API key
 * still waiting to be copied survives a detour to another page. Import jobs outlive the
 * dialog altogether: the job runner is a module singleton, and the app shell's watcher and
 * progress bar keep reporting after it closes.
 */
export function IntegrationsDialog({
  open,
  onOpenChange,
  view,
  onViewChange,
  focus,
  tabs,
  statuses,
  inboxVisible,
  initialSettings,
  canUseRecruiters,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: IntegrationView;
  onViewChange: (view: IntegrationView) => void;
  /** Where inside `view` to land — set by links like `?integration=gmail`. */
  focus: IntegrationFocus | null;
  /** The pages this viewer may see, in order — already filtered for hidden surfaces. */
  tabs: IntegrationTabId[];
  statuses: IntegrationStatuses | null;
  /** False when /recruiters is hidden: the Google page then leaves out its Gmail inbox block. */
  inboxVisible: boolean;
  initialSettings: Settings;
  canUseRecruiters: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex h-[min(88dvh,46rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl",
          "md:grid md:grid-cols-[14.5rem_minmax(0,1fr)]"
        )}
      >
        <DialogBody
          active={open}
          view={view}
          onViewChange={onViewChange}
          focus={focus}
          tabs={tabs}
          statuses={statuses}
          inboxVisible={inboxVisible}
          initialSettings={initialSettings}
          canUseRecruiters={canUseRecruiters}
        />
      </DialogContent>
    </Dialog>
  );
}

function DialogBody({
  active,
  view,
  onViewChange,
  focus,
  tabs,
  statuses,
  inboxVisible,
  initialSettings,
  canUseRecruiters,
}: {
  /**
   * False from the moment the dialog starts closing. Base UI only unmounts the body once
   * its exit animation ends — which a backgrounded tab never finishes — so anything that
   * polls has to stop on this, not on unmount.
   */
  active: boolean;
  view: IntegrationView;
  onViewChange: (view: IntegrationView) => void;
  focus: IntegrationFocus | null;
  tabs: IntegrationTabId[];
  statuses: IntegrationStatuses | null;
  inboxVisible: boolean;
  initialSettings: Settings;
  canUseRecruiters: boolean;
}) {
  const job = useImportJob();
  const [visited, setVisited] = useState<ReadonlySet<IntegrationView>>(() => new Set([view]));
  const [advancedOpen, setAdvancedOpen] = useState(() => isAdvanced(view));
  const tabRefs = useRef(new Map<IntegrationView, HTMLButtonElement>());
  const panelScroller = useRef<HTMLDivElement>(null);

  // Adjusted during render rather than in an effect: a page chosen from outside (a deep
  // link, the card) must be mounted — and its nav row shown — in the same paint it is
  // selected in.
  if (!visited.has(view)) setVisited(new Set(visited).add(view));
  if (isAdvanced(view) && !advancedOpen) setAdvancedOpen(true);

  // Each page starts at its own top (or at the spot a link asked for) rather than wherever
  // the last one was scrolled to, and its nav row is brought into view.
  useEffect(() => {
    const target = focus ? document.getElementById(focusTargetId(view, focus)) : null;
    if (target) target.scrollIntoView({ block: "start" });
    else panelScroller.current?.scrollTo({ top: 0 });
    tabRefs.current.get(view)?.scrollIntoView({ block: "nearest" });
  }, [view, focus]);

  const runningTab = job?.status === "running" ? tabForImportJob(job.kind) : null;
  const runningProgress = job?.status === "running" && job.progress ? job.progress : null;

  const visibleTabs = INTEGRATION_TABS.filter((tab) => tabs.includes(tab.id));
  const mainGroups = INTEGRATION_TAB_GROUPS.filter((group) => group.key !== "advanced")
    .map((group) => ({ ...group, tabs: visibleTabs.filter((tab) => tab.group === group.key) }))
    .filter((group) => group.tabs.length > 0);
  const advancedTabs = visibleTabs.filter((tab) => tab.group === "advanced");
  const mainIds: IntegrationView[] = [OVERVIEW, ...mainGroups.flatMap((g) => g.tabs.map((t) => t.id))];
  const advancedIds: IntegrationView[] = advancedTabs.map((tab) => tab.id);
  const views: IntegrationView[] = [OVERVIEW, ...visibleTabs.map((tab) => tab.id)];

  function onTabKeyDown(event: React.KeyboardEvent<HTMLDivElement>, ids: IntegrationView[]) {
    const index = ids.indexOf(view);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = index < 0 ? 0 : (index + 1) % ids.length;
        break;
      case "ArrowUp":
        next = index < 0 ? ids.length - 1 : (index - 1 + ids.length) % ids.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = ids.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const id = ids[next];
    onViewChange(id);
    tabRefs.current.get(id)?.focus();
  }

  function tabRow(id: IntegrationView, label: string, ids: IntegrationView[]) {
    const selected = id === view;
    // Roving tabindex per tablist: the selected row, or the first row when the selection
    // is in the other list.
    const tabbable = selected || (!ids.includes(view) && id === ids[0]);
    const status = id === OVERVIEW ? undefined : statuses?.pages[id];
    const iconClass = cn("size-4 shrink-0", selected ? "text-primary" : "opacity-80");
    return (
      <button
        key={id}
        ref={(el) => {
          if (el) tabRefs.current.set(id, el);
          else tabRefs.current.delete(id);
        }}
        type="button"
        role="tab"
        id={`integration-tab-${id}`}
        aria-selected={selected}
        aria-controls={`integration-panel-${id}`}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => onViewChange(id)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm whitespace-nowrap",
          "outline-none transition-colors duration-fast ease-house focus-visible:ring-2 focus-visible:ring-ring/70",
          selected
            ? "bg-card text-ink shadow-sm ring-1 ring-border/70"
            : "text-muted-foreground hover:bg-card/60 hover:text-foreground"
        )}
      >
        {id === OVERVIEW ? (
          <LayoutGrid aria-hidden className={iconClass} />
        ) : (
          <IntegrationIcon id={id} className={iconClass} />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">
          {label}
          {runningTab === id ? <span className="text-muted-foreground"> · running</span> : null}
        </span>
        {id === OVERVIEW ? null : (
          <>
            <StatusDot status={status} />
            <span className="sr-only">, {statusText(status)}</span>
          </>
        )}
      </button>
    );
  }

  return (
    <>
      <aside className="flex shrink-0 flex-col border-b border-border/60 bg-muted/30 md:min-h-0 md:border-r md:border-b-0">
        <div className="flex items-center gap-1.5 px-4 pt-4 pb-3 pr-12 md:block md:px-5 md:pt-5 md:pr-5">
          {view !== OVERVIEW ? (
            <button
              type="button"
              onClick={() => onViewChange(OVERVIEW)}
              aria-label="Back to overview"
              className="tap-target -ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-card/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 md:hidden"
            >
              <ChevronLeft aria-hidden className="size-5" />
            </button>
          ) : null}
          <div className="min-w-0">
            <DialogTitle className="font-[family-name:var(--font-display)] text-xl text-ink">
              Integrations
            </DialogTitle>
            <DialogDescription className="mt-1.5 hidden text-xs md:block">
              Connect the accounts Orbit works with.
            </DialogDescription>
          </div>
        </div>

        <nav
          aria-label="Integrations"
          className="hidden min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4 md:flex"
        >
          <div
            role="tablist"
            aria-label="Integrations"
            aria-orientation="vertical"
            onKeyDown={(event) => onTabKeyDown(event, mainIds)}
          >
            {tabRow(OVERVIEW, "Overview", mainIds)}
            {mainGroups.map((group) => (
              <div key={group.key}>
                <p
                  aria-hidden
                  className="px-2.5 pt-3 pb-1.5 text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase"
                >
                  {group.label}
                </p>
                {group.tabs.map((tab) => tabRow(tab.id, tab.label, mainIds))}
              </div>
            ))}
          </div>

          {advancedTabs.length > 0 ? (
            <div className="mt-3 border-t border-border/60 pt-2">
              <button
                type="button"
                aria-expanded={advancedOpen}
                aria-controls="integration-advanced-tabs"
                onClick={() => setAdvancedOpen((wasOpen) => !wasOpen)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground outline-none hover:bg-card/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70"
              >
                <ChevronRight
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0 transition-transform duration-fast ease-house",
                    advancedOpen && "rotate-90"
                  )}
                />
                Advanced
              </button>
              {advancedOpen ? (
                <div
                  id="integration-advanced-tabs"
                  role="tablist"
                  aria-label="Advanced"
                  aria-orientation="vertical"
                  onKeyDown={(event) => onTabKeyDown(event, advancedIds)}
                >
                  {advancedTabs.map((tab) => tabRow(tab.id, tab.label, advancedIds))}
                </div>
              ) : null}
            </div>
          ) : null}
        </nav>
      </aside>

      <div ref={panelScroller} className="min-h-0 flex-1 overflow-y-auto">
        <SettingsSurfaceProvider surface="panel">
          {views.map((id) =>
            visited.has(id) ? (
              <div
                key={id}
                role="tabpanel"
                id={`integration-panel-${id}`}
                aria-labelledby={`integration-tab-${id}`}
                hidden={id !== view}
                className="space-y-5 p-5 md:p-7"
              >
                {id === OVERVIEW ? (
                  <IntegrationsOverview tabs={tabs} statuses={statuses} onOpen={onViewChange} />
                ) : (
                  <>
                    {runningProgress && runningTab === id ? (
                      <ImportProgress
                        {...runningProgress}
                        cancelling={Boolean(job?.cancelling)}
                        onCancel={cancelImportJob}
                      />
                    ) : null}
                    <Panel
                      id={id}
                      active={active}
                      inboxVisible={inboxVisible}
                      initialSettings={initialSettings}
                      canUseRecruiters={canUseRecruiters}
                    />
                  </>
                )}
              </div>
            ) : null
          )}
        </SettingsSurfaceProvider>
      </div>
    </>
  );
}

function Panel({
  id,
  active,
  inboxVisible,
  initialSettings,
  canUseRecruiters,
}: {
  id: IntegrationTabId;
  active: boolean;
  inboxVisible: boolean;
  initialSettings: Settings;
  canUseRecruiters: boolean;
}) {
  switch (id) {
    case "google":
      return (
        <div className="space-y-5">
          <GoogleContactsImport returnTo={integrationHref("google")} />
          {inboxVisible ? (
            <div id={focusTargetId("google", "inbox")} className="scroll-mt-4">
              <GmailTab active={active} canUseRecruiters={canUseRecruiters} returnTo={integrationHref("gmail")} />
            </div>
          ) : null}
        </div>
      );
    case "microsoft":
      return <OutlookContactsImport returnTo={integrationHref("microsoft")} />;
    case "linkedin":
      return (
        <div className="space-y-5">
          <LinkedInConnectionsImport />
          <LinkedInMessagesImport />
        </div>
      );
    case "ai":
      return (
        <div className="space-y-5">
          <AiSettings initialSettings={initialSettings} />
          <AiUsageCard />
        </div>
      );
    case "assistants":
      return <AssistantsSettings />;
    case "reminders":
      return <CalendarFeedSettings />;
    case "api":
      return <ApiSettings />;
    case "webhooks":
      return <WebhookSettings />;
    case "outreach":
      return <OutreachSettings initial={initialSettings.outreach} />;
  }
}
```

- [ ] **Step 2: Replace the Settings card**

(`tsc` fails between Steps 1 and 2 — the card still passes `tab`/`onTabChange`. That is expected; don't commit in between.)

Replace `src/components/settings/integrations-settings.tsx` entirely with:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";
import type { getSettings } from "@/actions/settings";
import { getIntegrationStatuses } from "@/actions/integrations";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/settings-section";
import {
  INTEGRATION_PARAM,
  OVERVIEW,
  OVERVIEW_TABS,
  integrationLabel,
  legacyHashTab,
  resolveIntegrationParam,
  type IntegrationFocus,
  type IntegrationTabId,
  type IntegrationView,
} from "@/components/settings/sections";
import { IntegrationIcon, StatusDot, statusText } from "@/components/settings/integration-ui";
import { IntegrationsDialog, tabForImportJob } from "@/components/settings/integrations-dialog";
import { useImportJob } from "@/lib/import-job-runner";
import type { IntegrationStatuses } from "@/lib/integration-status";
import { cn } from "@/lib/utils";

type Settings = Awaited<ReturnType<typeof getSettings>>;

/**
 * The Integrations group's one card: each account at a glance, and the way into the dialog
 * where it is set up.
 *
 * Opened three ways besides a click, all of which have to land on the right page:
 *   - `?integration=<page>` — the link every other part of the app uses (`integrationHref`),
 *     and the `returnTo` a Google or Microsoft consent screen sends the user back to. Old ids
 *     (`gmail`, `outlook`, `calendar`) still resolve, `gmail` to the Google page's inbox;
 *   - `#settings-ai` and the other anchors these pages had when they were cards on the page;
 *   - an import job running when Settings loads, which opens on its importer's page.
 */
export function IntegrationsSettings({
  tabs,
  inboxVisible,
  initialSettings,
  canUseRecruiters,
}: {
  /** Visible pages, in order — hidden surfaces already filtered out by the page. */
  tabs: IntegrationTabId[];
  /** False when /recruiters is hidden — the Google page drops its inbox block. */
  inboxVisible: boolean;
  initialSettings: Settings;
  canUseRecruiters: boolean;
}) {
  const searchParams = useSearchParams();
  const job = useImportJob();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<IntegrationView>(OVERVIEW);
  const [focus, setFocus] = useState<IntegrationFocus | null>(null);
  const [statuses, setStatuses] = useState<IntegrationStatuses | null>(null);

  const refreshStatuses = useCallback(() => {
    let settled = false;
    const attempt = () =>
      getIntegrationStatuses().then(
        (next) => {
          settled = true;
          setStatuses(next);
        },
        () => {
          // The rows just keep saying "Checking…"; nothing here is worth an error toast.
        }
      );
    void attempt();
    // A server action queued when a `history.replaceState` lands is dropped by the router
    // and never settles — and the importer cards strip their OAuth params exactly that way
    // as they mount. Ask once more rather than leave every row on "Checking…".
    window.setTimeout(() => {
      if (!settled) void attempt();
    }, 6_000);
  }, []);

  useEffect(refreshStatuses, [refreshStatuses]);

  const rows = OVERVIEW_TABS.filter((id) => tabs.includes(id));

  /** Opens on `next` when this viewer can see it; otherwise on the Overview. */
  const show = useCallback(
    (next: IntegrationView, nextFocus: IntegrationFocus | null = null) => {
      const visible = next === OVERVIEW || tabs.includes(next);
      setView(visible ? next : OVERVIEW);
      setFocus(visible ? nextFocus : null);
      setOpen(true);
    },
    [tabs]
  );

  const openOn = useCallback(
    (next?: IntegrationTabId) => {
      const running = job?.status === "running" ? tabForImportJob(job.kind) : null;
      // With only Advanced pages visible the Overview would be empty, so start on a page.
      const home: IntegrationView = rows.length > 0 ? OVERVIEW : (tabs[0] ?? OVERVIEW);
      show(next ?? (running && tabs.includes(running) ? running : home));
    },
    [job, tabs, rows.length, show]
  );

  // `?integration=` — read through `useSearchParams` so a link clicked while already on
  // Settings (the notifications panel is reachable from here) opens the dialog without a
  // remount. Opened while rendering rather than in an effect, so the dialog is up in the
  // same paint the URL asks for it; `handled` makes each request count once.
  const requested = searchParams.get(INTEGRATION_PARAM);
  const [handled, setHandled] = useState<string | null>(null);
  if (requested !== handled) {
    setHandled(requested);
    const resolved = resolveIntegrationParam(requested);
    if (resolved && (resolved.view === OVERVIEW || tabs.includes(resolved.view))) {
      setView(resolved.view);
      setFocus(resolved.focus);
      setOpen(true);
    }
  }

  // The old per-card anchors.
  useEffect(() => {
    function openForHash() {
      const target = legacyHashTab(window.location.hash);
      if (target && tabs.includes(target)) show(target);
    }
    openForHash();
    window.addEventListener("hashchange", openForHash);
    return () => window.removeEventListener("hashchange", openForHash);
  }, [tabs, show]);

  /**
   * Spend the deep link — `?integration=` or a legacy hash — so a reload shows the page
   * rather than reopening the dialog.
   *
   * On close, and only on close. Next patches `history.replaceState` into a router
   * "restore", and a restore that lands while a server action is queued drops that action
   * without ever settling it. Stripping the param on open did exactly that to the panel
   * that had just mounted: its first load never left the browser, and it sat on its
   * skeleton until its own timeout. By the time the dialog closes, nothing is queued.
   */
  function clearDeepLink() {
    const params = new URLSearchParams(window.location.search);
    const hadParam = params.has(INTEGRATION_PARAM);
    params.delete(INTEGRATION_PARAM);
    const legacyHash = legacyHashTab(window.location.hash);
    if (!hadParam && !legacyHash) return;
    const rest = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${rest ? `?${rest}` : ""}${legacyHash ? "" : window.location.hash}`
    );
  }

  if (tabs.length === 0) return null;

  const connected = statuses
    ? rows.filter((id) => {
        const s = statuses.pages[id];
        return s !== undefined && s !== "unknown" && s.state === "on";
      }).length
    : null;

  return (
    <SettingsSection
      title="Integrations"
      description={
        connected
          ? `${connected} set up. Connect the accounts Orbit works with.`
          : "Connect the accounts Orbit works with."
      }
      action={
        <Button size="sm" variant="outline" onClick={() => openOn()}>
          Manage
        </Button>
      }
    >
      {rows.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {rows.map((id) => {
            const status = statuses?.pages[id];
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => openOn(id)}
                  className={cn(
                    "group/row flex w-full items-center gap-3 rounded-xl border border-border/60 px-3 py-2.5 text-left",
                    "outline-none transition-colors duration-fast ease-house",
                    "hover:border-border hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/70"
                  )}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground transition-colors group-hover/row:text-primary">
                    <IntegrationIcon id={id} className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">
                      {integrationLabel(id)}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusDot status={status} />
                      <span className="truncate">{statusText(status)}</span>
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground/50 transition-transform duration-fast ease-house group-hover/row:translate-x-0.5"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <IntegrationsDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) return;
          // Strip first, so the refresh below is queued behind the restore, not dropped by it.
          clearDeepLink();
          // Whatever was connected, saved or revoked in there should show on the card.
          refreshStatuses();
        }}
        view={view}
        onViewChange={(next) => {
          setView(next);
          setFocus(null);
        }}
        focus={focus}
        tabs={tabs}
        statuses={statuses}
        inboxVisible={inboxVisible}
        initialSettings={initialSettings}
        canUseRecruiters={canUseRecruiters}
      />
    </SettingsSection>
  );
}
```

- [ ] **Step 3: Typecheck, lint, smokes**

Run: `npx tsc --noEmit` — no errors.
Run: `npx eslint src/components/settings` — 0 errors. (If `react-hooks` flags the render-time `setView`/`setFocus`/`setVisited`/`setAdvancedOpen`, it is the same pattern the previous files used for `setTab`/`setOpen`/`setVisited`; match whatever suppression, if any, they had — `git show HEAD~1:src/components/settings/integrations-settings.tsx | grep -n eslint`.)
Run: `npx tsx scripts/smoke-settings-layout.ts && npx tsx scripts/smoke-integration-status.ts` — all ok.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/integrations-dialog.tsx src/components/settings/integrations-settings.tsx
git commit -m "Open Integrations on an overview, fold developer tools into Advanced, add phone Back"
```

---

### Task 8: Point every link at the new pages

**Files:**
- Modify: `src/lib/account-alerts.ts:488-512`
- Modify: `scripts/smoke-account-alerts.ts:475`
- Modify: `src/components/reminders/reminder-calendar-sync.tsx:190`
- Modify: `src/app/(site)/connect/page.tsx:152`

**Interfaces:**
- Consumes: `integrationHref` (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Update the alert smoke first (failing)**

In `scripts/smoke-account-alerts.ts` line 475, change:

```ts
  check("20 it points at the Google card", pausedAlert?.cta?.href === "/imports#import-google-contacts");
```

to:

```ts
  check("20 it points at the Google page", pausedAlert?.cta?.href === "/settings?integration=google");
```

Run: `npx tsx scripts/smoke-account-alerts.ts`
Expected: FAIL on check 20 (the alert still links to /imports).

- [ ] **Step 2: Repoint the reconnect alerts**

In `src/lib/account-alerts.ts`, in the `connection.gmail` / `connection.outlook` case, replace the `cta` object and its comment with:

```ts
          cta: {
            label: "Reconnect",
            // Straight at that account's page in the Integrations dialog.
            href: integrationHref(f.code === "connection.gmail" ? "google" : "microsoft"),
            external: false,
          },
```

and in the `connection.google_calendar` case:

```ts
          cta: { label: "Reconnect", href: integrationHref("google"), external: false },
```

(`integrationHref` is already imported at line 3. `surfaceKey: "page.imports"` stays — the Google and Microsoft pages follow that surface.)

Run: `npx tsx scripts/smoke-account-alerts.ts` — Expected: all ok.

- [ ] **Step 3: Repoint the Reminders popover and the /connect page**

In `src/components/reminders/reminder-calendar-sync.tsx`, change `href="/settings?integration=calendar"` to `href={integrationHref("reminders")}` and add `import { integrationHref } from "@/components/settings/sections";` with the other `@/components` imports.

In `src/app/(site)/connect/page.tsx`, change the CTA to:

```tsx
        primary={{ href: "/settings?integration=assistants", label: "Get your Orbit link" }}
```

(A literal on purpose: the marketing group stays free of app-module imports.)

- [ ] **Step 4: Check nothing else links to the old places**

Run: `grep -rn "imports#import-google-contacts\|imports#import-outlook-contacts\|integration=calendar\|integration=outlook" src`
Expected: matches only inside `src/components/imports/` (the /imports page's own anchors) — no link from outside /imports.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npx tsc --noEmit` — no errors. Run: `npx eslint src/lib/account-alerts.ts src/components/reminders/reminder-calendar-sync.tsx "src/app/(site)/connect/page.tsx"` — 0 errors.

```bash
git add src/lib/account-alerts.ts scripts/smoke-account-alerts.ts src/components/reminders/reminder-calendar-sync.tsx "src/app/(site)/connect/page.tsx"
git commit -m "Send reconnect alerts and reminder links to the new Integrations pages"
```

---

### Task 9: Verify in the app and open the PR

**Files:** none (verification), unless a check finds a defect — fix it in the task's file and re-run.

- [ ] **Step 1: Full static checks**

Run each and confirm:
- `npx tsc --noEmit` → no output.
- `npx eslint` → `0 errors` (warnings ≈ baseline).
- `npx tsx scripts/run-smoke.ts --check` → exit 0.
- `npx tsx scripts/run-smoke.ts --ci` → all pass. If `smoke-admin-render` or `smoke-instrumentation` time out under load, rerun them alone with `npx tsx scripts/run-smoke.ts --only smoke-admin-render smoke-instrumentation` (known load flakes).

- [ ] **Step 2: Start the demo preview**

Do not run `npm run build` in this worktree while the preview runs (a build wedges `next dev`; if one ran, `rm -rf .next` first). Start `mcp__Claude_Browser__preview_start` with `{ name: "orbit-demo" }` (demo account on a throwaway local PGlite, no sign-in), then `mcp__Claude_Browser__tabs_select` the returned tab so the pane is **displayed** — a hidden pane never hydrates and every check passes vacuously. Set `resize_window` to 1280×860.

- [ ] **Step 3: Desktop checks** (navigate with `javascript_tool` `location.href = "…"`, wait ~8 s after the first compile, then `read_page`/`find`/`screenshot`)

1. `/settings` — the Integrations card lists Google, Microsoft, LinkedIn, AI, Claude and ChatGPT, Reminders in calendar (no API keys/Webhooks rows), each with a status (Claude and ChatGPT shows none); **Manage** opens the dialog on **Overview**.
2. Overview — AI is off in the demo, so the attention strip shows "AI isn’t on yet…" with **Turn on AI**; clicking it selects the AI page. Six cards, each with one button.
3. Nav — "Your accounts" and "AI and calendar" groups; **Advanced** collapsed; clicking it reveals API keys, Webhooks (Outreach keys stays hidden while Outreach is coming soon). Arrow Down/Up/Home/End move within each list.
4. `/settings?integration=gmail` → dialog on Google, scrolled to the Gmail block (`#integration-google-inbox` in view: `javascript_tool` → `document.getElementById("integration-google-inbox").getBoundingClientRect().top` is within the panel's top 200 px).
5. `/settings?integration=outlook` → Microsoft; `?integration=calendar` → Reminders in calendar; `?integration=api` → API keys with Advanced expanded; `?integration=overview` → Overview; `?integration=nope` → dialog stays closed.
6. `/settings#settings-api` → API keys. `/settings#settings-calendar` → Reminders.
7. Claude and ChatGPT page — toggling "I use ChatGPT" swaps the steps; **Copy link** toasts "Link copied".
8. API keys page — no "Connect Claude or ChatGPT" box remains.
9. Closing the dialog removes `?integration=` from the URL; reloading shows the page without the dialog.
10. `read_console_messages` with `onlyErrors: true` → no new errors.

Screenshot the Overview and the Google page for the PR.

- [ ] **Step 4: Phone checks**

`resize_window` preset `mobile`, reload `/settings?integration=overview`:
- No side nav; the header shows "Integrations"; the Overview cards stack in one column with no horizontal scroll (`javascript_tool`: `document.documentElement.scrollWidth <= window.innerWidth`).
- Tapping a card opens its page with a Back button; Back returns to Overview.
- `?integration=webhooks` opens Webhooks with Back available.

Screenshot the phone Overview. Reset with `resize_window` preset `desktop`, then `preview_stop`.

- [ ] **Step 5: Manual acceptance checklist for Jason (put in the PR body)**

Needs real Google/Microsoft client IDs and a signed-in account — not possible in demo mode:
- Google connected with contacts + calendar: Google page status "Connected as …"; Gmail block reachable at `?integration=gmail`.
- Google connected without mail: Overview no longer implies Gmail is connected (inbox reads not allowed / locked on free).
- A connection in `needs_reauth`: attention strip shows "Google signed Orbit out…", card button "Sign in again"; the bell's Reconnect alert opens the Google page.
- LinkedIn after a completed import: card reads "Imported … ago", button "Import again".

- [ ] **Step 6: Re-check main, push, open the PR (ask Jason first)**

```bash
git fetch origin main -q && git log --oneline HEAD..origin/main | head -20
```

If main moved and touches these files (`git diff --stat HEAD...origin/main -- src/components/settings src/actions/integrations.ts src/lib/account-alerts.ts`), merge it and re-run Step 1. Then ask Jason before pushing. With his go-ahead:

Write the PR body to the session scratchpad (any temp path outside the repo), filling the checklist from Step 5 verbatim and attaching the Step 3/4 screenshots in the PR after it is created:

```bash
cat > "$SCRATCH/p1-pr-body.md" <<'EOF'
## What changes

The Settings → Integrations dialog is organised by account instead of by technology (phase P1 of `docs/superpowers/specs/2026-09-22-integrations-dialog-simplification-design.md`).

- Opens on an **Overview**: anything that needs fixing, then one card per account with one button.
- Nav: Your accounts (Google, Microsoft, LinkedIn) · AI and calendar (AI, Claude and ChatGPT, Reminders in calendar) · a collapsed **Advanced** (API keys, Webhooks, Outreach keys).
- Google and Microsoft status is per feature — Gmail no longer reads "Connected" when mail access was never granted.
- New plain-language **Claude and ChatGPT** page (moved out of API keys).
- Phones: Overview first, Back on every page.
- Old links keep working: `?integration=gmail|outlook|calendar`, `#settings-*`; reconnect alerts now open the dialog.
- Existing importer and settings panels are unchanged inside their new pages (P2–P5 redesign them).

## Checks

- `tsc` clean, eslint 0 errors, `run-smoke --ci` green (new: `smoke-integration-status`, `smoke-import-history`; updated: `smoke-settings-layout`, `smoke-account-alerts`).
- Verified in the demo preview at desktop and phone width.

## Needs a real account (Jason)

- [ ] Google connected with contacts + calendar: page reads "Connected as …"; `?integration=gmail` lands on the Gmail block.
- [ ] Google connected without mail: the inbox reads not allowed (or locked on free), never "Connected".
- [ ] A connection needing sign-in: Overview strip "Google signed Orbit out…", card button "Sign in again"; the bell's Reconnect opens the Google page.
- [ ] LinkedIn after a completed import: "Imported … ago", button "Import again".

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
git push -u origin claude/settings-popup-redesign-0ed30d
gh pr create --title "Integrations dialog P1: organise by account, honest status, Overview" --body-file "$SCRATCH/p1-pr-body.md"
```

(`$SCRATCH` is the session scratchpad directory from the system prompt.)

---

## Next plans (not part of P1)

Each gets its own plan, written when it starts, against the code P1 leaves behind:

- **P2 Google and Microsoft pages** — multi-purpose connect (contacts + calendar), feature rows replacing the embedded importer cards, Overview "Connect …" starting sign-in directly, Meetings switch with a user-paused state, Outlook inbox scan in the dialog, `requireSyncUser` off Google/Microsoft (inbox scan gated on `canUseRecruiters`), pricing copy, the spec's seven fixes.
- **P3 AI** — OpenRouter provider + PKCE connect + real cost/credit, `TurnOnAi` with the guided Gemini paste, More options; `eval-ai.ts` gate. Can start right after P1, in parallel with P2.
- **P4 Reminders in calendar** — per-app subscribe buttons, encrypted feed token (schema bump — scan branches first), shared with the Reminders popover.
- **P5 LinkedIn and Advanced** — one-ZIP guided import (after PR #238 if it has landed), webhook/outreach fixes.
