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
  HubSpotMark,
  LinkedInMark,
  MicrosoftMark,
  NotionMark,
  ZapierMark,
} from "@/components/settings/provider-marks";
import type { IntegrationTabId } from "@/components/settings/sections";
import { connectorById } from "@/lib/connectors/registry";

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

function item(id: string, blurb: string, mark: Mark, to: CatalogTarget, label?: string): CatalogItem {
  return { id, label: label ?? connectorById(id)?.label ?? id, blurb, mark, to };
}

/**
 * Everything Orbit connects to, in the order a person looks for it.
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
      item("google", "Contacts, calendar, Gmail and Drive.", GoogleMark, { tab: "google" }),
      item("outlook", "Outlook contacts, calendar and mail.", MicrosoftMark, { tab: "microsoft" }, "Microsoft"),
      item("linkedin", "Your connections and messages.", LinkedInMark, { tab: "linkedin" }),
    ],
  },
  {
    key: "people",
    label: "People and contacts",
    accent: "bg-import-connections",
    items: [
      item("contacts_file", "A CSV or vCard from your phone or anywhere else.", lucide(BookUser), {
        href: "/imports#import-contacts-file",
      }),
      item("apple_contacts", "Keep iCloud contacts in sync.", AppleMark, { planned: true }),
      item("hubspot", "Import the contacts you own, log what you do.", HubSpotMark, { planned: true }),
    ],
  },
  {
    key: "calendars",
    label: "Calendars and events",
    accent: "bg-import-calendar",
    items: [
      item("calendar_ics", "Any calendar’s private link, kept in sync.", GoogleCalendarMark, {
        href: "/imports#import-panel-calendar",
      }),
      item("luma", "Events and guest lists.", lucide(CalendarRange), { href: "/events" }),
      item("eventbrite", "Events and attendees.", EventbriteMark, { href: "/events" }),
      item("reminders", "Your follow-ups next to your meetings.", lucide(CalendarDays), { tab: "reminders" }, "Reminders in calendar"),
      item("apple_calendar", "Log meetings from iCloud Calendar.", AppleMark, { planned: true }),
    ],
  },
  {
    key: "notes",
    label: "Notes and documents",
    accent: "bg-import-messages",
    items: [
      item("google_drive", "Pick documents; Orbit finds the people in them.", GoogleDriveMark, { href: "/imports" }),
      item("notion", "Import a people database.", NotionMark, { planned: true }),
      item("apple_reminders", "A reminder for each follow-up.", AppleMark, { planned: true }),
    ],
  },
  {
    key: "ai",
    label: "AI and assistants",
    accent: "bg-tier-max",
    items: [
      item("ai", "Turns notes into contacts and answers questions.", lucide(Sparkles), { tab: "ai" }, "AI"),
      item("assistants", "Use Orbit from inside Claude or ChatGPT.", ClaudeMark, { tab: "assistants" }, "Claude and ChatGPT"),
    ],
  },
  {
    key: "automation",
    label: "Automations and enrichment",
    accent: "bg-import-scan",
    items: [
      item("zapier", "Send events in and out with an Orbit API key.", ZapierMark, { tab: "api" }),
      item("apollo", "Work history and contact details.", lucide(Rocket), { tab: "outreach" }),
    ],
  },
];

/** Label, blurb and the registry's aliases ("iCloud" finds Apple, "Teams" finds Outlook). */
export function matchesCatalogQuery(entry: CatalogItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const aliases = connectorById(entry.id)?.aliases ?? [];
  return [entry.label, entry.blurb, ...aliases].some((s) => s.toLowerCase().includes(q));
}
