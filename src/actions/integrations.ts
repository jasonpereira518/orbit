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

  // Without the plan a locked inbox can't be told from an open one — but that is the only
  // thing it decides, and everything else about an account comes from its connection row. So
  // an unread plan is passed down as "unknown" and costs the inbox capability alone: the page
  // still reports its status, and an account that signed Orbit out still raises its attention
  // item, rather than the whole account going blank because a settings read timed out.
  const plan = settings === "unknown" ? "unknown" : { canUseRecruiters: settings.plan.canUseRecruiters };
  accounts.google = google === "unknown" ? "unknown" : googleAccountStatus(google, plan);
  accounts.microsoft = outlook === "unknown" ? "unknown" : microsoftAccountStatus(outlook, plan);
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
