/**
 * HubSpot, pure: the scopes and properties Orbit asks for, what a contact search result
 * becomes, the search body, and the paging window a sync carries across runs in its cursor.
 *
 * Built on HubSpot's dated `2026-09` API. The undated v1 OAuth endpoints stop working on
 * 2027-02-16 and CRM v3 goes unsupported in Sept 2027 — bump `HUBSPOT_API_VERSION` each
 * March/September rather than falling back to them.
 */
import type { ConnectorSyncCursor, CrmLifecycle } from "@/db/schema";
import type { CrmPerson } from "@/lib/crm/types";

export const HUBSPOT_API_BASE = "https://api.hubapi.com";
export const HUBSPOT_API_VERSION = "2026-09";

/** The app's `requiredScopes`, sent as the `scope` param. `oauth` is added to every app by default. */
export const HUBSPOT_SCOPES = ["crm.objects.contacts.read", "crm.objects.owners.read"] as const;

export const HUBSPOT_SEARCH_PAGE = 100;
/** HubSpot answers a 400 to any search paged past this many results. */
export const HUBSPOT_SEARCH_CEILING = 10_000;
/** How often a sync re-reads every owned contact, as a net under incremental paging. */
export const HUBSPOT_FULL_RESYNC_MS = 7 * 24 * 60 * 60 * 1000;

export const HUBSPOT_CONTACT_PROPERTIES = [
  "firstname",
  "lastname",
  "email",
  "phone",
  "mobilephone",
  "company",
  "jobtitle",
  "hs_linkedin_url",
  "lifecyclestage",
  "hs_lead_status",
  "hubspot_owner_id",
  "createdate",
  "lastmodifieddate",
  "notes_last_updated",
] as const;

export type HubspotContactResult = {
  id: string;
  properties: Record<string, string | null | undefined>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  url?: string;
};

const CUSTOMER_STAGES = new Set(["customer", "evangelist"]);
const LEAD_STAGES = new Set(["subscriber", "lead", "marketingqualifiedlead", "salesqualifiedlead", "opportunity"]);

/** Anything a portal invented (custom stages are numeric ids) is `other`. */
export function lifecycleForStage(stage: string | null | undefined): CrmLifecycle {
  const value = (stage ?? "").trim().toLowerCase();
  if (CUSTOMER_STAGES.has(value)) return "customer";
  if (LEAD_STAGES.has(value)) return "lead";
  return "other";
}

export function hubspotRecordUrl(portalId: string, contactId: string): string {
  return `https://app.hubspot.com/contacts/${encodeURIComponent(portalId)}/record/0-1/${encodeURIComponent(contactId)}`;
}

/** HubSpot sends ISO strings in properties and accepts epoch-ms strings; read both. */
export function parseHubspotDate(value: string | null | undefined): Date | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

function isHubspotUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "hubspot.com" || parsed.hostname.endsWith(".hubspot.com"));
  } catch {
    return false;
  }
}

/** Null when there is nothing to call the person by, or HubSpot says the record is archived. */
export function mapHubspotContact(raw: HubspotContactResult, ctx: { portalId: string }): CrmPerson | null {
  if (raw.archived) return null;
  const p = raw.properties ?? {};
  const email = text(p.email);
  const name = [text(p.firstname), text(p.lastname)].filter(Boolean).join(" ");
  const displayName = name || email;
  if (!displayName) return null;
  const stage = text(p.lifecyclestage);
  const leadStatus = text(p.hs_lead_status);
  return {
    remoteType: "contact",
    remoteId: raw.id,
    lifecycle: lifecycleForStage(stage),
    stage,
    displayName,
    email,
    phone: text(p.phone) ?? text(p.mobilephone),
    linkedinUrl: text(p.hs_linkedin_url),
    companyName: text(p.company),
    companyDomain: null,
    title: text(p.jobtitle),
    remoteOwnerRef: text(p.hubspot_owner_id),
    remoteUrl: isHubspotUrl(raw.url) ? raw.url : hubspotRecordUrl(ctx.portalId, raw.id),
    lastActivityAt: parseHubspotDate(p.notes_last_updated),
    remoteCreatedAt: parseHubspotDate(p.createdate ?? raw.createdAt),
    remoteUpdatedAt: parseHubspotDate(p.lastmodifieddate ?? raw.updatedAt),
    properties: leadStatus ? { hs_lead_status: leadStatus } : {},
  };
}

export function buildContactSearchBody(input: { ownerId: string; since: string | null; after: string | null }): object {
  const filters: Array<{ propertyName: string; operator: string; value: string }> = [
    { propertyName: "hubspot_owner_id", operator: "EQ", value: input.ownerId },
  ];
  if (input.since) {
    filters.push({ propertyName: "lastmodifieddate", operator: "GTE", value: String(Date.parse(input.since)) });
  }
  return {
    filterGroups: [{ filters }],
    sorts: [{ propertyName: "lastmodifieddate", direction: "ASCENDING" }],
    properties: [...HUBSPOT_CONTACT_PROPERTIES],
    limit: HUBSPOT_SEARCH_PAGE,
    ...(input.after ? { after: input.after } : {}),
  };
}

/** One search query's progress. Stored in the connection's cursor between runs. */
export type HubspotWindow = {
  /** Lower bound (ISO) on `lastmodifieddate`; null reads every owned contact. */
  since: string | null;
  /** HubSpot's `after` offset within this query; null = its first page. */
  after: string | null;
  /** Newest `lastmodifieddate` seen in this window (ISO). */
  windowMax: string | null;
  /** This window began as a full re-read. */
  full: boolean;
  /** When the last full window finished (ISO). */
  fullSyncedAt: string | null;
};

export type HubspotIdentity = { portalId: string; ownerId: string; hubUserId?: string };

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

export function windowFromCursor(cursor: ConnectorSyncCursor | null | undefined, now: Date): HubspotWindow {
  const meta = cursor?.meta ?? {};
  const window: HubspotWindow = {
    since: cursor?.syncedThrough ?? null,
    after: cursor?.cursor ?? null,
    windowMax: meta.windowMax ?? null,
    full: meta.full === "1",
    fullSyncedAt: meta.fullSyncedAt ?? null,
  };
  if (window.after !== null) return window;
  const lastFull = window.fullSyncedAt ? Date.parse(window.fullSyncedAt) : Number.NaN;
  if (!Number.isFinite(lastFull) || now.getTime() - lastFull >= HUBSPOT_FULL_RESYNC_MS) {
    return { ...window, since: null, windowMax: null, full: true };
  }
  return window;
}

export function advanceWindow(
  window: HubspotWindow,
  page: { maxModified: string | null; nextAfter: string | null },
  now: Date
): { window: HubspotWindow; done: boolean } {
  const windowMax = later(window.windowMax, page.maxModified);
  if (page.nextAfter !== null) {
    if (Number(page.nextAfter) + HUBSPOT_SEARCH_PAGE <= HUBSPOT_SEARCH_CEILING) {
      return { window: { ...window, after: page.nextAfter, windowMax }, done: false };
    }
    // The next page would cross HubSpot's ceiling: restart the query from the newest
    // modified time seen. `>=` re-reads the boundary records; the upsert is idempotent.
    if (windowMax !== null && (window.since === null || Date.parse(windowMax) > Date.parse(window.since))) {
      return { window: { ...window, since: windowMax, after: null, windowMax }, done: false };
    }
  }
  return {
    window: {
      since: windowMax ?? window.since,
      after: null,
      windowMax: null,
      full: false,
      fullSyncedAt: window.full ? now.toISOString() : window.fullSyncedAt,
    },
    done: true,
  };
}

export function cursorFromWindow(window: HubspotWindow, identity: HubspotIdentity): ConnectorSyncCursor {
  const meta: Record<string, string> = { portalId: identity.portalId, ownerId: identity.ownerId };
  if (identity.hubUserId) meta.hubUserId = identity.hubUserId;
  if (window.windowMax) meta.windowMax = window.windowMax;
  if (window.full) meta.full = "1";
  if (window.fullSyncedAt) meta.fullSyncedAt = window.fullSyncedAt;
  return { syncedThrough: window.since, cursor: window.after, meta };
}

export function identityFromCursor(cursor: ConnectorSyncCursor | null | undefined): HubspotIdentity | null {
  const meta = cursor?.meta;
  if (!meta?.portalId || !meta.ownerId) return null;
  return { portalId: meta.portalId, ownerId: meta.ownerId, ...(meta.hubUserId ? { hubUserId: meta.hubUserId } : {}) };
}
