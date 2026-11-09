/**
 * What every CRM connector hands the shared write path (`src/lib/crm/persist.ts`): one person
 * as the provider describes them, already mapped. Pure and client-safe.
 */
import type { CrmLifecycle, CrmRemoteType, CrmScalar } from "@/db/schema";

export type CrmPerson = {
  remoteType: CrmRemoteType;
  remoteId: string;
  lifecycle: CrmLifecycle;
  /** The provider's raw stage, never interpreted beyond `lifecycle`. */
  stage: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  companyName: string | null;
  companyDomain: string | null;
  title: string | null;
  remoteOwnerRef: string | null;
  remoteUrl: string | null;
  lastActivityAt: Date | null;
  remoteCreatedAt: Date | null;
  remoteUpdatedAt: Date | null;
  properties: Record<string, CrmScalar>;
};

/** `connector_connections.account_ref` of the localhost demo's HubSpot: never synced, never revoked. */
export const DEMO_CRM_ACCOUNT_REF = "orbit-demo";

/**
 * The line the CRM card shows for a stored `sync_error`. Every message Orbit's own HubSpot code
 * writes on purpose starts with "HubSpot " (the API errors, the not-entitled and no-owner
 * stops) and passes through; anything else — a database constraint, a missing server setting,
 * a token endpoint's status — never reaches the page.
 */
export function crmErrorLine(error: string | null): string | null {
  if (!error) return null;
  if (error.startsWith("HubSpot ")) return error;
  return "The last sync hit a problem — the next automatic sync will try again";
}

/** What the CRM card shows about one connection. Dates arrive pre-worded, so SSR and hydration agree. */
export type CrmConnectionView = {
  connectorId: "hubspot";
  label: string | null;
  status: "active" | "needs_reauth";
  syncing: boolean;
  lastSyncedAgo: string | null;
  error: string | null;
  demo: boolean;
  /**
   * Active but disarmed by a stop (a 403, no owner record, a downgrade): no sync is coming
   * until the person reconnects, which keeps the records a disconnect would delete.
   */
  paused: boolean;
};

export type CrmStatus = {
  entitled: boolean;
  configured: boolean;
  connection: CrmConnectionView | null;
  counts: { workContacts: number; pipeline: number; blocked: number } | null;
};

export type CrmSyncNowResult = {
  outcome: "complete" | "partial" | "needs_reauth" | "stopped";
  pages: number;
  records: number;
  message: string | null;
};
