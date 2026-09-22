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
 * never the grant. `off` is the person's own choice (the Meetings switch) — distinct from
 * `paused`, which is the sync having broken on its own.
 */
export type CapabilityState = "on" | "available" | "not_allowed" | "paused" | "off" | "locked";
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
  if (health === "paused") return { state: "off", detail: "Off" };
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
