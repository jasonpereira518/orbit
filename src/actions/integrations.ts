"use server";

import { getSettings } from "@/actions/settings";
import { getCalendarFeedStatus } from "@/actions/calendar-feed";
import { listApiKeys } from "@/actions/api-keys";
import { listWebhookEndpoints } from "@/actions/webhook-endpoints";
import { getGmailConnectionStatus } from "@/actions/gmail";
import { getOutlookConnectionStatus } from "@/actions/outlook";
import type { IntegrationTabId } from "@/components/settings/sections";

export type IntegrationStatus = {
  /** `on` is fully set up, `partial` is some of it, `off` is nothing yet. */
  state: "on" | "partial" | "off";
  detail: string;
};

/** `unknown` stands in for a lookup that failed or timed out — see `settle`. */
export type IntegrationStatuses = Partial<
  Record<IntegrationTabId, IntegrationStatus | "unknown">
>;

/**
 * Per-lookup budget. The calendar feed status has hung in production rather than failed
 * (see `calendar-feed-settings.tsx`), and one hung lookup must not hold up the other eight.
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
 * is set up, in a few words. Loaded after the page paints rather than with it, so nine
 * lookups — two of them to third-party config — never sit in front of the settings page.
 */
export async function getIntegrationStatuses(): Promise<IntegrationStatuses> {
  const [settings, feed, keys, webhooks, google, outlook] = await Promise.all([
    settle(getSettings()),
    settle(getCalendarFeedStatus()),
    settle(listApiKeys()),
    settle(listWebhookEndpoints()),
    settle(getGmailConnectionStatus()),
    settle(getOutlookConnectionStatus()),
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
    google === "unknown"
      ? "unknown"
      : !google.configured
        ? { state: "off", detail: "Unavailable" }
        : google.connected
          ? { state: "on", detail: "Connected" }
          : { state: "off", detail: "Not connected" };
  statuses.google = googleStatus;
  statuses.gmail = googleStatus;

  statuses.outlook =
    outlook === "unknown"
      ? "unknown"
      : !outlook.configured
        ? { state: "off", detail: "Unavailable" }
        : outlook.connected
          ? { state: "on", detail: "Connected" }
          : { state: "off", detail: "Not connected" };

  // LinkedIn has no connection to report — it is a CSV you upload each time.
  statuses.linkedin = { state: "off", detail: "Upload a CSV export" };

  return statuses;
}
