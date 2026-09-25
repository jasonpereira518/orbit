import type { GmailConnectionStatus } from "@/actions/gmail";
import type { OutlookConnectionStatus } from "@/actions/outlook";
import type { ConnectionHealth } from "@/lib/connection-status";

/**
 * What onboarding's Connect step needs to know about one account, cut down from the two
 * providers' full status objects so the step renders both rows from one shape.
 */
export type ConnectAccount = {
  /** The deployment has this provider's OAuth client configured at all. */
  configured: boolean;
  connected: boolean;
  email: string | null;
  health: ConnectionHealth | null;
};

export type ConnectProvider = "google" | "microsoft";

export function connectAccountFromGmail(s: GmailConnectionStatus): ConnectAccount {
  return { configured: s.configured, connected: s.connected, email: s.emailAddress, health: s.status };
}

export function connectAccountFromOutlook(s: OutlookConnectionStatus): ConnectAccount {
  return { configured: s.configured, connected: s.connected, email: s.emailAddress, health: s.status };
}

/** The step is skipped outright when neither provider can be connected on this deployment. */
export function connectConfigured(accounts: Record<ConnectProvider, ConnectAccount>): boolean {
  return accounts.google.configured || accounts.microsoft.configured;
}
