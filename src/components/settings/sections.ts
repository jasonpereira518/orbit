/**
 * Single source of truth for the settings page's structure: five groups, the sections in
 * each, and which of those live in the Integrations dialog rather than on the page.
 *
 * `page.tsx` renders the groups and cards from these lists, `SettingsSectionNav` renders the
 * rail from `SETTINGS_GROUPS`, and `IntegrationsDialog` renders its side nav from
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

/**
 * The Integrations dialog's side nav, in order.
 *
 * `section` tabs are settings sections moved off the page; they keep their surface key, so an
 * operator hiding `settings.webhooks` hides the Webhooks tab. `surface` tabs embed an importer
 * whose home is another page, and follow that page's surface — a hidden /imports page should
 * not leak back in through Settings.
 */
export const INTEGRATION_TABS = [
  { id: "ai", label: "AI provider", group: "services", section: "settings-ai" },
  { id: "outreach", label: "Outreach", group: "services", section: "settings-outreach" },
  { id: "calendar", label: "Calendar feed", group: "services", section: "settings-calendar" },
  { id: "api", label: "API & connectors", group: "services", section: "settings-api" },
  { id: "webhooks", label: "Webhooks", group: "services", section: "settings-webhooks" },
  { id: "google", label: "Google Contacts", group: "imports", surface: "page.imports" },
  { id: "linkedin", label: "LinkedIn", group: "imports", surface: "page.imports" },
  { id: "outlook", label: "Outlook", group: "imports", surface: "page.imports" },
  { id: "gmail", label: "Gmail", group: "imports", surface: "page.recruiters" },
] as const satisfies ReadonlyArray<
  { id: string; label: string; group: "services" | "imports" } & (
    | { section: SettingsSectionId }
    | { surface: string }
  )
>;

export type IntegrationTabId = (typeof INTEGRATION_TABS)[number]["id"];

export const INTEGRATION_TAB_GROUPS = [
  { key: "services", label: "Services" },
  { key: "imports", label: "Import contacts" },
] as const;

/** Query param that opens the Integrations dialog on a tab: `/settings?integration=ai`. */
export const INTEGRATION_PARAM = "integration";

export function integrationHref(tab: IntegrationTabId) {
  return `/settings?${INTEGRATION_PARAM}=${tab}`;
}

export function isIntegrationTabId(value: string | null | undefined): value is IntegrationTabId {
  return INTEGRATION_TABS.some((tab) => tab.id === value);
}

/**
 * The anchors these tabs had when they were cards on the page. Bookmarks and old links still
 * say `/settings#settings-ai`; the dialog opens the matching tab for them.
 */
export const INTEGRATION_TAB_FOR_LEGACY_HASH: Partial<Record<string, IntegrationTabId>> =
  Object.fromEntries(
    INTEGRATION_TABS.flatMap((tab) => ("section" in tab ? [[tab.section, tab.id]] : []))
  );

/** Gap left above a section when the rail scrolls to it. Mirrors `scroll-mt-8`. */
export const SECTION_SCROLL_OFFSET = 32;
