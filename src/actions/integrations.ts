"use server";

import { getSettings } from "@/actions/settings";
import { connectionSummary } from "@/lib/connection-status";
import { getCalendarFeedStatus } from "@/actions/calendar-feed";
import { listApiKeys } from "@/actions/api-keys";
import { listWebhookEndpoints } from "@/actions/webhook-endpoints";
import { getGmailConnectionStatus } from "@/actions/gmail";
import { getOutlookConnectionStatus } from "@/actions/outlook";
import { listCalendarSubscriptions } from "@/actions/calendar";
import { listEventConnections } from "@/lib/events/connections";
import { getConnectorConnection } from "@/lib/connectors/connections";
import { requireUserId } from "@/lib/auth";
import { CONNECTOR_STATUS_LOOKUP_IDS, type ConnectorStatusId } from "@/lib/connectors/status";
import type { IntegrationTabId } from "@/components/settings/sections";

export type IntegrationStatus = {
  /** `on` is fully set up, `partial` is some of it, `off` is nothing yet. */
  state: "on" | "partial" | "off";
  detail: string;
};

/**
 * `unknown` stands in for a lookup that failed or timed out — see `settle`.
 *
 * Keyed by two things that are not the same kind of thing: `IntegrationTabId` (settings
 * sections — `ai`, `outreach`, `calendar`, `api`, `webhooks` — plus the tab ids `google`,
 * `linkedin`, `outlook`, `gmail`) and `ConnectorStatusId` (registry ids this action answers
 * for). They overlap on `google`/`linkedin`/`outlook`, which is intentional — those ids name
 * both a tab and a connector. `calendar_ics`, `luma`, `eventbrite`, `apollo` and `zapier` are
 * connector-only: they aren't tabs today, but `integrations-settings.tsx` only ever reads
 * `statuses[tab]` for a real `IntegrationTabId`, so widening the key type here is additive.
 */
export type IntegrationStatuses = Partial<
  Record<IntegrationTabId | ConnectorStatusId, IntegrationStatus | "unknown">
>;

/**
 * Per-lookup budget. The calendar feed status has hung in production rather than failed
 * (see `calendar-feed-settings.tsx`), and one hung lookup must not hold up the other nine.
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
 * One line per integration for the Integrations card and the dialog's side nav: whether it
 * is set up, in a few words. Loaded after the page paints rather than with it, so ten
 * lookups — two of them to third-party config — never sit in front of the settings page.
 */
export async function getIntegrationStatuses(): Promise<IntegrationStatuses> {
  const [settings, feed, keys, webhooks, google, outlook, icsSubs, eventConns, hubspot] =
    await Promise.all([
      settle(getSettings()),
      settle(getCalendarFeedStatus()),
      settle(listApiKeys()),
      settle(listWebhookEndpoints()),
      settle(getGmailConnectionStatus()),
      settle(getOutlookConnectionStatus()),
      settle(listCalendarSubscriptions()),
      settle(requireUserId().then((id) => listEventConnections(id))),
      settle(requireUserId().then((id) => getConnectorConnection(id, "hubspot"))),
    ]);

  const statuses: IntegrationStatuses = {};

  if (settings === "unknown") {
    statuses.ai = "unknown";
    statuses.outreach = "unknown";
  } else {
    const provider = settings.providers.find((p) => p.id === settings.aiProvider);
    statuses.ai = settings.hasApiKey
      ? { state: "on", detail: provider ? `${provider.label} key saved` : "Key saved" }
      : { state: "off", detail: "No key yet" };

    const outreach = [settings.outreach.apollo, settings.outreach.resend, settings.outreach.twilio];
    const configured = outreach.filter(Boolean).length;
    statuses.outreach =
      configured === 0
        ? { state: "off", detail: "Not set up" }
        : {
            state: configured === outreach.length ? "on" : "partial",
            detail: `${configured} of ${outreach.length} set up`,
          };
  }

  statuses.calendar =
    feed === "unknown"
      ? "unknown"
      : feed.enabled
        ? { state: "on", detail: "Feed on" }
        : { state: "off", detail: "Off" };

  statuses.api =
    keys === "unknown"
      ? "unknown"
      : keys.length > 0
        ? { state: "on", detail: plural(keys.length, "key") }
        : { state: "off", detail: "No keys" };

  if (webhooks === "unknown") {
    statuses.webhooks = "unknown";
  } else {
    const live = webhooks.filter((w) => w.status === "active").length;
    statuses.webhooks =
      webhooks.length === 0
        ? { state: "off", detail: "None" }
        : {
            state: live === webhooks.length ? "on" : "partial",
            detail: live === webhooks.length ? `${live} live` : `${live} of ${webhooks.length} live`,
          };
  }

  // Google Contacts and the Gmail recruiter scan share one Google connection.
  const googleStatus: IntegrationStatus | "unknown" =
    google === "unknown" ? "unknown" : connectionSummary(google);
  statuses.google = googleStatus;
  statuses.gmail = googleStatus;

  statuses.outlook = outlook === "unknown" ? "unknown" : connectionSummary(outlook);

  // LinkedIn has no connection to report — it is a CSV you upload each time.
  statuses.linkedin = { state: "off", detail: "Upload a CSV export" };

  // Inbound calendar subscriptions, distinct from `statuses.calendar`, which is the OUTBOUND
  // feed Orbit publishes. Two different directions that have shared a word for too long.
  statuses.calendar_ics =
    icsSubs === "unknown"
      ? "unknown"
      : icsSubs.length === 0
        ? { state: "off", detail: "No feeds" }
        : {
            state: icsSubs.some((s) => s.lastSyncStatus === "error") ? "partial" : "on",
            detail: plural(icsSubs.length, "feed"),
          };

  if (eventConns === "unknown") {
    statuses.luma = "unknown";
    statuses.eventbrite = "unknown";
  } else {
    for (const id of ["luma", "eventbrite"] as const) {
      // `luma` and `luma_ics` are separate providers on the same platform; either one means
      // Luma is connected as far as the catalog is concerned.
      const conns = eventConns.filter((c) => c.provider.startsWith(id));
      statuses[id] =
        conns.length === 0
          ? { state: "off", detail: "Not connected" }
          : conns.some((c) => c.status === "needs_reauth")
            ? { state: "partial", detail: "Reconnect needed" }
            : { state: "on", detail: "Connected" };
    }
  }

  // Apollo and Zapier have no connection of their own: Apollo is a key on user_settings and
  // Zapier is whatever API keys exist. Both are read from data already fetched above.
  statuses.apollo =
    settings === "unknown"
      ? "unknown"
      : settings.outreach.apollo
        ? { state: "on", detail: "Key saved" }
        : { state: "off", detail: "No key yet" };

  statuses.zapier =
    keys === "unknown"
      ? "unknown"
      : keys.length > 0
        ? { state: "on", detail: plural(keys.length, "key") }
        : { state: "off", detail: "No keys" };

  statuses.hubspot =
    hubspot === "unknown"
      ? "unknown"
      : hubspot === null
        ? { state: "off", detail: "Not connected" }
        : hubspot.status === "needs_reauth"
          ? { state: "partial", detail: "Reconnect needed" }
          : { state: "on", detail: hubspot.label ?? "Connected" };

  // The registry and this action must answer for the same connectors. The smoke test checks
  // the list against the registry; this checks the implementation against the list.
  for (const id of CONNECTOR_STATUS_LOOKUP_IDS) {
    if (!(id in statuses)) statuses[id] = { state: "off", detail: "Not connected" };
  }

  return statuses;
}
