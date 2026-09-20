/**
 * Every connector Orbit offers, as data.
 *
 * The scheduler, the settings status action, the integrations dialog, the account alerts and
 * the purge registry all derive from this list rather than each keeping their own. Before it
 * existed, `runSyncPass` hardcoded three sync families, `INTEGRATION_TABS` hardcoded nine
 * tabs and `getIntegrationStatuses` hardcoded six lookups — three lists that drifted
 * independently, which is the drift `sections.ts` already warns about in its own header.
 *
 * Deliberately free of `@/db` and `next/*` imports: a client component renders this catalog,
 * and a client component that reaches `@/db` fails the build with a `node:fs` chunking error
 * that names neither file. The sync function is a dynamic import for the same reason — the
 * manifest can be loaded without pulling a database driver into the browser bundle.
 */

export type ConnectorFamily =
  | "people"
  | "conversations"
  | "calendar"
  | "tasks"
  | "knowledge"
  | "crm"
  | "events"
  | "enrichment"
  | "automation";

/**
 * How Orbit holds the credential.
 *
 * `provider_oauth` means the connection lives in `gmail_connections` / `outlook_connections`
 * and is reached through `provider-connections.ts`; `oauth2` means it lives in the generic
 * `connector_connections` table. The distinction is historical and deliberate — see that
 * module's header for why the two legacy tables are not being migrated.
 */
export type ConnectorAuthKind =
  | "provider_oauth"
  | "oauth2"
  | "api_key"
  | "dav_password"
  | "ics_url"
  | "file"
  | "extension"
  | "api_token"
  | "none";

export type ConnectorCapabilityId =
  | "importContacts"
  | "syncPeople"
  | "syncEvents"
  | "writeTasks"
  | "logActivity"
  | "writeContact"
  | "enrich";

export type ConnectorCapability = {
  id: ConnectorCapabilityId;
  label: string;
  /** Reads are enabled at connect time; writes stay off until the user turns them on. */
  direction: "read" | "write";
  /** Extra scopes this capability needs. Empty when the base connection already covers it. */
  scopes: string[];
};

export type ConnectorManifest = {
  id: string;
  label: string;
  family: ConnectorFamily;
  auth: ConnectorAuthKind;
  capabilities: ConnectorCapability[];
  /** `planned` renders as a Request card and never syncs. */
  availability: "available" | "planned";
  /** The entitlement flag name in `src/lib/entitlements.ts`, or null for always-on. */
  entitlement: "sync" | "api" | "extension" | "recruiters" | null;
  /** The `RATE_LIMITS` bucket a sync run consumes, or null when it makes no outbound call. */
  rateBucket: "providerSync" | "eventEnrich" | null;
  /** Search aliases so "iCloud" finds Apple Contacts and "Teams" finds Outlook Calendar. */
  aliases?: string[];
  /**
   * One sync pass for one connection. Dynamically imported by the scheduler so this module
   * stays loadable from a client component.
   */
  sync?: (connectionId: string) => Promise<void>;
};

const read = (id: ConnectorCapabilityId, label: string, scopes: string[] = []): ConnectorCapability => ({
  id,
  label,
  direction: "read",
  scopes,
});
const write = (id: ConnectorCapabilityId, label: string, scopes: string[] = []): ConnectorCapability => ({
  id,
  label,
  direction: "write",
  scopes,
});

/**
 * Registered connectors, in catalog order.
 *
 * Everything already shipped is registered as `available` with the capabilities it really
 * has today — the registry describes reality, not the roadmap, and a `planned` entry is the
 * only place the roadmap appears.
 */
export const CONNECTORS: readonly ConnectorManifest[] = [
  {
    id: "google",
    label: "Google",
    family: "people",
    auth: "provider_oauth",
    availability: "available",
    entitlement: "sync",
    rateBucket: "providerSync",
    aliases: ["gmail", "google contacts", "google calendar"],
    capabilities: [
      read("importContacts", "Import Google Contacts", ["https://www.googleapis.com/auth/contacts.readonly"]),
      read("syncEvents", "Keep calendar meetings in sync", ["https://www.googleapis.com/auth/calendar.readonly"]),
    ],
  },
  {
    id: "outlook",
    label: "Outlook",
    family: "people",
    auth: "provider_oauth",
    availability: "available",
    entitlement: "sync",
    rateBucket: "providerSync",
    aliases: ["microsoft", "office", "outlook people"],
    capabilities: [read("importContacts", "Import Outlook contacts", ["Contacts.Read"])],
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    family: "people",
    auth: "file",
    availability: "available",
    entitlement: null,
    rateBucket: null,
    capabilities: [read("importContacts", "Import a connections export")],
  },
  {
    id: "calendar_ics",
    label: "Calendar subscription",
    family: "calendar",
    auth: "ics_url",
    availability: "available",
    entitlement: "sync",
    rateBucket: null,
    aliases: ["ics", "webcal"],
    capabilities: [read("syncEvents", "Log meetings from a calendar feed")],
  },
  {
    id: "luma",
    label: "Luma",
    family: "events",
    auth: "api_key",
    availability: "available",
    entitlement: "sync",
    rateBucket: "eventEnrich",
    capabilities: [read("syncEvents", "Import events and guest lists")],
  },
  {
    id: "eventbrite",
    label: "Eventbrite",
    family: "events",
    auth: "oauth2",
    availability: "available",
    entitlement: "sync",
    rateBucket: "eventEnrich",
    capabilities: [read("syncEvents", "Import events and attendees")],
  },
  {
    id: "apollo",
    label: "Apollo",
    family: "enrichment",
    auth: "api_key",
    availability: "available",
    entitlement: null,
    rateBucket: null,
    capabilities: [read("enrich", "Look up work history and contact details")],
  },
  {
    id: "zapier",
    label: "Zapier & Make",
    family: "automation",
    auth: "api_token",
    availability: "available",
    entitlement: "api",
    rateBucket: null,
    aliases: ["make", "n8n", "webhooks"],
    capabilities: [
      read("syncEvents", "Send events into Orbit"),
      write("logActivity", "Send Orbit events out"),
    ],
  },
  {
    id: "apple_contacts",
    label: "Apple Contacts",
    family: "people",
    auth: "dav_password",
    availability: "planned",
    entitlement: "sync",
    rateBucket: "providerSync",
    aliases: ["icloud", "carddav"],
    capabilities: [read("syncPeople", "Keep iCloud contacts in sync")],
  },
  {
    id: "apple_calendar",
    label: "Apple Calendar",
    family: "calendar",
    auth: "dav_password",
    availability: "planned",
    entitlement: "sync",
    rateBucket: "providerSync",
    aliases: ["icloud", "caldav"],
    capabilities: [read("syncEvents", "Log meetings from iCloud Calendar")],
  },
  {
    id: "apple_reminders",
    label: "Apple Reminders",
    family: "tasks",
    auth: "api_token",
    availability: "planned",
    entitlement: "api",
    rateBucket: null,
    aliases: ["shortcuts", "icloud"],
    capabilities: [write("writeTasks", "Create a reminder for each follow-up")],
  },
  {
    id: "hubspot",
    label: "HubSpot",
    family: "crm",
    auth: "oauth2",
    availability: "planned",
    entitlement: "sync",
    rateBucket: "providerSync",
    capabilities: [
      read("syncPeople", "Import the contacts you own"),
      read("syncEvents", "Import logged engagements"),
      write("logActivity", "Log Orbit interactions on the matching record"),
      write("writeContact", "Create a HubSpot contact"),
    ],
  },
  {
    id: "notion",
    label: "Notion",
    family: "knowledge",
    auth: "oauth2",
    availability: "planned",
    entitlement: "sync",
    rateBucket: "providerSync",
    capabilities: [
      read("importContacts", "Import a people database"),
      write("writeContact", "Mirror contacts into a Notion database"),
    ],
  },
] as const;

export type ConnectorId = (typeof CONNECTORS)[number]["id"];

export function connectorById(id: string): ConnectorManifest | null {
  return CONNECTORS.find((c) => c.id === id) ?? null;
}

export function connectorsByFamily(family: ConnectorFamily): ConnectorManifest[] {
  return CONNECTORS.filter((c) => c.family === family);
}

/** Connectors the scheduler may claim. `planned` entries never have a sync function. */
export function syncableConnectors(): ConnectorManifest[] {
  return CONNECTORS.filter((c) => c.availability === "available" && typeof c.sync === "function");
}
