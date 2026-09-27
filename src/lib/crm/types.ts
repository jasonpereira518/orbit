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

export type CrmConnectorId = "hubspot" | "salesforce";

/** The CRMs Leads connects, in the order the card lists them. */
export const CRM_PROVIDERS: readonly { id: CrmConnectorId; label: string }[] = [
  { id: "hubspot", label: "HubSpot" },
  { id: "salesforce", label: "Salesforce" },
];

export function isCrmConnectorId(id: string): id is CrmConnectorId {
  return CRM_PROVIDERS.some((p) => p.id === id);
}

export function crmProviderLabel(id: CrmConnectorId): string {
  return CRM_PROVIDERS.find((p) => p.id === id)?.label ?? "your CRM";
}

/**
 * The line the CRM card shows for a stored `sync_error`. Both providers' own API modules
 * (`HubspotApiError`, `SalesforceApiError`) write only fixed sentences Orbit wrote — starting
 * "HubSpot " or "Salesforce " — never a provider's raw text (Ruling 12c), so this prefix check
 * is a second net, not the only one: anything else — a database constraint, a missing server
 * setting, a token endpoint's status — never reaches the page.
 */
export function crmErrorLine(error: string | null): string | null {
  if (!error) return null;
  if (error.startsWith("HubSpot ") || error.startsWith("Salesforce ")) return error;
  return "The last sync hit a problem — the next automatic sync will try again";
}

/** What the CRM card shows about one connection. Dates arrive pre-worded, so SSR and hydration agree. */
export type CrmConnectionView = {
  connectorId: CrmConnectorId;
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
  /** A Salesforce sandbox (its instance host says so): Reconnect goes back to the sandbox login. */
  sandbox: boolean;
};

/** Salesforce sandboxes live on `<domain>--<name>.sandbox.my.salesforce.com`. */
export function isSalesforceSandboxHost(instanceUrl: string | null): boolean {
  if (!instanceUrl) return false;
  try {
    return new URL(instanceUrl).hostname.toLowerCase().endsWith(".sandbox.my.salesforce.com");
  } catch {
    return false;
  }
}

/** One CRM's row on the card: whether this server can connect it, and its connection if any. */
export type CrmProviderStatus = {
  id: CrmConnectorId;
  label: string;
  configured: boolean;
  connection: CrmConnectionView | null;
  counts: { workContacts: number; pipeline: number; blocked: number } | null;
};

export type CrmStatus = {
  entitled: boolean;
  providers: CrmProviderStatus[];
};

/** One connector's sync run, whatever provider ran it — `syncHubspot` and `syncSalesforce` share it. */
export type CrmSyncResult = {
  outcome: "complete" | "partial" | "needs_reauth" | "stopped";
  pages: number;
  records: number;
  contactsCreated: number;
  leadsCreated: number;
  blocked: number;
  message?: string;
};

export type CrmSyncNowResult = {
  outcome: "complete" | "partial" | "needs_reauth" | "stopped";
  pages: number;
  records: number;
  message: string | null;
};
