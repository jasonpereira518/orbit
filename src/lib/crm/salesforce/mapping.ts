/**
 * Salesforce, pure: the scopes and fields Orbit asks for, which hosts a token may be sent to,
 * the SOQL a sync runs, the keyset progress it carries across runs, and what a record becomes.
 *
 * Built on REST API v66.0. `instance_url` and the identity URL arrive in a token response;
 * both are checked with `isTrustedSalesforceUrl` before a bearer token goes near them.
 */
import type { ConnectorSyncCursor } from "@/db/schema";
import type { CrmPerson } from "@/lib/crm/types";

/** A token response names the org's host; nothing outside these domains is ever sent a token. */
export const SALESFORCE_HOST_SUFFIXES = ["salesforce.com", "force.com", "cloudforce.com"] as const;

export function isTrustedSalesforceUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return false;
    const host = parsed.hostname.toLowerCase();
    return SALESFORCE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

export const SALESFORCE_API_VERSION = "v66.0";

/** Sent as the `scope` param; the External Client App grants the same three. */
export const SALESFORCE_SCOPES = ["api", "refresh_token", "id"] as const;

export const SALESFORCE_PAGE = 200;
/** How far a finished phase rewinds its watermark: a transaction committing late can carry an earlier stamp. */
export const SALESFORCE_WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

export type SalesforceObject = "Contact" | "Lead";
export type SalesforceRecord = { Id: string; attributes?: { type?: string; url?: string } } & Record<string, unknown>;
/** The last record a query read: its stamp (ISO) and id. `id: ""` sorts before every real id. */
export type SalesforceMark = { at: string; id: string };
export type SalesforceProgress = { phase: SalesforceObject; contact: SalesforceMark | null; lead: SalesforceMark | null; lean: boolean };
export type SalesforceIdentity = { orgId: string; userId: string };

const BASE_FIELDS = ["Id", "FirstName", "LastName", "Email", "OwnerId", "CreatedDate", "SystemModstamp"] as const;
const FULL_FIELDS: Record<SalesforceObject, readonly string[]> = {
  Contact: [...BASE_FIELDS, "Phone", "MobilePhone", "Title", "Account.Name", "LastActivityDate"],
  Lead: [...BASE_FIELDS, "Company", "Status", "IsConverted", "ConvertedContactId", "Phone", "MobilePhone", "Title", "LastActivityDate"],
};
/** Fields every user who can read the object can read; the fallback after an INVALID_FIELD. */
const LEAN_FIELDS: Record<SalesforceObject, readonly string[]> = {
  Contact: [...BASE_FIELDS, "Account.Name"],
  Lead: [...BASE_FIELDS, "Company", "Status", "IsConverted", "ConvertedContactId"],
};

export function fieldsFor(object: SalesforceObject, lean: boolean): readonly string[] {
  return (lean ? LEAN_FIELDS : FULL_FIELDS)[object];
}

export function isSalesforceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value);
}

/** SOQL datetime literals are unquoted and second-precision. */
export function soqlDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error("Not a date");
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** Salesforce writes `2026-09-26T12:00:00.000+0000`; dates are `2026-09-01`. */
export function parseSalesforceDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * The owned records of one object, strictly after `after`, oldest stamp first. Keyset, not
 * `nextRecordsUrl`: a locator dies after 15 idle minutes, and a run killed at its time limit
 * resumes from the cursor on the next one. Every interpolated value is an id or a date this
 * module validated — nothing a person or a provider typed reaches the query text.
 */
export function buildOwnedQuery(object: SalesforceObject, input: { ownerId: string; after: SalesforceMark | null; lean: boolean }): string {
  if (!isSalesforceId(input.ownerId)) throw new Error("Not a Salesforce user id");
  const where = [`OwnerId = '${input.ownerId}'`];
  if (input.after) {
    const at = soqlDateTime(input.after.at);
    if (input.after.id === "") where.push(`SystemModstamp >= ${at}`);
    else {
      if (!isSalesforceId(input.after.id)) throw new Error("Not a Salesforce record id");
      where.push(`(SystemModstamp > ${at} OR (SystemModstamp = ${at} AND Id > '${input.after.id}'))`);
    }
  }
  return `SELECT ${fieldsFor(object, input.lean).join(", ")} FROM ${object} WHERE ${where.join(" AND ")} ORDER BY SystemModstamp ASC, Id ASC LIMIT ${SALESFORCE_PAGE}`;
}

export function markOf(raw: SalesforceRecord): SalesforceMark | null {
  const at = parseSalesforceDate(raw.SystemModstamp);
  return at && isSalesforceId(raw.Id) ? { at: at.toISOString(), id: raw.Id } : null;
}

function rewind(mark: SalesforceMark | null): SalesforceMark | null {
  return mark ? { at: new Date(Date.parse(mark.at) - SALESFORCE_WATERMARK_OVERLAP_MS).toISOString(), id: "" } : null;
}

/**
 * One page read. A full page means more may follow in this phase; a short one finishes it. A
 * finished phase rewinds its mark by the overlap (`id: ""` re-reads the boundary second), but
 * only when this page moved it — an empty page leaves the already-rewound mark alone, so
 * nothing walks backwards run after run. Contacts finish into leads; leads finish the run.
 */
export function advanceProgress(
  progress: SalesforceProgress,
  page: { last: SalesforceMark | null; full: boolean }
): { progress: SalesforceProgress; done: boolean } {
  const key = progress.phase === "Contact" ? "contact" : "lead";
  const moved = page.last ?? progress[key];
  if (page.full && page.last) return { progress: { ...progress, [key]: moved }, done: false };
  const settled = { ...progress, [key]: page.last ? rewind(page.last) : progress[key] };
  return progress.phase === "Contact"
    ? { progress: { ...settled, phase: "Lead" }, done: false }
    : { progress: { ...settled, phase: "Contact" }, done: true };
}

function markFrom(meta: Record<string, string>, key: "contact" | "lead"): SalesforceMark | null {
  const at = meta[`${key}At`];
  return at ? { at, id: meta[`${key}Id`] ?? "" } : null;
}

export function progressFromCursor(cursor: ConnectorSyncCursor | null | undefined): SalesforceProgress {
  const meta = cursor?.meta ?? {};
  return {
    phase: meta.phase === "Lead" ? "Lead" : "Contact",
    contact: markFrom(meta, "contact"),
    lead: markFrom(meta, "lead"),
    lean: meta.lean === "1",
  };
}

export function cursorFromProgress(progress: SalesforceProgress, identity: SalesforceIdentity): ConnectorSyncCursor {
  const meta: Record<string, string> = { orgId: identity.orgId, userId: identity.userId, phase: progress.phase };
  if (progress.contact) Object.assign(meta, { contactAt: progress.contact.at, contactId: progress.contact.id });
  if (progress.lead) Object.assign(meta, { leadAt: progress.lead.at, leadId: progress.lead.id });
  if (progress.lean) meta.lean = "1";
  return { meta };
}

export function identityFromCursor(cursor: ConnectorSyncCursor | null | undefined): SalesforceIdentity | null {
  const meta = cursor?.meta;
  return meta?.orgId && meta.userId ? { orgId: meta.orgId, userId: meta.userId } : null;
}

export function salesforceRecordUrl(instanceUrl: string, object: SalesforceObject, id: string): string {
  return new URL(`/lightning/r/${object}/${encodeURIComponent(id)}/view`, instanceUrl).href;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Salesforce requires a Lead's company and fills this in when a form didn't ask. */
const NO_COMPANY = new Set(["[not provided]", "not provided", "n/a", "none", "unknown"]);

export function mapSalesforceRecord(object: SalesforceObject, raw: SalesforceRecord, ctx: { instanceUrl: string }): CrmPerson | null {
  if (!isSalesforceId(raw.Id)) return null;
  const email = text(raw.Email);
  const name = [text(raw.FirstName), text(raw.LastName)].filter(Boolean).join(" ");
  const displayName = name || email;
  if (!displayName) return null;
  const account = raw.Account && typeof raw.Account === "object" ? (raw.Account as Record<string, unknown>) : null;
  const company = object === "Contact" ? text(account?.Name) : text(raw.Company);
  const properties: CrmPerson["properties"] = {};
  let lifecycle: CrmPerson["lifecycle"] = "customer";
  let stage: string | null = null;
  if (object === "Lead") {
    stage = text(raw.Status);
    if (stage) properties.sf_status = stage;
    if (raw.IsConverted === true) {
      stage = "Converted";
      if (isSalesforceId(raw.ConvertedContactId)) properties.sf_converted_contact_id = raw.ConvertedContactId;
    } else {
      lifecycle = "lead";
    }
  }
  return {
    remoteType: object === "Contact" ? "contact" : "lead",
    remoteId: raw.Id,
    lifecycle,
    stage,
    displayName,
    email,
    phone: text(raw.Phone) ?? text(raw.MobilePhone),
    linkedinUrl: null,
    companyName: company && !NO_COMPANY.has(company.toLowerCase()) ? company : null,
    companyDomain: null,
    title: text(raw.Title),
    remoteOwnerRef: isSalesforceId(raw.OwnerId) ? raw.OwnerId : null,
    remoteUrl: salesforceRecordUrl(ctx.instanceUrl, object, raw.Id),
    lastActivityAt: parseSalesforceDate(raw.LastActivityDate),
    remoteCreatedAt: parseSalesforceDate(raw.CreatedDate),
    remoteUpdatedAt: parseSalesforceDate(raw.SystemModstamp),
    properties,
  };
}
