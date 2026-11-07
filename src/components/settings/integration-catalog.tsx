"use client";

import type { ComponentType } from "react";
import { BookUser, CalendarDays, CalendarRange, Rocket, Sparkles } from "lucide-react";
import {
  AppleMark,
  ClaudeMark,
  EventbriteMark,
  GoogleCalendarMark,
  GoogleDriveMark,
  GoogleMark,
  GranolaMark,
  HubSpotMark,
  LinkedInMark,
  MicrosoftMark,
  NotionMark,
  ZapierMark,
} from "@/components/settings/provider-marks";
import type { IntegrationTabId } from "@/components/settings/sections";

type Mark = ComponentType<{ className?: string }>;

/**
 * Where a tile goes. A `tab` tile is one of the dialog's own pages and carries its live
 * status; an `href` tile is set up somewhere else today; `planned` renders Coming soon.
 */
export type CatalogTarget = { tab: IntegrationTabId } | { href: string } | { planned: true };

export type CatalogItem = {
  /** A registry id where one exists, so search reads its aliases. */
  id: string;
  label: string;
  blurb: string;
  mark: Mark;
  to: CatalogTarget;
  /** Search words beyond the label. A superset of the registry's own aliases — checked by
   *  `smoke-integration-catalog`, because this file cannot import the registry (below). */
  aliases: string[];
};

export type CatalogGroup = {
  key: string;
  label: string;
  /** One of the theme's accent tokens, as a Tailwind background class. */
  accent: string;
  items: CatalogItem[];
};

/** Luma and Apollo have no citable recorded mark; a plain glyph beats a guessed logo. */
function lucide(Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>): Mark {
  return function LucideMark({ className }) {
    return <Icon aria-hidden className={className} />;
  };
}

function item(id: string, label: string, blurb: string, mark: Mark, to: CatalogTarget, aliases: string[] = []): CatalogItem {
  return { id, label, blurb, mark, to, aliases };
}

/**
 * Everything Orbit connects to, in the order a person looks for it.
 *
 * Labels and aliases are written out here rather than read from `@/lib/connectors/registry`:
 * the registry's `sync` functions `import()` database modules, and the bundler follows those
 * into the browser. `smoke-integration-catalog` holds the two lists together instead.
 *
 * The `href` targets on /imports are temporary: those rows move into this dialog as their own
 * pages, and each tile becomes a `tab`. WhatsApp & iMessage is left out until then — its row is
 * surface-gated, and a tile linking to a row the viewer cannot see goes nowhere.
 */
export const CATALOG: CatalogGroup[] = [
  {
    key: "accounts",
    label: "Your accounts",
    accent: "bg-primary",
    items: [
      item("google", "Google", "Contacts, calendar, Gmail and Drive.", GoogleMark, { tab: "google" }, ["gmail", "google contacts", "google calendar"]),
      item("outlook", "Microsoft", "Outlook contacts, calendar and mail.", MicrosoftMark, { tab: "microsoft" }, ["microsoft", "office", "outlook", "outlook people", "teams"]),
      item("linkedin", "LinkedIn", "Your connections, messages and profile.", LinkedInMark, { tab: "linkedin" }),
      item("granola", "Granola", "Meeting notes, synced in as they happen.", GranolaMark, { tab: "granola" }, ["meeting notes"]),
    ],
  },
  {
    key: "people",
    label: "People and contacts",
    accent: "bg-import-connections",
    items: [
      item("contacts_file", "Contacts file", "A CSV or vCard from your phone or anywhere else.", lucide(BookUser), {
        href: "/imports#import-contacts-file",
      }, ["csv", "vcard", "vcf", "phone", "excel"]),
      item("apple_contacts", "Apple Contacts", "Keep iCloud contacts in sync.", AppleMark, { planned: true }, ["icloud", "carddav"]),
      item("hubspot", "HubSpot", "Import the contacts you own, log what you do.", HubSpotMark, { planned: true }),
    ],
  },
  {
    key: "calendars",
    label: "Calendars and events",
    accent: "bg-import-calendar",
    items: [
      item("calendar_ics", "Calendar subscription", "Any calendar’s private link, kept in sync.", GoogleCalendarMark, {
        href: "/imports#import-panel-calendar",
      }, ["ics", "webcal"]),
      item("luma", "Luma", "Events and guest lists.", lucide(CalendarRange), { href: "/events" }),
      item("eventbrite", "Eventbrite", "Events and attendees.", EventbriteMark, { href: "/events" }),
      item("reminders", "Reminders in calendar", "Your follow-ups next to your meetings.", lucide(CalendarDays), { tab: "reminders" }),
      item("apple_calendar", "Apple Calendar", "Log meetings from iCloud Calendar.", AppleMark, { planned: true }, ["icloud", "caldav"]),
    ],
  },
  {
    key: "notes",
    label: "Notes and documents",
    accent: "bg-import-messages",
    items: [
      item("google_drive", "Google Drive", "Pick documents; Orbit finds the people in them.", GoogleDriveMark, { href: "/imports" }, ["docs", "google docs"]),
      item("notion", "Notion", "Import a people database.", NotionMark, { planned: true }),
      item("apple_reminders", "Apple Reminders", "A reminder for each follow-up.", AppleMark, { planned: true }, ["shortcuts", "icloud"]),
    ],
  },
  {
    key: "ai",
    label: "AI and assistants",
    accent: "bg-tier-max",
    items: [
      item("ai", "AI", "Turns notes into contacts and answers questions.", lucide(Sparkles), { tab: "ai" }),
      item("assistants", "Claude and ChatGPT", "Use Orbit from inside Claude or ChatGPT.", ClaudeMark, { tab: "assistants" }),
    ],
  },
  {
    key: "automation",
    label: "Automations and enrichment",
    accent: "bg-import-scan",
    items: [
      item("zapier", "Zapier & Make", "Send events in and out with an Orbit API key.", ZapierMark, { tab: "api" }, ["make", "n8n", "webhooks"]),
      item("apollo", "Apollo", "Work history and contact details.", lucide(Rocket), { tab: "outreach" }),
    ],
  },
];

/** Label, blurb and aliases ("iCloud" finds Apple, "Teams" finds Microsoft). */
export function matchesCatalogQuery(entry: CatalogItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [entry.label, entry.blurb, ...entry.aliases].some((s) => s.toLowerCase().includes(q));
}
