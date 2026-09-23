/**
 * Single source of truth for the settings page's structure: five groups, the sections in
 * each, and which of those live in the Integrations dialog rather than on the page.
 *
 * `page.tsx` renders the groups and cards from these lists, `SettingsSectionNav` renders the
 * rail from `SETTINGS_GROUPS`, and `IntegrationsDialog` renders its side nav and Overview from
 * `INTEGRATION_TABS` — so none of the three can drift from the others.
 *
 * Section ids are load-bearing beyond this page: `src/lib/surfaces.ts` derives each
 * operator-hideable surface key from them (`settings-ai` → `settings.ai`), and hide-lists are
 * stored by that key. Consolidating cards must not rename them, or every stored hide-list
 * would silently stop matching. Grouping is layered on top instead.
 */
export const SETTINGS_GROUPS = [
  { id: "settings-group-account", key: "account", label: "Account" },
  { id: "settings-group-preferences", key: "preferences", label: "Preferences" },
  { id: "settings-group-integrations", key: "integrations", label: "Integrations" },
  { id: "settings-group-resources", key: "resources", label: "Resources" },
  { id: "settings-group-data", key: "data", label: "Data" },
] as const satisfies ReadonlyArray<{ id: string; key: string; label: string }>;

export type SettingsGroupKey = (typeof SETTINGS_GROUPS)[number]["key"];
export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];

/** Labels are what the admin console lists these surfaces as. */
export const SETTINGS_SECTIONS = [
  { id: "settings-profile", label: "Profile", group: "account" },
  { id: "settings-plan", label: "Pricing Plan", group: "account" },
  { id: "settings-appearance", label: "Appearance", group: "preferences" },
  { id: "settings-notifications", label: "Notifications", group: "preferences" },
  { id: "settings-goals", label: "Goals", group: "preferences" },
  { id: "settings-targets", label: "Targets", group: "preferences" },
  { id: "settings-ai", label: "AI provider", group: "integrations" },
  { id: "settings-outreach", label: "Outreach", group: "integrations" },
  { id: "settings-calendar", label: "Calendar feed", group: "integrations" },
  { id: "settings-api", label: "API and connectors", group: "integrations" },
  { id: "settings-webhooks", label: "Webhooks", group: "integrations" },
  { id: "settings-knowledge", label: "Knowledge", group: "resources" },
  { id: "settings-help", label: "Help", group: "resources" },
  { id: "settings-data", label: "Data and privacy", group: "data" },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  group: SettingsGroupKey;
}>;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const INTEGRATION_TAB_GROUPS = [
  { key: "accounts", label: "Your accounts" },
  { key: "ai", label: "AI and calendar" },
  { key: "advanced", label: "Advanced" },
] as const;

export type IntegrationTabGroupKey = (typeof INTEGRATION_TAB_GROUPS)[number]["key"];

/**
 * The Integrations dialog's pages, in nav order.
 *
 * Organised by account rather than by technology: one Google page holds contacts, meetings
 * and Gmail, which used to be three places. `section` pages are settings sections moved off
 * the page and keep their surface key, so an operator hiding `settings.webhooks` hides
 * Webhooks. `surface` pages embed importers whose home is another page and follow that page's
 * surface — a hidden /imports must not leak back in through Settings. Claude and ChatGPT and
 * API keys share `settings-api` because the old card held both.
 *
 * Overview is not a page here: it is the dialog's home view, shown whenever any page is.
 */
export const INTEGRATION_TABS = [
  { id: "google", label: "Google", group: "accounts", surface: "page.imports" },
  { id: "microsoft", label: "Microsoft", group: "accounts", surface: "page.imports" },
  { id: "linkedin", label: "LinkedIn", group: "accounts", surface: "page.imports" },
  { id: "ai", label: "AI", group: "ai", section: "settings-ai" },
  { id: "assistants", label: "Claude and ChatGPT", group: "ai", section: "settings-api" },
  { id: "reminders", label: "Reminders in calendar", group: "ai", section: "settings-calendar" },
  { id: "api", label: "API keys", group: "advanced", section: "settings-api" },
  { id: "webhooks", label: "Webhooks", group: "advanced", section: "settings-webhooks" },
  { id: "outreach", label: "Outreach keys", group: "advanced", section: "settings-outreach" },
] as const satisfies ReadonlyArray<
  { id: string; label: string; group: IntegrationTabGroupKey } & (
    | { section: SettingsSectionId }
    | { surface: string }
  )
>;

export type IntegrationTabId = (typeof INTEGRATION_TABS)[number]["id"];

/** The dialog's home view. */
export const OVERVIEW = "overview";
export type IntegrationView = typeof OVERVIEW | IntegrationTabId;

/** The pages the Overview gives a card — everything outside Advanced. */
export const OVERVIEW_TABS: readonly IntegrationTabId[] = INTEGRATION_TABS.filter(
  (tab) => tab.group !== "advanced"
).map((tab) => tab.id);

/** A place inside a page a link can land on. Only the Google page has one so far. */
export type IntegrationFocus = "inbox";

/**
 * The element a `focus` lands on, e.g. `integration-google-inbox`.
 *
 * Here rather than in the dialog because the two ends of that link live in different files:
 * the dialog looks the id up to scroll to it, and the account page puts it on the one row it
 * names. A constant spelled out by hand at either end would drift without failing anything.
 */
export function focusTargetId(view: IntegrationView, focus: IntegrationFocus): string {
  return `integration-${view}-${focus}`;
}

/**
 * Ids the dialog used before it was organised by account. Links, bookmarks and the
 * `returnTo` of Google and Microsoft consent screens already in flight still say these, and
 * `gmail` stays the way to link straight to the Google page's inbox.
 */
export const INTEGRATION_TAB_ALIASES = {
  gmail: { view: "google", focus: "inbox" },
  outlook: { view: "microsoft" },
  calendar: { view: "reminders" },
} as const satisfies Record<string, { view: IntegrationTabId; focus?: IntegrationFocus }>;

export type IntegrationLinkTarget = IntegrationView | keyof typeof INTEGRATION_TAB_ALIASES;

/** Query param that opens the Integrations dialog: `/settings?integration=google`. */
export const INTEGRATION_PARAM = "integration";

export function integrationHref(target: IntegrationLinkTarget) {
  return `/settings?${INTEGRATION_PARAM}=${target}`;
}

export function isIntegrationTabId(value: string | null | undefined): value is IntegrationTabId {
  return INTEGRATION_TABS.some((tab) => tab.id === value);
}

function ownKey<T extends object>(record: T, key: string): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** What `?integration=` asks for — a page, the overview, or an old id — or null. */
export function resolveIntegrationParam(
  value: string | null | undefined
): { view: IntegrationView; focus: IntegrationFocus | null } | null {
  if (!value) return null;
  if (value === OVERVIEW) return { view: OVERVIEW, focus: null };
  if (isIntegrationTabId(value)) return { view: value, focus: null };
  if (!ownKey(INTEGRATION_TAB_ALIASES, value)) return null;
  const alias: { view: IntegrationTabId; focus?: IntegrationFocus } = INTEGRATION_TAB_ALIASES[value];
  return { view: alias.view, focus: alias.focus ?? null };
}

/**
 * The anchors these pages had when they were cards on the settings page. `#settings-api`
 * held both API keys and the Claude/ChatGPT connector; it opens API keys, the literal
 * meaning of the old anchor.
 */
const LEGACY_HASH_TAB = {
  "settings-ai": "ai",
  "settings-outreach": "outreach",
  "settings-calendar": "reminders",
  "settings-api": "api",
  "settings-webhooks": "webhooks",
} as const satisfies Record<string, IntegrationTabId>;

/** The page an old `#settings-*` anchor stands for, or null. Accepts the hash with or without `#`. */
export function legacyHashTab(hash: string): IntegrationTabId | null {
  const key = hash.replace(/^#/, "");
  return ownKey(LEGACY_HASH_TAB, key) ? LEGACY_HASH_TAB[key] : null;
}

export function integrationLabel(id: IntegrationTabId): string {
  return INTEGRATION_TABS.find((tab) => tab.id === id)?.label ?? id;
}

/** Gap left above a section when the rail scrolls to it. Mirrors `scroll-mt-8`. */
export const SECTION_SCROLL_OFFSET = 32;
