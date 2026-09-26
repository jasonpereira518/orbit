/**
 * What the demo workspace's integrations read as: connected, healthy, recently synced.
 *
 * Display only. No connection row, token or grant is ever written for the demo workspace,
 * so every scheduler, cron and sync that selects connection rows simply never sees it — the
 * reads below are the whole illusion, and the provider-calling actions short-circuit on
 * `isDemoWorkspace` before they would reach a token. See `demo-workspace.ts`.
 *
 * Import-free on purpose (types only), so the status actions pay nothing for it.
 */
import type { IntegrationStatuses, PageStatus } from "@/lib/integration-status";
import type { GmailConnectionStatus } from "@/actions/gmail";
import type { OutlookConnectionStatus } from "@/actions/outlook";

/** How long ago the last "sync" ran: recent enough to read as live, not suspiciously now. */
const LAST_SYNC_MINUTES_AGO = 7;
/** The calendar scheduler's cadence, so "next sync" sits a plausible distance ahead. */
const NEXT_SYNC_MINUTES_AHEAD = 23;

function minutesFromNow(minutes: number, now: number) {
  return new Date(now + minutes * 60_000).toISOString();
}

export function demoGmailConnectionStatus(
  email: string | null,
  now = Date.now()
): GmailConnectionStatus {
  return {
    configured: true,
    connected: true,
    emailAddress: email,
    lastSyncedAt: minutesFromNow(-LAST_SYNC_MINUTES_AGO, now),
    canSend: true,
    status: "active",
    syncError: null,
    nextSyncAt: minutesFromNow(NEXT_SYNC_MINUTES_AHEAD, now),
    canRead: true,
    canImportContacts: true,
    hasCalendarScope: true,
    canImportDrive: true,
    // The demo workspace never pauses meetings: nothing schedules them in the first place.
    syncPaused: false,
    redirectUri: null,
  };
}

export function demoOutlookConnectionStatus(
  email: string | null,
  now = Date.now()
): OutlookConnectionStatus {
  return {
    configured: true,
    connected: true,
    emailAddress: email,
    lastSyncedAt: minutesFromNow(-LAST_SYNC_MINUTES_AGO - 4, now),
    hasContactsScope: true,
    hasCalendarScope: true,
    hasMailScope: true,
    syncPaused: false,
    status: "active",
    syncError: null,
    nextSyncAt: minutesFromNow(NEXT_SYNC_MINUTES_AHEAD + 6, now),
    redirectUri: null,
  };
}

/**
 * Layered over the real statuses, never instead of them: anything the account has actually
 * set up (an AI key, an API key, the calendar feed) keeps its true line, and only the
 * integrations that would otherwise read "not connected" are lifted.
 */
export function withDemoIntegrationStatuses(real: IntegrationStatuses): IntegrationStatuses {
  const on = (detail: string): PageStatus => ({ state: "on", detail });
  /**
   * Lifted only where the real answer is not already "on": the page lines and the connector
   * lines are two views of the same account, so both are lifted, and anything the account
   * genuinely set up keeps its own wording in either view.
   */
  const lift = <K extends string>(
    from: Partial<Record<K, PageStatus | "unknown">>,
    key: K,
    detail: string
  ): PageStatus => {
    const current = from[key];
    return current && current !== "unknown" && current.state === "on" ? current : on(detail);
  };
  const pages = real.pages;
  const connectors = real.connectors;
  return {
    ...real,
    pages: {
      ...pages,
      google: on("Connected"),
      microsoft: on("Connected"),
      linkedin: on("Connections imported"),
      outreach: lift(pages, "outreach", "3 of 3 set up"),
      webhooks: lift(pages, "webhooks", "1 live"),
      reminders: lift(pages, "reminders", "Feed on"),
      api: lift(pages, "api", "1 key"),
    },
    connectors: {
      ...connectors,
      google: on("Connected"),
      outlook: on("Connected"),
      linkedin: on("Connections imported"),
      calendar_ics: lift(connectors, "calendar_ics", "2 feeds"),
      luma: on("Connected"),
      eventbrite: on("Connected"),
      apollo: lift(connectors, "apollo", "Key saved"),
      zapier: lift(connectors, "zapier", "1 key"),
    },
  };
}
