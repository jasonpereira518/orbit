/**
 * Three ways a calendar reaches Orbit, told as one thing.
 *
 * Google and Outlook are cursored OAuth syncs driven by `sync-scheduler.ts`; an ICS link is a
 * row in `calendar_subscriptions` that a different pass fetches on a staleness clock. Those
 * are genuinely different mechanisms, and none of that is the user's problem — they have
 * calendars, and they want Orbit to read them. So this folds all three into one row shape and
 * the card renders a uniform list.
 *
 * Extends `connection-status.ts` rather than restating it. That module already owns the rule
 * that matters most here, and it is easy to get backwards: a contacts-only Google grant parked
 * for want of the calendar scope is a *choice*, not a fault, and must not read as broken.
 *
 * What is new is `needs_permission`. Today someone connects Google for contacts, the scheduler
 * disarms calendar sync for the missing scope, `deriveConnectionHealth` correctly reports
 * "active" — and nothing anywhere tells them calendar sync exists and is one click away. That
 * silence is the single biggest thing wrong with calendars on this page.
 *
 * Pure and import-free beyond its two siblings, so the page can derive this on the server and
 * the card can render it on the client.
 */
import {
  SESSION_EXPIRED_LINE,
  calendarPauseLine,
  type ConnectionHealth,
} from "@/lib/connection-status";
import { icsFailureLine } from "@/lib/import-errors";

export type CalendarSourceKind = "google" | "outlook" | "link";

export type CalendarSourceState =
  /** A pass is running right now. */
  | "syncing"
  /** Connected, scoped, and scheduled. */
  | "on"
  /** Switched off by the person, not by a fault. */
  | "paused"
  /** Connected for something else; calendar access has simply never been granted. An offer. */
  | "needs_permission"
  /** The grant died. */
  | "needs_reconnect"
  /** Something went wrong that reconnecting may not fix. */
  | "trouble";

export type CalendarSource = {
  id: string;
  kind: CalendarSourceKind;
  /** What this calendar is called, in the person's terms. */
  name: string;
  state: CalendarSourceState;
  lastSyncedAt: string | null;
  /** One line under the name. Never a provider's raw body. */
  detail: string;
  /** The action that resolves `state`, when there is one. */
  fix: { label: string } | null;
};

/** Providers whose calendar arrives through an account connection. */
export type ProviderCalendarInput = {
  kind: "google" | "outlook";
  configured: boolean;
  connected: boolean;
  emailAddress: string | null;
  status: ConnectionHealth | null;
  hasCalendarScope: boolean;
  syncError: string | null;
  lastSyncedAt: string | null;
  syncStatus?: string | null;
};

export type IcsCalendarInput = {
  id: string;
  label: string | null;
  icsUrl: string;
  enabled: number;
  lastSyncedAt: Date | string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
};

const PROVIDER_NAME: Record<"google" | "outlook", string> = {
  google: "Google Calendar",
  outlook: "Outlook Calendar",
};

const PROVIDER_LABEL: Record<"google" | "outlook", "Google" | "Microsoft"> = {
  google: "Google",
  outlook: "Microsoft",
};

export function providerCalendarSource(
  input: ProviderCalendarInput,
): CalendarSource | null {
  // Not set up on this deployment at all — offering it would be a dead end.
  if (!input.configured) return null;
  if (!input.connected) return null;

  const base = {
    id: input.kind,
    kind: input.kind,
    name: PROVIDER_NAME[input.kind],
    lastSyncedAt: input.lastSyncedAt,
  } as const;

  if (input.status === "needs_reauth") {
    return {
      ...base,
      state: "needs_reconnect",
      detail: SESSION_EXPIRED_LINE,
      fix: { label: `Reconnect ${PROVIDER_LABEL[input.kind]}` },
    };
  }

  // The offer, not an error: they are connected, they just never granted calendar.
  if (!input.hasCalendarScope) {
    return {
      ...base,
      state: "needs_permission",
      detail: `Connected for contacts — allow calendar access to log your meetings`,
      fix: { label: "Allow calendar access" },
    };
  }

  if (input.status === "disarmed") {
    return {
      ...base,
      state: "trouble",
      detail: calendarPauseLine(input.syncError, PROVIDER_LABEL[input.kind]),
      fix: { label: `Reconnect ${PROVIDER_LABEL[input.kind]}` },
    };
  }

  if (input.syncStatus === "syncing") {
    return {
      ...base,
      state: "syncing",
      detail: "Checking for new meetings…",
      fix: null,
    };
  }

  return {
    ...base,
    state: "on",
    detail: input.emailAddress ? `Syncing ${input.emailAddress}` : "Syncing",
    fix: null,
  };
}

/** A calendar someone pasted a link to. */
export function icsCalendarSource(sub: IcsCalendarInput): CalendarSource {
  const lastSyncedAt =
    sub.lastSyncedAt instanceof Date
      ? sub.lastSyncedAt.toISOString()
      : (sub.lastSyncedAt ?? null);

  const base = {
    id: sub.id,
    kind: "link" as const,
    // Falling back to the host rather than the whole URL: a secret ICS address is long and
    // carries a token, and neither belongs in a list someone reads.
    name: sub.label?.trim() || hostOf(sub.icsUrl),
    lastSyncedAt,
  };

  if (!sub.enabled) {
    return {
      ...base,
      state: "paused",
      detail: "Paused",
      fix: { label: "Resume" },
    };
  }
  if (sub.lastSyncStatus && sub.lastSyncStatus !== "ok") {
    return {
      ...base,
      state: "trouble",
      detail: icsFailureLine(sub.lastSyncError),
      fix: { label: "Paste a new link" },
    };
  }
  return { ...base, state: "on", detail: "Syncing", fix: null };
}

function hostOf(url: string): string {
  try {
    return new URL(url.replace(/^webcal:/i, "https:")).hostname.replace(
      /^www\./,
      "",
    );
  } catch {
    return "Calendar";
  }
}

/** Everything wired up, newest problems first so a broken one cannot hide below the fold. */
export function calendarSources(
  providers: ProviderCalendarInput[],
  subscriptions: IcsCalendarInput[],
): CalendarSource[] {
  const rows = [
    ...providers
      .map(providerCalendarSource)
      .filter((s): s is CalendarSource => s !== null),
    ...subscriptions.map(icsCalendarSource),
  ];
  const rank: Record<CalendarSourceState, number> = {
    needs_reconnect: 0,
    trouble: 1,
    needs_permission: 2,
    syncing: 3,
    on: 4,
    paused: 5,
  };
  return rows.sort((a, b) => rank[a.state] - rank[b.state]);
}
