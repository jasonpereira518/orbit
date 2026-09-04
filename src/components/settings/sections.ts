/**
 * Single source of truth for the settings page's section order, anchor ids,
 * and rail labels. `page.tsx` renders the anchors from this list and
 * `SettingsSectionNav` renders the rail from it, so the two can never drift.
 *
 * Labels are the section headings trimmed to what reads cleanly in a ~10rem
 * rail; the headings themselves stay long-form on the cards.
 */
export const SETTINGS_SECTIONS = [
  { id: "settings-profile", label: "Profile" },
  { id: "settings-plan", label: "Pricing Plan" },
  { id: "settings-goals", label: "Goals" },
  { id: "settings-appearance", label: "Appearance" },
  { id: "settings-ai", label: "AI provider" },
  { id: "settings-notifications", label: "Notifications" },
  { id: "settings-calendar", label: "Calendar feed" },
  { id: "settings-outreach", label: "Outreach" },
  { id: "settings-knowledge", label: "Knowledge" },
  { id: "settings-api", label: "API and connectors" },
  { id: "settings-webhooks", label: "Webhooks" },
  { id: "settings-help", label: "Help" },
  { id: "settings-data", label: "Data and privacy" },
] as const satisfies ReadonlyArray<{ id: string; label: string }>;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** Gap left above a section when the rail scrolls to it. Mirrors `scroll-mt-8`. */
export const SECTION_SCROLL_OFFSET = 32;
