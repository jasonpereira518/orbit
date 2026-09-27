/**
 * Every connector Orbit offers, as data.
 *
 * TWO consumers derive from this list today, and only two:
 *
 *   - `runSyncPass`'s connector family (`src/lib/sync-scheduler.ts`), which dispatches by
 *     manifest instead of the `switch` over three hardcoded sync families it used to be.
 *   - The settings status action (`src/actions/integrations.ts`), through
 *     `CONNECTOR_STATUS_LOOKUP_IDS` in `./status.ts`, which used to hardcode six lookups.
 *
 * Everything else still keeps its own list, deliberately: `INTEGRATION_TABS`
 * (`src/components/settings/sections.ts`) is untouched by P0 and belongs to the Integrations
 * UI plan, `src/lib/account-alerts.ts` never mentions connectors at all, and the purge
 * registry (`src/lib/user-data.ts`) is an explicit table list because it deletes TABLES, not
 * connectors — several connectors share one table and one connector (`google`) spans two.
 * `purgeCategory` below records which of its categories erases a connector's data, so the
 * two can be checked against each other without pretending one generates the other.
 *
 * No client component renders this catalog yet — the dialog that will is the UI plan's. The
 * no-database rule stands anyway, because that is the component this file exists to be
 * loadable from: a client component that reaches `@/db` fails the build with a `node:fs`
 * chunking error that names neither file. Hence no `@/db` and no `next/*` import here, and
 * hence `sync` being a function the scheduler resolves rather than a static import of a
 * module that would drag a database driver into the browser bundle.
 */
import type { DataCategory } from "@/lib/data-categories";
import type { FeatureKey } from "@/lib/entitlements";

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
 * How Orbit holds the credential — which is also WHERE it holds it, and that is the half a
 * new connector's author actually has to get right.
 *
 *   - `provider_oauth` lives in `gmail_connections` / `outlook_connections`, reached through
 *     `provider-connections.ts`. Historical and deliberate; that module's header says why
 *     the two legacy tables are not being migrated.
 *   - `event_provider` lives in `event_provider_connections`, reached through
 *     `src/lib/events/connections.ts`. It names a STORE, not a mechanism: Eventbrite
 *     authenticates with OAuth2 and Luma with an API key, and both land in that one table
 *     because the events pipeline already owned them before this registry existed. Anyone
 *     building the Eventbrite or Luma connect route must reconnect the EXISTING row through
 *     `upsertEventConnection`, never mint a second credential for the same provider in
 *     `connector_connections`.
 *   - `oauth2`, `api_key` and `dav_password` live in the generic `connector_connections`
 *     table, reached through `./connections.ts`. These are the three `./connections.ts` can
 *     claim, and the reason every connector carrying one has `purgeCategory: "connections"`.
 *   - `orbit_api_key` is the reverse direction: the credential is one of ORBIT's own keys
 *     (`api_keys`), which the user pastes into Zapier or an Apple Shortcut so THAT system can
 *     call Orbit. Nothing of the provider's is stored, and the key goes with the `api`
 *     purge category, not `connections`.
 *   - `settings_key` is a provider key on `user_settings` — Apollo's, shared with Outreach
 *     rather than owned by this registry. It goes with `preferences`.
 *   - `ics_url` is a feed URL on `calendar_subscriptions`; `file`, `extension` and `none`
 *     hold no credential at all.
 *
 * Getting this wrong is not cosmetic: registering Eventbrite as `oauth2` told a P1 author to
 * build a second credential store for a provider Orbit is already connected to, and an auth
 * kind whose store does not match its `purgeCategory` is a claim that an encrypted token
 * survives an account deletion it does not survive. `scripts/smoke-connector-registry.ts`
 * checks the pairing.
 */
export type ConnectorAuthKind =
  | "provider_oauth"
  | "event_provider"
  | "oauth2"
  | "api_key"
  | "dav_password"
  | "ics_url"
  | "file"
  | "extension"
  | "orbit_api_key"
  | "settings_key"
  | "none";

/**
 * A capability id is also an `OutboxAction` for every `direction: "write"` entry — the outbox
 * row's `action` column carries exactly this string (see `./outbox.ts` and the `action`
 * comment on `connectorOutbox` in `src/db/schema.ts`). They are singular for that reason:
 * `writeTask` writes ONE task, per queued follow-up.
 */
export type ConnectorCapabilityId =
  | "importContacts"
  | "syncPeople"
  | "syncEvents"
  | "writeTask"
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
  /**
   * The entitlement flag name in `src/lib/entitlements.ts`, or null for always-on.
   *
   * Typed against `FeatureKey` itself — a type-only import, erased at build, so it cannot
   * drag the database into a client bundle — rather than a second copy of those strings.
   */
  entitlement: FeatureKey | null;
  /** The `RATE_LIMITS` bucket a sync run consumes, or null when it makes no outbound call. */
  rateBucket: "providerSync" | "eventEnrich" | null;
  /**
   * The `DATA_CATEGORY_META` category whose purge step deletes this connector's rows.
   *
   * Declared per connector rather than derived, because the purge registry deletes tables and
   * a connector is not a table: `google` spans `gmail_connections` AND `calendar_subscriptions`,
   * `luma`/`eventbrite` share `event_provider_connections`, and `apollo` is a column on
   * `user_settings`. A new connector whose credentials land somewhere no category covers is
   * the failure this field exists to make visible — `scripts/smoke-connector-registry.ts`
   * checks it, and `scripts/smoke-purge.ts` catches the table half.
   */
  purgeCategory: DataCategory;
  /** Search aliases so "iCloud" finds Apple Contacts and "Teams" finds Outlook Calendar. */
  aliases?: string[];
  /**
   * One sync pass for one connection, resolved by the scheduler so this module stays
   * loadable from a client component.
   *
   * ── Who records the outcome ────────────────────────────────────────────────────────────
   *
   * The scheduler owns FAILURE: a throw is caught, reported, and marked retryable via
   * `markConnectorSyncResult`. It also owns SUCCESS, but only as a backstop —
   * `markConnectorSyncSucceeded` runs after a clean return and is guarded on the row still
   * being `syncing`, so it never touches a row this function already resolved.
   *
   * That means: if the sync has a cursor to store, or wants a cadence other than
   * `CONNECTOR_SYNC_INTERVAL_MS`, it MUST call `markConnectorSyncResult(id, { ok: true,
   * cursor, nextSyncAt })` itself — the backstop deliberately does not write `sync_cursor`,
   * because the only value it could write is the stale one the claim already read. If it has
   * neither, returning is enough and the backstop closes the row out.
   *
   * Returning without either — which is what P0 leaves behind, since no manifest entry has a
   * `sync` yet — used to leave the row `sync_status = 'syncing'` with `next_sync_at`
   * unchanged and `last_synced_at` NULL: under a 10-minute lease and a 15-minute cron it
   * re-synced every single pass, forever, while the settings UI said "never synced".
   *
   * ── Before the first connect route ships ───────────────────────────────────────────────
   *
   * A connect route must either ship its connector's `sync` in the same change, or write the
   * connection with `nextSyncAt: null`. A row that is armed for a connector with no `sync`
   * is disarmed by the very next pass with "This connector is no longer available — reconnect
   * it from Settings," which is a lie the user cannot act on.
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
const CONNECTOR_MANIFESTS = [
  {
    id: "google",
    label: "Google",
    family: "people",
    auth: "provider_oauth",
    availability: "available",
    entitlement: "sync",
    rateBucket: "providerSync",
    purgeCategory: "connections",
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
    purgeCategory: "connections",
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
    purgeCategory: "imports",
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
    purgeCategory: "connections",
    aliases: ["ics", "webcal"],
    capabilities: [read("syncEvents", "Log meetings from a calendar feed")],
  },
  {
    id: "luma",
    label: "Luma",
    family: "events",
    // An API key, but NOT in `connector_connections`: it is already stored (encrypted) in
    // `event_provider_connections` by the events pipeline. See `ConnectorAuthKind`.
    auth: "event_provider",
    availability: "available",
    entitlement: "sync",
    rateBucket: "eventEnrich",
    purgeCategory: "connections",
    capabilities: [read("syncEvents", "Import events and guest lists")],
  },
  {
    id: "eventbrite",
    label: "Eventbrite",
    family: "events",
    // OAuth2 on the wire, but the access token lives in `event_provider_connections`
    // (src/lib/events/connections.ts:281), not in `connector_connections`. Registering it as
    // `oauth2` told a P1 author to build a second credential store for a provider that is
    // already connected. See `ConnectorAuthKind`.
    auth: "event_provider",
    availability: "available",
    entitlement: "sync",
    rateBucket: "eventEnrich",
    purgeCategory: "connections",
    capabilities: [read("syncEvents", "Import events and attendees")],
  },
  {
    id: "apollo",
    label: "Apollo",
    family: "enrichment",
    // The key lives on `user_settings`, shared with Outreach — not in
    // `connector_connections`. See `ConnectorAuthKind`.
    auth: "settings_key",
    availability: "available",
    entitlement: null,
    rateBucket: null,
    purgeCategory: "preferences",
    capabilities: [read("enrich", "Look up work history and contact details")],
  },
  {
    id: "zapier",
    label: "Zapier & Make",
    family: "automation",
    // Inbound: the user pastes an Orbit API key into Zapier. Nothing of Zapier's is stored.
    auth: "orbit_api_key",
    availability: "available",
    entitlement: "api",
    rateBucket: null,
    purgeCategory: "api",
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
    purgeCategory: "connections",
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
    purgeCategory: "connections",
    aliases: ["icloud", "caldav"],
    capabilities: [read("syncEvents", "Log meetings from iCloud Calendar")],
  },
  {
    id: "apple_reminders",
    label: "Apple Reminders",
    family: "tasks",
    // Reminders has no cloud API to hold a credential for: the integration is a Shortcut
    // calling Orbit with an Orbit API key, same shape as Zapier.
    auth: "orbit_api_key",
    availability: "planned",
    entitlement: "api",
    rateBucket: null,
    purgeCategory: "api",
    aliases: ["shortcuts", "icloud"],
    capabilities: [write("writeTask", "Create a reminder for each follow-up")],
  },
  {
    id: "hubspot",
    label: "HubSpot",
    family: "crm",
    auth: "oauth2",
    availability: "planned",
    entitlement: "sync",
    rateBucket: "providerSync",
    purgeCategory: "connections",
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
    purgeCategory: "connections",
    capabilities: [
      read("importContacts", "Import a people database"),
      write("writeContact", "Mirror contacts into a Notion database"),
    ],
  },
] as const satisfies readonly ConnectorManifest[];

/**
 * Widened for consumption: callers get the full `ConnectorManifest` shape (including the
 * optional `sync`), while `ConnectorId` below is still derived from the literal array so it
 * stays a real union of ids, not `string`.
 */
export const CONNECTORS: readonly ConnectorManifest[] = CONNECTOR_MANIFESTS;

export type ConnectorId = (typeof CONNECTOR_MANIFESTS)[number]["id"];

export function connectorById(id: string): ConnectorManifest | null {
  return CONNECTORS.find((c) => c.id === id) ?? null;
}

export function connectorsByFamily(family: ConnectorFamily): ConnectorManifest[] {
  return CONNECTORS.filter((c) => c.family === family);
}

/**
 * Whether the scheduler may run this manifest's sync.
 *
 * Exported as a predicate, not just applied inline below, because P0 ships no `sync` at all:
 * every assertion about `syncableConnectors()`'s OUTPUT is vacuous while the catalog's answer
 * is the empty list, however the rule is written — inverting it to `planned` changes nothing
 * observable. Handed a manifest, it can be tested for real.
 */
export function isSyncable(manifest: ConnectorManifest): boolean {
  return manifest.availability === "available" && typeof manifest.sync === "function";
}

/** Connectors the scheduler may claim. `planned` entries never have a sync function. */
export function syncableConnectors(): ConnectorManifest[] {
  return CONNECTORS.filter(isSyncable);
}
