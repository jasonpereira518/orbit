/**
 * Everything ⌘K can take you to or do, as data. The palette (`command-palette-dialog.tsx`)
 * renders it; `scripts/smoke-command-palette-coverage.ts` reads it to prove it still matches
 * the app.
 *
 * It is built from the app's own registries wherever one exists, so the common ways of going
 * stale are closed off rather than remembered:
 *
 * - Pages come from `APP_NAV` (the sidebar's list), plus the few pages the sidebar does not
 *   carry. A page added to the nav is in the palette.
 * - Settings sections come from `SETTINGS_SECTIONS`, and Integrations pages from
 *   `INTEGRATION_TABS`, so a new section or a new connected account is findable the day it
 *   ships. The coverage smoke fails if one is not.
 * - What each entry is hidden by comes from the surface it lands on (see `visibleEntries`), or
 *   `surface` where the landing page cannot say (an Integrations page is `/settings`).
 *
 * What is hand-written is the verbs: the things a person does rather than the places they go.
 * Each one names the page it ends on, so hiding that page removes it, and every deep link it
 * carries (`?view=`, `?mode=`, `?followUp=`) is checked against the page that reads it.
 */
import {
  AudioLines,
  BellPlus,
  BellRing,
  Bot,
  Briefcase,
  CalendarClock,
  CheckCheck,
  Cloud,
  CreditCard,
  Database,
  History,
  Hourglass,
  Infinity as InfinityIcon,
  KeyRound,
  Link2,
  Mail,
  MessageCircle,
  MessageSquarePlus,
  Mic,
  Plug,
  QrCode,
  Send,
  Settings,
  Sparkles,
  Star,
  Sun,
  Telescope,
  Upload,
  UserPlus,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { APP_NAV } from "@/components/layout/app-nav";
import {
  INTEGRATION_TABS,
  SETTINGS_SECTIONS,
  integrationHref,
  type IntegrationTabId,
} from "@/components/settings/sections";
import type { PaletteEntry } from "@/lib/command-palette";
import { CLOUD_NOTES_SURFACE_KEY, COMPOSE_SURFACE_KEY, FEEDBACK_SURFACE_KEY, surfaceKeyForSettingsId } from "@/lib/surfaces";

/** What an entry does when it is not a link. */
export type PaletteVerb = "compose" | "feedback";

export type Command = PaletteEntry & {
  icon: LucideIcon;
  hint?: string;
  /** Shown on an empty palette. The rest wait for a search, so recent people stay in view. */
  featured?: boolean;
  /** Opens a dialog instead of navigating; `href` is then absent and `surface` names the gate. */
  verb?: PaletteVerb;
};

/* ---------------------------------------------------------------------- actions ---- */

export const ACTIONS: Command[] = [
  // Capture
  {
    id: "action:capture",
    label: "New capture",
    featured: true,
    hint: "Paste notes or upload photos",
    href: "/capture",
    icon: Sparkles,
    keywords: "log interaction notes paste photo picture upload extract add structured manual",
  },
  {
    id: "action:voice",
    label: "Record a voice note",
    featured: true,
    href: "/capture?mode=voice",
    icon: Mic,
    keywords: "dictate audio speak capture microphone",
  },
  {
    id: "action:meeting",
    label: "Record a meeting",
    href: "/meetings",
    icon: AudioLines,
    keywords: "call zoom meet transcribe transcript summary recorder granola",
  },
  {
    id: "action:cloud-notes",
    label: "Capture from Drive or OneDrive notes",
    hint: "Meeting notes in your cloud files",
    href: "/capture?mode=cloud",
    surface: CLOUD_NOTES_SURFACE_KEY,
    icon: Cloud,
    keywords: "google drive onedrive docs meeting notes files import capture",
  },
  {
    id: "action:capture-history",
    label: "Capture history",
    hint: "Past captures and what they made",
    href: "/capture?mode=library",
    icon: History,
    keywords: "library previous notes undo review past",
  },
  {
    id: "action:import",
    label: "Import contacts",
    hint: "LinkedIn, contacts file, Google, Outlook",
    href: "/imports",
    icon: Upload,
    keywords: "linkedin csv vcard vcf google outlook iphone phone address book calendar ics whatsapp imessage",
  },

  // People
  {
    id: "action:add-contact",
    label: "Add a contact",
    featured: true,
    href: "/contacts/new",
    icon: UserPlus,
    keywords: "new person create",
  },
  {
    id: "action:compose",
    label: "Write an email",
    hint: "From your own mailbox",
    verb: "compose",
    surface: COMPOSE_SURFACE_KEY,
    icon: Mail,
    keywords: "compose send message gmail outlook mail new",
  },
  {
    id: "action:due-follow-ups",
    label: "Contacts due for a follow-up",
    href: "/contacts?followUp=due",
    icon: BellRing,
    keywords: "overdue reach out check in people who need a message",
  },
  {
    id: "action:quiet-30",
    label: "Contacts quiet for 30+ days",
    href: "/contacts?quiet=30",
    icon: Hourglass,
    keywords: "dormant gone quiet losing touch haven't spoken a month",
  },
  {
    id: "action:quiet-90",
    label: "Contacts quiet for 90+ days",
    href: "/contacts?quiet=90",
    icon: Hourglass,
    keywords: "dormant gone quiet losing touch haven't spoken three months quarter",
  },
  {
    id: "action:quiet-180",
    label: "Contacts quiet for 180+ days",
    href: "/contacts?quiet=180",
    icon: Hourglass,
    keywords: "dormant gone quiet losing touch haven't spoken six months half year",
  },
  {
    id: "action:closest",
    label: "Closest contacts",
    href: "/contacts?sort=closeness",
    icon: Star,
    keywords: "inner orbit strongest ties best relationships sort closeness",
  },
  {
    id: "action:last-spoken",
    label: "Contacts by last spoken",
    href: "/contacts?sort=last_touch",
    icon: MessageCircle,
    keywords: "recent conversations last touch sort who i talked to",
  },
  {
    id: "action:duplicates",
    label: "Review duplicate contacts",
    href: "/contacts/duplicates",
    icon: Users,
    keywords: "merge dedupe same person",
  },

  // Reminders
  {
    id: "action:new-reminder",
    label: "New reminder",
    featured: true,
    href: "/reminders?new=1",
    icon: BellPlus,
    keywords: "add create task follow up remind todo",
  },
  {
    id: "action:today-reminders",
    label: "Today’s reminders",
    hint: "Due today, and anything overdue",
    href: "/reminders?view=today",
    icon: Sun,
    keywords: "due now overdue todo",
  },
  {
    id: "action:upcoming-reminders",
    label: "Upcoming reminders",
    hint: "What’s due after today",
    href: "/reminders?view=upcoming",
    icon: CalendarClock,
    keywords: "due soon week schedule next",
  },
  {
    id: "action:share-card",
    label: "Share my card",
    hint: "Show your QR code full screen",
    href: "/card/show",
    icon: QrCode,
    keywords: "qr code nfc contact card business card swap exchange show",
  },
  {
    id: "action:anytime-reminders",
    label: "Reminders with no date",
    href: "/reminders?view=anytime",
    icon: InfinityIcon,
    keywords: "anytime someday undated backlog",
  },
  {
    id: "action:done-reminders",
    label: "Completed reminders",
    href: "/reminders?view=done",
    icon: CheckCheck,
    keywords: "done finished history archive",
  },

  // Recruiters and outreach
  {
    id: "action:add-recruiter",
    label: "Add a recruiter",
    href: "/recruiters/new",
    icon: Briefcase,
    keywords: "recruiting hiring headhunter log",
  },
  {
    id: "action:write-recruiters",
    label: "Write to recruiters",
    href: "/recruiters/compose",
    icon: Mail,
    keywords: "recruiting hiring email message",
  },
  {
    id: "action:campaigns",
    label: "Outreach campaigns",
    href: "/outreach?tab=campaigns",
    icon: Send,
    keywords: "cold email sequences prospects drafts sent replies",
  },
  {
    id: "action:new-campaign",
    label: "New outreach campaign",
    href: "/outreach/new",
    icon: Send,
    keywords: "outreach cold email sequence prospects campaign",
  },

  // Account
  {
    id: "action:plans",
    label: "Compare plans",
    hint: "Pricing, credits and what each plan includes",
    href: "/pricing",
    icon: CreditCard,
    keywords: "upgrade pricing pro max lifetime credits billing subscription",
  },
  {
    id: "action:feedback",
    label: "Send feedback",
    hint: "Report a problem or suggest something",
    verb: "feedback",
    surface: FEEDBACK_SURFACE_KEY,
    icon: MessageSquarePlus,
    keywords: "bug problem report idea suggestion help message",
  },
];

/* ------------------------------------------------------------------------ pages ---- */

/** Words that find a page without being its name. Keyed by href. */
const PAGE_KEYWORDS: Readonly<Record<string, string>> = {
  "/dashboard": "home overview today stats",
  "/radar": "who to reach out to this week analyst suggestions drafts overnight changes",
  "/contacts": "people network address book list",
  "/capture": "log add notes",
  "/meetings": "recordings transcripts calls granola",
  "/reminders": "tasks follow ups todo due",
  "/chat": "ask assistant questions network ai",
  "/graph": "constellation map network sky stars galaxy visual",
  "/knowledge": "what i know about people summaries history",
  "/events": "conferences meetups attended debrief",
  "/outreach": "campaigns cold email sequences prospects",
  "/find": "research discover new people prospects outside network brief",
  "/recruiters": "recruiting hiring jobs headhunters",
  "/settings": "preferences account configure",
};

export const PAGES: Command[] = [
  ...APP_NAV.map((item) => ({
    id: `page:${item.href}`,
    label: item.label,
    href: item.href,
    icon: item.icon,
    keywords: `go open page ${PAGE_KEYWORDS[item.href] ?? ""}`.trim(),
  })),
  // Pages the sidebar does not list: Recruiters lives under Contacts there, and Find people
  // is reached from Radar and Chat rather than the nav.
  {
    id: "page:/recruiters",
    label: "Recruiters",
    href: "/recruiters",
    icon: Briefcase,
    keywords: `go open page ${PAGE_KEYWORDS["/recruiters"]}`,
  },
  {
    // `/find` only redirects here now ("Find people is now unified under Outreach"), so this
    // goes straight to the tab. It is still the `page.find` surface that hides or tags it.
    id: "page:/find",
    label: "Find people",
    hint: "Research people outside your network",
    href: "/outreach?tab=discover",
    surface: "page.find",
    icon: Telescope,
    keywords: `go open page ${PAGE_KEYWORDS["/find"]}`,
  },
];

/* --------------------------------------------------------------------- settings ---- */

/**
 * Sections that moved into the Integrations dialog. Their palette entries are the dialog's
 * pages (below), which land on the right page directly instead of through an old `#anchor`.
 */
const MOVED_TO_INTEGRATIONS: ReadonlySet<string> = new Set(
  INTEGRATION_TABS.flatMap((tab) => ("section" in tab ? [tab.section] : []))
);

export const SETTINGS: Command[] = SETTINGS_SECTIONS.filter((s) => !MOVED_TO_INTEGRATIONS.has(s.id)).map((section) => ({
  id: `settings:${section.id}`,
  label: `Settings › ${section.label}`,
  href: `/settings#${section.id}`,
  settingsId: section.id,
  icon: Settings,
  keywords: "preferences configure",
}));

const INTEGRATION_META: Record<IntegrationTabId, { icon: LucideIcon; keywords: string }> = {
  google: { icon: Plug, keywords: "gmail google contacts calendar meet drive connect account sync" },
  microsoft: { icon: Plug, keywords: "outlook microsoft office 365 onedrive teams connect account sync" },
  linkedin: { icon: Link2, keywords: "linkedin connections export import profile connect" },
  granola: { icon: AudioLines, keywords: "granola meeting notes transcripts connect sync" },
  notion: { icon: Database, keywords: "notion database people sync connect" },
  ai: { icon: Bot, keywords: "ai provider model key api anthropic claude openai gemini openrouter byok" },
  assistants: { icon: Bot, keywords: "claude chatgpt mcp connector assistant" },
  api: { icon: KeyRound, keywords: "api keys token developer access" },
  webhooks: { icon: Webhook, keywords: "webhook automation zapier events developer" },
  outreach: { icon: Send, keywords: "outreach keys apollo email finder enrichment provider" },
};

/** One entry per Integrations dialog page, so a connected account is a few keystrokes away. */
export const INTEGRATIONS: Command[] = INTEGRATION_TABS.map((tab) => ({
  id: `integration:${tab.id}`,
  label: `Integrations › ${tab.label}`,
  href: integrationHref(tab.id),
  // A page of the dialog follows the page it embeds, or the settings section it moved from.
  surface: "surface" in tab ? tab.surface : surfaceKeyForSettingsId(tab.section),
  icon: INTEGRATION_META[tab.id].icon,
  keywords: `settings integrations ${INTEGRATION_META[tab.id].keywords}`,
}));
